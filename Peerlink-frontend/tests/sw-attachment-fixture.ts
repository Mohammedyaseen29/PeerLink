import { deleteFile, saveChunks, saveMetaData, streamFileToDownload, type FileMetadata } from "../src/ProgressDB";
import { registerPeerLinkServiceWorker } from "../src/serviceWorker";

const MIB = 1024 * 1024;
const status = document.querySelector("#status")!;
const writeStatus = (text: string) => { status.textContent = text; };

async function runLargeAttachmentDownload() {
  const size = 33 * MIB + 123;
  const chunkSize = MIB;
  const totalChunks = Math.ceil(size / chunkSize);
  const fileId = "large-attachment-test";
  const name = "large-attachment-test.bin";
  const meta: FileMetadata = { fileId, roomId: "large-attachment-test", name, size, mimeType: "application/octet-stream", chunkSize, totalChunks, receivedChunks: totalChunks, status: "complete", createdAt: Date.now() };
  const bytesFor = (start: number, length: number) => {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = (Math.imul(start + i, 43) + ((start + i) >>> 8) + 9) & 255;
    return bytes;
  };
  await saveMetaData(meta);
  try {
    for (let first = 0; first < totalChunks; first += 4) {
      const batch = [];
      for (let index = first; index < Math.min(first + 4, totalChunks); index++) {
        const length = Math.min(chunkSize, size - index * chunkSize);
        const bytes = bytesFor(index * chunkSize, length);
        batch.push({ chunkIndex: index, data: bytes.buffer as ArrayBuffer });
      }
      if (first + batch.length >= totalChunks) await saveChunks(fileId, batch, { ...meta, receivedChunks: totalChunks, status: "complete" });
      else await saveChunks(fileId, batch);
      if (first % 16 === 0) writeStatus(`Preparing ${size.toLocaleString()}-byte service-worker attachment`);
    }
    await registerPeerLinkServiceWorker(15000);
    const container = navigator.serviceWorker;
    if (!container.controller) await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => { container.removeEventListener("controllerchange", changed); reject(new Error("Service worker did not control the attachment page")); }, 15000);
      const changed = () => { if (container.controller) { clearTimeout(timer); container.removeEventListener("controllerchange", changed); resolve(); } };
      container.addEventListener("controllerchange", changed); changed();
    });
    writeStatus("Starting >32 MiB service-worker attachment download");
    await streamFileToDownload(fileId, undefined, { picker: false, name });
    return { fileId, sizeBytes: size, thresholdBytes: 32 * MIB, name, path: "/__peerlink_download/", completed: true };
  } catch (error) {
    await deleteFile(fileId).catch(() => {});
    throw error;
  }
}

Object.assign(window, { runLargeAttachmentDownload });
