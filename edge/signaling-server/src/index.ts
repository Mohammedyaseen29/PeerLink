import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";

type Bindings = {
  SIGNALING_ROOM: DurableObjectNamespace;
};

type RoomPeer = {
  peerId: string;
  username: string;
  avatar?: string;
  supportsReconnect: boolean;
};

type RoomSession = RoomPeer & {
  protocolVersion: 2;
  roomId: string;
  roomType: "persistent" | "temporary";
};

type LegacyRoomSession = {
  roomId: string;
  username: string;
  roomType: "persistent" | "temporary";
  avatar?: string;
};

type AnyRoomSession = RoomSession | LegacyRoomSession;

const PROTOCOL_VERSION = 2;
const MAX_ROOM_ID_LENGTH = 128;
const MAX_ROOM_SESSIONS = 2;
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const app = new Hono<{ Bindings: Bindings }>();

app.get("/health", (c) => c.json({ message: "iam alive" }));

app.all("*", async (c) => {
  if (c.req.header("upgrade") === "websocket") {
    // All sockets share the router object; room membership stays in attachments.
    const id = c.env.SIGNALING_ROOM.idFromName("global-router");
    const stub = c.env.SIGNALING_ROOM.get(id);
    return stub.fetch(c.req.raw);
  }
  return c.text("Not a websocket request", 400);
});

