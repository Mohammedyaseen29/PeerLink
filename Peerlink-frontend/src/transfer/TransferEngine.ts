import { saveMetaData, saveChunks, deleteFile, type FileMetadata } from '../ProgressDB';
import { getFileMimeType } from '../utils/helpers';

export const CHUNK_SIZE = 16 * 1024 - 128;
const LEGACY_CHUNK_SIZE = 64 * 1024 - 128;
// Raw loopback trials favored a smaller native queue over 2 MiB; 256 KiB kept more headroom than 128 KiB.
export const SEND_BUFFER_HIGH_WATER = 256 * 1024;
const HIGH = SEND_BUFFER_HIGH_WATER;
const LOW = HIGH / 2;
const WINDOW = 128; // 2 MiB for current sends; at most 8 MiB for legacy receive chunks.
const INITIAL_READ_BATCH = 16;
const READ_BATCH = 32;
const RECEIVE_BATCH = 32;
const encoder = new TextDecoder();
const MAX_TRANSFER_PATH_LENGTH = 1024;

function validTransferName(name: unknown): name is string {
    return typeof name === 'string' && name.length > 0 && name.length <= 255 && name !== '.' && name !== '..' &&
        !/[\u0000-\u001f\u007f/\\]/.test(name);
}

function validTransferPath(path: unknown): path is string | undefined {
    if (path === undefined || path === '') return true;
    if (typeof path !== 'string' || path.length > MAX_TRANSFER_PATH_LENGTH || /[\u0000-\u001f\u007f\\]/.test(path) ||
        path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
    return path.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes(':'));
}

