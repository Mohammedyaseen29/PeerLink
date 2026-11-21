import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { webcrypto } from 'node:crypto';

const source = (await readFile(new URL('../src/sw.ts', import.meta.url), 'utf8')).replace(/^import .*\r?\n/gm, '').replaceAll('import.meta.env.DEV', 'false');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/export \{\};?/, '');

function fixture(size = 2 * 1024 * 1024 + 73) {
    const bytes = Uint8Array.from({ length: size }, (_, i) => i * 31 % 256), ranges = [], lifetimes = [];
    const client = { type: 'window', postMessage(message, ports) {
        const { start, end } = message;
        ranges.push({ start, end });
        ports[0].postMessage({ size, mimeType: 'image/webp', data: bytes.slice(start, Math.min(end + 1, size)).buffer });
        ports[0].close();
    } };
    const noop = () => {};
    const runtime = { Request, Response, Headers, URL, ArrayBuffer, Uint8Array, ReadableStream, AbortController, DOMException, MessageChannel, crypto: webcrypto, setTimeout, clearTimeout,
        addEventListener: noop, clients: { async get() { return client; } }, self: { __WB_MANIFEST: [] },
        registerRoute: noop, cleanupOutdatedCaches: noop, precacheAndRoute: noop, createHandlerBoundToURL: noop,
        NavigationRoute: class {}, CacheFirst: class {}, CacheableResponsePlugin: class {}, ExpirationPlugin: class {},
    };
    vm.runInNewContext(compiled + '\nglobalThis.handle = handlePreviewRequest;', runtime);
    return { bytes, ranges, lifetimes, async request(headers = {}, method = 'GET') {
        const request = new Request('https://peerlink.test/__peerlink_preview/synthetic-id', { headers, method });
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
