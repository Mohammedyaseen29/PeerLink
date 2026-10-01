import { saveMetaData, saveChunks, deleteFile, type FileMetadata } from '../ProgressDB';

export const CHUNK_SIZE = 64 * 1024 - 128;
const HIGH = 2 * 1024 * 1024;
const LOW = HIGH - 2 * CHUNK_SIZE;
const WINDOW = 128; // At most 8 MiB sent but not committed, including SCTP queues.
const INITIAL_READ_BATCH = 16;
const READ_BATCH = 32;
const RECEIVE_BATCH = 32;
const encoder = new TextDecoder();
type Packet = { chunkIndex: number; data: ArrayBuffer; hash: Uint8Array };
type PendingBatch = { packets: Packet[]; validation: Promise<void> };
type Incoming = { meta: FileMetadata; wireId: string; next: number; committed: number; queue: Packet[]; writing: boolean; committing: boolean; cancelled: boolean; flushRequested: boolean; pendingBatch?: PendingBatch; timer?: number };
type Outgoing = { id: string; file: File; next: number; committed: number; ready: boolean; paused: boolean; done: boolean; error?: Error; progress: (bytes: number) => void; lastUpdate: number };
export type TransferEvents = {
    receiving: (meta: FileMetadata, bytes: number) => void;
    received: (meta: FileMetadata) => void;
    error: (message: string) => void;
};

export class TransferEngine {
    private worker: Worker | null = null;
    private workerIdleTimer: number | undefined;
    private requestId = 0;
    private reads = new Map<number, { resolve: (packets: ArrayBuffer[]) => void; reject: (error: Error) => void; timer: number }>();
    private outgoing: Outgoing | null = null;
    private incoming: Incoming | null = null;
    private disposed = false;
    private waiters = new Set<() => void>();
    private controlTasks: Promise<void> = Promise.resolve();
    readonly metrics = {
        peakBufferedBytes: 0, peakReceiveBytes: 0, receivedBytes: 0, sentBytes: 0,
        activeWorkers: 0, workerStarts: 0, pendingReads: 0, disposed: false,
        readAwaitMs: 0, readyWaitMs: 0, channelWaitMs: 0, creditWaitMs: 0, pausedWaitMs: 0,
        hashMs: 0, storageMs: 0, storedBatches: 0, storedChunks: 0,
    };

    private data: RTCDataChannel;
    private control: RTCDataChannel;
    private room: () => string;
    private roomType: () => "persistent" | "temporary";
    private events: TransferEvents;
    private source: { peerId?: string; peerName?: string };
    constructor(data: RTCDataChannel, control: RTCDataChannel, room: () => string, events: TransferEvents,
        roomType: () => "persistent" | "temporary" = () => "persistent",
        source: { peerId?: string; peerName?: string } = {}) {
        this.data = data; this.control = control; this.room = room; this.events = events; this.roomType = roomType; this.source = source;
        data.binaryType = 'arraybuffer';
        data.bufferedAmountLowThreshold = LOW;
        data.addEventListener('bufferedamountlow', this.wake);
        data.addEventListener('message', this.onData);
        data.addEventListener('close', this.onClose);
        control.addEventListener('close', this.onClose);
    }

