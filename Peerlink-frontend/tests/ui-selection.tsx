import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { FileUploader, ReceiveProgress, ReceivedFiles, SendQueue } from "../src/components";
import type { QueuedFile, ReceivingFile } from "../src/types";
import type { FileMetadata } from "../src/ProgressDB";
import "../src/index.css";

const now = Date.now();
const makeQueued = (name: string, status: QueuedFile["status"] = "pending", size = 10) => ({
  id: name, file: new File([new Uint8Array(size)], name, { type: "application/octet-stream" }), recipientIds: [], recipients: [], status,
  progress: 0, lastSentChunk: 0, totalChunks: 1, bytesTransferred: status === "sending" ? 1 : 0,
  ...(status === "failed" ? { error: "Connection lost" } : {}), ...(status === "sending" ? { speedBytesPerSecond: 500 } : {}),
} as QueuedFile);
const makeMetadata = (i: number): FileMetadata => ({ fileId: `received-${i}`, roomId: "test", name: `received-${String(i).padStart(3, "0")}.txt`, size: i + 1, mimeType: "text/plain", totalChunks: 1, receivedChunks: 1, status: "complete", createdAt: now });

function Harness() {
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [receivings, setReceivings] = useState<ReceivingFile[]>([]);
  const [received, setReceived] = useState<FileMetadata[]>([]);
  const [accepted, setAccepted] = useState(true);
  const [selectedPayload, setSelectedPayload] = useState<string[]>([]);
  const [callbacks, setCallbacks] = useState<string[]>([]);
  const note = (name: string, id = "") => setCallbacks(current => [...current, `${name}:${id}`]);
  Object.assign(window, {
    uiTest: {
      setAccepted,
      setQueue: (next: QueuedFile[]) => setQueue(next),
      setReceivings: (next: ReceivingFile[]) => setReceivings(next),
      setReceived: (next: FileMetadata[]) => setReceived(next),
      callbacks: () => callbacks,
      payload: () => selectedPayload,
      clearCallbacks: () => setCallbacks([]),
    },
  });
  return <main className="app-shell" style={{ maxWidth: 1000, margin: "0 auto", padding: 16 }}>
    <h1>PeerLink UI selection checks</h1>
    <FileUploader canSend onFilesSelect={async files => { setSelectedPayload(files.map(file => file.name)); return accepted; }} />
    <SendQueue queue={queue} onPause={id => note("pause", id)} onResume={id => note("resume", id)} onRetry={id => note("retry", id)} onRemove={id => note("remove", id)} onClearAll={() => note("clear")} onPreview={file => note("preview", file.id)} />
    <ReceiveProgress receivings={receivings} />
    <ReceivedFiles files={received} onlineFiles={[]} onDownload={async file => note("download", file.fileId)} onPreview={file => note("preview-received", file.fileId)} onDelete={file => note("delete", file.fileId)} onClearRoom={() => note("clear-room")} />
    <output data-testid="callback-log">{callbacks.join(",")}</output>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Harness />);
