import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useP2P } from '../src/hooks/useP2P';
import { FilePreviewModal } from '../src/components/FilePreviewModal';
import { deleteFile, getFilesInRoom, releasePreviewUrl, type FileMetadata } from '../src/ProgressDB';
import '../src/index.css';

// One hook per tab is intentional: each page owns its own production RangeBroker.
const params = new URLSearchParams(location.search);
const role = params.get('role') === 'receiver' ? 'receiver' : 'sender';
const room = params.get('room') || `video-qa-${Date.now().toString(36)}`;
if (!/^[A-Za-z0-9_-]{1,64}$/.test(room)) throw new Error('Use a unique alphanumeric/hyphen room parameter, at most 64 characters.');
const MIB = 1024 * 1024;
const PADDING_BOX_BYTES = 33 * MIB;
const fileName = `peerlink-video-stream-${room}.mp4`;
type Peer = ReturnType<typeof useP2P>;
type RangeObservation = { fileId: string; start: number; end: number; length: number; at: number };
type Preview = { file: FileMetadata; url: string | null; error: string | null };
type PlaybackReport = {
  duration: number; width: number; height: number; decodedFrames: number; frameCounter: string;
  initialTime: number; advancedTime: number; pausedTime: number; pausedAfterWait: number;
  seeks: Array<{ fraction: number; target: number; actual: number }>; resumedTime: number; mediaError: null;
};
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const detail = (error: unknown) => error instanceof Error ? `${error.name}: ${error.message}` : String(error);
async function until<T>(read: () => T | null | false | undefined, message: string, timeout = 20_000): Promise<T> {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) { const result = read(); if (result) return result; await sleep(40); }
  throw new Error(message);
}
async function bounded<T>(promise: Promise<T>, label: string, timeout = 20_000): Promise<T> {
  let timer = 0;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = window.setTimeout(() => reject(new Error(`${label} timed out after ${timeout / 1000}s`)), timeout); })]); }
  finally { clearTimeout(timer); }
}
function mediaOkay(video: HTMLVideoElement) {
  if (video.error) throw new Error(`Video decoder error ${video.error.code}: ${video.error.message || 'No browser detail'}`);
}
function frameCount(video: HTMLVideoElement): { count: number; source: string } {
  const decoded = (video as HTMLVideoElement & { webkitDecodedFrameCount?: number }).webkitDecodedFrameCount;
  return typeof decoded === 'number' ? { count: decoded, source: 'webkitDecodedFrameCount' }
    : { count: video.getVideoPlaybackQuality?.().totalVideoFrames || 0, source: 'getVideoPlaybackQuality.totalVideoFrames' };
}
async function checkPlayback(video: HTMLVideoElement): Promise<PlaybackReport> {
  video.muted = true;
  video.playsInline = true;
  await until(() => { mediaOkay(video); return Number.isFinite(video.duration) && video.duration > 0 && video.videoWidth > 0; }, 'Video metadata did not load. Check peer connectivity and service-worker control.');
  const duration = video.duration;
  const initialTime = video.currentTime;
  await bounded(video.play(), 'Muted video play', 10_000);
  await until(() => { mediaOkay(video); return video.currentTime > initialTime + Math.min(0.15, duration / 6) && frameCount(video).count > 0; }, 'Video did not advance and decode frames after play.', 10_000);
  const advancedTime = video.currentTime;
  video.pause();
  const pausedTime = video.currentTime;
  await sleep(220);
  const pausedAfterWait = video.currentTime;
  if (Math.abs(pausedAfterWait - pausedTime) > 0.08) throw new Error('Video time continued advancing while paused.');
  const seeks: PlaybackReport['seeks'] = [];
  for (const fraction of [0.75, 0.20]) {
    const target = duration * fraction;
    video.currentTime = target;
    await until(() => { mediaOkay(video); return !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.12; }, `Video could not seek to ${Math.round(fraction * 100)}%.`, 10_000);
    seeks.push({ fraction, target, actual: video.currentTime });
  }
  const resumedFrom = video.currentTime;
  await bounded(video.play(), 'Video resume', 10_000);
  await until(() => { mediaOkay(video); return video.currentTime > resumedFrom + Math.min(0.12, duration / 8); }, 'Video did not advance after seeking backward and resuming.', 10_000);
  const resumedTime = video.currentTime;
  video.pause();
  mediaOkay(video);
  const frames = frameCount(video);
  if (frames.count < 1) throw new Error('The browser reported no decoded video frames.');
  return { duration, width: video.videoWidth, height: video.videoHeight, decodedFrames: frames.count, frameCounter: frames.source,
    initialTime, advancedTime, pausedTime, pausedAfterWait, seeks, resumedTime, mediaError: null };
}