    private wake = () => { for (const fn of [...this.waiters]) fn(); };
    private onClose = () => this.dispose();
    private message(value: object) {
        if (this.control.readyState !== 'open') throw new Error('Connection closed');
        this.control.send(JSON.stringify(value));
    }
    private async wait(timeout = 100) {
        if (this.disposed) throw new Error('Connection closed');
        await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(); };
            const timer = window.setTimeout(done, timeout);
            this.waiters.add(done);
        });
    }

    handle(message: Record<string, unknown>): boolean {
        if (typeof message.type !== 'string' || !message.type.startsWith('transfer_')) return false;
        this.controlTasks = this.controlTasks.then(() => this.onControl(message)).catch(error => {
            const failure = error instanceof Error ? error : new Error(String(error));
            if (this.outgoing && message.fileId === this.outgoing.id) { this.outgoing.error = failure; this.wake(); }
            else if (message.type === 'transfer_meta' && this.control.readyState === 'open') {
                this.message({ type: 'transfer_error', fileId: message.fileId, message: failure.message });
                this.events.error(failure.message);
            } else this.failIncoming(failure);
        });
        return true;
    }

    private async onControl(msg: Record<string, unknown>) {
        if (this.disposed) return;
        const out = this.outgoing;
        if (msg.type === 'transfer_meta') {
            if (this.incoming && !this.incoming.cancelled && this.incoming.meta.status !== 'complete') throw new Error('Receiver already busy');
            const { fileId, name, size, totalChunks, chunkSize } = msg;
            if (typeof fileId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(fileId) || typeof name !== 'string' ||
                !Number.isSafeInteger(size) || Number(size) < 0 || chunkSize !== CHUNK_SIZE ||
                totalChunks !== Math.ceil(Number(size) / CHUNK_SIZE) || msg.version !== 3) throw new Error('Incompatible transfer metadata');
            const localId = crypto.randomUUID();
            const meta: FileMetadata = { fileId: localId, sourcePeerId: this.source.peerId, sourceName: this.source.peerName,
                sharedWithRoom: msg.sharedWithRoom === true, name, size: Number(size), totalChunks: Number(totalChunks), chunkSize: CHUNK_SIZE,
                roomId: this.room(), roomType: this.roomType(), path: typeof msg.path === 'string' ? msg.path : undefined,
                mimeType: typeof msg.mimeType === 'string' ? msg.mimeType : '', receivedChunks: 0, status: 'receiving', createdAt: Date.now() };
            const incoming: Incoming = { meta, wireId: fileId, next: 0, committed: 0, queue: [], writing: false, committing: false, cancelled: false, flushRequested: false };
            this.incoming = incoming;
            const storageStarted = performance.now();
            try { await saveMetaData(meta); }
            finally { this.metrics.storageMs += performance.now() - storageStarted; }
            if (this.disposed) return;
            this.events.receiving(meta, 0);
            this.message({ type: 'transfer_ready', fileId });
            if (!meta.totalChunks) await this.finishIncoming(incoming);
        } else if (msg.type === 'transfer_cancel') {
            const incoming = this.incoming;
            if (incoming && incoming.wireId === msg.fileId) {
                incoming.cancelled = true;
                incoming.committing = false;
                clearTimeout(incoming.timer);
                incoming.queue = [];
                incoming.pendingBatch = undefined;
                incoming.flushRequested = false;
                // The active transaction precedes deleteFile in IndexedDB's transaction order.
                await deleteFile(incoming.meta.fileId);
            }
        } else if (out && msg.fileId === out.id) {
            if (msg.type === 'transfer_ready') out.ready = true;
            if (msg.type === 'transfer_progress' || msg.type === 'transfer_complete') {
                const count = Number(msg.committed);
                if (!Number.isInteger(count) || count < out.committed || count > out.next) throw new Error('Invalid receiver progress');
                out.committed = count;
                const now = performance.now();
                if (now - out.lastUpdate >= 150 || msg.type === 'transfer_complete') {
                    out.lastUpdate = now;
                    out.progress(Math.min(count * CHUNK_SIZE, out.file.size));
                }
                if (msg.type === 'transfer_complete' && count === Math.ceil(out.file.size / CHUNK_SIZE)) out.done = true;
            }
            if (msg.type === 'transfer_error') out.error = new Error(String(msg.message));
            this.wake();
        }
    }

    private onData = (event: MessageEvent) => {
        const incoming = this.incoming;
        if (!incoming || incoming.cancelled || this.disposed) return;
        try {
            const packet = event.data as ArrayBuffer;
            if (!(packet instanceof ArrayBuffer) || packet.byteLength < 38) throw new Error('Invalid packet');
            const view = new DataView(packet);
            const length = view.getUint16(0, true);
            if (length > 64 || 38 + length > packet.byteLength) throw new Error('Invalid packet header');
            const id = encoder.decode(new Uint8Array(packet, 6, length));
            if (id !== incoming.wireId) return; // Late packets from a cancelled file.
            const index = view.getUint32(2, true);
            if (index < incoming.next) return;
            const expected = Math.min(CHUNK_SIZE, incoming.meta.size - index * CHUNK_SIZE);
            if (index !== incoming.next || expected <= 0 || packet.byteLength - 38 - length !== expected) throw new Error('File chunk sequence or size mismatch');
            if (incoming.next - incoming.committed >= WINDOW) throw new Error('Receiver buffer limit exceeded');
            incoming.next++;
            incoming.queue.push({ chunkIndex: index, data: packet.slice(38 + length), hash: new Uint8Array(packet.slice(6 + length, 38 + length)) });
            this.metrics.peakReceiveBytes = Math.max(this.metrics.peakReceiveBytes, (incoming.next - incoming.committed) * CHUNK_SIZE);
            this.scheduleFlush(incoming);
        } catch (error) { this.failIncoming(error as Error); }
    };

    private scheduleFlush(incoming: Incoming) {
        if (incoming.cancelled || this.disposed || !incoming.queue.length) return;
        if (incoming.queue.length >= RECEIVE_BATCH || incoming.next === incoming.meta.totalChunks) {
            clearTimeout(incoming.timer);
            incoming.timer = undefined;
            incoming.flushRequested = false;
            if (incoming.writing) this.prepareNextBatch(incoming);
            else void this.flush(incoming);
        } else if (!incoming.timer) incoming.timer = window.setTimeout(() => {
            incoming.timer = undefined;
            incoming.flushRequested = true;
            if (incoming.writing) this.prepareNextBatch(incoming);
            else void this.flush(incoming);
        }, 32);
    }

    private validateBatch(batch: Packet[]): Promise<void> {
        const hashStarted = performance.now();
        return Promise.all(batch.map(async packet => {
            const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', packet.data));
            if (!hash.every((byte, i) => byte === packet.hash[i])) throw new Error('File integrity check failed');
        })).then(() => undefined).finally(() => { this.metrics.hashMs += performance.now() - hashStarted; });
    }

    private prepareNextBatch(incoming: Incoming) {
        if (!incoming.committing || incoming.pendingBatch || incoming.cancelled || this.disposed || this.incoming !== incoming || !incoming.queue.length) return;
        const full = incoming.queue.length >= RECEIVE_BATCH;
        const final = incoming.next === incoming.meta.totalChunks;
        if (!full && !final && !incoming.flushRequested) return;

        clearTimeout(incoming.timer);
        incoming.timer = undefined;
        incoming.flushRequested = false;
        const packets = incoming.queue.splice(0, RECEIVE_BATCH);
        const validation = this.validateBatch(packets);
        // A speculative digest can reject while IndexedDB is committing the prior batch.
        // Mark it handled now; the ordered writer still awaits it before saving.
        void validation.catch(() => undefined);
        incoming.pendingBatch = { packets, validation };
    }

    private failIncoming(error: Error) {
        const incoming = this.incoming;
        const message = error instanceof DOMException && error.name === 'QuotaExceededError'
            ? 'Not enough receiver storage. Free space and retry.' : error.message;
        if (incoming && !incoming.cancelled) {
            incoming.cancelled = true;
            incoming.committing = false;
            clearTimeout(incoming.timer);
            incoming.queue = [];
            incoming.pendingBatch = undefined;
            incoming.flushRequested = false;
            if (this.control.readyState === 'open') this.message({ type: 'transfer_error', fileId: incoming.wireId, message });
        }
        this.events.error(message);
    }

    private async finishIncoming(incoming: Incoming) {
        const needsPersistence = incoming.meta.status !== 'complete';
        incoming.meta.status = 'complete';
        if (needsPersistence) {
            const storageStarted = performance.now();
            try { await saveMetaData(incoming.meta); }
            finally { this.metrics.storageMs += performance.now() - storageStarted; }
        }
        if (incoming.cancelled || this.disposed) return;
        this.events.received({ ...incoming.meta });
        this.message({ type: 'transfer_complete', fileId: incoming.wireId, committed: incoming.committed });
    }

    private async flush(incoming: Incoming) {
        if (incoming.writing || incoming.cancelled || this.disposed) return;
        incoming.writing = true;
        try {
            while ((incoming.pendingBatch || incoming.queue.length) && !incoming.cancelled && !this.disposed) {
                let batch: Packet[];
                let validation: Promise<void>;
                if (incoming.pendingBatch) {
                    ({ packets: batch, validation } = incoming.pendingBatch);
                    incoming.pendingBatch = undefined;
                } else {
                    const full = incoming.queue.length >= RECEIVE_BATCH;
                    const final = incoming.next === incoming.meta.totalChunks;
                    if (!full && !final && !incoming.flushRequested) break;
                    clearTimeout(incoming.timer);
                    incoming.timer = undefined;
                    incoming.flushRequested = false;
                    batch = incoming.queue.splice(0, RECEIVE_BATCH);
                    validation = this.validateBatch(batch);
                }
                await validation;
                if (incoming.cancelled || this.disposed) return;
                const committed = incoming.committed + batch.length;
                const completesFile = committed === incoming.meta.totalChunks;
                const storageStarted = performance.now();
                incoming.committing = true;
                const storageCommit = saveChunks(incoming.meta.fileId, batch, {
                    ...incoming.meta, receivedChunks: committed, status: completesFile ? 'complete' : 'receiving',
                });
                // Start at most one following batch's digest while this transaction commits.
                // Partial batches still wait for the 32 ms coalescing timer.
                this.prepareNextBatch(incoming);
                this.scheduleFlush(incoming);
                try { await storageCommit; }
                finally {
                    incoming.committing = false;
                    this.metrics.storageMs += performance.now() - storageStarted;
                }
                this.metrics.storedBatches++;
                this.metrics.storedChunks += batch.length;
                if (incoming.cancelled || this.disposed) return;
                incoming.committed = committed;
                incoming.meta.receivedChunks = committed;
                if (completesFile) incoming.meta.status = 'complete';
                this.metrics.receivedBytes += batch.reduce((n, packet) => n + packet.data.byteLength, 0);
                this.events.receiving(incoming.meta, Math.min(committed * CHUNK_SIZE, incoming.meta.size));
                if (committed === incoming.meta.totalChunks) await this.finishIncoming(incoming);
                else this.message({ type: 'transfer_progress', fileId: incoming.wireId, committed });
            }
        } catch (error) { if (!incoming.cancelled && !this.disposed && this.incoming === incoming) this.failIncoming(error as Error); }
        finally { incoming.committing = false; incoming.writing = false; this.scheduleFlush(incoming); }
    }

    private getWorker() {
        clearTimeout(this.workerIdleTimer);
        this.workerIdleTimer = undefined;
        if (this.worker) return this.worker;
        const worker = new Worker(new URL('../workers/transferWorker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = ({ data }) => {
            const pending = this.reads.get(data.requestId);
            if (!pending) return;
            clearTimeout(pending.timer);
            this.reads.delete(data.requestId);
            this.metrics.pendingReads = this.reads.size;
            if (data.error) pending.reject(new Error(data.error)); else pending.resolve(data.packets);
        };
        worker.onerror = () => this.clearWorker(new Error('File reader failed'));
        this.worker = worker;
        this.metrics.activeWorkers = 1;
        this.metrics.workerStarts++;
        return worker;
    }
    private read(out: Outgoing, start: number, count: number) {
        return new Promise<ArrayBuffer[]>((resolve, reject) => {
            const requestId = ++this.requestId;
            const timer = window.setTimeout(() => {
                this.reads.delete(requestId); this.metrics.pendingReads = this.reads.size;
                reject(new Error('File read timed out'));
            }, 30000);
            this.reads.set(requestId, { resolve, reject, timer });
            this.metrics.pendingReads = this.reads.size;
            this.getWorker().postMessage({ type: 'read', requestId, fileId: out.id, start, count, chunkSize: CHUNK_SIZE });
        });
    }
    private clearWorker(error = new Error('Transfer stopped')) {
        clearTimeout(this.workerIdleTimer);
        this.workerIdleTimer = undefined;
        this.worker?.terminate();
        this.worker = null;
        this.metrics.activeWorkers = 0;
        for (const read of this.reads.values()) { clearTimeout(read.timer); read.reject(error); }
        this.reads.clear();
        this.metrics.pendingReads = 0;
    }

    async send(file: File, id: string, progress: (bytes: number) => void, keepWorkerForNext = false, sharedWithRoom = true) {
        if (this.outgoing || this.disposed) throw new Error('Sender unavailable');
        const out: Outgoing = { id, file, next: 0, committed: 0, ready: false, paused: false, done: false, progress, lastUpdate: 0 };
        this.outgoing = out;
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
        let lastAdvance = performance.now();
        let lastCommitted = 0;
        const check = () => {
            if (out.error) throw out.error;
            if (this.disposed) throw new Error('Connection closed');
            if (out.paused || out.committed !== lastCommitted) { lastAdvance = performance.now(); lastCommitted = out.committed; }
            if (performance.now() - lastAdvance > 60000) throw new Error('Peer stopped responding. Reconnect and retry.');
        };
        try {
            const max = this.data.readyState === 'open';
            if (!max || this.control.readyState !== 'open') throw new Error('Connection not ready');
            // Prepare only the first bounded batch while the receiver opens storage.
            // No packets are sent until transfer_ready arrives.
            let nextRead: Promise<ArrayBuffer[]> | null = null;
            if (totalChunks) {
                this.getWorker().postMessage({ type: 'load', file });
                nextRead = this.read(out, 0, Math.min(INITIAL_READ_BATCH, totalChunks));
                nextRead.catch(() => undefined);
            }
            this.message({ type: 'transfer_meta', version: 3, fileId: id, name: file.name, path: file.webkitRelativePath, sharedWithRoom,
                mimeType: file.type, size: file.size, totalChunks, chunkSize: CHUNK_SIZE });
            while (!out.ready) {
                check();
                const waitStarted = performance.now();
                try { await this.wait(); }
                finally { this.metrics.readyWaitMs += performance.now() - waitStarted; }
            }
            while (out.next < totalChunks) {
                check();
                const readStarted = performance.now();
                let packets: ArrayBuffer[];
                try { packets = await nextRead!; }
                finally { this.metrics.readAwaitMs += performance.now() - readStarted; }
                const end = out.next + packets.length;
                nextRead = end < totalChunks ? this.read(out, end, Math.min(READ_BATCH, totalChunks - end)) : null;
                // A speculative read can be cancelled before the pump awaits it.
                nextRead?.catch(() => undefined);
                for (const packet of packets) {
                    for (let attempts = 0; ; attempts++) {
                        // Recheck pause and credits after every asynchronous retry.
                        while (out.paused || out.next - out.committed >= WINDOW || this.data.bufferedAmount + packet.byteLength > HIGH) {
                            check();
                            const paused = out.paused;
                            const creditBlocked = out.next - out.committed >= WINDOW;
                            const channelBlocked = this.data.bufferedAmount + packet.byteLength > HIGH;
                            const waitStarted = performance.now();
                            try { await this.wait(); }
                            finally {
                                const waited = performance.now() - waitStarted;
                                if (paused) this.metrics.pausedWaitMs += waited;
                                if (creditBlocked) this.metrics.creditWaitMs += waited;
                                if (channelBlocked) this.metrics.channelWaitMs += waited;
                            }
                        }
                        check();
                        try { this.data.send(packet); break; }
                        catch (error) {
                            if (!(error instanceof DOMException) || error.name !== 'OperationError' || attempts >= 20) throw error;
                            await this.wait(8); check();
                        }
                    }
                    out.next++;
                    this.metrics.sentBytes += Math.min(CHUNK_SIZE, file.size - (out.next - 1) * CHUNK_SIZE);
                    this.metrics.peakBufferedBytes = Math.max(this.metrics.peakBufferedBytes, this.data.bufferedAmount);
                }
            }
            while (!out.done) { check(); await this.wait(); }
        } catch (error) {
            if (this.control.readyState === 'open') this.message({ type: 'transfer_cancel', fileId: id });
            throw error;
        } finally {
            if (out.done && keepWorkerForNext && this.worker) {
                // Release the source File while retaining the worker for the next queued item.
                this.worker.postMessage({ type: 'clear' });
                this.workerIdleTimer = window.setTimeout(() => {
                    this.workerIdleTimer = undefined;
                    this.clearWorker();
                }, 10000);
            } else this.clearWorker();
            if (this.outgoing === out) this.outgoing = null;
        }
    }
    releaseIdleWorker() {
        if (this.outgoing) return;
        clearTimeout(this.workerIdleTimer);
        this.workerIdleTimer = undefined;
        this.clearWorker();
    }
    pause(id: string) { if (this.outgoing?.id === id) this.outgoing.paused = true; }
    resume(id: string) { if (this.outgoing?.id === id) { this.outgoing.paused = false; this.wake(); } }
    cancel(id: string) {
        if (this.outgoing?.id !== id) return;
        this.outgoing.error = new Error('Cancelled');
        if (this.control.readyState === 'open') this.message({ type: 'transfer_cancel', fileId: id });
        this.clearWorker(); this.wake();
    }
    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.metrics.disposed = true;
        if (this.incoming) {
            this.incoming.cancelled = true;
            this.incoming.committing = false;
            clearTimeout(this.incoming.timer);
            this.incoming.queue = [];
            this.incoming.pendingBatch = undefined;
            this.incoming.flushRequested = false;
        }
        this.clearWorker(); this.wake();
        this.data.removeEventListener('bufferedamountlow', this.wake);
        this.data.removeEventListener('message', this.onData);
        this.data.removeEventListener('close', this.onClose);
        this.control.removeEventListener('close', this.onClose);
    }
}
