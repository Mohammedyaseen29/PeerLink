import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { webcrypto } from 'node:crypto';

const policySource = (await readFile(new URL('../src/previewPolicy.ts', import.meta.url), 'utf8')).replaceAll('export ', '');
const source = policySource + '\n' + (await readFile(new URL('../src/sw.ts', import.meta.url), 'utf8')).replace(/^import .*\r?\n/gm, '').replaceAll('import.meta.env.DEV', 'false');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/export \{\};?/, '');

function fixture(size = 2 * 1024 * 1024 + 73, mimeType = 'image/webp', options = {}) {
    const bytes = options.virtual ? null : Uint8Array.from({ length: size }, (_, i) => i * 31 % 256), ranges = [], lifetimes = [], cancellations = [];
    const read = (start, end) => bytes ? bytes.slice(start, Math.min(end + 1, size)) : Uint8Array.from({ length: Math.max(0, Math.min(end + 1, size) - start) }, (_, i) => (start + i) * 31 % 256);
    const client = { type: 'window', postMessage(message, ports) {
        const { start, end } = message;
        ranges.push({ start, end });
        const port = ports[0];
        port.onmessage = event => { cancellations.push(event.data); port.close(); };
        port.start();
        if (ranges.length === options.blockAt) return;
        const reply = { size, mimeType, data: read(start, end).buffer };
        port.postMessage(options.transform ? options.transform(reply, ranges.length) : reply);
        ports[0].close();
    } };
    const noop = () => {};
    const runtime = { Request, Response, Headers, URL, ArrayBuffer, Uint8Array, ReadableStream, AbortController, DOMException, MessageChannel, crypto: webcrypto, setTimeout: options.shortTimeout ? ((fn, ms) => setTimeout(fn, ms === 30000 ? 10 : ms)) : setTimeout, clearTimeout,
        addEventListener: noop, clients: { async get() { return client; } }, self: { __WB_MANIFEST: [] },
        registerRoute: noop, cleanupOutdatedCaches: noop, precacheAndRoute: noop, createHandlerBoundToURL: noop,
        NavigationRoute: class {}, CacheFirst: class {}, CacheableResponsePlugin: class {}, ExpirationPlugin: class {},
    };
    vm.runInNewContext(compiled + '\nglobalThis.handle = handlePreviewRequest;', runtime);
    return { bytes, read, ranges, lifetimes, cancellations, async request(headers = {}, method = 'GET', signal) {
        const request = new Request('https://peerlink.test/__peerlink_preview/synthetic-id', { headers, method, signal });
        return runtime.handle({ clientId: 'owner', waitUntil(promise) { lifetimes.push(promise); } }, request, new URL(request.url));
    } };
}

test('ordinary image GET streams a complete 200 response in bounded peer ranges', async () => {
    const f = fixture(), response = await f.request();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'image/webp');
    assert.equal(Number(response.headers.get('Content-Length')), f.bytes.length);
    assert.equal(response.headers.has('Content-Range'), false);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), f.bytes);
    assert.equal(f.ranges.length, 3);
    assert.equal(f.ranges.every(range => range.end - range.start + 1 <= 1024 * 1024), true);
    await Promise.all(f.lifetimes);
});
test('media byte ranges remain 206 and preserve exact bytes', async () => {
    const f = fixture(), response = await f.request({ Range: 'bytes=100-300' });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Range'), `bytes 100-300/${f.bytes.length}`);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), f.bytes.slice(100, 301));
});
test('HEAD without a range reports full metadata without a body', async () => {
    const f = fixture(), response = await f.request({}, 'HEAD');
    assert.equal(response.status, 200);
    assert.equal(Number(response.headers.get('Content-Length')), f.bytes.length);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
});
test('empty files work and malformed or out-of-bounds ranges remain rejected', async () => {
    const empty = fixture(0), response = await empty.request();
    assert.equal(response.status, 200);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
    const f = fixture(100);
    assert.equal((await f.request({ Range: 'bytes=200-300' })).status, 416);
    assert.equal((await f.request({ Range: 'invalid' })).status, 416);
});
test('canceling a full preview releases its service-worker lifetime', async () => {
    const f = fixture(), response = await f.request();
    await response.body.cancel();
    await Promise.all(f.lifetimes);
    assert.ok(f.ranges.length <= 2);
});

test('remote text previews return only a plain-text 256KiB prefix', async () => {
    const f = fixture(2 * 1024 * 1024 + 73, 'text/html');
    const response = await f.request();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'text/plain; charset=utf-8');
    assert.match(response.headers.get('Content-Security-Policy'), /sandbox/);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), f.bytes.slice(0, 256 * 1024));
    assert.equal(f.ranges.length, 1);
    assert.equal((await f.request({ Range: 'bytes=262144-' })).status, 416);
});

