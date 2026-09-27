export const MAX_PREVIEW_RANGE_BYTES = 1024 * 1024;
const BROKER_TIMEOUT_MS = 25_000;
const MAX_PENDING_RANGES = 16;
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

export function waitForPreviewServiceWorker(timeoutMs = 5_000): Promise<void> {
    if (typeof navigator === "undefined" || !navigator.serviceWorker) {
        return Promise.reject(new Error("Remote previews require service-worker support in this browser."));
    }
    const serviceWorker = navigator.serviceWorker;
    if (serviceWorker.controller) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            window.clearTimeout(timer);
            serviceWorker.removeEventListener("controllerchange", checkController);
        };
        const checkController = () => {
            if (!serviceWorker.controller) return;
            cleanup();
            resolve();
        };
        const timer = window.setTimeout(() => {
            cleanup();
            reject(new Error("Remote preview service worker is not ready. Refresh the page and try again."));
        }, timeoutMs);
        serviceWorker.addEventListener("controllerchange", checkController);
        void serviceWorker.ready.then(checkController).catch(() => undefined);
        checkController();
    });
}
