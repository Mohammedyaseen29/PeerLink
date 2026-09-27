// One file and one bounded read batch live in this worker at a time.
let file: File | null = null;
let generation = 0;
self.onmessage = async ({ data: msg }) => {
    if (msg.type === 'load') { file = msg.file; generation++; return; }
    if (msg.type === 'clear') { file = null; generation++; return; }
    const current = generation;
    try {
        if (!file) throw new Error('No source file');
        const id = new TextEncoder().encode(msg.fileId);
        const block = await file.slice(msg.start * msg.chunkSize, (msg.start + msg.count) * msg.chunkSize).arrayBuffer();
        const packets = await Promise.all(Array.from({ length: msg.count }, async (_, i) => {
            const offset = i * msg.chunkSize;
            const bytes = new Uint8Array(block, offset, Math.min(msg.chunkSize, block.byteLength - offset));
            const hash = await crypto.subtle.digest('SHA-256', bytes);
            const packet = new ArrayBuffer(38 + id.length + bytes.byteLength);
            const view = new DataView(packet);
            view.setUint16(0, id.length, true);
            view.setUint32(2, msg.start + i, true);
            new Uint8Array(packet, 6, id.length).set(id);
            new Uint8Array(packet, 6 + id.length, 32).set(new Uint8Array(hash));
            new Uint8Array(packet, 38 + id.length).set(bytes);
            return packet;
        }));
        if (generation === current) self.postMessage({ requestId: msg.requestId, packets }, { transfer: packets });
    } catch (error) {
        self.postMessage({ requestId: msg.requestId, error: String(error) });
    }
};
export {};