test('remote suffix ranges return their complete requested tail, including suffixes larger than1MiB or file size', async () => {
    const f = fixture();
    for (const length of [1, 128, 1024 * 1024 + 19, f.bytes.length + 100]) {
        const response = await f.request({ Range: `bytes=-${length}` });
        const start = Math.max(0, f.bytes.length - length);
        assert.equal(response.status, 206);
        assert.equal(response.headers.get('Content-Range'), `bytes ${start}-${f.bytes.length - 1}/${f.bytes.length}`);
        assert.equal(Number(response.headers.get('Content-Length')), f.bytes.length - start);
        const actual = new Uint8Array(await response.arrayBuffer());
        assert.deepEqual(actual, f.bytes.slice(start));
        assert.equal(actual.at(-1), f.bytes.at(-1));
    }
    assert.equal(f.ranges.every(range => range.end - range.start + 1 <= 1024 * 1024), true);
    await Promise.all(f.lifetimes);
});

test('remote explicit/open ranges stream the whole selected interval in bounded pulls at high offsets', async () => {
    for (const size of [50_000_000_000, 50 * 1024 ** 3 + 123]) {
        const f = fixture(size, 'video/mp4', { virtual: true });
        for (const header of [`bytes=${2 ** 32 - 17}-${2 ** 32 + 1024 * 1024 + 19}`, `bytes=${size - 1024 * 1024 - 77}-`, 'bytes=-128']) {
            const response = await f.request({ Range: header });
            const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range'));
            assert.equal(response.status, 206); assert.ok(match);
            const start = Number(match[1]), end = Number(match[2]);
            assert.equal(Number(match[3]), size);
            assert.equal(Number(response.headers.get('Content-Length')), end - start + 1);
            assert.deepEqual(new Uint8Array(await response.arrayBuffer()), f.read(start, end));
        }
        assert.equal(f.ranges.every(range => range.end - range.start + 1 <= 1024 * 1024), true);
        await Promise.all(f.lifetimes);
    }
});

test('remote HEAD ignores any Range and only probes one metadata byte; invalid/EOF/empty GET remains416', async () => {
    const f = fixture(100, 'video/mp4');
    for (const range of ['bytes=-0', 'bytes=100-', 'bytes=-128', 'bytes=90-99', 'invalid', 'bytes=0-1,4-5']) {
        const before = f.ranges.length;
        const response = await f.request({ Range: range }, 'HEAD');
        assert.equal(response.status, 200); assert.equal(response.headers.has('Content-Range'), false);
        assert.equal(response.headers.get('Content-Length'), '100'); assert.equal((await response.arrayBuffer()).byteLength, 0);
        assert.deepEqual(f.ranges.slice(before), [{ start: 0, end: 0 }]);
    }
    for (const range of ['bytes=-0', 'bytes=100-', 'bytes=9-2', 'invalid', 'bytes=0-1,4-5', 'bytes=-9007199254740992']) {
        const response = await f.request({ Range: range });
        assert.equal(response.status, 416); assert.equal(response.headers.get('Content-Range'), 'bytes */100');
    }
    const emptySuffix = await fixture(0).request({ Range: 'bytes=-1' });
    assert.equal(emptySuffix.status, 200); assert.equal(emptySuffix.headers.get('Content-Length'), '0');
    assert.equal((await emptySuffix.arrayBuffer()).byteLength, 0);
    assert.equal((await fixture(0).request({ Range: 'bytes=0-' })).status, 416);
});

test('remote text suffix and HEAD describe the bounded plain-text representation', async () => {
    const f = fixture(2 * 1024 * 1024 + 73, 'text/html');
    const response = await f.request({ Range: 'bytes=-128' });
    assert.equal(response.headers.get('Content-Range'), 'bytes 262016-262143/262144');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), f.bytes.slice(262016, 262144));
    assert.equal((await f.request({ Range: 'bytes=-1' }, 'HEAD')).headers.get('Content-Length'), '262144');
});

test('remote stream rejects changed peer size/MIME or a malformed bounded range reply', async () => {
    for (const change of [reply => ({ ...reply, size: reply.size + 1 }), reply => ({ ...reply, mimeType: 'video/webm' }), reply => ({ ...reply, data: new ArrayBuffer(1) })]) {
        const f = fixture(2 * 1024 * 1024 + 73, 'video/mp4', { transform: (reply, index) => index === 1 ? reply : change(reply) });
        const response = await f.request();
        await assert.rejects(response.arrayBuffer(), /changed|unavailable|incomplete/);
        await Promise.all(f.lifetimes);
    }
});

