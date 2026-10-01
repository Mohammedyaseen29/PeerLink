import type { FileMetadata } from "../ProgressDB";

// TypeScript fix for webkitdirectory
declare module "react" {
    interface InputHTMLAttributes<T> extends HTMLAttributes<T> {
        webkitdirectory?: string;
    }
}

export type QueuedFile = {
    file: File;
    id: string;
  recipientIds: string[];
  recipients: RecipientTransfer[];
    status: "pending" | "sending" | "sent" | "failed" | "paused";
    progress: number;
    lastSentChunk: number;
    startTime?: number;
    bytesTransferred?: number;
    totalChunks: number;
};

export type PeerMember = {
  peerId: string;
  username: string;
  avatar?: string;
  supportsReconnect?: boolean;
  connectionType: ConnectionType;
  status: "connecting" | "connected" | "disconnected";
};

export type RecipientTransfer = {
  peerId: string;
  peerName: string;
  status: "pending" | "sending" | "sent" | "failed" | "paused";
  progress: number;
  bytesTransferred: number;
  startTime?: number;
};

export type ConnectionType = "disconnected" | "local" | "p2p" | "relay";

export type TransferStats = {
    currentSpeed: number; // bytes per second
    estimatedTimeRemaining: number; // seconds
    bytesTransferred: number;
    totalBytes: number;
};

export type ReceivingFile = {
  fileId: string;
  peerId: string;
  peerName: string;
    name: string;
    progress: number;
    size: number;
    startTime: number;
    bytesReceived: number;
};

export type RoomType = "persistent" | "temporary";

export type ChatMessage = {
    id: string;
    senderId: string;
    senderName: string;
    content: string;
    timestamp: number;
    status: "sent" | "delivered" | "read";
  recipientStatuses?: Array<{ peerId: string; peerName: string; status: "sent" | "delivered" }>;
};

export type Settings = {
    autoDownload: boolean;
    avatar: string;
};

export type P2PState = {
    connected: boolean;
    connectionType: ConnectionType;
    roomId: string;
    roomType: RoomType;
    sendQueue: QueuedFile[];
    receivedFiles: FileMetadata[];
    currentReceiving: ReceivingFile | null;
    chatMessages: ChatMessage[];
    unreadCount: number;
    settings: Settings;
    username: string;
};

export type P2PActions = {
    join: (roomId: string, roomType?: RoomType) => void;
    setRoomId: (roomId: string) => void;
    addFilesToQueue: (files: File[]) => Promise<void>;
    pauseSending: (fileId: string) => void;
    resumeSending: (fileId: string) => void;
    removeFromQueue: (fileId: string) => Promise<void>;
    clearAllQueue: () => Promise<void>;
    downloadFile: (file: FileMetadata) => Promise<void>;
    clearRoom: () => Promise<void>;
    openPreview: (file: FileMetadata) => Promise<string>;
    sendChatMessage: (content: string) => void;
    markChatRead: () => void;
    updateSettings: (settings: Partial<Settings>) => void;
    setChatOpen: (open: boolean) => void;
    setSettingsOpen: (open: boolean) => void;
};
