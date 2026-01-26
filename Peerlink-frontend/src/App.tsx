import React, { useRef, useState, useEffect } from "react";
import {
  saveMetaData,
  saveChunk,
  getMetaData,
  getFilesInRoom,
  getLastChunkIndex,
  deleteFile,
  updateFileProgress,
  streamFileToDownload,
  savePartialSendState,
  clearPartialSendState,
  getPartialSendState,
  clearRoom,
  type FileMetadata,
} from "./ProgressDB";

// TypeScript fix for webkitdirectory
declare module "react" {
  interface InputHTMLAttributes<T> extends HTMLAttributes<T> {
    webkitdirectory?: string;
  }
}

const iceServers = [
  { urls: "stun:stun.l.google.com:19302" },
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

type QueuedFile = {
  file: File;
  id: string;
  status: "pending" | "sending" | "sent" | "failed" | "paused";
  progress: number;
  lastSentChunk: number;
};

type log = string;

function App() {
  const [roomId, setRoomId] = useState("");
  const [connected, setConnected] = useState(false);
  const [log, setLog] = useState<log[]>([]);
  const [sendQueue, setSendQueue] = useState<QueuedFile[]>([]);
  const [receivedFiles, setReceivedFiles] = useState<FileMetadata[]>([]);
  const [currentReceiving, setCurrentReceiving] = useState<string | null>(null);
  const [receiveProgress, setReceiveProgress] = useState(0);
  const [previewFile, setPreviewFile] = useState<FileMetadata | null>(null);
  const [previewBlob, setPreviewBlob] = useState<string | null>(null);

  // Load send queue from storage on mount
  useEffect(() => {
    const loadSendQueue = () => {
      const saved = localStorage.getItem(`sendQueue_${roomId}`);
      if (saved && roomId) {
        try {
          const parsed = JSON.parse(saved);
          // We can't restore File objects, so we'll just clear old queues
          // Files need to be re-selected after reconnection
        } catch (e) {
          console.error("Error loading send queue:", e);
        }
      }
    };
    loadSendQueue();
  }, [roomId]);

  // Save send queue to storage whenever it changes
  useEffect(() => {
    if (roomId && sendQueue.length > 0) {
      // We can only save metadata, not actual File objects
      const queueMeta = sendQueue.map(f => ({
        id: f.id,
        name: f.file.name,
        size: f.file.size,
        status: f.status,
        progress: f.progress,
        lastSentChunk: f.lastSentChunk
      }));
      localStorage.setItem(`sendQueue_${roomId}`, JSON.stringify(queueMeta));
    }
  }, [sendQueue, roomId]);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const currentFileId = useRef<string | null>(null);
  const currentMeta = useRef<FileMetadata | null>(null);
  const lastReceivedChunk = useRef<number>(-1);
  const sendingFile = useRef<QueuedFile | null>(null);
  const currentChunkToSend = useRef<number>(0);
  const fileReaderRef = useRef<FileReader>(new FileReader());

  useEffect(() => {
    const loadReceivedFiles = async () => {
      try {
        const files = await getFilesInRoom(roomId);
        // Only show completed files
        setReceivedFiles(files.filter(f => f.status === "complete"));
      } catch (error) {
        console.error("Error loading files:", error);
      }
    };

    if (roomId) {
      loadReceivedFiles();
    }
  }, [roomId]);

  useEffect(() => {
    if (
      connected &&
      !sendingFile.current &&
      sendQueue.find((f) => f.status === "pending")
    ) {
      processNextFileInQueue();
    }
  }, [connected, sendQueue]);

  const logs = (m: string) => {
    setLog((p) => [...p, m]);
    console.log(m);
  };

  const ensurePeer = () => {
    if (pcRef.current) {
      return;
    }
    const pc = new RTCPeerConnection({ iceServers });
    console.log("peer created");

    pc.onicecandidate = (evnt) => {
      if (evnt.candidate) {
        wsRef.current?.send(
          JSON.stringify({
            type: "ice_candidate",
            payload: evnt.candidate,
            roomId,
          }),
        );
      }
    };
    pc.ondatachannel = (evnt) => {
      console.log("data channel received");
      bindChannel(evnt.channel);
    };

    const dc = pc.createDataChannel("data");
    bindChannel(dc);

    pcRef.current = pc;
  };

  const makeOffer = async () => {
    const offer = await pcRef.current?.createOffer();
    await pcRef.current?.setLocalDescription(offer);
    wsRef.current?.send(
      JSON.stringify({ type: "offer", payload: offer, roomId }),
    );
  };

  const bindChannel = (ch: RTCDataChannel) => {
    dcRef.current = ch;
    ch.onopen = () => {
      console.log("data channel opened");
      setConnected(true);
    };
    ch.onmessage = async (event) => {
      if (typeof event.data === "string") {
        await handleControlMessage(event.data);
      } else {
        await handleBinaryChunk(event.data);
      }
    };
    ch.onclose = () => {
      console.log("data channel closed");
      setConnected(false);
    };
  };

  const handleControlMessage = async (data: string) => {
    try {
      const msg = JSON.parse(data);
      switch (msg.type) {
        case "meta": {
          const fileId = `${roomId}_${Date.now()}_${Math.random()}`;
          currentFileId.current = fileId;
          lastReceivedChunk.current = -1;
          const metaData: FileMetadata = {
            fileId,
            roomId,
            name: msg.name,
            size: msg.size,
            path: msg.path,
            mimeType: msg.mimeType,
            totalChunks: msg.totalChunks,
            receivedChunks: 0,
            status: "receiving",
            createdAt: Date.now(),
          };

          await saveMetaData(metaData);
          currentMeta.current = metaData;

          const lastChunk = await getLastChunkIndex(fileId);
          if (lastChunk !== null && lastChunk >= 0) {
            lastReceivedChunk.current = lastChunk;
            dcRef.current?.send(
              JSON.stringify({ type: "resume_req", fromChunk: lastChunk + 1 }),
            );
            logs(`Resuming from chunk ${lastChunk + 1}`);
          }
          setCurrentReceiving(msg.name);
          break;
        }

        case "done":
          if (currentFileId.current && currentMeta.current) {
            await updateFileProgress(
              currentFileId.current,
              currentMeta.current.totalChunks,
              "complete",
            );
            logs(`✓ Received: ${currentMeta.current.name}`);
            const files = await getFilesInRoom(roomId);
            setReceivedFiles(files.filter(f => f.status === "complete"));
            setCurrentReceiving(null);
            setReceiveProgress(0);
          }
          break;

        case "ack":
          if (sendingFile.current) {
            const ackedChunk = msg.chunk;
            currentChunkToSend.current = ackedChunk + 1;
            
            const totalChunks = Math.ceil(sendingFile.current.file.size / (64 * 1024));
            const progress = Math.round((currentChunkToSend.current / totalChunks) * 100);
            
            // Save progress to IndexedDB
            await savePartialSendState(
              roomId,
              sendingFile.current.file.name,
              sendingFile.current.file.size,
              ackedChunk,
              totalChunks
            );
            
            setSendQueue((prev) =>
              prev.map((f) => {
                if (f.id === sendingFile.current?.id) {
                  return { ...f, progress, lastSentChunk: ackedChunk };
                }
                return f;
              })
            );

            if (currentChunkToSend.current < totalChunks) {
              sendNextChunk();
            } else {
              dcRef.current?.send(JSON.stringify({ type: "done" }));
              logs(`✓ Sent: ${sendingFile.current.file.name}`);
              
              // Clear send state after successful completion
              await clearPartialSendState(
                roomId,
                sendingFile.current.file.name,
                sendingFile.current.file.size
              );
              
              setSendQueue((prev) =>
                prev.map((f) =>
                  f.id === sendingFile.current?.id
                    ? { ...f, status: "sent", progress: 100 }
                    : f,
                ),
              );
              sendingFile.current = null;
              processNextFileInQueue();
            }
          }
          break;

        case "resume_req":
          if (sendingFile.current) {
            currentChunkToSend.current = msg.fromChunk;
            logs(`Resuming send from chunk ${msg.fromChunk}`);
            sendNextChunk();
          }
          break;

        case "pause_req":
          if (sendingFile.current) {
            logs(`⏸ Paused by receiver`);
            setSendQueue((prev) =>
              prev.map((f) =>
                f.id === sendingFile.current?.id ? { ...f, status: "paused" } : f,
              ),
            );
            sendingFile.current = null;
          }
          break;

        case "cancel":
          if (currentFileId.current && currentMeta.current) {
            logs(`✗ Sender cancelled: ${currentMeta.current.name}`);
            await deleteFile(currentFileId.current);
            const files = await getFilesInRoom(roomId);
            setReceivedFiles(files.filter(f => f.status === "complete"));
            setCurrentReceiving(null);
            setReceiveProgress(0);
            currentFileId.current = null;
            currentMeta.current = null;
          }
          break;
      }
    } catch (e) {
      console.log(e);
    }
  };

  const handleBinaryChunk = async (data: ArrayBuffer) => {
    if (!currentFileId.current || !currentMeta.current) {
      return;
    }

    const nextIndex = lastReceivedChunk.current + 1;
    await saveChunk(currentFileId.current, nextIndex, data);
    lastReceivedChunk.current = nextIndex;
    await updateFileProgress(currentFileId.current, nextIndex + 1);

    const progress = Math.round(
      ((nextIndex + 1) / currentMeta.current.totalChunks) * 100,
    );
    setReceiveProgress(progress);
    dcRef.current?.send(JSON.stringify({ type: "ack", chunk: nextIndex }));

    // Update preview if this file is being previewed
    if (previewFile && previewFile.fileId === currentFileId.current) {
      updatePreview(currentFileId.current, currentMeta.current);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const newQueue: QueuedFile[] = [];
    
    for (const file of files) {
      // Check if this file has partial send state
      const lastChunk = await getPartialSendState(roomId, file.name, file.size);
      const totalChunks = Math.ceil(file.size / (64 * 1024));
      const progress = lastChunk >= 0 ? Math.round(((lastChunk + 1) / totalChunks) * 100) : 0;
      
      if (lastChunk >= 0) {
        logs(`Resuming ${file.name} from chunk ${lastChunk + 1}`);
      }
      
      newQueue.push({
        file,
        id: `${Date.now()}_${Math.random()}`,
        progress,
        status: "pending",
        lastSentChunk: lastChunk,
      });
    }
    
    setSendQueue((prev) => [...prev, ...newQueue]);
    logs(`Added ${files.length} file(s) to queue`);
  };

  const processNextFileInQueue = () => {
    const nextFile = sendQueue.find((f) => f.status === "pending");
    if (!nextFile || !dcRef.current) return;

    sendingFile.current = nextFile;
    // Resume from last sent chunk + 1
    currentChunkToSend.current = nextFile.lastSentChunk + 1;

    setSendQueue((prev) =>
      prev.map((f) => (f.id === nextFile.id ? { ...f, status: "sending" } : f)),
    );

    const totalChunks = Math.ceil(nextFile.file.size / (64 * 1024));

    // Only send meta if starting fresh
    if (nextFile.lastSentChunk === -1) {
      dcRef.current.send(
        JSON.stringify({
          type: "meta",
          name: nextFile.file.name,
          path: (nextFile.file as any).webkitRelativePath || undefined,
          size: nextFile.file.size,
          mimeType: nextFile.file.type,
          totalChunks,
        }),
      );
    }

    sendNextChunk();
  };

  const sendNextChunk = async () => {
    if (!sendingFile.current) return;

    const chunkSize = 64 * 1024;
    const start = currentChunkToSend.current * chunkSize;
    const end = Math.min(start + chunkSize, sendingFile.current.file.size);
    const slice = sendingFile.current.file.slice(start, end);

    fileReaderRef.current.onload = () => {
      if (fileReaderRef.current.result) {
        dcRef.current?.send(fileReaderRef.current.result as ArrayBuffer);
      }
    };

    fileReaderRef.current.readAsArrayBuffer(slice);
  };

  const pauseSending = (fileId: string) => {
    const file = sendQueue.find((f) => f.id === fileId);
    if (file && file.status === "sending") {
      setSendQueue((prev) =>
        prev.map((f) => (f.id === fileId ? { ...f, status: "paused" } : f)),
      );
      sendingFile.current = null;
      logs(`⏸ Paused: ${file.file.name}`);
    }
  };

  const resumeSending = (fileId: string) => {
    const file = sendQueue.find((f) => f.id === fileId);
    if (file && file.status === "paused") {
      setSendQueue((prev) =>
        prev.map((f) => (f.id === fileId ? { ...f, status: "pending" } : f)),
      );
      logs(`▶ Resuming: ${file.file.name}`);
    }
  };

  const removeFromQueue = async (fileId: string) => {
    const file = sendQueue.find((f) => f.id === fileId);
    if (file) {
      if (file.status === "sending") {
        dcRef.current?.send(JSON.stringify({ type: "cancel" }));
        sendingFile.current = null;
      }
      
      // Clear send state from IndexedDB
      await clearPartialSendState(roomId, file.file.name, file.file.size);
      
      setSendQueue((prev) => prev.filter((f) => f.id !== fileId));
      logs(`✗ Removed: ${file.file.name}`);
    }
  };

  const clearAllQueue = async () => {
    if (sendingFile.current) {
      dcRef.current?.send(JSON.stringify({ type: "cancel" }));
      sendingFile.current = null;
    }
    
    // Clear all send states from IndexedDB
    for (const file of sendQueue) {
      await clearPartialSendState(roomId, file.file.name, file.file.size);
    }
    
    setSendQueue([]);
    logs("Cleared all files from queue");
  };

  const downloadFile = async (file: FileMetadata) => {
    try {
      logs(`Downloading: ${file.name}`);
      await streamFileToDownload(file.fileId, (percent) => {
        // Optional: show download progress
      });
      logs(`✓ Downloaded: ${file.name}`);
    } catch (error) {
      logs(`✗ Error downloading ${file.name}`);
      console.error(error);
    }
  };

  const updatePreview = async (fileId: string, metadata: FileMetadata) => {
    try {
      const db = await (await import("./ProgressDB")).openDB();
      const chunks: ArrayBuffer[] = [];

      for (let i = 0; i < metadata.receivedChunks; i++) {
        const tx = db.transaction("chunks", "readonly");
        const store = tx.objectStore("chunks");
        const req = store.get([fileId, i]);

        const chunk = await new Promise<ArrayBuffer>((resolve, reject) => {
          req.onsuccess = () => {
            if (req.result) resolve(req.result.data);
            else reject(new Error(`Chunk ${i} not found`));
          };
          req.onerror = () => reject(req.error);
        });

        chunks.push(chunk);
      }

      const blob = new Blob(chunks, { type: metadata.mimeType });
      const url = URL.createObjectURL(blob);
      
      if (previewBlob) {
        URL.revokeObjectURL(previewBlob);
      }
      
      setPreviewBlob(url);
    } catch (error) {
      console.error("Error updating preview:", error);
    }
  };

  const openPreview = async (file: FileMetadata) => {
    setPreviewFile(file);
    await updatePreview(file.fileId, file);
  };

  const closePreview = () => {
    if (previewBlob) {
      URL.revokeObjectURL(previewBlob);
    }
    setPreviewFile(null);
    setPreviewBlob(null);
  };

  const isPreviewable = (mimeType: string) => {
    return (
      mimeType.startsWith("image/") ||
      mimeType.startsWith("video/") ||
      mimeType.startsWith("audio/") ||
      mimeType === "application/pdf" ||
      mimeType.startsWith("text/")
    );
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
  };

  const handleClearRoom = async () => {
    if (!roomId) return;
    
    const confirmed = window.confirm(
      `Are you sure you want to clear all files from room "${roomId}"? This will permanently delete all stored files.`
    );
    
    if (confirmed) {
      try {
        await clearRoom(roomId);
        setReceivedFiles([]);
        logs(`🗑️ Cleared all files from room ${roomId}`);
      } catch (error) {
        logs(`✗ Error clearing room`);
        console.error(error);
      }
    }
  };

  const connectWebsocket = () => {
    if (wsRef.current) {
      return;
    }
    const ws = new WebSocket("ws://localhost:3000");
    wsRef.current = ws;
    ws.onopen = () => {
      console.log("client is connected");
      ws.send(JSON.stringify({ type: "join", roomId }));
    };

    ws.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      console.log(data.type);

      switch (data.type) {
        case "joined":
          ensurePeer();
          break;
        case "peer_joined":
          ensurePeer();
          await makeOffer();
          break;

        case "offer": {
          ensurePeer();
          await pcRef.current?.setRemoteDescription(data.payload);
          const answer = await pcRef.current?.createAnswer();
          await pcRef.current?.setLocalDescription(answer);
          ws.send(JSON.stringify({ type: "answer", payload: answer, roomId }));
          break;
        }
        case "answer":
          await pcRef.current?.setRemoteDescription(data.payload);
          break;
        case "ice_candidate":
          try {
            await pcRef.current?.addIceCandidate(data.payload);
          } catch (error) {
            console.error(error);
          }
          break;

        case "peer_left":
          console.log("peer left...");
          break;
      }
    };
  };

  const join = () => {
    if (!roomId.trim()) return;
    connectWebsocket();
  };

  return (
    <div className="p-6">
      <h1 className="text-5xl text-green-500 text-center mb-5">PeerLink</h1>

      <div className="flex gap-2 justify-center mb-4">
        <input
          className="border px-2 py-1 rounded"
          placeholder="Room ID"
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
        />
        <button
          className="bg-blue-600 text-white px-4 py-1 rounded hover:bg-blue-700"
          onClick={join}
        >
          Join
        </button>
      </div>

      {connected && (
        <div className="flex flex-col items-center gap-2">
          <div className="flex gap-4">
            <div className="relative">
              <input
                id="file-input"
                type="file"
                multiple
                onChange={handleFileSelect}
                className="hidden"
              />
              <label
                htmlFor="file-input"
                className="cursor-pointer bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 transition inline-block"
              >
                📄 Select Files
              </label>
            </div>

            <div className="relative">
              <input
                id="folder-input"
                type="file"
                webkitdirectory="true"
                directory=""
                onChange={handleFileSelect}
                className="hidden"
              />
              <label
                htmlFor="folder-input"
                className="cursor-pointer bg-purple-600 text-white px-6 py-3 rounded-lg hover:bg-purple-700 transition inline-block"
              >
                📁 Select Folder
              </label>
            </div>
          </div>

          {sendQueue.length > 0 && (
            <div className="w-full max-w-2xl">
              <div className="flex justify-between items-center mb-2">
                <h3 className="font-bold">
                  Sending Queue (
                  {sendQueue.filter((f) => f.status === "sent").length}/
                  {sendQueue.length})
                </h3>
                <button
                  onClick={clearAllQueue}
                  className="text-sm text-red-600 hover:text-red-800"
                >
                  Clear All
                </button>
              </div>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {sendQueue.map((f) => (
                  <div
                    key={f.id}
                    className="border rounded p-2 bg-white shadow-sm"
                  >
                    <div className="flex justify-between items-start">
                      <div className="flex-1">
                        <span className="text-sm font-medium">
                          {f.file.name}
                        </span>
                        {(f.file as any).webkitRelativePath && (
                          <div className="text-xs text-gray-500">
                            📁 {(f.file as any).webkitRelativePath}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs">{formatBytes(f.file.size)}</span>
                        {f.status === "sending" && (
                          <button
                            onClick={() => pauseSending(f.id)}
                            className="text-orange-600 hover:text-orange-800 text-xs px-2 py-1"
                            title="Pause"
                          >
                            ⏸
                          </button>
                        )}
                        {f.status === "paused" && (
                          <button
                            onClick={() => resumeSending(f.id)}
                            className="text-green-600 hover:text-green-800 text-xs px-2 py-1"
                            title="Resume"
                          >
                            ▶
                          </button>
                        )}
                        {f.status !== "sent" && (
                          <button
                            onClick={() => removeFromQueue(f.id)}
                            className="text-red-600 hover:text-red-800 text-xs px-2 py-1"
                            title="Remove"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="w-full bg-gray-200 h-2 rounded mt-1">
                      <div
                        className={`h-2 rounded transition-all ${
                          f.status === "sent"
                            ? "bg-green-500"
                            : f.status === "sending"
                              ? "bg-blue-500"
                              : f.status === "paused"
                                ? "bg-orange-500"
                                : "bg-gray-400"
                        }`}
                        style={{ width: `${f.progress}%` }}
                      />
                    </div>
                    <div className="text-xs text-gray-500 capitalize mt-1">
                      {f.status === "sending"
                        ? `${f.progress}% - Sending...`
                        : f.status === "paused"
                          ? `${f.progress}% - Paused`
                          : f.status}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-4 w-full max-w-2xl">
            <div className="flex justify-between items-center mb-2">
              <h3 className="font-bold">Received Files</h3>
              {receivedFiles.length > 0 && (
                <button
                  onClick={handleClearRoom}
                  className="text-sm text-red-600 hover:text-red-800"
                  title="Clear all files in this room"
                >
                  🗑️ Clear Room
                </button>
              )}
            </div>
            {currentReceiving && (
              <div className="mb-2 p-2 bg-blue-50 rounded">
                <div className="text-sm">Receiving: {currentReceiving}</div>
                <div className="w-full bg-gray-200 h-2 rounded mt-1">
                  <div
                    className="bg-blue-500 h-2 rounded"
                    style={{ width: `${receiveProgress}%` }}
                  />
                </div>
              </div>
            )}
            <div className="space-y-2">
              {receivedFiles.map((file) => (
                <div key={file.fileId} className="border rounded p-2">
                  <div className="flex justify-between items-center">
                    <div className="flex-1">
                      <div className="text-sm font-medium">{file.name}</div>
                      {file.path && (
                        <div className="text-xs text-gray-500">{file.path}</div>
                      )}
                    </div>
                    <span className="text-xs">{formatBytes(file.size)}</span>
                  </div>
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={() => downloadFile(file)}
                      className="bg-indigo-600 text-white px-3 py-1 rounded text-sm flex-1"
                    >
                      Download
                    </button>
                    {isPreviewable(file.mimeType) && (
                      <button
                        onClick={() => openPreview(file)}
                        className="bg-green-600 text-white px-3 py-1 rounded text-sm"
                      >
                        👁 Preview
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {previewFile && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg max-w-4xl max-h-[90vh] w-full flex flex-col">
            <div className="flex justify-between items-center p-4 border-b">
              <div>
                <h3 className="font-bold">{previewFile.name}</h3>
                <p className="text-xs text-gray-500">
                  {formatBytes(previewFile.size)}
                </p>
              </div>
              <button
                onClick={closePreview}
                className="text-2xl hover:text-red-600"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {previewBlob ? (
                <>
                  {previewFile.mimeType.startsWith("image/") && (
                    <img
                      src={previewBlob}
                      alt={previewFile.name}
                      className="max-w-full h-auto mx-auto"
                    />
                  )}
                  {previewFile.mimeType.startsWith("video/") && (
                    <video
                      src={previewBlob}
                      controls
                      className="max-w-full h-auto mx-auto"
                    />
                  )}
                  {previewFile.mimeType.startsWith("audio/") && (
                    <audio src={previewBlob} controls className="w-full" />
                  )}
                  {previewFile.mimeType === "application/pdf" && (
                    <iframe
                      src={previewBlob}
                      className="w-full h-[70vh]"
                      title="PDF Preview"
                    />
                  )}
                  {previewFile.mimeType.startsWith("text/") && (
                    <iframe
                      src={previewBlob}
                      className="w-full h-[70vh] border"
                      title="Text Preview"
                    />
                  )}
                </>
              ) : (
                <div className="text-center py-10">Loading preview...</div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="mt-6 border p-3 h-64 overflow-y-auto text-sm font-mono bg-gray-50 rounded">
        {log.map((l, i) => (
          <div key={i}>{l}</div>
        ))}
      </div>
    </div>
  );
}

export default App;