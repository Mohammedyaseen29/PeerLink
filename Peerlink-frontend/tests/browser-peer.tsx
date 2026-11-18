import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { useP2P } from '../src/hooks/useP2P';
import { openDB, type FileMetadata } from '../src/ProgressDB';

type Peer = ReturnType<typeof useP2P>;
declare global { interface Window { peerProbe?: { join(room: string): void; add(name: string, size: number, seed: number): Promise<boolean>; summary(): unknown; received(name: string): Promise<{ ok: boolean; bytes: number }>; leave(): void } } }

function Fixture() {
  const peer: Peer = useP2P();
  useEffect(() => {
    window.peerProbe = {
      join: room => peer.join(room, 'temporary'),
      add: (name, size, seed) => {
        const blockSize = 1024 * 1024;
        const blocks: Uint8Array[] = [];
        for (let offset = 0; offset < size; offset += blockSize) {
          const length = Math.min(blockSize, size - offset);
          const block = new Uint8Array(length);
          for (let i = 0; i < length; i++) block[i] = ((offset + i) * 31 + ((offset + i) >>> 8) + seed) & 255;
          blocks.push(block);
        }
        return peer.addFilesToQueue([new File(blocks, name, { type: 'application/octet-stream' })]);
      },
      summary: () => ({ roomId: peer.roomId, inRoom: peer.inRoom, connected: peer.connected, connectionType: peer.connectionType,
        signalingStatus: peer.signalingStatus, members: peer.members.map(m => ({ username: m.username, status: m.status })),
        sent: peer.sendQueue.map(f => ({ name: f.file.name, status: f.status, bytesTransferred: f.bytesTransferred })),
        received: peer.receivedFiles.map(f => ({ name: f.name, size: f.size, fileId: f.fileId })) }),
      received: async name => {
        const meta = peer.receivedFiles.find(file => file.name === name);
        if (!meta) return { ok: false, bytes: 0 };
        const db = await openDB();
        let offset = 0, index = 0, ok = true;
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('chunks', 'readonly');
          const req = tx.objectStore('chunks').openCursor(IDBKeyRange.bound([meta.fileId, 0], [meta.fileId, Number.MAX_SAFE_INTEGER]));
          req.onsuccess = () => {
            const cursor = req.result; if (!cursor) return;
            if (cursor.value.chunkIndex !== index++) ok = false;
            const bytes = new Uint8Array(cursor.value.data);
            for (const byte of bytes) {
              const expected = ((offset * 31 + (offset >>> 8) + (meta.name === 'chrome-to-brave.bin' ? 17 : 29)) & 255);
              if (byte !== expected) ok = false;
              offset++;
            }
            cursor.continue();
          };
          tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
        });
        return { ok: ok && offset === meta.size && index === meta.totalChunks, bytes: offset };
      },
      leave: () => peer.leaveRoom(),
    };
    return () => { delete window.peerProbe; };
  }, [peer]);
  return <pre id="status">{JSON.stringify({ inRoom: peer.inRoom, connected: peer.connected, members: peer.members.map(m => m.status) })}</pre>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
