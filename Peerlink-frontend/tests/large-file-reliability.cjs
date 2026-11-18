const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const port = 5222;
const base = `http://127.0.0.1:${port}`;
const chromePath = process.env.PEERLINK_CHROME;
const testMode = process.env.PEERLINK_TEST_MODE || 'full';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/tests/large-file-reliability.html`)).ok) return; } catch {}
    await wait(250);
  }
  throw new Error('Vite did not start on port 5222');
}

async function run() {
  const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, windowsHide: true, stdio: 'ignore' });
  const tempRoot = path.resolve(os.tmpdir());
  const userDataDir = fs.mkdtempSync(path.join(tempRoot, 'peerlink-large-file-'));
  let context;
  let page;
  try {
    await waitForServer();
    context = await chromium.launchPersistentContext(userDataDir, { headless: true, ...(chromePath ? { executablePath: chromePath } : {}), acceptDownloads: true });
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/tests/large-file-reliability.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.runLargeTransfer === 'function' && typeof window.runSmallCappedFrameTest === 'function');
    const started = Date.now();
    const work = testMode === 'capped'
      ? page.evaluate(async () => ({ capped: await window.runSmallCappedFrameTest() }))
      : page.evaluate(async () => ({ large: await window.runLargeTransfer(), capped: await window.runSmallCappedFrameTest() }));
    let last = '';
    while (Date.now() - started < 60 * 60 * 1000) {
      const status = await page.locator('#status').innerText().catch(() => '');
      if (status && status !== last) { console.log(status); last = status; }
      const settled = await Promise.race([work.then(() => true, () => true), wait(500).then(() => false)]);
      if (settled) break;
    }
    if (Date.now() - started >= 60 * 60 * 1000) throw new Error('Large transfer exceeded 60 minute test timeout');
    const result = await work;
    console.log(JSON.stringify({ transferPhasePassed: true, mode: testMode, ...result }, null, 2));
    if (testMode === 'capped') {
      if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
      return;
    }
    if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
  } finally {
    if (page) await page.evaluate(async () => {
      const { deleteFile } = await import('/src/ProgressDB.ts');
      const fileId = window.largeFileId;
      if (typeof fileId === 'string') await deleteFile(fileId).catch(() => {});
      try { await (await navigator.storage.getDirectory()).removeEntry('peerlink-large-source-2gib.bin'); } catch {}
    }).catch(() => {});
    if (context) await context.close().catch(() => {});
    vite.kill();
    const resolvedUserDataDir = path.resolve(userDataDir);
    const relativeTempPath = path.relative(tempRoot, resolvedUserDataDir);
    if (!relativeTempPath || relativeTempPath.startsWith('..') || path.isAbsolute(relativeTempPath)) throw new Error('Refusing to remove a browser profile outside the temporary directory.');
    fs.rmSync(resolvedUserDataDir, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
