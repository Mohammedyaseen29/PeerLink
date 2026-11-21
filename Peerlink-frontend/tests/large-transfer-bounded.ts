import { TransferEngine, CHUNK_SIZE } from "../src/transfer/TransferEngine";
import { getChunkIndices, getMetaData, readFileRange, deleteFile, openDB, CHUNK_STORE, saveChunks, type FileMetadata, getUpdatePreviewUrl, streamFileToDownload } from "../src/ProgressDB";

const LARGE_SIZE = 33 * 1024 * 1024 + 123;
const MIB = 1024 * 1024;
const PATTERN_PERIOD = MIB;
const status = document.querySelector("#status")!;
const writeStatus = (value: string) => { status.textContent = value; };
const expectedByte = (absolute: number) => ((absolute % PATTERN_PERIOD) * 31 + ((absolute % PATTERN_PERIOD) >>> 8) * 17 + 91) & 255;

class LoopChannel extends EventTarget {
  readyState: RTCDataChannelState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = "arraybuffer";
  onSend: ((data: string | ArrayBuffer) => void) | null = null;
  send(data: string | ArrayBuffer) { this.onSend?.(data); }
  close() { this.readyState = "closed"; this.dispatchEvent(new Event("close")); }
}

async function makeOpfsSource(): Promise<File> {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle("peerlink-bounded-source.bin", { create: true });
  const stream = await handle.createWritable();
  for (let start = 0; start < LARGE_SIZE; start += MIB) {
    const length = Math.min(MIB, LARGE_SIZE - start);
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = expectedByte(start + i);
    await stream.write(bytes);
    if (start % (128 * MIB) === 0) writeStatus(`Creating OPFS source: ${Math.min(start + length, LARGE_SIZE).toLocaleString()} / ${LARGE_SIZE.toLocaleString()} bytes`);
  }
  await stream.close();
  const file = await handle.getFile();
  if (file.size !== LARGE_SIZE) throw new Error(`OPFS source size mismatch: ${file.size}`);
  return file;
}

function connect(senderData: LoopChannel, senderControl: LoopChannel, receiverData: LoopChannel, receiverControl: LoopChannel) {
  senderData.onSend = packet => receiverData.dispatchEvent(new MessageEvent("message", { data: packet }));
  receiverData.onSend = packet => senderData.dispatchEvent(new MessageEvent("message", { data: packet }));
  senderControl.onSend = message => receiverEngine.handle(JSON.parse(String(message)));
  receiverControl.onSend = message => senderEngine.handle(JSON.parse(String(message)));
  let senderEngine: TransferEngine;
  let receiverEngine: TransferEngine;
  return {
    engines: (sender: TransferEngine, receiver: TransferEngine) => { senderEngine = sender; receiverEngine = receiver; },
  };
}

async function verifyReceiver(fileId: string, expectedSize: number) {
  const meta = await getMetaData(fileId);
  if (!meta || meta.status !== "complete") throw new Error("Receiver metadata did not reach complete state");
  if (meta.size !== expectedSize) throw new Error(`Metadata size mismatch: ${meta.size}`);
  const indexes = await getChunkIndices(fileId);
  const expectedChunks = Math.ceil(expectedSize / (meta.chunkSize || CHUNK_SIZE));
  if (meta.totalChunks !== expectedChunks || meta.receivedChunks !== expectedChunks || indexes.length !== expectedChunks) {
    throw new Error(`Chunk metadata mismatch: ${JSON.stringify({ total: meta.totalChunks, received: meta.receivedChunks, indexed: indexes.length, expectedChunks })}`);
  }
  for (let i = 0; i < indexes.length; i++) if (indexes[i] !== i) throw new Error(`Chunk index gap at ${i}`);
  let bytesChecked = 0;
  let maxReadBytes = 0;
  for (let start = 0; start < expectedSize; start += MIB) {
    const end = Math.min(expectedSize, start + MIB) - 1;
    const block = new Uint8Array(await readFileRange(fileId, meta, start, end));
    if (block.byteLength > MIB) throw new Error(`Bounded read exceeded 1 MiB: ${block.byteLength}`);
    maxReadBytes = Math.max(maxReadBytes, block.byteLength);
    for (let i = 0; i < block.length; i++) if (block[i] !== expectedByte(start + i)) throw new Error(`Byte mismatch at ${start + i}`);
    bytesChecked += block.length;
    if (start % (128 * MIB) === 0) writeStatus(`Verifying receiver storage: ${bytesChecked.toLocaleString()} / ${expectedSize.toLocaleString()} bytes`);
  }
  const tail = new Uint8Array(await readFileRange(fileId, meta, expectedSize - 123, expectedSize - 1));
  if (tail.length !== 123 || tail.some((value, i) => value !== expectedByte(expectedSize - 123 + i))) throw new Error("Final 123-byte tail mismatch");
  return { size: meta.size, chunkSize: meta.chunkSize, totalChunks: meta.totalChunks, receivedChunks: meta.receivedChunks, indexedChunks: indexes.length, bytesChecked, maxReadBytes, tailBytes: tail.length };
}

