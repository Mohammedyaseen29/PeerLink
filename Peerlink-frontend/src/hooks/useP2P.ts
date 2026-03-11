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
import type { QueuedFile, ConnectionType, ReceivingFile, ChatMessage, Settings, RoomType } from "../types";
import { generateId } from "../utils/helpers";
import { getRandomAvatar } from "../components/avatars";

const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    {
        urls: "turn:openrelay.metered.ca:80",
        username: "openrelayproject",
        credential: "openrelayproject",
    },
];

const CHUNK_SIZE = 64 * 1024;
const STORAGE_KEY = "peerlink_settings";

const ADJECTIVES = ["Swift", "Cosmic", "Neon", "Shadow", "Crystal", "Thunder", "Frost", "Blaze", "Lunar", "Storm", "Echo", "Phoenix", "Nova", "Vortex", "Pixel", "Cyber", "Quantum", "Hyper", "Ultra", "Mega"];
const NOUNS = ["Spidy", "Foxy", "Rexy", "Wolf", "Tiger", "Eagle", "Hawk", "Fox", "Bear", "Lynx", "Owl", "Raven", "Falcon", "Dragon", "Leopard", "Panther", "Lion"];


function generateMeaningfulName(): string {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    return `${adj}${noun}`;
}

function generateRoomId(): string {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)].toLowerCase();
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)].toLowerCase();
    const num = Math.floor(Math.random() * 100) + 1;
    return `${adj}-${noun}-${num}`;
}

function loadSettings(): Settings {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
            const parsed = JSON.parse(stored);
            if (!parsed.avatar) {
                parsed.avatar = getRandomAvatar().id;
            }
            return parsed;
        }
    } catch {}
    return { autoDownload: false, avatar: getRandomAvatar().id };
}

function saveSettings(settings: Settings): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function getUsername(): string {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
        try {
            const parsed = JSON.parse(stored);
            if (parsed.username) return parsed.username;
        } catch {}
    }
    return generateMeaningfulName();
}

