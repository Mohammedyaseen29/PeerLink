import express from 'express';
import { WebSocketServer,WebSocket } from 'ws';
import cors from 'cors';
import http from "http";
import { join } from 'path/win32';


const app = express();
app.use(cors());
app.get("/health", (req, res) => { 
  res.json({ message: 'iam alive' });
})
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rooms = new Map<string, Set<WebSocket>>();

function broadCast(roomId:string, data:any, exceptWs:WebSocket) { 
  const clients = rooms.get(roomId) || new Set();
  for (const client of clients) {
    if(client !== exceptWs && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  }
}

wss.on("connection", (ws: WebSocket) => { 
  
  console.log("client connected");
  let joinedRoom : string | null = null;
  
  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());
      const { roomId, type, payload } = data;
        
    
        
      switch (type) {
        case "join":
          if (!rooms.get(roomId)) {
            rooms.set(roomId, new Set());
            rooms.get(roomId)!.add(ws);
          }
          joinedRoom = roomId;
            
          ws.send(JSON.stringify({ type: "joined", roomId }));
          // Now lets broadcast to every client in the room
          broadCast(roomId, { type: "peer_joined", roomId }, ws);
          break;
          
        case "ice_candidate":
          if (!joinedRoom) {
            return;
          }
          broadCast(roomId, { type: "ice_candidate", payload }, ws);
          break;
          
        case "offer":
          if (!joinedRoom) {
            return;
          }
          broadCast(roomId, { type: "offer", payload }, ws);
          break;
          
        case "answer":
          if (!joinedRoom) {
            return;
          }
          broadCast(roomId, { type: "answer", payload }, ws);
          break;
            
        case "leave":
          if (joinedRoom && rooms.has(roomId)) {
            rooms.get(roomId)?.delete(ws);
            broadCast(roomId, { type: "peer_left", roomId }, ws);
            if (rooms.get(roomId)?.size === 0) {
              rooms.delete(roomId);
            }
            joinedRoom = null;
            break;
          }
      }
        
    } catch(error) {
      console.error(error);
    }
    
  })
  
  ws.on("close", () => { 
    if(joinedRoom && rooms.has(joinedRoom)) {
      rooms.get(joinedRoom)?.delete(ws);
      broadCast(joinedRoom, { type: "peer_left", roomId: joinedRoom }, ws);
      if (rooms.get(joinedRoom)?.size === 0) {
        rooms.delete(joinedRoom);
      }
    }
  })
  
})


server.listen(3000, () => {
  console.log('Server is running on port 3000');
});