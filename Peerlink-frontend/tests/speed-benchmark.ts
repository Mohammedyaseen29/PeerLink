import { TransferEngine } from '../src/transfer/TransferEngine';
import { getMetaData, getChunkIndices, readFileRange, deleteFile } from '../src/ProgressDB';

const output = document.querySelector<HTMLPreElement>('#output')!;
const btn = document.querySelector<HTMLButtonElement>('#run')!;
const rawBtn = document.querySelector<HTMLButtonElement>('#raw')!;
const lifecycleBtn = document.querySelector<HTMLButtonElement>('#lifecycle')!;
const params = new URLSearchParams(location.search);
const sizeMiB = Number(params.get('mib') ?? '32');
const sendBufferLimitMiB = Number(params.get('bufferMiB') ?? '2');
const SIZE = Math.max(1, Number.isFinite(sizeMiB) ? sizeMiB : 32) * 1024 * 1024 + 123;
const SEND_BUFFER_LIMIT = Math.max(1, Number.isFinite(sendBufferLimitMiB) ? sendBufferLimitMiB : 2) * 1024 * 1024;
let benchmarkBusy = false;
function launch(active: HTMLButtonElement, run: () => Promise<void>) {
  if (benchmarkBusy) return;
  benchmarkBusy = true;
  for (const control of [btn, rawBtn, lifecycleBtn]) control.disabled = true;
  active.disabled = true;
  void run().catch(e => log({ error: String(e), stack: e?.stack })).finally(() => {
    benchmarkBusy = false;
    for (const control of [btn, rawBtn, lifecycleBtn]) control.disabled = false;
  });
}
function log(s: unknown) { output.textContent += `${JSON.stringify(s)}\n`; }
type PairedChannels = { data: [RTCDataChannel, RTCDataChannel]; control: [RTCDataChannel, RTCDataChannel]; maxMessageSize: number | null; close: () => void };
function channelPairs() {
  return new Promise<PairedChannels>((resolve, reject) => {
    const left = new RTCPeerConnection(), right = new RTCPeerConnection();
    const pairs: PairedChannels = { data: [] as unknown as [RTCDataChannel, RTCDataChannel], control: [] as unknown as [RTCDataChannel, RTCDataChannel], maxMessageSize: null, close: () => { left.close(); right.close(); } };
    let timer: ReturnType<typeof setTimeout>;
    const fail = (error: unknown) => { clearTimeout(timer); pairs.close(); reject(error); };
    left.onicecandidate = e => { if (e.candidate) void right.addIceCandidate(e.candidate).catch(fail); };
    right.onicecandidate = e => { if (e.candidate) void left.addIceCandidate(e.candidate).catch(fail); };
    const channels = new Map<string, RTCDataChannel>();
    right.ondatachannel = e => { const label=e.channel.label; if (label === 'data') pairs.data = [channels.get(label)!, e.channel]; else if (label === 'control') pairs.control = [channels.get(label)!, e.channel];
      const poll = () => { if ([pairs.data,pairs.control].every(pair => pair.length === 2 && pair.every(ch => ch.readyState === 'open'))) { clearTimeout(timer); pairs.maxMessageSize = left.sctp?.maxMessageSize ?? null; resolve(pairs); } else setTimeout(poll, 10); }; poll(); };
    channels.set('data', left.createDataChannel('data', { ordered: true }));
    channels.set('control', left.createDataChannel('control', { ordered: true }));
    void (async () => { await left.setLocalDescription(await left.createOffer()); await right.setRemoteDescription(left.localDescription!);
      await right.setLocalDescription(await right.createAnswer()); await left.setRemoteDescription(right.localDescription!); })().catch(fail);
    timer = setTimeout(() => fail(new Error('Loopback negotiation timeout')), 15000);
    void Promise.all([...channels.values()].map(ch => new Promise<void>((res, rej) => { ch.addEventListener('open', () => res(), { once: true }); ch.addEventListener('error', () => rej(new Error('channel error'))); }))).catch(fail);
  });
}
function patternBlob(size: number) {
  const block = new Uint8Array(1024 * 1024);
  for (let i = 0; i < block.length; i++) block[i] = (i * 31 + (i >>> 8) * 17 + 91) & 255;
  const parts: BlobPart[] = [];
  for (let left = size; left > 0; left -= block.length) parts.push(left >= block.length ? block : block.slice(0, left));
  return new File(parts, `benchmark-${Math.floor(size / 1048576)}MiB-plus-123.bin`, { type: 'application/octet-stream' });
}
async function verify(id: string, expectedSize = SIZE) {
  const meta = await getMetaData(id);
  if (!meta || meta.status !== 'complete' || meta.size !== expectedSize) throw new Error('Stored metadata incomplete or size mismatch');
  const indices = await getChunkIndices(id);
  if (indices.length !== meta.totalChunks || indices.some((n, i) => n !== i)) throw new Error('Stored chunk index integrity failed');
  // TransferEngine checks SHA-256 for every chunk before commit; independently compare every persisted byte in bounded 1 MiB ranges.
  for (let start = 0; start < expectedSize; start += 1024 * 1024) {
    const end = Math.min(expectedSize - 1, start + 1024 * 1024 - 1);
    const bytes = new Uint8Array(await readFileRange(id, meta, start, end));
    for (let j = 0; j < bytes.length; j++) { const n = start + j; const expected = ((n % 1048576) * 31 + ((n % 1048576) >>> 8) * 17 + 91) & 255; if (bytes[j] !== expected) throw new Error(`Stored content mismatch at byte ${n}`); }
  }
  return { chunks: indices.length, storedSize: meta.size, chunkSize: meta.chunkSize, allTransferChunksSha256Verified: true, allStoredBytesCompared: true };
}
async function runEngine() {
  output.textContent = '';
  const pairs = await channelPairs();
  const [dataA, dataB] = pairs.data;
  const [controlA, controlB] = pairs.control;
  const id = `bench_${crypto.randomUUID().replaceAll('-', '')}`;
  let storedId = '';
  const receiver = new TransferEngine(dataB, controlB, () => 'speed-benchmark', { receiving: m => { storedId = m.fileId; }, received: m => { storedId = m.fileId; }, error: m => log({ receiverError: m }) });
  const sender = new TransferEngine(dataA, controlA, () => 'speed-benchmark', { receiving: () => {}, received: () => {}, error: m => log({ senderError: m }) });
  controlA.addEventListener('message', e => { try { sender.handle(JSON.parse(String(e.data))); } catch {} });
  controlB.addEventListener('message', e => { try { receiver.handle(JSON.parse(String(e.data))); } catch {} });
  let lastAt = performance.now(), lastBytes = 0;
  const start = performance.now();
  const timer = setInterval(() => {
    const now = performance.now(), bytes = receiver.metrics.receivedBytes;
    if (bytes !== lastBytes) { log({ intervalSeconds: +((now-lastAt)/1000).toFixed(2), intervalMiBps: +(((bytes-lastBytes)/(now-lastAt)*1000/1048576).toFixed(2)), receivedMiB: +(bytes/1048576).toFixed(1) }); lastAt=now; lastBytes=bytes; }
  }, 1000);
  try {
    await sender.send(patternBlob(SIZE), id, () => {});
    const elapsed = (performance.now() - start) / 1000;
    clearInterval(timer);
    const integrity = await verify(storedId);
    const workerCleanup = sender.metrics.activeWorkers === 0 && sender.metrics.pendingReads === 0;
    const boundedReceive = receiver.metrics.peakReceiveBytes <= 8 * 1024 * 1024;
    const boundedSend = sender.metrics.peakBufferedBytes <= SEND_BUFFER_LIMIT + 256 * 1024;
    log({ result: 'complete', sizeBytes: SIZE, sizeMiBPlus123: sizeMiB, sendBufferLimitMiB, elapsedSeconds: +elapsed.toFixed(2), meanMiBps: +(SIZE/1048576/elapsed).toFixed(2), maxMessageSize: pairs.maxMessageSize, integrity,
      workerCleanup, boundedReceive, boundedSend, passed: workerCleanup && boundedReceive && boundedSend && integrity.allStoredBytesCompared,
      sender: sender.metrics, receiver: receiver.metrics, userAgent: navigator.userAgent, memory: (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory ?? null });
  } finally { clearInterval(timer); sender.dispose(); receiver.dispose(); dataA.close(); dataB.close(); controlA.close(); controlB.close(); pairs.close(); }
}

btn.addEventListener('click', () => launch(btn, runEngine));
async function runRaw() {
  output.textContent = '';
  for (const size of [16, 64, 256].map(k => k * 1024)) {
    const pairs = await channelPairs();
    const [send, receive] = pairs.data;
    try {
      if (pairs.maxMessageSize !== null && pairs.maxMessageSize > 0 && size > pairs.maxMessageSize) { log({ kind: 'raw ordered reliable SCTP', chunkBytes: size, skipped: true, maxMessageSize: pairs.maxMessageSize }); continue; }
      receive.binaryType = 'arraybuffer';
      let received = 0;
      receive.addEventListener('message', e => { if (e.data instanceof ArrayBuffer) received += e.data.byteLength; });
      const bytes = 8 * 1024 * 1024;
      const payload = new ArrayBuffer(size);
      const last = performance.now(), deadline = last + 30000;
      send.bufferedAmountLowThreshold = 512 * 1024;
      const low = () => new Promise<void>((resolve, reject) => {
        if (send.bufferedAmount < 512 * 1024) resolve();
        else { const timeout = setTimeout(() => reject(new Error('raw send backpressure timeout')), Math.max(1, deadline-performance.now()));
          send.addEventListener('bufferedamountlow', () => { clearTimeout(timeout); resolve(); }, { once: true }); }
      });
      for (let sent = 0; sent < bytes; sent += size) {
        if (performance.now() > deadline) throw new Error('raw send timed out');
        if (send.bufferedAmount + size > 2 * 1024 * 1024) await low();
        send.send(payload);
      }
      while (received < bytes && performance.now() < deadline) await new Promise(r => setTimeout(r, 10));
      const elapsed = (performance.now() - last) / 1000;
      log({ kind: 'raw ordered reliable SCTP', chunkBytes: size, sentBytes: bytes, receivedBytes: received, elapsedSeconds: +elapsed.toFixed(2), meanMiBps: +(received/1048576/elapsed).toFixed(2), verified: received === bytes });
    } finally { send.close(); receive.close(); pairs.control[0].close(); pairs.control[1].close(); pairs.close(); }
  }
}
rawBtn.addEventListener('click', () => launch(rawBtn, runRaw));
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 15000) {
  const until = performance.now() + timeoutMs;
  while (!(await predicate())) { if (performance.now() > until) throw new Error('lifecycle check timed out'); await new Promise(r => setTimeout(r, 20)); }
}
async function lifecycleCase(kind: 'pause' | 'cancel') {
  const pairs = await channelPairs();
  const [dataA,dataB] = pairs.data, [controlA,controlB] = pairs.control;
  let storedId = '';
  const receiver = new TransferEngine(dataB, controlB, () => 'speed-benchmark', { receiving: m => { storedId=m.fileId; }, received: m => { storedId=m.fileId; }, error: () => {} });
  const sender = new TransferEngine(dataA, controlA, () => 'speed-benchmark', { receiving: () => {}, received: () => {}, error: () => {} });
  controlA.addEventListener('message', e => { try { sender.handle(JSON.parse(String(e.data))); } catch {} });
  controlB.addEventListener('message', e => { try { receiver.handle(JSON.parse(String(e.data))); } catch {} });
  const size = 8 * 1024 * 1024 + 123;
  const id = `bench_${kind}_${crypto.randomUUID().replaceAll('-', '')}`;
  try {
    const task = sender.send(patternBlob(size), id, () => {});
    void task.catch(() => undefined);
    await waitFor(() => sender.metrics.sentBytes >= 1024 * 1024);
    if (kind === 'pause') {
      sender.pause(id);
      await new Promise(r => setTimeout(r, 1000));
      const pausedBytes = sender.metrics.sentBytes;
      await new Promise(r => setTimeout(r, 500));
      const remainedPaused = sender.metrics.sentBytes === pausedBytes;
      sender.resume(id);
      await task;
      const integrity = await verify(storedId, size);
      const passed = remainedPaused && integrity.storedSize === size;
      log({ kind, passed, remainedPaused, resumedToComplete: integrity.storedSize === size, integrity, senderBytes: sender.metrics.sentBytes, storedBytes: receiver.metrics.receivedBytes });
      if (storedId) await deleteFile(storedId);
      if (!passed) throw new Error('pause/resume assertion failed');
    } else {
      sender.cancel(id);
      let rejected = false;
      try { await task; } catch { rejected = true; }
      await waitFor(async () => !!storedId && await getMetaData(storedId) === null);
      const meta = storedId ? await getMetaData(storedId) : null;
      const passed = rejected && meta === null;
      log({ kind, passed, sendRejected: rejected, receiverRecordRemoved: meta === null, sentBytesAtCancel: sender.metrics.sentBytes });
      if (storedId && meta) await deleteFile(storedId);
      if (!passed) throw new Error('cancel assertion failed');
    }
  } finally { sender.dispose(); receiver.dispose(); dataA.close(); dataB.close(); controlA.close(); controlB.close(); pairs.close(); }
}
async function bidirectionalCase() {
  const pairs = await channelPairs();
  const [dataA,dataB] = pairs.data, [controlA,controlB] = pairs.control;
  let receivedByA = '', receivedByB = '';
  const engineA = new TransferEngine(dataA, controlA, () => 'speed-benchmark', { receiving: m => { receivedByA=m.fileId; }, received: m => { receivedByA=m.fileId; }, error: e => log({ bidirectionalErrorA: e }) });
  const engineB = new TransferEngine(dataB, controlB, () => 'speed-benchmark', { receiving: m => { receivedByB=m.fileId; }, received: m => { receivedByB=m.fileId; }, error: e => log({ bidirectionalErrorB: e }) });
  controlA.addEventListener('message', e => { try { engineA.handle(JSON.parse(String(e.data))); } catch {} });
  controlB.addEventListener('message', e => { try { engineB.handle(JSON.parse(String(e.data))); } catch {} });
  const size = 2 * 1024 * 1024 + 123;
  const idA = `bench_bidir_a_${crypto.randomUUID().replaceAll('-', '')}`, idB = `bench_bidir_b_${crypto.randomUUID().replaceAll('-', '')}`;
  try {
    const [sendA, sendB] = await Promise.all([engineA.send(patternBlob(size), idA, () => {}), engineB.send(patternBlob(size), idB, () => {})]);
    void sendA; void sendB;
    const [checkA, checkB] = await Promise.all([verify(receivedByA, size), verify(receivedByB, size)]);
    log({ kind: 'bidirectional', passed: true, eachDirectionBytes: size, receivedByA: checkA, receivedByB: checkB,
      senderA: { sentBytes: engineA.metrics.sentBytes, receivedBytes: engineA.metrics.receivedBytes, peakBufferedBytes: engineA.metrics.peakBufferedBytes, peakReceiveBytes: engineA.metrics.peakReceiveBytes },
      senderB: { sentBytes: engineB.metrics.sentBytes, receivedBytes: engineB.metrics.receivedBytes, peakBufferedBytes: engineB.metrics.peakBufferedBytes, peakReceiveBytes: engineB.metrics.peakReceiveBytes } });
    await Promise.all([deleteFile(receivedByA), deleteFile(receivedByB)]);
  } finally { engineA.dispose(); engineB.dispose(); dataA.close(); dataB.close(); controlA.close(); controlB.close(); pairs.close(); }
}
lifecycleBtn.addEventListener('click', () => launch(lifecycleBtn, async () => { await lifecycleCase('pause'); await lifecycleCase('cancel'); await bidirectionalCase(); }));
