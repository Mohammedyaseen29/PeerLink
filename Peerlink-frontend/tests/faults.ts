import { TransferEngine, CHUNK_SIZE } from '../src/transfer/TransferEngine';
import { deleteFile, getMetaData } from '../src/ProgressDB';

class Channel extends EventTarget {
    readyState = 'open'; bufferedAmount = 0; bufferedAmountLowThreshold = 0; binaryType = 'arraybuffer';
    sent: unknown[] = [];
    transmit?: (value: unknown) => void;
    send(value: unknown) { this.transmit?.(value); this.sent.push(value); }
    packet(value: ArrayBuffer) { this.dispatchEvent(new MessageEvent('message', { data: value })); }
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean) {
    const deadline = Date.now() + 10000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error('Test timeout'); await delay(10); }
}
const result = document.querySelector<HTMLPreElement>('#result')!;
const button = document.querySelector<HTMLButtonElement>('#run')!;
button.onclick = async () => {
    button.disabled = true; result.textContent = '';
    const append = (text: string) => { result.textContent += text + '\n'; };
    try {
        for (const fault of ['hash', 'sequence']) {
            const data = new Channel(), control = new Channel();
            const errors: string[] = [];
            const engine = new TransferEngine(data as unknown as RTCDataChannel, control as unknown as RTCDataChannel,
                () => 'synthetic-fault-tests', { receiving() {}, received() { throw new Error('Corrupt file accepted'); }, error: message => errors.push(message) });
            const fileId = crypto.randomUUID();
            try {
                engine.handle({ type: 'transfer_meta', version: 3, fileId, name: 'synthetic.bin', size: 1, totalChunks: 1, chunkSize: CHUNK_SIZE });
                await until(() => control.sent.some(value => JSON.parse(String(value)).type === 'transfer_ready'));
                const id = new TextEncoder().encode(fileId);
                const packet = new ArrayBuffer(39 + id.length), view = new DataView(packet);
                view.setUint16(0, id.length, true); view.setUint32(2, fault === 'sequence' ? 1 : 0, true);
                new Uint8Array(packet, 6, id.length).set(id);
                data.packet(packet);
                await until(() => errors.length > 0);
                if ((await getMetaData(fileId))?.status === 'complete') throw new Error('Corrupt file marked complete');
                append(`PASS: ${fault} fault rejected (${errors[0]})`);
            } finally { engine.dispose(); await deleteFile(fileId); }
        }
        const data = new Channel(), control = new Channel();
        const engine = new TransferEngine(data as unknown as RTCDataChannel, control as unknown as RTCDataChannel,
            () => 'synthetic-fault-tests', { receiving() {}, received() {}, error() {} });
        const fileId = crypto.randomUUID(); let attempted = false;
        control.transmit = value => {
            if (JSON.parse(String(value)).type === 'transfer_meta') queueMicrotask(() => engine.handle({ type: 'transfer_ready', fileId }));
        };
        data.transmit = () => {
            if (!attempted) { attempted = true; engine.pause(fileId); throw new DOMException('Synthetic queue full', 'OperationError'); }
            queueMicrotask(() => engine.handle({ type: 'transfer_complete', fileId, committed: 1 }));
        };
        try {
            const sent = engine.send(new File([new Uint8Array(17)], 'synthetic.bin'), fileId, () => {});
            sent.catch(() => undefined);
            await until(() => attempted); await delay(250);
            if (data.sent.length !== 0) throw new Error('Retry bypassed pause');
            engine.resume(fileId); await sent;
            if (data.sent.length !== 1 || engine.metrics.activeWorkers !== 0 || engine.metrics.pendingReads !== 0) throw new Error('Retry duplicated packet or leaked resources');
            append('PASS: buffer-full retry respects pause, sends exactly once after resume, releases worker');
        } finally { engine.dispose(); }
        append('ALL FAULT TESTS PASSED');
    } catch (error) { append('FAIL: ' + String(error)); }
    finally { button.disabled = false; }
};
