const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('C:/Users/hp/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = __dirname + '/..';
const vite = spawn(process.execPath, [root + '/node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5199', '--strictPort'], { cwd: root, windowsHide: true, stdio: 'ignore' });
let browser;
let passed = 0;
const check = (condition, message) => { assert.ok(condition, message); passed++; };
async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try { const response = await fetch('http://127.0.0.1:5199/tests/ui-selection.html'); if (response.ok) return; } catch {}
    await delay(250);
  }
  throw new Error('Vite did not start on port 5199');
}
async function main() {
  console.log('Starting isolated UI preview');
  await waitForServer();
  console.log('Opening browser');
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:5199/tests/ui-selection.html', { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'PeerLink UI selection checks' }).waitFor();
  console.log('Page mounted; starting checks');

  const files = Array.from({ length: 500 }, (_, i) => ({ name: `batch-${String(i).padStart(3, '0')}.bin`, mimeType: 'application/octet-stream', buffer: Buffer.alloc(i % 7 + 1) }));
  await page.locator('input[type=file]').first().setInputFiles(files);
  await page.getByRole('region', { name: 'Selected files before sending' }).waitFor();
  check(await page.locator('.staged-item').count() === 50, 'staged list is capped at 50 rendered rows');
  check(await page.getByText('500 files total', { exact: false }).count() === 1, 'staging reports all 500 files');
  check(await page.locator('.staged-send').isEnabled(), 'selected files are staged and send is explicit');
  check(await page.locator('.queue-item').count() === 0, 'staging does not auto-enqueue files');
  check(await page.locator('.staged-summary').innerText().then(s => s.includes('500 selected') && s.includes('1.95 KB')), 'selection count and total bytes are displayed');
  await page.getByRole('button', { name: 'Previous', exact: true }).first().click();
  check(await page.locator('.staged-item').count() === 50 && await page.getByText('Page 9 of 10').count() === 1, 'staged list starts at the most recently added page');
  await page.getByRole('button', { name: 'Next', exact: true }).first().click();
  check(await page.locator('.staged-item').count() === 50 && await page.getByText('Page 10 of 10').count() === 1, 'staged pagination advances by 50');
  await page.locator('.staged-list input[type=checkbox]').first().uncheck();
  check(await page.locator('.staged-summary').innerText().then(s => s.includes('499 selected')), 'individual deselection updates selected count');
  await page.getByRole('button', { name: 'Select all' }).click();
  check(await page.locator('.staged-summary').innerText().then(s => s.includes('500 selected')), 'select all restores selection');
  await page.getByRole('button', { name: 'Clear selection' }).click();
  check(await page.locator('.staged-summary').innerText().then(s => s.includes('0 selected')) && await page.locator('.staged-send').isDisabled(), 'clear selection disables sending');
  await page.getByRole('button', { name: 'Select all' }).click();
  await page.evaluate(() => window.uiTest.setAccepted(false));
  await page.locator('.staged-send').click();
  await page.getByRole('alert').filter({ hasText: 'still selected' }).waitFor();
  check(await page.locator('.staged-summary').innerText().then(s => s.includes('500 selected')) && await page.locator('.staged-item').count() === 50, 'rejected enqueue retains staged selection');
  await page.evaluate(() => window.uiTest.setAccepted(true));
  await page.locator('.staged-list input[type=checkbox]').first().uncheck();
  await page.locator('.staged-send').click();
  await page.waitForFunction(() => document.querySelectorAll('.staged-summary').length && document.querySelector('.staged-summary').textContent.includes('0 selected'));
  check(await page.locator('.staged-summary').innerText().then(s => s.includes('0 selected') && s.includes('1 files total')), 'accepted enqueue removes only selected files and preserves the deselected file');
  check((await page.evaluate(() => window.uiTest.payload())).length === 499, 'enqueue callback receives selected files only');
  await page.getByRole('button', { name: 'Remove batch-450.bin' }).click();
  check(await page.locator('.staged-item').count() === 0, 'remove button removes an individual staged file');

  await page.evaluate(() => {
    const entries = Array.from({ length: 105 }, (_, i) => ({
      isFile: true, isDirectory: false, name: `folder-${i}.txt`,
      file: success => success(new File(['x'], `folder-${i}.txt`, { type: 'text/plain' })),
    }));
    let read = 0;
    const directory = { isFile: false, isDirectory: true, name: 'batch-folder', createReader: () => ({ readEntries: success => { read++; success(read === 1 ? entries.slice(0, 100) : read === 2 ? entries.slice(100) : []); } }) };
    const transfer = { items: [{ kind: 'file', webkitGetAsEntry: () => directory }], files: [] };
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    document.querySelector('.drop-zone').dispatchEvent(event);
  });
  await page.getByText('105 files total', { exact: false }).waitFor();
  check(await page.locator('.staged-summary').innerText().then(s => s.includes('105 selected') && s.includes('105 files total')), 'folder drop reads multiple batches beyond the 100-entry browser limit');
  check(await page.locator('.file-path').first().innerText().then(s => s.startsWith('batch-folder/')), 'dropped folder files retain their relative paths');
  await page.getByRole('button', { name: 'Clear all staged files' }).click();
  check(await page.locator('.staged-item').count() === 0, 'clear all removes staged files');

  // Construct real queue fixtures in page context using Files and the component's public props.
  await page.evaluate(() => {
    const make = (name, status, size = 10) => ({ id: name, file: new File([new Uint8Array(size)], name, { type: 'application/octet-stream' }), recipientIds: [], recipients: [], status, progress: 0, lastSentChunk: 0, totalChunks: 1, bytesTransferred: status === 'sending' ? 1 : 0, ...(status === 'failed' ? { error: 'Connection lost' } : {}), ...(status === 'sending' ? { speedBytesPerSecond: 500 } : {}) });
    window.uiTest.setQueue([make('resume.bin', 'paused'), make('retry.bin', 'failed'), make('send.bin', 'sending')]);
  });
  await page.getByRole('button', { name: 'Resume resume.bin' }).click();
  await page.getByRole('button', { name: 'Retry retry.bin' }).click();
  const logs = await page.evaluate(() => window.uiTest.callbacks());
  check(logs.includes('resume:resume.bin') && logs.includes('retry:retry.bin'), 'resume and retry buttons call their distinct callbacks');
  check(await page.getByText('Connection lost').count() === 1, 'failed outgoing transfer shows its error');
  await page.evaluate(() => {
    const queue = Array.from({ length: 120 }, (_, i) => ({ id: `queue-${i}`, file: new File(['x'], `queue-${String(i).padStart(3, '0')}.bin`), recipientIds: [], recipients: [], status: 'pending', progress: 0, lastSentChunk: 0, totalChunks: 1 }));
    window.uiTest.setQueue(queue);
  });
  check(await page.locator('.queue-item').count() === 50, 'send queue renders only its first 50 rows');
  await page.getByRole('button', { name: 'Next', exact: true }).last().click();
  check(await page.locator('.queue-item').count() === 50 && await page.getByText('Page 2 of 3').count() === 1, 'send queue paginates in groups of 50');
  await page.evaluate(() => {
    const now = Date.now();
    window.uiTest.setReceivings([
      { fileId: 'failed', peerId: 'peer', peerName: 'Sender', name: 'failed.bin', progress: 60, size: 10000, startTime: now - 1000, bytesReceived: 6000, status: 'failed', error: 'Peer disconnected' },
      { fileId: 'active', peerId: 'peer', peerName: 'Sender', name: 'active.bin', progress: 10, size: 10000, startTime: now - 1000, bytesReceived: 1000, status: 'receiving' },
    ]);
  });
  check(await page.locator('.receive-failed .receive-status').textContent().then(s => s.trim() === 'Failed'), 'failed receive has a failed label');
  check(await page.locator('.receive-failed').getByRole('alert').innerText() === 'Peer disconnected', 'failed receive shows its error');
  check(await page.locator('.receive-failed .receive-meta').innerText().then(s => !s.includes('/s') && !s.includes('left')), 'failed receive suppresses speed and ETA');

  await page.evaluate(() => window.uiTest.setReceived(Array.from({ length: 120 }, (_, i) => ({ fileId: `received-${i}`, roomId: 'test', name: `received-${String(i).padStart(3, '0')}.txt`, size: i + 1, mimeType: 'text/plain', totalChunks: 1, receivedChunks: 1, status: 'complete', createdAt: Date.now() }))));
  check(await page.locator('.file-item').count() === 50, 'received list renders only first 50 files');
  await page.locator('.local-received-files .file-pagination').getByRole('button', { name: 'Next', exact: true }).click();
  check(await page.locator('.file-item').count() === 50 && await page.locator('.local-received-files .file-pagination').getByText('Page 2 of 3').count() === 1, 'received list paginates in groups of 50');

  await page.setViewportSize({ width: 320, height: 900 });
  await page.evaluate(() => window.scrollTo(0, 0));
  const mobile = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, buttons: [...document.querySelectorAll('button')].filter(b => b.getClientRects().length).map(b => ({ name: b.getAttribute('aria-label') || b.innerText.trim(), width: b.getBoundingClientRect().width, height: b.getBoundingClientRect().height })) }));
  check(mobile.scroll <= mobile.viewport, `320px layout has no horizontal overflow (${mobile.scroll}/${mobile.viewport})`);
  const shortTargets = mobile.buttons.filter(b => b.width < 44 || b.height < 44);
  check(shortTargets.length === 0, `visible mobile buttons meet 44px targets (${shortTargets.map(b => `${b.name}:${b.width.toFixed(0)}x${b.height.toFixed(0)}`).join('; ')})`);
  await page.screenshot({ path: root + '/tests/ui-selection-320px.png', fullPage: true });
  check(errors.length === 0, `browser has no uncaught errors: ${errors.join('; ')}`);
  console.log(`PASS ${passed} UI reliability checks`);
  console.log(`Counts: 500 staged; 50 visible per staged/queue/received page; 120 received files paginated; mobile 320px overflow ${mobile.scroll - mobile.viewport}px.`);
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close().catch(() => {});
  vite.kill();
});
