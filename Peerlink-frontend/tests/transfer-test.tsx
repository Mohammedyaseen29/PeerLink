import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useP2P } from '../src/hooks/useP2P';
import { openDB, deleteFile, getChunkIndices, getFilesInRoom, releasePreviewUrl, type FileMetadata } from '../src/ProgressDB';

type Peer = ReturnType<typeof useP2P>;
const peers: Peer[] = [];
const signalingSockets: Array<{ socket: WebSocket; peerId?: string }> = [];
const signaledOffers: Array<{ peerId?: string; targetPeerId?: string; sdp?: string }> = [];
const reconnectLinks: Array<{ peerId?: string; targetPeerId?: string; linkId?: string }> = [];
const rtcPeers: RTCPeerConnection[] = [];
const nativeDataFrameSizes: number[] = [];
const instrumentedDataChannelPrototypes = new WeakSet<object>();
function instrumentDataChannel(channel: RTCDataChannel) {
    const prototype = Object.getPrototypeOf(channel) as RTCDataChannel & { send: RTCDataChannel['send'] };
    if (instrumentedDataChannelPrototypes.has(prototype)) return;
    instrumentedDataChannelPrototypes.add(prototype);
    const nativeDataSend = prototype.send;
    prototype.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if ((this as RTCDataChannel).label === 'data') {
            const size = typeof data === 'string' ? new TextEncoder().encode(data).byteLength
                : data instanceof Blob ? data.size
                    : data instanceof ArrayBuffer ? data.byteLength
                        : ArrayBuffer.isView(data) ? data.byteLength : 0;
            nativeDataFrameSizes.push(size);
        }
        return nativeDataSend.call(this, data);
    };
}
const NativeRTCPeerConnection = window.RTCPeerConnection;
window.RTCPeerConnection = new Proxy(NativeRTCPeerConnection, {
    construct(target, args, newTarget) {
        const peer = Reflect.construct(target, args, newTarget) as RTCPeerConnection;
        rtcPeers.push(peer);
        const nativeCreateDataChannel = peer.createDataChannel.bind(peer);
        peer.createDataChannel = function (label, options) {
            const channel = nativeCreateDataChannel(label, options);
            instrumentDataChannel(channel);
            return channel;
        };
        return peer;
    },
});
let failNextWorkerRead = false;
const NativeWorker = window.Worker;
window.Worker = new Proxy(NativeWorker, {
    construct(target, args) {
        const worker = Reflect.construct(target, args, target);
        const post = worker.postMessage.bind(worker);
        (worker as Worker & { postMessage: (message: unknown, transfer?: Transferable[]) => void }).postMessage =
            (message: unknown, transfer?: Transferable[]) => {
                if (failNextWorkerRead && message && typeof message === 'object' &&
                    (message as { type?: unknown }).type === 'read') {
                    failNextWorkerRead = false;
                    const requestId = (message as { requestId?: unknown }).requestId;
                    queueMicrotask(() => worker.dispatchEvent(new MessageEvent('message', {
                        data: { requestId, error: 'Synthetic worker read failure' },
                    })));
                    return;
                }
                post(message, transfer as Transferable[] | undefined);
            };
        return worker;
    },
});
const nativeWebSocketSend = WebSocket.prototype.send;
WebSocket.prototype.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (typeof data === 'string') {
        try {
                const message = JSON.parse(data);
                if (message.type === 'offer') {
                    const socketEntry = signalingSockets.find(entry => entry.socket === this);
                    signaledOffers.push({ peerId: socketEntry?.peerId, targetPeerId: message.targetPeerId,
                        sdp: message.payload?.sdp });
                }
                if (message.type === 'reconnect') {
                    const socketEntry = signalingSockets.find(entry => entry.socket === this);
                    reconnectLinks.push({ peerId: socketEntry?.peerId, targetPeerId: message.targetPeerId,
                        linkId: message.linkId });
                }
                if (message.type === 'join' && !signalingSockets.some(entry => entry.socket === this)) {
                const entry: { socket: WebSocket; peerId?: string } = { socket: this };
                this.addEventListener('message', event => {
                    try {
                        const message = JSON.parse(String(event.data));
                        if (message.type === 'joined' && typeof message.peerId === 'string') entry.peerId = message.peerId;
                    } catch { /* The application handles malformed signaling frames. */ }
                });
                signalingSockets.push(entry);
            }
        } catch { /* Non-JSON data channels are not signaling joins. */ }
    }
    return nativeWebSocketSend.call(this, data);
};
function PeerPanel({ index }: { index: number }) {
    const peer = useP2P(); peers[index] = peer;
    return <p>Peer {index}: {peer.connected ? peer.connectionType : 'connecting'} | Sent {peer.sendQueue.filter(f => f.status === 'sent').length} | Received {peer.receivedFiles.length} | Progress {peer.sendQueue.at(-1)?.bytesTransferred ?? peer.currentReceiving?.bytesReceived ?? 0} | Metrics {JSON.stringify(peer.transferMetrics)} | {peer.toast?.message}</p>;
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, description: string, timeout = 300000) {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
        if (peers.some(peer => peer.sendQueue.some(file => file.status === 'failed'))) throw new Error(peers.map(peer => peer.toast?.message).join('; '));
        await delay(25);
    }
}
async function untilWithoutFailureCheck(predicate: () => boolean, description: string, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
        await delay(25);
    }
}
const pattern = new Uint8Array(1024 * 1024);
for (let i = 0; i < pattern.length; i++) pattern[i] = (i * 31 + (i >>> 8)) & 255;
function source(size: number, name: string, seed = 0) {
    const parts: BlobPart[] = [];
    for (let offset = 0; offset < size; offset += pattern.length) {
        const length = Math.min(pattern.length, size - offset);
        if (seed === 0) parts.push(pattern.subarray(0, length));
        else {
            const content = new Uint8Array(length);
            for (let index = 0; index < length; index++) content[index] = (pattern[index] + seed) & 255;
            parts.push(content);
        }
    }
    return new File(parts, name, { type: 'application/octet-stream' });
}
function iceUfrag(sdp?: string) { return sdp?.match(/^a=ice-ufrag:([^\r\n]+)/m)?.[1]; }
async function verify(meta: FileMetadata, seed = 0) {
    const db = await openDB();
    let offset = 0, index = 0;
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('chunks', 'readonly');
        const request = tx.objectStore('chunks').openCursor(IDBKeyRange.bound([meta.fileId, 0], [meta.fileId, Number.MAX_SAFE_INTEGER]));
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            if (cursor.value.chunkIndex !== index++) { reject(new Error('Stored chunk gap')); return; }
            const bytes = new Uint8Array(cursor.value.data);
            for (const byte of bytes) {
                if (byte !== ((pattern[offset++ % pattern.length] + seed) & 255)) { reject(new Error('Stored byte mismatch')); return; }
            }
            cursor.continue();
        };
        tx.oncomplete = () => offset === meta.size && index === meta.totalChunks ? resolve() : reject(new Error('Stored length mismatch'));
        tx.onerror = () => reject(tx.error);
    });
}
async function verifyExactMedia(meta: FileMetadata, expected: Uint8Array, expectedHash: ArrayBuffer) {
    const db = await openDB();
    const bytes = new Uint8Array(meta.size);
    let offset = 0, index = 0;
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('chunks', 'readonly');
        const request = tx.objectStore('chunks').openCursor(IDBKeyRange.bound([meta.fileId, 0], [meta.fileId, Number.MAX_SAFE_INTEGER]));
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            if (cursor.value.chunkIndex !== index++) { reject(new Error(`Media chunk gap: ${meta.name}`)); return; }
            const chunk = new Uint8Array(cursor.value.data);
            bytes.set(chunk, offset); offset += chunk.length;
            cursor.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    if (offset !== expected.length || offset !== meta.size || index !== meta.totalChunks ||
        bytes.some((byte, i) => byte !== expected[i])) throw new Error(`Exact media bytes mismatch: ${meta.name}`);
    const actualHash = await crypto.subtle.digest('SHA-256', bytes);
    if (new Uint8Array(actualHash).some((byte, i) => byte !== new Uint8Array(expectedHash)[i])) throw new Error(`Media SHA-256 mismatch: ${meta.name}`);
}
async function runTwoMemberCapacityTest(room: string, append: (line: string) => void, extended: boolean) {
    append('Joining a two-member room, rejecting a third join, and retaining the open pair...');
    peers[0].join(room, 'temporary');
    await until(() => peers[0].inRoom && peers[0].selfPeerId && peers[0].signalingStatus === 'waiting', 'first signaling member joined');
    peers[1].join(room);
    await until(() => peers.slice(0, 2).every(peer => peer.inRoom && peer.members.length === 1 && peer.connected &&
        peer.members[0]?.status === 'connected'), 'two-member mesh connected');
    peers[2].join(room);
    await until(() => peers[2].signalingStatus === 'full' && peers[2].toast?.message.includes('2 people') &&
        peers[2].members.length === 0, 'third member rejected at room capacity');
    const connectedSockets = () => signalingSockets.filter(entry => entry.socket.readyState === WebSocket.OPEN);
    if (connectedSockets().length !== 2 || peers.slice(0, 2).some(peer => peer.members.length !== 1 || !peer.connected)) {
        throw new Error('Rejecting a third member affected the existing two-member room');
    }
    if (!peers[2].inRoom || peers[2].signalingStatus !== 'full') throw new Error('Rejected member did not remain on the durable room-full screen');
    append('PASS: third join was rejected cleanly; both existing members stayed connected at 2/2');

    if (extended) {
        await delay(50_500);
        if (peers[0].members.length !== 1 || peers[1].members.length !== 1 || peers[2].signalingStatus !== 'full') {
            throw new Error('An idle room changed membership after heartbeat intervals');
        }
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
        await delay(400);
        if (peers[0].members.length !== 1 || peers[1].members.length !== 1) throw new Error('Focus/visibility sync lost an active member');
        append('PASS: room membership remained 2/2 across idle heartbeats and focus sync');
    }

    const firstId = peers[0].selfPeerId, secondId = peers[1].selfPeerId;
    const pairIds = [firstId, secondId].sort();
    const pairForEndpoint = (low: boolean) => {
        const offer = [...signaledOffers].reverse().find(item => item.sdp && item.peerId === pairIds[0] && item.targetPeerId === pairIds[1]);
        const ufrag = iceUfrag(offer?.sdp);
        if (!ufrag) return undefined;
        const sender = rtcPeers.find(pc => iceUfrag(pc.localDescription?.sdp) === ufrag);
        const receiver = rtcPeers.find(pc => iceUfrag(pc.remoteDescription?.sdp) === ufrag);
        if (!sender || !receiver) return undefined;
        return low ? (offer!.peerId === pairIds[0] ? sender : receiver) : (offer!.peerId === pairIds[1] ? sender : receiver);
    };
    const savedBeforeRetry = source(16391, 'two-member-room-file.bin', 29);
    peers[0].setSelectedPeerIds([secondId]);
    await peers[0].addFilesToQueue([savedBeforeRetry]);
    await until(() => peers[1].receivedFiles.some(meta => meta.name === savedBeforeRetry.name), 'pair transfer before RTC fault');
    const saved = peers[1].receivedFiles.find(meta => meta.name === savedBeforeRetry.name)!;
    await verify(saved, 29);
    let firstLinkId: string | undefined;
    for (const [label, low] of [['lower UUID endpoint', true], ['upper UUID endpoint', false]] as const) {
        const pc = pairForEndpoint(low);
        if (!pc) throw new Error(`Unable to map ${label} from signaling SDP`);
        const linksBefore = reconnectLinks.filter(link => link.peerId === pairIds[0] && link.targetPeerId === pairIds[1]).length;
        pc.close();
        await delay(350);
        if (connectedSockets().length !== 2 || peers[0].members.length !== 1 || peers[1].members.length !== 1) {
            throw new Error(`RTC failure at ${label} changed the 2/2 room roster`);
        }
        await until(() => peers[0].members[0]?.status === 'connected' && peers[1].members[0]?.status === 'connected',
            `RTC connection recovered after ${label} failure`, 45_000);
        await until(() => reconnectLinks.filter(link => link.peerId === pairIds[0] && link.targetPeerId === pairIds[1] && link.linkId).length > linksBefore,
            `new link ID after ${label} failure`, 10_000);
        if (low && !firstLinkId) firstLinkId = reconnectLinks.find(link => link.peerId === pairIds[0] &&
            link.targetPeerId === pairIds[1])?.linkId;
    }
    const freshLinkId = [...reconnectLinks].reverse().find(link => link.peerId === pairIds[0] && link.targetPeerId === pairIds[1])?.linkId;
    if (!firstLinkId || !freshLinkId || firstLinkId === freshLinkId) throw new Error('Reconnects did not mint distinct link IDs');
    const lowSocket = signalingSockets.find(entry => entry.peerId === pairIds[0])!.socket;
    lowSocket.send(JSON.stringify({ type: 'offer', roomId: room, targetPeerId: pairIds[1], linkId: firstLinkId,
        payload: { type: 'offer', sdp: 'stale-link-offer' } }));
    lowSocket.send(JSON.stringify({ type: 'ice_candidate', roomId: room, targetPeerId: pairIds[1], linkId: firstLinkId,
        payload: { candidate: 'candidate:stale', sdpMid: '0', sdpMLineIndex: 0 } }));
    await delay(350);
    if (peers[0].members[0]?.status !== 'connected' || peers[1].members[0]?.status !== 'connected') {
        throw new Error('A stale offer or ICE candidate disturbed the repaired pair');
    }
    if (!(await getFilesInRoom(room)).some(meta => meta.fileId === saved.fileId)) throw new Error('RTC recovery deleted the stored room file');
    await peers[0].addFilesToQueue([source(9001, 'two-member-after-recovery.bin', 31)]);
    await until(() => peers[1].receivedFiles.some(meta => meta.name === 'two-member-after-recovery.bin'), 'pair transfer after recovery', 45_000);
    await verify(peers[1].receivedFiles.find(meta => meta.name === 'two-member-after-recovery.bin')!, 31);
    append('PASS: each RTC endpoint recovered without losing 2/2 membership; stale signaling was ignored and bytes/storage verified');

    peers[1].leaveRoom();
    await until(() => !peers[1].inRoom && peers[0].members.length === 0, 'manual leave updates the remaining member roster');
    peers[2].leaveRoom();
    await until(() => !peers[2].inRoom, 'rejected member clears local room state');
    peers[2].join(room);
    await until(() => peers[0].members.length === 1 && peers[2].members.length === 1 && peers[0].connected && peers[2].connected,
        'available slot admits a replacement member', 45_000);
    await peers[2].addFilesToQueue([source(7003, 'replacement-member-transfer.bin', 37)]);
    await until(() => peers[0].receivedFiles.some(meta => meta.name === 'replacement-member-transfer.bin'), 'replacement member sends exact file');
    await verify(peers[0].receivedFiles.find(meta => meta.name === 'replacement-member-transfer.bin')!, 37);
    peers[2].leaveRoom(); await until(() => !peers[2].inRoom, 'replacement member leaves');
    peers[1].join(room);
    await until(() => peers[0].members.length === 1 && peers[1].members.length === 1 && peers[0].connected && peers[1].connected,
        'manually left member rejoins', 45_000);
    append('PASS: manual leave freed one slot; another member joined and byte-verified transfer; original member rejoined');
    for (const peer of peers) peer.leaveRoom();
}
function Tests() {
    const [log, setLog] = useState('Ready');
    const [running, setRunning] = useState(false);
    const [mounted, setMounted] = useState(true);
    const groupMode = new URLSearchParams(location.search).has('group');
    const failureMode = new URLSearchParams(location.search).has('group-failure');
    const membershipMode = new URLSearchParams(location.search).has('membership');
    const append = (line: string) => setLog(previous => previous + '\n' + line);
    async function run() {
        setRunning(true); setLog(groupMode || failureMode || membershipMode ? 'Connecting three real application hooks through local WebSockets...' : 'Connecting two real application hooks through local WebSockets...');
        signalingSockets.length = 0;
        signaledOffers.length = 0;
        reconnectLinks.length = 0;
        const room = `test-${crypto.randomUUID()}`;
        try {
            if (membershipMode || groupMode || failureMode) {
                await runTwoMemberCapacityTest(room, append, membershipMode || failureMode);
                append('TWO-MEMBER CAPACITY AND RECOVERY TESTS PASSED');
                return;
            }
            if (new URLSearchParams(location.search).has('rooms')) {
                peers[0].join(room, 'persistent');
                await until(() => peers[0].signalingStatus === 'waiting', 'persistent creator joined');
                peers[1].join(room);
                await until(() => peers.every(peer => peer.connected), 'persistent peers connected');
                await peers[0].addFilesToQueue([source(70001, 'saved-room.bin')]);
                await until(() => peers[1].receivedFiles.some(file => file.name === 'saved-room.bin'), 'persistent receive');
                await until(() => peers[0].sendQueue.at(-1)?.status === 'sent', 'persistent send committed');
                const saved = peers[1].receivedFiles.find(file => file.name === 'saved-room.bin')!;
                await verify(saved);
                peers[0].leaveRoom(); peers[1].leaveRoom();
                await until(() => peers.every(peer => !peer.inRoom && !peer.connected && peer.receivedFiles.length === 0), 'persistent peers left');
                peers[1].join(room);
                await until(() => peers[1].receivedFiles.some(file => file.fileId === saved.fileId), 'persistent room reopen');
                if (peers[1].connected) throw new Error('Persistent revisit unexpectedly needs a peer');
                const previewUrl = await peers[1].openPreview(saved);
                const previewBytes = new Uint8Array(await (await fetch(previewUrl)).arrayBuffer());
                await releasePreviewUrl(previewUrl);
                if (previewBytes.length !== saved.size || previewBytes.some((byte, index) => byte !== pattern[index % pattern.length])) {
                    throw new Error('Stored preview content mismatch');
                }
                append('PASS: persistent room reopens offline with intact local preview');
                const originalPicker = Object.getOwnPropertyDescriptor(window, 'showSaveFilePicker');
                const downloadedChunks: Uint8Array[] = [];
                let downloadClosed = false;
                Object.defineProperty(window, 'showSaveFilePicker', {
                    configurable: true,
                    value: async () => ({ createWritable: async () => ({
                        write: async (data: ArrayBuffer) => { downloadedChunks.push(new Uint8Array(data.slice(0))); },
                        close: async () => { downloadClosed = true; },
                        abort: async () => undefined,
                    }) }),
                });
                try { await peers[1].downloadFile(saved); }
                finally {
                    if (originalPicker) Object.defineProperty(window, 'showSaveFilePicker', originalPicker);
                    else Reflect.deleteProperty(window, 'showSaveFilePicker');
                }
                const downloadedBytes = new Uint8Array(saved.size);
                let downloadedLength = 0;
                for (const chunk of downloadedChunks) { downloadedBytes.set(chunk, downloadedLength); downloadedLength += chunk.byteLength; }
                if (!downloadClosed || downloadedLength !== saved.size ||
                    downloadedBytes.some((byte, index) => byte !== pattern[index % pattern.length])) {
                    throw new Error('Stored download content mismatch');
                }
                append('PASS: stored download stream matches the original bytes');
                await deleteFile(saved.fileId);
                if ((await getFilesInRoom(room)).some(file => file.fileId === saved.fileId) ||
                    (await getChunkIndices(saved.fileId)).length) throw new Error('Deleted file or chunks remained in room');
                append('PASS: deleted room file and chunks removed');
                peers[1].leaveRoom();

                const temporaryRoom = `test-${crypto.randomUUID()}`;
                peers[0].join(temporaryRoom, 'temporary');
                await until(() => peers[0].signalingStatus === 'waiting', 'temporary creator joined');
                peers[1].join(temporaryRoom);
                await until(() => peers.every(peer => peer.connected), 'temporary peers connected');
                if (peers[1].roomType !== 'temporary') throw new Error('Temporary room type did not reach joiner');
                await peers[0].addFilesToQueue([source(70001, 'temporary-room.bin')]);
                await until(() => peers[1].receivedFiles.some(file => file.name === 'temporary-room.bin'), 'temporary receive');
                await until(() => peers[0].sendQueue.at(-1)?.status === 'sent', 'temporary send committed');
                if (peers[1].receivedFiles[0].roomType !== 'temporary') throw new Error('Temporary metadata not marked');
                peers[1].leaveRoom(); peers[0].leaveRoom();
                for (let attempt = 0; attempt < 40; attempt++) {
                    if (!(await getFilesInRoom(temporaryRoom)).some(file => file.roomType === 'temporary')) break;
                    await delay(25);
                }
                if ((await getFilesInRoom(temporaryRoom)).some(file => file.roomType === 'temporary')) throw new Error('Temporary file survived leave');
                append('PASS: both peers use temporary room type and received files are removed on leave');
                setMounted(false);
                append('ROOM LIFECYCLE TESTS PASSED');
                return;
            }
            peers[0].join(room);
            await until(() => peers[0].inRoom, 'first room join');
            peers[1].join(room);
            await until(() => peers.every(peer => peer.connected), 'both data channels');
            append('Connected: ' + peers.map(peer => peer.connectionType).join(', '));
            const sizeMiB = new URLSearchParams(location.search).has('quick') ? 8 : 128;
            const big = source(sizeMiB * 1024 * 1024 + 123, 'large-test.bin');
            await peers[0].addFilesToQueue([big]);
            await until(() => Boolean(peers[0].sendQueue[0]?.startTime), 'large file send starts');
            const startedAt = peers[0].sendQueue[0]!.startTime!;
            const originalPeerIds = peers.map(peer => peer.selfPeerId);
            const originalRtcCount = rtcPeers.length;
            const interrupted = signalingSockets.find(entry => entry.peerId === originalPeerIds[0] && entry.socket.readyState === WebSocket.OPEN)!;
            interrupted.socket.close(1000, 'Regression: transient signaling loss during transfer');
            await until(() => signalingSockets.some(entry => entry !== interrupted && entry.peerId === originalPeerIds[0] && entry.socket.readyState === WebSocket.OPEN),
                'signaling rejoins with the same protocol2 peer identity', 30_000);
            await until(() => peers[0].signalingStatus !== 'offline', 'restored signaling clears its outage status');
            if (!peers.every((peer, index) => peer.connected && peer.inRoom && peer.selfPeerId === originalPeerIds[index]) || rtcPeers.length !== originalRtcCount) {
                throw new Error('Signaling recovery replaced a live RTC connection or room identity');
            }
            append('PASS: signaling drop/rejoin preserved protocol2 peer IDs, existing RTC links, and active transfer');
            await until(() => peers[0].sendQueue[0]?.status === 'sent', 'large file committed');
            const seconds = (Date.now() - startedAt) / 1000;
            append(`${sizeMiB} MiB sender start to receiver commit in ${seconds.toFixed(2)}s: ${(big.size / 1048576 / seconds).toFixed(2)} MiB/s`);
            await verify(peers[1].receivedFiles[0]); append('PASS: every stored byte matches source, including final partial chunk');
            if (new URLSearchParams(location.search).has('speed')) {
                append('ENGINE METRICS: ' + JSON.stringify(peers.map(peer => peer.transferMetrics)));
                const diagnostics = await Promise.all(peers.map(peer => peer.getTransferDiagnostics().catch(error => ({ error: String(error) }))));
                append('TRANSPORT DIAGNOSTICS: ' + JSON.stringify(diagnostics));
                for (const meta of peers[1].receivedFiles) await deleteFile(meta.fileId);
                setMounted(false);
                append('TRANSFER-ONLY TEST PASSED');
                return;
            }
            const batchCount = 500;
            const chunkBoundary = 16 * 1024 - 128;
            const boundarySizes = new Map<number, number>([
                [4, chunkBoundary - 1], [5, chunkBoundary], [6, chunkBoundary + 1],
                [7, 64 * 1024 - 1], [8, 64 * 1024], [9, 64 * 1024 + 1],
                [10, 1024 * 1024], [11, 1024 * 1024 + 123],
            ]);
            const specs = Array.from({ length: batchCount }, (_, i) => ({
                name: i < 3 ? 'duplicate.bin' : i === 3 ? '資料-🧪-résumé.bin' : `batch-${i}.bin`,
                size: i === 0 ? 0 : i === 1 ? 17 : i === 2 ? 31 : boundarySizes.get(i) ?? 1 + (i * 977) % 4096,
                seed: (i * 13 + 7) % 251,
            }));
            const batchKey = (name: string, size: number) => `${name}\u0000${size}`;
            if (new Set(specs.map(spec => batchKey(spec.name, spec.size))).size !== batchCount ||
                specs.filter(spec => spec.name === 'duplicate.bin').length !== 3) {
                throw new Error('The 500-file fixture did not generate unique contents with duplicate names');
            }
            const files = specs.map(spec => source(spec.size, spec.name, spec.seed));
            const receivedBeforeBatch = peers[1].receivedFiles.length;
            const queueBeforeBatch = peers[0].sendQueue.length;
            const framesBeforeBatch = nativeDataFrameSizes.length;
            await peers[0].addFilesToQueue(files);
            await until(() => {
                const batch = peers[0].sendQueue.slice(queueBeforeBatch);
                return batch.length === batchCount && batch.every(file => file.status === 'sent');
            }, '500-file mixed queue', 300000);
            const receivedBatch = peers[1].receivedFiles.slice(receivedBeforeBatch);
            const batchQueue = peers[0].sendQueue.slice(queueBeforeBatch);
            if (receivedBatch.length !== batchCount || new Set(receivedBatch.map(meta => meta.fileId)).size !== batchCount ||
                new Set(batchQueue.map(file => file.id)).size !== batchCount) {
                throw new Error(`Expected ${batchCount} unique sent/received IDs; got ${batchQueue.length}/${receivedBatch.length}`);
            }
            const metadataByNameAndSize = new Map(receivedBatch.map(meta => [batchKey(meta.name, meta.size), meta]));
            if (metadataByNameAndSize.size !== batchCount) throw new Error('Duplicate/missing received filename and size pair');
            for (const spec of specs) {
                const meta = metadataByNameAndSize.get(batchKey(spec.name, spec.size));
                if (!meta || meta.status !== 'complete' || meta.totalChunks !== Math.ceil(spec.size / (meta.chunkSize || chunkBoundary))) {
                    throw new Error(`Invalid received metadata for ${spec.name} (${spec.size} bytes)`);
                }
                await verify(meta, spec.seed);
            }
            const batchFrames = nativeDataFrameSizes.slice(framesBeforeBatch);
            const maxFrame = Math.max(0, ...batchFrames);
            const negotiatedCaps = rtcPeers.map(pc => pc.sctp?.maxMessageSize)
                .filter((cap): cap is number => typeof cap === 'number' && cap > 0 && Number.isFinite(cap));
            if (!batchFrames.length || maxFrame > 16 * 1024 || !negotiatedCaps.length || maxFrame > Math.min(...negotiatedCaps)) {
                throw new Error(`Native data frame/negotiated SCTP bound failed (max frame ${maxFrame}; caps ${negotiatedCaps.join(',') || 'unavailable'})`);
            }
            append(`PASS: ${batchCount} mixed files (empty, duplicate and Unicode names, 16/64 KiB boundaries, 1 MiB); IDs and bytes verified`);
            append(`PASS: ${batchFrames.length} native data-channel frames stayed within 16 KiB and negotiated SCTP max ${Math.min(...negotiatedCaps)} bytes`);
            const [photoBytes, videoBytes] = await Promise.all([
                fetch('/peerlink-logo.png').then(response => { if (!response.ok) throw new Error('Photo fixture unavailable'); return response.arrayBuffer(); }),
                fetch('/tests/peerlink-test-clip.mp4').then(response => { if (!response.ok) throw new Error('Video fixture unavailable'); return response.arrayBuffer(); }),
            ]);
            const photo = new Uint8Array(photoBytes), video = new Uint8Array(videoBytes);
            if (photo[0] !== 0x89 || photo[1] !== 0x50 || video[4] !== 0x66 || video[5] !== 0x74 || video[6] !== 0x79 || video[7] !== 0x70) {
                throw new Error('Media fixture signature check failed');
            }
            const [photoHash, videoHash] = await Promise.all([crypto.subtle.digest('SHA-256', photo), crypto.subtle.digest('SHA-256', video)]);
            const mediaFiles = Array.from({ length: 500 }, (_, i) => i % 2 === 0
                ? new File([photoBytes], `photo-${String(i).padStart(3, '0')}.png`, { type: 'image/png' })
                : new File([videoBytes], `clip-${String(i).padStart(3, '0')}.mp4`, { type: 'video/mp4' }));
            const mediaQueueStart = peers[0].sendQueue.length;
            const mediaReceivedStart = peers[1].receivedFiles.length;
            await peers[0].addFilesToQueue(mediaFiles);
            await until(() => peers[0].sendQueue.slice(mediaQueueStart).length === mediaFiles.length &&
                peers[0].sendQueue.slice(mediaQueueStart).every(file => file.status === 'sent') &&
                peers[1].receivedFiles.length - mediaReceivedStart === mediaFiles.length, '500 photo/video files transfer');
            const mediaQueue = peers[0].sendQueue.slice(mediaQueueStart);
            const mediaReceived = peers[1].receivedFiles.slice(mediaReceivedStart);
            if (new Set(mediaQueue.map(file => file.id)).size !== 500 || new Set(mediaReceived.map(file => file.fileId)).size !== 500) {
                throw new Error('Photo/video transfer produced duplicate or missing IDs');
            }
            const mediaByName = new Map(mediaReceived.map(meta => [meta.name, meta]));
            for (let i = 0; i < 500; i++) {
                const isPhoto = i % 2 === 0;
                const name = `${isPhoto ? 'photo' : 'clip'}-${String(i).padStart(3, '0')}.${isPhoto ? 'png' : 'mp4'}`;
                const meta = mediaByName.get(name);
                if (!meta || meta.size !== (isPhoto ? photo.length : video.length) || meta.mimeType !== (isPhoto ? 'image/png' : 'video/mp4')) {
                    throw new Error(`Missing or mislabeled media file: ${name}`);
                }
                await verifyExactMedia(meta, isPhoto ? photo : video, isPhoto ? photoHash : videoHash);
            }
            append(`PASS: 500 valid photo/video files (250 PNG ${photo.length} B, 250 MP4 ${video.length} B); unique IDs, exact bytes and SHA-256 verified`);
            await peers[0].addFilesToQueue([source(8 * 1048576, 'pause.bin')]);
            await until(() => (peers[0].sendQueue.find(f => f.file.name === 'pause.bin')?.bytesTransferred ?? 0) > 0, 'pause transfer starts');
            const id = peers[0].sendQueue.at(-1)!.id;
            peers[0].pauseSending(id);
            const sent = peers[0].transferMetrics!.sentBytes;
            await delay(600);
            if (peers[0].transferMetrics!.sentBytes !== sent) throw new Error('Sender continued while paused');
            peers[0].resumeSending(id);
            await until(() => peers[0].sendQueue.at(-1)?.status === 'sent', 'resume completes');
            if (peers[0].sendQueue.find(file => file.file.name === 'pause.bin')?.id !== id) {
                throw new Error('Pause/resume changed the active transfer ID');
            }
            await verify(peers[1].receivedFiles.at(-1)!); append('PASS: pause/resume and exact contents');
            await peers[0].addFilesToQueue([source(16 * 1048576, 'cancel.bin'), source(17, 'after-cancel.bin')]);
            await until(() => (peers[0].sendQueue.find(f => f.file.name === 'cancel.bin')?.progress ?? 0) > 0, 'cancel starts');
            await peers[0].removeFromQueue(peers[0].sendQueue.find(f => f.file.name === 'cancel.bin')!.id);
            await until(() => peers[0].sendQueue.at(-1)?.status === 'sent', 'queue continues after cancel');
            if (peers[1].receivedFiles.some(f => f.name === 'cancel.bin')) throw new Error('Cancelled file marked complete');
            const roomFilesAfterCancel = await getFilesInRoom(room);
            if (roomFilesAfterCancel.some(meta => meta.name === 'cancel.bin' || meta.status === 'receiving')) {
                throw new Error('Cancelled receive left a room row or partial metadata behind');
            }
            await verify(peers[1].receivedFiles.at(-1)!); append('PASS: cancellation and next-file startup');
            const retryQueueStart = peers[0].sendQueue.length;
            failNextWorkerRead = true;
            await peers[0].addFilesToQueue([source(16391, 'retry-fresh-id.bin', 89)]);
            await untilWithoutFailureCheck(() => peers[0].sendQueue.slice(retryQueueStart).some(file => file.status === 'failed'),
                'injected worker read failure');
            const failedAttempt = peers[0].sendQueue.slice(retryQueueStart).find(file => file.status === 'failed');
            if (!failedAttempt) throw new Error('Synthetic transfer did not fail before retry');
            const failedAttemptId = failedAttempt.id;
            peers[0].retrySending(failedAttemptId);
            await untilWithoutFailureCheck(() => peers[0].sendQueue.some(file => file.file.name === 'retry-fresh-id.bin' &&
                file.id !== failedAttemptId && file.status === 'sent'), 'retry with a fresh file ID');
            const retried = peers[0].sendQueue.find(file => file.file.name === 'retry-fresh-id.bin' && file.id !== failedAttemptId)!;
            const retriedMeta = peers[1].receivedFiles.find(meta => meta.name === 'retry-fresh-id.bin' && meta.size === 16391);
            if (retried.id === failedAttemptId || !retriedMeta) throw new Error('Explicit retry did not use a fresh ID and produce a receiver file');
            await verify(retriedMeta, 89);
            append('PASS: a failed read retried with a fresh transfer ID and exact content');
            peers[0].sendChatMessage('integration chat');
            await until(() => peers[1].chatMessages.some(m => m.content === 'integration chat'), 'chat');
            append('PASS: chat');
            await peers[0].addFilesToQueue([source(70001, 'forward.bin')]);
            await peers[1].addFilesToQueue([source(80003, 'reverse.bin')]);
            await until(() => peers[0].receivedFiles.some(f => f.name === 'reverse.bin') && peers[1].receivedFiles.some(f => f.name === 'forward.bin'), 'bidirectional transfers');
            await until(() => peers.every(peer => peer.sendQueue.at(-1)?.status === 'sent'), 'bidirectional completion');
            await verify(peers[0].receivedFiles.at(-1)!); await verify(peers[1].receivedFiles.at(-1)!);
            append('PASS: simultaneous bidirectional transfers');
            const metrics = peers.map(peer => peer.transferMetrics!);
            if (metrics.some(m => m.activeWorkers !== 0 || m.pendingReads !== 0)) throw new Error('Worker/read leak');
            if (metrics.some(m => m.peakBufferedBytes > 2 * 1048576 || m.peakReceiveBytes > 8 * 1048576)) throw new Error('Buffer cap exceeded');
            append('Resource counters: ' + JSON.stringify(metrics));
            // Only synthetic files created in this uniquely named test room are removed.
            for (const meta of peers[1].receivedFiles) await deleteFile(meta.fileId);
            for (const meta of peers[0].receivedFiles) await deleteFile(meta.fileId);
            setMounted(false); await delay(100);
            if (!metrics.every(m => m.disposed)) throw new Error('Unmount cleanup failed');
            append('PASS: bounded buffers, workers released, unmount disposal');
            append('ALL TESTS PASSED');
        } catch (error) { append('FAIL: ' + String(error)); }
        finally { setRunning(false); }
    }
    return <main><h1>PeerLink integration tests</h1><button disabled={running || !mounted} onClick={() => void run()}>Run integration tests</button>
        {mounted && Array.from({ length: groupMode || failureMode || membershipMode ? 3 : 2 }, (_, index) => <PeerPanel key={index} index={index} />)}<pre style={{ whiteSpace: 'pre-wrap' }}>{log}</pre></main>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Tests /></StrictMode>);
