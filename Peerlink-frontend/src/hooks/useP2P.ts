import { useCallback, useEffect, useRef, useState } from 'react';
import { clearRoom as clearRoomDB, clearTemporaryFiles, deleteFile as deleteStoredFile, getFilesInRoom, getUpdatePreviewUrl, readFileRange, streamFileToDownload, type FileMetadata } from '../ProgressDB';
import { CHUNK_SIZE, TransferEngine } from '../transfer/TransferEngine';
import type { QueuedFile, ConnectionType, ReceivingFile, ChatMessage, Settings, RoomType, PeerMember, SignalingStatus } from '../types';
import { generateId, getFileMimeType } from '../utils/helpers';
import { getRandomAvatar } from '../components/avatars';
import { createRemotePreviewUrl, MAX_PREVIEW_RANGE_BYTES, RangeBroker, type PreviewRangeRequest, type PreviewRangeResponse, waitForPreviewServiceWorker } from '../preview/RangeBroker';
import { getRecentDiagnostics, recordTransferDiagnostic } from '../transferDiagnostics';

export { getRecentDiagnostics } from '../transferDiagnostics';

const STORAGE_KEY = 'peerlink_settings';
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443?transport=udp',
        'turn:openrelay.metered.ca:443?transport=tcp',
    ], username: 'openrelayproject', credential: 'openrelayproject' },
];
function safeIceServers(): RTCIceServer[] {
    const raw = (import.meta.env as Record<string, unknown>).VITE_ICE_SERVERS;
    if (typeof raw !== 'string' || !raw.trim()) return DEFAULT_ICE_SERVERS;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length > 8) throw new Error('Expected an array with at most eight ICE servers.');
        const servers: RTCIceServer[] = parsed.map((value, index) => {
            if (!value || typeof value !== 'object') throw new Error(`ICE server ${index + 1} is invalid.`);
            const candidate = value as Record<string, unknown>;
            const urls = typeof candidate.urls === 'string' ? [candidate.urls] : candidate.urls;
            if (!Array.isArray(urls) || urls.length < 1 || urls.length > 8 || urls.some(url => typeof url !== 'string' ||
                url.length > 512 || !/^(stun|stuns|turn|turns):/i.test(url))) throw new Error(`ICE server ${index + 1} has invalid URLs.`);
            if (candidate.username !== undefined && (typeof candidate.username !== 'string' || candidate.username.length > 512)) {
                throw new Error(`ICE server ${index + 1} has an invalid username.`);
            }
            if (candidate.credential !== undefined && (typeof candidate.credential !== 'string' || candidate.credential.length > 2048)) {
                throw new Error(`ICE server ${index + 1} has an invalid credential.`);
            }
            return { urls: urls as string[], ...(typeof candidate.username === 'string' ? { username: candidate.username } : {}),
                ...(typeof candidate.credential === 'string' ? { credential: candidate.credential } : {}) };
        });
        if (!servers.length) throw new Error('At least one ICE server is required.');
        return servers;
    } catch {
        recordTransferDiagnostic('ice_server_override', 'invalid_override_fallback');
        return DEFAULT_ICE_SERVERS;
    }
}
const ICE_SERVERS = safeIceServers();
const CATALOG_FILES_PER_MESSAGE = 16;
const MAX_CATALOG_FILES = 10_000;
const MAX_CATALOG_MESSAGES = 10_000;
const MAX_CONTROL_MESSAGE_BYTES = 16 * 1024;
const CONTROL_BUFFER_HIGH_WATER = 256 * 1024;
const MAX_AUTO_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const MAX_PENDING_AUTO_DOWNLOADS = 10;
const ICE_DISCONNECT_GRACE_MS = 10_000;
const MAX_PENDING_ICE_CANDIDATES = 256;
const MAX_PREVIEW_REQUESTS = 8;
const PREVIEW_REQUEST_TIMEOUT_MS = 22_000;
const PREVIEW_BUFFER_HIGH_WATER = 512 * 1024;
const SIGNALING_HEARTBEAT_INTERVAL_MS = 25_000;

/** Keep the signaling handle stable while native sockets reconnect. RTC sessions
 * capture this handle, so directory recovery never replaces a healthy transport. */
class RoomSignalingSocket {
    onopen: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    private socket: WebSocket | null = null;
    private timer: number | undefined;
    private watchdog: number | undefined;
    private stopped = false;
    private joined = false;
    private attempts = 0;
    private lastMessage = Date.now();
    private url: string;
    private recovering: () => void;
    constructor(url: string, recovering: () => void) { this.url = url; this.recovering = recovering; this.connect(); }
    get readyState() { return this.socket?.readyState ?? (this.stopped ? WebSocket.CLOSED : WebSocket.CONNECTING); }
    send(message: string) {
        if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('The signaling connection is closed.');
        this.socket.send(message);
    }
    private detach() {
        const socket = this.socket; this.socket = null;
        if (!socket) return;
        socket.onopen = null; socket.onclose = null; socket.onerror = null; socket.onmessage = null;
        try { socket.close(); } catch { /* Already closed. */ }
    }
    private clearTimer() { if (this.timer !== undefined) window.clearTimeout(this.timer); this.timer = undefined; }
    private connect() {
        if (this.stopped) return;
        this.clearTimer();
        let socket: WebSocket;
        try { socket = new WebSocket(this.url); } catch { this.retry(); return; }
        this.socket = socket;
        this.timer = window.setTimeout(() => this.retry(), 15_000);
        socket.onopen = event => { if (this.socket === socket && !this.stopped) this.onopen?.(event); };
        socket.onmessage = event => {
            if (this.socket !== socket || this.stopped) return;
            this.lastMessage = Date.now();
            try {
                if (JSON.parse(event.data).type === 'joined') {
                    this.joined = true; this.attempts = 0; this.clearTimer();
                    if (this.watchdog === undefined) this.watchdog = window.setInterval(() => {
                        if (this.socket?.readyState === WebSocket.OPEN && Date.now() - this.lastMessage > 75_000) this.retry();
                    }, 25_000);
                }
            } catch { /* The room handler validates messages. */ }
            this.onmessage?.(event);
        };
        socket.onerror = () => { if (this.socket === socket && !this.stopped) this.retry(); };
        socket.onclose = event => {
            if (this.socket !== socket || this.stopped) return;
            if ([4000, 4001, 4002, 4003].includes(event.code)) { this.close(); this.onclose?.(event); }
            else this.retry();
        };
    }
    private retry() {
        if (this.stopped) return;
        this.clearTimer(); this.detach();
        if (!this.joined && this.attempts >= 3) {
            this.close(); this.onerror?.(new Event('error')); return;
        }
        this.recovering();
        const delay = [1_000, 2_000, 4_000, 8_000, 15_000][Math.min(this.attempts++, 4)];
        this.timer = window.setTimeout(() => this.connect(), delay);
    }
    wake() {
        if (this.stopped) return;
        if (this.socket?.readyState !== WebSocket.OPEN || Date.now() - this.lastMessage > 75_000) {
            this.clearTimer(); this.detach(); this.connect();
        }
    }
    close() {
        this.stopped = true; this.clearTimer();
        if (this.watchdog !== undefined) window.clearInterval(this.watchdog);
        this.watchdog = undefined; this.detach();
    }
}
const RECONNECT_DELAYS_MS = [1_000, 5_000, 15_000] as const;
const NEGOTIATION_TIMEOUT_MS = 45_000;
const previewFrameEncoder = new TextEncoder();
const previewFrameDecoder = new TextDecoder();
const MIME_TYPE_PATTERN = /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+(?:\s*;\s*[\w!#$&^_.+-]+=(?:"[^"\r\n]*"|[\w!#$&^_.+-]+))*$/;

type SharedSource = { metadata: FileMetadata; file?: File; databaseFileId?: string };
type CatalogSnapshot = { revision: number; chunkCount: number; chunks: Map<number, FileMetadata[]> };
type PreviewFrameHeader = {
    type: 'preview_range_chunk';
    requestId: string;
    fileId: string;
    start: number;
    end: number;
    sequence: number;
    total: number;
    offset: number;
    size: number;
    mimeType: string;
    length: number;
};
type PendingRemoteRange = {
    request: PreviewRangeRequest;
    metadata: FileMetadata;
    peerId: string;
    remoteFileId: string;
    generation: string;
    resolve: (response: PreviewRangeResponse) => void;
    reject: (error: Error) => void;
    timer: number;
    signal: AbortSignal;
    abort: () => void;
    output?: Uint8Array<ArrayBuffer>;
    size?: number;
    mimeType?: string;
    length?: number;
    total?: number;
    sequence: number;
    received: number;
};

type PeerSession = {
    peerId: string;
    username: string;
    avatar?: string;
    generation: string;
    linkId?: string;
    supportsReconnect: boolean;
    pc: RTCPeerConnection | null;
    engine: TransferEngine | null;
    control: RTCDataChannel | null;
    data: RTCDataChannel | null;
    preview: RTCDataChannel | null;
    candidates: RTCIceCandidateInit[];
    remoteCandidateChain: Promise<void>;
    pendingRemoteCandidateCount: number;
    status: PeerMember['status'];
    connectionType: ConnectionType;
    initialNegotiationTimer?: number;
    iceDisconnectTimer?: number;
    outgoingCatalogRevision: number;
    catalogSendChain: Promise<void>;
    incomingCatalogRevision: number;
    incomingCatalog: CatalogSnapshot | null;
    sharedSources: Map<string, SharedSource>;
    lastCatalogFingerprint: string;
    aliasesByRemoteId: Map<string, string>;
    remoteFilesByAlias: Map<string, FileMetadata>;
    pendingHostRanges: Map<string, AbortController>;
    previewSendChain: Promise<void>;
    receiveClock: { id: string; start: number; update: number };
    dispose?: (retry?: boolean) => void;
};

function sendControlMessage(session: PeerSession, value: object): void {
    const channel = session.control;
    if (!channel || channel.readyState !== 'open') throw new Error('The peer control channel is closed.');
    channel.send(encodeControlMessage(session.pc, value));
}

function safeMimeType(value: string): string {
    if (value.length > 255 || !MIME_TYPE_PATTERN.test(value)) return 'application/octet-stream';
    const essence = value.split(';', 1)[0].trim().toLowerCase();
    return essence === 'text/html' || essence === 'application/xhtml+xml' ? 'text/plain' : value;
}

function controlMessageLimit(peer: RTCPeerConnection | null | undefined): number {
    const negotiated = peer?.sctp?.maxMessageSize;
    return typeof negotiated === 'number' && negotiated > 0
        ? Math.min(MAX_CONTROL_MESSAGE_BYTES, negotiated)
        : MAX_CONTROL_MESSAGE_BYTES;
}

function encodeControlMessage(peer: RTCPeerConnection | null | undefined, value: object): string {
    const text = JSON.stringify(value);
    if (previewFrameEncoder.encode(text).byteLength > controlMessageLimit(peer)) {
        throw new Error('This control message is too large for the current connection.');
    }
    return text;
}

function iceServerHostnames(servers: RTCIceServer[]): string[] {
    return [...new Set(servers.flatMap(server => {
        const urls = typeof server.urls === 'string' ? [server.urls] : server.urls || [];
        return urls.flatMap(url => {
            const match = /^(?:stun|stuns|turn|turns):(?:\/\/)?(?:[^@/]*@)?(\[[^\]]+\]|[^:/?]+)/i.exec(url);
            return match ? [match[1].slice(0, 255)] : [];
        });
    }))].slice(0, 16);
}

function safeCatalogEntry(value: unknown): FileMetadata | null {
    if (!value || typeof value !== 'object') return null;
    const file = value as Record<string, unknown>;
    if (typeof file.fileId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(file.fileId) ||
        typeof file.name !== 'string' || !file.name || file.name.length > 255 ||
        typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size < 0 ||
        typeof file.mimeType !== 'string' || file.mimeType.length > 255 ||
        typeof file.totalChunks !== 'number' || !Number.isSafeInteger(file.totalChunks) || file.totalChunks < 0 ||
        typeof file.receivedChunks !== 'number' || file.receivedChunks !== file.totalChunks || file.status !== 'complete' ||
        typeof file.createdAt !== 'number' || !Number.isSafeInteger(file.createdAt) ||
        (file.chunkSize !== undefined && (typeof file.chunkSize !== 'number' || !Number.isSafeInteger(file.chunkSize) || file.chunkSize < 1)) ||
        (file.path !== undefined && (typeof file.path !== 'string' || file.path.length > 512))) return null;
    if (typeof file.chunkSize === 'number' && file.totalChunks !== Math.ceil(file.size / file.chunkSize)) return null;
    if ((file.size === 0) !== (file.totalChunks === 0)) return null;
    return {
        fileId: file.fileId,
        roomId: '',
        name: file.name,
        path: typeof file.path === 'string' ? file.path : undefined,
        size: file.size,
        mimeType: safeMimeType(file.mimeType),
        totalChunks: file.totalChunks,
        chunkSize: typeof file.chunkSize === 'number' ? file.chunkSize : undefined,
        receivedChunks: file.receivedChunks,
        status: 'complete',
        createdAt: file.createdAt,
    };
}

function encodePreviewFrame(header: PreviewFrameHeader, payload: Uint8Array): ArrayBuffer {
    const json = previewFrameEncoder.encode(JSON.stringify(header));
    const frame = new Uint8Array(4 + json.byteLength + payload.byteLength);
    new DataView(frame.buffer).setUint32(0, json.byteLength, false);
    frame.set(json, 4);
    frame.set(payload, 4 + json.byteLength);
    return frame.buffer;
}

function decodePreviewFrame(value: unknown): { header: PreviewFrameHeader; payload: Uint8Array } | null {
    if (!(value instanceof ArrayBuffer) || value.byteLength < 5 || value.byteLength > 256 * 1024 + 2048) return null;
    const bytes = new Uint8Array(value);
    const headerLength = new DataView(value).getUint32(0, false);
    if (headerLength < 2 || headerLength > 2048 || 4 + headerLength > bytes.byteLength) return null;
    let header: unknown;
    try { header = JSON.parse(previewFrameDecoder.decode(bytes.subarray(4, 4 + headerLength))); } catch { return null; }
    if (!header || typeof header !== 'object') return null;
    const candidate = header as Record<string, unknown>;
    if (candidate.type !== 'preview_range_chunk' || typeof candidate.requestId !== 'string' ||
        typeof candidate.fileId !== 'string' || !Number.isSafeInteger(candidate.start) ||
        !Number.isSafeInteger(candidate.end) || !Number.isSafeInteger(candidate.sequence) ||
        !Number.isSafeInteger(candidate.total) || !Number.isSafeInteger(candidate.offset) ||
        !Number.isSafeInteger(candidate.size) || typeof candidate.mimeType !== 'string' ||
        !Number.isSafeInteger(candidate.length)) return null;
    return { header: candidate as PreviewFrameHeader, payload: bytes.subarray(4 + headerLength) };
}

function isValidRangeEnvelope(requestId: unknown, fileId: unknown, start: unknown, end: unknown): requestId is string {
    return typeof requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(requestId) &&
        typeof fileId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(fileId) &&
        typeof start === 'number' && Number.isSafeInteger(start) && start >= 0 &&
        typeof end === 'number' && Number.isSafeInteger(end) && end >= start && end - start + 1 <= MAX_PREVIEW_RANGE_BYTES;
}

function waitForDataChannel(channel: RTCDataChannel, signal: AbortSignal, timeoutMs: number): Promise<void> {
    if (channel.readyState === 'open') return Promise.resolve();
    if (channel.readyState !== 'connecting') return Promise.reject(new Error('Preview channel is closed.'));
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            window.clearTimeout(timer);
            channel.removeEventListener('open', onOpen);
            channel.removeEventListener('close', onClose);
            signal.removeEventListener('abort', onAbort);
        };
        const onOpen = () => { cleanup(); resolve(); };
        const onClose = () => { cleanup(); reject(new Error('Preview channel closed.')); };
        const onAbort = () => { cleanup(); reject(new DOMException('Preview request aborted', 'AbortError')); };
        const timer = window.setTimeout(() => { cleanup(); reject(new Error('Preview channel did not open in time.')); }, timeoutMs);
        channel.addEventListener('open', onOpen, { once: true });
        channel.addEventListener('close', onClose, { once: true });
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
    });
}
function loadSettings(): Settings {
    try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        if (parsed) return { ...parsed, avatar: parsed.avatar || getRandomAvatar().id };
    } catch { /* Use defaults when storage is unavailable. */ }
    return { autoDownload: false, avatar: getRandomAvatar().id };
}
const ADJECTIVES = ['Swift', 'Cosmic', 'Neon', 'Shadow', 'Crystal', 'Thunder', 'Frost', 'Blaze', 'Lunar', 'Storm', 'Echo', 'Phoenix', 'Nova', 'Vortex', 'Pixel', 'Cyber', 'Quantum', 'Hyper', 'Ultra', 'Mega'];
const NOUNS = ['Spidy', 'Foxy', 'Rexy', 'Wolf', 'Tiger', 'Eagle', 'Hawk', 'Fox', 'Bear', 'Lynx', 'Owl', 'Raven', 'Falcon', 'Dragon', 'Leopard', 'Panther', 'Lion'];
function randomWord(words: string[]) { return words[Math.floor(Math.random() * words.length)]; }
function generateRoomId() { return `peer-${crypto.randomUUID()}`; }
function validUsername(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const name = value.trim();
    return name.length >= 1 && name.length <= 64 && !/[\u0000-\u001f\u007f-\u009f]/.test(name) ? name : null;
}
function getUsername(saved: unknown) {
    return validUsername(saved) || `${randomWord(ADJECTIVES)}${randomWord(NOUNS)}`;
}
function loadProfile() {
    const settings = loadSettings();
    const username = getUsername(settings.username);
    return { username, settings: { ...settings, username } };
}

