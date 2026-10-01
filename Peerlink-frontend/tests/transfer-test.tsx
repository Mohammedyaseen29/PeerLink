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
const NativeRTCPeerConnection = window.RTCPeerConnection;
window.RTCPeerConnection = new Proxy(NativeRTCPeerConnection, {
    construct(target, args, newTarget) {
        const peer = Reflect.construct(target, args, newTarget) as RTCPeerConnection;
        rtcPeers.push(peer);
        return peer;
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
const pattern = new Uint8Array(1024 * 1024);
for (let i = 0; i < pattern.length; i++) pattern[i] = (i * 31 + (i >>> 8)) & 255;
function source(size: number, name: string, seed = 0) {
    const parts: BlobPart[] = [];
    const content = seed === 0 ? pattern : pattern.map((byte) => (byte + seed) & 255);
    for (let remaining = size; remaining > 0; remaining -= content.length) parts.push(content.subarray(0, Math.min(remaining, content.length)));
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
            if (membershipMode) {
                append('Joining three users and separating WebRTC transport failure from signaling departure...');
                peers[0].join(room, 'temporary');
                await until(() => peers[0].inRoom && peers[0].selfPeerId && peers[0].signalingStatus === 'waiting',
                    'membership test creator joined the signaling room');
                peers[1].join(room); peers[2].join(room);
                await until(() => peers.slice(0, 3).every(peer => peer.inRoom && peer.members.length === 2 &&
                    peer.members.every(member => member.status === 'connected')), 'three-member connected mesh');
                await until(() => signalingSockets.length === 3 && signalingSockets.every(entry => entry.peerId), 'all signaling sockets identified');
                if (rtcPeers.length !== 6) throw new Error(`Expected six mesh connections, got ${rtcPeers.length}`);
                append('Holding all three Chrome clients idle across two 25-second heartbeat intervals...');
                await delay(50_500);
                if (peers.slice(0, 3).some(peer => !peer.inRoom || peer.members.length !== 2)) {
                    throw new Error('An idle member disappeared from a room roster after two heartbeat intervals');
                }
                window.dispatchEvent(new Event('focus'));
                document.dispatchEvent(new Event('visibilitychange'));
                await delay(500);
                if (peers.slice(0, 3).some(peer => !peer.inRoom || peer.members.length !== 2)) {
                    throw new Error('Focus/visibility room resync changed the healthy three-member roster');
                }
                peers[2].setSelectedPeerIds([peers[1].selfPeerId]);
                await peers[2].addFilesToQueue([source(7013, 'third-peer-after-idle.bin', 27)]);
                await until(() => peers[1].receivedFiles.some(meta => meta.name === 'third-peer-after-idle.bin'), 'third-peer transfer after idle');
                await verify(peers[1].receivedFiles.find(meta => meta.name === 'third-peer-after-idle.bin')!, 27);
                append('PASS: all 3/4 rosters survived idle heartbeats and focus resync; third-peer transfer succeeded');

                const firstId = peers[0].selfPeerId, secondId = peers[1].selfPeerId;
                const targetId = secondId;
                const pairForFirstTwo = (lower: boolean) => {
                    const pairIds = [firstId, secondId].sort();
                    const offer = [...signaledOffers].reverse().find(item => item.sdp && item.peerId === pairIds[0] && item.targetPeerId === pairIds[1]);
                    const ufrag = iceUfrag(offer?.sdp);
                    if (!ufrag) return undefined;
                    const sender = rtcPeers.find(pc => iceUfrag(pc.localDescription?.sdp) === ufrag);
                    const receiver = rtcPeers.find(pc => iceUfrag(pc.remoteDescription?.sdp) === ufrag);
                    if (!sender || !receiver) return undefined;
                    return lower ? (offer!.peerId === pairIds[0] ? sender : receiver) : (offer!.peerId === pairIds[1] ? sender : receiver);
                };
                const pairIds = [firstId, secondId].sort();
                let firstRecoveryLink: string | undefined;
                const openSockets = () => signalingSockets.filter(entry => entry.socket.readyState === WebSocket.OPEN);
                const file = source(16391, 'membership-survives-rtc-drop.bin', 29);
                peers[0].setSelectedPeerIds([targetId]);
                await peers[0].addFilesToQueue([file]);
                await until(() => peers[1].receivedFiles.some(meta => meta.name === file.name), 'temporary file before transport drop');
                const saved = peers[1].receivedFiles.find(meta => meta.name === file.name)!;
                await verify(saved, 29);
                for (const [direction, lower] of [['lower UUID endpoint', true], ['upper UUID endpoint', false]] as const) {
                    const failedPeer = pairForFirstTwo(lower);
                    if (!failedPeer) throw new Error(`Could not map the ${direction} RTCPeerConnection from its signaling SDP`);
                    failedPeer.close();
                    await delay(350);
                    if (openSockets().length !== 3 || peers.slice(0, 3).some(peer => peer.members.length !== 2)) {
                        throw new Error(`RTC-only failure at ${direction} changed the authoritative 3/4 roster`);
                    }
                    await until(() => peers[0].members.find(member => member.peerId === secondId)?.status === 'connected' &&
                        peers[1].members.find(member => member.peerId === firstId)?.status === 'connected',
                        `RTC link healed after ${direction} failure`, 45_000);
                    await until(() => reconnectLinks.some(link => link.peerId === pairIds[0] &&
                        link.targetPeerId === pairIds[1] && typeof link.linkId === 'string'),
                        `fresh authenticated link ID after ${direction} failure`, 10_000);
                    if (lower && !firstRecoveryLink) firstRecoveryLink = reconnectLinks.find(link =>
                        link.peerId === pairIds[0] && link.targetPeerId === pairIds[1])?.linkId;
                    if (peers.slice(0, 3).some(peer => peer.members.length !== 2)) {
                        throw new Error(`Roster changed while healing ${direction} failure`);
                    }
                }
                const latestRecoveryLink = [...reconnectLinks].reverse().find(link =>
                    link.peerId === pairIds[0] && link.targetPeerId === pairIds[1])?.linkId;
                if (!firstRecoveryLink || !latestRecoveryLink || firstRecoveryLink === latestRecoveryLink) {
                    throw new Error('Expected distinct stale and current reconnect link IDs');
                }
                const lowerSocket = signalingSockets.find(entry => entry.peerId === pairIds[0])!.socket;
                lowerSocket.send(JSON.stringify({ type: 'offer', roomId: room, targetPeerId: pairIds[1],
                    linkId: firstRecoveryLink, payload: { type: 'offer', sdp: 'stale-link-offer' } }));
                lowerSocket.send(JSON.stringify({ type: 'ice_candidate', roomId: room, targetPeerId: pairIds[1],
                    linkId: firstRecoveryLink, payload: { candidate: 'candidate:stale', sdpMid: '0', sdpMLineIndex: 0 } }));
                await delay(350);
                if (peers.slice(0, 3).some(peer => peer.members.length !== 2) ||
                    peers[1].members.find(member => member.peerId === firstId)?.status !== 'connected') {
                    throw new Error('A stale offer or ICE candidate disturbed the recovered link');
                }
                if (!(await getFilesInRoom(room)).some(meta => meta.fileId === saved.fileId)) {
                    throw new Error('Temporary-room file was deleted during RTC-only recovery');
                }
                await peers[0].addFilesToQueue([source(9001, 'membership-after-rtc-recovery.bin', 31)]);
                await until(() => peers[1].receivedFiles.some(meta => meta.name === 'membership-after-rtc-recovery.bin'),
                    'transfer after transport recovery', 45_000);
                await verify(peers[1].receivedFiles.find(meta => meta.name === 'membership-after-rtc-recovery.bin')!, 31);
                append('PASS: WebRTC-only failure retained 3/4 rosters, preserved room files, and recovered peer transfer');

                const thirdEntry = signalingSockets.find(entry => entry.peerId === peers[2].selfPeerId)!;
                thirdEntry.socket.close();
                await until(() => peers[0].members.length === 1 && peers[1].members.length === 1 &&
                    peers[2].signalingStatus === 'offline' && peers[2].members.length === 0,
                    'signaling departure removes third member from all rosters', 15_000);
                if ((await getFilesInRoom(room)).some(meta => meta.roomType === 'temporary')) {
                    throw new Error('Temporary-room data survived signaling membership departure');
                }
                append('PASS: signaling loss removes membership and temporary-room data');
                peers[2].leaveRoom();
                await until(() => !peers[2].inRoom, 'third member leaves after signaling loss');
                peers[2].join(room);
                await until(() => peers.slice(0, 3).every(peer => peer.inRoom && peer.members.length === 2 &&
                    peer.members.every(member => member.status === 'connected')), 'third member rejoins with fresh roster', 45_000);
                append('PASS: rejoin restored a converged three-member roster');
                peers.forEach(peer => peer.leaveRoom());
                append('ROOM MEMBERSHIP TESTS PASSED');
                return;
            }
            if (failureMode) {
                for (const peer of peers) peer.join(room, 'persistent');
                await until(() => peers.every(peer => peer.inRoom && peer.members.length === 2), 'three room members joined');
                await until(() => peers.every(peer => peer.members.length === 2 && peer.members.every(member => member.status === 'connected')), 'three-peer mesh connected');
                await until(() => signalingSockets.some(entry => entry.peerId === peers[2].selfPeerId), 'third signaling socket identified');
                if (peers.some(peer => peer.members.length !== 2)) throw new Error('A room member is missing from the mesh');
                append('PASS: three users joined the same room and formed a mesh');

                // Simulate one malformed offer from the third member to the first. The
                // other peer link must stay usable when this negotiation fails.
                const thirdSocket = signalingSockets.find(entry => entry.peerId === peers[2].selfPeerId)!.socket;
                thirdSocket.send(JSON.stringify({ type: 'offer', roomId: room, targetPeerId: peers[0].selfPeerId,
                    payload: { type: 'offer', sdp: 'not-an-sdp' } }));
                await until(() => peers[0].toast?.message.includes('Unable to negotiate') ?? false, 'third-peer negotiation error surfaced', 10_000);
                const firstStillHasSecond = () => peers[0].members.some(member =>
                    member.peerId === peers[1].selfPeerId && member.status === 'connected');
                const secondStillHasFirst = () => peers[1].members.some(member =>
                    member.peerId === peers[0].selfPeerId && member.status === 'connected');
                if (!firstStillHasSecond() || !secondStillHasFirst() || !peers[0].inRoom || !peers[1].inRoom) {
                    throw new Error('A malformed third-peer offer disrupted the existing peer link');
                }
                append('PASS: malformed third-peer offer left the first peer link connected');

                peers[0].setSelectedPeerIds([peers[1].selfPeerId]);
                await peers[0].addFilesToQueue([source(70001, 'third-peer-regression.bin')]);
                await until(() => peers[1].receivedFiles.some(file => file.name === 'third-peer-regression.bin'), 'transfer after malformed offer');
                await until(() => peers[0].sendQueue.at(-1)?.status === 'sent', 'transfer after malformed offer committed');
                await verify(peers[1].receivedFiles.find(file => file.name === 'third-peer-regression.bin')!);
                append('PASS: existing peer transferred exact bytes after third-peer negotiation failure');
                for (const peer of peers) for (const meta of peer.receivedFiles) await deleteFile(meta.fileId);
                peers.forEach(peer => peer.leaveRoom());
                append('ALL THREE-PEER TESTS PASSED');
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
            if (new URLSearchParams(location.search).has('group')) {
                append('Joining a three-member room and checking direct recipient routes...');
                peers[0].join(room, 'persistent');
                await until(() => peers[0].inRoom, 'group creator joined');
                peers[1].join(room);
                peers[2].join(room);
                await until(() => peers.slice(0, 3).every(peer => peer.connected && peer.members.length === 2), 'three-member mesh');
                const recipientId = peers[1].selfPeerId;
                peers[0].setSelectedPeerIds([recipientId]);
                peers[2].setSelectedPeerIds([recipientId]);
                await until(() => peers[0].selectedPeerIds[0] === recipientId && peers[2].selectedPeerIds[0] === recipientId, 'target selections applied');
                await Promise.all([
                    peers[0].addFilesToQueue([source(96 * 1024 + 13, 'from-peer-a.bin', 17)]),
                    peers[2].addFilesToQueue([source(80 * 1024 + 7, 'from-peer-c.bin', 83)]),
                ]);
                await until(() =>
                    peers[1].receivedFiles.some(file => file.name === 'from-peer-a.bin') &&
                    peers[1].receivedFiles.some(file => file.name === 'from-peer-c.bin') &&
                    peers[0].sendQueue.some(file => file.file.name === 'from-peer-a.bin' && file.status === 'sent') &&
                    peers[2].sendQueue.some(file => file.file.name === 'from-peer-c.bin' && file.status === 'sent'),
                'two concurrent targeted sends');
                const fromA = peers[1].receivedFiles.find(file => file.name === 'from-peer-a.bin')!;
                const fromC = peers[1].receivedFiles.find(file => file.name === 'from-peer-c.bin')!;
                await verify(fromA, 17);
                await verify(fromC, 83);
                if (fromA.fileId === fromC.fileId || fromA.sourcePeerId !== peers[0].selfPeerId || fromC.sourcePeerId !== peers[2].selfPeerId) {
                    throw new Error('Incoming copies were not kept distinct by source');
                }
                const sentA = peers[0].sendQueue.find(file => file.file.name === 'from-peer-a.bin')!;
                const sentC = peers[2].sendQueue.find(file => file.file.name === 'from-peer-c.bin')!;
                if (sentA.recipientIds.join() !== recipientId || sentC.recipientIds.join() !== recipientId ||
                    peers[2].onlineFiles.some(file => file.name === 'from-peer-a.bin') ||
                    peers[0].onlineFiles.some(file => file.name === 'from-peer-c.bin')) {
                    throw new Error('A file catalog reached an unselected room member');
                }
                peers[0].sendChatMessage('group sender identity');
                await until(() => peers[1].chatMessages.some(message => message.content === 'group sender identity'), 'group chat');
                if (peers[1].chatMessages.find(message => message.content === 'group sender identity')?.senderId !== peers[0].selfPeerId) {
                    throw new Error('Group chat sender identity did not match the sending peer');
                }
                append('PASS: two simultaneous, byte-verified targeted copies; unselected catalog stayed private; chat identity is peer-based');
                peers[2].leaveRoom();
                await until(() => !peers[2].inRoom && peers[0].connected && peers[1].connected, 'third member leaves while pair remains');
                peers[0].setSelectedPeerIds([recipientId]);
                await peers[0].addFilesToQueue([source(32 * 1024 + 1, 'after-member-left.bin', 41)]);
                await until(() => peers[1].receivedFiles.some(file => file.name === 'after-member-left.bin'), 'remaining pair transfer');
                await verify(peers[1].receivedFiles.find(file => file.name === 'after-member-left.bin')!, 41);
                peers[2].join(room);
                await until(() => peers.slice(0, 3).every(peer => peer.connected && peer.members.length === 2), 'third member rejoins');
                append('PASS: remaining pair transferred while one member was gone; that member rejoined successfully');
                for (const peer of peers.slice(0, 3)) peer.leaveRoom();
                setMounted(false);
                append('THREE-PEER GROUP TESTS PASSED');
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
            const files = Array.from({ length: 120 }, (_, i) => source(i === 0 ? 0 : 8192 + i * 101, `batch-${i}.bin`));
            await peers[0].addFilesToQueue(files);
            await until(() => peers[0].sendQueue.filter(f => f.status === 'sent').length === 121, '120-file queue');
            if (peers[1].receivedFiles.length !== 121) throw new Error('Duplicate/missing received file');
            for (const meta of peers[1].receivedFiles.slice(1)) await verify(meta);
            append('PASS: 120-file queue, zero-byte file, exact file count and contents');
            await peers[0].addFilesToQueue([source(8 * 1048576, 'pause.bin')]);
            await until(() => (peers[0].sendQueue.find(f => f.file.name === 'pause.bin')?.bytesTransferred ?? 0) > 0, 'pause transfer starts');
            const id = peers[0].sendQueue.at(-1)!.id;
            peers[0].pauseSending(id);
            const sent = peers[0].transferMetrics!.sentBytes;
            await delay(600);
            if (peers[0].transferMetrics!.sentBytes !== sent) throw new Error('Sender continued while paused');
            peers[0].resumeSending(id);
            await until(() => peers[0].sendQueue.at(-1)?.status === 'sent', 'resume completes');
            await verify(peers[1].receivedFiles.at(-1)!); append('PASS: pause/resume and exact contents');
            await peers[0].addFilesToQueue([source(16 * 1048576, 'cancel.bin'), source(17, 'after-cancel.bin')]);
            await until(() => (peers[0].sendQueue.find(f => f.file.name === 'cancel.bin')?.progress ?? 0) > 0, 'cancel starts');
            await peers[0].removeFromQueue(peers[0].sendQueue.find(f => f.file.name === 'cancel.bin')!.id);
            await until(() => peers[0].sendQueue.at(-1)?.status === 'sent', 'queue continues after cancel');
            if (peers[1].receivedFiles.some(f => f.name === 'cancel.bin')) throw new Error('Cancelled file marked complete');
            await verify(peers[1].receivedFiles.at(-1)!); append('PASS: cancellation and next-file startup');
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