async function waitFor(predicate) {
    for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
    throw new Error('The preview cancellation did not settle.');
}
test('remote abort during initial probe cancels exactly its page provider request', async () => {
    const f = fixture(100, 'video/mp4', { blockAt: 1 });
    const abort = new AbortController();
    const request = f.request({ Range: 'bytes=-1' }, 'GET', abort.signal);
    const rejected = assert.rejects(request, /aborted/);
    await waitFor(() => f.ranges.length === 1);
    abort.abort(); await rejected;
    await waitFor(() => f.cancellations.length === 1);
    assert.equal(f.cancellations[0].type, 'peerlink_preview_cancel');
    assert.equal(typeof f.cancellations[0].requestId, 'string');
});
test('remote timeout sends provider port cancellation before closing', async () => {
    const f = fixture(100, 'video/mp4', { blockAt: 1, shortTimeout: true });
    assert.equal((await f.request()).status, 504);
    await waitFor(() => f.cancellations.length === 1);
    assert.equal(f.cancellations[0].type, 'peerlink_preview_cancel');
});
test('remote pending-read abort/cancel and idle backpressure abort settle the body/lifetime without another pull', async () => {
    for (const mode of ['abort-pending', 'cancel-pending', 'abort-idle']) {
        const f = fixture(3 * 1024 * 1024, 'video/mp4', { blockAt: 2 });
        const abort = new AbortController();
        const response = await f.request({}, 'GET', abort.signal);
        const reader = response.body.getReader();
        if (mode === 'abort-idle') {
            abort.abort();
            await assert.rejects(reader.read(), /canceled/);
        } else {
            assert.equal((await reader.read()).value.byteLength, 1024 * 1024);
            const pending = reader.read();
            const settled = mode === 'abort-pending' ? assert.rejects(pending, /canceled/) : pending;
            await waitFor(() => f.ranges.length === 2);
            if (mode === 'abort-pending') abort.abort(); else await reader.cancel();
            await settled;
            await waitFor(() => f.cancellations.length === 1);
        }
        await Promise.all(f.lifetimes);
    }
});

const brokerSource = (await readFile(new URL('../src/preview/RangeBroker.ts', import.meta.url), 'utf8')).replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\r?\n/gm, '');
const brokerCompiled = ts.transpileModule(brokerSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
test('production RangeBroker cancels only the matching port request and suppresses intentional-close errors', async () => {
    const listeners = new Set(), providers = [], errors = [];
    const runtime = { exports: {}, ArrayBuffer, AbortController, DOMException, window: { setTimeout, clearTimeout },
        navigator: { serviceWorker: { addEventListener(_name, fn) { listeners.add(fn); }, removeEventListener(_name, fn) { listeners.delete(fn); } } },
    };
    vm.runInNewContext(brokerCompiled, runtime);
    const broker = new runtime.exports.RangeBroker((request, signal) => new Promise((resolve, reject) => {
        providers.push({ request, signal, resolve });
        signal.addEventListener('abort', () => reject(new DOMException('Canceled by caller', 'AbortError')), { once: true });
    }), message => errors.push(message));
    broker.start();
    const channels = [new MessageChannel(), new MessageChannel()];
    try {
        channels.forEach((channel, index) => {
            const request = { type: 'peerlink_preview_range', fileId: 'synthetic-id', requestId: `request-${index}`, start: 0, end: 0 };
            for (const listener of listeners) listener({ data: request, ports: [channel.port2] });
        });
        channels[0].port1.postMessage({ type: 'peerlink_preview_cancel', requestId: 'request-1' });
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(providers[0].signal.aborted, false);
        channels[0].port1.postMessage({ type: 'peerlink_preview_cancel', requestId: 'request-0' });
        await waitFor(() => providers[0].signal.aborted);
        assert.equal(providers[1].signal.aborted, false);
        assert.equal(broker.pending.size, 1);
        const reply = new Promise(resolve => { channels[1].port1.onmessage = event => resolve(event.data); });
        providers[1].resolve({ size: 1, mimeType: 'video/mp4', data: new ArrayBuffer(1) });
        assert.equal((await reply).data.byteLength, 1);
        assert.equal(broker.pending.size, 0);
        assert.deepEqual(errors, []);
    } finally { broker.dispose(); for (const channel of channels) { channel.port1.close(); channel.port2.close(); } }
});
