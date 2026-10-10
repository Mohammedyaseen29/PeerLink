import {
    isPeerLinkServiceWorker,
    isPeerLinkServiceWorkerRegistration,
    peerLinkServiceWorkerScope,
    registerPeerLinkServiceWorker,
} from "../serviceWorker";

export const MAX_PREVIEW_RANGE_BYTES = 1024 * 1024;
const BROKER_TIMEOUT_MS = 25_000;
const MAX_PENDING_RANGES = 16;
const PREVIEW_SERVICE_WORKER_TIMEOUT_MS = 30_000;
const CLAIM_CLIENT_MESSAGE = "PEERLINK_CLAIM_CLIENT";
const CLAIM_CLIENT_ACK = "PEERLINK_CLAIM_CLIENT_ACK";
const CLAIM_CLIENT_ERROR = "PEERLINK_CLAIM_CLIENT_ERROR";
const MIME_TYPE_PATTERN = /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+(?:\s*;\s*[\w!#$&^_.+-]+=(?:"[^"\r\n]*"|[\w!#$&^_.+-]+))*$/;

export type PreviewRangeRequest = {
    requestId: string;
    fileId: string;
    start: number;
    end: number;
};

export type PreviewRangeResponse = {
    size: number;
    mimeType: string;
    data: ArrayBuffer;
};

type PendingRange = {
    request: PreviewRangeRequest;
    port: MessagePort;
    controller: AbortController;
    timer: number;
    settled: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function validIdentifier(value: unknown): value is string {
    return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function validateRequest(value: unknown): PreviewRangeRequest | null {
    if (!isRecord(value) || value.type !== "peerlink_preview_range") return null;
    const { requestId, fileId, start, end } = value;
    if (!validIdentifier(requestId) || !validIdentifier(fileId) ||
        typeof start !== "number" || !Number.isSafeInteger(start) || start < 0 ||
        typeof end !== "number" || !Number.isSafeInteger(end) || end < start ||
        end - start + 1 > MAX_PREVIEW_RANGE_BYTES) return null;
    return { requestId, fileId, start, end };
}

function validateResponse(response: PreviewRangeResponse, request: PreviewRangeRequest): boolean {
    if (!Number.isSafeInteger(response.size) || response.size < 0 ||
        typeof response.mimeType !== "string" || response.mimeType.length > 255 || !MIME_TYPE_PATTERN.test(response.mimeType) ||
        !(response.data instanceof ArrayBuffer) || response.data.byteLength > MAX_PREVIEW_RANGE_BYTES) return false;
    const expected = request.start >= response.size
        ? 0
        : Math.min(request.end, response.size - 1) - request.start + 1;
    return response.data.byteLength === expected;
}

/** Bridges service-worker range requests to the active peer range provider. */
export class RangeBroker {
    private readonly pending = new Map<string, PendingRange>();
    private readonly provideRange: (request: PreviewRangeRequest, signal: AbortSignal) => Promise<PreviewRangeResponse>;
    private readonly onError?: (message: string) => void;
    private started = false;
    private disposed = false;

    constructor(
        provideRange: (request: PreviewRangeRequest, signal: AbortSignal) => Promise<PreviewRangeResponse>,
        onError?: (message: string) => void
    ) {
        this.provideRange = provideRange;
        this.onError = onError;
    }

    start(): void {
        if (this.started || this.disposed || typeof navigator === "undefined" || !navigator.serviceWorker) return;
        navigator.serviceWorker.addEventListener("message", this.onMessage);
        this.started = true;
    }

    cancelFile(fileId: string, reason = "Preview closed"): void {
        for (const pending of [...this.pending.values()]) {
            if (pending.request.fileId === fileId) this.fail(pending, reason, true);
        }
    }

    cancelAll(reason = "Preview connection closed"): void {
        for (const pending of [...this.pending.values()]) this.fail(pending, reason, true);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.started && typeof navigator !== "undefined" && navigator.serviceWorker) {
            navigator.serviceWorker.removeEventListener("message", this.onMessage);
        }
        this.started = false;
        this.cancelAll("Preview connection closed");
    }

    private onMessage = (event: MessageEvent<unknown>): void => {
        const data = event.data;
        if (!isRecord(data) || data.type !== "peerlink_preview_range") return;
        const port = event.ports[0];
        if (!port) return;
        const request = validateRequest(data);
        if (!request) {
            this.replyError(port, "Invalid preview range request");
            return;
        }
        if (this.disposed || this.pending.size >= MAX_PENDING_RANGES || this.pending.has(request.requestId)) {
            this.replyError(port, this.disposed ? "Preview broker is closed" : "Too many preview range requests");
            return;
        }

        const pending: PendingRange = {
            request,
            port,
            controller: new AbortController(),
            timer: window.setTimeout(() => this.fail(pending, "Preview range request timed out", true), BROKER_TIMEOUT_MS),
            settled: false,
        };
        this.pending.set(request.requestId, pending);
        port.start();
        void this.provideRange(request, pending.controller.signal).then((response) => {
            if (pending.settled) return;
            if (!validateResponse(response, request)) {
                this.onError?.("Peer returned an invalid preview range.");
                this.fail(pending, "Peer returned an invalid preview range", true);
                return;
            }
            this.finish(pending);
            try {
                port.postMessage(response, [response.data]);
            } catch {
                // The worker may have abandoned this response.
            } finally {
                try { port.close(); } catch { /* Port already closed. */ }
            }
        }).catch((error: unknown) => {
            const failure = error instanceof Error ? error : new Error(String(error));
            if (failure.name !== "AbortError") this.onError?.(failure.message);
            this.fail(pending, failure.message, true);
        });
    };

    private finish(pending: PendingRange): void {
        if (pending.settled) return;
        pending.settled = true;
        window.clearTimeout(pending.timer);
        this.pending.delete(pending.request.requestId);
        pending.port.onmessage = null;
        pending.port.onmessageerror = null;
    }

    private fail(pending: PendingRange, reason: string, abort: boolean): void {
        if (pending.settled) return;
        this.finish(pending);
        if (abort) pending.controller.abort(reason);
        try { pending.port.postMessage({ error: reason.slice(0, 512) }); } catch { /* The page or worker has closed the port. */ }
        finally { try { pending.port.close(); } catch { /* Port already closed. */ } }
    }

    private replyError(port: MessagePort, reason: string): void {
        try { port.postMessage({ error: reason.slice(0, 512) }); } catch { /* The worker has closed the port. */ }
        try { port.close(); } catch { /* Port already closed. */ }
    }
}

export function createRemotePreviewUrl(fileId: string): string {
    return new URL(`/__peerlink_preview/${encodeURIComponent(fileId)}`, window.location.origin).toString();
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function withinTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    if (timeoutMs <= 0) return Promise.reject(new Error(message));
    return new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
        void promise.then(
            (value) => {
                window.clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                window.clearTimeout(timer);
                reject(error);
            }
        );
    });
}

function requestWorkerToClaimClient(worker: ServiceWorker, signal: AbortSignal, timeoutMs: number): Promise<void> {
    if (typeof MessageChannel === "undefined") {
        return Promise.reject(new Error("This browser cannot request service-worker control for remote previews."));
    }
    if (timeoutMs <= 0) return Promise.reject(new Error("The service worker did not acknowledge the control request before the timeout."));

    return new Promise<void>((resolve, reject) => {
        const channel = new MessageChannel();
        const port = channel.port1;
        let settled = false;
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            port.onmessage = null;
            port.onmessageerror = null;
            try { port.close(); } catch { /* The worker may already have closed the channel. */ }
            try { channel.port2.close(); } catch { /* The channel may already be transferred. */ }
            if (error) reject(error);
            else resolve();
        };
        const onAbort = () => finish(new Error("The service-worker control request was canceled."));
        const timer = window.setTimeout(() => {
            finish(new Error("The active service worker did not acknowledge the request to control this page."));
        }, timeoutMs);

        port.onmessage = (event: MessageEvent<unknown>) => {
            if (!isRecord(event.data)) {
                finish(new Error("The active service worker returned an invalid control response."));
                return;
            }
            if (event.data.type === CLAIM_CLIENT_ACK) {
                finish();
                return;
            }
            if (event.data.type === CLAIM_CLIENT_ERROR) {
                finish(new Error(`The active service worker could not claim this page: ${String(event.data.error ?? "unknown error")}`));
                return;
            }
            finish(new Error("The active service worker returned an unexpected control response."));
        };
        port.onmessageerror = () => finish(new Error("The active service worker returned an unreadable control response."));
        port.start();
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
            onAbort();
            return;
        }
        try {
            worker.postMessage({ type: CLAIM_CLIENT_MESSAGE }, [channel.port2]);
        } catch (error) {
            finish(new Error(`Unable to request service-worker control: ${errorMessage(error)}`));
        }
    });
}

