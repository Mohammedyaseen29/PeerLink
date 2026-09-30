import { useCallback, useEffect, useRef, useState } from 'react';
import { clearRoom as clearRoomDB, clearTemporaryFiles, deleteFile as deleteStoredFile, getFilesInRoom, getUpdatePreviewUrl, readFileRange, streamFileToDownload, type FileMetadata } from '../ProgressDB';
import { CHUNK_SIZE, TransferEngine } from '../transfer/TransferEngine';
import type { QueuedFile, ConnectionType, ReceivingFile, ChatMessage, Settings, RoomType, PeerMember } from '../types';
import { generateId } from '../utils/helpers';
import { getRandomAvatar } from '../components/avatars';
import { createRemotePreviewUrl, MAX_PREVIEW_RANGE_BYTES, RangeBroker, type PreviewRangeRequest, type PreviewRangeResponse, waitForPreviewServiceWorker } from '../preview/RangeBroker';

const STORAGE_KEY = 'peerlink_settings';
const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
];
const CATALOG_FILES_PER_MESSAGE = 16;
const MAX_CATALOG_MESSAGES = 10_000;
const MAX_PREVIEW_REQUESTS = 8;
const PREVIEW_REQUEST_TIMEOUT_MS = 22_000;
const PREVIEW_BUFFER_HIGH_WATER = 512 * 1024;
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
    pc: RTCPeerConnection | null;
    engine: TransferEngine | null;
    control: RTCDataChannel | null;
    data: RTCDataChannel | null;
    preview: RTCDataChannel | null;
    candidates: RTCIceCandidateInit[];
    status: PeerMember['status'];
    connectionType: ConnectionType;
    outgoingCatalogRevision: number;
    incomingCatalogRevision: number;
    incomingCatalog: CatalogSnapshot | null;
    sharedSources: Map<string, SharedSource>;
    lastCatalogFingerprint: string;
    aliasesByRemoteId: Map<string, string>;
    remoteFilesByAlias: Map<string, FileMetadata>;
    pendingHostRanges: Map<string, AbortController>;
    previewSendChain: Promise<void>;
    receiveClock: { id: string; start: number; update: number };
    dispose?: () => void;
};

function safeMimeType(value: string): string {
    if (value.length > 255 || !MIME_TYPE_PATTERN.test(value)) return 'application/octet-stream';
    const essence = value.split(';', 1)[0].trim().toLowerCase();
    return essence === 'text/html' || essence === 'application/xhtml+xml' ? 'text/plain' : value;
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
function getUsername() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        if (typeof saved?.username === 'string' && saved.username) return saved.username;
    } catch { /* Keep identity generation usable when storage is unavailable. */ }
    return `${randomWord(ADJECTIVES)}${randomWord(NOUNS)}`;
}

