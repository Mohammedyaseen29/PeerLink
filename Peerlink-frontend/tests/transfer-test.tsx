import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useP2P } from '../src/hooks/useP2P';
import { openDB, deleteFile, getChunkIndices, getFilesInRoom, releasePreviewUrl, type FileMetadata } from '../src/ProgressDB';

type Peer = ReturnType<typeof useP2P>;
const peers: Peer[] = [];
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
function source(size: number, name: string) {
    const parts: BlobPart[] = [];
    for (let remaining = size; remaining > 0; remaining -= pattern.length) parts.push(pattern.subarray(0, Math.min(remaining, pattern.length)));
    return new File(parts, name, { type: 'application/octet-stream' });
}
async function verify(meta: FileMetadata) {
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
                if (byte !== pattern[offset++ % pattern.length]) { reject(new Error('Stored byte mismatch')); return; }
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
    const append = (line: string) => setLog(previous => previous + '\n' + line);
    async function run() {
        setRunning(true); setLog('Connecting two real application hooks through local WebSockets...');
        const room = `test-${crypto.randomUUID()}`;
        try {
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
        {mounted && <><PeerPanel index={0} /><PeerPanel index={1} /></>}<pre style={{ whiteSpace: 'pre-wrap' }}>{log}</pre></main>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Tests /></StrictMode>);
