import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const MIB = 1024 * 1024;
const pattern = position => (position % MIB * 31 + Math.floor(position % MIB / 256) * 17 + 91) & 255;
const bytes = (start, length) => Uint8Array.from({ length }, (_, i) => pattern(start + i));
async function compiled(path) {
    const source = (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\r?\n/gm, '').replaceAll('import.meta.env.DEV', 'false').replaceAll('import.meta.url', "'https://peerlink.test/src/transfer/TransferEngine.ts'");
    return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}
const base = { ArrayBuffer, Uint8Array, DataView, TextEncoder, TextDecoder, DOMException, URL, Request, Response, Headers, ReadableStream, AbortController, crypto: webcrypto, console, setTimeout, clearTimeout, performance };
const policy = await compiled('../src/previewPolicy.ts');
const progressSource = await compiled('../src/ProgressDB.ts');

test('extent packing coalesces actual partial batches, respects 1MiB and legacy rows', () => {
    const runtime = { ...base, exports: {} };
    vm.runInNewContext(progressSource, runtime);
    const { storageRows } = runtime.exports;
    const size = 3 * MIB + 7, chunkSize = 65536;
    const meta = { size, chunkSize, totalChunks: Math.ceil(size / chunkSize), storageFormat: 'extent-v1' };
    const chunks = Array.from({ length: meta.totalChunks }, (_, i) => ({ chunkIndex: i, data: bytes(i * chunkSize, Math.min(chunkSize, size - i * chunkSize)).buffer }));
    const rows = storageRows('id', chunks, meta);
    assert.equal(rows.length, 4);
    assert.equal(rows.every(row => row.data.byteLength <= MIB), true);
    assert.equal(rows.reduce((sum, row) => sum + row.chunkCount, 0), chunks.length);
    assert.deepEqual(new Uint8Array(rows.at(-1).data), bytes(3 * MIB, 7));
    const partial = storageRows('id', chunks.slice(2, 5), meta);
    assert.equal(partial.length, 1);
    assert.equal(partial[0].chunkIndex, 2);
    assert.equal(partial[0].chunkCount, 3);
    assert.equal(storageRows('id', chunks).length, chunks.length);
    assert.throws(() => storageRows('id', [chunks[0], chunks[2]], meta), /contiguous/);
    assert.throws(() => storageRows('id', [{ chunkIndex: 0, data: new ArrayBuffer(1) }], meta), /Invalid/);
});

const workerSource = await compiled('../src/workers/transferWorker.ts');
test('real sender worker reads exact high offsets and tail of virtual 50GB and 50GiB sources in bounded batches', async () => {
    const self = { postMessage(value) { self.result = value; } }, reads = [];
    const runtime = { ...base, self, exports: {} };
    vm.runInNewContext(workerSource, runtime);
    const chunkSize = 16 * 1024 - 128;
    for (const size of [50_000_000_000, 50 * 1024 ** 3 + 123]) {
        const file = { size, slice(start, end) { reads.push({ start, end: Math.min(end, size) }); return { async arrayBuffer() { return bytes(start, Math.min(end, size) - start).buffer; } }; } };
        await self.onmessage({ data: { type: 'load', file } });
        for (const start of [0, Math.floor(2 ** 32 / chunkSize) - 1, Math.ceil(size / chunkSize) - 1]) {
            const count = Math.min(32, Math.ceil(size / chunkSize) - start);
            await self.onmessage({ data: { type: 'read', requestId: start, fileId: 'synthetic', start, count, chunkSize } });
            assert.equal(self.result.error, undefined);
            assert.equal(self.result.packets.length, count);
            for (let i = 0; i < count; i++) {
                const packet = self.result.packets[i], view = new DataView(packet), idLength = view.getUint16(0, true);
                assert.equal(view.getUint32(2, true), start + i);
                const payload = new Uint8Array(packet, 38 + idLength);
                assert.deepEqual(payload, bytes((start + i) * chunkSize, Math.min(chunkSize, size - (start + i) * chunkSize)));
                assert.deepEqual(new Uint8Array(packet, 6 + idLength, 32), new Uint8Array(await webcrypto.subtle.digest('SHA-256', payload)));
            }
        }
    }
    assert.ok(reads.some(read => read.start > 2 ** 32));
    assert.ok(reads.every(read => read.end - read.start <= 32 * chunkSize));
});