export function useP2P() {
    const [roomId, setRoomId] = useState('');
    const [roomType, setRoomType] = useState<RoomType>('persistent');
    const [connected, setConnected] = useState(false);
    const [connectionType, setConnectionType] = useState<ConnectionType>('disconnected');
    const [selfPeerId, setSelfPeerId] = useState('');
    const [members, setMembers] = useState<PeerMember[]>([]);
    const [selectedPeerIds, setSelectedPeerIdsState] = useState<string[]>([]);
    const [currentReceivings, setCurrentReceivings] = useState<ReceivingFile[]>([]);
    const [inRoom, setInRoom] = useState(false);
    const [hasPeer, setHasPeer] = useState(false);
    const [signalingStatus, setSignalingStatus] = useState<'idle' | 'connecting' | 'waiting' | 'negotiating' | 'offline'>('idle');
    const [connectionFormKey, setConnectionFormKey] = useState(0);
    const [sendQueue, setSendQueue] = useState<QueuedFile[]>([]);
    const [receivedFiles, setReceivedFiles] = useState<FileMetadata[]>([]);
    const [onlineFiles, setOnlineFiles] = useState<FileMetadata[]>([]);
    const [currentReceiving, setCurrentReceiving] = useState<ReceivingFile | null>(null);
    const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const [settings, setSettings] = useState<Settings>(loadSettings);
    const [username] = useState(getUsername);
    const [isChatOpen, setIsChatOpen] = useState(false);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [toast, setToast] = useState<{ message: string; kind: 'success' | 'error' | 'info' } | null>(null);
    const queue = useRef<QueuedFile[]>([]);
    // A room owns one signaling socket and one independent session per remote peer.
    const sessions = useRef(new Map<string, PeerSession>());
    const selfPeerIdRef = useRef('');
    const selectedPeerIdsRef = useRef<string[]>([]);
    const activeRecipientTransfers = useRef(new Set<string>());
    const transferEngines = useRef(new Set<TransferEngine>());
    const aggregateMetrics = useRef({ peakBufferedBytes: 0, peakReceiveBytes: 0, receivedBytes: 0, sentBytes: 0,
        activeWorkers: 0, workerStarts: 0, pendingReads: 0, disposed: true, readAwaitMs: 0, readyWaitMs: 0,
        channelWaitMs: 0, creditWaitMs: 0, pausedWaitMs: 0, hashMs: 0, storageMs: 0, storedBatches: 0, storedChunks: 0 });
    const syncAggregateMetrics = () => {
        const values = [...transferEngines.current].map(transport => transport.metrics);
        const maxKeys = ['peakBufferedBytes', 'peakReceiveBytes'] as const;
        const sumKeys = ['receivedBytes', 'sentBytes', 'activeWorkers', 'workerStarts', 'pendingReads', 'readAwaitMs', 'readyWaitMs',
            'channelWaitMs', 'creditWaitMs', 'pausedWaitMs', 'hashMs', 'storageMs', 'storedBatches', 'storedChunks'] as const;
        for (const key of maxKeys) aggregateMetrics.current[key] = values.reduce((max, value) => Math.max(max, value[key]), 0);
        for (const key of sumKeys) aggregateMetrics.current[key] = values.reduce((sum, value) => sum + value[key], 0);
        aggregateMetrics.current.disposed = values.every(value => value.disposed);
        return aggregateMetrics.current;
    };
    const ws = useRef<WebSocket | null>(null);
    const currentRoom = useRef('');
    const temporary = useRef(false);
    const live = useRef(true);
    const chatOpen = useRef(false);
    const seenChatMessages = useRef(new Set<string>());
    const options = useRef(settings);
    const toastTimer = useRef<number | undefined>(undefined);
    const receivedFilesRef = useRef<FileMetadata[]>([]);
    const onlineFilesRef = useRef<FileMetadata[]>([]);
    const publishCatalogRef = useRef<() => void>(() => undefined);
    const pendingRemoteRanges = useRef(new Map<string, PendingRemoteRange>());
    const previewBroker = useRef<RangeBroker | null>(null);
    options.current = settings;
    chatOpen.current = isChatOpen;

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
        const commands = sessions.current.get(pending.peerId)?.control;
        if (notifyPeer && commands?.readyState === 'open') {
            try { commands.send(JSON.stringify({ type: 'preview_range_cancel', requestId })); } catch { /* The peer is already leaving. */ }
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
                const commands = session.control;
                if (commands?.readyState !== 'open' || sessions.current.get(peerId) !== session) throw new Error('The peer is disconnected.');
                commands.send(JSON.stringify({ type: 'preview_range_request', ...request, fileId: remoteFileId }));
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
            commands.send(JSON.stringify({ type: 'preview_range_error', requestId: key, message: 'Too many preview requests.' })); return;
        }
        const source = session.sharedSources.get(fileId as string);
        if (!source) { commands.send(JSON.stringify({ type: 'preview_range_error', requestId: key, message: 'This file is no longer shared.' })); return; }
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
                try { session.control.send(JSON.stringify({ type: 'preview_range_error', requestId: key, message: error instanceof Error ? error.message.slice(0, 512) : 'Unable to serve preview range.' })); } catch { /* Peer left. */ }
            }
        } finally { if (session.pendingHostRanges.get(key) === controller) session.pendingHostRanges.delete(key); }
    }, [sendPreviewFrames]);

    const disconnectPeer = useCallback(() => {
        previewBroker.current?.cancelAll('Peer disconnected.');
        for (const requestId of [...pendingRemoteRanges.current.keys()]) {
            settleRemoteRange(requestId, null, new Error('Peer disconnected.'), false);
        }
        for (const session of [...sessions.current.values()]) session.dispose?.();
        replaceOnlineFiles([]);
        if (live.current) {
            setConnected(false); setConnectionType('disconnected'); setCurrentReceiving(null); setCurrentReceivings([]);
        }
    }, [replaceOnlineFiles, settleRemoteRange]);
    useEffect(() => {
        live.current = true;
        const broker = new RangeBroker((request, signal) => requestRemoteRange(request, signal), showToast);
        broker.start();
        previewBroker.current = broker;
        return () => {
            live.current = false;
            clearTimeout(toastTimer.current);
            broker.dispose();
            if (previewBroker.current === broker) previewBroker.current = null;
            for (const session of [...sessions.current.values()]) session.dispose?.();
            disconnectPeer();
            if (ws.current) { ws.current.onclose = null; ws.current.onmessage = null; ws.current.close(); ws.current = null; }
            if (temporary.current && currentRoom.current) void clearTemporaryFiles(currentRoom.current).catch(() => undefined);
        };
    }, [disconnectPeer, requestRemoteRange, showToast]);

    useEffect(() => {
        const onPageHide = () => {
            if (temporary.current && currentRoom.current) void clearTemporaryFiles(currentRoom.current).catch(() => undefined);
        };
        window.addEventListener('pagehide', onPageHide);
        return () => window.removeEventListener('pagehide', onPageHide);
    }, []);

    const publishSessionCatalog = (session: PeerSession, force = false) => {
        if (session.control?.readyState !== 'open') return;
        const sources = new Map<string, SharedSource>();
        for (const item of queue.current) {
            if (!item.recipientIds.includes(session.peerId) || ['failed', 'paused'].includes(item.recipients.find(recipient => recipient.peerId === session.peerId)?.status || '')) continue;
            const fileId = `q-${item.id}`;
            const totalChunks = Math.ceil(item.file.size / CHUNK_SIZE);
            sources.set(fileId, { file: item.file, metadata: { fileId, roomId: currentRoom.current, name: item.file.name.slice(0, 255),
                path: item.file.webkitRelativePath.slice(0, 512) || undefined, size: item.file.size, mimeType: safeMimeType(item.file.type),
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
        const chunkCount = Math.max(1, Math.ceil(files.length / CATALOG_FILES_PER_MESSAGE));
        if (chunkCount > MAX_CATALOG_MESSAGES) return;
        const revision = ++session.outgoingCatalogRevision;
        for (let index = 0; index < chunkCount; index++) {
            session.control.send(JSON.stringify({ type: 'catalog_snapshot', revision, index, chunkCount,
                files: files.slice(index * CATALOG_FILES_PER_MESSAGE, (index + 1) * CATALOG_FILES_PER_MESSAGE) }));
        }
        session.lastCatalogFingerprint = fingerprint;
    };

    const publishAllSessionCatalogs = () => { for (const session of sessions.current.values()) publishSessionCatalog(session); };
    publishCatalogRef.current = publishAllSessionCatalogs;
    const refreshGroupOnlineFiles = () => {
        const all: FileMetadata[] = [];
        for (const session of sessions.current.values()) all.push(...session.remoteFilesByAlias.values());
        replaceOnlineFiles(all);
    };
    const updateMember = (session: PeerSession, status: PeerMember['status'], connection: ConnectionType = session.connectionType) => {
        session.status = status; session.connectionType = connection;
        setMembers(current => current.map(member => member.peerId === session.peerId ? { ...member, status, connectionType: connection } : member));
        const liveSessions = [...sessions.current.values()].filter(item => item.status === 'connected');
        setHasPeer(liveSessions.length > 0);
        setConnected(liveSessions.length > 0);
        setConnectionType(liveSessions.length ? (liveSessions.some(item => item.connectionType === 'relay') ? 'relay' : 'p2p') : 'disconnected');
    };
    const acceptSessionCatalog = (session: PeerSession, message: Record<string, unknown>) => {
        const { revision, index, chunkCount, files } = message;
        if (!Number.isSafeInteger(revision) || Number(revision) < session.incomingCatalogRevision + 1 || !Number.isSafeInteger(index) ||
            !Number.isSafeInteger(chunkCount) || Number(chunkCount) < 1 || Number(chunkCount) > MAX_CATALOG_MESSAGES ||
            Number(index) < 0 || Number(index) >= Number(chunkCount) || !Array.isArray(files) || files.length > CATALOG_FILES_PER_MESSAGE) return;
        if (!session.incomingCatalog || session.incomingCatalog.revision !== Number(revision)) {
            session.incomingCatalog = { revision: Number(revision), chunkCount: Number(chunkCount), chunks: new Map() };
        }
        const snapshot = session.incomingCatalog;
        if (snapshot.chunkCount !== Number(chunkCount) || snapshot.chunks.has(Number(index))) return;
        const chunk: FileMetadata[] = [];
        for (const entry of files) { const value = safeCatalogEntry(entry); if (!value) return; chunk.push(value); }
        snapshot.chunks.set(Number(index), chunk);
        if (snapshot.chunks.size !== snapshot.chunkCount) return;
        const unique = new Map<string, FileMetadata>();
        for (let i = 0; i < snapshot.chunkCount; i++) for (const file of snapshot.chunks.get(i) || []) if (!unique.has(file.fileId)) unique.set(file.fileId, file);
        session.incomingCatalogRevision = snapshot.revision; session.incomingCatalog = null;
        session.remoteFilesByAlias.clear();
        for (const [remoteFileId, metadata] of unique) {
            let alias = session.aliasesByRemoteId.get(remoteFileId);
            if (!alias) { alias = crypto.randomUUID(); session.aliasesByRemoteId.set(remoteFileId, alias); }
            const remote = { ...metadata, fileId: alias, remoteFileId, sourcePeerId: session.peerId, sourceName: session.username };
            session.remoteFilesByAlias.set(alias, remote);
        }
        refreshGroupOnlineFiles();
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
                changeQueue(items => items.map(item => item.id !== file.id ? item : {
                    ...item, status: 'sending', startTime: item.startTime || Date.now(), recipients: item.recipients.map(value => value.peerId === recipient.peerId
                        ? { ...value, status: 'sending', startTime: Date.now(), progress: 0, bytesTransferred: 0 } : value),
                }));
                void session.engine.send(file.file, file.id, bytes => {
                    syncAggregateMetrics();
                    changeQueue(items => items.map(item => item.id !== file.id ? item : {
                        ...item, bytesTransferred: bytes, progress: file.file.size ? Math.min(99, Math.floor(bytes / file.file.size * 100)) : 0,
                        recipients: item.recipients.map(value => value.peerId === recipient.peerId ? { ...value, bytesTransferred: bytes,
                            progress: file.file.size ? Math.min(99, Math.floor(bytes / file.file.size * 100)) : 0 } : value),
                    }));
                }, true, sharedWithRoom).then(() => {
                    changeQueue(items => items.map(item => item.id !== file.id ? item : {
                        ...item, recipients: item.recipients.map(value => value.peerId === recipient.peerId
                            ? { ...value, status: 'sent', progress: 100, bytesTransferred: file.file.size } : value),
                    }));
                }).catch(error => {
                    changeQueue(items => items.map(item => item.id !== file.id ? item : {
                        ...item, recipients: item.recipients.map(value => value.peerId === recipient.peerId ? { ...value, status: 'failed' } : value),
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
    const createPeerSession = (member: Pick<PeerMember, 'peerId' | 'username' | 'avatar'>) => {
        if (sessions.current.has(member.peerId)) return sessions.current.get(member.peerId)!;
        const session: PeerSession = { ...member, generation: crypto.randomUUID(), pc: null, engine: null, control: null, data: null, preview: null,
            candidates: [], status: 'connecting', connectionType: 'disconnected', outgoingCatalogRevision: 0, incomingCatalogRevision: 0,
            incomingCatalog: null, sharedSources: new Map(), lastCatalogFingerprint: '', aliasesByRemoteId: new Map(), remoteFilesByAlias: new Map(),
            pendingHostRanges: new Map(), previewSendChain: Promise.resolve(), receiveClock: { id: '', start: 0, update: 0 } };
        sessions.current.set(session.peerId, session);
        setMembers(current => current.some(item => item.peerId === member.peerId) ? current : [...current, { ...member, connectionType: 'disconnected', status: 'connecting' }]);
        const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS }); session.pc = peer;
        const commands = peer.createDataChannel('control', { negotiated: true, id: 0, ordered: true });
        const chunks = peer.createDataChannel('data', { negotiated: true, id: 1, ordered: true });
        const previews = peer.createDataChannel('preview', { negotiated: true, id: 2, ordered: true });
        session.control = commands; session.data = chunks; session.preview = previews;
        previews.binaryType = 'arraybuffer'; previews.bufferedAmountLowThreshold = PREVIEW_BUFFER_HIGH_WATER / 2;
        const closeSession = () => {
            if (sessions.current.get(session.peerId) !== session) return;
            for (const [id, pending] of pendingRemoteRanges.current) if (pending.peerId === session.peerId) settleRemoteRange(id, null, new Error('Peer disconnected.'), false);
            for (const controller of session.pendingHostRanges.values()) controller.abort('Peer disconnected');
            session.pendingHostRanges.clear();
            sessions.current.delete(session.peerId);
            setSelectedPeerIds(current => current.filter(peerId => peerId !== session.peerId));
            changeQueue(items => items.map(item => {
                const recipients = item.recipients.map(recipient => recipient.peerId === session.peerId && ['pending', 'sending', 'paused'].includes(recipient.status)
                    ? { ...recipient, status: 'failed' as const } : recipient);
                const statuses = recipients.map(recipient => recipient.status);
                const status = statuses.every(value => value === 'sent') ? 'sent' : statuses.every(value => value === 'sent' || value === 'failed') ? 'failed' : item.status;
                return { ...item, recipients, status };
            }), true);
            session.engine?.dispose(); syncAggregateMetrics(); session.pc?.close(); session.remoteFilesByAlias.clear(); session.sharedSources.clear();
            if (live.current) {
                setMembers(current => current.filter(item => item.peerId !== session.peerId));
                setCurrentReceivings(current => current.filter(item => item.peerId !== session.peerId));
                setCurrentReceiving(current => current?.peerId === session.peerId ? null : current);
            }
            refreshGroupOnlineFiles();
            const remaining = sessions.current.size > 0;
            if (live.current) {
                setHasPeer(remaining); setConnected([...sessions.current.values()].some(item => item.status === 'connected'));
                setConnectionType(remaining ? 'p2p' : 'disconnected'); setSignalingStatus(remaining ? 'negotiating' : 'waiting');
            }
        };
        session.dispose = closeSession;
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
                    progress: meta.size ? Math.min(99, Math.floor(bytes / meta.size * 100)) : 0 };
                setCurrentReceivings(current => [...current.filter(item => item.fileId !== meta.fileId), receiving]);
                setCurrentReceiving(receiving);
            },
            received: meta => {
                if (!live.current) return;
                replaceReceivedFiles([...receivedFilesRef.current.filter(file => file.fileId !== meta.fileId), meta]);
                setCurrentReceivings(current => current.filter(item => item.peerId !== session.peerId));
                setCurrentReceiving(current => current?.fileId === meta.fileId ? null : current);
                publishAllSessionCatalogs();
                if (options.current.autoDownload) void streamFileToDownload(meta.fileId, undefined, { picker: false }).catch(error => showToast(String(error)));
            },
            error: message => { setCurrentReceivings(current => current.filter(item => item.peerId !== session.peerId)); setCurrentReceiving(null); showToast(`${session.username}: ${message}`); },
        }, () => temporary.current ? 'temporary' : 'persistent', { peerId: session.peerId, peerName: session.username });
        transferEngines.current.add(session.engine);
        const opened = () => {
            if (sessions.current.get(session.peerId) !== session || commands.readyState !== 'open' || chunks.readyState !== 'open') return;
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
        commands.onclose = closeSession; chunks.onclose = closeSession; previews.onclose = closeSession;
        peer.onconnectionstatechange = () => { if (peer.connectionState === 'failed' || peer.connectionState === 'closed') closeSession(); };
        commands.onmessage = ({ data: text }) => {
            try {
                const msg = JSON.parse(text); if (session.engine?.handle(msg)) return;
                if (msg.type === 'catalog_snapshot') { acceptSessionCatalog(session, msg); return; }
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
                    commands.send(JSON.stringify({ type: 'chat_ack', id: msg.id })); return;
                }
                if (msg.type === 'chat_ack') setChatMessages(current => current.map(item => {
                    if (item.id !== msg.id || !item.recipientStatuses?.some(status => status.peerId === session.peerId)) return item;
                    const recipientStatuses = item.recipientStatuses.map(status => status.peerId === session.peerId ? { ...status, status: 'delivered' as const } : status);
                    return { ...item, recipientStatuses, status: recipientStatuses.every(status => status.status === 'delivered') ? 'delivered' : item.status };
                }));
                else if (['meta', 'file_ready', 'ack'].includes(msg.type)) showToast('The other browser is running an older version. Reload both peers.');
            } catch (error) { showToast(`${session.username}: ${String(error)}`); }
        };
        peer.onicecandidate = ({ candidate }) => {
            if (candidate && ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type: 'ice_candidate', roomId: currentRoom.current,
                targetPeerId: session.peerId, payload: candidate }));
        };
        return session;
    };

    const join = (newRoomId: string, newRoomType: RoomType = 'persistent') => {
        const room = newRoomId.trim();
        if (!room || ws.current) return;
        currentRoom.current = room; temporary.current = newRoomType === 'temporary';
        setRoomId(room); setRoomType(newRoomType); setInRoom(true); setHasPeer(false); setSignalingStatus('connecting');
        setSelfPeerId(''); selfPeerIdRef.current = ''; setMembers([]); setSelectedPeerIds([]); setCurrentReceivings([]);
        replaceOnlineFiles([]);
        const socket = new WebSocket(import.meta.env.VITE_SIGNALING_SERVER_URL); ws.current = socket;
        let joinedRoom = false;
        let signaling = Promise.resolve();
        const offering = new Set<string>();
        const closeAll = () => { for (const session of [...sessions.current.values()]) session.dispose?.(); };
        const failSignaling = (message: string) => {
            if (socket !== ws.current) return;
            showToast(message); setConnectionFormKey(value => value + 1); closeAll();
            ws.current = null; socket.onclose = null;
            try { socket.close(); } catch { /* Socket already closed. */ }
            if (live.current) { setHasPeer(false); setSignalingStatus('offline'); }
            if (temporary.current) {
                void clearTemporaryFiles(room).then(() => { if (currentRoom.current === room) replaceReceivedFiles([]); })
                    .catch(error => showToast(`Unable to remove temporary files: ${String(error)}`));
                setInRoom(false);
            }
        };
        const send = (message: object) => {
            if (socket.readyState !== WebSocket.OPEN) throw new Error('The signaling connection is closed.');
            socket.send(JSON.stringify(message));
        };
        const beginOffer = async (session: PeerSession) => {
            if (!session.pc || offering.has(session.peerId) || selfPeerIdRef.current.localeCompare(session.peerId) >= 0) return;
            offering.add(session.peerId);
            await session.pc.setLocalDescription(await session.pc.createOffer());
            send({ type: 'offer', roomId: room, targetPeerId: session.peerId, payload: session.pc.localDescription });
        };
        const ensureSignaledSession = (peer: { peerId: string; username?: string; avatar?: string }) => {
            if (typeof peer.peerId !== 'string' || !peer.peerId) return null;
            const session = createPeerSession({ peerId: peer.peerId, username: typeof peer.username === 'string' ? peer.username : 'Peer', avatar: peer.avatar });
            void beginOffer(session).catch(error => showToast(`Unable to connect to ${session.username}: ${String(error)}`));
            return session;
        };
        socket.onopen = () => {
            void (async () => {
                try {
                    // Complete temporary-room cleanup before announcing membership to peers.
                    if (newRoomType === 'temporary') { await clearTemporaryFiles(room); replaceReceivedFiles([]); }
                    else if (newRoomType === 'persistent') void navigator.storage?.persist?.().catch(() => undefined);
                    send({ type: 'join', protocolVersion: 2, roomId: room, roomType: newRoomType, username, avatar: options.current.avatar });
                } catch (error) { failSignaling(error instanceof Error ? error.message : String(error)); }
            })();
        };
        socket.onerror = () => failSignaling('Unable to reach the signaling server.');
        socket.onclose = () => {
            if (socket !== ws.current) return;
            if (joinedRoom) showToast('The signaling connection closed.');
            else showToast('The signaling connection ended before joining.');
            setConnectionFormKey(value => value + 1); closeAll(); ws.current = null;
            if (live.current) { setHasPeer(false); setSignalingStatus('offline'); }
            if (temporary.current) {
                void clearTemporaryFiles(room).then(() => { if (currentRoom.current === room) replaceReceivedFiles([]); })
                    .catch(error => showToast(`Unable to remove temporary files: ${String(error)}`));
                setInRoom(false);
            }
        };
        socket.onmessage = ({ data: text }) => {
            signaling = signaling.then(async () => {
                if (!live.current || socket !== ws.current) return;
                const msg = JSON.parse(text);
                if (msg.type === 'error' || msg.type === 'room_full') {
                    const messages: Record<string, string> = { already_joined: 'This connection has already joined a room.',
                        invalid_room_id: 'That room ID is invalid.', room_full: 'This room is full.' };
                    failSignaling(messages[msg.code] || 'The signaling server rejected the room connection.'); return;
                }
                if (msg.type === 'joined') {
                    if (msg.protocolVersion !== 2 || typeof msg.peerId !== 'string' || !Array.isArray(msg.peers)) { failSignaling('The signaling server returned an incompatible room response.'); return; }
                    joinedRoom = true; selfPeerIdRef.current = msg.peerId; setSelfPeerId(msg.peerId);
                    const confirmedType: RoomType = msg.roomType === 'temporary' ? 'temporary' : 'persistent';
                    temporary.current = confirmedType === 'temporary'; setRoomType(confirmedType); setInRoom(true);
                    if (confirmedType === 'temporary') { await clearTemporaryFiles(room); replaceReceivedFiles([]); }
                    else { const files = await getFilesInRoom(room); if (currentRoom.current === room) replaceReceivedFiles(files.filter(file => file.roomType !== 'temporary')); }
                    const peers = msg.peers.filter((peer: unknown) => !!peer && typeof peer === 'object' && typeof (peer as { peerId?: unknown }).peerId === 'string') as Array<{ peerId: string; username?: string; avatar?: string }>;
                    for (const peer of peers) ensureSignaledSession(peer);
                    setSelectedPeerIds(peers.map(peer => peer.peerId));
                    setHasPeer(peers.length > 0); setSignalingStatus(peers.length ? 'negotiating' : 'waiting');
                    return;
                }
                if (msg.type === 'peer_joined' && msg.peer) {
                    const session = ensureSignaledSession(msg.peer);
                    if (session) {
                        setSelectedPeerIds(current => current.includes(session.peerId) ? current : [...current, session.peerId]);
                        setHasPeer(true); setSignalingStatus('negotiating'); showToast(`${session.username} joined the room`, 'success');
                    }
                    return;
                }
                if (msg.type === 'peer_left' && typeof msg.peerId === 'string') {
                    sessions.current.get(msg.peerId)?.dispose?.(); offering.delete(msg.peerId); return;
                }
                if (msg.type === 'offer' || msg.type === 'answer' || msg.type === 'ice_candidate') {
                    if (typeof msg.fromPeerId !== 'string') return;
                    let session = sessions.current.get(msg.fromPeerId);
                    if (!session && msg.type === 'offer') session = createPeerSession({ peerId: msg.fromPeerId, username: 'Peer' });
                    const peer = session?.pc; if (!session || !peer) return;
                    if (msg.type === 'ice_candidate') {
                        if (peer.remoteDescription) await peer.addIceCandidate(msg.payload); else session.candidates.push(msg.payload);
                    } else {
                        await peer.setRemoteDescription(msg.payload);
                        for (const candidate of session.candidates.splice(0)) await peer.addIceCandidate(candidate);
                        if (msg.type === 'offer') {
                            await peer.setLocalDescription(await peer.createAnswer());
                            send({ type: 'answer', roomId: room, targetPeerId: session.peerId, payload: peer.localDescription });
                        }
                    }
                }
            }).catch(error => failSignaling(error instanceof Error ? error.message : String(error)));
        };
    };
    const retryConnection = () => {
        if (currentRoom.current && !ws.current) join(currentRoom.current, temporary.current ? 'temporary' : 'persistent');
    };

    const addFilesToQueue = async (files: File[]) => {
        const usedIds = new Set(queue.current.map(item => item.id));
        const recipientIds = selectedPeerIdsRef.current.filter(peerId => sessions.current.has(peerId));
        const recipients = recipientIds.map(peerId => {
            const peer = sessions.current.get(peerId)!;
            return { peerId, peerName: peer.username, status: 'pending' as const, progress: 0, bytesTransferred: 0 };
        });
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
    };
    const pauseSending = (id: string) => {
        for (const session of sessions.current.values()) session.engine?.pause(id);
        changeQueue(files => files.map(file => file.id === id ? { ...file, status: 'paused', recipients: file.recipients.map(recipient =>
            ['sending', 'pending'].includes(recipient.status) ? { ...recipient, status: 'paused' } : recipient) } : file));
    };
    const resumeSending = (id: string) => {
        if (!queue.current.some(file => file.id === id && file.recipients.some(recipient => ['failed', 'paused'].includes(recipient.status)))) return;
        for (const session of sessions.current.values()) session.engine?.resume(id);
        changeQueue(files => files.map(file => file.id !== id ? file : { ...file, status: 'pending',
            recipients: file.recipients.map(recipient => ['failed', 'paused'].includes(recipient.status)
                ? { ...recipient, status: 'pending', progress: 0, bytesTransferred: 0 } : recipient) }), true);
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
    const downloadFile = async (file: FileMetadata) => {
        try { await streamFileToDownload(file.fileId, undefined, { name: file.name }); } catch (error) {
            if (!(error instanceof DOMException && error.name === 'AbortError')) showToast(String(error));
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
        const wasTemporary = temporary.current;
        const socket = ws.current;
        ws.current = null;
        if (socket) {
            socket.onclose = null; socket.onmessage = null; socket.onerror = null;
            if (socket.readyState === WebSocket.OPEN) {
                try { socket.send(JSON.stringify({ type: 'leave', roomId: room })); } catch { /* Closing connection. */ }
            }
            socket.close();
        }
        for (const session of [...sessions.current.values()]) session.dispose?.();
        disconnectPeer();
        currentRoom.current = ''; temporary.current = false;
        setRoomId(''); setRoomType('persistent'); setInRoom(false); setHasPeer(false); setSignalingStatus('idle');
        setSelfPeerId(''); selfPeerIdRef.current = ''; setMembers([]); setSelectedPeerIds([]); setCurrentReceivings([]);
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
        if (!content.trim() || !targets.length) return;
        const message: ChatMessage = { id: generateId(), senderId: selfPeerIdRef.current, senderName: username,
            content: content.trim(), timestamp: Date.now(), status: 'sent',
            recipientStatuses: targets.map(session => ({ peerId: session.peerId, peerName: session.username, status: 'sent' })) };
        for (const session of targets) session.control!.send(JSON.stringify({ type: 'chat', ...message }));
        setChatMessages(messages => [...messages, message]);
    };
    const markChatRead = useCallback(() => setUnreadCount(0), []);
    useEffect(() => { if (isChatOpen) markChatRead(); }, [isChatOpen, markChatRead]);
    const updateSettings = (changes: Partial<Settings>) => {
        const updated = { ...options.current, ...changes };
        setSettings(updated); localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    };
    const dismissToast = () => { clearTimeout(toastTimer.current); setToast(null); };
    const getTransferDiagnostics = async () => {
        const peer = [...sessions.current.values()].find(session => session.pc)?.pc;
        let selectedCandidatePair: Record<string, string | number | null> | null = null;
        if (peer) {
            const stats = await peer.getStats();
            let pairId: string | undefined;
            stats.forEach(report => {
                if (report.type === 'transport' && typeof report.selectedCandidatePairId === 'string') {
                    pairId = report.selectedCandidatePairId;
                }
            });
            let pair = pairId ? stats.get(pairId) : undefined;
            if (!pair) {
                stats.forEach(report => {
                    if (!pair && report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) pair = report;
                });
            }
            if (pair) {
                const p = pair as RTCStats & {
                    localCandidateId?: string; remoteCandidateId?: string;
                    currentRoundTripTime?: number; bytesSent?: number; bytesReceived?: number;
                };
                const local = p.localCandidateId ? stats.get(p.localCandidateId) as (RTCStats & { candidateType?: string; protocol?: string }) : undefined;
                const remote = p.remoteCandidateId ? stats.get(p.remoteCandidateId) as (RTCStats & { candidateType?: string; protocol?: string }) : undefined;
                selectedCandidatePair = {
                    localCandidateType: local?.candidateType ?? null,
                    remoteCandidateType: remote?.candidateType ?? null,
                    localProtocol: local?.protocol ?? null,
                    remoteProtocol: remote?.protocol ?? null,
                    currentRoundTripTime: p.currentRoundTripTime ?? null,
                    bytesSent: p.bytesSent ?? null,
                    bytesReceived: p.bytesReceived ?? null,
                };
            }
        }
        return {
            selectedCandidatePair,
            sctpMaxMessageSize: peer?.sctp?.maxMessageSize ?? null,
            visibilityState: document.visibilityState,
        };
    };
    return { roomId, roomType, connected, connectionType, signalingStatus, sendQueue, receivedFiles, onlineFiles, currentReceiving, currentReceivings,
        members, selectedPeerIds, setSelectedPeerIds, selfPeerId,
        connectionFormKey, chatMessages, unreadCount, settings, username, isChatOpen, isSettingsOpen, inRoom, hasPeer, toast,
        setRoomId, join, retryConnection, leaveRoom, addFilesToQueue, pauseSending, resumeSending, removeFromQueue, clearAllQueue,
        downloadFile, clearRoom, deleteReceivedFile, openPreview, closePreview, sendChatMessage, markChatRead, updateSettings, setIsChatOpen,
        setIsSettingsOpen, generateRoomId, dismissToast, notifyError: showToast, transferMetrics: syncAggregateMetrics(), getTransferDiagnostics };
}
