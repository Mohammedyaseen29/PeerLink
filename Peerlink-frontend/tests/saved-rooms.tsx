import { useState } from "react";
import { createRoot } from "react-dom/client";
import App from "../src/App";
import { getStoredFiles, saveChunks, saveMetaData, type FileMetadata } from "../src/ProgressDB";
import "../src/index.css";

let sockets = 0;
const NativeWebSocket = window.WebSocket;
window.WebSocket = class extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets++;
        document.querySelector("#socket-count")!.textContent = `Room connections: ${sockets}`;
    }
};
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600"><rect width="960" height="600" fill="#243120"/><circle cx="740" cy="165" r="220" fill="#c4f55a"/><path d="M0 600L470 160L760 600" fill="#6f8c50"/><text x="55" y="510" fill="#eff2e9" font-family="sans-serif" font-size="54">A little space to create.</text></svg>';
async function seed() {
    const names = ["Design studio", "Weekend photos", "Client handoff", "Sound notes", "Reading list", "A very long room name that should still fit on a narrow mobile screen", "Archive", "Old sketches"];
    for (let index = 0; index < names.length; index++) {
        for (let file = 0; file < (index === 0 ? 3 : 1); file++) {
            const text = file === 0 ? svg : "PeerLink saved-room preview. Already received, available without a peer.";
            const bytes = new TextEncoder().encode(text).buffer;
            const metadata: FileMetadata = { fileId: `qa-recent-${index}-${file}`, roomId: names[index].toLowerCase().replaceAll(" ", "-"), roomType: "persistent", name: file === 0 ? "Moodboard.svg" : `Notes-${file}.txt`, mimeType: file === 0 ? "image/svg+xml" : "text/plain", size: bytes.byteLength, receivedChunks: 1, totalChunks: 1, chunkSize: bytes.byteLength, status: "complete", sourceName: "Alex", createdAt: Date.now() - index * 86_400_000 - file * 1000, completedAt: Date.now() - index * 86_400_000 - file * 1000 };
            await saveChunks(metadata.fileId, [{ chunkIndex: 0, data: bytes }], metadata);
        }
    }
    const reference = (await getStoredFiles()).find(file => file.fileId === "qa-recent-0-0")!;
    await saveMetaData({ ...reference, fileId: "qa-recent-temporary", roomId: "temporary-must-not-appear", roomType: "temporary" });
    await saveMetaData({ ...reference, fileId: "qa-recent-incomplete", roomId: "incomplete-must-not-appear", status: "receiving", receivedChunks: 0 });
}
function Harness() {
    const [message, setMessage] = useState("");
    return <><div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, padding: 16 }}><button type="button" className="btn btn-secondary" onClick={() => void seed().then(() => window.location.reload()).catch(error => setMessage(String(error)))}>Seed saved rooms</button><output id="socket-count">Room connections: 0</output><output>{message}</output></div><App /></>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
