import { useRef, useState } from "react";

const iceServers = [
  { urls: "stun:stun.l.google.com:19302" },
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

type FileMeta = {
  name: string;
  size: number;
} | null;;

type log = string;

function App() {
  const [roomId, setRoomId] = useState('');
  const [connected, setConnected] = useState(false);
  const [log, setLog] = useState<log[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [progress,setProgress] = useState(0);
  
  
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const receivedBuffer = useRef<ArrayBuffer[]>([]);
  const receivedSize = useRef<number>(0);
  const fileMeta = useRef<FileMeta>(null);
  
  const logs = (m: string) => { 
    setLog((p) => [...p, m]);
    console.log(m);
  };
  
  const ensurePeer = () => { 
    if (pcRef.current) { 
      return;
    }
    const pc = new RTCPeerConnection({iceServers});
    
    pc.onicecandidate = (evnt) => { 
      if (evnt.candidate) { 
        wsRef.current?.send(JSON.stringify({type:"ice_candidate",payload:evnt.candidate,roomId}))
      }
    }
    
    pc.ondatachannel = (evnt) => { 
      console.log("data channel received");
      bindChannel(evnt.channel);
    }
    
    // create data channel , if u became offerer
    const dc = pc.createDataChannel("data");
    bindChannel(dc);
    
    pcRef.current = pc;
  }
  
  const makeOffer = async () => {
    const offer = await pcRef.current?.createOffer();
    await pcRef.current?.setLocalDescription(offer);
    wsRef.current?.send(JSON.stringify({type:"offer",payload:offer,roomId}))
  }
  const bindChannel = (ch:RTCDataChannel) => {
    dcRef.current = ch;
    ch.onopen = () => {
      console.log("data channel opened");
      setConnected(true);
    }
    ch.onmessage = (evnt) => {
      if (typeof evnt.data === "string") {
        try {
          const data = JSON.parse(evnt.data);
          if (data.type === "meta") {
            fileMeta.current = {name:data.name,size:data.size};
            receivedBuffer.current = [];
            receivedSize.current = 0;
            logs(`Receiving file: ${data.name} (${data.size} bytes)`);
          }
          else if (data.type === "done") {
            const blob = new Blob(receivedBuffer.current);
            downloadFile(blob, fileMeta.current!.name);
            receivedBuffer.current = [];
            receivedSize.current = 0;
          }
        } catch (e) {
          console.log(e);
        }
      } else { 
        // binary chunk
        receivedBuffer.current.push(evnt.data);
        receivedSize.current += evnt.data.byteLength;
        const pct = Math.round((receivedSize.current/fileMeta.current!.size)*100);
        setProgress(pct);
      }
    }
    ch.onclose = () => {
      console.log("data channel closed");
    }
  };
  
  const sendFile = async () => {
    if (!file || !dcRef.current) { 
      return;
    }
    const chunk = 64 * 1024; //64kb
    dcRef.current.send(JSON.stringify({ type: "meta", name: file.name, size: file.size }));
    
    
    let offset = 0;
    while (offset < file.size) { 
      const slice = file.slice(offset, offset + chunk);
      const buffer = await slice.arrayBuffer();
      dcRef.current.send(buffer);
      offset += chunk;
      
      const pct = Math.round((offset/file.size)*100);
      setProgress(pct);
      await waitForBuffer();
    }
    dcRef.current.send(JSON.stringify({ type: "done" }));
    logs("File sent successfully");
    
  }
  
  const waitForBuffer = async () => {
    await new Promise<void>((res) => { 
      const interval = setInterval(() => { 
        if (dcRef.current && dcRef.current?.bufferedAmount < 1e6) {
          clearInterval(interval);
          res();
        }
      },50)
    })
  }
  
  const downloadFile = (blob:Blob,name:string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };
  
  const connectWebsocket = () => { 
    if (wsRef.current) { 
      return;
    }
    const ws = new WebSocket("ws://localhost:3000");
    ws.onopen = () => { 
      console.log("client is connected");
    }
    
    ws.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      console.log(data.type);
      
      switch (data.type) { 
        case "joined":
          ensurePeer(); // if u joined first then u will wait for peer to join
          if (data.peers === 2) { // if joined as second peer if have to send the offer
            await makeOffer();
          }
          break;
        case "peer_joined": // you are the second guy joined in the room
          ensurePeer();
          await makeOffer();
          break;
          
        case "offer":{
          ensurePeer();
          await pcRef.current?.setRemoteDescription(data.payload);
          const answer = await pcRef.current?.createAnswer();
          await pcRef.current?.setLocalDescription(answer);
          ws.send(JSON.stringify({ type: "answer", payload: answer,roomId }));
          break;
        }
        case "answer":
          await pcRef.current?.setRemoteDescription(data.payload);
          break;
        case "ice_candidate":
            try {
              await pcRef.current?.addIceCandidate(data.payload);
            } catch (error) {
              console.error(error);
            }
          break;
          
        case "peer_left":
          console.log("peer left...")
          break;

      }
      wsRef.current = ws;
    }    
  }
  const join = () => { 
    connectWebsocket();
    setInterval(() => {
      wsRef.current?.send(JSON.stringify({ type: "join", roomId }));
      logs("join " + roomId);
    },200)
    
  }

  return (
    <div className="p-6">
          <h1 className="text-5xl text-green-500 text-center mb-5">PeerLink</h1>
    
          <div className="flex gap-2 justify-center mb-4">
            <input
              className="border px-2"
              placeholder="Room ID"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
            />
            <button
              className="bg-blue-600 text-white px-3"
              onClick={join}
            >
              Join
            </button>
          </div>
    
          {connected && (
            <div className="flex flex-col items-center gap-2">
              <input
                type="file"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="mb-2"
              />
              <button
                className="bg-green-600 text-white px-3"
                onClick={sendFile}
              >
                Send File
              </button>
              <div className="w-1/2 bg-gray-300 h-3 rounded">
                <div
                  className="bg-green-500 h-3 rounded"
                  style={{ width: `${progress}%` }}
                ></div>
              </div>
            </div>
          )}
    
          <div className="mt-6 border p-3 h-64 overflow-y-auto text-sm font-mono">
            {log.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        </div>
    )
}

export default App
