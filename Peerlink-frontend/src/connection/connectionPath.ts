import type { ConnectionType } from '../types';

type Candidate = { candidateType?: string; address?: string; protocol?: string };
type Pair = RTCStats & {
    localCandidateId?: string; remoteCandidateId?: string; state?: string; nominated?: boolean;
    requestsSent?: number; responsesReceived?: number; requestsReceived?: number; responsesSent?: number;
};

export function selectedIcePair(stats: RTCStatsReport): { pair: Pair; source: 'transport' | 'nominated-fallback' } | null {
    let selected: Pair | undefined;
    stats.forEach(report => {
        if (report.type === 'transport' && typeof report.selectedCandidatePairId === 'string') {
            const pair = stats.get(report.selectedCandidatePairId);
            if (pair?.type === 'candidate-pair') selected = pair;
        }
    });
    if (selected) return { pair: selected, source: 'transport' };
    stats.forEach(report => {
        if (!selected && report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated === true) selected = report;
    });
    return selected ? { pair: selected, source: 'nominated-fallback' } : null;
}

function localAddress(address?: string): boolean {
    if (!address) return false;
    const value = address.toLowerCase();
    if (value.endsWith('.local') || value === '::1' || /^(?:fc|fd)[0-9a-f]{2}:|^fe[89ab][0-9a-f]:/.test(value)) return true;
    const parts = value.split('.').map(Number);
    return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255) &&
        (parts[0] === 10 || parts[0] === 127 || parts[0] === 192 && parts[1] === 168 ||
            parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || parts[0] === 169 && parts[1] === 254);
}

export function connectionTypeFromStats(stats: RTCStatsReport): ConnectionType | null {
    const selected = selectedIcePair(stats);
    if (!selected) return null;
    const pair = selected.pair;
    const local = pair.localCandidateId ? stats.get(pair.localCandidateId) as Candidate | undefined : undefined;
    const remote = pair.remoteCandidateId ? stats.get(pair.remoteCandidateId) as Candidate | undefined : undefined;
    if (local?.candidateType === 'relay' || remote?.candidateType === 'relay') return 'relay';
    if (!local?.candidateType || !remote?.candidateType) return null;
    if (local.candidateType === 'host' && remote.candidateType === 'host' && localAddress(local.address) && localAddress(remote.address)) return 'local';
    return 'p2p';
}

export function aggregateConnectionType(types: readonly ConnectionType[]): ConnectionType {
    if (types.includes('relay')) return 'relay';
    if (types.length && types.every(type => type === 'local')) return 'local';
    return types.some(type => type === 'local' || type === 'p2p') ? 'p2p' : 'disconnected';
}

/** Address-free evidence: distinguish missing candidates from unanswered ICE checks. */
export function summarizeIcePaths(stats: RTCStatsReport) {
    const selected = selectedIcePair(stats)?.pair.id;
    const localCandidateTypes: Record<string, number> = {}, remoteCandidateTypes: Record<string, number> = {};
    const candidatePairs: Array<{ selected: boolean; localType: string | null; remoteType: string | null;
        state: string | null; nominated: boolean; requestsSent: number; responsesReceived: number;
        requestsReceived: number; responsesSent: number }> = [];
    stats.forEach(report => {
        if ((report.type === 'local-candidate' || report.type === 'remote-candidate') && typeof report.candidateType === 'string' &&
            ['host', 'srflx', 'prflx', 'relay'].includes(report.candidateType)) {
            const counts = report.type === 'local-candidate' ? localCandidateTypes : remoteCandidateTypes;
            counts[report.candidateType] = (counts[report.candidateType] || 0) + 1;
        }
        if (report.type !== 'candidate-pair' || candidatePairs.length >= 64) return;
        const local = stats.get(report.localCandidateId) as Candidate | undefined;
        const remote = stats.get(report.remoteCandidateId) as Candidate | undefined;
        const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
        candidatePairs.push({ selected: report.id === selected, localType: local?.candidateType ?? null, remoteType: remote?.candidateType ?? null,
            state: report.state ?? null, nominated: report.nominated === true, requestsSent: count(report.requestsSent),
            responsesReceived: count(report.responsesReceived), requestsReceived: count(report.requestsReceived), responsesSent: count(report.responsesSent) });
    });
    return { localCandidateTypes, remoteCandidateTypes, candidatePairs };
}

/** Follow path changes without renegotiating or interrupting file transfers. */
export function watchConnectionPath(peer: RTCPeerConnection, onPath: (type: ConnectionType) => void, isCurrent: () => boolean): () => void {
    let stopped = false, reading = false;
    let transport: RTCIceTransport | null = null;
    const refresh = async () => {
        if (stopped || reading || !isCurrent()) return;
        const next = peer.sctp?.transport.iceTransport ?? null;
        if (next !== transport) {
            transport?.removeEventListener('selectedcandidatepairchange', refresh);
            transport = next;
            transport?.addEventListener('selectedcandidatepairchange', refresh);
        }
        reading = true;
        try {
            const type = connectionTypeFromStats(await peer.getStats());
            if (!stopped && isCurrent() && type) onPath(type);
        } catch { /* A failed stats read must never close a healthy connection. */ }
        finally { reading = false; }
    };
    const timer = window.setInterval(() => void refresh(), 3000);
    peer.addEventListener('iceconnectionstatechange', refresh);
    void refresh();
    return () => {
        stopped = true; window.clearInterval(timer);
        transport?.removeEventListener('selectedcandidatepairchange', refresh);
        peer.removeEventListener('iceconnectionstatechange', refresh);
    };
}