async function makeSource(progress: (message: string) => void): Promise<{ file: File; moovOffset: number }> {
  const response = await fetch('/tests/peerlink-test-clip.mp4');
  if (!response.ok) throw new Error('The bundled H.264 test clip is unavailable.');
  const original = new Uint8Array(await response.arrayBuffer());
  if (original.byteLength > MIB) throw new Error('The bundled clip unexpectedly exceeds the bounded source limit.');
  let offset = 0;
  let moov: { start: number; size: number } | null = null;
  while (offset + 8 <= original.length) {
    const size = new DataView(original.buffer, original.byteOffset + offset, 4).getUint32(0);
    const type = new TextDecoder().decode(original.subarray(offset + 4, offset + 8));
    if (size < 8 || offset + size > original.length) throw new Error('The bundled clip has invalid top-level MP4 boxes.');
    if (type === 'moov') moov = { start: offset, size };
    offset += size;
  }
  if (!moov || offset !== original.length) throw new Error('The bundled clip has no usable moov box.');
  const movedMoov = original.slice(moov.start, moov.start + moov.size);
  // Equal-size free replacement preserves the original mdat and stco sample offsets.
  original.set(new TextEncoder().encode('free'), moov.start + 4);
  const estimate = await navigator.storage.estimate();
  const sourceSize = original.length + PADDING_BOX_BYTES + movedMoov.length;
  if (typeof estimate.quota === 'number' && typeof estimate.usage === 'number' && estimate.quota - estimate.usage < sourceSize * 2 + 64 * MIB) {
    throw new Error('Not enough site storage for this bounded source and receive copy. Free test storage and retry.');
  }
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(original);
    const header = new Uint8Array(8);
    new DataView(header.buffer).setUint32(0, PADDING_BOX_BYTES);
    header.set(new TextEncoder().encode('free'), 4);
    await writable.write(header);
    const zeros = new Uint8Array(MIB);
    for (let written = 8; written < PADDING_BOX_BYTES;) {
      const length = Math.min(MIB, PADDING_BOX_BYTES - written);
      await writable.write(zeros.subarray(0, length));
      written += length;
      progress(`Creating disk-backed MP4: ${Math.round(written / MIB)} / 33 MiB padding`);
    }
    await writable.write(movedMoov);
    await writable.close();
  } catch (error) { await writable.abort().catch(() => undefined); throw error; }
  const source = await handle.getFile();
  if (source.size !== sourceSize) throw new Error('The generated MP4 has an unexpected byte count.');
  const file = source.type === 'video/mp4' ? source : new File([source], fileName, { type: 'video/mp4', lastModified: source.lastModified });
  return { file, moovOffset: original.length + PADDING_BOX_BYTES };
}

