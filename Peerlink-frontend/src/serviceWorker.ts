const SERVICE_WORKER_TIMEOUT_MS = 30_000;

let registrationInFlight: Promise<ServiceWorkerRegistration> | null = null;

function serviceWorkerContainer(): ServiceWorkerContainer {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
        throw new Error("Remote previews require service-worker support in this browser.");
    }
    if (typeof window === "undefined" || !window.isSecureContext) {
        throw new Error("Remote previews require a secure context, such as HTTPS or localhost.");
    }
    return navigator.serviceWorker;
}

export function peerLinkServiceWorkerScope(): string {
    return new URL("/", window.location.origin).href;
}

export function peerLinkServiceWorkerScriptUrl(): string {
    const workerPath = import.meta.env.DEV ? "/dev-sw.js?dev-sw" : "/sw.js";
    return new URL(workerPath, window.location.origin).href;
}

export function isPeerLinkServiceWorker(worker: ServiceWorker | null | undefined): boolean {
    if (!worker) return false;
    try {
        const actual = new URL(worker.scriptURL);
        const expected = new URL(peerLinkServiceWorkerScriptUrl());
        // Dev builds can normalize the vite-plugin-pwa query string between loads.
        return actual.origin === expected.origin && actual.pathname === expected.pathname;
    } catch {
        return false;
    }
}

function clearInFlightRegistration(promise: Promise<ServiceWorkerRegistration>): void {
    if (registrationInFlight === promise) registrationInFlight = null;
}

export function registerPeerLinkServiceWorker(timeoutMs = SERVICE_WORKER_TIMEOUT_MS): Promise<ServiceWorkerRegistration> {
    let container: ServiceWorkerContainer;
    try {
        container = serviceWorkerContainer();
    } catch (error) {
        return Promise.reject(error);
    }
    if (registrationInFlight) return registrationInFlight;

    let registrationRequest: Promise<ServiceWorkerRegistration>;
    try {
        registrationRequest = container.register(peerLinkServiceWorkerScriptUrl(), {
            scope: "/",
            type: import.meta.env.DEV ? "module" : "classic",
        });
    } catch (error) {
        return Promise.reject(error);
    }

    let timer = 0;
    const boundedRequest = new Promise<ServiceWorkerRegistration>((resolve, reject) => {
        timer = window.setTimeout(() => {
            reject(new Error(`Service worker registration did not complete within ${timeoutMs} ms.`));
        }, Math.max(0, timeoutMs));
        void registrationRequest.then(
            (registration) => {
                window.clearTimeout(timer);
                resolve(registration);
            },
            (error: unknown) => {
                window.clearTimeout(timer);
                reject(error);
            }
        );
    });
    registrationInFlight = boundedRequest;
    void boundedRequest.then(
        () => clearInFlightRegistration(boundedRequest),
        () => clearInFlightRegistration(boundedRequest)
    );
    return boundedRequest;
}

export function isPeerLinkServiceWorkerRegistration(registration: ServiceWorkerRegistration | undefined): boolean {
    return Boolean(registration && registration.scope === peerLinkServiceWorkerScope());
}
