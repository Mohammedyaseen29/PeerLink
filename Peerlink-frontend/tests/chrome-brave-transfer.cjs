const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const base = `${process.env.PEERLINK_TEST_BASE_URL || 'http://127.0.0.1:5173'}/browser-peer.html`;
const chromePath = process.env.PEERLINK_CHROME_EXECUTABLE || process.env.CHROME_EXECUTABLE || undefined;
const bravePath = process.env.PEERLINK_BRAVE_EXECUTABLE || process.env.BRAVE_EXECUTABLE || undefined;
const room = `interop-${Date.now()}`;
const deadline = Date.now() + 120000;

(async () => {
  const chrome = await chromium.launch({ headless: true, ...(chromePath ? { executablePath: chromePath } : {}) });
  const brave = await chromium.launch({ headless: true, ...(bravePath ? { executablePath: bravePath } : {}) });
  let a, b;
  const errors = [];
  try {
    a = await chrome.newPage(); b = await brave.newPage();
    a.on('pageerror', e => errors.push(`Chrome:${e.name}`));
    b.on('pageerror', e => errors.push(`Brave:${e.name}`));
    await Promise.all([a.goto(base, { waitUntil: 'domcontentloaded', timeout: 20000 }), b.goto(base, { waitUntil: 'domcontentloaded', timeout: 20000 })]);
    await Promise.all([a, b].map(page => page.waitForFunction(() => Boolean(window.peerProbe), null, { timeout: 20000 })));
    await a.evaluate(id => window.peerProbe.join(id), room);
    await b.evaluate(id => window.peerProbe.join(id), room);
    const waitUntil = async (predicate, label, timeout = 60000) => {
      const stop = Date.now() + timeout;
      while (Date.now() < stop) {
        const [sa, sb] = await Promise.all([a.evaluate(() => window.peerProbe.summary()), b.evaluate(() => window.peerProbe.summary())]);
        if (predicate(sa, sb)) return [sa, sb];
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw new Error(`Timed out waiting for ${label}`);
    };
    const [connectedA, connectedB] = await waitUntil((x, y) => x.connected && y.connected && x.members.some(m => m.status === 'connected') && y.members.some(m => m.status === 'connected'), 'cross-browser P2P');
    await Promise.all([
      a.evaluate(() => window.peerProbe.add('chrome-to-brave.bin', 4 * 1024 * 1024 + 123, 17)),
      b.evaluate(() => window.peerProbe.add('brave-to-chrome.bin', 4 * 1024 * 1024 + 123, 29)),
    ]);
    const [finalA, finalB] = await waitUntil((x, y) =>
      x.sent.some(f => f.name === 'chrome-to-brave.bin' && f.status === 'sent') &&
      y.sent.some(f => f.name === 'brave-to-chrome.bin' && f.status === 'sent') &&
      x.received.some(f => f.name === 'brave-to-chrome.bin') && y.received.some(f => f.name === 'chrome-to-brave.bin'),
    'bidirectional transfer completion', 90000);
    const [verifyAtChrome, verifyAtBrave] = await Promise.all([
      a.evaluate(() => window.peerProbe.received('brave-to-chrome.bin')),
      b.evaluate(() => window.peerProbe.received('chrome-to-brave.bin')),
    ]);
    if (!verifyAtChrome.ok || !verifyAtBrave.ok) throw new Error('Stored bytes did not match in both directions');
    console.log(JSON.stringify({ status: 'passed', room, browserPair: 'Chrome ↔ Brave',
      connected: [connectedA.connectionType, connectedB.connectionType],
      transfers: [{ direction: 'Chrome to Brave', bytes: verifyAtBrave.bytes, exact: verifyAtBrave.ok },
        { direction: 'Brave to Chrome', bytes: verifyAtChrome.bytes, exact: verifyAtChrome.ok }],
      frameLimits: [finalA, finalB].map(s => s.sent.length), pageErrors: errors }));
  } catch (error) {
    console.log(JSON.stringify({ status: 'failed', room, error: `${error.name}: ${error.message}`, pageErrors: errors }));
    process.exitCode = 1;
  } finally {
    await Promise.all([a, b].filter(Boolean).map(page => page.evaluate(() => window.peerProbe?.leave()).catch(() => {})));
    await Promise.all([chrome.close(), brave.close()]);
  }
})().catch(error => { console.error(`${error.name}: ${error.message}`); process.exitCode = 1; });
