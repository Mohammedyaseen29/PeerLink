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
    status: "pending" | "sending" | "sent" | "failed" | "paused";
    progress: number;
    lastSentChunk: number;
    startTime?: number;
    bytesTransferred?: number;
};

export type ConnectionType = "disconnected" | "local" | "p2p" | "relay";

export type TransferStats = {
    currentSpeed: number; // bytes per second
    estimatedTimeRemaining: number; // seconds
    bytesTransferred: number;
    totalBytes: number;
};

export type ReceivingFile = {
    name: string;
    progress: number;
    size: number;
    startTime: number;
    bytesReceived: number;
};

export type P2PState = {
    connected: boolean;
    connectionType: ConnectionType;
    roomId: string;
    sendQueue: QueuedFile[];
    receivedFiles: FileMetadata[];
    currentReceiving: ReceivingFile | null;
    logs: string[];
};

export type P2PActions = {
    join: (roomId: string) => void;
    setRoomId: (roomId: string) => void;
    addFilesToQueue: (files: File[]) => Promise<void>;
    pauseSending: (fileId: string) => void;
    resumeSending: (fileId: string) => void;
    removeFromQueue: (fileId: string) => Promise<void>;
    clearAllQueue: () => Promise<void>;
    downloadFile: (file: FileMetadata) => Promise<void>;
    clearRoom: () => Promise<void>;
    openPreview: (file: FileMetadata) => Promise<string>;
};