export function useP2P() {
    const [roomId, setRoomId] = useState('');
    const [roomType, setRoomType] = useState<RoomType>('persistent');
    const [connected, setConnected] = useState(false);
    const [connectionType, setConnectionType] = useState<ConnectionType>('disconnected');
    const [selfPeerId, setSelfPeerId] = useState('');
    const [members, setMembers] = useState<PeerMember[]>([]);
    const [selectedPeerIds, setSelectedPeerIdsState] = useState<string[]>([]);
    const [currentReceivings, setCurrentReceivingsState] = useState<ReceivingFile[]>([]);
    const [inRoom, setInRoom] = useState(false);
    const [hasPeer, setHasPeer] = useState(false);
    const [signalingStatus, setSignalingStatus] = useState<SignalingStatus>('idle');
    const [connectionFormKey, setConnectionFormKey] = useState(0);
    const [sendQueue, setSendQueue] = useState<QueuedFile[]>([]);
    const [receivedFiles, setReceivedFiles] = useState<FileMetadata[]>([]);
    const [onlineFiles, setOnlineFiles] = useState<FileMetadata[]>([]);
    const [currentReceiving, setCurrentReceiving] = useState<ReceivingFile | null>(null);
    const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const [initialProfile] = useState(loadProfile);
    const [settings, setSettings] = useState<Settings>(initialProfile.settings);
    const [username, setUsername] = useState(initialProfile.username);
    const [isChatOpen, setIsChatOpen] = useState(false);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [toast, setToast] = useState<{ message: string; kind: 'success' | 'error' | 'info' } | null>(null);
    const queue = useRef<QueuedFile[]>([]);
    const currentReceivingsRef = useRef<ReceivingFile[]>([]);
    // A room owns one signaling socket and one independent session per remote peer.
    const sessions = useRef(new Map<string, PeerSession>());
    const roomMembers = useRef(new Map<string, PeerMember>());
    const selfPeerIdRef = useRef('');
    const selectedPeerIdsRef = useRef<string[]>([]);
    const activeRecipientTransfers = useRef(new Set<string>());
    const transferEngines = useRef(new Set<TransferEngine>());
    const aggregateMetrics = useRef({ peakBufferedBytes: 0, peakReceiveBytes: 0, receivedBytes: 0, sentBytes: 0,
        activeWorkers: 0, workerStarts: 0, pendingReads: 0, disposed: true, readAwaitMs: 0, readyWaitMs: 0,
        channelWaitMs: 0, creditWaitMs: 0, pausedWaitMs: 0, hashMs: 0, storageMs: 0, storedBatches: 0, storedChunks: 0,
        bufferedLowEvents: 0, eventWaitWakes: 0, fallbackWaitWakes: 0, channelWaits: 0, channelFallbackWakes: 0,
        bufferedLowWakeCount: 0, bufferedLowWakeBytes: 0, bufferedLowWakeEmptyCount: 0,
        creditWaits: 0, creditFallbackWakes: 0, receiveTimerFlushes: 0, receiveTimerFlushedChunks: 0,
        sendOperationErrors: 0, sendRetryWaitMs: 0 });
    const syncAggregateMetrics = () => {
        const values = [...transferEngines.current].map(transport => transport.metrics);
        const maxKeys = ['peakBufferedBytes', 'peakReceiveBytes'] as const;
        const sumKeys = ['receivedBytes', 'sentBytes', 'activeWorkers', 'workerStarts', 'pendingReads', 'readAwaitMs', 'readyWaitMs',
            'channelWaitMs', 'creditWaitMs', 'pausedWaitMs', 'hashMs', 'storageMs', 'storedBatches', 'storedChunks',
            'bufferedLowEvents', 'eventWaitWakes', 'fallbackWaitWakes', 'channelWaits', 'channelFallbackWakes', 'creditWaits', 'creditFallbackWakes',
            'bufferedLowWakeCount', 'bufferedLowWakeBytes', 'bufferedLowWakeEmptyCount',
            'receiveTimerFlushes', 'receiveTimerFlushedChunks', 'sendOperationErrors', 'sendRetryWaitMs'] as const;
        for (const key of maxKeys) aggregateMetrics.current[key] = values.reduce((max, value) => Math.max(max, value[key]), 0);
        for (const key of sumKeys) aggregateMetrics.current[key] = values.reduce((sum, value) => sum + value[key], 0);
        aggregateMetrics.current.disposed = values.every(value => value.disposed);
        return aggregateMetrics.current;
    };
    const ws = useRef<RoomSignalingSocket | null>(null);
    const clearSignalingMonitor = useRef<() => void>(() => undefined);
    const retryPeerRef = useRef<(peerId: string) => void>(() => undefined);
    const currentRoom = useRef('');
    const roomJoinGeneration = useRef(0);
    const temporary = useRef(false);
    const live = useRef(true);
    const identityRef = useRef(username);
    const chatOpen = useRef(false);
    const seenChatMessages = useRef(new Set<string>());
    const options = useRef(settings);
    const toastTimer = useRef<number | undefined>(undefined);
    const autoDownloadQueue = useRef<string[]>([]);
    const autoDownloadQueued = useRef(new Set<string>());
    const autoDownloadActive = useRef(false);
    const receivedFilesRef = useRef<FileMetadata[]>([]);
    const onlineFilesRef = useRef<FileMetadata[]>([]);
    const publishCatalogRef = useRef<() => void>(() => undefined);
    const pendingRemoteRanges = useRef(new Map<string, PendingRemoteRange>());
    const previewBroker = useRef<RangeBroker | null>(null);
    options.current = settings;
    identityRef.current = username;
    chatOpen.current = isChatOpen;

    const updateCurrentReceivings = (update: (files: ReceivingFile[]) => ReceivingFile[]) => {
        currentReceivingsRef.current = update(currentReceivingsRef.current);
        if (live.current) setCurrentReceivingsState(currentReceivingsRef.current);
    };

    // React may defer/replay updater callbacks. Keep protocol state outside them.
    const changeQueue = useCallback((update: (files: QueuedFile[]) => QueuedFile[], publishCatalog = false) => {
        queue.current = update(queue.current);
        if (live.current) setSendQueue(queue.current);
        if (publishCatalog) publishCatalogRef.current();
    }, []);
    const replaceReceivedFiles = useCallback((files: FileMetadata[]) => {
        receivedFilesRef.current = files.filter(file => file.status === 'complete' && file.mimeType !== 'send_state');
        if (live.current) setReceivedFiles(receivedFilesRef.current);
        publishCatalogRef.current();
    }, []);
    const replaceOnlineFiles = useCallback((files: FileMetadata[]) => {
        onlineFilesRef.current = files;
        if (live.current) setOnlineFiles(files);
    }, []);
    const showToast = useCallback((message: string, kind: 'success' | 'error' | 'info' = 'error') => {
        if (!live.current) return;
        clearTimeout(toastTimer.current);
        setToast({ message, kind });
        toastTimer.current = window.setTimeout(() => setToast(null), 4500);
    }, []);
    const queueAutomaticDownload = useCallback((metadata: FileMetadata) => {
        if (metadata.size > MAX_AUTO_DOWNLOAD_BYTES) {
            showToast(`“${metadata.name}” is ready. Download large files from Received files.`, 'info');
            return;
        }
        if (autoDownloadQueued.current.has(metadata.fileId)) return;
        if (autoDownloadQueue.current.length + Number(autoDownloadActive.current) >= MAX_PENDING_AUTO_DOWNLOADS) {
            showToast('Automatic downloads are backed up. Download this file from Received files.', 'info');
            return;
        }
        autoDownloadQueued.current.add(metadata.fileId);
        autoDownloadQueue.current.push(metadata.fileId);
        if (autoDownloadActive.current) return;
        autoDownloadActive.current = true;
        void (async () => {
            while (live.current && autoDownloadQueue.current.length) {
                const fileId = autoDownloadQueue.current.shift()!;
                try {
                    await streamFileToDownload(fileId, undefined, { picker: false });
                } catch (error) {
                    if (!(error instanceof DOMException && error.name === 'AbortError')) {
                        showToast('Automatic download could not start. Use Download in Received files.', 'info');
                    }
                } finally {
                    autoDownloadQueued.current.delete(fileId);
                }
                if (live.current && autoDownloadQueue.current.length) await new Promise(resolve => window.setTimeout(resolve, 1200));
            }
            autoDownloadActive.current = false;
        })();
    }, [showToast]);

    const setSelectedPeerIds = useCallback((next: string[] | ((current: string[]) => string[])) => {
        const value = typeof next === 'function' ? next(selectedPeerIdsRef.current) : next;
        selectedPeerIdsRef.current = value;
        if (live.current) setSelectedPeerIdsState(value);
    }, []);

    const settleRemoteRange = useCallback((requestId: string, response: PreviewRangeResponse | null, error: Error | null, notifyPeer: boolean) => {
        const pending = pendingRemoteRanges.current.get(requestId);
        if (!pending) return;
        pendingRemoteRanges.current.delete(requestId);
        window.clearTimeout(pending.timer);
        pending.signal.removeEventListener('abort', pending.abort);
        const session = sessions.current.get(pending.peerId);
        if (notifyPeer && session?.control?.readyState === 'open') {
            try { sendControlMessage(session, { type: 'preview_range_cancel', requestId }); } catch { /* The peer is already leaving. */ }
        }
        if (error) pending.reject(error);
        else if (response) pending.resolve(response);
        else pending.reject(new Error('The peer returned an empty preview response.'));
    }, []);

    const requestRemoteRange = useCallback((request: PreviewRangeRequest, signal: AbortSignal): Promise<PreviewRangeResponse> => {
        const metadata = onlineFilesRef.current.find(file => file.fileId === request.fileId);
        if (!metadata) return Promise.reject(new Error('This file is no longer shared by the peer.'));
        if (!isValidRangeEnvelope(request.requestId, request.fileId, request.start, request.end)) {
            return Promise.reject(new Error('Invalid preview range request.'));
        }
        if (signal.aborted) return Promise.reject(new DOMException('Preview request aborted', 'AbortError'));
        if (pendingRemoteRanges.current.size >= MAX_PREVIEW_REQUESTS || pendingRemoteRanges.current.has(request.requestId)) {
            return Promise.reject(new Error('Too many preview ranges are already in progress.'));
        }
        const peerId = metadata.sourcePeerId || '';
        const session = sessions.current.get(peerId);
        const commands = session?.control;
        if (!session) return Promise.reject(new Error('The peer is disconnected.'));
        if (commands?.readyState !== 'open') return Promise.reject(new Error('The peer is disconnected.'));
        const remoteFileId = metadata.remoteFileId || metadata.fileId;

        return new Promise((resolve, reject) => {
            const abort = () => settleRemoteRange(request.requestId, null, new DOMException('Preview request aborted', 'AbortError'), true);
            const pending: PendingRemoteRange = {
                request, metadata, peerId, remoteFileId, generation: session.generation, resolve, reject, signal, abort, sequence: 0, received: 0,
                timer: window.setTimeout(() => settleRemoteRange(request.requestId, null, new Error('Peer preview request timed out.'), true), PREVIEW_REQUEST_TIMEOUT_MS),
            };
            pendingRemoteRanges.current.set(request.requestId, pending);
            signal.addEventListener('abort', abort, { once: true });
            const preview = session.preview;
            if (!preview) {
                settleRemoteRange(request.requestId, null, new Error('Peer preview channel is unavailable.'), false);
                return;
            }
            void waitForDataChannel(preview, signal, 5_000).then(() => {
                if (!pendingRemoteRanges.current.has(request.requestId)) return;
                if (session.control?.readyState !== 'open' || sessions.current.get(peerId) !== session) throw new Error('The peer is disconnected.');
                sendControlMessage(session, { type: 'preview_range_request', ...request, fileId: remoteFileId });
            }).catch(error => {
                settleRemoteRange(request.requestId, null, error instanceof Error ? error : new Error(String(error)), false);
            });
        });
    }, [settleRemoteRange]);

    const onPreviewData = useCallback((event: MessageEvent, sourceSession: PeerSession) => {
        const decoded = decodePreviewFrame(event.data);
        if (!decoded) return;
        const { header, payload } = decoded;
        const pending = pendingRemoteRanges.current.get(header.requestId);
        if (!pending) return;
        if (pending.peerId !== sourceSession.peerId || pending.generation !== sourceSession.generation) return;
        const fail = (message: string) => settleRemoteRange(header.requestId, null, new Error(message), true);
        const expectedLength = header.start >= pending.metadata.size
            ? 0
            : Math.min(header.end, pending.metadata.size - 1) - header.start + 1;
        if (header.fileId !== pending.remoteFileId || header.start !== pending.request.start || header.end !== pending.request.end ||
            header.size !== pending.metadata.size || header.mimeType !== safeMimeType(pending.metadata.mimeType) ||
            header.length !== expectedLength || header.length < 0 || header.length > MAX_PREVIEW_RANGE_BYTES ||
            header.total < 1 || header.total > 128 || header.sequence !== pending.sequence ||
            header.offset !== pending.request.start + pending.received || header.sequence >= header.total ||
            (header.length === 0 ? (header.total !== 1 || payload.byteLength !== 0) : payload.byteLength === 0) ||
            pending.received + payload.byteLength > header.length) {
            fail('Peer returned an invalid preview range frame.');
            return;
        }
        if (pending.total !== undefined && (pending.total !== header.total || pending.length !== header.length ||
            pending.size !== header.size || pending.mimeType !== header.mimeType)) {
            fail('Peer changed preview range metadata during transfer.');
            return;
        }
        if (!pending.output) {
            pending.output = new Uint8Array(header.length);
            pending.size = header.size;
            pending.mimeType = header.mimeType;
            pending.length = header.length;
            pending.total = header.total;
        }
        pending.output.set(payload, pending.received);
        pending.received += payload.byteLength;
        pending.sequence++;
        if (pending.sequence === header.total) {
            if (pending.received !== header.length) {
                fail('Peer returned an incomplete preview range.');
                return;
            }
            settleRemoteRange(header.requestId, { size: header.size, mimeType: header.mimeType, data: pending.output.buffer }, null, false);
        } else if (pending.received >= header.length) {
            fail('Peer returned too many preview range bytes.');
        }
    }, [settleRemoteRange]);

    const sendPreviewFrames = useCallback(async (
        request: PreviewRangeRequest,
        metadata: FileMetadata,
        dataBytes: ArrayBuffer,
        signal: AbortSignal,
        session: PeerSession,
    ) => {
        const channel = session.preview;
        if (!channel || channel.readyState !== 'open') throw new Error('Peer preview channel is closed.');
        const negotiatedMax = session.pc?.sctp?.maxMessageSize;
        const maxMessageBytes = Math.min(256 * 1024, Number.isSafeInteger(negotiatedMax) && negotiatedMax! > 0 ? negotiatedMax! : 64 * 1024);
        const payloadLimit = maxMessageBytes - 1024;
        if (payloadLimit < 1) throw new Error('Peer preview channel has an unsupported message limit.');
        const data = new Uint8Array(dataBytes);
        const total = Math.max(1, Math.ceil(data.byteLength / payloadLimit));
        const mimeType = safeMimeType(metadata.mimeType);
        for (let sequence = 0; sequence < total; sequence++) {
            if (signal.aborted) throw new DOMException('Preview request cancelled', 'AbortError');
            if (channel.readyState !== 'open') throw new Error('Peer preview channel closed during transfer.');
            const offsetInData = sequence * payloadLimit;
            const payload = data.subarray(offsetInData, Math.min(data.byteLength, offsetInData + payloadLimit));
            const header: PreviewFrameHeader = {
                type: 'preview_range_chunk', requestId: request.requestId, fileId: request.fileId,
                start: request.start, end: request.end, sequence, total,
                offset: request.start + offsetInData, size: metadata.size, mimeType, length: data.byteLength,
            };
            const frame = encodePreviewFrame(header, payload);
            if (frame.byteLength > maxMessageBytes) throw new Error('Preview frame exceeds the negotiated channel limit.');
            while (channel.bufferedAmount > PREVIEW_BUFFER_HIGH_WATER) {
                if (signal.aborted) throw new DOMException('Preview request cancelled', 'AbortError');
                if (channel.readyState !== 'open') throw new Error('Peer preview channel closed during transfer.');
                await new Promise<void>((resolve, reject) => {
                    const timer = window.setTimeout(() => { cleanup(); reject(new Error('Peer preview channel is backpressured.')); }, 10_000);
                    const cleanup = () => { window.clearTimeout(timer); channel.removeEventListener('bufferedamountlow', onLow); signal.removeEventListener('abort', onAbort); };
                    const onLow = () => { cleanup(); resolve(); };
                    const onAbort = () => { cleanup(); reject(new DOMException('Preview request cancelled', 'AbortError')); };
                    channel.addEventListener('bufferedamountlow', onLow, { once: true });
                    signal.addEventListener('abort', onAbort, { once: true });
                    if (signal.aborted) onAbort();
                    else if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) onLow();
                });
            }
            channel.send(frame);
        }
    }, []);

    const handleSessionPreviewRangeRequest = useCallback(async (session: PeerSession, message: Record<string, unknown>) => {
        const { requestId, fileId, start, end } = message;
        const commands = session.control;
        if (!isValidRangeEnvelope(requestId, fileId, start, end) || !commands || commands.readyState !== 'open') return;
        const key = requestId as string;
        if (session.pendingHostRanges.has(key) || session.pendingHostRanges.size >= MAX_PREVIEW_REQUESTS) {
            sendControlMessage(session, { type: 'preview_range_error', requestId: key, message: 'Too many preview requests.' }); return;
        }
        const source = session.sharedSources.get(fileId as string);
        if (!source) { sendControlMessage(session, { type: 'preview_range_error', requestId: key, message: 'This file is no longer shared.' }); return; }
        const controller = new AbortController(); session.pendingHostRanges.set(key, controller);
        try {
            const actualEnd = Math.min(end as number, source.metadata.size - 1);
            const bytes = start as number >= source.metadata.size ? new ArrayBuffer(0) : source.file
                ? await source.file.slice(start as number, actualEnd + 1).arrayBuffer()
                : await readFileRange(source.databaseFileId!, source.metadata, start as number, end as number);
            const expected = start as number >= source.metadata.size ? 0 : actualEnd - (start as number) + 1;
            if (bytes.byteLength !== expected || bytes.byteLength > MAX_PREVIEW_RANGE_BYTES) throw new Error('Unable to read the requested preview range.');
            if (controller.signal.aborted) return;
            const request = { requestId: key, fileId: fileId as string, start: start as number, end: end as number };
            const sending = session.previewSendChain.catch(() => undefined).then(() => sendPreviewFrames(request, source.metadata, bytes, controller.signal, session));
            session.previewSendChain = sending.catch(() => undefined); await sending;
        } catch (error) {
            if (!controller.signal.aborted && session.control?.readyState === 'open') {
                try { sendControlMessage(session, { type: 'preview_range_error', requestId: key, message: error instanceof Error ? error.message.slice(0, 512) : 'Unable to serve preview range.' }); } catch { /* Peer left. */ }
            }
        } finally { if (session.pendingHostRanges.get(key) === controller) session.pendingHostRanges.delete(key); }
    }, [sendPreviewFrames]);

    const disconnectPeer = useCallback(() => {
        previewBroker.current?.cancelAll('Peer disconnected.');
        for (const requestId of [...pendingRemoteRanges.current.keys()]) {
            settleRemoteRange(requestId, null, new Error('Peer disconnected.'), false);
        }
        for (const session of [...sessions.current.values()]) session.dispose?.(false);
        replaceOnlineFiles([]);
        if (live.current) {
            setConnected(false); setConnectionType('disconnected'); setCurrentReceiving(null); updateCurrentReceivings(() => []);
        }
    }, [replaceOnlineFiles, settleRemoteRange]);
    useEffect(() => {
        live.current = true;
        const broker = new RangeBroker((request, signal) => requestRemoteRange(request, signal), showToast);
        broker.start();
        previewBroker.current = broker;
        return () => {
            live.current = false;
            autoDownloadQueue.current = [];
            autoDownloadQueued.current.clear();
            clearTimeout(toastTimer.current);
            broker.dispose();
            clearSignalingMonitor.current();
            if (previewBroker.current === broker) previewBroker.current = null;
            for (const session of [...sessions.current.values()]) session.dispose?.(false);
            disconnectPeer();
            if (ws.current) {
                if (ws.current.readyState === WebSocket.OPEN) {
                    try { ws.current.send(JSON.stringify({ type: 'leave', roomId: currentRoom.current })); } catch { /* Best effort on unmount. */ }
                }
                ws.current.onclose = null; ws.current.onmessage = null; ws.current.close(); ws.current = null;
            }
            if (temporary.current && currentRoom.current) void clearTemporaryFiles(currentRoom.current).catch(() => undefined);
        };
    }, [disconnectPeer, requestRemoteRange, showToast]);

    useEffect(() => {
        const onPageHide = (event: PageTransitionEvent) => {
            if (event.persisted) return;
            if (ws.current?.readyState === WebSocket.OPEN) {
                try { ws.current.send(JSON.stringify({ type: 'leave', roomId: currentRoom.current })); } catch { /* Best effort on tab close. */ }
            }
            clearSignalingMonitor.current(); ws.current?.close();
            for (const session of [...sessions.current.values()]) session.dispose?.(false);
            if (temporary.current && currentRoom.current) void clearTemporaryFiles(currentRoom.current).catch(() => undefined);
        };
        window.addEventListener('pagehide', onPageHide);
        return () => window.removeEventListener('pagehide', onPageHide);
    }, []);

    const publishSessionCatalog = (session: PeerSession, force = false) => {
        if (session.control?.readyState !== 'open') return;
        const sources = new Map<string, SharedSource>();
        for (const item of queue.current) {
            if (!item.recipientIds.includes(session.peerId)) continue;
            const fileId = `q-${item.id}`;
            const totalChunks = Math.ceil(item.file.size / CHUNK_SIZE);
            sources.set(fileId, { file: item.file, metadata: { fileId, roomId: currentRoom.current, name: item.file.name.slice(0, 255),
                path: item.file.webkitRelativePath.slice(0, 512) || undefined, size: item.file.size, mimeType: safeMimeType(getFileMimeType(item.file)),
                totalChunks, chunkSize: CHUNK_SIZE, receivedChunks: totalChunks, status: 'complete', createdAt: 0 } });
        }
        for (const metadata of receivedFilesRef.current) {
            if (metadata.status !== 'complete' || metadata.sharedWithRoom === false || metadata.sourcePeerId === session.peerId || metadata.mimeType === 'send_state') continue;
            const fileId = `r-${metadata.fileId}`;
            if (!/^[A-Za-z0-9_-]{1,128}$/.test(fileId)) continue;
            sources.set(fileId, { metadata: { ...metadata, fileId, mimeType: safeMimeType(metadata.mimeType) }, databaseFileId: metadata.fileId });
        }
        session.sharedSources = sources;
        const files = [...sources.values()].map(source => source.metadata);
        const fingerprint = JSON.stringify(files.map(file => [file.fileId, file.name, file.path || '', file.size, file.mimeType, file.totalChunks, file.chunkSize || 0]));
        if (!force && fingerprint === session.lastCatalogFingerprint) return;
        const reportCatalogFailure = (code: string, message: string) => {
            recordTransferDiagnostic('catalog_publish', code);
            try { session.control?.send(encodeControlMessage(session.pc, { type: 'catalog_error', message })); } catch { /* Peer may have left. */ }
        };
        if (files.length > MAX_CATALOG_FILES) {
            reportCatalogFailure('catalog_too_large', 'This shared catalog exceeds the 10,000 file limit.');
            return;
        }
        const revision = session.outgoingCatalogRevision + 1;
        const limit = controlMessageLimit(session.pc);
        const groups: FileMetadata[][] = [];
        let current: FileMetadata[] = [];
        const candidateFits = (candidate: FileMetadata[]) => previewFrameEncoder.encode(JSON.stringify({ type: 'catalog_snapshot',
            revision, index: MAX_CATALOG_MESSAGES - 1, chunkCount: MAX_CATALOG_MESSAGES, files: candidate })).byteLength <= limit;
        for (const file of files) {
            const candidate = [...current, file];
            if (candidate.length <= CATALOG_FILES_PER_MESSAGE && candidateFits(candidate)) {
                current = candidate;
                continue;
            }
            if (!current.length) {
                reportCatalogFailure('catalog_entry_too_large', 'A shared file entry exceeds the control message size limit.');
                return;
            }
            groups.push(current);
            current = [file];
            if (!candidateFits(current)) {
                reportCatalogFailure('catalog_entry_too_large', 'A shared file entry exceeds the control message size limit.');
                return;
            }
        }
        if (current.length || !groups.length) groups.push(current);
        if (groups.length > MAX_CATALOG_MESSAGES) {
            reportCatalogFailure('catalog_too_large', 'This shared catalog exceeds the message count limit.');
            return;
        }
        const chunkCount = groups.length;
        session.outgoingCatalogRevision = revision;
        session.lastCatalogFingerprint = fingerprint;
        const publish = async () => {
            for (let index = 0; index < groups.length; index++) {
                const control = session.control;
                if (sessions.current.get(session.peerId) !== session || control?.readyState !== 'open' ||
                    session.outgoingCatalogRevision !== revision) return;
                const text = encodeControlMessage(session.pc, { type: 'catalog_snapshot', revision, index, chunkCount, files: groups[index] });
                while (control.bufferedAmount + previewFrameEncoder.encode(text).byteLength > CONTROL_BUFFER_HIGH_WATER) {
                    if (sessions.current.get(session.peerId) !== session || control.readyState !== 'open' ||
                        session.outgoingCatalogRevision !== revision) return;
                    await new Promise(resolve => window.setTimeout(resolve, 50));
                }
                control.send(text);
            }
        };
        session.catalogSendChain = session.catalogSendChain.catch(() => undefined).then(publish).catch(() => {
            if (session.outgoingCatalogRevision === revision) session.lastCatalogFingerprint = '';
            recordTransferDiagnostic('catalog_publish', 'send_failed');
        });
    };

    const publishAllSessionCatalogs = () => { for (const session of sessions.current.values()) publishSessionCatalog(session); };
    publishCatalogRef.current = publishAllSessionCatalogs;
    const refreshGroupOnlineFiles = () => {
        const all: FileMetadata[] = [];
        for (const session of sessions.current.values()) all.push(...session.remoteFilesByAlias.values());
        replaceOnlineFiles(all);
    };
    const applyPeerProfile = (peerId: string, username: unknown, avatar: unknown) => {
        const member = roomMembers.current.get(peerId);
        if (!member) return;
        const name = validUsername(username) || member.username;
        const nextAvatar = typeof avatar === 'string' && avatar.trim() ? avatar.trim().slice(0, 64) : undefined;
        const existingSession = sessions.current.get(peerId);
        if (member.username === name && member.avatar === nextAvatar &&
            (!existingSession || (existingSession.username === name && existingSession.avatar === nextAvatar))) return;
        const updated: PeerMember = { ...member, username: name, avatar: nextAvatar };
        roomMembers.current.set(peerId, updated);
        setMembers(current => current.map(item => item.peerId === peerId ? { ...item, username: name, avatar: nextAvatar } : item));

        const session = existingSession;
        if (session) {
            session.username = name;
            session.avatar = nextAvatar;
            session.engine?.updateSourceName(name);
            for (const [alias, metadata] of session.remoteFilesByAlias) {
                session.remoteFilesByAlias.set(alias, { ...metadata, sourceName: name });
            }
            refreshGroupOnlineFiles();
        }
        changeQueue(items => items.map(item => ({ ...item, recipients: item.recipients.map(recipient => recipient.peerId === peerId
            ? { ...recipient, peerName: name } : recipient) })));
        updateCurrentReceivings(current => current.map(item => item.peerId === peerId ? { ...item, peerName: name } : item));
        setCurrentReceiving(current => current?.peerId === peerId ? { ...current, peerName: name } : current);
    };
    const updateMember = (session: PeerSession, status: PeerMember['status'], connection: ConnectionType = session.connectionType) => {
        session.status = status; session.connectionType = connection;
        const member = roomMembers.current.get(session.peerId);
        if (member) roomMembers.current.set(session.peerId, { ...member, status, connectionType: connection });
        setMembers(current => current.map(member => member.peerId === session.peerId ? { ...member, status, connectionType: connection } : member));
        const liveSessions = [...sessions.current.values()].filter(item => item.status === 'connected');
        setHasPeer(liveSessions.length > 0);
        setConnected(liveSessions.length > 0);
        setConnectionType(liveSessions.length ? (liveSessions.some(item => item.connectionType === 'relay') ? 'relay' : 'p2p') : 'disconnected');
    };
    const acceptSessionCatalog = (session: PeerSession, message: Record<string, unknown>): string | null => {
        const { revision, index, chunkCount, files } = message;
        if (!Number.isSafeInteger(revision) || Number(revision) < 1 || !Number.isSafeInteger(index) ||
            !Number.isSafeInteger(chunkCount) || Number(chunkCount) < 1 || Number(chunkCount) > MAX_CATALOG_MESSAGES ||
            Number(index) < 0 || Number(index) >= Number(chunkCount) || !Array.isArray(files) || files.length > CATALOG_FILES_PER_MESSAGE) {
            return 'Peer sent an invalid shared file list.';
        }
        if (Number(revision) < session.incomingCatalogRevision + 1) return null;
        if (!session.incomingCatalog || session.incomingCatalog.revision !== Number(revision)) {
            session.incomingCatalog = { revision: Number(revision), chunkCount: Number(chunkCount), chunks: new Map() };
        }
        const snapshot = session.incomingCatalog;
        if (snapshot.chunkCount !== Number(chunkCount)) {
            session.incomingCatalog = null;
            return 'Peer sent an inconsistent shared file list.';
        }
        if (snapshot.chunks.has(Number(index))) return null;
        const chunk: FileMetadata[] = [];
        for (const entry of files) {
            const value = safeCatalogEntry(entry);
            if (!value) { session.incomingCatalog = null; return 'Peer sent an invalid file entry in its shared file list.'; }
            chunk.push(value);
        }
        snapshot.chunks.set(Number(index), chunk);
        if (snapshot.chunks.size !== snapshot.chunkCount) return null;
        const unique = new Map<string, FileMetadata>();
        for (let i = 0; i < snapshot.chunkCount; i++) for (const file of snapshot.chunks.get(i) || []) if (!unique.has(file.fileId)) unique.set(file.fileId, file);
        if (unique.size > MAX_CATALOG_FILES) { session.incomingCatalog = null; return 'Peer shared more than 10,000 files.'; }
        session.incomingCatalogRevision = snapshot.revision; session.incomingCatalog = null;
        session.remoteFilesByAlias.clear();
        for (const [remoteFileId, metadata] of unique) {
            let alias = session.aliasesByRemoteId.get(remoteFileId);
            if (!alias) { alias = crypto.randomUUID(); session.aliasesByRemoteId.set(remoteFileId, alias); }
            const remote = { ...metadata, fileId: alias, remoteFileId, sourcePeerId: session.peerId, sourceName: session.username };
            session.remoteFilesByAlias.set(alias, remote);
        }
        refreshGroupOnlineFiles();
        return null;
    };
    function scheduleRecipientTransfers() {
        if (!live.current) return;
        for (const file of queue.current) {
            for (const recipient of file.recipients) {
                if (activeRecipientTransfers.current.size >= 2) return;
                if (recipient.status !== 'pending' || !file.recipientIds.includes(recipient.peerId)) continue;
                const session = sessions.current.get(recipient.peerId);
                if (!session || session.status !== 'connected' || !session.engine || session.data?.readyState !== 'open' || session.control?.readyState !== 'open') continue;
                if ([...activeRecipientTransfers.current].some(key => key.endsWith(`:${recipient.peerId}`))) continue;
                const key = `${file.id}:${recipient.peerId}`;
                activeRecipientTransfers.current.add(key);
                const sharedWithRoom = false;
                const sendingStartedAt = Date.now();
                changeQueue(items => items.map(item => item.id !== file.id ? item : {
                    ...item, status: 'sending', startTime: item.startTime || sendingStartedAt, pausedAt: undefined,
                    recipients: item.recipients.map(value => value.peerId === recipient.peerId
                        ? { ...value, status: 'sending', startTime: value.startTime || sendingStartedAt, pausedAt: undefined,
                            activeElapsedMs: value.activeElapsedMs || 0 } : value),
                }));
                void session.engine.send(file.file, file.id, bytes => {
                    syncAggregateMetrics();
                    const now = Date.now();
                    changeQueue(items => items.map(item => {
                        if (item.id !== file.id) return item;
                        const recipients = item.recipients.map(value => {
                            if (value.peerId !== recipient.peerId) return value;
                            const elapsed = Math.max(0, now - (value.startTime || now) - (value.pausedMs || 0));
                            const elapsedDelta = elapsed - (value.activeElapsedMs || 0);
                            const byteDelta = bytes - value.bytesTransferred;
                            const speed = elapsedDelta > 0 ? Math.max(0, byteDelta * 1000 / elapsedDelta) : value.speedBytesPerSecond || 0;
                            return { ...value, bytesTransferred: bytes,
                                progress: file.file.size ? Math.min(99, Math.floor(bytes / file.file.size * 100)) : 0,
                                activeElapsedMs: elapsed, speedBytesPerSecond: speed };
                        });
                        const activeRecipient = recipients.find(value => value.peerId === recipient.peerId)!;
                        return { ...item, bytesTransferred: bytes, progress: file.file.size ? Math.min(99, Math.floor(bytes / file.file.size * 100)) : 0,
                            activeElapsedMs: activeRecipient.activeElapsedMs, speedBytesPerSecond: activeRecipient.speedBytesPerSecond, recipients };
                    }));
                }, true, sharedWithRoom).then(() => {
                    changeQueue(items => items.map(item => item.id !== file.id ? item : {
                        ...item, recipients: item.recipients.map(value => value.peerId === recipient.peerId
                            ? { ...value, status: 'sent', progress: 100, bytesTransferred: file.file.size, pausedAt: undefined,
                                activeElapsedMs: value.startTime ? Math.max(value.activeElapsedMs || 0, Date.now() - value.startTime - (value.pausedMs || 0)) : value.activeElapsedMs,
                                speedBytesPerSecond: 0, error: undefined } : value), error: undefined,
                    }));
                }).catch(error => {
                    const errorMessage = (error instanceof Error ? error.message : String(error)).slice(0, 512);
                    recordTransferDiagnostic('transfer_error', 'send_failed');
                    changeQueue(items => items.map(item => item.id !== file.id ? item : {
                        ...item, error: errorMessage, recipients: item.recipients.map(value => value.peerId === recipient.peerId
                            ? { ...value, status: 'failed', error: errorMessage, pausedAt: undefined, speedBytesPerSecond: 0 } : value),
                    }));
                    if (live.current) showToast(`${recipient.peerName}: ${error instanceof Error ? error.message : String(error)}`);
                }).finally(() => {
                    activeRecipientTransfers.current.delete(key);
                    changeQueue(items => items.map(item => {
                        if (item.id !== file.id) return item;
                        const statuses = item.recipients.map(value => value.status);
                        const status = statuses.every(value => value === 'sent') ? 'sent' : statuses.every(value => value === 'sent' || value === 'failed') ? 'failed' :
                            statuses.some(value => value === 'sending') ? 'sending' : statuses.some(value => value === 'paused') ? 'paused' : 'pending';
                        return { ...item, status, progress: status === 'sent' ? 100 : item.progress };
                    }));
                    publishAllSessionCatalogs(); scheduleRecipientTransfers();
                });
            }
        }
        for (const session of sessions.current.values()) {
            const hasPending = queue.current.some(file => file.recipients.some(recipient => recipient.peerId === session.peerId && recipient.status === 'pending'));
            const isActive = [...activeRecipientTransfers.current].some(key => key.endsWith(`:${session.peerId}`));
            if (!hasPending && !isActive) session.engine?.releaseIdleWorker();
        }
    }
    const createPeerSession = (member: Pick<PeerMember, 'peerId' | 'username' | 'avatar' | 'supportsReconnect'>,
        linkId?: string, onTransportLost?: (session: PeerSession) => void, onTransportConnected?: (session: PeerSession) => void) => {
        if (sessions.current.has(member.peerId)) return sessions.current.get(member.peerId)!;
        const session: PeerSession = { ...member, supportsReconnect: member.supportsReconnect === true, linkId,
            generation: crypto.randomUUID(), pc: null, engine: null, control: null, data: null, preview: null,
            candidates: [], remoteCandidateChain: Promise.resolve(), pendingRemoteCandidateCount: 0,
            status: 'connecting', connectionType: 'disconnected', outgoingCatalogRevision: 0, incomingCatalogRevision: 0,
            catalogSendChain: Promise.resolve(),
            incomingCatalog: null, sharedSources: new Map(), lastCatalogFingerprint: '', aliasesByRemoteId: new Map(), remoteFilesByAlias: new Map(),
            pendingHostRanges: new Map(), previewSendChain: Promise.resolve(), receiveClock: { id: '', start: 0, update: 0 } };
        sessions.current.set(session.peerId, session);
        if (roomMembers.current.has(session.peerId)) setSignalingStatus('negotiating');
        setMembers(current => current.some(item => item.peerId === member.peerId)
            ? current.map(item => item.peerId === member.peerId ? { ...item, ...member, connectionType: 'disconnected', status: 'connecting' } : item)
            : [...current, { ...member, connectionType: 'disconnected', status: 'connecting' }]);
        const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS }); session.pc = peer;
        recordTransferDiagnostic('peer_connection_created', undefined, {
            serverCount: ICE_SERVERS.length,
            serverHostnames: iceServerHostnames(ICE_SERVERS).join(', ').slice(0, 512),
            maxMessageSize: peer.sctp?.maxMessageSize ?? null,
            connectionState: peer.connectionState, iceConnectionState: peer.iceConnectionState,
            iceGatheringState: peer.iceGatheringState,
        });
        const commands = peer.createDataChannel('control', { negotiated: true, id: 0, ordered: true });
        const chunks = peer.createDataChannel('data', { negotiated: true, id: 1, ordered: true });
        const previews = peer.createDataChannel('preview', { negotiated: true, id: 2, ordered: true });
        session.control = commands; session.data = chunks; session.preview = previews;
        commands.bufferedAmountLowThreshold = CONTROL_BUFFER_HIGH_WATER / 2;
        previews.binaryType = 'arraybuffer'; previews.bufferedAmountLowThreshold = PREVIEW_BUFFER_HIGH_WATER / 2;
        const closeSession = (retry = true, reason = 'transport_closed') => {
            if (sessions.current.get(session.peerId) !== session) return;
            if (session.initialNegotiationTimer !== undefined) {
                window.clearTimeout(session.initialNegotiationTimer);
                session.initialNegotiationTimer = undefined;
            }
            if (session.iceDisconnectTimer !== undefined) {
                window.clearTimeout(session.iceDisconnectTimer);
                session.iceDisconnectTimer = undefined;
            }
            recordTransferDiagnostic('peer_session_closed', reason, { retry });
            for (const [id, pending] of pendingRemoteRanges.current) if (pending.peerId === session.peerId) settleRemoteRange(id, null, new Error('Peer disconnected.'), false);
            for (const controller of session.pendingHostRanges.values()) controller.abort('Peer disconnected');
            session.pendingHostRanges.clear();
            sessions.current.delete(session.peerId);
            changeQueue(items => items.map(item => {
                const recipients = item.recipients.map(recipient => recipient.peerId === session.peerId && ['pending', 'sending', 'paused'].includes(recipient.status)
                    ? { ...recipient, status: 'failed' as const } : recipient);
                const statuses = recipients.map(recipient => recipient.status);
                const status = statuses.every(value => value === 'sent') ? 'sent' : statuses.every(value => value === 'sent' || value === 'failed') ? 'failed' : item.status;
                return { ...item, recipients, status };
            }), true);
            session.engine?.dispose(); syncAggregateMetrics(); session.pc?.close(); session.remoteFilesByAlias.clear(); session.sharedSources.clear();
            if (live.current) {
                const member = roomMembers.current.get(session.peerId);
                if (member) roomMembers.current.set(session.peerId, { ...member, status: 'disconnected', connectionType: 'disconnected' });
                setMembers(current => current.map(item => item.peerId === session.peerId
                    ? { ...item, status: 'disconnected', connectionType: 'disconnected' } : item));
                updateCurrentReceivings(current => current.filter(item => item.peerId !== session.peerId));
                setCurrentReceiving(current => current?.peerId === session.peerId ? null : current);
            }
            refreshGroupOnlineFiles();
            const liveSessions = [...sessions.current.values()].filter(item => item.status === 'connected');
            if (live.current) {
                setHasPeer(liveSessions.length > 0); setConnected(liveSessions.length > 0);
                setConnectionType(liveSessions.length ? (liveSessions.some(item => item.connectionType === 'relay') ? 'relay' : 'p2p') : 'disconnected');
                setSignalingStatus(liveSessions.length ? 'negotiating' : roomMembers.current.size ? 'unreachable' : 'waiting');
            }
            if (retry) onTransportLost?.(session);
        };
        session.dispose = (retry = true) => closeSession(retry);
        if (!linkId) {
            session.initialNegotiationTimer = window.setTimeout(() => {
                session.initialNegotiationTimer = undefined;
                if (sessions.current.get(session.peerId) !== session || session.status === 'connected' ||
                    commands.readyState === 'open' && chunks.readyState === 'open') return;
                recordTransferDiagnostic('initial_connection_deadline', 'channel_open_timeout', {
                    connectionState: peer.connectionState, iceConnectionState: peer.iceConnectionState,
                    signalingState: peer.signalingState,
                });
                showToast(session.supportsReconnect
                    ? `Signaling with ${session.username} timed out. Retrying the negotiation.`
                    : `Signaling with ${session.username} timed out. Retry the room connection.`, 'info');
                closeSession(true, 'initial_channel_timeout');
            }, NEGOTIATION_TIMEOUT_MS);
        }
        previews.onmessage = event => {
            const decoded = decodePreviewFrame(event.data); if (!decoded) return;
            const frame = decoded.header; const pending = pendingRemoteRanges.current.get(frame.requestId);
            // Resolve the requesting frame's public alias to this peer's private wire id.
            if (pending && pending.peerId === session.peerId) onPreviewData(event, session);
        };
        session.engine = new TransferEngine(chunks, commands, () => currentRoom.current, {
            receiving: (meta, bytes) => {
                if (!live.current) return;
                syncAggregateMetrics();
                const clock = session.receiveClock;
                if (clock.id !== meta.fileId) { clock.id = meta.fileId; clock.start = Date.now(); clock.update = 0; }
                if (Date.now() - clock.update < 150 && bytes < meta.size) return;
                clock.update = Date.now();
                const receiving: ReceivingFile = { fileId: meta.fileId,
                    peerId: session.peerId, peerName: session.username, name: meta.name, size: meta.size, startTime: clock.start, bytesReceived: bytes,
                    progress: meta.size ? Math.min(99, Math.floor(bytes / meta.size * 100)) : 0, status: 'receiving' };
                updateCurrentReceivings(current => [...current.filter(item => item.peerId !== session.peerId), receiving]);
                setCurrentReceiving(receiving);
            },
            received: meta => {
                if (!live.current) return;
                replaceReceivedFiles([...receivedFilesRef.current.filter(file => file.fileId !== meta.fileId), meta]);
                updateCurrentReceivings(current => current.filter(item => item.peerId !== session.peerId));
                setCurrentReceiving(current => current?.fileId === meta.fileId ? null : current);
                publishAllSessionCatalogs();
                if (options.current.autoDownload) queueAutomaticDownload(meta);
            },
            cancelled: meta => {
                updateCurrentReceivings(current => current.filter(item => item.fileId !== meta.fileId));
                setCurrentReceiving(current => current?.fileId === meta.fileId ? null : current);
                if (session.receiveClock.id === meta.fileId) session.receiveClock = { id: '', start: 0, update: 0 };
                recordTransferDiagnostic('transfer_cancelled', 'receiver_cancelled');
            },
            error: message => {
                recordTransferDiagnostic('transfer_error', 'receive_failed');
                const failure: ReceivingFile = {
                    ...(currentReceivingsRef.current.find(item => item.peerId === session.peerId) || {
                        fileId: crypto.randomUUID(), peerId: session.peerId, peerName: session.username, name: 'Receive failed',
                        size: 0, startTime: Date.now(), bytesReceived: 0, progress: 0,
                    }),
                    status: 'failed', error: message.slice(0, 512),
                };
                updateCurrentReceivings(current => [...current.filter(item => item.peerId !== session.peerId), failure]);
                setCurrentReceiving(failure); showToast(`${session.username}: ${message}`);
            },
        }, () => temporary.current ? 'temporary' : 'persistent', { peerId: session.peerId, peerName: session.username },
        { getMaxMessageSize: () => peer.sctp?.maxMessageSize });
        transferEngines.current.add(session.engine);
        const opened = () => {
            if (sessions.current.get(session.peerId) !== session || commands.readyState !== 'open' || chunks.readyState !== 'open') return;
            recordTransferDiagnostic('data_channels_open', undefined, { control: commands.readyState, data: chunks.readyState });
            if (session.initialNegotiationTimer !== undefined) {
                window.clearTimeout(session.initialNegotiationTimer);
                session.initialNegotiationTimer = undefined;
            }
            onTransportConnected?.(session);
            updateMember(session, 'connected', 'p2p'); setSignalingStatus('negotiating');
            publishSessionCatalog(session); scheduleRecipientTransfers();
            void peer.getStats().then(stats => {
                if (sessions.current.get(session.peerId) !== session) return;
                let id: string | undefined; stats.forEach(report => { if (report.type === 'transport') id = report.selectedCandidatePairId; });
                const pair = id ? stats.get(id) : undefined; if (!pair) return;
                const cs = [stats.get(pair.localCandidateId), stats.get(pair.remoteCandidateId)];
                updateMember(session, 'connected', cs.some(candidate => candidate?.candidateType === 'relay') ? 'relay' : cs.every(candidate => candidate?.candidateType === 'host') ? 'local' : 'p2p');
            }).catch(() => undefined);
        };
        commands.onopen = opened; chunks.onopen = opened;
        commands.onclose = () => { recordTransferDiagnostic('data_channel_state', 'control_closed'); closeSession(true, 'control_channel_closed'); };
        chunks.onclose = () => { recordTransferDiagnostic('data_channel_state', 'data_closed'); closeSession(true, 'data_channel_closed'); };
        previews.onclose = () => { recordTransferDiagnostic('data_channel_state', 'preview_closed'); closeSession(true, 'preview_channel_closed'); };
        commands.onerror = () => recordTransferDiagnostic('data_channel_error', 'control_error');
        chunks.onerror = () => recordTransferDiagnostic('data_channel_error', 'data_error');
        previews.onerror = () => recordTransferDiagnostic('data_channel_error', 'preview_error');
        peer.oniceconnectionstatechange = () => {
            recordTransferDiagnostic('ice_connection_state', peer.iceConnectionState);
            if (peer.iceConnectionState === 'connected' || peer.iceConnectionState === 'completed') {
                if (session.iceDisconnectTimer !== undefined) window.clearTimeout(session.iceDisconnectTimer);
                session.iceDisconnectTimer = undefined;
            } else if (peer.iceConnectionState === 'disconnected' && session.iceDisconnectTimer === undefined) {
                session.iceDisconnectTimer = window.setTimeout(() => {
                    session.iceDisconnectTimer = undefined;
                    if (sessions.current.get(session.peerId) === session && peer.iceConnectionState === 'disconnected') {
                        closeSession(true, 'ice_disconnected_timeout');
                    }
                }, ICE_DISCONNECT_GRACE_MS);
            } else if (peer.iceConnectionState === 'failed') closeSession(true, 'ice_failed');
        };
        peer.onicegatheringstatechange = () => recordTransferDiagnostic('ice_gathering_state', peer.iceGatheringState);
        peer.addEventListener('icecandidateerror', event => {
            const failure = event as RTCPeerConnectionIceErrorEvent;
            let serverHostname: string | null = null;
            if (typeof failure.url === 'string') serverHostname = iceServerHostnames([{ urls: failure.url }])[0] || null;
            recordTransferDiagnostic('ice_candidate_error', 'ice_server_error', {
                errorCode: Number.isSafeInteger(failure.errorCode) ? failure.errorCode : null,
                serverHostname,
            });
        });
        peer.onconnectionstatechange = () => {
            recordTransferDiagnostic('peer_connection_state', peer.connectionState);
            if (peer.connectionState === 'failed' || peer.connectionState === 'closed') closeSession(true, `connection_${peer.connectionState}`);
        };
        commands.onmessage = ({ data: text }) => {
            if (typeof text !== 'string') {
                recordTransferDiagnostic('control_message', 'non_text_frame');
                return;
            }
            if (previewFrameEncoder.encode(text).byteLength > controlMessageLimit(peer)) {
                recordTransferDiagnostic('control_message', 'oversized_frame');
                if (/^\s*\{\s*"type"\s*:\s*"catalog_snapshot"/.test(text)) {
                    try { sendControlMessage(session, { type: 'catalog_error', message: 'A shared file list exceeded the control message size limit.' }); } catch { /* Peer may have left. */ }
                    showToast(`${session.username} sent a shared file list that was too large.`);
                } else showToast(`${session.username} sent a control message that was too large.`);
                return;
            }
            try {
                const msg = JSON.parse(text); if (session.engine?.handle(msg)) return;
                if (msg.type === 'catalog_snapshot') {
                    const error = acceptSessionCatalog(session, msg);
                    if (error) {
                        recordTransferDiagnostic('catalog_receive', 'invalid_snapshot');
                        try { sendControlMessage(session, { type: 'catalog_error', message: error }); } catch { /* Peer may have left. */ }
                        showToast(`${session.username}: ${error}`);
                    }
                    return;
                }
                if (msg.type === 'catalog_error') {
                    showToast(`${session.username}: ${typeof msg.message === 'string' ? msg.message.slice(0, 256) : 'The shared file list could not be sent.'}`);
                    return;
                }
                if (msg.type === 'catalog_request') { publishSessionCatalog(session, true); return; }
                if (msg.type === 'preview_range_request') { void handleSessionPreviewRangeRequest(session, msg); return; }
                if (msg.type === 'preview_range_error') {
                    const pending = typeof msg.requestId === 'string' ? pendingRemoteRanges.current.get(msg.requestId) : undefined;
                    if (pending?.peerId === session.peerId) settleRemoteRange(msg.requestId, null,
                        new Error(typeof msg.message === 'string' ? msg.message : 'Peer could not provide the preview.'), false);
                    return;
                }
                if (msg.type === 'preview_range_cancel') { if (typeof msg.requestId === 'string') session.pendingHostRanges.get(msg.requestId)?.abort(); return; }
                if (msg.type === 'chat') {
                    if (typeof msg.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(msg.id) || typeof msg.content !== 'string' ||
                        !msg.content.trim() || msg.content.length > 4000) return;
                    const key = `${session.peerId}:${msg.id}`;
                    if (!seenChatMessages.current.has(key)) {
                        seenChatMessages.current.add(key);
                        if (seenChatMessages.current.size > 512) seenChatMessages.current.delete(seenChatMessages.current.values().next().value!);
                        setChatMessages(current => [...current, { id: msg.id, senderId: session.peerId, senderName: session.username,
                            content: msg.content.trim(), timestamp: Number.isSafeInteger(msg.timestamp) ? Number(msg.timestamp) : Date.now(), status: 'delivered' }]);
                        if (!chatOpen.current) setUnreadCount(count => count + 1);
                    }
                    sendControlMessage(session, { type: 'chat_ack', id: msg.id }); return;
                }
                if (msg.type === 'chat_ack') setChatMessages(current => current.map(item => {
                    if (item.id !== msg.id || !item.recipientStatuses?.some(status => status.peerId === session.peerId)) return item;
                    const recipientStatuses = item.recipientStatuses.map(status => status.peerId === session.peerId ? { ...status, status: 'delivered' as const } : status);
                    return { ...item, recipientStatuses, status: recipientStatuses.every(status => status.status === 'delivered') ? 'delivered' : item.status };
                }));
                else if (['meta', 'file_ready', 'ack'].includes(msg.type)) showToast('The other browser is running an older version. Reload both peers.');
            } catch {
                recordTransferDiagnostic('control_message', 'processing_failed');
                showToast(`${session.username}: A control message could not be processed.`);
            }
        };
        const sessionSocket = ws.current;
        const sessionRoom = currentRoom.current;
        const sessionGeneration = session.generation;
        peer.onicecandidate = ({ candidate }) => {
            if (!candidate || !sessionSocket || sessionSocket !== ws.current || sessionSocket.readyState !== WebSocket.OPEN ||
                sessions.current.get(session.peerId) !== session || session.pc !== peer || session.generation !== sessionGeneration ||
                currentRoom.current !== sessionRoom) return;
            sessionSocket.send(JSON.stringify({ type: 'ice_candidate', roomId: sessionRoom,
                targetPeerId: session.peerId, ...(session.linkId ? { linkId: session.linkId } : {}), payload: candidate }));
        };
        return session;
    };

    const join = (newRoomId: string, newRoomType: RoomType = 'persistent') => {
        const room = newRoomId.trim();
        if (!room || ws.current) return;
        const rtcAvailable = typeof RTCPeerConnection === 'function';
        const joinGeneration = ++roomJoinGeneration.current;
        currentRoom.current = room; temporary.current = newRoomType === 'temporary';
        setRoomId(room); setRoomType(newRoomType); setInRoom(true); setHasPeer(false); setSignalingStatus(rtcAvailable ? 'connecting' : 'unsupported');
        setSelfPeerId(''); selfPeerIdRef.current = ''; setMembers([]); setSelectedPeerIds([]); updateCurrentReceivings(() => []);
        if (!rtcAvailable) { setConnected(false); setConnectionType('disconnected'); }
        replaceOnlineFiles([]); replaceReceivedFiles([]);
        // Begin the local lookup before the server replies so a full-room rejection
        // can still show files already saved for this room on this device.
        const savedRoomFiles = getFilesInRoom(room).then(
            files => ({ files: files.filter(file => file.roomType !== 'temporary') }),
            error => ({ error }),
        );
        const restoreSavedRoomFiles = async () => {
            const result = await savedRoomFiles;
            if (!live.current || roomJoinGeneration.current !== joinGeneration || currentRoom.current !== room) return;
            if ('files' in result) replaceReceivedFiles(result.files);
            else showToast(`Unable to load saved room files: ${String(result.error)}`);
        };
        if (!rtcAvailable) {
            recordTransferDiagnostic('runtime_capability', 'rtcp_unavailable', { roomType: newRoomType });
            if (newRoomType === 'persistent') void restoreSavedRoomFiles();
            return;
        }
        const resumeToken = crypto.randomUUID();
        const socket = new RoomSignalingSocket(import.meta.env.VITE_SIGNALING_SERVER_URL, () => {
            if (live.current && currentRoom.current === room) setSignalingStatus('offline');
        }); ws.current = socket;
        let joinedRoom = false;
        let joinedProfileUpdated = false;
        let signaling = Promise.resolve();
        const offering = new Set<string>();
        const roomPeers = roomMembers.current;
        roomPeers.clear();
        const recovery = new Map<string, { attempts: number; inFlight: boolean; requested: boolean; timer?: number; timeout?: number }>();
        let heartbeatTimer: number | undefined;
        const clearRecovery = (peerId: string) => {
            const state = recovery.get(peerId);
            if (state?.timer !== undefined) window.clearTimeout(state.timer);
            if (state?.timeout !== undefined) window.clearTimeout(state.timeout);
            recovery.delete(peerId);
        };
        const refreshRoomSignalingStatus = () => {
            if (!roomPeers.size) {
                setSignalingStatus('waiting');
                return;
            }
            if ([...sessions.current.values()].some(session => session.status === 'connected')) {
                setSignalingStatus('negotiating');
                return;
            }
            const negotiating = [...sessions.current.values()].some(session => session.status === 'connecting') ||
                [...recovery].some(([peerId, state]) => roomPeers.has(peerId) && state.inFlight);
            setSignalingStatus(negotiating ? 'negotiating' : 'unreachable');
        };
        const onTransportConnected = (session: PeerSession) => clearRecovery(session.peerId);
        const clearMonitoring = () => {
            if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
            heartbeatTimer = undefined;
            window.removeEventListener('focus', onWindowFocus);
            document.removeEventListener('visibilitychange', onVisibilityChange);
            for (const peerId of recovery.keys()) clearRecovery(peerId);
            if (clearSignalingMonitor.current === clearMonitoring) clearSignalingMonitor.current = () => undefined;
            retryPeerRef.current = () => undefined;
        };
        clearSignalingMonitor.current = clearMonitoring;
        const closeAll = () => { for (const session of [...sessions.current.values()]) session.dispose?.(false); };
        const failSignaling = (message: string) => {
            if (socket !== ws.current) return;
            showToast(message); setConnectionFormKey(value => value + 1); clearMonitoring();
            ws.current = null; setMembers([]); roomPeers.clear(); setSelectedPeerIds([]);
            setSelfPeerId(''); selfPeerIdRef.current = '';
            closeAll(); socket.onclose = null;
            try { socket.close(); } catch { /* Socket already closed. */ }
            if (live.current) { setHasPeer(false); setConnected(false); setConnectionType('disconnected'); setSignalingStatus('offline'); }
            if (temporary.current) {
                void clearTemporaryFiles(room).then(() => { if (currentRoom.current === room) replaceReceivedFiles([]); })
                    .catch(error => showToast(`Unable to remove temporary files: ${String(error)}`));
                setInRoom(false);
            }
        };
        const handleRoomFull = (message: string) => {
            if (socket !== ws.current) return;
            showToast(message);
            setConnectionFormKey(value => value + 1);
            clearMonitoring();
            ws.current = null;
            setMembers([]); roomPeers.clear(); setSelectedPeerIds([]);
            setSelfPeerId(''); selfPeerIdRef.current = '';
            closeAll();
            socket.onclose = null; socket.onmessage = null; socket.onerror = null;
            try { socket.close(); } catch { /* Socket already closed. */ }
            if (live.current) {
                setHasPeer(false); setConnected(false); setConnectionType('disconnected'); setSignalingStatus('full');
                setInRoom(true);
            }
            if (newRoomType === 'persistent') void restoreSavedRoomFiles();
        };
        const send = (message: object) => {
            if (socket.readyState !== WebSocket.OPEN) throw new Error('The signaling connection is closed.');
            socket.send(JSON.stringify(message));
        };
        const queueRemoteCandidate = (session: PeerSession, candidate: RTCIceCandidateInit) => {
            const peer = session.pc;
            const generation = session.generation;
            if (!peer || session.pendingRemoteCandidateCount >= MAX_PENDING_ICE_CANDIDATES) return;
            session.pendingRemoteCandidateCount++;
            session.remoteCandidateChain = session.remoteCandidateChain.catch(() => undefined).then(async () => {
                if (!live.current || socket !== ws.current || sessions.current.get(session.peerId) !== session ||
                    session.generation !== generation || session.pc !== peer || !peer.remoteDescription) return;
                try {
                    await peer.addIceCandidate(candidate);
                } catch {
                    // A single stale or unusable ICE candidate must not abort the SDP handshake.
                }
            }).catch(() => undefined).finally(() => {
                session.pendingRemoteCandidateCount = Math.max(0, session.pendingRemoteCandidateCount - 1);
            });
        };
        const requestRoomSync = () => {
            if (!joinedRoom || socket !== ws.current || socket.readyState !== WebSocket.OPEN) return;
            try { send({ type: 'heartbeat', roomId: room }); send({ type: 'sync', roomId: room }); }
            catch { /* The WebSocket close event owns room membership cleanup. */ }
        };
        const onWindowFocus = () => { socket.wake(); requestRoomSync(); };
        const onVisibilityChange = () => { if (document.visibilityState === 'visible') onWindowFocus(); };
        const startMonitoring = () => {
            if (heartbeatTimer !== undefined) return;
            heartbeatTimer = window.setInterval(() => {
                if (!joinedRoom || socket !== ws.current || socket.readyState !== WebSocket.OPEN) return;
                requestRoomSync();
            }, SIGNALING_HEARTBEAT_INTERVAL_MS);
            window.addEventListener('focus', onWindowFocus);
            document.addEventListener('visibilitychange', onVisibilityChange);
        };
        let startReconnect = (_peerId: string) => undefined;
        const onTransportLost = (session: PeerSession) => {
            offering.delete(session.peerId);
            if (!live.current || !session.supportsReconnect || socket !== ws.current || socket.readyState !== WebSocket.OPEN) return;
            const state = recovery.get(session.peerId) || { attempts: 0, inFlight: false, requested: false };
            recovery.set(session.peerId, state);
            if (state.timer !== undefined) window.clearTimeout(state.timer);
            state.timer = undefined;
            if (state.timeout !== undefined) window.clearTimeout(state.timeout);
            state.timeout = undefined;
            state.inFlight = false;
            if (selfPeerIdRef.current.localeCompare(session.peerId) < 0) startReconnect(session.peerId);
            else if (!state.requested) {
                state.requested = true;
                setSignalingStatus('negotiating');
                try { send({ type: 'reconnect_request', roomId: room, targetPeerId: session.peerId }); }
                catch { state.requested = false; refreshRoomSignalingStatus(); }
            }
        };
        const beginOffer = async (session: PeerSession) => {
            const peer = session.pc;
            if (!peer || sessions.current.get(session.peerId) !== session || offering.has(session.peerId) || selfPeerIdRef.current.localeCompare(session.peerId) >= 0) return;
            offering.add(session.peerId);
            const offer = await peer.createOffer();
            if (sessions.current.get(session.peerId) !== session) return;
            await peer.setLocalDescription(offer);
            if (sessions.current.get(session.peerId) !== session) return;
            send({ type: 'offer', roomId: room, targetPeerId: session.peerId,
                ...(session.linkId ? { linkId: session.linkId } : {}), payload: peer.localDescription });
        };
        startReconnect = (peerId: string) => {
            const member = roomPeers.get(peerId);
            if (!member?.supportsReconnect || selfPeerIdRef.current.localeCompare(peerId) >= 0 || socket !== ws.current || socket.readyState !== WebSocket.OPEN) return;
            const state = recovery.get(peerId) || { attempts: 0, inFlight: false, requested: false };
            recovery.set(peerId, state);
            if (state.inFlight || state.attempts >= RECONNECT_DELAYS_MS.length) return;
            const delay = RECONNECT_DELAYS_MS[state.attempts++];
            state.inFlight = true; state.requested = false;
            setSignalingStatus('negotiating');
            state.timer = window.setTimeout(() => {
                state.timer = undefined;
                if (socket !== ws.current || socket.readyState !== WebSocket.OPEN || !roomPeers.has(peerId)) { state.inFlight = false; return; }
                const previous = sessions.current.get(peerId);
                previous?.dispose?.(false);
                offering.delete(peerId);
                const linkId = crypto.randomUUID();
                const session = createPeerSession(member, linkId, onTransportLost, onTransportConnected);
                try {
                    send({ type: 'reconnect', roomId: room, targetPeerId: peerId, linkId });
                    void beginOffer(session).catch(error => {
                        if (sessions.current.get(peerId) === session) showToast(`Unable to reconnect to ${session.username}: ${String(error)}`);
                        session.dispose?.(true);
                    });
                    state.timeout = window.setTimeout(() => {
                        state.timeout = undefined;
                        if (sessions.current.get(peerId) === session && session.status !== 'connected') {
                            state.inFlight = false;
                            session.dispose?.(true);
                        }
                    }, NEGOTIATION_TIMEOUT_MS);
                } catch {
                    state.inFlight = false;
                    session.dispose?.(true);
                }
            }, delay);
        };
        retryPeerRef.current = (peerId: string) => {
            const member = roomPeers.get(peerId);
            if (!member?.supportsReconnect || socket !== ws.current || socket.readyState !== WebSocket.OPEN) return;
            clearRecovery(peerId);
            const state = { attempts: 0, inFlight: false, requested: false };
            recovery.set(peerId, state);
            if (selfPeerIdRef.current.localeCompare(peerId) < 0) startReconnect(peerId);
            else {
                state.requested = true;
                setSignalingStatus('negotiating');
                try { send({ type: 'reconnect_request', roomId: room, targetPeerId: peerId, payload: { manual: true } }); }
                catch { state.requested = false; refreshRoomSignalingStatus(); }
            }
        };
        const markRecipientUnavailable = (peerId: string) => changeQueue(items => items.map(item => {
            const recipients = item.recipients.map(recipient => recipient.peerId === peerId && ['pending', 'sending', 'paused'].includes(recipient.status)
                ? { ...recipient, status: 'failed' as const } : recipient);
            const statuses = recipients.map(recipient => recipient.status);
            const status = statuses.every(value => value === 'sent') ? 'sent' : statuses.every(value => value === 'sent' || value === 'failed') ? 'failed' : item.status;
            return { ...item, recipients, status };
        }));
        const ensureSignaledSession = (peer: { peerId: string; username?: string; avatar?: string; supportsReconnect?: boolean }) => {
            if (typeof peer.peerId !== 'string' || !peer.peerId) return null;
            const existing = sessions.current.get(peer.peerId);
            if (existing) {
                applyPeerProfile(peer.peerId, peer.username, peer.avatar);
                return existing;
            }
            const known = roomPeers.get(peer.peerId);
            if (known) applyPeerProfile(peer.peerId, peer.username, peer.avatar);
            const details: PeerMember = { peerId: peer.peerId, username: validUsername(peer.username) || known?.username || 'Peer',
                avatar: typeof peer.avatar === 'string' ? peer.avatar : known?.avatar,
                supportsReconnect: peer.supportsReconnect === true, connectionType: known?.connectionType ?? 'disconnected',
                status: known?.status ?? 'connecting' };
            roomPeers.set(peer.peerId, details);
            const session = createPeerSession(details, undefined, onTransportLost, onTransportConnected);
            void beginOffer(session).catch(error => {
                if (socket !== ws.current || sessions.current.get(session.peerId) !== session) return;
                offering.delete(session.peerId);
                showToast(`Unable to connect to ${session.username}: ${String(error)}. Other room connections are still active.`);
                session.dispose?.();
            });
            return session;
        };
        const reconcileRoomPeers = (rawPeers: unknown[], authoritative: boolean) => {
            const peers = rawPeers.filter((value): value is { peerId: string; username?: string; avatar?: string; supportsReconnect?: boolean } =>
                !!value && typeof value === 'object' && typeof (value as { peerId?: unknown }).peerId === 'string')
                .map(peer => ({ peerId: peer.peerId, username: validUsername(peer.username) || 'Peer',
                    avatar: typeof peer.avatar === 'string' ? peer.avatar : undefined, supportsReconnect: peer.supportsReconnect === true }));
            const known = new Set(roomPeers.keys());
            if (authoritative) {
                const present = new Set(peers.map(peer => peer.peerId));
                for (const peerId of known) {
                    if (present.has(peerId)) continue;
                    // A delayed directory snapshot must not tear down an open
                    // direct connection while that peer restores signaling.
                    const session = sessions.current.get(peerId);
                    const member = roomPeers.get(peerId);
                    if (session?.status === 'connected' && member) { peers.push({ ...member, avatar: member.avatar, supportsReconnect: member.supportsReconnect === true }); continue; }
                    sessions.current.get(peerId)?.dispose?.(false);
                    markRecipientUnavailable(peerId);
                    clearRecovery(peerId); offering.delete(peerId); roomPeers.delete(peerId);
                    setSelectedPeerIds(current => current.filter(id => id !== peerId));
                }
            }
            for (const peer of peers) {
                if (roomPeers.has(peer.peerId)) applyPeerProfile(peer.peerId, peer.username, peer.avatar);
                const session = sessions.current.get(peer.peerId);
                const previous = roomPeers.get(peer.peerId);
                roomPeers.set(peer.peerId, { ...peer, status: session?.status ?? previous?.status ?? 'connecting',
                    connectionType: session?.connectionType ?? previous?.connectionType ?? 'disconnected' });
            }
            setMembers(current => peers.map(peer => {
                const session = sessions.current.get(peer.peerId);
                const previous = current.find(item => item.peerId === peer.peerId);
                return { ...peer, status: session?.status ?? previous?.status ?? 'connecting',
                    connectionType: session?.connectionType ?? previous?.connectionType ?? 'disconnected' };
            }));
            for (const peer of peers) if (!sessions.current.has(peer.peerId)) ensureSignaledSession(peer);
            refreshRoomSignalingStatus();
        };
        socket.onopen = () => {
            void (async () => {
                try {
                    // Complete temporary-room cleanup before announcing membership to peers.
                    if (!joinedRoom && newRoomType === 'temporary') await clearTemporaryFiles(room);
                    else if (!joinedRoom && newRoomType === 'persistent') void navigator.storage?.persist?.().catch(() => undefined);
                    if (!live.current || socket !== ws.current || currentRoom.current !== room) return;
                    if (!joinedRoom && newRoomType === 'temporary') replaceReceivedFiles([]);
                    send({ type: 'join', protocolVersion: 2, roomId: room, roomType: temporary.current ? 'temporary' : 'persistent', username: identityRef.current, avatar: options.current.avatar,
                        heartbeat: true, supportsReconnect: true, resumeToken });
                } catch (error) { failSignaling(error instanceof Error ? error.message : String(error)); }
            })();
        };
        socket.onerror = () => failSignaling('Unable to reach the signaling server.');
        socket.onclose = event => {
            if (socket !== ws.current) return;
            if (event.code === 4001) { handleRoomFull('This room is full. Rooms support up to 2 people.'); return; }
            else if (event.code === 4002) showToast('That room ID is invalid.');
            else if (event.code === 4003) showToast('This room has older PeerLink clients. Everyone must update or reload the app, leave the room, and rejoin.');
            else if (event.code === 4004) showToast('The room connection expired. Retry to rejoin and refresh the member list.');
            else if (joinedRoom) showToast('The signaling connection closed.');
            else showToast('The signaling connection ended before joining.');
            setConnectionFormKey(value => value + 1); clearMonitoring(); ws.current = null;
            setMembers([]); roomPeers.clear(); setSelectedPeerIds([]); setSelfPeerId(''); selfPeerIdRef.current = '';
            closeAll();
            if (live.current) { setHasPeer(false); setConnected(false); setConnectionType('disconnected'); setSignalingStatus('offline'); }
            if (temporary.current) {
                void clearTemporaryFiles(room).then(() => { if (currentRoom.current === room) replaceReceivedFiles([]); })
                    .catch(error => showToast(`Unable to remove temporary files: ${String(error)}`));
                setInRoom(false);
            }
        };
        socket.onmessage = ({ data: text }) => {
            let msg: Record<string, unknown>;
            try {
                const parsed: unknown = JSON.parse(text);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
                msg = parsed as Record<string, unknown>;
            } catch {
                return;
            }
            if (msg.type === 'error' || msg.type === 'room_full') {
                const maxPeers = typeof msg.maxPeers === 'number' && Number.isSafeInteger(msg.maxPeers) && msg.maxPeers > 0 ? msg.maxPeers : 2;
                const code = typeof msg.code === 'string' ? msg.code : '';
                const messages: Record<string, string> = {
                    already_joined: 'This connection has already joined a room.',
                    invalid_room_id: 'That room ID is invalid.',
                    room_full: `This room is full. Rooms support up to ${maxPeers} people.`,
                    incompatible_protocol: 'This room has older PeerLink clients. Everyone must update or reload the app, leave the room, and rejoin.',
                };
                const message = messages[code] || (msg.type === 'room_full'
                    ? `This room is full. Rooms support up to ${maxPeers} people.`
                    : 'The signaling server rejected the room connection.');
                if (msg.type === 'room_full' || code === 'room_full') handleRoomFull(message);
                else failSignaling(message);
                return;
            }
            signaling = signaling.then(async () => {
                if (!live.current || socket !== ws.current) return;
                if (msg.type === 'protocol_conflict') {
                    showToast('A peer is using an older PeerLink version. Everyone must update or reload the app, leave the room, and rejoin.', 'info');
                    return;
                }
                if (msg.type === 'profile_error') {
                    if (msg.roomId === room && msg.peerId === selfPeerIdRef.current) {
                        showToast(typeof msg.message === 'string' ? msg.message : 'Unable to sync your profile with the room.');
                    }
                    return;
                }
                if (msg.type === 'profile_updated') {
                    // The server acknowledgement is informational. The local desired identity stays authoritative.
                    return;
                }
                if (msg.type === 'peer_updated' && msg.roomId === room && msg.peer && typeof msg.peer === 'object' && !Array.isArray(msg.peer)) {
                    const peer = msg.peer as { peerId?: unknown; username?: unknown; avatar?: unknown };
                    if (typeof peer.peerId === 'string' && peer.peerId !== selfPeerIdRef.current) {
                        applyPeerProfile(peer.peerId, peer.username, peer.avatar);
                    }
                    return;
                }
                if (msg.type === 'joined') {
                    if (msg.protocolVersion !== 2 || typeof msg.peerId !== 'string' || !Array.isArray(msg.peers)) { failSignaling('The signaling server returned an incompatible room response.'); return; }
                    const firstJoin = !joinedRoom;
                    joinedRoom = true; selfPeerIdRef.current = msg.peerId; setSelfPeerId(msg.peerId);
                    joinedProfileUpdated = false;
                    if (!joinedProfileUpdated) {
                        joinedProfileUpdated = true;
                        try { send({ type: 'profile_update', username: identityRef.current, avatar: options.current.avatar }); }
                        catch { showToast('Your profile could not be synced to the room yet.', 'error'); }
                    }
                    const confirmedType: RoomType = msg.roomType === 'temporary' ? 'temporary' : 'persistent';
                    temporary.current = confirmedType === 'temporary'; setRoomType(confirmedType); setInRoom(true);
                    if (firstJoin && confirmedType === 'temporary') {
                        await clearTemporaryFiles(room);
                        if (!live.current || socket !== ws.current || currentRoom.current !== room) return;
                        replaceReceivedFiles([]);
                    } else if (firstJoin) {
                        await restoreSavedRoomFiles();
                        if (!live.current || socket !== ws.current || currentRoom.current !== room) return;
                    }
                    reconcileRoomPeers(msg.peers, true);
                    const peerIds = msg.peers.map((peer: { peerId?: unknown }) => typeof peer?.peerId === 'string' ? peer.peerId : '').filter(Boolean);
                    setSelectedPeerIds(peerIds);
                    setHasPeer(peerIds.length > 0); refreshRoomSignalingStatus();
                    startMonitoring();
                    if (!firstJoin) for (const session of sessions.current.values()) {
                        if (session.status !== 'connected') onTransportLost(session);
                    }
                    return;
                }
                if (msg.type === 'peer_disconnected') return;
                if (msg.type === 'heartbeat_ack') return;
                if (msg.type === 'room_state') {
                    if (msg.roomId !== room || !Array.isArray(msg.peers)) return;
                    reconcileRoomPeers(msg.peers, true);
                    return;
                }
                if (msg.type === 'peer_joined' && msg.peer) {
                    if (typeof msg.peer !== 'object' || Array.isArray(msg.peer)) return;
                    const peer = msg.peer as { peerId?: unknown; username?: unknown; avatar?: unknown; supportsReconnect?: unknown };
                    if (typeof peer.peerId !== 'string') return;
                    const wasKnown = roomPeers.has(peer.peerId);
                    const nextPeer = { peerId: peer.peerId, username: typeof peer.username === 'string' ? peer.username : 'Peer',
                        avatar: typeof peer.avatar === 'string' ? peer.avatar : undefined, supportsReconnect: peer.supportsReconnect === true };
                    reconcileRoomPeers([...roomPeers.values(), nextPeer], false);
                    setSelectedPeerIds(current => current.includes(peer.peerId as string) ? current : [...current, peer.peerId as string]);
                    setHasPeer(true); setSignalingStatus('negotiating');
                    if (!wasKnown) showToast(`${nextPeer.username} joined the room`, 'success');
                    return;
                }
                if (msg.type === 'peer_left' && typeof msg.peerId === 'string') {
                    sessions.current.get(msg.peerId)?.dispose?.(false); markRecipientUnavailable(msg.peerId);
                    clearRecovery(msg.peerId); offering.delete(msg.peerId); roomPeers.delete(msg.peerId);
                    setMembers(current => current.filter(member => member.peerId !== msg.peerId));
                    setSelectedPeerIds(current => current.filter(peerId => peerId !== msg.peerId));
                    setHasPeer([...sessions.current.values()].some(session => session.status === 'connected'));
                    refreshRoomSignalingStatus();
                    return;
                }
                if (msg.type === 'reconnect_request') {
                    if (typeof msg.fromPeerId === 'string' && selfPeerIdRef.current.localeCompare(msg.fromPeerId) < 0) {
                        const manual = (msg.payload as { manual?: unknown } | undefined)?.manual === true;
                        if (manual) {
                            clearRecovery(msg.fromPeerId);
                            recovery.set(msg.fromPeerId, { attempts: 0, inFlight: false, requested: false });
                        }
                        startReconnect(msg.fromPeerId);
                    }
                    return;
                }
                if (msg.type === 'reconnect') {
                    if (typeof msg.fromPeerId !== 'string' || typeof msg.linkId !== 'string' ||
                        !/^[A-Za-z0-9_-]{1,128}$/.test(msg.linkId) || selfPeerIdRef.current.localeCompare(msg.fromPeerId) <= 0) return;
                    const details = roomPeers.get(msg.fromPeerId) || (msg.fromPeer && typeof msg.fromPeer === 'object'
                        ? { ...(msg.fromPeer as { peerId: string; username?: string; avatar?: string; supportsReconnect?: boolean }),
                            username: typeof (msg.fromPeer as { username?: unknown }).username === 'string' ? (msg.fromPeer as { username: string }).username : 'Peer',
                            supportsReconnect: (msg.fromPeer as { supportsReconnect?: unknown }).supportsReconnect === true,
                            connectionType: 'disconnected' as const, status: 'connecting' as const }
                        : undefined);
                    if (!details?.supportsReconnect) return;
                    const current = sessions.current.get(msg.fromPeerId);
                    if (current?.linkId === msg.linkId) return;
                    const state = recovery.get(msg.fromPeerId) || { attempts: 0, inFlight: false, requested: false };
                    if (state.timer !== undefined) window.clearTimeout(state.timer);
                    if (state.timeout !== undefined) window.clearTimeout(state.timeout);
                    state.inFlight = true; state.requested = false; recovery.set(msg.fromPeerId, state);
                    current?.dispose?.(false); offering.delete(msg.fromPeerId);
                    const next = createPeerSession(details, msg.linkId, onTransportLost, onTransportConnected);
                    state.timeout = window.setTimeout(() => {
                        state.timeout = undefined;
                        if (sessions.current.get(msg.fromPeerId as string) === next && next.status !== 'connected') {
                            state.inFlight = false; next.dispose?.(true);
                        }
                    }, NEGOTIATION_TIMEOUT_MS);
                    return;
                }
                if (msg.type === 'offer' || msg.type === 'answer' || msg.type === 'ice_candidate') {
                    if (typeof msg.fromPeerId !== 'string') return;
                    let session = sessions.current.get(msg.fromPeerId);
                    const linkId = typeof msg.linkId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(msg.linkId) ? msg.linkId : undefined;
                    if (!session && msg.type === 'offer') {
                        const details = roomPeers.get(msg.fromPeerId) || { peerId: msg.fromPeerId,
                            username: (msg.fromPeer as { username?: string } | undefined)?.username || 'Peer',
                            supportsReconnect: (msg.fromPeer as { supportsReconnect?: unknown } | undefined)?.supportsReconnect === true,
                            connectionType: 'disconnected' as const, status: 'connecting' as const };
                        roomPeers.set(msg.fromPeerId, details);
                        session = createPeerSession(details, linkId, onTransportLost, onTransportConnected);
                    }
                    const peer = session?.pc; if (!session || !peer) return;
                    if (session.linkId && session.linkId !== linkId) return;
                    if (linkId && !session.linkId) session.linkId = linkId;
                    try {
                        if (msg.type === 'ice_candidate') {
                            if (peer.remoteDescription) {
                                queueRemoteCandidate(session, msg.payload as RTCIceCandidateInit);
                            } else if (session.candidates.length < MAX_PENDING_ICE_CANDIDATES) {
                                session.candidates.push(msg.payload as RTCIceCandidateInit);
                            }
                        } else {
                            await peer.setRemoteDescription(msg.payload as RTCSessionDescriptionInit);
                            if (socket !== ws.current || sessions.current.get(session.peerId) !== session) return;
                            if (msg.type === 'offer') {
                                await peer.setLocalDescription(await peer.createAnswer());
                                if (socket !== ws.current || sessions.current.get(session.peerId) !== session) return;
                                send({ type: 'answer', roomId: room, targetPeerId: session.peerId,
                                    ...(session.linkId ? { linkId: session.linkId } : {}), payload: peer.localDescription });
                            }
                            for (const candidate of session.candidates.splice(0)) queueRemoteCandidate(session, candidate);
                        }
                    } catch (error) {
                        if (socket !== ws.current || !live.current || sessions.current.get(session.peerId) !== session) return;
                        offering.delete(session.peerId);
                        showToast(`Unable to negotiate with ${session.username}: ${String(error)}. Other room connections are still active.`);
                        session.dispose?.();
                    }
                }
            }).catch(error => failSignaling(error instanceof Error ? error.message : String(error)));
        };
    };
    const retryConnection = () => {
        if (ws.current) { ws.current.wake(); return; }
        if (currentRoom.current && !ws.current) join(currentRoom.current, temporary.current ? 'temporary' : 'persistent');
    };
    const retryPeerConnection = useCallback((peerId: string) => retryPeerRef.current(peerId), []);

    const addFilesToQueue = async (files: File[]): Promise<boolean> => {
        if (!files.length) return false;
        const usedIds = new Set(queue.current.map(item => item.id));
        const activePeer = [...sessions.current.values()].find(session => session.status === 'connected' &&
            session.engine && session.data?.readyState === 'open' && session.control?.readyState === 'open');
        if (!activePeer) {
            showToast('Join a room with another person before adding files.');
            return false;
        }
        const recipientIds = [activePeer.peerId];
        const recipients = [{ peerId: activePeer.peerId, peerName: activePeer.username, status: 'pending' as const, progress: 0, bytesTransferred: 0 }];
        const items = files.map(file => {
            let id = generateId();
            while (usedIds.has(id)) id = generateId();
            usedIds.add(id);
            return { file, id, status: 'pending' as const, progress: 0, bytesTransferred: 0,
                lastSentChunk: -1, totalChunks: Math.ceil(file.size / CHUNK_SIZE), recipientIds: [...recipientIds],
                recipients: recipients.map(recipient => ({ ...recipient })) };
        });
        changeQueue(previous => [...previous, ...items], true);
        scheduleRecipientTransfers();
        return true;
    };
    const pauseSending = (id: string) => {
        const isActive = [...activeRecipientTransfers.current].some(key => key.startsWith(`${id}:`));
        const pausedAt = Date.now();
        for (const session of sessions.current.values()) session.engine?.pause(id);
        changeQueue(files => files.map(file => {
            if (file.id !== id) return file;
            const recipients = file.recipients.map(recipient => {
                if (!['sending', 'pending'].includes(recipient.status)) return recipient;
                const isRecipientActive = isActive && recipient.status === 'sending';
                return { ...recipient, status: 'paused' as const,
                    pausedAt: isRecipientActive ? pausedAt : undefined,
                    activeElapsedMs: isRecipientActive && recipient.startTime
                        ? Math.max(recipient.activeElapsedMs || 0, pausedAt - recipient.startTime - (recipient.pausedMs || 0))
                        : recipient.activeElapsedMs,
                    speedBytesPerSecond: isRecipientActive ? 0 : recipient.speedBytesPerSecond };
            });
            return { ...file, status: 'paused', pausedAt: isActive ? pausedAt : undefined,
                activeElapsedMs: isActive && file.startTime ? Math.max(file.activeElapsedMs || 0, pausedAt - file.startTime - (file.pausedMs || 0)) : file.activeElapsedMs,
                speedBytesPerSecond: isActive ? 0 : file.speedBytesPerSecond, recipients };
        }), true);
    };
    const resumeSending = (id: string) => {
        const file = queue.current.find(item => item.id === id);
        if (!file || !file.recipients.some(recipient => recipient.status === 'paused')) return;
        const isActive = [...activeRecipientTransfers.current].some(key => key.startsWith(`${id}:`));
        const resumedAt = Date.now();
        if (isActive) for (const session of sessions.current.values()) session.engine?.resume(id);
        changeQueue(files => files.map(item => {
            if (item.id !== id) return item;
            const recipients = item.recipients.map(recipient => {
                if (recipient.status !== 'paused') return recipient;
                const pausedDuration = recipient.pausedAt ? Math.max(0, resumedAt - recipient.pausedAt) : 0;
                return { ...recipient, status: isActive ? 'sending' as const : 'pending' as const,
                    pausedMs: (recipient.pausedMs || 0) + pausedDuration, pausedAt: undefined, speedBytesPerSecond: 0 };
            });
            return { ...item, status: isActive ? 'sending' : 'pending',
                pausedMs: (item.pausedMs || 0) + (item.pausedAt ? Math.max(0, resumedAt - item.pausedAt) : 0), pausedAt: undefined,
                speedBytesPerSecond: 0, recipients };
        }), true);
        if (!isActive) scheduleRecipientTransfers();
    };
    const retrySending = (id: string) => {
        const previous = queue.current.find(item => item.id === id);
        if (!previous || !previous.recipients.some(recipient => recipient.status === 'failed')) return;
        if ([...activeRecipientTransfers.current].some(key => key.startsWith(`${id}:`))) return;
        const connectedPeers = [...sessions.current.values()].filter(session => session.status === 'connected' && session.engine &&
            session.data?.readyState === 'open' && session.control?.readyState === 'open');
        if (!connectedPeers.length) {
            showToast('Reconnect to a peer before retrying this file.');
            return;
        }
        const usedIds = new Set(queue.current.map(item => item.id));
        let nextId = generateId();
        while (usedIds.has(nextId) || nextId === id) nextId = generateId();
        const fallbackPeer = connectedPeers[0];
        const nextRecipients = previous.recipients.map(recipient => {
            if (recipient.status !== 'failed') return recipient;
            const currentPeer = connectedPeers.find(session => session.peerId === recipient.peerId) || fallbackPeer;
            return { ...recipient, peerId: currentPeer.peerId, peerName: currentPeer.username, status: 'pending' as const,
                progress: 0, bytesTransferred: 0, startTime: undefined, pausedAt: undefined, pausedMs: 0,
                activeElapsedMs: 0, speedBytesPerSecond: 0, error: undefined };
        });
        const recipientIds = [...new Set(nextRecipients.map(recipient => recipient.peerId))];
        changeQueue(items => items.map(item => item.id !== id ? item : {
            ...item, id: nextId, recipientIds, recipients: nextRecipients, status: 'pending', progress: 0,
            lastSentChunk: -1, startTime: undefined, pausedAt: undefined, pausedMs: 0, activeElapsedMs: 0,
            speedBytesPerSecond: 0, bytesTransferred: 0, error: undefined,
        }), true);
        scheduleRecipientTransfers();
    };
    const removeFromQueue = async (id: string) => {
        changeQueue(files => files.filter(file => file.id !== id), true);
        for (const session of sessions.current.values()) session.engine?.cancel(id);
    };
    const clearAllQueue = async () => {
        const ids = queue.current.map(file => file.id);
        changeQueue(() => [], true);
        for (const session of sessions.current.values()) for (const id of ids) session.engine?.cancel(id);
    };
    const downloadFile = async (file: FileMetadata): Promise<void> => {
        try { await streamFileToDownload(file.fileId, undefined, { name: file.name }); } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') return;
            const failure = error instanceof Error ? error : new Error('Unable to download this file.');
            showToast(`Download failed: ${failure.message || 'Unable to download this file.'}`);
            throw failure;
        }
    };
    const clearRoom = async () => {
        if (window.confirm(`Delete all stored files from room "${currentRoom.current}"?`)) {
            try {
                await clearRoomDB(currentRoom.current); replaceReceivedFiles([]);
                showToast('Stored room files deleted.', 'success');
            } catch (error) { showToast(String(error)); }
        }
    };
    const deleteReceivedFile = async (file: FileMetadata) => {
        if (file.roomId !== currentRoom.current ||
            !window.confirm(`Delete "${file.name}" from this device?`)) return;
        try {
            await deleteStoredFile(file.fileId);
            replaceReceivedFiles(receivedFilesRef.current.filter(item => item.fileId !== file.fileId));
            showToast('File deleted from this device.', 'success');
        } catch (error) { showToast(String(error)); }
    };
    const leaveRoom = () => {
        const room = currentRoom.current;
        if (!room) return;
        autoDownloadQueue.current = [];
        autoDownloadQueued.current.clear();
        roomJoinGeneration.current++;
        const wasTemporary = temporary.current;
        const socket = ws.current;
        clearSignalingMonitor.current();
        ws.current = null;
        if (socket) {
            socket.onclose = null; socket.onmessage = null; socket.onerror = null;
            if (socket.readyState === WebSocket.OPEN) {
                try { socket.send(JSON.stringify({ type: 'leave', roomId: room })); } catch { /* Closing connection. */ }
            }
            socket.close();
        }
        for (const session of [...sessions.current.values()]) session.dispose?.(false);
        disconnectPeer();
        currentRoom.current = ''; temporary.current = false;
        setRoomId(''); setRoomType('persistent'); setInRoom(false); setHasPeer(false); setSignalingStatus('idle');
        setSelfPeerId(''); selfPeerIdRef.current = ''; setMembers([]); roomMembers.current.clear(); setSelectedPeerIds([]); updateCurrentReceivings(() => []);
        setConnectionFormKey(value => value + 1);
        queue.current = []; activeRecipientTransfers.current.clear(); setSendQueue([]);
        replaceReceivedFiles([]); replaceOnlineFiles([]); setChatMessages([]); setUnreadCount(0);
        if (wasTemporary) void clearTemporaryFiles(room).catch(error => showToast(`Unable to remove temporary files: ${String(error)}`));
    };
    const openPreview = async (file: FileMetadata) => {
        if (!onlineFilesRef.current.some(onlineFile => onlineFile === file)) {
            return getUpdatePreviewUrl(file.fileId, file, null);
        }
        await waitForPreviewServiceWorker();
        if (!onlineFilesRef.current.some(onlineFile => onlineFile.fileId === file.fileId)) {
            throw new Error('This file is no longer shared by the peer.');
        }
        return createRemotePreviewUrl(file.fileId);
    };
    const closePreview = useCallback((fileId: string) => {
        previewBroker.current?.cancelFile(fileId, 'Preview closed.');
    }, []);
    const sendChatMessage = (content: string) => {
        const targets = [...sessions.current.values()].filter(session => session.status === 'connected' && session.control?.readyState === 'open');
        const trimmed = content.trim();
        if (!trimmed || !targets.length) return;
        if (trimmed.length > 4000) { showToast('Chat messages can be up to 4,000 characters.'); return; }
        const id = generateId();
        const timestamp = Date.now();
        const sendable = targets.filter(session => {
            try {
                encodeControlMessage(session.pc, { type: 'chat', id, senderId: selfPeerIdRef.current, senderName: identityRef.current,
                    content: trimmed, timestamp, status: 'sent', recipientStatuses: targets.map(peer => ({
                        peerId: peer.peerId, peerName: peer.username, status: 'sent',
                    })) });
                return true;
            } catch { recordTransferDiagnostic('control_message', 'chat_oversized'); return false; }
        });
        if (!sendable.length) { showToast('This chat message is too large for the current connection.'); return; }
        const message: ChatMessage = { id, senderId: selfPeerIdRef.current, senderName: identityRef.current,
            content: trimmed, timestamp, status: 'sent',
            recipientStatuses: sendable.map(session => ({ peerId: session.peerId, peerName: session.username, status: 'sent' })) };
        for (const session of sendable) {
            try { sendControlMessage(session, { type: 'chat', ...message }); }
            catch { recordTransferDiagnostic('control_message', 'chat_send_failed'); }
        }
        setChatMessages(messages => [...messages, message]);
    };
    const markChatRead = useCallback(() => setUnreadCount(0), []);
    useEffect(() => { if (isChatOpen) markChatRead(); }, [isChatOpen, markChatRead]);
    const updateSettings = (changes: Partial<Settings>): boolean => {
        const hasUsername = Object.prototype.hasOwnProperty.call(changes, 'username');
        const nextUsername = hasUsername ? validUsername(changes.username) : identityRef.current;
        if (!nextUsername) {
            showToast('Name must be 1–64 characters and cannot be blank or contain control characters.');
            return false;
        }
        if (Object.prototype.hasOwnProperty.call(changes, 'avatar') &&
            (typeof changes.avatar !== 'string' || !changes.avatar.trim() || changes.avatar.trim().length > 64)) {
            showToast('Choose a valid avatar before saving.');
            return false;
        }

        const nextAvatar = typeof changes.avatar === 'string' ? changes.avatar.trim() : options.current.avatar;
        const updated: Settings = { ...options.current, ...changes, username: nextUsername, avatar: nextAvatar };
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
        } catch (error) {
            showToast(`Unable to save settings on this device: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }

        const profileChanged = nextUsername !== identityRef.current || nextAvatar !== options.current.avatar;
        identityRef.current = nextUsername;
        options.current = updated;
        setUsername(nextUsername);
        setSettings(updated);
        if (profileChanged) {
            const socket = ws.current;
            if (socket?.readyState === WebSocket.OPEN && selfPeerIdRef.current) {
                try { socket.send(JSON.stringify({ type: 'profile_update', username: nextUsername, avatar: nextAvatar })); }
                catch { showToast('Your profile was saved on this device but could not be synced to the room.'); }
            }
        }
        return true;
    };
    const dismissToast = () => { clearTimeout(toastTimer.current); setToast(null); };
    const getTransferDiagnostics = async () => {
        const session = [...sessions.current.values()].find(item => item.pc);
        const peer = session?.pc;
        let selectedCandidatePair: Record<string, string | number | null> | null = null;
        const candidateTypeCounts: Record<string, number> = {};
        const dataChannels: Array<Record<string, string | number | null>> | null = peer ? [] : null;
        if (peer) {
            const stats = await peer.getStats();
            let pairId: string | undefined;
            stats.forEach(report => {
                if (report.type === 'transport' && typeof report.selectedCandidatePairId === 'string') {
                    pairId = report.selectedCandidatePairId;
                }
                if (report.type === 'data-channel') {
                    const channel = report as RTCStats & {
                        label?: string; dataChannelIdentifier?: number; state?: string;
                        messagesSent?: number; bytesSent?: number; messagesReceived?: number; bytesReceived?: number;
                    };
                    dataChannels!.push({
                        label: typeof channel.label === 'string' ? channel.label : null,
                        dataChannelIdentifier: typeof channel.dataChannelIdentifier === 'number' ? channel.dataChannelIdentifier : null,
                        state: typeof channel.state === 'string' ? channel.state : null,
                        messagesSent: typeof channel.messagesSent === 'number' ? channel.messagesSent : null,
                        bytesSent: typeof channel.bytesSent === 'number' ? channel.bytesSent : null,
                        messagesReceived: typeof channel.messagesReceived === 'number' ? channel.messagesReceived : null,
                        bytesReceived: typeof channel.bytesReceived === 'number' ? channel.bytesReceived : null,
                        timestamp: typeof channel.timestamp === 'number' ? channel.timestamp : null,
                    });
                }
                const candidateType = (report as RTCStats & { candidateType?: string }).candidateType;
                if ((report.type === 'local-candidate' || report.type === 'remote-candidate') && typeof candidateType === 'string') {
                    candidateTypeCounts[candidateType] = (candidateTypeCounts[candidateType] || 0) + 1;
                }
            });
            let pair = pairId ? stats.get(pairId) : undefined;
            let selectionSource: 'transport' | 'nominated-fallback' = pair ? 'transport' : 'nominated-fallback';
            if (!pair) {
                stats.forEach(report => {
                    if (!pair && report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) pair = report;
                });
            }
            if (pair) {
                const p = pair as RTCStats & {
                    localCandidateId?: string; remoteCandidateId?: string;
                    currentRoundTripTime?: number; bytesSent?: number; bytesReceived?: number;
                    packetsSent?: number; packetsReceived?: number; packetsDiscardedOnSend?: number; bytesDiscardedOnSend?: number;
                };
                const local = p.localCandidateId ? stats.get(p.localCandidateId) as (RTCStats & { candidateType?: string; protocol?: string }) : undefined;
                const remote = p.remoteCandidateId ? stats.get(p.remoteCandidateId) as (RTCStats & { candidateType?: string; protocol?: string }) : undefined;
                // Candidate-pair RTT is measured by ICE/STUN checks; discard counters are socket handoff errors, not SCTP loss counters.
                selectedCandidatePair = {
                    selectionSource,
                    localCandidateType: local?.candidateType ?? null,
                    remoteCandidateType: remote?.candidateType ?? null,
                    localProtocol: local?.protocol ?? null,
                    remoteProtocol: remote?.protocol ?? null,
                    currentRoundTripTime: typeof p.currentRoundTripTime === 'number' ? p.currentRoundTripTime : null,
                    bytesSent: typeof p.bytesSent === 'number' ? p.bytesSent : null,
                    bytesReceived: typeof p.bytesReceived === 'number' ? p.bytesReceived : null,
                    packetsSent: typeof p.packetsSent === 'number' ? p.packetsSent : null,
                    packetsReceived: typeof p.packetsReceived === 'number' ? p.packetsReceived : null,
                    packetsDiscardedOnSend: typeof p.packetsDiscardedOnSend === 'number' ? p.packetsDiscardedOnSend : null,
                    bytesDiscardedOnSend: typeof p.bytesDiscardedOnSend === 'number' ? p.bytesDiscardedOnSend : null,
                    timestamp: typeof p.timestamp === 'number' ? p.timestamp : null,
                };
            }
        }
        return {
            peerId: session?.peerId ?? null,
            transferMetrics: { ...syncAggregateMetrics() },
            selectedCandidatePair,
            candidateTypeCounts,
            dataChannels,
            connection: peer ? {
                connectionState: peer.connectionState,
                iceConnectionState: peer.iceConnectionState,
                iceGatheringState: peer.iceGatheringState,
                signalingState: peer.signalingState,
                channels: [session?.control, session?.data, session?.preview].map(channel => channel ? {
                    label: channel.label, state: channel.readyState, bufferedAmount: channel.bufferedAmount,
                } : null),
            } : null,
            iceServerHostnames: iceServerHostnames(ICE_SERVERS),
            events: getRecentDiagnostics(),
            sctpMaxMessageSize: peer?.sctp?.maxMessageSize ?? null,
            visibilityState: document.visibilityState,
        };
    };
    return { roomId, roomType, connected, connectionType, signalingStatus, sendQueue, receivedFiles, onlineFiles, currentReceiving, currentReceivings,
        members, selectedPeerIds, setSelectedPeerIds, selfPeerId,
        connectionFormKey, chatMessages, unreadCount, settings, username, isChatOpen, isSettingsOpen, inRoom, hasPeer, toast,
        setRoomId, join, retryConnection, leaveRoom, addFilesToQueue, pauseSending, resumeSending, retrySending, removeFromQueue, clearAllQueue,
        retryPeerConnection,
        downloadFile, clearRoom, deleteReceivedFile, openPreview, closePreview, sendChatMessage, markChatRead, updateSettings, setIsChatOpen,
        setIsSettingsOpen, generateRoomId, dismissToast, notifyError: showToast, transferMetrics: syncAggregateMetrics(), getTransferDiagnostics };
}
