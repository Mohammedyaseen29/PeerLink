const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const port = Number(process.env.PEERLINK_SW_ATTACHMENT_PORT || 5223);
const base = `http://127.0.0.1:${port}`;
const chromePath = process.env.PEERLINK_CHROME;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/tests/sw-attachment-fixture.html`)).ok) return; } catch {}
    await delay(250);
  }
  throw new Error(`Vite did not start at ${base}`);
}

async function run() {
  const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, windowsHide: true, stdio: 'ignore' });
  const tempRoot = path.resolve(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(tempRoot, 'peerlink-sw-attachment-'));
  let context, page;
  try {
    await waitForServer();
    context = await chromium.launchPersistentContext(profile, { headless: true, ...(chromePath ? { executablePath: chromePath } : {}), acceptDownloads: true });
    page = await context.newPage();
    const pageErrors = [];
    const responses = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('response', response => {
      if (new URL(response.url()).pathname.startsWith('/__peerlink_download/')) responses.push({ status: response.status(), headers: response.headers(), url: response.url() });
    });
    await page.goto(`${base}/tests/sw-attachment-fixture.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.runLargeAttachmentDownload === 'function');
    const downloadEvent = page.waitForEvent('download', { timeout: 120000 });
    const attachmentPromise = page.evaluate(() => window.runLargeAttachmentDownload());
    const [download, attachment] = await Promise.all([downloadEvent, attachmentPromise]);
    const response = responses.find(item => item.status === 200);
    if (!response || response.headers['content-length'] !== String(attachment.sizeBytes) || response.headers['content-type'] !== 'application/octet-stream' || !response.headers['content-disposition']?.includes('attachment')) {
      throw new Error(`Missing/invalid attachment response headers: ${JSON.stringify(response)}`);
    }
    const output = path.join(profile, 'downloaded-attachment.bin');
    await download.saveAs(output);
    const expected = crypto.createHash('sha256');
    for (let start = 0; start < attachment.sizeBytes; start += 1024 * 1024) {
      const length = Math.min(1024 * 1024, attachment.sizeBytes - start);
      const block = Buffer.allocUnsafe(length);
      for (let i = 0; i < length; i++) block[i] = (Math.imul(start + i, 43) + ((start + i) >>> 8) + 9) & 255;
      expected.update(block);
    }
    const expectedSha256 = expected.digest('hex');
    const actual = crypto.createHash('sha256');
    let bytesRead = 0;
    for await (const block of fs.createReadStream(output)) { bytesRead += block.length; actual.update(block); }
    const actualSha256 = actual.digest('hex');
    if (bytesRead !== attachment.sizeBytes || actualSha256 !== expectedSha256) throw new Error(`Downloaded attachment mismatch: ${bytesRead} bytes, sha256 ${actualSha256}`);
    const replay = await page.evaluate(async url => {
      const response = await fetch(url);
      return { status: response.status, contentType: response.headers.get('content-type'), body: await response.text() };
    }, download.url());
    if (replay.status !== 410) throw new Error(`Expected one-use URL replay to return 410, got ${replay.status}`);
    if (pageErrors.length) throw new Error(`Browser errors: ${pageErrors.join('; ')}`);
    console.log(JSON.stringify({ passed: true, browser: await page.evaluate(() => navigator.userAgent), attachment, response: { status: response.status, ...response.headers }, suggestedFilename: download.suggestedFilename(), bytesRead, actualSha256, expectedSha256, replay, pageErrors }, null, 2));
  } finally {
    if (page) await page.evaluate(async () => {
      const { deleteFile } = await import('/src/ProgressDB.ts');
      await deleteFile('large-attachment-test').catch(() => {});
    }).catch(() => {});
    if (context) await context.close().catch(() => {});
    vite.kill();
    const resolved = path.resolve(profile);
    const relative = path.relative(tempRoot, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Refusing to remove profile outside the temporary directory.');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