async function runBoundedTransfer() {
  const before = await navigator.storage.estimate();
  const required = LARGE_SIZE * 2 + 64 * MIB;
  const available = typeof before.quota === "number" && typeof before.usage === "number" ? before.quota - before.usage : 0;
  if (!available || available < required) throw new Error(`Storage preflight insufficient: free=${available}, required=${required}`);
  writeStatus(`Storage preflight passed (${Math.round(available / MIB)} MiB free); creating source`);
  const source = await makeOpfsSource();
  const senderData = new LoopChannel();
  const senderControl = new LoopChannel();
  const receiverData = new LoopChannel();
  const receiverControl = new LoopChannel();
  let receivedId = "";
  let receiverError = "";
  let senderError = "";
  let lastStatusAt = 0;
  let senderBytes = 0;
  let receiverBytes = 0;
  let senderEngine!: TransferEngine;
  let receiverEngine!: TransferEngine;
  const link = connect(senderData, senderControl, receiverData, receiverControl);
  receiverEngine = new TransferEngine(receiverData as unknown as RTCDataChannel, receiverControl as unknown as RTCDataChannel, () => "large-file-check", {
    receiving: (_meta, bytes) => { receiverBytes = bytes; }, received: meta => { receivedId = meta.fileId; Object.assign(window, { largeFileId: receivedId }); }, error: message => { receiverError = message; },
  }, () => "persistent", { peerId: "test-peer", peerName: "Large file test" });
  senderEngine = new TransferEngine(senderData as unknown as RTCDataChannel, senderControl as unknown as RTCDataChannel, () => "large-file-check", {
    receiving: () => {}, received: () => {}, error: message => { senderError = message; },
  });
  link.engines(senderEngine, receiverEngine);
  const startedAt = performance.now();
  try {
    await senderEngine.send(source, "bounded-file", bytes => {
      senderBytes = bytes;
      if (performance.now() - lastStatusAt > 1000) {
        lastStatusAt = performance.now();
        writeStatus(`Transfer running: sender ${senderBytes.toLocaleString()} bytes; receiver committed ${receiverBytes.toLocaleString()} bytes`);
      }
    });
    if (senderError || receiverError) throw new Error(`Transfer engine error: ${senderError || receiverError}`);
    const verification = await verifyReceiver(receivedId, LARGE_SIZE);
    const meta = (await getMetaData(receivedId))!;
    if (meta.storageFormat !== 'extent-v1') throw new Error('New large receive was not packed');
    const db = await openDB();
    const rows = await new Promise<number>((resolve, reject) => {
      const req = db.transaction(CHUNK_STORE).objectStore(CHUNK_STORE).index('fileId').count(receivedId);
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    if (rows >= meta.totalChunks / 4) throw new Error('Receive rows were not coalesced');
    Object.assign(window, { boundedReceivedFile: meta });
    document.querySelector<HTMLButtonElement>('#download')!.disabled = false;
    const previewUrl = await getUpdatePreviewUrl(receivedId, meta, null);
    const head = await fetch(previewUrl, { method: 'HEAD' });
    if (head.status !== 200 || Number(head.headers.get('Content-Length')) !== meta.size) throw new Error('Local preview HEAD failed');
    const tailResponse = await fetch(previewUrl, { headers: { Range: 'bytes=' + (meta.size - 123) + '-' } });
    if (tailResponse.status !== 206) throw new Error('Local preview tail failed');
    const tailBytes = new Uint8Array(await tailResponse.arrayBuffer());
    if (tailBytes.length !== 123 || tailBytes.some((v, i) => v !== expectedByte(meta.size - 123 + i))) throw new Error('Local preview tail mismatch');
    if ((await fetch(previewUrl, { headers: { Range: 'bytes=' + meta.size + '-' } })).status !== 416) throw new Error('Local preview should reject EOF');
    const streamResponse = await fetch(previewUrl); await streamResponse.body!.cancel();
    const durationSeconds = (performance.now() - startedAt) / 1000;
    const result = {
      mode: "in-page ordered loop channels; real TransferEngine sender worker, v4 metadata, per-chunk SHA-256, receiver IndexedDB persistence and commit flow",
      fileSizeBytes: LARGE_SIZE,
      fileId: receivedId,
      senderChunkSizeBytes: verification.chunkSize,
      senderBytes,
      receiverCommittedBytes: receiverBytes,
      durationSeconds: Math.round(durationSeconds * 10) / 10,
      verification,
      packedRows: rows,
      localPreview: { head: head.status, tail: tailResponse.status, canceled: true },
      senderMetrics: senderEngine.metrics,
      receiverMetrics: receiverEngine.metrics,
      storageAfter: await navigator.storage.estimate(),
    };
    writeStatus(`PASS 33 MiB + 123 bytes; ${verification.bytesChecked.toLocaleString()} bytes verified in <=1 MiB reads`);
    return result;
  } finally {
    senderEngine.releaseIdleWorker();
    receiverEngine.dispose();
    senderData.close(); senderControl.close(); receiverData.close(); receiverControl.close();
    await (await navigator.storage.getDirectory()).removeEntry("peerlink-bounded-source.bin").catch(() => {});
  }
}


async function runSparseStorage() {
  const chunkSize = 16384;
  const results = [];
  for (const size of [50_000_000_000, 50 * 1024 ** 3 + 123]) {
    const fileId = 'sparse-' + crypto.randomUUID();
    const meta: FileMetadata = { fileId, roomId: 'bounded-test', name: 'sparse.bin', size, mimeType: 'application/octet-stream',
      chunkSize, storageFormat: 'extent-v1', totalChunks: Math.ceil(size / chunkSize), receivedChunks: Math.ceil(size / chunkSize), status: 'complete', createdAt: Date.now() };
    try {
      for (const position of [2 ** 32 - 79, size - 123]) {
        const first = Math.max(0, Math.floor(position / chunkSize) - 2);
        const last = Math.min(meta.totalChunks - 1, Math.floor((position + 122) / chunkSize) + 2);
        // Irregular, partial batches intentionally persist without filling 1 MiB.
        for (let i = first; i <= last; i += 3) {
          const chunks = [];
          for (let j = i; j <= Math.min(last, i + 2); j++) {
            const data = new Uint8Array(Math.min(chunkSize, size - j * chunkSize));
            for (let k = 0; k < data.length; k++) data[k] = expectedByte(j * chunkSize + k);
            chunks.push({ chunkIndex: j, data: data.buffer });
          }
          await saveChunks(fileId, chunks, meta);
        }
        const end = Math.min(size - 1, position + 122);
        const bytes = new Uint8Array(await readFileRange(fileId, meta, position, end));
        if (bytes.length !== end - position + 1 || bytes.some((v, i) => v !== expectedByte(position + i))) throw new Error('Sparse high-offset mismatch');
        results.push({ size, start: position, verifiedBytes: bytes.length });
      }
    } finally { await deleteFile(fileId); }
  }
  const id = 'legacy-' + crypto.randomUUID();
  const meta: FileMetadata = { fileId: id, roomId: 'bounded-test', name: 'legacy.bin', size: 103, mimeType: 'text/plain', chunkSize: 100, totalChunks: 2, receivedChunks: 2, status: 'complete', createdAt: Date.now() };
  try {
    await saveChunks(id, [{ chunkIndex: 0, data: new Uint8Array(100).fill(7).buffer }, { chunkIndex: 1, data: new Uint8Array(3).fill(9).buffer }], meta);
    const bytes = new Uint8Array(await readFileRange(id, meta, 99, 102));
    if (bytes.join(',') !== '7,9,9,9') throw new Error('Legacy reader failed');
  } finally { await deleteFile(id); }
  const corruptId = 'corrupt-' + crypto.randomUUID();
  const corruptMeta: FileMetadata = { ...meta, fileId: corruptId, size: 400, chunkSize: 100, storageFormat: 'extent-v1', totalChunks: 4, receivedChunks: 4 };
  let rejectedCorruptRanges = 0;
  const cases = [
    [{ chunkIndex: 2, chunkCount: 2, data: new ArrayBuffer(200) }],
    [{ chunkIndex: 0, chunkCount: 1, data: new ArrayBuffer(100) }, { chunkIndex: 2, chunkCount: 2, data: new ArrayBuffer(200) }],
    [{ chunkIndex: 0, chunkCount: 3, data: new ArrayBuffer(300) }, { chunkIndex: 2, chunkCount: 2, data: new ArrayBuffer(200) }],
    [{ chunkIndex: 0, chunkCount: 5, data: new ArrayBuffer(500) }],
    [{ chunkIndex: 0, chunkCount: 4, data: new ArrayBuffer(100) }],
    [{ chunkIndex: 0, chunkCount: 0, data: new ArrayBuffer(400) }],
  ];
  for (const rows of cases) {
    try {
      const db = await openDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(CHUNK_STORE, 'readwrite');
        for (const row of rows) tx.objectStore(CHUNK_STORE).put({ fileId: corruptId, ...row });
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
      });
      try { await readFileRange(corruptId, corruptMeta, 0, 399); }
      catch { rejectedCorruptRanges++; }
    } finally { await deleteFile(corruptId); }
  }
  if (rejectedCorruptRanges !== cases.length) throw new Error('Corrupt extent range was accepted');
  return { sparse: results, legacy: 'PASS', rejectedCorruptRanges };
}

