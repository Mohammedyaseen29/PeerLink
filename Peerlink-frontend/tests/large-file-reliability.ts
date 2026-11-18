import { TransferEngine, CHUNK_SIZE } from "../src/transfer/TransferEngine";
import { getChunkIndices, getMetaData, readFileRange } from "../src/ProgressDB";

const LARGE_SIZE = 2 * 1024 * 1024 * 1024 + 123;
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
  const handle = await root.getFileHandle("peerlink-large-source-2gib.bin", { create: true });
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

async function runLargeTransfer() {
  const before = await navigator.storage.estimate();
  const required = LARGE_SIZE * 2 + 512 * MIB;
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
    await senderEngine.send(source, "large-file-2gib", bytes => {
      senderBytes = bytes;
      if (performance.now() - lastStatusAt > 1000) {
        lastStatusAt = performance.now();
        writeStatus(`Transfer running: sender ${senderBytes.toLocaleString()} bytes; receiver committed ${receiverBytes.toLocaleString()} bytes`);
      }
    });
    if (senderError || receiverError) throw new Error(`Transfer engine error: ${senderError || receiverError}`);
    const verification = await verifyReceiver(receivedId, LARGE_SIZE);
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
      senderMetrics: senderEngine.metrics,
      receiverMetrics: receiverEngine.metrics,
      storageAfter: await navigator.storage.estimate(),
    };
    writeStatus(`PASS 2 GiB + 123 bytes; ${verification.bytesChecked.toLocaleString()} bytes verified in <=1 MiB reads`);
    return result;
  } finally {
    senderEngine.releaseIdleWorker();
    receiverEngine.dispose();
    senderData.close(); senderControl.close(); receiverData.close(); receiverControl.close();
  }
}

async function runSmallCappedFrameTest() {
  const size = 48 * 1024 + 23;
  const bytes = new Uint8Array(size);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + 23) & 255;
  const file = new File([bytes], "message-cap-check.bin", { type: "application/octet-stream" });
  const sd = new LoopChannel(), sc = new LoopChannel(), rd = new LoopChannel(), rc = new LoopChannel();
  let sender!: TransferEngine, receiver!: TransferEngine;
  let receivedId = "", maxFrameBytes = 0;
  const link = connect(sd, sc, rd, rc);
  sd.onSend = packet => { if (packet instanceof ArrayBuffer) maxFrameBytes = Math.max(maxFrameBytes, packet.byteLength); rd.dispatchEvent(new MessageEvent("message", { data: packet })); };
  receiver = new TransferEngine(rd as unknown as RTCDataChannel, rc as unknown as RTCDataChannel, () => "small-cap-check", {
    receiving: () => {}, received: meta => { receivedId = meta.fileId; }, error: message => { throw new Error(`Capped receive error: ${message}`); },
  });
  sender = new TransferEngine(sd as unknown as RTCDataChannel, sc as unknown as RTCDataChannel, () => "small-cap-check", {
    receiving: () => {}, received: () => {}, error: message => { throw new Error(`Capped sender error: ${message}`); },
  }, () => "persistent", {}, { getMaxMessageSize: () => 4096 });
  link.engines(sender, receiver);
  try {
    await sender.send(file, "message-cap-check", () => {});
    const meta = await getMetaData(receivedId);
    if (!meta || meta.status !== "complete" || meta.size !== size) throw new Error("The capped frame transfer metadata is incomplete");
    if (!meta.chunkSize || meta.chunkSize + 38 + new TextEncoder().encode("message-cap-check").length > 4096) throw new Error(`Negotiated chunk exceeds 4096-byte channel limit: ${meta.chunkSize}`);
    if (maxFrameBytes > 4096) throw new Error(`Observed frame exceeds channel limit: ${maxFrameBytes}`);
    const ranges = [];
    for (let start = 0; start < size; start += MIB) {
      const block = new Uint8Array(await readFileRange(receivedId, meta, start, Math.min(size, start + MIB) - 1));
      for (let i = 0; i < block.length; i++) if (block[i] !== ((start + i) * 17 + 23 & 255)) throw new Error(`Capped frame byte mismatch at ${start + i}`);
      ranges.push(block.length);
    }
    return { sizeBytes: size, channelLimitBytes: 4096, observedMaxFrameBytes: maxFrameBytes, chunkSizeBytes: meta.chunkSize, byteRangesVerified: ranges.length };
  } finally {
    sender.releaseIdleWorker(); receiver.dispose();
    sd.close(); sc.close(); rd.close(); rc.close();
    if (receivedId) await (await import("../src/ProgressDB")).deleteFile(receivedId).catch(() => {});
  }
}

Object.assign(window, { runLargeTransfer, runSmallCappedFrameTest });
