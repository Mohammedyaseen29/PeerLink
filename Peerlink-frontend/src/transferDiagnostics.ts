export type LocalTransferDiagnostic = {
    at: number;
    event: string;
    code?: string;
    details?: Record<string, string | number | boolean | null>;
};

const MAX_DIAGNOSTIC_EVENTS = 100;
const recentEvents: LocalTransferDiagnostic[] = [];

/**
 * Keep a small local-only diagnostic trail. Callers should pass state names,
 * counts and error codes only; filenames, SDP, ICE addresses and credentials
 * must never be recorded here.
 */
export function recordTransferDiagnostic(
    event: string,
    code?: string,
    details?: Record<string, string | number | boolean | null>,
): void {
    const entry: LocalTransferDiagnostic = {
        at: Date.now(),
        event: event.slice(0, 64),
        ...(code ? { code: code.slice(0, 64) } : {}),
        ...(details ? { details: { ...details } } : {}),
    };
    recentEvents.push(entry);
    if (recentEvents.length > MAX_DIAGNOSTIC_EVENTS) recentEvents.splice(0, recentEvents.length - MAX_DIAGNOSTIC_EVENTS);

    // State transitions and failures only. No per-packet/per-chunk logging.
    console.info('[PeerLink diagnostics]', entry);
}

export function getRecentDiagnostics(): LocalTransferDiagnostic[] {
    return recentEvents.map(entry => ({ ...entry, details: entry.details ? { ...entry.details } : undefined }));
}