export function useP2P() {
    const [roomId, setRoomId] = useState("");
    const roomIdRef = useRef(roomId);
    const [roomType, setRoomType] = useState<RoomType>("persistent");
    const [connected, setConnected] = useState(false);
    const [connectionType, setConnectionType] = useState<ConnectionType>("disconnected");
    const [sendQueue, setSendQueue] = useState<QueuedFile[]>([]);
    const [receivedFiles, setReceivedFiles] = useState<FileMetadata[]>([]);
    const [currentReceiving, setCurrentReceiving] = useState<ReceivingFile | null>(null);
    const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const [settings, setSettings] = useState<Settings>(loadSettings);
    const [username] = useState<string>(getUsername);
    const [isChatOpen, setIsChatOpen] = useState(false);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const peerLeftRef = useRef(false);
    const wsRef = useRef<WebSocket | null>(null);
    const pcRef = useRef<RTCPeerConnection | null>(null);
    const currentFileId = useRef<string | null>(null);
    const currentMeta = useRef<FileMetadata | null>(null);
    const lastReceivedChunk = useRef<number>(-1);
    const receivedChunksSet = useRef<Set<number>>(new Set());
    const sendingFile = useRef<QueuedFile | null>(null);
    const controlChannelRef = useRef<RTCDataChannel | null>(null);
    const dataChannelRef = useRef<RTCDataChannel | null>(null);
    const receiveStartTime = useRef<number>(0);
    const receiverAckBuffer = useRef<Set<number>>(new Set());
    const ackTimerRef = useRef<number | null>(null);
    const retransmitTimerRef = useRef<number | null>(null);
    const slidingWindow = useRef({
      windowSize: 32,
      maxWindowSize: 256, 
      minWindowSize: 8,
      inFlight: new Set<number>(), 
      nextToSend: 0,
      lastAcked: -1,
      ackBitmap: new Map<number, boolean>() 
    });
    
    const congestionControl = useRef({
      rttSamples: [] as number[],
      rttAvg: 100,
      sentTimes: new Map<number, number>()
    });

    // Load received files when roomId changes
    useEffect(() => {
        const loadReceivedFiles = async () => {
            if (!roomId || !roomId.trim()) return;
            
            setReceivedFiles([]);
            
            try {
                const files = await getFilesInRoom(roomId);
                setReceivedFiles(files.filter((f) => f.status === "complete"));
            } catch (error) {
                console.error("Error loading files:", error);
            }
        };
        loadReceivedFiles();
    }, [roomId]);

    // Keep roomIdRef updated with current roomId
    useEffect(() => {
        roomIdRef.current = roomId;
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

    const bindControlChannel = useCallback((ch: RTCDataChannel) => {
        controlChannelRef.current = ch;
    
        ch.onopen = () => {
        };
    
        ch.onmessage = async (event) => {
            if (typeof event.data === "string") {
                await handleControlMessage(event.data);
            }
        };
    
        ch.onclose = () => {
        };
    }, []);
    
    const bindDataChannel = useCallback((ch: RTCDataChannel) => {
        dataChannelRef.current = ch;
    
        ch.onopen = () => {
            setConnected(true);
            if (pcRef.current) {
                detectConnectionType(pcRef.current);
            }
        };
    
        ch.onmessage = async (event) => {
            if (event.data instanceof ArrayBuffer) {
                await handleBinaryChunk(event.data);
            }
        };
    
        ch.onclose = () => {
            setConnected(false);
            setConnectionType("disconnected");
        };
        
        ch.onbufferedamountlow = () => {
            if (sendingFile.current) {
                sendChunkBatch();
            }
        };
    }, [detectConnectionType]);

    const handleControlMessage = async (data: string) => {
        try {
            const msg = JSON.parse(data);

            switch (msg.type) {
                case "meta": {
                    const fileId = `${roomIdRef.current}_${Date.now()}_${Math.random()}`;
                    currentFileId.current = fileId;
                    lastReceivedChunk.current = -1;
                    receivedChunksSet.current.clear();
                    receiveStartTime.current = Date.now();

                    const metaData: FileMetadata = {
                        fileId,
                        roomId: roomIdRef.current,
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
                        controlChannelRef.current?.send(
                            JSON.stringify({ type: "resume_req", fromChunk: lastChunk + 1 })
                        );

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
                        const files = await getFilesInRoom(roomIdRef.current);
                        setReceivedFiles(files.filter((f) => f.status === "complete"));
                        
                        const completedFile = files.find(f => f.fileId === currentFileId.current);
                        if (completedFile) {
                            const savedSettings = loadSettings();
                            if (savedSettings.autoDownload) {
                                try {
                                    await streamFileToDownload(completedFile.fileId);
                                    await streamFileToDownload(completedFile.fileId);
                                } catch (err) {
                                    console.error("Auto-download failed:", err);
                                }
                            }
                        }
                        
                        setCurrentReceiving(null);
                    }
                    break;

                case "chat": {
                    const chatMsg: ChatMessage = {
                        id: msg.id,
                        senderId: msg.senderId,
                        senderName: msg.senderName,
                        content: msg.content,
                        timestamp: msg.timestamp,
                        status: "delivered"
                    };
                    setChatMessages(prev => [...prev, chatMsg]);
                    if (!isChatOpen) {
                        setUnreadCount(prev => prev + 1);
                    }
                    controlChannelRef.current?.send(JSON.stringify({
                        type: "chat_ack",
                        id: msg.id
                    }));
                    break;
                }

                case "chat_ack": {
                    setChatMessages(prev => prev.map(m => 
                        m.id === msg.id ? { ...m, status: "sent" } : m
                    ));
                    break;
                }

                case "peer_left": {
                    if (roomType === "temporary") {
                        peerLeftRef.current = true;
                        if (wsRef.current?.readyState === WebSocket.OPEN) {
                            wsRef.current.send(JSON.stringify({ type: "room_cleared", roomId }));
                        }
                    }
                    break;
                }

                case "room_cleared": {
                    if (roomType === "temporary") {
                        setConnected(false);
                        setConnectionType("disconnected");
                        const files = await getFilesInRoom(roomIdRef.current);
                        for (const file of files) {
                            await deleteFile(file.fileId);
                        }
                        setReceivedFiles([]);
                    }
                    break;
                }

                case "ack":{
                  if (!sendingFile.current) break;
                    
                    const ackedChunks = msg.chunks as number[];  // Receive array of chunk indices
                    const { inFlight, ackBitmap } = slidingWindow.current;
                    
                    // Process each ACK
                    ackedChunks.forEach(chunkIdx => {
                      inFlight.delete(chunkIdx);
                      ackBitmap.set(chunkIdx, true);
                      
                      // Update RTT for congestion control
                      const sentTime = congestionControl.current.sentTimes.get(chunkIdx);
                      if (sentTime) {
                        const rtt = Date.now() - sentTime;
                        congestionControl.current.rttSamples.push(rtt);
                        if (congestionControl.current.rttSamples.length > 10) {
                          congestionControl.current.rttSamples.shift();
                        }
                        const avgRtt = congestionControl.current.rttSamples.reduce((a,b) => a+b, 0) / 
                                       congestionControl.current.rttSamples.length;
                        congestionControl.current.rttAvg = avgRtt;
                        congestionControl.current.sentTimes.delete(chunkIdx);
                      }
                    });
                    
                    adjustWindowSize();
                    
                    const totalChunks = Math.ceil(sendingFile.current.file.size / CHUNK_SIZE);
                    const totalAcked = ackBitmap.size;
                    const progress = Math.round((totalAcked / totalChunks) * 100);
                    const bytesTransferred = Math.min(totalAcked * CHUNK_SIZE, sendingFile.current.file.size);
                    
                    // compute contiguous lastAcked
                    let lastAcked = slidingWindow.current.lastAcked;

                    while (ackBitmap.get(lastAcked + 1)) {
                        lastAcked++;
                    }
                    slidingWindow.current.lastAcked = lastAcked;
                    
                    await savePartialSendState(
                        roomIdRef.current,
                        sendingFile.current.file.name,
                        sendingFile.current.file.size,
                        lastAcked,
                        totalChunks
                    );
                    
                    setSendQueue((prev) =>
                        prev.map((f) => {
                            if (f.id === sendingFile.current?.id) {
                                return {
                                    ...f,
                                    progress,
                                    lastSentChunk: lastAcked,
                                    bytesTransferred,
                                };
                            }
                            return f;
                        })
                    );
                    
                    if (totalAcked >= totalChunks) {
                        controlChannelRef.current?.send(JSON.stringify({ type: "done" }));
                    
                        await clearPartialSendState(
                            roomIdRef.current,
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
                        
                        if (retransmitTimerRef.current) {
                            clearTimeout(retransmitTimerRef.current);
                            retransmitTimerRef.current = null;
                        }
                        
                        slidingWindow.current = {
                            windowSize: 32,
                            maxWindowSize: 256,
                            minWindowSize: 8,
                            inFlight: new Set(),
                            nextToSend: 0,
                            lastAcked: -1,
                            ackBitmap: new Map()
                        };
                        
                        sendingFile.current = null;
                        processNextFileInQueue();
                    } else {
                        sendChunkBatch();
                    }
                    break;
                }
                    

                case "resume_req":
                    if (sendingFile.current) {
                        slidingWindow.current.nextToSend = msg.fromChunk;
                        sendChunkBatch();
                    }
                    break;

                case "pause_req":
                    if (sendingFile.current) {
                        setSendQueue((prev) =>
                            prev.map((f) =>
                                f.id === sendingFile.current?.id ? { ...f, status: "paused" } : f
                            )
                        );
                        if (retransmitTimerRef.current) {
                            clearTimeout(retransmitTimerRef.current);
                            retransmitTimerRef.current = null;
                        }
                        sendingFile.current = null;
                    }
                    break;

                case "cancel":
                    if (currentFileId.current && currentMeta.current) {
                        await deleteFile(currentFileId.current);
                        const files = await getFilesInRoom(roomIdRef.current);
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
        const view = new DataView(data);
        const chunkIndex = view.getUint32(0, true);
        const chunkData = data.slice(4);
        
        if (receivedChunksSet.current.has(chunkIndex)) {
            return;
        }
        receivedChunksSet.current.add(chunkIndex);
        
        await saveChunk(currentFileId.current, chunkIndex, chunkData);
        if (chunkIndex > lastReceivedChunk.current) {
            lastReceivedChunk.current = chunkIndex;
          }
          
          // Add to ACK buffer
          receiverAckBuffer.current.add(chunkIndex);
          
          // Send batched ACK every 32 chunks OR every 20ms
          if (receiverAckBuffer.current.size >= 32) {
            sendBatchedAck();
          } else if (!ackTimerRef.current) {
            ackTimerRef.current = window.setTimeout(sendBatchedAck, 20);
          }
          
          const uniqueChunksReceived = receivedChunksSet.current.size;
          const progress = Math.round(
              (uniqueChunksReceived / currentMeta.current.totalChunks) * 100
          );
          const bytesReceived = uniqueChunksReceived * CHUNK_SIZE;
          
          await updateFileProgress(currentFileId.current, uniqueChunksReceived, "receiving");
          
          setCurrentReceiving((prev) =>
              prev
                  ? {
                      ...prev,
                      progress,
                      bytesReceived: Math.min(bytesReceived, currentMeta.current!.size),
                  }
                  : null
          );
          
          if (uniqueChunksReceived >= currentMeta.current.totalChunks) {
              controlChannelRef.current?.send(JSON.stringify({ type: "done" }));
              await updateFileProgress(currentFileId.current, currentMeta.current.totalChunks, "complete");
              const files = await getFilesInRoom(roomIdRef.current);
              setReceivedFiles(files.filter((f) => f.status === "complete"));
              setCurrentReceiving(null);
          }
        
    };
    const sendBatchedAck = useCallback(() => {
      if (receiverAckBuffer.current.size === 0) return;
      
      const chunks = Array.from(receiverAckBuffer.current);
      controlChannelRef.current?.send(JSON.stringify({ 
        type: "ack", 
        chunks 
      }));
      
      receiverAckBuffer.current.clear();
      if (ackTimerRef.current) {
        clearTimeout(ackTimerRef.current);
        ackTimerRef.current = null;
      }
    }, []);

    
    const sendChunkBatch = useCallback(() => {
        if (!sendingFile.current || !dataChannelRef.current) return;
    
        const { windowSize, inFlight } = slidingWindow.current;
        const totalChunks = Math.ceil(sendingFile.current.file.size / CHUNK_SIZE);
    
        const bufferedAmount = dataChannelRef.current.bufferedAmount;
        const threshold = 4 * 1024 * 1024;
    
        if (bufferedAmount > threshold) {
            dataChannelRef.current.bufferedAmountLowThreshold = threshold/2;
            return;
        }
    
        let sent = 0;
        while (inFlight.size < windowSize && slidingWindow.current.nextToSend < totalChunks && sent < 64) {
            const chunkIndex = slidingWindow.current.nextToSend;
    
            const start = chunkIndex * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, sendingFile.current.file.size);
            const slice = sendingFile.current.file.slice(start, end);
    
            slice.arrayBuffer().then(buffer => {
                const indexedChunk = new ArrayBuffer(buffer.byteLength + 4);
                const view = new DataView(indexedChunk);
                view.setUint32(0, chunkIndex, true);
                new Uint8Array(indexedChunk, 4).set(new Uint8Array(buffer));

                dataChannelRef.current?.send(indexedChunk);
                congestionControl.current.sentTimes.set(chunkIndex, Date.now());
            });

            inFlight.add(chunkIndex);
            slidingWindow.current.nextToSend++;
            sent++;
        }
    
        if (slidingWindow.current.nextToSend < totalChunks) {
            requestAnimationFrame(sendChunkBatch);
        }
    }, []);
    
    const adjustWindowSize = useCallback(() => {
      const { windowSize, maxWindowSize, minWindowSize, inFlight } = slidingWindow.current;
      const { rttAvg, rttSamples } = congestionControl.current;
      
      if (rttSamples.length < 3) return;
      
      const recentRtt = rttSamples[rttSamples.length - 1];
      const rttIncrease = recentRtt / rttAvg;
      
      if (rttIncrease > 1.3) {
        slidingWindow.current.windowSize = Math.max(
          minWindowSize,
          Math.floor(windowSize * 0.7)
        );
      }
      else if (inFlight.size < windowSize / 2 && rttIncrease < 1.1) {
        slidingWindow.current.windowSize = Math.min(
          maxWindowSize,
          Math.floor(windowSize * 1.2)
        );
      }
    }, []);

    const retransmitLostChunks = useCallback(() => {
        if (!sendingFile.current || !dataChannelRef.current) return;
        
        const { inFlight, ackBitmap } = slidingWindow.current;
        const { rttAvg, sentTimes } = congestionControl.current;
        const timeout = Math.max(rttAvg * 4, 500);
        const now = Date.now();
        
        const toRetransmit: number[] = [];
        
        inFlight.forEach(chunkIdx => {
            const sentTime = sentTimes.get(chunkIdx);
            if (sentTime && (now - sentTime > timeout)) {
                if (!ackBitmap.has(chunkIdx)) {
                    toRetransmit.push(chunkIdx);
                }
            }
        });
        
        if (toRetransmit.length > 0) {
        }
        
        toRetransmit.forEach(chunkIdx => {
            const start = chunkIdx * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, sendingFile.current!.file.size);
            const slice = sendingFile.current!.file.slice(start, end);
            
            slice.arrayBuffer().then(buffer => {
                const indexedChunk = new ArrayBuffer(buffer.byteLength + 4);
                const view = new DataView(indexedChunk);
                view.setUint32(0, chunkIdx, true);
                new Uint8Array(indexedChunk, 4).set(new Uint8Array(buffer));
                
                dataChannelRef.current?.send(indexedChunk);
                congestionControl.current.sentTimes.set(chunkIdx, Date.now());
            });
        });
        
        if (sendingFile.current && inFlight.size > 0) {
            retransmitTimerRef.current = window.setTimeout(retransmitLostChunks, 200);
        }
    }, []);


    const processNextFileInQueue = () => {
        const nextFile = sendQueue.find((f) => f.status === "pending");
        if (!nextFile || !dataChannelRef.current || !controlChannelRef.current) return;
    
        sendingFile.current = nextFile;
        
        slidingWindow.current = {
            windowSize: 32,
            maxWindowSize: 256,
            minWindowSize: 8,
            inFlight: new Set(),
            nextToSend: nextFile.lastSentChunk + 1,
            lastAcked: nextFile.lastSentChunk,
            ackBitmap: new Map()
        };
    
        setSendQueue((prev) =>
            prev.map((f) =>
                f.id === nextFile.id
                    ? { ...f, status: "sending", startTime: Date.now() }
                    : f
            )
        );
    
        const totalChunks = Math.ceil(nextFile.file.size / CHUNK_SIZE);
    
        if (nextFile.lastSentChunk === -1) {
            controlChannelRef.current.send(
                JSON.stringify({
                    type: "meta",
                    name: nextFile.file.name,
                    path: (nextFile.file as any).webkitRelativePath || undefined,
                    size: nextFile.file.size,
                    mimeType: nextFile.file.type,
                    totalChunks,
                })
            );
            
            for (let i = 0; i <= nextFile.lastSentChunk; i++) {
                slidingWindow.current.ackBitmap.set(i, true);
            }
        }
        
        if (retransmitTimerRef.current) {
            clearTimeout(retransmitTimerRef.current);
        }
        retransmitTimerRef.current = window.setTimeout(retransmitLostChunks, 200);
        
        sendChunkBatch();
    };


    const ensurePeer = useCallback(() => {
        if (pcRef.current) return;

        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

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
            if (event.channel.label === "control") {
                bindControlChannel(event.channel);
            } else if (event.channel.label === "data") {
                bindDataChannel(event.channel);
            }
        };

        const controlChannel = pc.createDataChannel("control", {
            ordered: true,
            maxRetransmits: 10
        });
        bindControlChannel(controlChannel);
        
        const dataChannel = pc.createDataChannel("data", {
            ordered: false,
            maxRetransmits: 2
        });
        bindDataChannel(dataChannel);


        pcRef.current = pc;
    }, [roomId, bindControlChannel, bindDataChannel]);

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

        const ws = new WebSocket(import.meta.env.VITE_SIGNALING_SERVER_URL);
        wsRef.current = ws;

        ws.onopen = () => {
            ws.send(JSON.stringify({ type: "join", roomId: newRoomId }));
        };

        ws.onmessage = async (event) => {
            const data = JSON.parse(event.data);

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
                    break;
                case "peer_left_room":
                    setConnected(false);
                    setConnectionType("disconnected");
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
    }, [roomId]);

    const pauseSending = useCallback((fileId: string) => {
        const file = sendQueue.find((f) => f.id === fileId);
        if (file && file.status === "sending") {
            setSendQueue((prev) =>
                prev.map((f) => (f.id === fileId ? { ...f, status: "paused" } : f))
            );
            if (retransmitTimerRef.current) {
                clearTimeout(retransmitTimerRef.current);
                retransmitTimerRef.current = null;
            }
            sendingFile.current = null;
        }
    }, [sendQueue]);

    const resumeSending = useCallback((fileId: string) => {
        const file = sendQueue.find((f) => f.id === fileId);
        if (file && file.status === "paused") {
            setSendQueue((prev) =>
                prev.map((f) => (f.id === fileId ? { ...f, status: "pending" } : f))
            );
            
            sendingFile.current = file;
            
            slidingWindow.current = {
                windowSize: 32,
                maxWindowSize: 256,
                minWindowSize: 8,
                inFlight: new Set(),
                nextToSend: file.lastSentChunk + 1,
                lastAcked: file.lastSentChunk,
                ackBitmap: new Map()
            };
            
            for (let i = 0; i <= file.lastSentChunk; i++) {
                slidingWindow.current.ackBitmap.set(i, true);
            }
            
            setSendQueue((prev) =>
                prev.map((f) =>
                    f.id === file.id
                        ? { ...f, status: "sending", startTime: Date.now() }
                        : f
                )
            );
            
            if (retransmitTimerRef.current) {
                clearTimeout(retransmitTimerRef.current);
            }
            retransmitTimerRef.current = window.setTimeout(retransmitLostChunks, 200);
            
            sendChunkBatch();
        }
    }, [sendQueue]);

    const removeFromQueue = useCallback(async (fileId: string) => {
        const file = sendQueue.find((f) => f.id === fileId);
        if (file) {
            if (file.status === "sending") {
              controlChannelRef.current?.send(JSON.stringify({ type: "cancel" }));
              if (retransmitTimerRef.current) {
                  clearTimeout(retransmitTimerRef.current);
                  retransmitTimerRef.current = null;
              }
              sendingFile.current = null;
            }

            await clearPartialSendState(roomId, file.file.name, file.file.size);
            setSendQueue((prev) => prev.filter((f) => f.id !== fileId));
        }
    }, [sendQueue, roomId]);

    const clearAllQueue = useCallback(async () => {
        if (sendingFile.current) {
            controlChannelRef.current?.send(JSON.stringify({ type: "cancel" }));
            if (retransmitTimerRef.current) {
                clearTimeout(retransmitTimerRef.current);
                retransmitTimerRef.current = null;
            }
            sendingFile.current = null;
        }

        for (const file of sendQueue) {
            await clearPartialSendState(roomId, file.file.name, file.file.size);
        }

        setSendQueue([]);
    }, [sendQueue, roomId]);

    const downloadFile = useCallback(async (file: FileMetadata) => {
        try {
            await streamFileToDownload(file.fileId);
        } catch (error) {
            console.error(error);
        }
    }, []);

    const clearRoom = useCallback(async () => {
        if (!roomId || !roomId.trim()) return;

        const confirmed = window.confirm(
            `Are you sure you want to clear all files from room "${roomId}"? This will permanently delete all stored files.`
        );

        if (confirmed) {
            try {
                await clearRoomDB(roomId);
                setReceivedFiles([]);
            } catch (error) {
                console.error(error);
            }
        }
    }, [roomId]);

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

    const sendChatMessage = useCallback((content: string) => {
        if (!content.trim() || !controlChannelRef.current) return;
        
        const msg: ChatMessage = {
            id: generateId(),
            senderId: username,
            senderName: username,
            content: content.trim(),
            timestamp: Date.now(),
            status: "sent"
        };
        
        setChatMessages(prev => [...prev, msg]);
        
        controlChannelRef.current.send(JSON.stringify({
            type: "chat",
            id: msg.id,
            senderId: username,
            senderName: username,
            content: msg.content,
            timestamp: msg.timestamp
        }));
    }, [username]);

    const markChatRead = useCallback(() => {
        setUnreadCount(0);
    }, []);

    const updateSettings = useCallback((newSettings: Partial<Settings>) => {
        setSettings(prev => {
            const updated = { ...prev, ...newSettings };
            saveSettings(updated);
            return updated;
        });
    }, []);

    const joinWithType = useCallback((newRoomId: string, newRoomType: RoomType = "persistent") => {
        setRoomType(newRoomType);
        peerLeftRef.current = false;
        join(newRoomId);
    }, [join]);

    useEffect(() => {
        if (isChatOpen) {
            markChatRead();
        }
    }, [isChatOpen, markChatRead]);

    return {
        roomId,
        roomType,
        connected,
        connectionType,
        sendQueue,
        receivedFiles,
        currentReceiving,
        chatMessages,
        unreadCount,
        settings,
        username,
        isChatOpen,
        isSettingsOpen,

        setRoomId,
        join: joinWithType,
        addFilesToQueue,
        pauseSending,
        resumeSending,
        removeFromQueue,
        clearAllQueue,
        downloadFile,
        clearRoom,
        openPreview,
        sendChatMessage,
        markChatRead,
        updateSettings,
        setIsChatOpen,
        setIsSettingsOpen,
        generateRoomId,
    };
}