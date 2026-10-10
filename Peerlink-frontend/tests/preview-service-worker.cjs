const { spawn } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = process.cwd();
const port = Number(process.env.PREVIEW_SW_TEST_PORT || 5193);
const baseUrl = `http://127.0.0.1:${port}`;
const chromePath = process.env.PEERLINK_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      if ((await fetch(baseUrl)).ok) return;
    } catch { /* Vite is still starting. */ }
    await wait(500);
  }
  throw new Error(`Vite did not start at ${baseUrl}`);
}

async function run() {
  const vite = spawn(process.execPath, [
    'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort',
  ], { cwd: root, stdio: 'ignore' });
  let browser;
  try {
    await waitForServer();
    browser = await chromium.launch({ headless: true, executablePath: chromePath });
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => {
      const { registerPeerLinkServiceWorker } = await import('/src/serviceWorker.ts');
      await registerPeerLinkServiceWorker(15000);
    });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), undefined, { timeout: 15000 });

    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.setBypassServiceWorker', { bypass: true });
    const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    await cdp.send('Page.reload', { ignoreCache: true });
    await navigation;
    const uncontrolledController = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null);
    if (uncontrolledController) throw new Error('Forced reload unexpectedly retained a controller.');

    await cdp.send('Network.setBypassServiceWorker', { bypass: false });
    const recoveryStarted = Date.now();
    const recoveredController = await page.evaluate(async () => {
      const { waitForPreviewServiceWorker } = await import('/src/preview/RangeBroker.ts');
      await waitForPreviewServiceWorker(15000);
      return navigator.serviceWorker.controller?.scriptURL ?? null;
    });
    const recoveryMs = Date.now() - recoveryStarted;
    if (!recoveredController) throw new Error('Readiness helper returned without restoring controller.');

    const fixture = await context.newPage();
    fixture.on('pageerror', (error) => pageErrors.push(error.message));
    const fixtureCdp = await context.newCDPSession(fixture);
    await fixtureCdp.send('Network.setBypassServiceWorker', { bypass: true });
    await fixture.route('**/tests/preview-fixture.html', (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body>Range fixture</body></html>',
    }));
    await fixture.goto(`${baseUrl}/tests/preview-fixture.html`, { waitUntil: 'domcontentloaded' });
    await fixtureCdp.send('Network.setBypassServiceWorker', { bypass: false });
    await fixture.evaluate(async () => {
      const { waitForPreviewServiceWorker } = await import('/src/preview/RangeBroker.ts');
      await waitForPreviewServiceWorker(10000);
    });

    const sourceBytes = Array.from({ length: 1600 }, (_, index) => (index * 37 + 19) % 256);
    const range = await fixture.evaluate(async (source) => {
      const { RangeBroker, createRemotePreviewUrl } = await import('/src/preview/RangeBroker.ts');
      const bytes = Uint8Array.from(source);
      const broker = new RangeBroker(async (request) => ({
        size: bytes.length,
        mimeType: 'audio/wav',
        data: bytes.slice(request.start, Math.min(request.end + 1, bytes.length)).buffer,
      }));
      broker.start();
      try {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const response = await fetch(createRemotePreviewUrl('test-audio'), {
          headers: { Range: 'bytes=128-527' },
        });
        return {
          status: response.status,
          contentRange: response.headers.get('content-range'),
          contentLength: response.headers.get('content-length'),
          bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
        };
      } finally {
        broker.dispose();
      }
    }, sourceBytes);

    const expectedBytes = sourceBytes.slice(128, 528);
    if (range.status !== 206 || range.contentRange !== 'bytes 128-527/1600' || range.contentLength !== '400' ||
        range.bytes.length !== 400 || JSON.stringify(range.bytes) !== JSON.stringify(expectedBytes)) {
      throw new Error(`Unexpected preview range response: ${JSON.stringify({ ...range, bytes: `[${range.bytes.length} bytes]` })}`);
    }
    if (pageErrors.length) throw new Error(`Page errors: ${pageErrors.join('; ')}`);

    console.log(JSON.stringify({
      uncontrolledController,
      recoveredController,
      recoveryMs,
      rangeStatus: range.status,
      contentRange: range.contentRange,
      contentLength: range.contentLength,
      byteCount: range.bytes.length,
      bytesMatch: true,
      pageErrors,
    }, null, 2));
  } finally {
    if (browser) await browser.close();
    vite.kill();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