const swSource = await compiled('../src/sw.ts');
function localFixture(size = 3 * MIB + 7, mimeType = 'video/mp4', readOverride) {
    const ranges = [], lifetimes = [], events = {};
    const meta = { fileId: 'synthetic', size, mimeType, chunkSize: 16384, totalChunks: Math.ceil(size / 16384), receivedChunks: Math.ceil(size / 16384), status: 'complete', storageFormat: 'extent-v1' };
    const noop = () => {};
    const runtime = { ...base, exports: {}, location: { origin: 'https://peerlink.test' }, addEventListener(name, callback) { events[name] = callback; }, self: { __WB_MANIFEST: [] },
        getMetaData: async () => meta, async readFileRange(_id, _meta, start, end) { ranges.push({ start, end }); return readOverride ? readOverride(start, end) : bytes(start, end - start + 1).buffer; },
        registerRoute: noop, cleanupOutdatedCaches: noop, precacheAndRoute: noop, createHandlerBoundToURL: noop,
        NavigationRoute: class {}, CacheFirst: class {}, CacheableResponsePlugin: class {}, ExpirationPlugin: class {},
    };
    vm.runInNewContext(policy, runtime);
    Object.assign(runtime, runtime.exports);
    vm.runInNewContext(swSource + '\nglobalThis.handle = handleLocalPreviewRequest;', runtime);
    return { ranges, lifetimes, events, async request(headers = {}, method = 'GET', signal) {
        const request = new Request('https://peerlink.test/__peerlink_local_preview/synthetic', { headers, method, signal });
        return runtime.handle({ waitUntil(promise) { lifetimes.push(promise); } }, request, new URL(request.url));
    } };
}

test('local preview GET/HEAD streams bounded ranges without broker or OPFS and sets defensive headers', async () => {
    const f = localFixture();
    const head = await f.request({}, 'HEAD');
    assert.equal(head.status, 200); assert.equal(f.ranges.length, 0);
    const response = await f.request();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.match(response.headers.get('Content-Security-Policy'), /sandbox/);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes(0, 3 * MIB + 7));
    assert.equal(f.ranges.every(range => range.end - range.start + 1 <= MIB), true);
    await Promise.all(f.lifetimes);
});

test('local preview handles >4GiB and 50GB/50GiB ranges, suffix, EOF and malformed ranges', async () => {
    for (const size of [50_000_000_000, 50 * 1024 ** 3 + 123]) {
        const f = localFixture(size);
        for (const start of [2 ** 32 - 13, size - 73]) {
            const end = Math.min(size - 1, start + 100);
            const response = await f.request({ Range: `bytes=${start}-${end}` });
            assert.equal(response.status, 206);
            assert.equal(response.headers.get('Content-Range'), `bytes ${start}-${end}/${size}`);
            assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes(start, end - start + 1));
        }
        const suffix = await f.request({ Range: 'bytes=-9' });
        assert.deepEqual(new Uint8Array(await suffix.arrayBuffer()), bytes(size - 9, 9));
        for (const value of [`bytes=${size}-`, 'bytes=5-2', 'invalid', 'bytes=1-2,3-4']) assert.equal((await f.request({ Range: value })).status, 416);
        await Promise.all(f.lifetimes);
    }
});

test('local HEAD ignores Range while large suffix GET returns all tail bytes in bounded reads', async () => {
    const f = localFixture();
    for (const range of ['bytes=-1', 'bytes=999999999-', 'invalid']) {
        const response = await f.request({ Range: range }, 'HEAD');
        assert.equal(response.status, 200); assert.equal(response.headers.has('Content-Range'), false);
        assert.equal(Number(response.headers.get('Content-Length')), 3 * MIB + 7);
        assert.equal((await response.arrayBuffer()).byteLength, 0);
    }
    assert.equal(f.ranges.length, 0);
    for (const length of [128, MIB + 31, 4 * MIB]) {
        const response = await f.request({ Range: `bytes=-${length}` });
        const start = Math.max(0, 3 * MIB + 7 - length);
        assert.equal(response.status, 206);
        assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes(start, 3 * MIB + 7 - start));
    }
    assert.equal(f.ranges.every(range => range.end - range.start + 1 <= MIB), true);
    await Promise.all(f.lifetimes);
    const empty = localFixture(0);
    const response = await empty.request({ Range: 'bytes=-1' });
    assert.equal(response.status, 200); assert.equal(response.headers.get('Content-Length'), '0');
    assert.equal((await response.arrayBuffer()).byteLength, 0); assert.equal(empty.ranges.length, 0);
});

