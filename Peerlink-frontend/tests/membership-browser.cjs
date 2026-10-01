// Independent Chrome processes exercise the visible two-member product behavior.
// Configure PEERLINK_BASE_URL, PEERLINK_CHROME, PLAYWRIGHT_MODULE, and PEERLINK_LONG_IDLE as needed.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.PEERLINK_BASE_URL || 'http://127.0.0.1:5173';
const executablePath = process.env.PEERLINK_CHROME;
const longIdle = process.env.PEERLINK_LONG_IDLE === '1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const expectedRoomBytes = Buffer.from([11, 23, 47, 89, 144]);

async function storedBytes(page, name) {
    await page.locator('.local-received-files .file-name', { hasText: name }).waitFor({ timeout: 60000 });
    return page.evaluate(async fileName => {
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('PeerLink_files', 4);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const metadata = await new Promise((resolve, reject) => {
            const request = db.transaction('files', 'readonly').objectStore('files').getAll();
            request.onsuccess = () => resolve(request.result.find(item => item.name === fileName));
            request.onerror = () => reject(request.error);
        });
        if (!metadata) throw new Error(`No stored file metadata for ${fileName}`);
        const chunks = await new Promise((resolve, reject) => {
            const request = db.transaction('chunks', 'readonly').objectStore('chunks')
                .getAll(IDBKeyRange.bound([metadata.fileId, 0], [metadata.fileId, Number.MAX_SAFE_INTEGER]));
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        db.close();
        chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
        return { metadata, bytes: chunks.flatMap(chunk => [...new Uint8Array(chunk.data)]) };
    }, name);
}
async function verifyStored(page, name, expected) {
    const record = await storedBytes(page, name);
    assert.equal(record.metadata.status, 'complete');
    assert.deepEqual(Buffer.from(record.bytes), expected, `stored bytes for ${name} match exactly`);
}
async function waitForPair(pages) {
    for (const page of pages) await page.waitForFunction(() =>
        document.querySelector('.group-members-count')?.textContent?.trim() === '2 / 2', null, { timeout: 60000 });
    for (const page of pages) await page.waitForFunction(() =>
        [...document.querySelectorAll('.member-entry .member-copy span')].filter(node => node.textContent === 'Ready to receive').length === 1,
        null, { timeout: 60000 });
}
async function seedSavedRoomFile(page, roomId) {
    await page.evaluate(async ({ room, data }) => {
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('PeerLink_files', 4);
            request.onupgradeneeded = () => {
                const files = request.result.createObjectStore('files', { keyPath: 'fileId' });
                files.createIndex('roomId', 'roomId');
                const chunks = request.result.createObjectStore('chunks', { keyPath: ['fileId', 'chunkIndex'] });
                chunks.createIndex('fileId', 'fileId');
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const fileId = `saved-${room}`;
        const tx = db.transaction(['files', 'chunks'], 'readwrite');
        tx.objectStore('files').put({ fileId, roomId: room, roomType: 'persistent', name: 'saved-before-room-full.bin',
            size: data.length, mimeType: 'application/octet-stream', totalChunks: 1, receivedChunks: 1, status: 'complete',
            createdAt: Date.now(), sourcePeerId: 'local-test' });
        tx.objectStore('chunks').put({ fileId, chunkIndex: 0, data: new Uint8Array(data).buffer });
        await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
        db.close();
    }, { room: roomId, data: [...expectedRoomBytes] });
}
async function joinRoom(page, roomId) {
    if (await page.locator('.room-leave-btn').count()) await page.locator('.room-leave-btn').click();
    const joinMode = page.locator('.room-mode-btn.join');
    if (await joinMode.count()) await joinMode.click();
    await page.locator('input[placeholder="Paste Room ID here"]').fill(roomId);
    await page.locator('.join-btn').click();
}
async function sendFile(sender, recipients, name, bytes) {
    await sender.locator('input[type="file"]').first().setInputFiles({ name, mimeType: 'application/octet-stream', buffer: bytes });
    await Promise.all(recipients.map(page => verifyStored(page, name, bytes)));
}

(async () => {
    const browsers = [], contexts = [], pages = [], sessions = [];
    try {
        for (let index = 0; index < 3; index++) {
            const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}),
                args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
            browsers.push(browser);
            const context = await browser.newContext(); contexts.push(context);
            await context.addInitScript(() => {
                window.__peerlinkDiagnostic = { sockets: [], sent: [], forwarded: [], received: [], events: [] };
                const nativeSend = WebSocket.prototype.send;
                WebSocket.prototype.send = function (data) {
                    if (typeof data === 'string') {
                        try {
                            const message = JSON.parse(data);
                            const diag = window.__peerlinkDiagnostic;
                            diag.sent.push({ type: message.type, at: Date.now() });
                            if (message.type === 'join') {
                                diag.sockets.push(this);
                                if (!this.__peerlinkObserved) {
                                    this.__peerlinkObserved = true;
                                    this.addEventListener('message', event => {
                                        try { const incoming = JSON.parse(String(event.data));
                                            diag.received.push({ type: incoming.type, code: incoming.code, maxPeers: incoming.maxPeers,
                                                supportsReconnect: incoming.supportsReconnect, peerSupportsReconnect: incoming.peer?.supportsReconnect, at: Date.now() });
                                        } catch { /* Ignore non-JSON frames. */ }
                                    });
                                    this.addEventListener('close', event => diag.events.push({ type: 'close', code: event.code, reason: event.reason, clean: event.wasClean, at: Date.now() }));
                                    this.addEventListener('error', () => diag.events.push({ type: 'error', at: Date.now() }));
                                }
                            }
                            if (window.__suppressRoomSync && ['heartbeat', 'sync'].includes(message.type)) {
                                diag.events.push({ type: 'suppressed', frame: message.type, at: Date.now() });
                                return;
                            }
                            diag.forwarded.push({ type: message.type, at: Date.now() });
                        } catch { /* Ignore non-JSON payloads. */ }
                    }
                    return nativeSend.call(this, data);
                };
            });
            const page = await context.newPage(); pages.push(page);
            page.on('pageerror', error => sessions[index].errors.push(error.message));
            const record = { errors: [] }; sessions.push(record);
            await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        }

        const bundle = await pages[0].evaluate(() => [...document.scripts].map(script => script.src).filter(Boolean));
        console.log(JSON.stringify({ event: 'bundle', bundle, at: Date.now() }));
        await pages[0].locator('.room-mode-btn.create').click();
        await pages[0].getByRole('button', { name: 'Persistent', exact: true }).click();
        const roomId = `capacity-${Date.now()}`;
        await pages[0].locator('input[placeholder="Enter Room ID"]').fill(roomId);
        await pages[0].getByRole('button', { name: 'Create Room', exact: true }).click();
        await pages[0].locator('.group-members-count').waitFor();
        await seedSavedRoomFile(pages[2], roomId);
        await joinRoom(pages[1], roomId);
        await waitForPair(pages.slice(0, 2));
        const joinedInfo = await pages[0].evaluate(() => window.__peerlinkDiagnostic.received.find(frame => frame.type === 'joined'));
        assert.equal(joinedInfo?.maxPeers, 2);
        const advertisedPeer = await pages[0].evaluate(() => window.__peerlinkDiagnostic.received.find(frame => frame.type === 'peer_joined'));
        assert.equal(advertisedPeer?.peerSupportsReconnect, true, 'joined peer advertises reconnect support');
        console.log(JSON.stringify({ event: 'pair-connected', roomId, counts: await Promise.all(pages.slice(0, 2).map(page => page.locator('.group-members-count').innerText())),
            sockets: await Promise.all(pages.slice(0, 2).map(page => page.evaluate(() => window.__peerlinkDiagnostic.sockets.map(ws => ws.url)))),
            peerMetadata: await pages[0].evaluate(() => window.__peerlinkDiagnostic.received.filter(frame => frame.type === 'joined' || frame.type === 'peer_joined')) }));

        await joinRoom(pages[2], roomId);
        await pages[2].waitForFunction(() => document.querySelector('.room-status-copy strong')?.textContent?.trim() === 'Room is full', null, { timeout: 20000 });
        await pages[2].locator('.local-received-files .file-name', { hasText: 'saved-before-room-full.bin' }).waitFor({ timeout: 20000 });
        await verifyStored(pages[2], 'saved-before-room-full.bin', expectedRoomBytes);
        const thirdDiagnostics = await pages[2].evaluate(() => ({ received: window.__peerlinkDiagnostic.received,
            events: window.__peerlinkDiagnostic.events, socketUrls: window.__peerlinkDiagnostic.sockets.map(socket => socket.url) }));
        assert(thirdDiagnostics.received.some(message => message.type === 'room_full' && message.maxPeers === 2));
        assert(thirdDiagnostics.events.some(event => event.type === 'close' && event.code === 4001), 'third socket closes as full-room');
        await waitForPair(pages.slice(0, 2));
        assert.deepEqual(sessions.map(session => session.errors), [[], [], []]);
        console.log(JSON.stringify({ event: 'third-rejected-with-files-retained', roomFull: true, thirdSocket: thirdDiagnostics.socketUrls,
            close: thirdDiagnostics.events.find(event => event.type === 'close'), savedFile: 'saved-before-room-full.bin' }));

        const firstFile = Buffer.from(Array.from({ length: 32003 }, (_, index) => (index * 19 + 5) & 255));
        await sendFile(pages[0], [pages[1]], 'pair-before-idle.bin', firstFile);
        console.log('PASS: third join rejected at maxPeers=2; the remaining pair transferred exact bytes; saved room file remained available');
        const idleStart = Date.now();
        const initialIdle = longIdle ? 52000 : 50500;
        await sleep(initialIdle);
        assert.deepEqual(await Promise.all(pages.slice(0, 2).map(async page => {
            const value = await page.locator('.group-members-count').innerText();
            return value.trim();
        })), ['2 / 2', '2 / 2']);

        if (longIdle) {
            const baseline = await pages[1].evaluate(() => ({
                roomStates: window.__peerlinkDiagnostic.received.filter(frame => frame.type === 'room_state').length,
                heartbeatCount: window.__peerlinkDiagnostic.forwarded.filter(frame => frame.type === 'heartbeat').length,
                syncCount: window.__peerlinkDiagnostic.forwarded.filter(frame => frame.type === 'sync').length,
            }));
            await pages[1].evaluate(() => { window.__suppressRoomSync = true; });
            console.log(JSON.stringify({ event: 'heartbeat-sync-suppression-start', elapsed: Date.now() - idleStart,
                url: await pages[1].evaluate(() => window.__peerlinkDiagnostic.sockets.at(-1)?.url) }));
            for (let slept = 0; slept < 190000; slept += 30000) {
                await sleep(Math.min(30000, 190000 - slept));
                const otherState = await pages[0].evaluate(() => ({ count: document.querySelector('.group-members-count')?.textContent?.trim(),
                    ready: [...document.querySelectorAll('.member-entry .member-copy span')].filter(node => node.textContent === 'Ready to receive').length,
                    ws: window.__peerlinkDiagnostic.sockets.map(socket => socket.readyState) }));
                assert.equal(otherState.count, '2 / 2');
                assert.equal(otherState.ready, 1);
                assert(otherState.ws.every(state => state === 1));
                const suppressed = await pages[1].evaluate(() => ({
                    heartbeatCount: window.__peerlinkDiagnostic.forwarded.filter(frame => frame.type === 'heartbeat').length,
                    syncCount: window.__peerlinkDiagnostic.forwarded.filter(frame => frame.type === 'sync').length,
                    suppressedCount: window.__peerlinkDiagnostic.events.filter(event => event.type === 'suppressed').length,
                }));
                assert.equal(suppressed.heartbeatCount, baseline.heartbeatCount, 'no heartbeat frames reached the socket while paused');
                assert.equal(suppressed.syncCount, baseline.syncCount, 'no sync frames reached the socket while paused');
                assert(suppressed.suppressedCount >= 1, 'the deterministic shim intercepted periodic heartbeats and syncs');
                console.log(JSON.stringify({ event: 'suppressed-idle-progress', suppressedMs: slept + Math.min(30000, 190000 - slept), otherState }));
            }
            await pages[1].evaluate(() => { window.__suppressRoomSync = false; window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
            await pages[1].waitForFunction(count => window.__peerlinkDiagnostic.received.filter(message => message.type === 'room_state').length > count,
                baseline.roomStates, { timeout: 10000 });
            await waitForPair(pages.slice(0, 2));
            assert(Date.now() - idleStart > 240000, 'two-member session remains open for more than four minutes');
            console.log(JSON.stringify({ event: 'resumed-after-heartbeat-suppression', elapsed: Date.now() - idleStart,
                state: await pages[1].evaluate(() => ({ count: document.querySelector('.group-members-count')?.textContent?.trim(),
                    url: window.__peerlinkDiagnostic.sockets.at(-1)?.url, sends: window.__peerlinkDiagnostic.sent.filter(frame => frame.type === 'heartbeat').slice(-3),
                    received: window.__peerlinkDiagnostic.received.filter(frame => frame.type === 'room_state').slice(-1) })) }));
        } else {
            await Promise.all(pages.slice(0, 2).map(page => page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); })));
            await sleep(500);
            await waitForPair(pages.slice(0, 2));
        }

        const postIdle = Buffer.from(Array.from({ length: 96013 }, (_, index) => (index * 13 + 7) & 255));
        await sendFile(pages[1], [pages[0]], 'pair-after-idle-resume.bin', postIdle);
        console.log('PASS: paired session retained 2/2 and completed an exact transfer after idle/resync');

        await pages[1].locator('.room-leave-btn').click();
        await pages[0].waitForFunction(() => document.querySelector('.group-members-count')?.textContent?.trim() === '1 / 2', null, { timeout: 20000 });
        await joinRoom(pages[2], roomId);
        await waitForPair([pages[0], pages[2]]);
        const replacement = Buffer.from([241, 242, 243, 244, 245, 246]);
        await sendFile(pages[2], [pages[0]], 'replacement-peer.bin', replacement);
        console.log('PASS: manual leave freed a slot, the previously rejected client joined, and replacement bytes matched');
        await pages[2].locator('.room-leave-btn').click();
        await pages[1].waitForTimeout(200);
        await joinRoom(pages[1], roomId);
        await waitForPair([pages[0], pages[1]]);
        assert.deepEqual(sessions.map(session => session.errors), [[], [], []]);
        console.log('PASS: original client rejoined and pair returned to 2/2');
    } finally {
        for (const context of contexts) await context.close();
        for (const browser of browsers) await browser.close();
    }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