function transferChunkSize(id: string, getMaxMessageSize?: () => number | undefined): number {
    const headerBytes = 38 + new TextEncoder().encode(id).byteLength;
    let maximum = Number.POSITIVE_INFINITY;
    try {
        const negotiated = getMaxMessageSize?.();
        if (typeof negotiated === 'number' && Number.isFinite(negotiated) && negotiated > 0) maximum = Math.floor(negotiated);
        // SCTP treats zero and an unavailable value as no negotiated cap.
    } catch { /* The default chunk is safe when the channel limit is unavailable. */ }
    const payloadLimit = Math.min(CHUNK_SIZE, maximum - headerBytes);
    if (payloadLimit < 1) throw new Error('The peer data channel has a message limit too small for file transfer.');
    return payloadLimit;
}
type Packet = { chunkIndex: number; data: ArrayBuffer; hash: Uint8Array };
type PendingBatch = { packets: Packet[]; validation: Promise<void>; timerFlush: boolean };
type Incoming = { meta: FileMetadata; wireId: string; next: number; committed: number; queue: Packet[]; writing: boolean; committing: boolean; cancelled: boolean; reportedComplete: boolean; flushRequested: boolean; pendingBatch?: PendingBatch; cleanup?: Promise<void>; timer?: number };
type Outgoing = { id: string; file: File; chunkSize: number; next: number; committed: number; ready: boolean; paused: boolean; done: boolean; error?: Error; progress: (bytes: number) => void; lastUpdate: number };
export type TransferEngineOptions = { getMaxMessageSize?: () => number | undefined };
export type TransferEvents = {
    receiving: (meta: FileMetadata, bytes: number) => void;
    received: (meta: FileMetadata) => void;
    cancelled?: (meta: FileMetadata) => void;
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
        bufferedLowEvents: 0, eventWaitWakes: 0, fallbackWaitWakes: 0,
        channelWaits: 0, channelFallbackWakes: 0, creditWaits: 0, creditFallbackWakes: 0,
        bufferedLowWakeCount: 0, bufferedLowWakeBytes: 0, bufferedLowWakeEmptyCount: 0,
        receiveTimerFlushes: 0, receiveTimerFlushedChunks: 0,
        sendOperationErrors: 0, sendRetryWaitMs: 0,
    };

    private data: RTCDataChannel;
    private control: RTCDataChannel;
    private room: () => string;
    private roomType: () => "persistent" | "temporary";
    private events: TransferEvents;
    private source: { peerId?: string; peerName?: string };
    private options: TransferEngineOptions;
    constructor(data: RTCDataChannel, control: RTCDataChannel, room: () => string, events: TransferEvents,
        roomType: () => "persistent" | "temporary" = () => "persistent",
        source: { peerId?: string; peerName?: string } = {}, options: TransferEngineOptions = {}) {
        this.data = data; this.control = control; this.room = room; this.events = events; this.roomType = roomType; this.source = source; this.options = options;
        data.binaryType = 'arraybuffer';
        data.bufferedAmountLowThreshold = LOW;
        data.addEventListener('bufferedamountlow', this.onBufferedAmountLow);
        data.addEventListener('message', this.onData);
        data.addEventListener('close', this.onClose);
        control.addEventListener('close', this.onClose);
    }

    private wake = () => { for (const fn of [...this.waiters]) fn(); };
    private emitError(message: string) {
        try { this.events.error(message); } catch (error) { console.error('Transfer error callback failed:', error); }
    }
    private emitReceiving(meta: FileMetadata, bytes: number) {
        try { this.events.receiving(meta, bytes); } catch (error) { console.error('Transfer progress callback failed:', error); }
    }
    private emitReceived(meta: FileMetadata) {
        try { this.events.received(meta); } catch (error) { console.error('Transfer completion callback failed:', error); }
    }
    private emitCancelled(meta: FileMetadata) {
        try { this.events.cancelled?.(meta); } catch (error) { console.error('Transfer cancellation callback failed:', error); }
    }
    private emitProgress(outgoing: Outgoing, bytes: number) {
        try { outgoing.progress(bytes); } catch (error) { console.error('Transfer progress callback failed:', error); }
    }
    private async checkAvailableStorage(meta: FileMetadata) {
        try {
            const estimate = await navigator.storage?.estimate?.();
            if (typeof estimate?.quota === 'number' && Number.isFinite(estimate.quota) &&
                typeof estimate.usage === 'number' && Number.isFinite(estimate.usage) &&
                estimate.quota - estimate.usage < meta.size) {
                throw new Error(`Not enough receiver storage is available for "${meta.name}". Free space and retry.`);
            }
        } catch (error) {
            if (error instanceof Error && error.message.startsWith('Not enough receiver storage')) throw error;
            // Storage estimates are advisory. IndexedDB remains the final quota check.
        }
    }
    private onBufferedAmountLow = () => {
        this.metrics.bufferedLowEvents++;
        this.wake();
    };
    private onClose = () => this.dispose();
    private message(value: object) {
        if (this.control.readyState !== 'open') throw new Error('Connection closed');
        this.control.send(JSON.stringify(value));
    }
    private async wait(timeout = 100): Promise<boolean> {
        if (this.disposed) throw new Error('Connection closed');
        let wokeByEvent = false;
        await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); this.waiters.delete(onWake); resolve(); };
            const onWake = () => { wokeByEvent = true; done(); };
            const timer = window.setTimeout(done, timeout);
            this.waiters.add(onWake);
        });
        if (wokeByEvent) this.metrics.eventWaitWakes++;
        else this.metrics.fallbackWaitWakes++;
        return wokeByEvent;
    }

    handle(message: Record<string, unknown>): boolean {
        if (typeof message.type !== 'string' || !message.type.startsWith('transfer_')) return false;
        this.controlTasks = this.controlTasks.then(() => this.onControl(message)).catch(error => {
            const failure = error instanceof Error ? error : new Error(String(error));
            if (this.outgoing && message.fileId === this.outgoing.id) { this.outgoing.error = failure; this.wake(); }
            else if (message.type === 'transfer_meta' && this.control.readyState === 'open') {
                const incoming = this.incoming;
                const messageText = incoming && incoming.wireId === message.fileId
                    ? failure instanceof DOMException && failure.name === 'QuotaExceededError'
                        ? `Not enough receiver storage for "${incoming.meta.name}". Free space and retry.`
                        : failure.message.startsWith('Not enough receiver storage')
                            ? failure.message
                            : `Unable to prepare "${incoming.meta.name}": ${failure.message}`
                    : failure.message;
                if (incoming && incoming.wireId === message.fileId && !incoming.reportedComplete) {
                    incoming.cancelled = true;
                    void this.removeIncomplete(incoming);
                    this.incoming = null;
                }
                try { this.message({ type: 'transfer_error', fileId: message.fileId, message: messageText }); } catch { /* The peer has left. */ }
                this.emitError(messageText);
            } else this.failIncoming(failure);
        });
        return true;
    }

    private async onControl(msg: Record<string, unknown>) {
        if (this.disposed) return;
        const out = this.outgoing;
        if (msg.type === 'transfer_meta') {
            if (this.incoming && !this.incoming.cancelled && this.incoming.meta.status !== 'complete') throw new Error('Receiver already busy');
            const { fileId, name, size, totalChunks, chunkSize, path } = msg;
            const validVersionAndChunkSize = msg.version === 3
                ? chunkSize === LEGACY_CHUNK_SIZE
                : msg.version === 4 && Number.isSafeInteger(chunkSize) && Number(chunkSize) >= 1 && Number(chunkSize) <= LEGACY_CHUNK_SIZE;
            if (typeof fileId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(fileId) || !validTransferName(name) ||
                !validTransferPath(path) || !Number.isSafeInteger(size) || Number(size) < 0 || !validVersionAndChunkSize ||
                totalChunks !== Math.ceil(Number(size) / Number(chunkSize)) || Number(totalChunks) > 0x1_0000_0000) {
                throw new Error('This transfer uses unsupported metadata. Update PeerLink on both devices and retry.');
            }
            const localId = crypto.randomUUID();
            const meta: FileMetadata = { fileId: localId, sourcePeerId: this.source.peerId, sourceFileId: fileId, sourceName: this.source.peerName,
                sharedWithRoom: msg.sharedWithRoom === true, name, size: Number(size), totalChunks: Number(totalChunks), chunkSize: Number(chunkSize),
                roomId: this.room(), roomType: this.roomType(), path: path || undefined,
                mimeType: typeof msg.mimeType === 'string' ? msg.mimeType : '', receivedChunks: 0, status: 'receiving', createdAt: Date.now() };
            const incoming: Incoming = { meta, wireId: fileId, next: 0, committed: 0, queue: [], writing: false, committing: false,
                cancelled: false, reportedComplete: false, flushRequested: false };
            this.incoming = incoming;
            await this.checkAvailableStorage(meta);
            if (this.disposed || incoming.cancelled || this.incoming !== incoming) {
                await this.removeIncomplete(incoming);
                return;
            }
            const storageStarted = performance.now();
            try { await saveMetaData(meta); }
            finally { this.metrics.storageMs += performance.now() - storageStarted; }
            if (this.disposed || incoming.cancelled || this.incoming !== incoming) {
                await this.removeIncomplete(incoming);
                return;
            }
            this.emitReceiving(meta, 0);
            this.message({ type: 'transfer_ready', fileId });
            if (!meta.totalChunks) await this.finishIncoming(incoming);
        } else if (msg.type === 'transfer_cancel') {
            const incoming = this.incoming;
            if (incoming && incoming.wireId === msg.fileId) {
                if (incoming.reportedComplete) return;
                incoming.cancelled = true;
                incoming.committing = false;
                clearTimeout(incoming.timer);
                incoming.queue = [];
                incoming.pendingBatch = undefined;
                incoming.flushRequested = false;
                await this.removeIncomplete(incoming);
                this.emitCancelled({ ...incoming.meta });
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
                    this.emitProgress(out, Math.min(count * out.chunkSize, out.file.size));
                }
                if (msg.type === 'transfer_complete' && count === Math.ceil(out.file.size / out.chunkSize)) out.done = true;
            }
            if (msg.type === 'transfer_error') {
                const reason = String(msg.message);
                out.error = new Error(reason === 'Incompatible transfer metadata'
                    ? 'This peer is running an older version of PeerLink. Update both devices and retry.' : reason);
            }
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
            const chunkSize = incoming.meta.chunkSize ?? LEGACY_CHUNK_SIZE;
            const expected = Math.min(chunkSize, incoming.meta.size - index * chunkSize);
            if (index !== incoming.next || expected <= 0 || packet.byteLength - 38 - length !== expected) throw new Error('File chunk sequence or size mismatch');
            if (incoming.next - incoming.committed >= WINDOW) throw new Error('Receiver buffer limit exceeded');
            incoming.next++;
            incoming.queue.push({ chunkIndex: index, data: packet.slice(38 + length), hash: new Uint8Array(packet.slice(6 + length, 38 + length)) });
            this.metrics.peakReceiveBytes = Math.max(this.metrics.peakReceiveBytes,
                Math.min(incoming.next * chunkSize, incoming.meta.size) - Math.min(incoming.committed * chunkSize, incoming.meta.size));
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
        }, 128);
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

        const timerFlush = !full && !final && incoming.flushRequested;
        clearTimeout(incoming.timer);
        incoming.timer = undefined;
        incoming.flushRequested = false;
        const packets = incoming.queue.splice(0, RECEIVE_BATCH);
        const validation = this.validateBatch(packets);
        // A speculative digest can reject while IndexedDB is committing the prior batch.
        // Mark it handled now; the ordered writer still awaits it before saving.
        void validation.catch(() => undefined);
        incoming.pendingBatch = { packets, validation, timerFlush };
    }

    private failIncoming(error: Error) {
        const incoming = this.incoming;
        const message = incoming
            ? error instanceof DOMException && error.name === 'QuotaExceededError'
                ? `Not enough receiver storage for "${incoming.meta.name}". Free space and retry.`
                : `Unable to receive "${incoming.meta.name}": ${error.message}`
            : error instanceof DOMException && error.name === 'QuotaExceededError'
                ? 'Not enough receiver storage. Free space and retry.' : error.message;
        if (incoming && !incoming.reportedComplete) {
            incoming.cancelled = true;
            incoming.committing = false;
            clearTimeout(incoming.timer);
            incoming.queue = [];
            incoming.pendingBatch = undefined;
            incoming.flushRequested = false;
            void this.removeIncomplete(incoming);
            if (this.control.readyState === 'open') {
                try { this.message({ type: 'transfer_error', fileId: incoming.wireId, message }); } catch { /* The peer has left. */ }
            }
        }
        this.emitError(message);
    }

    private removeIncomplete(incoming: Incoming): Promise<void> {
        if (incoming.reportedComplete) return Promise.resolve();
        if (incoming.cleanup) return incoming.cleanup;
        incoming.cleanup = deleteFile(incoming.meta.fileId).catch(error => {
            const detail = error instanceof Error ? error.message : String(error);
            this.emitError(`Unable to remove incomplete file "${incoming.meta.name}" from receiver storage: ${detail}`);
        });
        return incoming.cleanup;
    }

    private async finishIncoming(incoming: Incoming) {
        const needsPersistence = incoming.meta.status !== 'complete';
        incoming.meta.status = 'complete';
        if (needsPersistence) {
            incoming.meta.completedAt = Date.now();
            const storageStarted = performance.now();
            try { await saveMetaData(incoming.meta); }
            finally { this.metrics.storageMs += performance.now() - storageStarted; }
        }
        if (incoming.cancelled || this.disposed) return;
        incoming.reportedComplete = true;
        this.emitReceived({ ...incoming.meta });
        try { this.message({ type: 'transfer_complete', fileId: incoming.wireId, committed: incoming.committed }); }
        catch (error) {
            this.emitError(`"${incoming.meta.name}" was saved, but the sender could not be notified: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async flush(incoming: Incoming) {
        if (incoming.writing || incoming.cancelled || this.disposed) return;
        incoming.writing = true;
        try {
            while ((incoming.pendingBatch || incoming.queue.length) && !incoming.cancelled && !this.disposed) {
                let batch: Packet[];
                let validation: Promise<void>;
                let timerFlush = false;
                if (incoming.pendingBatch) {
                    ({ packets: batch, validation, timerFlush } = incoming.pendingBatch);
                    incoming.pendingBatch = undefined;
                } else {
                    const full = incoming.queue.length >= RECEIVE_BATCH;
                    const final = incoming.next === incoming.meta.totalChunks;
                    if (!full && !final && !incoming.flushRequested) break;
                    timerFlush = !full && !final && incoming.flushRequested;
                    clearTimeout(incoming.timer);
                    incoming.timer = undefined;
                    incoming.flushRequested = false;
                    batch = incoming.queue.splice(0, RECEIVE_BATCH);
                    validation = this.validateBatch(batch);
                }
                if (timerFlush) {
                    this.metrics.receiveTimerFlushes++;
                    this.metrics.receiveTimerFlushedChunks += batch.length;
                }
                await validation;
                if (incoming.cancelled || this.disposed) return;
                const committed = incoming.committed + batch.length;
                const completesFile = committed === incoming.meta.totalChunks;
                const completedAt = completesFile ? Date.now() : undefined;
                const storageStarted = performance.now();
                incoming.committing = true;
                const storageCommit = saveChunks(incoming.meta.fileId, batch, {
                    ...incoming.meta, receivedChunks: committed, status: completesFile ? 'complete' : 'receiving',
                    ...(completedAt === undefined ? {} : { completedAt }),
                });
                // Start at most one following batch's digest while this transaction commits.
                // Partial batches still wait for the 128 ms coalescing timer.
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
                if (completesFile) {
                    incoming.meta.status = 'complete';
                    incoming.meta.completedAt = completedAt;
                }
                this.metrics.receivedBytes += batch.reduce((n, packet) => n + packet.data.byteLength, 0);
                const chunkSize = incoming.meta.chunkSize ?? LEGACY_CHUNK_SIZE;
                this.emitReceiving(incoming.meta, Math.min(committed * chunkSize, incoming.meta.size));
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
            try { this.getWorker().postMessage({ type: 'read', requestId, fileId: out.id, start, count, chunkSize: out.chunkSize }); }
            catch (error) {
                clearTimeout(timer);
                this.reads.delete(requestId);
                this.metrics.pendingReads = this.reads.size;
                reject(error instanceof Error ? error : new Error(String(error)));
            }
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
        const path = file.webkitRelativePath || undefined;
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !validTransferName(file.name) || !validTransferPath(path) ||
            !Number.isSafeInteger(file.size) || file.size < 0) {
            throw new Error('The file name or relative path is not supported. Rename the file and retry.');
        }
        const chunkSize = transferChunkSize(id, this.options.getMaxMessageSize);
        const out: Outgoing = { id, file, chunkSize, next: 0, committed: 0, ready: false, paused: false, done: false, progress, lastUpdate: 0 };
        this.outgoing = out;
        const totalChunks = Math.ceil(file.size / out.chunkSize);
        if (totalChunks > 0x1_0000_0000) {
            this.outgoing = null;
            throw new Error('This file exceeds the transfer protocol size limit.');
        }
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
            this.message({ type: 'transfer_meta', version: 4, fileId: id, name: file.name, path, sharedWithRoom,
                mimeType: getFileMimeType(file), size: file.size, totalChunks, chunkSize: out.chunkSize });
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
                            const lowEventsBeforeWait = this.metrics.bufferedLowEvents;
                            const waitStarted = performance.now();
                            let wokeByEvent = false;
                            try { wokeByEvent = await this.wait(); }
                            finally {
                                const waited = performance.now() - waitStarted;
                                if (paused) this.metrics.pausedWaitMs += waited;
                                if (creditBlocked) {
                                    this.metrics.creditWaitMs += waited;
                                    this.metrics.creditWaits++;
                                    if (!wokeByEvent) this.metrics.creditFallbackWakes++;
                                }
                                if (channelBlocked) {
                                    this.metrics.channelWaitMs += waited;
                                    this.metrics.channelWaits++;
                                    if (!wokeByEvent) this.metrics.channelFallbackWakes++;
                                    else if (this.metrics.bufferedLowEvents > lowEventsBeforeWait) {
                                        const bufferedBytes = this.data.bufferedAmount;
                                        this.metrics.bufferedLowWakeCount++;
                                        this.metrics.bufferedLowWakeBytes += bufferedBytes;
                                        if (bufferedBytes === 0) this.metrics.bufferedLowWakeEmptyCount++;
                                    }
                                }
                            }
                        }
                        check();
                        try { this.data.send(packet); break; }
                        catch (error) {
                            if (!(error instanceof DOMException) || error.name !== 'OperationError') throw error;
                            this.metrics.sendOperationErrors++;
                            if (attempts >= 20) throw error;
                            const retryWaitStarted = performance.now();
                            try { await this.wait(8); }
                            finally { this.metrics.sendRetryWaitMs += performance.now() - retryWaitStarted; }
                            check();
                        }
                    }
                    out.next++;
                    this.metrics.sentBytes += Math.min(out.chunkSize, file.size - (out.next - 1) * out.chunkSize);
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
    updateSourceName(peerName: string) {
        this.source.peerName = peerName;
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
            void this.removeIncomplete(this.incoming);
        }
        this.clearWorker(); this.wake();
        this.data.removeEventListener('bufferedamountlow', this.onBufferedAmountLow);
        this.data.removeEventListener('message', this.onData);
        this.data.removeEventListener('close', this.onClose);
        this.control.removeEventListener('close', this.onClose);
    }
}
