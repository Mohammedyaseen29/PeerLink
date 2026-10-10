// Suppress each page's first outbound offer; the pair must recover and stay healthy past the deadline.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.PEERLINK_BASE_URL || 'http://127.0.0.1:5178';
const stableWindowMs = 26_000;

(async () => {
  const browsers = [];
  const pages = [];
  const errors = [];
  try {
    for (let i = 0; i < 2; i++) {
      const browser = await chromium.launch({
        headless: true,
        ...(process.env.PEERLINK_CHROME ? { executablePath: process.env.PEERLINK_CHROME } : {}),
      });
      browsers.push(browser);
      const page = await browser.newPage();
      pages.push(page);
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        window.__offerProbe = { offers: 0, dropped: 0 };
        const send = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
          if (typeof data === 'string') {
            try {
              if (JSON.parse(data).type === 'offer') {
                window.__offerProbe.offers++;
                if (!window.__offerProbe.dropped) {
                  window.__offerProbe.dropped++;
                  return;
                }
              }
            } catch { /* Ignore non-signaling frames. */ }
          }
          return send.call(this, data);
        };
      });
    }

    await Promise.all(pages.map(page => page.goto(baseUrl, { waitUntil: 'domcontentloaded' })));
    const roomId = `negotiation-timeout-${Date.now()}`;
    await pages[0].getByText('Create Room', { exact: true }).first().click();
    await pages[0].locator('input[placeholder="Enter Room ID"]').fill(roomId);
    await pages[0].locator('button.join-btn').click();
    await pages[1].getByText('Join Room', { exact: true }).first().click();
    await pages[1].locator('input[placeholder="Paste Room ID here"]').fill(roomId);
    await pages[1].locator('button.join-btn').click();

    const pairReady = page => page.waitForFunction(
      () => document.body.innerText.includes('P2P Direct') && document.body.innerText.includes('Ready to receive'),
      null,
      { timeout: 80000 },
    );
    await Promise.all(pages.map(pairReady));
    const probes = await Promise.all(pages.map(page => page.evaluate(() => window.__offerProbe)));
    assert(probes.reduce((sum, probe) => sum + probe.dropped, 0) >= 1, 'the first offer was suppressed');
    assert(probes.reduce((sum, probe) => sum + probe.offers, 0) >= 2, 'a later offer retried negotiation');

    await new Promise(resolve => setTimeout(resolve, stableWindowMs));
    await Promise.all(pages.map(pairReady));
    const stableProbes = await Promise.all(pages.map(page => page.evaluate(() => window.__offerProbe)));
    assert.deepEqual(stableProbes.map(probe => probe.offers), probes.map(probe => probe.offers),
      'a connected session does not start another negotiation when its initial timeout elapses');
    assert.deepEqual(errors, [], 'pages raised no uncaught errors');
    console.log(JSON.stringify({ passed: true, roomId, probes, stableProbes, remainedConnectedMsAfterRecovery: stableWindowMs, pageErrors: errors }));
  } finally {
    for (const browser of browsers) await browser.close();
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
