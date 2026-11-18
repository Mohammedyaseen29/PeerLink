import {
    isPeerLinkServiceWorker,
    isPeerLinkServiceWorkerRegistration,
    registerPeerLinkServiceWorker,
} from '../serviceWorker';

const WORKER_TIMEOUT_MS = 30_000;
const DOWNLOAD_CAPABILITY_TIMEOUT_MS = 2_500;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

function tokenValue(): string {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function activeWorkerSupportsDownload(worker: ServiceWorker): Promise<boolean> {
    return new Promise(resolve => {
        const channel = new MessageChannel();
        let settled = false;
        let timer = 0;
        const finish = (supported: boolean) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            channel.port1.onmessage = null;
            channel.port1.onmessageerror = null;
            channel.port1.close();
            resolve(supported);
        };
        timer = window.setTimeout(() => finish(false), DOWNLOAD_CAPABILITY_TIMEOUT_MS);
        channel.port1.onmessage = ({ data }) => finish(
            data?.type === 'PEERLINK_DOWNLOAD_CAPABILITY_ACK' && Number.isSafeInteger(data.version) && data.version >= 1
        );
        channel.port1.onmessageerror = () => finish(false);
        channel.port1.start();
        try { worker.postMessage({ type: 'PEERLINK_DOWNLOAD_CAPABILITY' }, [channel.port2]); }
        catch { finish(false); }
    });
}

async function requireCurrentDownloadCapability(worker: ServiceWorker, updateWaiting: boolean): Promise<void> {
    if (updateWaiting && !(await activeWorkerSupportsDownload(worker))) {
        throw new Error('Apply the PeerLink update, then retry the download.');
    }
}

async function controlledPeerLinkWorker(): Promise<ServiceWorker> {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || typeof ReadableStream !== 'function') {
        throw new Error('Large downloads need streaming service-worker support in this browser.');
    }
    if (typeof window === 'undefined' || !window.isSecureContext) {
        throw new Error('Large downloads need a secure page, such as HTTPS or localhost.');
    }

    const container = navigator.serviceWorker;
    const current = container.controller;
    if (current && isPeerLinkServiceWorker(current)) {
        const registration = await container.getRegistration().catch(() => undefined);
        await requireCurrentDownloadCapability(current, Boolean(registration?.waiting));
        return current;
    }

    const registration = await registerPeerLinkServiceWorker(WORKER_TIMEOUT_MS);
    if (!isPeerLinkServiceWorkerRegistration(registration)) {
        throw new Error('The PeerLink download service worker is unavailable for this page.');
    }
    const worker = await new Promise<ServiceWorker>((resolve, reject) => {
        let timeout = 0;
        let finish: (error?: Error, worker?: ServiceWorker) => void;
        const onControllerChange = () => {
            const worker = container.controller;
            if (worker && isPeerLinkServiceWorker(worker)) finish(undefined, worker);
        };
        finish = (error?: Error, worker?: ServiceWorker) => {
            window.clearTimeout(timeout);
            container.removeEventListener('controllerchange', onControllerChange);
            if (error) reject(error);
            else if (worker) resolve(worker);
            else reject(new Error('PeerLink download streaming is not ready. Reopen the page and retry.'));
        };
        timeout = window.setTimeout(() => finish(new Error('PeerLink download streaming is not ready. Reopen the page and retry.')), WORKER_TIMEOUT_MS);
        container.addEventListener('controllerchange', onControllerChange);
        onControllerChange();
    });
    await requireCurrentDownloadCapability(worker, Boolean(registration.waiting));
    return worker;
}

function registerToken(worker: ServiceWorker, value: {
    token: string;
    fileId: string;
    name: string;
    size: number;
}): Promise<void> {
    return new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        let timer = 0;
        const finish = (error?: Error) => {
            window.clearTimeout(timer);
            channel.port1.onmessage = null;
            channel.port1.onmessageerror = null;
            channel.port1.close();
            if (error) reject(error);
            else resolve();
        };
        timer = window.setTimeout(() => finish(new Error('The download service worker did not accept the file.')), WORKER_TIMEOUT_MS);
        channel.port1.onmessage = ({ data }) => {
            if (data?.type === 'PEERLINK_DOWNLOAD_REGISTERED') finish();
            else finish(new Error(typeof data?.error === 'string' ? data.error : 'The download service worker rejected the file.'));
        };
        channel.port1.onmessageerror = () => finish(new Error('The download service worker returned an invalid response.'));
        channel.port1.start();
        try { worker.postMessage({ type: 'PEERLINK_REGISTER_DOWNLOAD', ...value }, [channel.port2]); }
        catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
}

/** Ask the active same-origin service worker to stream a completed IndexedDB file as an attachment. */
export async function downloadWithServiceWorker(fileId: string, name: string, size: number): Promise<void> {
    const worker = await controlledPeerLinkWorker();
    const token = tokenValue();
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.title = 'PeerLink file download';
    frame.setAttribute('aria-hidden', 'true');
    document.body.append(frame);

    try {
        await registerToken(worker, { token, fileId, name, size });
        const container = navigator.serviceWorker;
        await new Promise<void>((resolve, reject) => {
            let started = false;
            let settled = false;
            let timer = 0;
            const cleanup = () => {
                window.clearTimeout(timer);
                container.removeEventListener('message', onMessage);
                frame.remove();
            };
            const fail = (error: Error) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(error);
            };
            const onMessage = (event: MessageEvent) => {
                const data = event.data;
                if (!data || data.token !== token) return;
                if (data.type === 'PEERLINK_DOWNLOAD_READY') {
                    started = true;
                    window.clearTimeout(timer);
                    timer = window.setTimeout(() => fail(new Error('The large-file download did not finish. Check the browser downloads list and retry.')), DOWNLOAD_TIMEOUT_MS);
                } else if (data.type === 'PEERLINK_DOWNLOAD_FINISHED') {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    resolve();
                } else if (data.type === 'PEERLINK_DOWNLOAD_CANCELLED') {
                    fail(new DOMException('Download cancelled.', 'AbortError'));
                } else if (data.type === 'PEERLINK_DOWNLOAD_ERROR') {
                    fail(new Error(typeof data.message === 'string' ? data.message : 'The browser could not stream this file.'));
                }
            };
            container.addEventListener('message', onMessage);
            timer = window.setTimeout(() => fail(new Error(started
                ? 'The large-file download did not finish. Check the browser downloads list and retry.'
                : 'The browser did not start the large-file download. Check service-worker support and retry.')), started ? DOWNLOAD_TIMEOUT_MS : WORKER_TIMEOUT_MS);
            frame.src = new URL(`/__peerlink_download/${encodeURIComponent(token)}`, window.location.origin).href;
        });
    } catch (error) {
        frame.remove();
        throw error;
    }
}