function Fixture() {
  const peer = useP2P();
  const latest = useRef<Peer>(peer);
  latest.current = peer;
  const [status, setStatus] = useState('ready');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Record<string, unknown>>({ role, room });
  const [preview, setPreview] = useState<Preview | null>(null);
  const previewRef = useRef<Preview | null>(null);
  previewRef.current = preview;
  const previewGeneration = useRef(0);
  const source = useRef<File | null>(null);
  const pauseRequested = useRef(false);
  const ranges = useRef<RangeObservation[]>([]);
  const [rangeVersion, setRangeVersion] = useState(0);
  const errors = useRef<string[]>([]);
  const [errorVersion, setErrorVersion] = useState(0);
  useEffect(() => {
    const observe = (event: MessageEvent) => {
      const data = event.data;
      // Observe only; the hook's production broker alone owns/replies to the transferred port.
      if (data?.type !== 'peerlink_preview_range' || typeof data.start !== 'number' || typeof data.end !== 'number') return;
      ranges.current.push({ fileId: data.fileId, start: data.start, end: data.end, length: data.end - data.start + 1, at: performance.now() });
      if (ranges.current.length > 2048) ranges.current.splice(0, ranges.current.length - 2048);
      setRangeVersion(version => version + 1);
    };
    const onError = (event: ErrorEvent) => { errors.current.push(event.message); setErrorVersion(version => version + 1); };
    const onRejection = (event: PromiseRejectionEvent) => { errors.current.push(detail(event.reason)); setErrorVersion(version => version + 1); };
    navigator.serviceWorker?.addEventListener('message', observe);
    window.addEventListener('error', onError); window.addEventListener('unhandledrejection', onRejection);
    return () => { navigator.serviceWorker?.removeEventListener('message', observe); window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection); };
  }, []);
  useLayoutEffect(() => {
    if (!pauseRequested.current) return;
    const item = peer.sendQueue.find(item => item.file.name === fileName);
    if (item) { pauseRequested.current = false; peer.pauseSending(item.id); }
  }, [peer.sendQueue, peer.pauseSending]);

  const report = (key: string, value: unknown) => setResults(previous => ({ ...previous, [key]: value }));
  const close = () => {
    previewGeneration.current++;
    const video = document.querySelector('video');
    if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
    const current = previewRef.current;
    if (current) { latest.current.closePreview(current.file.fileId); if (current.url) void releasePreviewUrl(current.url); }
    previewRef.current = null;
    setPreview(null);
  };
  const run = async (label: string, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setStatus(`${label}…`);
    try { await work(); setStatus(`PASS ${label}`); }
    catch (error) { const message = detail(error); report(`${label} failure`, message); setStatus(`FAIL ${label}: ${message}`); }
    finally { setBusy(false); }
  };
  const open = async (file: FileMetadata, urlProvider: () => Promise<string>) => {
    close();
    const generation = ++previewGeneration.current;
    setPreview({ file, url: null, error: null });
    const pending = urlProvider();
    void pending.then(url => { if (generation !== previewGeneration.current) void releasePreviewUrl(url); }, () => undefined);
    let url: string;
    try { url = await bounded(pending, 'Opening video preview'); }
    catch (error) { if (generation === previewGeneration.current) { previewGeneration.current++; setPreview({ file, url: null, error: detail(error) }); } throw error; }
    if (generation !== previewGeneration.current) { void releasePreviewUrl(url); throw new Error('The preview was closed before it opened.'); }
    setPreview({ file, url, error: null });
    const video = await until(() => document.querySelector('video'), 'The production preview modal did not mount its video element.', 5000);
    video.muted = true; video.playsInline = true;
    return { video, url };
  };
  const rangeSummary = (start = 0) => {
    const observed = ranges.current.slice(start);
    return { count: observed.length, maxLength: Math.max(0, ...observed.map(range => range.length)), maxEnd: Math.max(0, ...observed.map(range => range.end)),
      requestedIndexAbove32MiB: observed.some(range => range.end > 32 * MIB), ranges: observed.slice(-80) };
  };
  const remoteFile = () => {
    const file = latest.current.onlineFiles.find(file => file.name === fileName && file.remoteFileId);
    if (!file) throw new Error('The sender has not published this test video. Join both tabs, then Share and pause transfer in the sender.');
    return file;
  };
  const assertUnreceived = async () => {
    const copies = await getFilesInRoom(room);
    if (copies.some(file => file.name === fileName && file.status === 'complete')) throw new Error('This test video is already fully received. Use a fresh room to test a genuinely remote preview.');
  };
  const share = () => run('Share and pause transfer', async () => {
    if (!latest.current.connected) throw new Error('Join both tabs and wait for a connected peer first.');
    if (latest.current.sendQueue.some(item => item.file.name === fileName)) throw new Error('This source is already queued. Resume or clean up this test first.');
    const generated = await bounded(makeSource(setStatus), 'Creating 33MiB disk-backed MP4');
    source.current = generated.file;
    pauseRequested.current = true;
    if (!(await latest.current.addFilesToQueue([generated.file]))) { pauseRequested.current = false; throw new Error('The peer rejected queueing. Check the connection.'); }
    const item = await until(() => latest.current.sendQueue.find(item => item.file.name === fileName && item.status === 'paused'), 'The source did not pause before transfer. Use a fresh room and retry.', 5000);
    report('source', { size: generated.file.size, name: fileName, moovOffset: generated.moovOffset, sourceStorage: 'OPFS, <=1MiB writes', queueStatus: item.status, bytesTransferred: item.bytesTransferred || 0, totalChunks: item.totalChunks });
  });
  const sourcePlayback = () => run('Source playback', async () => {
    const file = source.current;
    if (!file) throw new Error('Create the source with Share and pause transfer first.');
    const metadata: FileMetadata = { fileId: 'qa-source', roomId: room, name: fileName, size: file.size, mimeType: 'video/mp4', totalChunks: 0, receivedChunks: 0, status: 'complete', createdAt: Date.now() };
    const { video } = await open(metadata, async () => URL.createObjectURL(file));
    report('sourcePlayback', await checkPlayback(video));
  });
  const peerPlayback = () => run('Peer playback', async () => {
    await assertUnreceived();
    const file = remoteFile();
    const before = ranges.current.length;
    const { video, url } = await open(file, () => latest.current.openPreview(file));
    const playback = await checkPlayback(video);
    const observed = rangeSummary(before);
    if (!url.includes('/__peerlink_preview/')) throw new Error('Peer playback did not use the remote service-worker route.');
    if (!observed.requestedIndexAbove32MiB || observed.maxLength > MIB) throw new Error('Expected bounded high-offset peer range requests were not observed.');
    await assertUnreceived();
    report('peerPlayback', { ...playback, url, genuinelyUnreceived: true, peerConnected: latest.current.connected, ranges: observed });
  });
  const cancelBuffering = () => run('Close while buffering', async () => {
    await assertUnreceived();
    const file = remoteFile();
    const before = ranges.current.length;
    const { video } = await open(file, () => latest.current.openPreview(file));
    video.preload = 'auto'; video.load();
    await until(() => ranges.current.length > before || video.networkState === HTMLMediaElement.NETWORK_LOADING, 'The video did not begin loading for the close test.', 5000);
    const snapshot = { readyState: video.readyState, networkState: video.networkState, paused: video.paused, currentTime: video.currentTime, rangeCount: ranges.current.length };
    close();
    await until(() => !document.querySelector('video'), 'Closing the preview left a mounted video element.', 2000);
    await sleep(1000);
    const afterOneSecond = ranges.current.length;
    await sleep(1000);
    const afterTwoSeconds = ranges.current.length;
    if (afterTwoSeconds !== afterOneSecond) throw new Error('Peer range requests continued after closing the video.');
    report('closeWhileBuffering', { closedDuring: snapshot, videoRemoved: true, rangeCountAfter1s: afterOneSecond, rangeCountAfter2s: afterTwoSeconds, uncaughtErrors: [...errors.current] });
  });
  const resume = () => run('Resume file transfer', async () => {
    close();
    const item = latest.current.sendQueue.find(item => item.file.name === fileName);
    if (!item) throw new Error('No synthetic source is queued.');
    latest.current.resumeSending(item.id);
    report('resume', { queueId: item.id, requested: true, instruction: 'Wait for sender sent / receiver completed before leaving the room and testing saved playback.' });
  });
  const savedPlayback = () => run('Saved playback', async () => {
    if (latest.current.connected || latest.current.onlineFiles.some(file => file.name === fileName)) throw new Error('Leave the test room first so this check cannot use an online peer.');
    const file = (await getFilesInRoom(room)).find(file => file.name === fileName && file.status === 'complete');
    if (!file) throw new Error('The test copy is not complete yet. Resume on the sender and wait for a completed receive before leaving.');
    if (file.storageFormat !== 'extent-v1' || file.receivedChunks !== file.totalChunks) throw new Error('The saved video is not a complete packed receive.');
    const { video, url } = await open(file, () => latest.current.openPreview(file));
    if (!url.includes('/__peerlink_local_preview/')) throw new Error('Saved playback did not use the local service-worker route.');
    const playback = await checkPlayback(video);
    report('savedPlayback', { ...playback, url, storageFormat: file.storageFormat, size: file.size, receivedChunks: file.receivedChunks, totalChunks: file.totalChunks, peerConnected: latest.current.connected });
  });
  const cleanup = () => run('Cleanup test files', async () => {
    close();
    for (const item of latest.current.sendQueue.filter(item => item.file.name === fileName)) await latest.current.removeFromQueue(item.id);
    latest.current.leaveRoom();
    const own = (await getFilesInRoom(room)).filter(file => file.name === fileName);
    for (const file of own) await deleteFile(file.fileId);
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(fileName).catch(error => { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; });
    source.current = null;
    report('cleanup', { ownReceivedCopiesDeleted: own.length, ownSourceRemoved: fileName });
  });
  const link = (which: string) => `/tests/video-streaming.html?role=${which}&room=${encodeURIComponent(room)}`;
  return <main style={{ maxWidth: 1050, margin: '20px auto', padding: 20 }}>
    <h1>Video streaming QA · {role}</h1>
    <p>Room <strong>{room}</strong>. Use two separate tabs: <a href={link('sender')} target="_blank" rel="noreferrer">Sender tab</a> · <a href={link('receiver')} target="_blank" rel="noreferrer">Receiver tab</a>.</p>
    <p>One second of real H.264 video, padded to 33 MiB with its MP4 index at the end. This tests playback and byte seeking; it does not certify 50 GB codec performance. No source writes happen automatically.</p>
    <ol><li>Join both tabs; wait for connected.</li><li>Sender: Share and pause transfer, then Test source playback; close the modal.</li><li>Receiver: Test peer playback, close the modal, then Close while buffering.</li><li>Sender: Resume file transfer. Wait for receiver complete, then leave both tabs.</li><li>Receiver: Test saved playback. Cleanup only when evidence is captured.</li></ol>
    <div style={{ position: 'relative', zIndex: 10001, background: '#1a201b', border: '1px solid #56634b', padding: 10, borderRadius: 10, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <button className="btn btn-secondary" disabled={busy || peer.inRoom} onClick={() => { peer.join(room, 'persistent'); setStatus('Joined test room; waiting for the other tab'); }}>Join test room</button>
      {role === 'sender' && <><button className="btn btn-secondary" disabled={busy || !peer.connected} onClick={() => void share()}>Share and pause transfer</button><button className="btn btn-secondary" disabled={busy} onClick={() => void sourcePlayback()}>Test source playback</button><button className="btn btn-secondary" disabled={busy} onClick={() => void resume()}>Resume file transfer</button></>}
      {role === 'receiver' && <><button className="btn btn-secondary" disabled={busy || !peer.connected} onClick={() => void peerPlayback()}>Test peer playback</button><button className="btn btn-secondary" disabled={busy || !peer.connected} onClick={() => void cancelBuffering()}>Close while buffering</button><button className="btn btn-secondary" disabled={busy} onClick={() => void savedPlayback()}>Test saved playback</button></>}
      <button className="btn btn-secondary" disabled={busy} onClick={() => { close(); peer.leaveRoom(); setStatus('Left test room; saved copy remains available'); }}>Leave test room</button>
      <button className="btn btn-secondary" disabled={busy} onClick={() => void cleanup()}>Cleanup test files</button>
    </div>
    <output id="status" style={{ display: 'block', margin: '16px 0', fontWeight: 700 }}>{status}</output>
    <pre id="connection" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify({ role, room, inRoom: peer.inRoom, connected: peer.connected, signalingStatus: peer.signalingStatus, connectionType: peer.connectionType,
      members: peer.members.map(member => ({ name: member.username, status: member.status })), queued: peer.sendQueue.filter(item => item.file.name === fileName).map(item => ({ name: item.file.name, status: item.status, bytes: item.bytesTransferred, progress: item.progress })),
      receiving: peer.currentReceivings.filter(file => file.name === fileName).map(file => ({ bytes: file.bytesReceived, size: file.size, progress: file.progress, status: file.status })),
      received: peer.receivedFiles.filter(file => file.name === fileName).map(file => ({ status: file.status, bytes: file.size, receivedChunks: file.receivedChunks, totalChunks: file.totalChunks, storageFormat: file.storageFormat })), toast: peer.toast }, null, 2)}</pre>
    <pre id="results" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginTop: 16 }}>{JSON.stringify({ ...results, observedRanges: rangeSummary(), observationVersion: rangeVersion, uncaughtErrors: errors.current, errorVersion }, null, 2)}</pre>
    {preview && <FilePreviewModal file={preview.file} previewUrl={preview.url} error={preview.error} onError={message => { setPreview(current => current ? { ...current, error: message } : null); report('mediaDisplayError', message); }} onClose={close} />}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