export class SignalingRoom extends DurableObject {
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
  }

  async fetch(request: Request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;

    let data: unknown;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return;

    const messageData = data as Record<string, unknown>;
    const { type, roomId, payload, username, avatar, roomType, protocolVersion, targetPeerId, linkId } = messageData;

    if (type === "join") {
      if (protocolVersion === PROTOCOL_VERSION) {
        await this.joinV2(ws, roomId, username, avatar, roomType, messageData.supportsReconnect);
      } else if (protocolVersion === undefined) {
        this.joinLegacy(ws, roomId, username, roomType);
      } else {
        this.rejectProtocol(ws);
      }
      return;
    }

    const session = this.getSession(ws);
    if (!session) return;

    if ("protocolVersion" in session) {
      switch (type) {
        case "offer":
        case "answer":
        case "ice_candidate":
          this.forwardToPeer(session, type, payload, targetPeerId, linkId);
          break;
        case "reconnect":
        case "reconnect_request":
          this.forwardToPeer(session, type, payload, targetPeerId, linkId);
          break;
        case "heartbeat":
          this.send(ws, { type: "heartbeat_ack", roomId: session.roomId, peerId: session.peerId });
          break;
        case "profile_update":
          this.updateProfile(ws, session, messageData);
          break;
        case "sync":
          this.send(ws, {
            type: "room_state",
            roomId: session.roomId,
            peerId: session.peerId,
            peers: this.getRoomPeers(session.roomId, session.peerId),
          });
          break;
        case "leave":
          this.leave(ws, session);
          break;
      }
      return;
    }

    // Compatibility bridge for already deployed unversioned two-peer clients.
    switch (type) {
      case "offer":
      case "answer":
      case "ice_candidate":
        this.broadcastToLegacyRoom(session.roomId, { type, payload, roomId: session.roomId }, ws);
        break;
      case "leave":
        this.leaveLegacy(ws, session);
        break;
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string) {
    const responseCode = code === 1005 || code === 1006 || code === 1015 ? 1000 : code;
    this.detachSocket(ws, responseCode, reason || "Closing handshake complete");
  }

  webSocketError(ws: WebSocket, _error: unknown) {
    this.detachSocket(ws, 1011, "WebSocket error");
  }

  private async joinV2(ws: WebSocket, requestedRoomId: unknown, requestedUsername: unknown, requestedAvatar: unknown,
    requestedRoomType: unknown, supportsReconnect: unknown) {
    const roomId = typeof requestedRoomId === "string" ? requestedRoomId.trim() : "";
    const existingSession = this.getSession(ws);

    if (existingSession) {
      if ("protocolVersion" in existingSession && roomId === existingSession.roomId) {
        this.send(ws, this.joinedMessage(existingSession));
      } else {
        this.send(ws, { type: "error", code: "already_joined" });
      }
      return;
    }

    if (!this.isValidRoomId(roomId)) {
      this.send(ws, { type: "error", code: "invalid_room_id" });
      if (ws.readyState === 1) ws.close(4002, "Invalid room ID");
      return;
    }

    if (this.countLegacyRoomSessions(roomId) > 0) {
      this.rejectProtocol(ws);
      return;
    }
    if (this.countRoomSessions(roomId) >= MAX_ROOM_SESSIONS) {
      this.send(ws, { type: "room_full", roomId, maxPeers: MAX_ROOM_SESSIONS });
      if (ws.readyState === 1) ws.close(4001, "Room full");
      return;
    }

    const existingPeers = this.getRoomPeers(roomId);
    const roomType = existingPeers[0]
      ? this.getSessionByPeerId(existingPeers[0].peerId)?.roomType ?? "persistent"
      : requestedRoomType === "temporary" ? "temporary" : "persistent";
    const session: RoomSession = {
      protocolVersion: PROTOCOL_VERSION,
      peerId: crypto.randomUUID(),
      roomId,
      roomType,
      username: this.cleanUsername(requestedUsername),
      supportsReconnect: supportsReconnect === true,
      ...(typeof requestedAvatar === "string" && requestedAvatar.trim()
        ? { avatar: requestedAvatar.trim().slice(0, 64) }
        : {}),
    };
    ws.serializeAttachment(session);

    if (!this.send(ws, {
      type: "joined",
      protocolVersion: PROTOCOL_VERSION,
      peerId: session.peerId,
      roomId,
      roomType,
      maxPeers: MAX_ROOM_SESSIONS,
      peers: existingPeers,
    }, false)) return;
    this.broadcastToRoom(roomId, { type: "peer_joined", roomId, peer: this.publicPeer(session) }, ws);
  }

  private joinLegacy(ws: WebSocket, requestedRoomId: unknown, requestedUsername: unknown, requestedRoomType: unknown) {
    const roomId = typeof requestedRoomId === "string" ? requestedRoomId.trim() : "";
    const existingSession = this.getSession(ws);
    if (existingSession) {
      if (!("protocolVersion" in existingSession) && roomId === existingSession.roomId) {
        this.send(ws, {
          type: "joined",
          roomId: existingSession.roomId,
          roomType: existingSession.roomType,
          peerCount: this.countLegacyRoomSessions(existingSession.roomId, ws),
        });
      } else {
        this.send(ws, { type: "error", code: "already_joined" });
      }
      return;
    }

    if (!this.isValidRoomId(roomId)) {
      this.send(ws, { type: "error", code: "invalid_room_id" });
      if (ws.readyState === 1) ws.close(4002, "Invalid room ID");
      return;
    }
    if (this.countRoomSessions(roomId) > 0) {
      this.broadcastToRoom(roomId, {
        type: "protocol_conflict",
        roomId,
        code: "incompatible_protocol",
      }, ws);
      this.rejectProtocol(ws);
      return;
    }
    if (this.countLegacyRoomSessions(roomId) >= 2) {
      this.send(ws, { type: "room_full", roomId });
      if (ws.readyState === 1) ws.close(4001, "Room full");
      return;
    }

    const firstPeer = this.ctx.getWebSockets().find((client) => {
      if (client === ws || client.readyState !== 1) return false;
      const session = this.getSession(client);
      return session && !("protocolVersion" in session) && session.roomId === roomId;
    });
    const firstSession = firstPeer ? this.getSession(firstPeer) : undefined;
    const session: LegacyRoomSession = {
      roomId,
      roomType: firstSession && !("protocolVersion" in firstSession)
        ? firstSession.roomType
        : requestedRoomType === "temporary" ? "temporary" : "persistent",
      username: this.cleanUsername(requestedUsername),
    };
    ws.serializeAttachment(session);

    if (!this.send(ws, {
      type: "joined",
      roomId,
      roomType: session.roomType,
      peerCount: this.countLegacyRoomSessions(roomId, ws),
    }, false)) return;
    this.broadcastToLegacyRoom(roomId, { type: "peer_joined", roomId, username: session.username }, ws);
  }

  private rejectProtocol(ws: WebSocket) {
    this.send(ws, {
      type: "error",
      code: "incompatible_protocol",
      expectedProtocolVersion: PROTOCOL_VERSION,
      message: "This room uses a different PeerLink version. Everyone must update or reload the app, leave the room, and rejoin.",
    });
    if (ws.readyState === 1) ws.close(4003, "Incompatible protocol");
  }

  private isValidRoomId(roomId: string) {
    return roomId.length > 0 && roomId.length <= MAX_ROOM_ID_LENGTH && ROOM_ID_PATTERN.test(roomId);
  }

  private cleanUsername(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 64) : "Anonymous";
  }

  private validProfileUsername(value: unknown) {
    if (typeof value !== "string") return null;
    const username = value.trim();
    return username.length >= 1 && username.length <= 64 && !/[\u0000-\u001f\u007f-\u009f]/.test(username) ? username : null;
  }

  private updateProfile(ws: WebSocket, session: RoomSession, message: Record<string, unknown>) {
    const hasUsername = Object.prototype.hasOwnProperty.call(message, "username");
    const hasAvatar = Object.prototype.hasOwnProperty.call(message, "avatar");
    if (!hasUsername && !hasAvatar) {
      this.send(ws, { type: "profile_error", roomId: session.roomId, peerId: session.peerId,
        code: "empty_profile", message: "Choose a name or avatar before syncing your profile." });
      return;
    }

    const username = hasUsername ? this.validProfileUsername(message.username) : session.username;
    if (!username) {
      this.send(ws, { type: "profile_error", roomId: session.roomId, peerId: session.peerId,
        code: "invalid_username", message: "Name must be 1–64 characters and cannot be blank or contain control characters." });
      return;
    }
    if (hasAvatar && typeof message.avatar !== "string") {
      this.send(ws, { type: "profile_error", roomId: session.roomId, peerId: session.peerId,
        code: "invalid_avatar", message: "Choose a valid avatar before syncing your profile." });
      return;
    }
    const avatar = hasAvatar
      ? (typeof message.avatar === "string" && message.avatar.trim() ? message.avatar.trim().slice(0, 64) : undefined)
      : session.avatar;
    const updated: RoomSession = { ...session, username, ...(avatar ? { avatar } : { avatar: undefined }) };
    try {
      ws.serializeAttachment(updated);
    } catch {
      this.send(ws, { type: "profile_error", roomId: session.roomId, peerId: session.peerId,
        code: "update_failed", message: "The room could not save your profile update." });
      return;
    }
    if (!this.send(ws, { type: "profile_updated", roomId: updated.roomId, peerId: updated.peerId,
      peer: this.publicPeer(updated) })) return;
    this.broadcastToRoom(updated.roomId, { type: "peer_updated", roomId: updated.roomId, peer: this.publicPeer(updated) }, ws);
  }

  private joinedMessage(session: RoomSession) {
    return {
      type: "joined",
      protocolVersion: PROTOCOL_VERSION,
      peerId: session.peerId,
      roomId: session.roomId,
      roomType: session.roomType,
      maxPeers: MAX_ROOM_SESSIONS,
      supportsReconnect: session.supportsReconnect,
      peers: this.getRoomPeers(session.roomId, session.peerId),
    };
  }

  private forwardToPeer(
    sender: RoomSession,
    type: "offer" | "answer" | "ice_candidate" | "reconnect" | "reconnect_request",
    payload: unknown,
    targetPeerId: unknown,
    linkId: unknown,
  ) {
    if (typeof targetPeerId !== "string" || targetPeerId.length === 0) return;
    const target = this.ctx.getWebSockets().find((client) => {
      if (client.readyState !== 1) return false;
      const session = this.getSession(client);
      return session && "protocolVersion" in session && session.roomId === sender.roomId && session.peerId === targetPeerId;
    });
    if (!target) return;
    this.send(target, { type, roomId: sender.roomId, payload, fromPeerId: sender.peerId, fromPeer: this.publicPeer(sender),
      ...(typeof linkId === "string" ? { linkId } : {}) });
  }

  async alarm() {
    // Consume alarms scheduled by a previous worker without evicting or rescheduling room members.
  }

  private leave(ws: WebSocket, session: RoomSession) {
    this.clearSession(ws);
    this.broadcastToRoom(session.roomId, { type: "peer_left", roomId: session.roomId, peerId: session.peerId }, ws);
  }

  private leaveLegacy(ws: WebSocket, session: LegacyRoomSession) {
    this.clearSession(ws);
    this.broadcastToLegacyRoom(session.roomId, { type: "peer_left", roomId: session.roomId }, ws);
  }

  private clearSession(ws: WebSocket) {
    try {
      ws.serializeAttachment(null);
    } catch {
      // The socket may already be closing.
    }
  }

  private detachSocket(ws: WebSocket, code: number, reason: string, announce = true) {
    const session = this.getSession(ws);
    this.clearSession(ws);
    this.closeSocket(ws, code, reason);
    if (!session || !announce) return;
    this.broadcastSessionLeft(session, ws);
  }

  private broadcastSessionLeft(session: AnyRoomSession, exceptWs: WebSocket) {
    if ("protocolVersion" in session) {
      this.broadcastToRoom(session.roomId, { type: "peer_left", roomId: session.roomId, peerId: session.peerId }, exceptWs);
    } else {
      this.broadcastToLegacyRoom(session.roomId, { type: "peer_left", roomId: session.roomId }, exceptWs);
    }
  }

  private closeSocket(ws: WebSocket, code: number, reason: string) {
    try {
      ws.close(code, reason);
    } catch {
      // The socket may already be closed.
    }
  }

  private getSession(ws: WebSocket): AnyRoomSession | undefined {
    try {
      const attachment: unknown = ws.deserializeAttachment();
      if (!attachment || typeof attachment !== "object") return undefined;
      const value = attachment as Partial<RoomSession>;
      if (!this.isValidRoomId(typeof value.roomId === "string" ? value.roomId : "") || typeof value.username !== "string") return undefined;
      const roomType = value.roomType === "temporary" ? "temporary" : "persistent";
      if (value.protocolVersion === PROTOCOL_VERSION && typeof value.peerId === "string") {
        return {
          protocolVersion: PROTOCOL_VERSION,
          peerId: value.peerId,
          roomId: value.roomId!,
          username: value.username,
          roomType,
          supportsReconnect: value.supportsReconnect === true,
          ...(typeof value.avatar === "string" ? { avatar: value.avatar } : {}),
        };
      }
      // Versionless attachments belong to the deployed legacy two-peer protocol.
      if (value.protocolVersion === undefined) {
        return { roomId: value.roomId!, username: value.username, roomType };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private getSessionByPeerId(peerId: string) {
    for (const client of this.ctx.getWebSockets()) {
      const session = this.getSession(client);
      if (session && "protocolVersion" in session && session.peerId === peerId) return session;
    }
    return undefined;
  }

  private publicPeer(session: RoomSession): RoomPeer {
    return {
      peerId: session.peerId,
      username: session.username,
      ...(session.avatar ? { avatar: session.avatar } : {}),
      supportsReconnect: session.supportsReconnect,
    };
  }

  private getRoomPeers(roomId: string, exceptPeerId?: string): RoomPeer[] {
    return this.ctx.getWebSockets()
      .filter((client) => client.readyState === 1)
      .map((client) => this.getSession(client))
      .filter((session): session is RoomSession => Boolean(session && "protocolVersion" in session && session.roomId === roomId && session.peerId !== exceptPeerId))
      .map((session) => this.publicPeer(session));
  }

  private countRoomSessions(roomId: string) {
    return this.getRoomPeers(roomId).length;
  }

  private countLegacyRoomSessions(roomId: string, exceptWs?: WebSocket) {
    let count = 0;
    for (const client of this.ctx.getWebSockets()) {
      if (client !== exceptWs && client.readyState === 1) {
        const session = this.getSession(client);
        if (session && !("protocolVersion" in session) && session.roomId === roomId) count++;
      }
    }
    return count;
  }

  private send(ws: WebSocket, data: Record<string, unknown>, announceFailure = true) {
    if (ws.readyState !== 1) {
      if (this.getSession(ws)) this.detachSocket(ws, 1011, "Signaling socket is not open", announceFailure);
      return false;
    }
    try {
      ws.send(JSON.stringify(data));
      return true;
    } catch {
      this.detachSocket(ws, 1011, "Signaling delivery failed", announceFailure);
      return false;
    }
  }

  private broadcastToRoom(roomId: string, data: Record<string, unknown>, exceptWs: WebSocket) {
    this.broadcastSafely(roomId, data, exceptWs, false);
  }

  private broadcastToLegacyRoom(roomId: string, data: Record<string, unknown>, exceptWs: WebSocket) {
    this.broadcastSafely(roomId, data, exceptWs, true);
  }

  private broadcastSafely(roomId: string, data: Record<string, unknown>, exceptWs: WebSocket, legacy: boolean) {
    const pending = [{ data, exceptWs, legacy }];
    while (pending.length > 0) {
      const current = pending.shift()!;
      const message = JSON.stringify(current.data);
      for (const client of this.ctx.getWebSockets()) {
        if (client === current.exceptWs || client.readyState !== 1) continue;
        const session = this.getSession(client);
        if (!session || session.roomId !== roomId || ("protocolVersion" in session) === current.legacy) continue;
        try {
          client.send(message);
        } catch {
          this.clearSession(client);
          this.closeSocket(client, 1011, "Signaling delivery failed");
          const leftMessage = "protocolVersion" in session
            ? { type: "peer_left", roomId, peerId: session.peerId }
            : { type: "peer_left", roomId };
          pending.push({ data: leftMessage, exceptWs: client, legacy: !("protocolVersion" in session) });
        }
      }
    }
  }
}

export default app;
