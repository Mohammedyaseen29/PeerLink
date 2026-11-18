const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const playwrightModule = process.env.PLAYWRIGHT_MODULE;
const { firefox, webkit, chromium } = playwrightModule ? require(playwrightModule) : require('playwright');
const root = path.resolve(__dirname, '../..');
const frontend = path.resolve(__dirname, '..');
const node = process.execPath;
const vite = path.join(frontend, 'node_modules/vite/bin/vite.js');
const wrangler = path.join(root, 'edge/signaling-server/node_modules/wrangler/bin/wrangler.js');
const children = [];
function start(args, cwd, env = {}) {
  const child = spawn(node, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => process.stdout.write(data));
  child.stderr.on('data', data => process.stderr.write(data));
  child.on('error', error => console.error(`process failed to start (${args[0]}): ${error.message}`));
  children.push(child);
  return child;
}
async function waitPort(url) {
  const { hostname, port } = new URL(url);
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.connect({ host: hostname, port: Number(port) }, () => { socket.destroy(); resolve(); });
        socket.once('error', reject);
      });
      return;
    } catch {}
    await delay(500);
  }
  throw new Error(`service did not start: ${url}`);
}
async function runBrowser(name, engine, launchOptions = {}) {
  let browser;
  let page;
  const errors = [];
  try {
    browser = await engine.launch(launchOptions);
    const context = await browser.newContext({ acceptDownloads: true });
    page = await context.newPage();
    page.setDefaultTimeout(30000);
    const capabilities = await page.evaluate(() => ({
      RTCPeerConnection: typeof window.RTCPeerConnection,
      RTCDataChannel: typeof window.RTCDataChannel,
    }));
    console.log(`ENGINE ${name}: version=${browser.version()} RTCPeerConnection=${capabilities.RTCPeerConnection} RTCDataChannel=${capabilities.RTCDataChannel}`);
    if (capabilities.RTCPeerConnection !== 'function') {
      console.log(`BLOCKED ${name}: this runtime does not expose RTCPeerConnection, so real WebRTC/data-channel compatibility cannot be tested.`);
      return;
    }
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${response.url()}`); });
    await page.goto('http://127.0.0.1:5212/transfer-test.html?quick', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Run integration tests' }).click();
    await page.waitForFunction(() => {
      const transcript = document.querySelector('pre')?.innerText ?? '';
      return /ALL TESTS PASSED|FAIL:/.test(transcript);
    }, null, { timeout: 900000 });
    const result = await page.locator('pre').innerText();
    if (result.includes('FAIL:')) throw new Error(`integration suite failed:\n${result}`);
    console.log(`PASS ${name}: ${result.split('\n').filter(line => line.startsWith('PASS:') || line === 'ALL TESTS PASSED').join('; ')}`);
    if (errors.length) console.warn(`WARN ${name} console/resource errors: ${errors.join(' | ')}`);
  } catch (error) {
    const details = page ? `\nURL: ${page.url()}\nBody: ${(await page.locator('body').innerText().catch(() => '<unavailable>')).slice(0, 2000)}\nBrowser messages: ${errors.join(' | ')}` : '';
    console.error(`FAIL ${name}: ${error.stack || error}${details}`);
    process.exitCode = 1;
  } finally { if (browser) await browser.close(); }
}
(async () => {
  try {
    const wranglerConfigHome = path.join(root, '.wrangler-config');
    start([wrangler, 'dev', '--local', '--port', '8812', '--ip', '127.0.0.1'], path.join(root, 'edge/signaling-server'), {
      APPDATA: wranglerConfigHome, XDG_CONFIG_HOME: wranglerConfigHome, WRANGLER_SEND_METRICS: 'false',
    });
    start([vite, '--host', '127.0.0.1', '--port', '5212', '--strictPort'], frontend, { VITE_SIGNALING_SERVER_URL: 'ws://127.0.0.1:8812' });
    await waitPort('http://127.0.0.1:8812');
    await waitPort('http://127.0.0.1:5212/transfer-test.html');
    const selected = new Set((process.env.CROSS_BROWSER || 'all').toLowerCase().split(',').map(value => value.trim()));
    if (selected.has('all') || selected.has('firefox')) await runBrowser('Firefox', firefox);
    if (selected.has('all') || selected.has('webkit')) await runBrowser('WebKit (Safari engine)', webkit);
    const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
    if ((selected.has('all') || selected.has('edge')) && fs.existsSync(edge)) await runBrowser('Microsoft Edge', chromium, { executablePath: edge, channel: 'msedge' });
  } finally {
    for (const child of children) { try { child.kill(); } catch {} }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