test('local text previews cap bytes, force plain text, and reject giant image/PDF decoding', async () => {
    const response = await localFixture(50_000_000_000, 'text/html').request();
    assert.equal((await response.arrayBuffer()).byteLength, 256 * 1024);
    assert.equal(response.headers.get('Content-Type'), 'text/plain; charset=utf-8');
    for (const mime of ['image/svg+xml', 'application/pdf']) assert.equal((await localFixture(33 * MIB, mime).request()).status, 413);
});

test('local preview cancel and request abort release lifetime during a pending range read', async () => {
    for (const mode of ['cancel', 'abort', 'already-aborted']) {
        let release;
        const waiting = new Promise(resolve => { release = resolve; });
        const f = localFixture(3 * MIB, 'video/mp4', async (start, end) => { await waiting; return bytes(start, end - start + 1).buffer; });
        const abort = new AbortController();
        if (mode === 'already-aborted') abort.abort();
        const response = await f.request({}, 'GET', abort.signal);
        const reader = response.body.getReader();
        const read = reader.read();
        if (mode === 'cancel') await reader.cancel(); else abort.abort();
        release();
        if (mode === 'cancel') assert.equal((await read).done, true);
        else await assert.rejects(read, /canceled/);
        await Promise.all(f.lifetimes);
    }
});

const downloadSource = await compiled('../src/download/serviceWorkerDownload.ts');
function downloadFixture(version = 2, options = {}) {
    let now = 0, nextTimer = 0, frame, token, registers = 0;
    const timers = new Map(), listeners = new Set();
    class Channel {
        constructor() {
            this.port1 = { start() {}, close() {} };
            this.port2 = { postMessage: data => this.port1.onmessage?.({ data }), close() {} };
        }
    }
    const worker = { postMessage(message, ports) {
        if (message.type === 'PEERLINK_DOWNLOAD_CAPABILITY') { if (options.ack !== false) ports[0].postMessage({ type: 'PEERLINK_DOWNLOAD_CAPABILITY_ACK', version }); }
        else { token = message.token; registers++; ports[0].postMessage({ type: 'PEERLINK_DOWNLOAD_REGISTERED' }); }
    } };
    const send = (type, extra = {}, source = worker) => { for (const listener of listeners) listener({ source, data: { type, token, ...extra } }); };
    const container = { controller: worker, async getRegistration() { return { waiting: null }; }, addEventListener(_type, fn) { listeners.add(fn); }, removeEventListener(_type, fn) { listeners.delete(fn); } };
    const window = { isSecureContext: true, location: { origin: 'https://peerlink.test' }, setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, due: now + delay }); return id; }, clearTimeout(id) { timers.delete(id); } };
    const runtime = { ...base, exports: {}, window, navigator: { serviceWorker: container }, MessageChannel: Channel,
        isPeerLinkServiceWorker: () => true, isPeerLinkServiceWorkerRegistration: () => true,
        document: { body: { append() {} }, createElement() { frame = { removed: false, setAttribute() {}, remove() { this.removed = true; }, set src(_value) { if (options.ready !== false) send('PEERLINK_DOWNLOAD_READY'); } }; return frame; } },
    };
    vm.runInNewContext(downloadSource, runtime);
    return { api: runtime.exports, worker, send, timers, get frame() { return frame; }, get registers() { return registers; },
        tick(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.fn(); } },
    };
}
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

test('packed downloads and local URLs require actual v2 ACK even without a waiting registration; legacy v1 remains usable', async () => {
    const old = downloadFixture(1);
    await assert.rejects(old.api.downloadWithServiceWorker('id', 'file', 100, 'extent-v1'), /Apply the PeerLink update/);
    await assert.rejects(old.api.localPreviewUrl('id'), /Apply the PeerLink update/);
    assert.equal(old.registers, 0);
    const download = old.api.downloadWithServiceWorker('id', 'file', 100);
    await flush();
    old.tick(45 * 60_000);
    old.send('PEERLINK_DOWNLOAD_FINISHED');
    await download;
    assert.equal(old.frame.removed, true);
});

test('remote preview needs v3 while a v2 controlling worker still permits packed download/local preview', async () => {
    const older = downloadFixture(2);
    await assert.rejects(older.api.requireRemotePreviewCapability(), /Apply the PeerLink update/);
    assert.match(await older.api.localPreviewUrl('id'), /__peerlink_local_preview/);
    const download = older.api.downloadWithServiceWorker('id', 'file', 100, 'extent-v1');
    await flush(); older.send('PEERLINK_DOWNLOAD_FINISHED'); await download;
    const current = downloadFixture(3);
    await current.api.requireRemotePreviewCapability();
});

