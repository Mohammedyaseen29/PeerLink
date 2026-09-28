import { useCallback, useEffect, useRef, useState } from 'react';
import { clearRoom as clearRoomDB, clearTemporaryFiles, deleteFile as deleteStoredFile, getFilesInRoom, getUpdatePreviewUrl, readFileRange, streamFileToDownload, type FileMetadata } from '../ProgressDB';
import { CHUNK_SIZE, TransferEngine } from '../transfer/TransferEngine';
import type { QueuedFile, ConnectionType, ReceivingFile, ChatMessage, Settings, RoomType } from '../types';
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
    const active = useRef<string | null>(null);
    const engine = useRef<TransferEngine | null>(null);
    const pc = useRef<RTCPeerConnection | null>(null);
    const ws = useRef<WebSocket | null>(null);
    const control = useRef<RTCDataChannel | null>(null);
    const data = useRef<RTCDataChannel | null>(null);
    const previewData = useRef<RTCDataChannel | null>(null);
    const currentRoom = useRef('');
    const temporary = useRef(false);
    const live = useRef(true);
    const chatOpen = useRef(false);
    const options = useRef(settings);
    const toastTimer = useRef<number | undefined>(undefined);
    const receiveClock = useRef({ id: '', start: 0, update: 0 });
    const startNext = useRef<() => void>(() => undefined);
    const receivedFilesRef = useRef<FileMetadata[]>([]);
    const onlineFilesRef = useRef<FileMetadata[]>([]);
    const sharedSources = useRef(new Map<string, SharedSource>());
    const publishCatalogRef = useRef<() => void>(() => undefined);
    const catalogRevision = useRef(0);
    const receivedCatalogRevision = useRef(0);
    const incomingCatalog = useRef<CatalogSnapshot | null>(null);
    const pendingRemoteRanges = useRef(new Map<string, PendingRemoteRange>());
    const pendingHostRanges = useRef(new Map<string, AbortController>());
    const previewBroker = useRef<RangeBroker | null>(null);
    const previewSendChain = useRef<Promise<void>>(Promise.resolve());
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

    const buildSharedCatalog = useCallback((): FileMetadata[] => {
        const sources = new Map<string, SharedSource>();
        for (const item of queue.current) {
            const file = item.file;
            const fileId = `q-${item.id}`;
            const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
            const metadata: FileMetadata = {
                fileId, roomId: currentRoom.current, name: file.name.slice(0, 255),
                path: file.webkitRelativePath.slice(0, 512) || undefined, size: file.size,
                mimeType: safeMimeType(file.type), totalChunks, chunkSize: CHUNK_SIZE,
                receivedChunks: totalChunks, status: 'complete', createdAt: 0,
            };
            sources.set(fileId, { metadata, file });
        }
        for (const metadata of receivedFilesRef.current) {
            if (metadata.status !== 'complete' || metadata.mimeType === 'send_state') continue;
            const fileId = `r-${metadata.fileId}`;
            if (!/^[A-Za-z0-9_-]{1,128}$/.test(fileId)) continue;
            const sharedMetadata: FileMetadata = {
                ...metadata, fileId, name: metadata.name.slice(0, 255),
                path: metadata.path?.slice(0, 512) || undefined, mimeType: safeMimeType(metadata.mimeType),
            };
            sources.set(fileId, { metadata: sharedMetadata, databaseFileId: metadata.fileId });
        }
        sharedSources.current = sources;
        return [...sources.values()].map(source => source.metadata);
    }, []);

    const lastCatalogFingerprint = useRef('');
    publishCatalogRef.current = () => {
        if (control.current?.readyState !== 'open') return;
        const files = buildSharedCatalog();
        const fingerprint = JSON.stringify(files.map(({ fileId, name, path, size, mimeType, totalChunks, chunkSize, receivedChunks, createdAt }) =>
            [fileId, name, path ?? '', size, mimeType, totalChunks, chunkSize ?? 0, receivedChunks, createdAt]));
        if (fingerprint === lastCatalogFingerprint.current) return;
        const chunkCount = Math.max(1, Math.ceil(files.length / CATALOG_FILES_PER_MESSAGE));
        if (chunkCount > MAX_CATALOG_MESSAGES) {
            showToast('This room has too many shared files to publish its catalog.');
            return;
        }
        const revision = ++catalogRevision.current;
        for (let index = 0; index < chunkCount; index++) {
            const chunk = files.slice(index * CATALOG_FILES_PER_MESSAGE, (index + 1) * CATALOG_FILES_PER_MESSAGE);
            try {
                control.current.send(JSON.stringify({ type: 'catalog_snapshot', revision, index, chunkCount, files: chunk }));
            } catch (error) {
                showToast(error instanceof Error ? error.message : 'Unable to publish the room catalog.');
                return;
            }
        }
        lastCatalogFingerprint.current = fingerprint;
    };

    startNext.current = () => {
        const transport = engine.current;
        if (!live.current || active.current || !transport || data.current?.readyState !== 'open' || control.current?.readyState !== 'open') return;
        const file = queue.current.find(item => item.status === 'pending');
        if (!file) { transport.releaseIdleWorker(); return; }
        active.current = file.id;
        changeQueue(files => files.map(item => item.id === file.id ? { ...item, status: 'sending', startTime: Date.now(), progress: 0, bytesTransferred: 0 } : item));
        const hasQueuedNext = queue.current.some(item => item.id !== file.id && item.status === 'pending');
        void transport.send(file.file, file.id, bytes => {
            changeQueue(files => files.map(item => item.id === file.id ? {
                ...item, bytesTransferred: bytes, lastSentChunk: Math.ceil(bytes / CHUNK_SIZE) - 1,
                progress: file.file.size ? Math.min(99, Math.floor(bytes / file.file.size * 100)) : 0,
            } : item));
        }, hasQueuedNext).then(() => {
            changeQueue(files => files.map(item => item.id === file.id ? { ...item, status: 'sent', progress: 100, bytesTransferred: file.file.size } : item));
        }).catch(error => {
            if (!live.current || !queue.current.some(item => item.id === file.id)) return;
            changeQueue(files => files.map(item => item.id === file.id ? { ...item, status: 'failed' } : item));
            showToast(error instanceof Error ? error.message : String(error));
        }).finally(() => {
            if (active.current === file.id) active.current = null;
            if (live.current) startNext.current();
        });
    };

    const settleRemoteRange = useCallback((requestId: string, response: PreviewRangeResponse | null, error: Error | null, notifyPeer: boolean) => {
        const pending = pendingRemoteRanges.current.get(requestId);
        if (!pending) return;
        pendingRemoteRanges.current.delete(requestId);
        window.clearTimeout(pending.timer);
        pending.signal.removeEventListener('abort', pending.abort);
        if (notifyPeer && control.current?.readyState === 'open') {
            try { control.current.send(JSON.stringify({ type: 'preview_range_cancel', requestId })); } catch { /* The peer is already leaving. */ }
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
        if (control.current?.readyState !== 'open') return Promise.reject(new Error('The peer is disconnected.'));

        return new Promise((resolve, reject) => {
            const abort = () => settleRemoteRange(request.requestId, null, new DOMException('Preview request aborted', 'AbortError'), true);
            const pending: PendingRemoteRange = {
                request, metadata, resolve, reject, signal, abort, sequence: 0, received: 0,
                timer: window.setTimeout(() => settleRemoteRange(request.requestId, null, new Error('Peer preview request timed out.'), true), PREVIEW_REQUEST_TIMEOUT_MS),
            };
            pendingRemoteRanges.current.set(request.requestId, pending);
            signal.addEventListener('abort', abort, { once: true });
            const preview = previewData.current;
            if (!preview) {
                settleRemoteRange(request.requestId, null, new Error('Peer preview channel is unavailable.'), false);
                return;
            }
            void waitForDataChannel(preview, signal, 5_000).then(() => {
                if (!pendingRemoteRanges.current.has(request.requestId)) return;
                const commands = control.current;
                if (commands?.readyState !== 'open') throw new Error('The peer is disconnected.');
                commands.send(JSON.stringify({ type: 'preview_range_request', ...request }));
            }).catch(error => {
                settleRemoteRange(request.requestId, null, error instanceof Error ? error : new Error(String(error)), false);
            });
        });
    }, [settleRemoteRange]);

    const onPreviewData = useCallback((event: MessageEvent) => {
        const decoded = decodePreviewFrame(event.data);
        if (!decoded) return;
        const { header, payload } = decoded;
        const pending = pendingRemoteRanges.current.get(header.requestId);
        if (!pending) return;
        const fail = (message: string) => settleRemoteRange(header.requestId, null, new Error(message), true);
        const expectedLength = header.start >= pending.metadata.size
            ? 0
            : Math.min(header.end, pending.metadata.size - 1) - header.start + 1;
        if (header.fileId !== pending.request.fileId || header.start !== pending.request.start || header.end !== pending.request.end ||
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
        signal: AbortSignal
    ) => {
        const channel = previewData.current;
        if (!channel || channel.readyState !== 'open') throw new Error('Peer preview channel is closed.');
        const negotiatedMax = pc.current?.sctp?.maxMessageSize;
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

    const handlePreviewRangeRequest = useCallback(async (message: Record<string, unknown>) => {
        const { requestId, fileId, start, end } = message;
        if (!isValidRangeEnvelope(requestId, fileId, start, end)) {
            if (typeof requestId === 'string' && control.current?.readyState === 'open') {
                control.current.send(JSON.stringify({ type: 'preview_range_error', requestId, message: 'Invalid range request.' }));
            }
            return;
        }
        const exactRequestId = requestId as string;
        const exactFileId = fileId as string;
        const exactStart = start as number;
        const exactEnd = end as number;
        if (pendingHostRanges.current.has(exactRequestId) || pendingHostRanges.current.size >= MAX_PREVIEW_REQUESTS) {
            control.current?.send(JSON.stringify({ type: 'preview_range_error', requestId: exactRequestId, message: 'Too many preview requests.' }));
            return;
        }
        const source = sharedSources.current.get(exactFileId);
        if (!source) {
            control.current?.send(JSON.stringify({ type: 'preview_range_error', requestId: exactRequestId, message: 'This file is no longer shared.' }));
            return;
        }
        const abortController = new AbortController();
        pendingHostRanges.current.set(exactRequestId, abortController);
        try {
            const actualEnd = Math.min(exactEnd, source.metadata.size - 1);
            const dataBytes = exactStart >= source.metadata.size
                ? new ArrayBuffer(0)
                : source.file
                    ? await source.file.slice(exactStart, actualEnd + 1).arrayBuffer()
                    : await readFileRange(source.databaseFileId!, source.metadata, exactStart, exactEnd);
            const expected = exactStart >= source.metadata.size ? 0 : actualEnd - exactStart + 1;
            if (dataBytes.byteLength !== expected || dataBytes.byteLength > MAX_PREVIEW_RANGE_BYTES) {
                throw new Error('Unable to read the requested preview range.');
            }
            if (abortController.signal.aborted) return;
            const sending = previewSendChain.current.catch(() => undefined).then(() =>
                sendPreviewFrames({ requestId: exactRequestId, fileId: exactFileId, start: exactStart, end: exactEnd }, source.metadata, dataBytes, abortController.signal));
            previewSendChain.current = sending.catch(() => undefined);
            await sending;
        } catch (error) {
            if (!abortController.signal.aborted && control.current?.readyState === 'open') {
                try {
                    control.current.send(JSON.stringify({ type: 'preview_range_error', requestId: exactRequestId,
                        message: error instanceof Error ? error.message.slice(0, 512) : 'Unable to serve preview range.' }));
                } catch { /* Connection closed while sending the failure. */ }
            }
        } finally {
            if (pendingHostRanges.current.get(exactRequestId) === abortController) pendingHostRanges.current.delete(exactRequestId);
        }
    }, [sendPreviewFrames]);

    const disconnectPeer = useCallback(() => {
        previewBroker.current?.cancelAll('Peer disconnected.');
        for (const requestId of [...pendingRemoteRanges.current.keys()]) {
            settleRemoteRange(requestId, null, new Error('Peer disconnected.'), false);
        }
        for (const controller of pendingHostRanges.current.values()) controller.abort('Peer disconnected');
        pendingHostRanges.current.clear();
        previewSendChain.current = Promise.resolve();
        sharedSources.current.clear();
        onlineFilesRef.current = [];
        incomingCatalog.current = null;
        receivedCatalogRevision.current = 0;
        lastCatalogFingerprint.current = '';
        engine.current?.dispose(); engine.current = null;
        const peer = pc.current; pc.current = null;
        control.current?.close(); data.current?.close();
        previewData.current?.removeEventListener('message', onPreviewData);
        previewData.current?.close();
        control.current = null; data.current = null; previewData.current = null;
        peer?.close();
        if (live.current) { setConnected(false); setConnectionType('disconnected'); setCurrentReceiving(null); setOnlineFiles([]); }
    }, [onPreviewData, settleRemoteRange]);

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

    const identifyConnection = async (peer: RTCPeerConnection) => {
        const stats = await peer.getStats();
        if (pc.current !== peer) return;
        let selected: string | undefined;
        stats.forEach(report => { if (report.type === 'transport') selected = report.selectedCandidatePairId; });
        const pair = selected ? stats.get(selected) : undefined;
        if (!pair) return;
        const candidates = [stats.get(pair.localCandidateId), stats.get(pair.remoteCandidateId)];
        setConnectionType(candidates.some(candidate => candidate?.candidateType === 'relay') ? 'relay' :
            candidates.every(candidate => candidate?.candidateType === 'host') ? 'local' : 'p2p');
    };

    const handleCatalogChunk = useCallback((message: Record<string, unknown>) => {
        const { revision, index, chunkCount, files } = message;
        if (!Number.isSafeInteger(revision) || Number(revision) < 1 || !Number.isSafeInteger(index) ||
            !Number.isSafeInteger(chunkCount) || Number(chunkCount) < 1 || Number(chunkCount) > MAX_CATALOG_MESSAGES ||
            Number(index) < 0 || Number(index) >= Number(chunkCount) || !Array.isArray(files) || files.length > CATALOG_FILES_PER_MESSAGE) return;
        if (Number(revision) < receivedCatalogRevision.current) return;
        if (Number(revision) > receivedCatalogRevision.current) {
            if (incomingCatalog.current?.revision !== Number(revision)) {
                incomingCatalog.current = { revision: Number(revision), chunkCount: Number(chunkCount), chunks: new Map() };
            }
        }
        const snapshot = incomingCatalog.current;
        if (!snapshot || snapshot.revision !== Number(revision) || snapshot.chunkCount !== Number(chunkCount)) return;
        if (snapshot.chunks.has(Number(index))) return;
        const sanitized: FileMetadata[] = [];
        for (const entry of files) {
            const metadata = safeCatalogEntry(entry);
            if (!metadata) return;
            sanitized.push(metadata);
        }
        snapshot.chunks.set(Number(index), sanitized);
        if (snapshot.chunks.size !== snapshot.chunkCount) return;

        const unique = new Map<string, FileMetadata>();
        for (let chunkIndex = 0; chunkIndex < snapshot.chunkCount; chunkIndex++) {
            const chunk = snapshot.chunks.get(chunkIndex);
            if (!chunk) return;
            for (const metadata of chunk) if (!unique.has(metadata.fileId)) unique.set(metadata.fileId, metadata);
        }
        receivedCatalogRevision.current = snapshot.revision;
        incomingCatalog.current = null;
        replaceOnlineFiles([...unique.values()]);
    }, [replaceOnlineFiles]);

    const ensurePeer = () => {
        if (pc.current) return pc.current;
        const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        pc.current = peer;
        // Use the same negotiated control, transfer, and preview channels on both peers.
        const commands = peer.createDataChannel('control', { negotiated: true, id: 0, ordered: true });
        const chunks = peer.createDataChannel('data', { negotiated: true, id: 1, ordered: true });
        const previews = peer.createDataChannel('preview', { negotiated: true, id: 2, ordered: true });
        control.current = commands; data.current = chunks; previewData.current = previews;
        previews.binaryType = 'arraybuffer';
        previews.bufferedAmountLowThreshold = PREVIEW_BUFFER_HIGH_WATER / 2;
        previews.addEventListener('message', onPreviewData);
        const transport = new TransferEngine(chunks, commands, () => currentRoom.current, {
            receiving: (meta, bytes) => {
                if (!live.current) return;
                const clock = receiveClock.current;
                if (clock.id !== meta.fileId) { clock.id = meta.fileId; clock.start = Date.now(); clock.update = 0; }
                if (Date.now() - clock.update < 150 && bytes < meta.size) return;
                clock.update = Date.now();
                setCurrentReceiving({ name: meta.name, size: meta.size, startTime: clock.start, bytesReceived: bytes,
                    progress: meta.size ? Math.min(99, Math.floor(bytes / meta.size * 100)) : 0 });
            },
            received: meta => {
                if (!live.current) return;
                replaceReceivedFiles([...receivedFilesRef.current.filter(file => file.fileId !== meta.fileId), meta]);
                setCurrentReceiving(null);
                if (options.current.autoDownload) void streamFileToDownload(meta.fileId, undefined, { picker: false }).catch(error => showToast(String(error)));
            },
            error: message => { if (live.current) setCurrentReceiving(null); showToast(message); },
        }, () => temporary.current ? 'temporary' : 'persistent');
        engine.current = transport;
        const opened = () => {
            if (pc.current !== peer || commands.readyState !== 'open' || chunks.readyState !== 'open') return;
            setConnected(true);
            setSignalingStatus('waiting');
            void identifyConnection(peer).catch(() => undefined);
            publishCatalogRef.current();
            startNext.current();
        };
        commands.onopen = () => { publishCatalogRef.current(); opened(); };
        chunks.onopen = opened;
        const closed = () => { if (pc.current === peer) disconnectPeer(); };
        commands.onclose = closed; chunks.onclose = closed; previews.onclose = closed;
        peer.onconnectionstatechange = () => { if (peer.connectionState === 'failed') closed(); };
        commands.onmessage = ({ data: text }) => {
            try {
                const msg = JSON.parse(text);
                if (transport.handle(msg)) return;
                if (msg.type === 'catalog_snapshot') { handleCatalogChunk(msg); return; }
                if (msg.type === 'preview_range_request') { void handlePreviewRangeRequest(msg); return; }
                if (msg.type === 'preview_range_cancel') {
                    if (typeof msg.requestId === 'string') pendingHostRanges.current.get(msg.requestId)?.abort('Peer cancelled preview request');
                    return;
                }
                if (msg.type === 'preview_range_error') {
                    if (typeof msg.requestId === 'string') {
                        settleRemoteRange(msg.requestId, null, new Error(typeof msg.message === 'string' ? msg.message : 'Peer could not provide the preview.'), false);
                    }
                    return;
                }
                if (msg.type === 'catalog_request') { publishCatalogRef.current(); return; }
                if (msg.type === 'chat') {
                    setChatMessages(messages => [...messages, { ...msg, status: 'delivered' }]);
                    if (!chatOpen.current) setUnreadCount(count => count + 1);
                    commands.send(JSON.stringify({ type: 'chat_ack', id: msg.id }));
                } else if (msg.type === 'chat_ack') {
                    setChatMessages(messages => messages.map(message => message.id === msg.id ? { ...message, status: 'sent' } : message));
                } else if (['meta', 'file_ready', 'ack'].includes(msg.type)) {
                    showToast('The other browser is running an older version. Reload both peers.');
                }
            } catch (error) { showToast(String(error)); }
        };
        peer.onicecandidate = ({ candidate }) => {
            if (candidate && ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type: 'ice_candidate', roomId: currentRoom.current, payload: candidate }));
        };
        return peer;
    };

    const join = (newRoomId: string, newRoomType: RoomType = 'persistent') => {
        if (!newRoomId.trim() || ws.current) return;
        const reopening = inRoom && currentRoom.current === newRoomId.trim();
        currentRoom.current = newRoomId.trim(); temporary.current = newRoomType === 'temporary';
        setRoomId(currentRoom.current); setRoomType(newRoomType);
        setInRoom(true); setHasPeer(false); setSignalingStatus('connecting');
        const room = currentRoom.current;
        if (!reopening) replaceReceivedFiles([]);
        void getFilesInRoom(room).then(files => {
            if (live.current && currentRoom.current === room && !temporary.current) {
                replaceReceivedFiles(files.filter(file => file.roomType !== 'temporary'));
            }
        }).catch(error => showToast(String(error)));
        if (newRoomType === 'persistent') void navigator.storage?.persist?.().catch(() => undefined);
        const socket = new WebSocket(import.meta.env.VITE_SIGNALING_SERVER_URL);
        ws.current = socket;
        let signaling: Promise<void> = Promise.resolve();
        let joinedRoom = false;
        const candidates: RTCIceCandidateInit[] = [];
        const failSignaling = (message: string) => {
            if (socket !== ws.current) return;
            showToast(message);
            setConnectionFormKey(value => value + 1);
            candidates.length = 0;
            disconnectPeer();
            ws.current = null;
            socket.onclose = null;
            try { socket.close(); } catch { /* The signaling socket has already closed. */ }
            if (live.current) { setHasPeer(false); setSignalingStatus('offline'); }
            if (temporary.current) {
                void clearTemporaryFiles(room).then(() => { if (currentRoom.current === room) replaceReceivedFiles([]); })
                    .catch(error => showToast(`Unable to remove temporary files: ${String(error)}`));
                setInRoom(false);
            }
        };
        socket.onopen = () => {
            try { socket.send(JSON.stringify({ type: 'join', roomId: room, roomType: newRoomType, username })); }
            catch { failSignaling('Unable to join the signaling server.'); }
        };
        socket.onerror = () => failSignaling('Unable to reach the signaling server.');
        socket.onclose = () => {
            if (socket !== ws.current) return;
            showToast(joinedRoom ? 'The signaling connection closed.' : 'The signaling connection ended before joining.');
            setConnectionFormKey(value => value + 1);
            disconnectPeer(); ws.current = null;
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
                if (msg.type === 'room_full') { failSignaling('This room is full.'); return; }
                if (msg.type === 'error') {
                    const messages: Record<string, string> = {
                        already_joined: 'This connection has already joined a room.',
                        invalid_room_id: 'That room ID is invalid.',
                        room_full: 'This room is full.',
                    };
                    failSignaling(messages[msg.code] || 'The signaling server rejected the room connection.');
                    return;
                }
                if (msg.type === 'joined') {
                    joinedRoom = true;
                    const confirmedType: RoomType = msg.roomType === 'temporary' ? 'temporary' : 'persistent';
                    temporary.current = confirmedType === 'temporary';
                    setRoomType(confirmedType);
                    setInRoom(true); setHasPeer(msg.peerCount > 0);
                    setSignalingStatus(msg.peerCount > 0 ? 'negotiating' : 'waiting');
                    if (confirmedType === 'temporary') {
                        await clearTemporaryFiles(room);
                        replaceReceivedFiles([]);
                    } else {
                        const files = await getFilesInRoom(room);
                        if (currentRoom.current === room) replaceReceivedFiles(files.filter(file => file.roomType !== 'temporary'));
                    }
                    ensurePeer();
                }
                if (msg.type === 'peer_joined') {
                    setHasPeer(true); setSignalingStatus('negotiating'); showToast(`${msg.username || 'Peer'} joined the room`, 'success');
                    const peer = ensurePeer();
                    await peer.setLocalDescription(await peer.createOffer());
                    socket.send(JSON.stringify({ type: 'offer', roomId: currentRoom.current, payload: peer.localDescription }));
                }
                if (msg.type === 'offer' || msg.type === 'answer') {
                    const peer = ensurePeer();
                    await peer.setRemoteDescription(msg.payload);
                    for (const candidate of candidates.splice(0)) await peer.addIceCandidate(candidate);
                    if (msg.type === 'offer') {
                        await peer.setLocalDescription(await peer.createAnswer());
                        socket.send(JSON.stringify({ type: 'answer', roomId: currentRoom.current, payload: peer.localDescription }));
                    }
                }
                if (msg.type === 'ice_candidate') {
                    const peer = ensurePeer();
                    if (peer.remoteDescription) await peer.addIceCandidate(msg.payload); else candidates.push(msg.payload);
                }
                if (msg.type === 'peer_left' || msg.type === 'peer_left_room') {
                    disconnectPeer(); candidates.length = 0; setHasPeer(false); setSignalingStatus('waiting');
                }
            }).catch(error => failSignaling(error instanceof Error ? error.message : String(error)));
        };
    };
    const retryConnection = () => {
        if (currentRoom.current && !ws.current) join(currentRoom.current, temporary.current ? 'temporary' : 'persistent');
    };

    const addFilesToQueue = async (files: File[]) => {
        const usedIds = new Set(queue.current.map(item => item.id));
        const items = files.map(file => {
            let id = generateId();
            while (usedIds.has(id)) id = generateId();
            usedIds.add(id);
            return { file, id, status: 'pending' as const, progress: 0, bytesTransferred: 0,
                lastSentChunk: -1, totalChunks: Math.ceil(file.size / CHUNK_SIZE) };
        });
        changeQueue(previous => [...previous, ...items], true);
        startNext.current();
    };
    const pauseSending = (id: string) => {
        engine.current?.pause(id);
        changeQueue(files => files.map(file => file.id === id && file.status === 'sending' ? { ...file, status: 'paused' } : file));
    };
    const resumeSending = (id: string) => {
        if (queue.current.some(file => file.id === id && file.status === 'failed')) {
            const usedIds = new Set(queue.current.filter(file => file.id !== id).map(file => file.id));
            let replacementId = generateId();
            while (usedIds.has(replacementId)) replacementId = generateId();
            changeQueue(files => files.map(file => file.id === id ? { ...file, id: replacementId, status: 'pending', progress: 0, bytesTransferred: 0 } : file), true);
            startNext.current();
            return;
        }
        if (active.current !== id) return;
        changeQueue(files => files.map(file => file.id === id && file.status === 'paused' ? { ...file, status: 'sending' } : file));
        engine.current?.resume(id);
    };
    const removeFromQueue = async (id: string) => {
        changeQueue(files => files.filter(file => file.id !== id), true);
        engine.current?.cancel(id);
    };
    const clearAllQueue = async () => {
        changeQueue(() => [], true);
        if (active.current) engine.current?.cancel(active.current);
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
        disconnectPeer();
        currentRoom.current = ''; temporary.current = false;
        setRoomId(''); setRoomType('persistent'); setInRoom(false); setHasPeer(false); setSignalingStatus('idle');
        setConnectionFormKey(value => value + 1);
        queue.current = []; active.current = null; setSendQueue([]);
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
        if (!content.trim() || control.current?.readyState !== 'open') return;
        const message: ChatMessage = { id: generateId(), senderId: username, senderName: username,
            content: content.trim(), timestamp: Date.now(), status: 'sent' };
        control.current.send(JSON.stringify({ type: 'chat', ...message }));
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
        const peer = pc.current;
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
    return { roomId, roomType, connected, connectionType, signalingStatus, sendQueue, receivedFiles, onlineFiles, currentReceiving, connectionFormKey,
        chatMessages, unreadCount, settings, username, isChatOpen, isSettingsOpen, inRoom, hasPeer, toast,
        setRoomId, join, retryConnection, leaveRoom, addFilesToQueue, pauseSending, resumeSending, removeFromQueue, clearAllQueue,
        downloadFile, clearRoom, deleteReceivedFile, openPreview, closePreview, sendChatMessage, markChatRead, updateSettings, setIsChatOpen,
        setIsSettingsOpen, generateRoomId, dismissToast, notifyError: showToast, transferMetrics: engine.current?.metrics, getTransferDiagnostics };
}
