import type { FileMetadata } from "../ProgressDB";

export function isReceivedCopy(local: FileMetadata, remote: FileMetadata): boolean {
    return local.status === "complete" && local.receivedChunks === local.totalChunks &&
        Boolean(local.sourceFileId && local.sourcePeerId) && local.sourcePeerId === remote.sourcePeerId &&
        remote.remoteFileId === `q-${local.sourceFileId}` && local.size === remote.size &&
        local.name === remote.name && (local.path || "") === (remote.path || "");
}

/** Match transfer identities, never just names: different files may share a name and size. */
export function filesOnlyOnPeer(files: FileMetadata[], onlineFiles: FileMetadata[]): FileMetadata[] {
    const received = new Map<string, FileMetadata[]>();
    for (const file of files) {
        if (!file.sourcePeerId || !file.sourceFileId) continue;
        const key = `${file.sourcePeerId}:${file.sourceFileId}`;
        const existing = received.get(key) ?? [];
        existing.push(file);
        received.set(key, existing);
    }
    return onlineFiles.filter(remote => {
        if (!remote.sourcePeerId || !remote.remoteFileId?.startsWith("q-")) return true;
        const key = `${remote.sourcePeerId}:${remote.remoteFileId.slice(2)}`;
        return !received.get(key)?.some(local => isReceivedCopy(local, remote));
    });
}
