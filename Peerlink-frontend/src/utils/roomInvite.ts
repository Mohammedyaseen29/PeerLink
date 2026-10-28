import type { RoomType } from "../types";

const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface RoomInvite {
  roomId: string;
  roomType: RoomType;
}

export function isValidRoomId(roomId: string): boolean {
  return ROOM_ID_PATTERN.test(roomId);
}

export function buildRoomInviteUrl(
  roomId: string,
  roomType: RoomType,
  currentUrl: string = window.location.href,
): string | null {
  if (!isValidRoomId(roomId)) return null;

  const url = new URL(currentUrl);
  url.search = "";
  url.hash = new URLSearchParams({ room: roomId, type: roomType }).toString();
  return url.toString();
}

export function parseRoomInvite(currentUrl: string): RoomInvite | null {
  try {
    const url = new URL(currentUrl);
    if (!url.hash.startsWith("#")) return null;

    const params = new URLSearchParams(url.hash.slice(1));
    const entries = [...params.entries()];
    if (entries.length !== 2 || !params.has("room") || !params.has("type")) return null;
    if (params.getAll("room").length !== 1 || params.getAll("type").length !== 1) return null;

    const roomId = params.get("room") ?? "";
    const roomType = params.get("type");
    if (!isValidRoomId(roomId) || (roomType !== "temporary" && roomType !== "persistent")) return null;

    return { roomId, roomType };
  } catch {
    return null;
  }
}