test('healthy progress continues beyond 30 minutes, duplicate/untrusted progress cannot extend idle watchdog, and cleanup is final', async () => {
    const f = downloadFixture();
    const download = f.api.downloadWithServiceWorker('id', 'file', 10000, 'extent-v1');
    await flush();
    for (let minute = 1; minute <= 45; minute++) { f.tick(60_000); f.send('PEERLINK_DOWNLOAD_PROGRESS', { bytes: minute }); }
    f.send('PEERLINK_DOWNLOAD_FINISHED');
    await download;
    assert.equal(f.frame.removed, true); assert.equal(f.timers.size, 0);

    for (const kind of ['duplicate', 'untrusted', 'ready']) {
        const idle = downloadFixture();
        const stalled = idle.api.downloadWithServiceWorker('id', 'file', 10000, 'extent-v1');
        await flush();
        const rejects = assert.rejects(stalled, /stopped making progress/);
        idle.send('PEERLINK_DOWNLOAD_PROGRESS', { bytes: 1 });
        idle.tick(90_000);
        if (kind === 'duplicate') idle.send('PEERLINK_DOWNLOAD_PROGRESS', { bytes: 1 });
        else if (kind === 'untrusted') idle.send('PEERLINK_DOWNLOAD_PROGRESS', { bytes: 2 }, {});
        else idle.send('PEERLINK_DOWNLOAD_READY');
        idle.tick(31_000);
        await rejects;
        assert.equal(idle.frame.removed, true); assert.equal(idle.timers.size, 0);
    }
});

test('missing capability ACK fails safely, startup stays bounded at30s, and error/cancel clean up', async () => {
    const missing = downloadFixture(2, { ack: false });
    const denied = missing.api.downloadWithServiceWorker('id', 'file', 10000, 'extent-v1');
    const deniedResult = assert.rejects(denied, /Apply the PeerLink update/);
    missing.tick(2500); await deniedResult;
    assert.equal(missing.registers, 0); assert.equal(missing.timers.size, 0);
    const startup = downloadFixture(2, { ready: false });
    const pending = startup.api.downloadWithServiceWorker('id', 'file', 10000, 'extent-v1');
    await flush();
    const timedOut = assert.rejects(pending, /did not start/);
    startup.tick(30_000); await timedOut;
    assert.equal(startup.frame.removed, true); assert.equal(startup.timers.size, 0);
    for (const type of ['PEERLINK_DOWNLOAD_ERROR', 'PEERLINK_DOWNLOAD_CANCELLED']) {
        const f = downloadFixture();
        const operation = f.api.downloadWithServiceWorker('id', 'file', 10000);
        await flush();
        const failed = assert.rejects(operation, type.endsWith('ERROR') ? /explicit failure/ : /cancelled/);
        f.send(type, { message: 'explicit failure' }); await failed;
        assert.equal(f.frame.removed, true); assert.equal(f.timers.size, 0);
    }
});

test('legacy preview cleanup is age/name/lock guarded and never creates a staging file', async () => {
    const removed = [], locked = [];
    const old = Date.now() - 2 * 24 * 60 * 60_000;
    const stale = `.peerlink-preview-${old}-stale`, active = `.peerlink-preview-${old}-active`, recent = `.peerlink-preview-${Date.now()}-recent`;
    const root = { async *entries() { for (const name of [stale, active, recent, 'source.bin']) yield [name, { kind: 'file' }]; }, async removeEntry(name) { removed.push(name); } };
    const runtime = { ...base, exports: {}, localPreviewUrl: async () => 'https://peerlink.test/__peerlink_local_preview/id', navigator: {
        storage: { async getDirectory() { return root; } }, locks: { async request(name, options, work) { assert.equal(options.ifAvailable, true); locked.push(name); return work(name.endsWith('-active') ? null : {}); } },
    } };
    vm.runInNewContext(policy, runtime); Object.assign(runtime, runtime.exports);
    vm.runInNewContext(progressSource, runtime);
    await runtime.exports.getUpdatePreviewUrl('id', { size: 33 * MIB, mimeType: 'video/mp4', status: 'complete' }, null);
    await flush();
    assert.deepEqual(removed, [stale]); assert.equal(locked.length, 2);
});

