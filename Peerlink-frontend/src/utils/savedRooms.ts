import type { FileMetadata } from "../ProgressDB";

export type SavedRoom = {
    roomId: string;
    files: FileMetadata[];
    totalSize: number;
    lastReceivedAt: number;
};

/** Derive history from received copies, so empty visits never create room cards. */
export function collectSavedRooms(files: FileMetadata[]): SavedRoom[] {
    const rooms = new Map<string, SavedRoom>();
    for (const file of files) {
        if (!file.roomId?.trim() || file.roomType === "temporary" || file.remoteFileId ||
            file.mimeType === "send_state" || file.status !== "complete" ||
            file.receivedChunks !== file.totalChunks) continue;
        const timestamp = file.completedAt ?? file.createdAt;
        const receivedAt = Number.isFinite(timestamp) ? timestamp : 0;
        let room = rooms.get(file.roomId);
        if (!room) {
            room = { roomId: file.roomId, files: [], totalSize: 0, lastReceivedAt: 0 };
            rooms.set(file.roomId, room);
        }
        room.files.push(file);
        room.totalSize += file.size;
        room.lastReceivedAt = Math.max(room.lastReceivedAt, receivedAt);
    }
    for (const room of rooms.values()) room.files.sort((a, b) =>
        (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt));
    return [...rooms.values()].sort((a, b) => b.lastReceivedAt - a.lastReceivedAt || a.roomId.localeCompare(b.roomId));
}
