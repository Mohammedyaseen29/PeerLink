import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ReceivedFiles } from "../src/components/ReceivedFiles";
import type { FileMetadata } from "../src/ProgressDB";
import "../src/index.css";
const make = (index: number): FileMetadata => ({ fileId: `saved-${index}`, sourcePeerId: "sender", sourceFileId: `wire-${index}`, sourceName: "Steve", roomId: "fixture", name: index === 0 ? "lockscreen.webp" : index % 3 === 0 ? `holiday-photo-${index}.webp` : index % 3 === 1 ? `notes-${index}.txt` : `recording-${index}.mp4`, mimeType: index % 3 === 0 ? "image/webp" : index % 3 === 1 ? "text/plain" : "video/mp4", size: 2_180_000 + index, receivedChunks: 1, totalChunks: 1, status: "complete", createdAt: Date.now() });
function Harness() {
    const [files, setFiles] = useState([make(0)]);
    const [peer, setPeer] = useState<FileMetadata[]>([{ ...make(0), fileId: "alias-0", remoteFileId: "q-wire-0" }]);
    const [log, setLog] = useState("");
    return <main style={{ maxWidth: 660, margin: "24px auto", padding: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
            <button className="btn btn-secondary" onClick={() => { setFiles([make(0)]); setPeer([{ ...make(0), fileId: "alias-0", remoteFileId: "q-wire-0" }]); }}>One received file</button>
            <button className="btn btn-secondary" onClick={() => { setFiles(Array.from({ length: 120 }, (_, i) => make(i))); setPeer([{ ...make(0), fileId: "alias-0", remoteFileId: "q-wire-0" }, { ...make(200), fileId: "peer-only", remoteFileId: "q-wire-200", name: "not-received-yet.webp", mimeType: "image/webp" }]); }}>Load many files</button>
        </div>
        <ReceivedFiles files={files} onlineFiles={peer} onPreview={file => setLog(`Preview ${file.fileId}`)} onDownload={async () => { throw new Error("Synthetic download failure"); }} onDelete={file => setFiles(current => current.filter(item => item.fileId !== file.fileId))} onClearRoom={() => setFiles([])} />
        <output>{log}</output>
    </main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
