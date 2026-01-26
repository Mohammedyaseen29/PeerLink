import { useRef, useState, useEffect, useCallback } from "react";
import {
    saveMetaData,
    saveChunk,
    getFilesInRoom,
    getLastChunkIndex,
    deleteFile,
    updateFileProgress,
    streamFileToDownload,
    savePartialSendState,
    clearPartialSendState,
    getPartialSendState,
    clearRoom as clearRoomDB,
    openDB,
    type FileMetadata,
} from "../ProgressDB";
import type { QueuedFile, ConnectionType, ReceivingFile } from "../types";
import { generateId } from "../utils/helpers";

const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    {
        urls: "turn:openrelay.metered.ca:80",
        username: "openrelayproject",
        credential: "openrelayproject",
    },
];

const CHUNK_SIZE = 64 * 1024;

export function useP2P() {
    const [roomId, setRoomId] = useState("");
    const [connected, setConnected] = useState(false);
    const [connectionType, setConnectionType] = useState<ConnectionType>("disconnected");
    const [logs, setLogs] = useState<string[]>([]);
    const [sendQueue, setSendQueue] = useState<QueuedFile[]>([]);
    const [receivedFiles, setReceivedFiles] = useState<FileMetadata[]>([]);
    const [currentReceiving, setCurrentReceiving] = useState<ReceivingFile | null>(null);

    const wsRef = useRef<WebSocket | null>(null);
    const pcRef = useRef<RTCPeerConnection | null>(null);
    const dcRef = useRef<RTCDataChannel | null>(null);
    const currentFileId = useRef<string | null>(null);
    const currentMeta = useRef<FileMetadata | null>(null);
    const lastReceivedChunk = useRef<number>(-1);
    const sendingFile = useRef<QueuedFile | null>(null);
    const currentChunkToSend = useRef<number>(0);
    const fileReaderRef = useRef<FileReader>(new FileReader());
    const receiveStartTime = useRef<number>(0);

    const log = useCallback((message: string) => {
        setLogs((prev) => [...prev, message]);
        console.log(message);
    }, []);

    // Load received files when roomId changes
    useEffect(() => {
        const loadReceivedFiles = async () => {
            if (!roomId) return;
            try {
                const files = await getFilesInRoom(roomId);
                setReceivedFiles(files.filter((f) => f.status === "complete"));
            } catch (error) {
                console.error("Error loading files:", error);
            }
        };
        loadReceivedFiles();
    }, [roomId]);

    // Process send queue when connected and no file is being sent
    useEffect(() => {
        if (connected && !sendingFile.current && sendQueue.find((f) => f.status === "pending")) {
            processNextFileInQueue();
        }
    }, [connected, sendQueue]);

    const detectConnectionType = useCallback((pc: RTCPeerConnection) => {
        pc.getStats().then((stats) => {
            stats.forEach((report) => {
                if (report.type === "candidate-pair" && report.state === "succeeded") {
                    const localCandidateId = report.localCandidateId;
                    const remoteCandidateId = report.remoteCandidateId;

                    stats.forEach((candidate) => {
                        if (candidate.id === localCandidateId || candidate.id === remoteCandidateId) {
                            if (candidate.candidateType === "relay") {
                                setConnectionType("relay");
                            } else if (candidate.candidateType === "srflx" || candidate.candidateType === "prflx") {
                                setConnectionType("p2p");
                            } else if (candidate.candidateType === "host") {
                                setConnectionType("local");
                            }
                        }
                    });
                }
            });
        });
    }, []);

    const bindChannel = useCallback((ch: RTCDataChannel) => {
        dcRef.current = ch;

        ch.onopen = () => {
            console.log("Data channel opened");
            setConnected(true);
            if (pcRef.current) {
                detectConnectionType(pcRef.current);
            }
        };

        ch.onmessage = async (event) => {
            if (typeof event.data === "string") {
                await handleControlMessage(event.data);
            } else {
                await handleBinaryChunk(event.data);
            }
        };

        ch.onclose = () => {
            console.log("Data channel closed");
            setConnected(false);
            setConnectionType("disconnected");
        };
    }, []);

    const handleControlMessage = async (data: string) => {
        try {
            const msg = JSON.parse(data);

            switch (msg.type) {
                case "meta": {
                    const fileId = `${roomId}_${Date.now()}_${Math.random()}`;
                    currentFileId.current = fileId;
                    lastReceivedChunk.current = -1;
                    receiveStartTime.current = Date.now();

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
                            JSON.stringify({ type: "resume_req", fromChunk: lastChunk + 1 })
                        );
                        log(`Resuming from chunk ${lastChunk + 1}`);
                    }

                    setCurrentReceiving({
                        name: msg.name,
                        progress: 0,
                        size: msg.size,
                        startTime: Date.now(),
                        bytesReceived: 0,
                    });
                    break;
                }

                case "done":
                    if (currentFileId.current && currentMeta.current) {
                        await updateFileProgress(
                            currentFileId.current,
                            currentMeta.current.totalChunks,
                            "complete"
                        );
                        log(`✓ Received: ${currentMeta.current.name}`);
                        const files = await getFilesInRoom(roomId);
                        setReceivedFiles(files.filter((f) => f.status === "complete"));
                        setCurrentReceiving(null);
                    }
                    break;

                case "ack":
                    if (sendingFile.current) {
                        const ackedChunk = msg.chunk;
                        currentChunkToSend.current = ackedChunk + 1;

                        const totalChunks = Math.ceil(sendingFile.current.file.size / CHUNK_SIZE);
                        const progress = Math.round((currentChunkToSend.current / totalChunks) * 100);
                        const bytesTransferred = currentChunkToSend.current * CHUNK_SIZE;

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
                                    return {
                                        ...f,
                                        progress,
                                        lastSentChunk: ackedChunk,
                                        bytesTransferred,
                                    };
                                }
                                return f;
                            })
                        );

                        if (currentChunkToSend.current < totalChunks) {
                            sendNextChunk();
                        } else {
                            dcRef.current?.send(JSON.stringify({ type: "done" }));
                            log(`✓ Sent: ${sendingFile.current.file.name}`);

                            await clearPartialSendState(
                                roomId,
                                sendingFile.current.file.name,
                                sendingFile.current.file.size
                            );

                            setSendQueue((prev) =>
                                prev.map((f) =>
                                    f.id === sendingFile.current?.id
                                        ? { ...f, status: "sent", progress: 100 }
                                        : f
                                )
                            );
                            sendingFile.current = null;
                            processNextFileInQueue();
                        }
                    }
                    break;

                case "resume_req":
                    if (sendingFile.current) {
                        currentChunkToSend.current = msg.fromChunk;
                        log(`Resuming send from chunk ${msg.fromChunk}`);
                        sendNextChunk();
                    }
                    break;

                case "pause_req":
                    if (sendingFile.current) {
                        log(`⏸ Paused by receiver`);
                        setSendQueue((prev) =>
                            prev.map((f) =>
                                f.id === sendingFile.current?.id ? { ...f, status: "paused" } : f
                            )
                        );
                        sendingFile.current = null;
                    }
                    break;

                case "cancel":
                    if (currentFileId.current && currentMeta.current) {
                        log(`✗ Sender cancelled: ${currentMeta.current.name}`);
                        await deleteFile(currentFileId.current);
                        const files = await getFilesInRoom(roomId);
                        setReceivedFiles(files.filter((f) => f.status === "complete"));
                        setCurrentReceiving(null);
                        currentFileId.current = null;
                        currentMeta.current = null;
                    }
                    break;
            }
        } catch (e) {
            console.error(e);
        }
    };

    const handleBinaryChunk = async (data: ArrayBuffer) => {
        if (!currentFileId.current || !currentMeta.current) return;

        const nextIndex = lastReceivedChunk.current + 1;
        await saveChunk(currentFileId.current, nextIndex, data);
        lastReceivedChunk.current = nextIndex;
        await updateFileProgress(currentFileId.current, nextIndex + 1);

        const progress = Math.round(
            ((nextIndex + 1) / currentMeta.current.totalChunks) * 100
        );
        const bytesReceived = (nextIndex + 1) * CHUNK_SIZE;

        setCurrentReceiving((prev) =>
            prev
                ? {
                    ...prev,
                    progress,
                    bytesReceived: Math.min(bytesReceived, currentMeta.current!.size),
                }
                : null
        );

        dcRef.current?.send(JSON.stringify({ type: "ack", chunk: nextIndex }));
    };

    const sendNextChunk = () => {
        if (!sendingFile.current) return;

        const start = currentChunkToSend.current * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, sendingFile.current.file.size);
        const slice = sendingFile.current.file.slice(start, end);

        fileReaderRef.current.onload = () => {
            if (fileReaderRef.current.result) {
                dcRef.current?.send(fileReaderRef.current.result as ArrayBuffer);
            }
        };

        fileReaderRef.current.readAsArrayBuffer(slice);
    };

    const processNextFileInQueue = () => {
        const nextFile = sendQueue.find((f) => f.status === "pending");
        if (!nextFile || !dcRef.current) return;

        sendingFile.current = nextFile;
        currentChunkToSend.current = nextFile.lastSentChunk + 1;

        setSendQueue((prev) =>
            prev.map((f) =>
                f.id === nextFile.id
                    ? { ...f, status: "sending", startTime: Date.now() }
                    : f
            )
        );

        const totalChunks = Math.ceil(nextFile.file.size / CHUNK_SIZE);

        if (nextFile.lastSentChunk === -1) {
            dcRef.current.send(
                JSON.stringify({
                    type: "meta",
                    name: nextFile.file.name,
                    path: (nextFile.file as any).webkitRelativePath || undefined,
                    size: nextFile.file.size,
                    mimeType: nextFile.file.type,
                    totalChunks,
                })
            );
        }

        sendNextChunk();
    };

    const ensurePeer = useCallback(() => {
        if (pcRef.current) return;

        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        console.log("Peer created");

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                wsRef.current?.send(
                    JSON.stringify({
                        type: "ice_candidate",
                        payload: event.candidate,
                        roomId,
                    })
                );
            }
        };

        pc.ondatachannel = (event) => {
            console.log("Data channel received");
            bindChannel(event.channel);
        };

        const dc = pc.createDataChannel("data");
        bindChannel(dc);

        pcRef.current = pc;
    }, [roomId, bindChannel]);

    const makeOffer = useCallback(async () => {
        const offer = await pcRef.current?.createOffer();
        await pcRef.current?.setLocalDescription(offer);
        wsRef.current?.send(
            JSON.stringify({ type: "offer", payload: offer, roomId })
        );
    }, [roomId]);

    const join = useCallback((newRoomId: string) => {
        if (!newRoomId.trim()) return;
        if (wsRef.current) return;

        setRoomId(newRoomId);

        const ws = new WebSocket("ws://localhost:3000");
        wsRef.current = ws;

        ws.onopen = () => {
            console.log("WebSocket connected");
            ws.send(JSON.stringify({ type: "join", roomId: newRoomId }));
        };

        ws.onmessage = async (event) => {
            const data = JSON.parse(event.data);
            console.log("WS message:", data.type);

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
                    ws.send(
                        JSON.stringify({ type: "answer", payload: answer, roomId: newRoomId })
                    );
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
                    console.log("Peer left");
                    break;
            }
        };
    }, [ensurePeer, makeOffer]);

    const addFilesToQueue = useCallback(async (files: File[]) => {
        const newQueue: QueuedFile[] = [];

        for (const file of files) {
            const lastChunk = await getPartialSendState(roomId, file.name, file.size);
            const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
            const progress =
                lastChunk >= 0 ? Math.round(((lastChunk + 1) / totalChunks) * 100) : 0;

            if (lastChunk >= 0) {
                log(`Resuming ${file.name} from chunk ${lastChunk + 1}`);
            }

            newQueue.push({
                file,
                id: generateId(),
                progress,
                status: "pending",
                lastSentChunk: lastChunk,
                bytesTransferred: lastChunk >= 0 ? (lastChunk + 1) * CHUNK_SIZE : 0,
            });
        }

        setSendQueue((prev) => [...prev, ...newQueue]);
        log(`Added ${files.length} file(s) to queue`);
    }, [roomId, log]);

    const pauseSending = useCallback((fileId: string) => {
        const file = sendQueue.find((f) => f.id === fileId);
        if (file && file.status === "sending") {
            setSendQueue((prev) =>
                prev.map((f) => (f.id === fileId ? { ...f, status: "paused" } : f))
            );
            sendingFile.current = null;
            log(`⏸ Paused: ${file.file.name}`);
        }
    }, [sendQueue, log]);

    const resumeSending = useCallback((fileId: string) => {
        const file = sendQueue.find((f) => f.id === fileId);
        if (file && file.status === "paused") {
            setSendQueue((prev) =>
                prev.map((f) => (f.id === fileId ? { ...f, status: "pending" } : f))
            );
            log(`▶ Resuming: ${file.file.name}`);
        }
    }, [sendQueue, log]);

    const removeFromQueue = useCallback(async (fileId: string) => {
        const file = sendQueue.find((f) => f.id === fileId);
        if (file) {
            if (file.status === "sending") {
                dcRef.current?.send(JSON.stringify({ type: "cancel" }));
                sendingFile.current = null;
            }

            await clearPartialSendState(roomId, file.file.name, file.file.size);
            setSendQueue((prev) => prev.filter((f) => f.id !== fileId));
            log(`✗ Removed: ${file.file.name}`);
        }
    }, [sendQueue, roomId, log]);

    const clearAllQueue = useCallback(async () => {
        if (sendingFile.current) {
            dcRef.current?.send(JSON.stringify({ type: "cancel" }));
            sendingFile.current = null;
        }

        for (const file of sendQueue) {
            await clearPartialSendState(roomId, file.file.name, file.file.size);
        }

        setSendQueue([]);
        log("Cleared all files from queue");
    }, [sendQueue, roomId, log]);

    const downloadFile = useCallback(async (file: FileMetadata) => {
        try {
            log(`Downloading: ${file.name}`);
            await streamFileToDownload(file.fileId);
            log(`✓ Downloaded: ${file.name}`);
        } catch (error) {
            log(`✗ Error downloading ${file.name}`);
            console.error(error);
        }
    }, [log]);

    const clearRoom = useCallback(async () => {
        if (!roomId) return;

        const confirmed = window.confirm(
            `Are you sure you want to clear all files from room "${roomId}"? This will permanently delete all stored files.`
        );

        if (confirmed) {
            try {
                await clearRoomDB(roomId);
                setReceivedFiles([]);
                log(`🗑️ Cleared all files from room ${roomId}`);
            } catch (error) {
                log(`✗ Error clearing room`);
                console.error(error);
            }
        }
    }, [roomId, log]);

    const openPreview = useCallback(async (file: FileMetadata): Promise<string> => {
        const db = await openDB();
        const chunks: ArrayBuffer[] = [];

        for (let i = 0; i < file.receivedChunks; i++) {
            const tx = db.transaction("chunks", "readonly");
            const store = tx.objectStore("chunks");
            const req = store.get([file.fileId, i]);

            const chunk = await new Promise<ArrayBuffer>((resolve, reject) => {
                req.onsuccess = () => {
                    if (req.result) resolve(req.result.data);
                    else reject(new Error(`Chunk ${i} not found`));
                };
                req.onerror = () => reject(req.error);
            });

            chunks.push(chunk);
        }

        const blob = new Blob(chunks, { type: file.mimeType });
        return URL.createObjectURL(blob);
    }, []);

    return {
        // State
        roomId,
        connected,
        connectionType,
        logs,
        sendQueue,
        receivedFiles,
        currentReceiving,

        // Actions
        setRoomId,
        join,
        addFilesToQueue,
        pauseSending,
        resumeSending,
        removeFromQueue,
        clearAllQueue,
        downloadFile,
        clearRoom,
        openPreview,
    };
}
