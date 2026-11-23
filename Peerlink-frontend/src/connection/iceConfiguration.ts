export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
];

function validIceUrl(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 512) return false;
    const match = /^(?:stun|stuns|turn|turns):(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?(?:\?transport=(?:udp|tcp))?$/i.exec(value);
    return !!match && (!match[1] || Number(match[1]) > 0 && Number(match[1]) <= 65535);
}

export function parseIceServers(value: unknown): RTCIceServer[] {
    if (!Array.isArray(value) || !value.length || value.length > 8) throw new Error('Invalid ICE server list.');
    return value.map(entry => {
        if (!entry || typeof entry !== 'object') throw new Error('Invalid ICE server.');
        const urls = typeof entry.urls === 'string' ? [entry.urls] : entry.urls;
        if (!Array.isArray(urls) || !urls.length || urls.length > 8 || urls.some(url => !validIceUrl(url))) {
            throw new Error('Invalid ICE URL.');
        }
        for (const [key, max] of [['username', 512], ['credential', 2048]] as const) {
            if (entry[key] !== undefined && (typeof entry[key] !== 'string' || entry[key].length > max)) {
                throw new Error('Invalid ICE credentials.');
            }
        }
        if (urls.some(url => /^turns?:/i.test(url)) && (!entry.username || !entry.credential)) {
            throw new Error('TURN requires credentials.');
        }
        return { urls: [...urls], ...(entry.username !== undefined ? { username: entry.username } : {}),
            ...(entry.credential !== undefined ? { credential: entry.credential } : {}) };
    });
}

export function hasRelayServer(servers: RTCIceServer[]): boolean {
    return servers.some(server => (typeof server.urls === 'string' ? [server.urls] : server.urls).some(url => /^turns?:/i.test(url)));
}

export type FailedConnection = {
    reason: string;
    connectionState: string;
    iceConnectionState: string;
    iceGatheringState: string;
    signalingState: string;
    relayConfigured: boolean;
    localCandidates: Record<string, number>;
    remoteCandidates: Record<string, number>;
};

export function connectionFailureMessage(failure: FailedConnection): string {
    if (failure.signalingState === 'have-local-offer' || failure.signalingState === 'have-remote-offer') {
        return 'The other device did not finish answering. Keep PeerLink open on both devices and retry.';
    }
    if (!failure.relayConfigured) {
        return 'The devices could not connect directly, and the backup connection is not configured. Retry without leaving the room.';
    }
    if (failure.iceGatheringState === 'complete' && !failure.localCandidates.relay) {
        return 'The backup connection could not be reached. Keep both devices online and retry without leaving the room.';
    }
    return 'The devices could not establish a connection. Keep both pages open and retry without leaving the room.';
}