function waitForMatchingController(
    serviceWorker: ServiceWorkerContainer,
    registration: ServiceWorkerRegistration,
    deadline: number
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let settled = false;
        let requestedClaimFrom: ServiceWorker | null = null;
        let claimAcknowledged = false;
        const observedWorkers = new Set<ServiceWorker>();
        const claimAbortController = new AbortController();

        const remainingMs = () => Math.max(0, deadline - Date.now());
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            serviceWorker.removeEventListener("controllerchange", checkController);
            registration.removeEventListener("updatefound", onUpdateFound);
            for (const worker of observedWorkers) worker.removeEventListener("statechange", checkController);
            claimAbortController.abort();
            if (error) reject(error);
            else resolve();
        };
        const onTimeout = () => {
            if (claimAcknowledged) {
                finish(new Error("The active service worker acknowledged the control request, but this page is still not controlled by it."));
            } else if (requestedClaimFrom) {
                finish(new Error("The active service worker did not acknowledge the request to control this page."));
            } else if (!registration.active) {
                finish(new Error("The service worker did not activate before the remote-preview readiness timeout."));
            } else {
                finish(new Error("The registered service worker did not become the active controller for this page."));
            }
        };
        const timer = window.setTimeout(onTimeout, remainingMs());
        const trackWorker = (worker: ServiceWorker | null) => {
            if (settled || !worker || observedWorkers.has(worker)) return;
            observedWorkers.add(worker);
            worker.addEventListener("statechange", checkController);
        };
        const onUpdateFound = () => {
            if (settled) return;
            trackWorker(registration.installing);
            checkController();
        };
        const checkController = () => {
            if (settled) return;
            if (serviceWorker.controller === registration.active && isPeerLinkServiceWorker(serviceWorker.controller)) {
                finish();
                return;
            }

            trackWorker(registration.installing);
            trackWorker(registration.waiting);
            trackWorker(registration.active);

            const activeWorker = registration.active;
            if (!activeWorker || activeWorker.state !== "activated" || !isPeerLinkServiceWorker(activeWorker)) {
                const installationFailed = !activeWorker && !registration.installing && !registration.waiting &&
                    [...observedWorkers].some((worker) => worker.state === "redundant");
                if (installationFailed) {
                    finish(new Error("The service-worker installation failed before an active worker was available."));
                }
                return;
            }

            if (requestedClaimFrom === activeWorker) return;
            requestedClaimFrom = activeWorker;
            void requestWorkerToClaimClient(activeWorker, claimAbortController.signal, remainingMs()).then(
                () => {
                    claimAcknowledged = true;
                    checkController();
                },
                (error: unknown) => finish(error instanceof Error ? error : new Error(String(error)))
            );
        };

        serviceWorker.addEventListener("controllerchange", checkController);
        registration.addEventListener("updatefound", onUpdateFound);
        trackWorker(registration.installing);
        trackWorker(registration.waiting);
        trackWorker(registration.active);
        checkController();
    });
}

