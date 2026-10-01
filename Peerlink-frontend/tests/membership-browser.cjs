// Three isolated browser contexts exercising the visible app and separate IndexedDB stores.
// Configure PEERLINK_BASE_URL, PEERLINK_CHROME, and PLAYWRIGHT_MODULE for the local environment.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const baseUrl = process.env.PEERLINK_BASE_URL || 'http://127.0.0.1:5173';
const executablePath = process.env.PEERLINK_CHROME;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function text(locator) { return (await locator.innerText()).trim(); }
async function joinRoom(page, roomId) {
    if (await page.locator('.room-leave-btn').count()) await page.locator('.room-leave-btn').click();
    const joinMode = page.locator('.room-mode-btn.join');
    if (await joinMode.count()) await joinMode.click();
    await page.locator('input[placeholder="Paste Room ID here"]').fill(roomId);
    await page.locator('.join-btn').click();
}

(async () => {
    const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}),
        args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
    const contexts = [];
    try {
        const pages = [];
        for (let index = 0; index < 3; index++) {
            const context = await browser.newContext();
            contexts.push(context);
            await context.addInitScript(() => {
                window.__peerlinkTestPCs = [];
                window.__peerlinkTestSockets = [];
                const NativePC = window.RTCPeerConnection;
                window.RTCPeerConnection = new Proxy(NativePC, { construct(target, args, newTarget) {
                    const pc = Reflect.construct(target, args, newTarget);
                    window.__peerlinkTestPCs.push(pc);
                    return pc;
                } });
                const nativeSend = WebSocket.prototype.send;
                WebSocket.prototype.send = function (data) {
                    if (typeof data === 'string') {
                        try {
                            if (JSON.parse(data).type === 'join') window.__peerlinkTestSockets.push(this);
                        } catch { /* Ignore non-JSON payloads. */ }
                    }
                    return nativeSend.call(this, data);
                };
            });
            const page = await context.newPage();
            pages.push(page);
            await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
        }

        await pages[0].locator('.room-mode-btn.create').click();
        await pages[0].getByRole('button', { name: 'Persistent', exact: true }).click();
        const roomId = `member-check-${Date.now()}`;
        await pages[0].locator('input[placeholder="Enter Room ID"]').fill(roomId);
        await pages[0].getByRole('button', { name: 'Create Room', exact: true }).click();
        await pages[0].locator('.group-members-count').waitFor();
        await joinRoom(pages[1], roomId);
        await joinRoom(pages[2], roomId);
        await Promise.all(pages.map(page => page.waitForFunction(() =>
            document.querySelector('.group-members-count')?.textContent?.trim() === '3 / 4', null, { timeout: 60000 })));
        await Promise.all(pages.map(page => page.waitForFunction(() =>
            [...document.querySelectorAll('.member-entry .member-copy span')].filter(node => node.textContent === 'Ready to receive').length === 2,
            null, { timeout: 60000 })));
        console.log('PASS: three separate Chrome contexts joined and each UI showed 3 / 4');

        // Allow two signaling heartbeat ticks while all real tabs remain open.
        await sleep(50_500);
        assert.deepEqual(await Promise.all(pages.map(page => text(page.locator('.group-members-count')))), ['3 / 4', '3 / 4', '3 / 4']);
        await Promise.all(pages.map(page => page.evaluate(() => {
            window.dispatchEvent(new Event('focus'));
            document.dispatchEvent(new Event('visibilitychange'));
        })));
        await sleep(500);
        assert.deepEqual(await Promise.all(pages.map(page => text(page.locator('.group-members-count')))), ['3 / 4', '3 / 4', '3 / 4']);
        console.log('PASS: separate contexts remained 3 / 4 through idle heartbeats and focus/visibility sync');

        const thirdPcCount = await pages[2].evaluate(() => window.__peerlinkTestPCs.length);
        assert.equal(thirdPcCount, 2, 'third context has one WebRTC connection to each other member');
        await pages[2].evaluate(() => window.__peerlinkTestPCs[0].close());
        await sleep(500);
        assert.deepEqual(await Promise.all(pages.map(page => text(page.locator('.group-members-count')))), ['3 / 4', '3 / 4', '3 / 4'],
            'RTC-only failure must not reduce any authoritative roster count');
        await Promise.all(pages.map(page => page.waitForFunction(() =>
            [...document.querySelectorAll('.member-entry .member-copy span')].filter(node => node.textContent === 'Ready to receive').length === 2,
            null, { timeout: 60000 })));
        console.log('PASS: closing one third-user RTCPeerConnection preserved all visible 3 / 4 counts and recovered the mesh');

        const fileName = 'third-peer-after-idle.bin';
        const expected = Buffer.from(Array.from({ length: 96_013 }, (_, index) => (index * 13 + 7) & 255));
        await pages[2].locator('input[type="file"]').first().setInputFiles({ name: fileName, mimeType: 'application/octet-stream', buffer: expected });
        const verifyStored = async page => {
            await page.locator('.local-received-files .file-name', { hasText: fileName }).waitFor({ timeout: 60000 });
            const received = await page.evaluate(async name => {
                const db = await new Promise((resolve, reject) => {
                    const request = indexedDB.open('PeerLink_files', 4);
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                });
                const metadata = await new Promise((resolve, reject) => {
                    const request = db.transaction('files', 'readonly').objectStore('files').getAll();
                    request.onsuccess = () => resolve(request.result.find(item => item.name === name));
                    request.onerror = () => reject(request.error);
                });
                if (!metadata) throw new Error(`Missing stored metadata for ${name}`);
                const chunks = await new Promise((resolve, reject) => {
                    const request = db.transaction('chunks', 'readonly').objectStore('chunks')
                        .getAll(IDBKeyRange.bound([metadata.fileId, 0], [metadata.fileId, Number.MAX_SAFE_INTEGER]));
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                });
                db.close();
                chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
                return { metadata, bytes: chunks.flatMap(chunk => [...new Uint8Array(chunk.data)]) };
            }, fileName);
            assert.equal(received.metadata.status, 'complete');
            assert.deepEqual(Buffer.from(received.bytes), expected, `${fileName} bytes match in each recipient's isolated store`);
        };
        await Promise.all(pages.slice(0, 2).map(verifyStored));
        console.log('PASS: third user sent an exact byte-verified file to both isolated recipients after idle and RTC recovery');

        await pages[2].evaluate(() => window.__peerlinkTestSockets.at(-1).close());
        await pages[2].waitForFunction(() => document.querySelector('.group-members-count')?.textContent?.trim() === 'Offline', null, { timeout: 15000 });
        await Promise.all(pages.slice(0, 2).map(page => page.waitForFunction(() =>
            document.querySelector('.group-members-count')?.textContent?.trim() === '2 / 4', null, { timeout: 15000 })));
        console.log('PASS: true signaling loss marked the third context Offline and the remaining contexts 2 / 4');

        await joinRoom(pages[2], roomId);
        await Promise.all(pages.map(page => page.waitForFunction(() =>
            document.querySelector('.group-members-count')?.textContent?.trim() === '3 / 4', null, { timeout: 60000 })));
        console.log('PASS: third context rejoined and all visible counts returned to 3 / 4');
    } finally {
        for (const context of contexts) await context.close();
        await browser.close();
    }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