async function runBoundedChecks() {
  const button = document.querySelector<HTMLButtonElement>('#run')!;
  button.disabled = true;
  try {
    const storage = await runSparseStorage();
    const transfer = await runBoundedTransfer();
    const result = { storage, transfer };
    document.querySelector('#results')!.textContent = JSON.stringify(result, null, 2);
    writeStatus('PASS bounded transfer, sparse 50 GB/50 GiB offsets, legacy storage, local preview and cancellation');
    return result;
  } catch (error) { writeStatus('FAIL ' + String(error)); throw error; }
  finally { button.disabled = false; }
}
Object.assign(window, { runBoundedChecks });
async function verifyAttachmentStream() {
  // Reuse the received copy across fixture reloads; never register a page-provided byte broker.
  const { getStoredFiles } = await import('../src/ProgressDB');
  const meta = (await getStoredFiles()).find(file => file.roomId === 'large-file-check' && file.storageFormat === 'extent-v1' && file.status === 'complete');
  if (!meta) throw new Error('Run bounded checks first to receive the test file.');
  await getUpdatePreviewUrl(meta.fileId, meta, null);
  const worker = navigator.serviceWorker.controller!;
  const token = crypto.randomUUID();
  const notifications: string[] = [];
  const onMessage = (event: MessageEvent) => { if (event.source === worker && event.data?.token === token) notifications.push(event.data.type); };
  navigator.serviceWorker.addEventListener('message', onMessage);
  try {
    await new Promise<void>((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = window.setTimeout(() => { channel.port1.close(); reject(new Error('Attachment registration timed out')); }, 5000);
      channel.port1.onmessage = ({ data }) => { clearTimeout(timer); channel.port1.close(); if (data.type === 'PEERLINK_DOWNLOAD_REGISTERED') resolve(); else reject(new Error(data.error)); };
      worker.postMessage({ type: 'PEERLINK_REGISTER_DOWNLOAD', token, fileId: meta.fileId, name: meta.name, size: meta.size }, [channel.port2]);
    });
    const url = new URL('/__peerlink_download/' + token, location.origin);
    const response = await fetch(url);
    if (response.status !== 200 || Number(response.headers.get('Content-Length')) !== meta.size || !response.headers.get('Content-Disposition')?.startsWith('attachment;')) throw new Error('Invalid attachment headers');
    const reader = response.body!.getReader();
    let offset = 0, maxReadBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > MIB) throw new Error('Attachment output exceeded 1MiB');
      maxReadBytes = Math.max(maxReadBytes, value.byteLength);
      for (let i = 0; i < value.length; i++) if (value[i] !== expectedByte(offset + i)) throw new Error('Attachment byte mismatch at ' + (offset + i));
      offset += value.length;
    }
    if (offset !== meta.size) throw new Error('Attachment byte count mismatch');
    // Owner notifications are queued independently of the response body.
    const deadline = performance.now() + 3000;
    while (!notifications.includes('PEERLINK_DOWNLOAD_FINISHED') && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    if (!notifications.includes('PEERLINK_DOWNLOAD_READY') || !notifications.includes('PEERLINK_DOWNLOAD_FINISHED')) throw new Error('Attachment owner notifications missing');
    const reused = await fetch(url);
    if (reused.status !== 410) throw new Error('Attachment token was reusable');
    const result = { verifiedBytes: offset, maxReadBytes, notifications, reusedStatus: reused.status };
    document.querySelector('#results')!.textContent = JSON.stringify(result, null, 2);
    writeStatus('PASS packed attachment stream: ' + offset.toLocaleString() + ' exact bytes');
    return result;
  } finally { navigator.serviceWorker.removeEventListener('message', onMessage); }
}
document.querySelector('#attachment')!.addEventListener('click', () => { void verifyAttachmentStream().catch(error => writeStatus('FAIL attachment stream ' + String(error))); });
document.querySelector('#run')!.addEventListener('click', () => { void runBoundedChecks().catch(console.error); });
document.querySelector('#download')!.addEventListener('click', () => {
  const meta = (window as unknown as { boundedReceivedFile: FileMetadata }).boundedReceivedFile;
  void streamFileToDownload(meta.fileId, undefined, { picker: false, name: meta.name }).then(() => writeStatus('PASS received packed attachment streamed'), error => writeStatus('FAIL attachment ' + String(error)));
});
document.querySelector('#cleanup')!.addEventListener('click', () => {
  const meta = (window as unknown as { boundedReceivedFile?: FileMetadata }).boundedReceivedFile;
  if (meta) void deleteFile(meta.fileId).then(() => { writeStatus('Synthetic received file deleted'); document.querySelector<HTMLButtonElement>('#download')!.disabled = true; });
});
