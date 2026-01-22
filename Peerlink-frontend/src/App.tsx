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
  status: "pending" | "sending" | "sent" | "failed";
  progress: number;
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
        setReceivedFiles(files);
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
            setReceivedFiles(files);
            setCurrentReceiving(null);
          }
          break;

        case "ack":
          if (sendingFile.current) {
            currentChunkToSend.current = msg.chunk + 1;
            const totalChunks = Math.ceil(
              sendingFile.current.file.size / (64 * 1024),
            );

            const progress = Math.round(
              (currentChunkToSend.current / totalChunks) * 100,
            );

            setSendQueue((prev) =>
              prev.map((f) =>
                f.id === sendingFile.current?.id ? { ...f, progress } : f,
              ),
            );

            if (currentChunkToSend.current < totalChunks) {
              sendNextChunk();
            } else {
              dcRef.current?.send(JSON.stringify({ type: "done" }));
              logs(`✓ Sent: ${sendingFile.current.file.name}`);
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
            sendNextChunk();
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
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const newQueue: QueuedFile[] = files.map((file) => ({
      file,
      id: `${Date.now()}_${Math.random()}`,
      progress: 0,
      status: "pending",
    }));
    setSendQueue((prev) => [...prev, ...newQueue]);
    logs(`Added ${files.length} file(s) to queue`);
  };

  const processNextFileInQueue = () => {
    const nextFile = sendQueue.find((f) => f.status === "pending");
    if (!nextFile || !dcRef.current) return;

    sendingFile.current = nextFile;
    currentChunkToSend.current = 0;

    setSendQueue((prev) =>
      prev.map((f) => (f.id === nextFile.id ? { ...f, status: "sending" } : f)),
    );

    const totalChunks = Math.ceil(nextFile.file.size / (64 * 1024));

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

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
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

          {/*<button
            className="bg-green-600 text-white px-6 py-2 rounded-lg hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition"
            onClick={startSending}
            disabled={sendingFile.current !== null}
          >
            {sendingFile.current ? "Sending..." : "Start Transfer"}
          </button>*/}
          {/* Send Queue Display */}
          {sendQueue.length > 0 && (
            <div className="w-full max-w-2xl">
              <div className="flex justify-between items-center mb-2">
                <h3 className="font-bold">
                  Sending Queue (
                  {sendQueue.filter((f) => f.status === "sent").length}/
                  {sendQueue.length})
                </h3>
                <button
                  onClick={() => setSendQueue([])}
                  className="text-sm text-red-600 hover:text-red-800"
                >
                  Clear Queue
                </button>
              </div>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {sendQueue.map((f) => (
                  <div
                    key={f.id}
                    className="border rounded p-2 bg-white shadow-sm"
                  >
                    <div className="flex justify-between">
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
                      <span className="text-xs ml-2">
                        {formatBytes(f.file.size)}
                      </span>
                    </div>
                    <div className="w-full bg-gray-200 h-2 rounded mt-1">
                      <div
                        className={`h-2 rounded transition-all ${
                          f.status === "sent"
                            ? "bg-green-500"
                            : f.status === "sending"
                              ? "bg-blue-500"
                              : "bg-gray-400"
                        }`}
                        style={{ width: `${f.progress}%` }}
                      />
                    </div>
                    <div className="text-xs text-gray-500 capitalize mt-1">
                      {f.status === "sending"
                        ? `${f.progress}% - Sending...`
                        : f.status}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Received Files Display */}
          <div className="mt-4 w-full">
            <h3 className="font-bold mb-2">Received Files</h3>
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
                    <div>
                      <div className="text-sm font-medium">{file.name}</div>
                      {file.path && (
                        <div className="text-xs text-gray-500">{file.path}</div>
                      )}
                    </div>
                    <span className="text-xs">{formatBytes(file.size)}</span>
                  </div>
                  {file.status === "complete" ? (
                    <button
                      onClick={() => downloadFile(file)}
                      className="mt-2 bg-indigo-600 text-white px-3 py-1 rounded text-sm w-full"
                    >
                      Download
                    </button>
                  ) : (
                    <div className="text-xs text-blue-600 mt-1">
                      Receiving... {file.receivedChunks}/{file.totalChunks}{" "}
                      chunks
                    </div>
                  )}
                </div>
              ))}
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