export async function waitForPreviewServiceWorker(timeoutMs = PREVIEW_SERVICE_WORKER_TIMEOUT_MS): Promise<void> {
    if (typeof navigator === "undefined" || !navigator.serviceWorker) {
        return Promise.reject(new Error("Remote previews require service-worker support in this browser."));
    }
    if (typeof window === "undefined" || !window.isSecureContext) {
        return Promise.reject(new Error("Remote previews require a secure context, such as HTTPS or localhost."));
    }

    const serviceWorker = navigator.serviceWorker;
    const deadline = Date.now() + timeoutMs;
    const remainingMs = () => Math.max(0, deadline - Date.now());
    const expectedScope = peerLinkServiceWorkerScope();

    if (isPeerLinkServiceWorker(serviceWorker.controller)) {
        const existingRegistration = await withinTimeout(
            serviceWorker.getRegistration(expectedScope),
            remainingMs(),
            "Unable to verify the remote-preview service-worker registration before the readiness timeout."
        );
        if (
            existingRegistration &&
            isPeerLinkServiceWorkerRegistration(existingRegistration) &&
            existingRegistration.active === serviceWorker.controller &&
            isPeerLinkServiceWorker(existingRegistration.active)
        ) {
            return;
        }
    }

    let registration: ServiceWorkerRegistration;
    try {
        registration = await withinTimeout(
            registerPeerLinkServiceWorker(remainingMs()),
            remainingMs(),
            "Service-worker registration did not complete before the remote-preview readiness timeout."
        );
    } catch (error) {
        throw new Error(`Unable to register the remote-preview service worker: ${errorMessage(error)}`, { cause: error });
    }
    if (!isPeerLinkServiceWorkerRegistration(registration)) {
        throw new Error(`The remote-preview service worker registered an unexpected scope: ${registration.scope}`);
    }

    await waitForMatchingController(serviceWorker, registration, deadline);
}