const engineSource = await compiled('../src/transfer/TransferEngine.ts');
async function receiverFixture() {
    const controls = [], calls = [], deleted = [], errors = [];
    const channel = () => ({ readyState: 'open', bufferedAmount: 0, addEventListener() {}, removeEventListener() {}, send(message) { controls.push(JSON.parse(message)); } });
    const runtime = { ...base, exports: {}, window: { setTimeout, clearTimeout }, navigator: { storage: { estimate: async () => ({ quota: 100 * 1024 ** 3, usage: 0 }) } },
        saveMetaData: async () => {}, saveChunks(_id, batch, meta) { return new Promise((resolve, reject) => calls.push({ batch, meta, resolve, reject })); },
        deleteFile: async id => { deleted.push(id); }, getFileMimeType: () => 'application/octet-stream',
    };
    vm.runInNewContext(engineSource, runtime);
    const engine = new runtime.exports.TransferEngine(channel(), channel(), () => 'bounded-test', { receiving() {}, received() {}, error(message) { errors.push(message); } });
    const chunkSize = runtime.exports.CHUNK_SIZE;
    engine.handle({ type: 'transfer_meta', version: 4, fileId: 'wire', name: 'test.bin', size: 33 * MIB + 123, totalChunks: Math.ceil((33 * MIB + 123) / chunkSize), chunkSize });
    await engine.controlTasks;
    const payload = bytes(0, chunkSize), digest = new Uint8Array(await webcrypto.subtle.digest('SHA-256', payload));
    function packet(index) {
        const buffer = new ArrayBuffer(42 + payload.byteLength), view = new DataView(buffer);
        view.setUint16(0, 4, true); view.setUint32(2, index, true);
        new Uint8Array(buffer, 6, 4).set(new TextEncoder().encode('wire'));
        new Uint8Array(buffer, 10, 32).set(digest); new Uint8Array(buffer, 42).set(payload);
        engine.onData({ data: buffer });
    }
    return { engine, packet, calls, controls, deleted, errors, chunkSize };
}
async function until(predicate) {
    for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
    throw new Error('Timed out waiting for receiver fixture');
}

test('receiver keeps bounded credit and withholds ACK until durable commit, including timer partial batches', async () => {
    const f = await receiverFixture();
    try {
        for (let i = 0; i < 128; i++) f.packet(i);
        await until(() => f.calls.length === 1);
        assert.equal(f.calls[0].meta.storageFormat, 'extent-v1');
        assert.equal(f.calls[0].batch.length, 32);
        assert.equal(f.engine.incoming.committed, 0);
        assert.equal(f.controls.some(value => value.type === 'transfer_progress'), false);
        assert.ok(f.engine.metrics.peakReceiveBytes <= 128 * f.chunkSize);
        f.calls[0].resolve();
        await until(() => f.calls.length === 2);
        assert.equal(f.controls.find(value => value.type === 'transfer_progress').committed, 32);
        // Cancel during the next pending commit; late completion must not ACK or resurrect receive state.
        f.engine.handle({ type: 'transfer_cancel', fileId: 'wire' }); await f.engine.controlTasks;
        f.calls[1].resolve(); await flush();
        assert.equal(f.deleted.length, 1);
        assert.equal(f.controls.filter(value => value.type === 'transfer_progress').length, 1);
    } finally { f.engine.dispose(); }

    const partial = await receiverFixture();
    try {
        for (let i = 0; i < 3; i++) partial.packet(i);
        await until(() => partial.calls.length === 1);
        assert.equal(partial.calls[0].batch.length, 3);
        assert.equal(partial.engine.metrics.receiveTimerFlushes, 1);
        partial.calls[0].resolve();
        await until(() => partial.controls.some(value => value.type === 'transfer_progress'));
        assert.equal(partial.controls.find(value => value.type === 'transfer_progress').committed, 3);
    } finally { partial.engine.dispose(); }
});

test('failed atomic receiver commit reports quota failure, cleans up, and never ACKs lost bytes', async () => {
    const f = await receiverFixture();
    try {
        for (let i = 0; i < 32; i++) f.packet(i);
        await until(() => f.calls.length === 1);
        f.calls[0].reject(new DOMException('full', 'QuotaExceededError'));
        await until(() => f.deleted.length === 1);
        assert.equal(f.controls.some(value => value.type === 'transfer_progress'), false);
        assert.match(f.errors[0], /Not enough receiver storage/);
        assert.equal(f.engine.incoming.committed, 0);
    } finally { f.engine.dispose(); }
});
