import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";

type Bindings = {
  SIGNALING_ROOM: DurableObjectNamespace;
};

type RoomPeer = {
  peerId: string;
  username: string;
  avatar?: string;
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
const MAX_ROOM_SESSIONS = 4;
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
    const { type, roomId, payload, username, avatar, roomType, protocolVersion, targetPeerId } = messageData;

    if (type === "join") {
      if (protocolVersion === PROTOCOL_VERSION) {
        this.joinV2(ws, roomId, username, avatar, roomType);
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
          this.forwardToPeer(session, type, payload, targetPeerId);
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

  webSocketClose(ws: WebSocket) {
    const session = this.getSession(ws);
    if (!session) return;

    this.clearSession(ws);
    if ("protocolVersion" in session) {
      this.broadcastToRoom(session.roomId, { type: "peer_left", roomId: session.roomId, peerId: session.peerId }, ws);
    } else {
      this.broadcastToLegacyRoom(session.roomId, { type: "peer_left", roomId: session.roomId }, ws);
    }
  }

  private joinV2(ws: WebSocket, requestedRoomId: unknown, requestedUsername: unknown, requestedAvatar: unknown, requestedRoomType: unknown) {
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
      ...(typeof requestedAvatar === "string" && requestedAvatar.trim()
        ? { avatar: requestedAvatar.trim().slice(0, 64) }
        : {}),
    };
    ws.serializeAttachment(session);

    this.send(ws, {
      type: "joined",
      protocolVersion: PROTOCOL_VERSION,
      peerId: session.peerId,
      roomId,
      roomType,
      maxPeers: MAX_ROOM_SESSIONS,
      peers: existingPeers,
    });
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

    this.send(ws, {
      type: "joined",
      roomId,
      roomType: session.roomType,
      peerCount: this.countLegacyRoomSessions(roomId, ws),
    });
    this.broadcastToLegacyRoom(roomId, { type: "peer_joined", roomId, username: session.username }, ws);
  }

  private rejectProtocol(ws: WebSocket) {
    this.send(ws, {
      type: "error",
      code: "incompatible_protocol",
      expectedProtocolVersion: PROTOCOL_VERSION,
      message: "This room uses a different PeerLink version. Update the app or use a new room ID.",
    });
    if (ws.readyState === 1) ws.close(4003, "Incompatible protocol");
  }

  private isValidRoomId(roomId: string) {
    return roomId.length > 0 && roomId.length <= MAX_ROOM_ID_LENGTH && ROOM_ID_PATTERN.test(roomId);
  }

  private cleanUsername(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 64) : "Anonymous";
  }

  private joinedMessage(session: RoomSession) {
    return {
      type: "joined",
      protocolVersion: PROTOCOL_VERSION,
      peerId: session.peerId,
      roomId: session.roomId,
      roomType: session.roomType,
      maxPeers: MAX_ROOM_SESSIONS,
      peers: this.getRoomPeers(session.roomId, session.peerId),
    };
  }

  private forwardToPeer(
    sender: RoomSession,
    type: "offer" | "answer" | "ice_candidate",
    payload: unknown,
    targetPeerId: unknown,
  ) {
    if (typeof targetPeerId !== "string" || targetPeerId.length === 0) return;
    const target = this.ctx.getWebSockets().find((client) => {
      if (client.readyState !== 1) return false;
      const session = this.getSession(client);
      return session && "protocolVersion" in session && session.roomId === sender.roomId && session.peerId === targetPeerId;
    });
    if (!target) return;
    this.send(target, { type, roomId: sender.roomId, payload, fromPeerId: sender.peerId });
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

  private send(ws: WebSocket, data: Record<string, unknown>) {
    if (ws.readyState === 1) ws.send(JSON.stringify(data));
  }

  private broadcastToRoom(roomId: string, data: Record<string, unknown>, exceptWs: WebSocket) {
    const message = JSON.stringify(data);
    for (const client of this.ctx.getWebSockets()) {
      const session = this.getSession(client);
      if (client !== exceptWs && client.readyState === 1 && session && "protocolVersion" in session && session.roomId === roomId) {
        client.send(message);
      }
    }
  }

  private broadcastToLegacyRoom(roomId: string, data: Record<string, unknown>, exceptWs: WebSocket) {
    const message = JSON.stringify(data);
    for (const client of this.ctx.getWebSockets()) {
      const session = this.getSession(client);
      if (client !== exceptWs && client.readyState === 1 && session && !("protocolVersion" in session) && session.roomId === roomId) {
        client.send(message);
      }
    }
  }
}

export default app;
