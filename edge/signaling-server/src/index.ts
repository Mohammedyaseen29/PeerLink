import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";

type Bindings = {
  SIGNALING_ROOM: DurableObjectNamespace;
};

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
  // We'll use a Map to track which sockets belong to which rooms
  // since the URL no longer defines the room.
  sessions = new Map<WebSocket, string>();

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

  async webSocketMessage(ws: WebSocket, message: string) {
    try {
      const data = JSON.parse(message);
      const { type, roomId, payload } = data;

      switch (type) {
        case "join":
          // Store which room this specific socket belongs to
          this.sessions.set(ws, roomId);
          
          // Acknowledge the join
          ws.send(JSON.stringify({ type: "joined", roomId }));
          
          // Notify others in the SAME room
          this.broadcastToRoom(roomId, { type: "peer_joined", roomId }, ws);
          break;

        case "offer":
        case "answer":
        case "ice_candidate":
          // Relay only to people in the same roomId
          this.broadcastToRoom(roomId, { type, payload, roomId }, ws);
          break;

        case "leave":
          this.sessions.delete(ws);
          this.broadcastToRoom(roomId, { type: "peer_left", roomId }, ws);
          break;
      }
    } catch (error) {
      console.error("Signal Error:", error);
    }
  }

  async webSocketClose(ws: WebSocket) {
    const roomId = this.sessions.get(ws);
    if (roomId) {
      this.broadcastToRoom(roomId, { type: "peer_left", roomId }, ws);
      this.sessions.delete(ws);
    }
  }

  // New helper to only send to people with the matching Room ID
  broadcastToRoom(roomId: string, data: any, exceptWs: WebSocket) {
    const message = JSON.stringify(data);
    const allSockets = this.ctx.getWebSockets();
    
    for (const client of allSockets) {
      // Only send if the client is in the same room AND is not the sender
      if (client !== exceptWs && this.sessions.get(client) === roomId) {
        if (client.readyState === 1) {
          client.send(message);
        }
      }
    }
  }
}

export default app;