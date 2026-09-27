import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";

type Bindings = {
  SIGNALING_ROOM: DurableObjectNamespace;
};

type RoomSession = {
  roomId: string;
  username: string;
};

const MAX_ROOM_ID_LENGTH = 128;
const MAX_ROOM_SESSIONS = 2;
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const app = new Hono<{ Bindings: Bindings }>();

app.get("/health", (c) => c.json({ message: "iam alive" }));

// FIX: This now matches EVERYTHING (including just "/")
app.all("*", async (c) => {
  if (c.req.header("upgrade") === "websocket") {
    // We use a single global ID or a default name because 
    // the actual room logic happens inside the message handler now.
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

    // Accept the connection
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

    const { type, roomId, payload, username } = data as {
      type?: unknown;
      roomId?: unknown;
      payload?: unknown;
      username?: unknown;
    };

    if (type === "join") {
      this.join(ws, roomId, username);
      return;
    }

    const session = this.getSession(ws);
    if (!session) return;

    switch (type) {
      case "offer":
      case "answer":
      case "ice_candidate":
        this.broadcastToRoom(session.roomId, { type, payload, roomId: session.roomId }, ws);
        break;

      case "leave":
        this.leave(ws, session);
        break;
    }
  }

  webSocketClose(ws: WebSocket) {
    const session = this.getSession(ws);
    if (!session) return;

    try {
      ws.serializeAttachment(null);
    } catch {
      // Closing sockets may no longer accept attachment updates.
    }
    this.broadcastToRoom(session.roomId, { type: "peer_left", roomId: session.roomId }, ws);
  }

  private join(ws: WebSocket, requestedRoomId: unknown, requestedUsername: unknown) {
    const roomId = typeof requestedRoomId === "string" ? requestedRoomId.trim() : "";
    const existingSession = this.getSession(ws);

    if (existingSession) {
      if (roomId === existingSession.roomId) {
        this.send(ws, {
          type: "joined",
          roomId: existingSession.roomId,
          peerCount: this.countRoomSessions(existingSession.roomId, ws),
        });
      } else {
        this.send(ws, { type: "error", code: "already_joined" });
      }
      return;
    }

    if (
      roomId.length === 0 ||
      roomId.length > MAX_ROOM_ID_LENGTH ||
      !ROOM_ID_PATTERN.test(roomId)
    ) {
      this.send(ws, { type: "error", code: "invalid_room_id" });
      if (ws.readyState === 1) ws.close(4002, "Invalid room ID");
      return;
    }

    if (this.countRoomSessions(roomId) >= MAX_ROOM_SESSIONS) {
      this.send(ws, { type: "room_full", roomId });
      if (ws.readyState === 1) ws.close(4001, "Room full");
      return;
    }

    const session: RoomSession = {
      roomId,
      username:
        typeof requestedUsername === "string" && requestedUsername.trim()
          ? requestedUsername.trim().slice(0, 64)
          : "Anonymous",
    };
    ws.serializeAttachment(session);

    this.send(ws, {
      type: "joined",
      roomId,
      peerCount: this.countRoomSessions(roomId, ws),
    });
    this.broadcastToRoom(
      roomId,
      { type: "peer_joined", roomId, username: session.username },
      ws,
    );
  }

  private leave(ws: WebSocket, session: RoomSession) {
    ws.serializeAttachment(null);
    this.broadcastToRoom(
      session.roomId,
      { type: "peer_left", roomId: session.roomId },
      ws,
    );
  }

  private getSession(ws: WebSocket): RoomSession | undefined {
    try {
      const attachment: unknown = ws.deserializeAttachment();
      if (!attachment || typeof attachment !== "object") return undefined;

      const session = attachment as Partial<RoomSession>;
      if (
        typeof session.roomId !== "string" ||
        session.roomId.length === 0 ||
        session.roomId.length > MAX_ROOM_ID_LENGTH ||
        !ROOM_ID_PATTERN.test(session.roomId) ||
        typeof session.username !== "string"
      ) {
        return undefined;
      }
      return { roomId: session.roomId, username: session.username };
    } catch {
      return undefined;
    }
  }

  private countRoomSessions(roomId: string, exceptWs?: WebSocket) {
    let count = 0;
    for (const client of this.ctx.getWebSockets()) {
      if (
        client !== exceptWs &&
        client.readyState === 1 &&
        this.getSession(client)?.roomId === roomId
      ) {
        count++;
      }
    }
    return count;
  }

  private send(ws: WebSocket, data: Record<string, unknown>) {
    if (ws.readyState === 1) ws.send(JSON.stringify(data));
  }

  broadcastToRoom(roomId: string, data: Record<string, unknown>, exceptWs: WebSocket) {
    const message = JSON.stringify(data);
    for (const client of this.ctx.getWebSockets()) {
      if (
        client !== exceptWs &&
        client.readyState === 1 &&
        this.getSession(client)?.roomId === roomId
      ) {
        client.send(message);
      }
    }
  }
}

export default app;
