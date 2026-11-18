const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const mode = process.argv[2];
const artifact = process.env.PEERLINK_RESULTS_PATH || path.join(__dirname, `local-${mode}-results.json`);
const baseUrl = process.env.PEERLINK_TEST_BASE_URL || 'http://127.0.0.1:5173';
const chromePath = process.env.PEERLINK_CHROME_EXECUTABLE || process.env.CHROME_EXECUTABLE || undefined;
const result = { mode, startedAt: new Date().toISOString(), status: 'running', output: [] };
const persist = () => fs.writeFileSync(artifact, JSON.stringify(result, null, 2));
persist();
(async () => {
  const browser = await chromium.launch({ headless: true, ...(chromePath ? { executablePath: chromePath } : {}) });
  try {
    const page = await browser.newPage();
    page.on('pageerror', error => { result.pageErrors = [...(result.pageErrors || []), error.name]; persist(); });
    await page.goto(`${baseUrl}/transfer-test.html?${mode}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.getByRole('button', { name: 'Run integration tests' }).click();
    const poll = setInterval(async () => {
      try { result.progress = (await page.locator('pre').innerText()).split('\n').filter(Boolean).slice(-8); persist(); } catch {}
    }, 10000);
    try {
      await page.waitForFunction(() => /PASSED|FAIL:/.test(document.querySelector('pre')?.textContent || ''), null, { timeout: 240000 });
      const text = await page.locator('pre').innerText();
      result.output = text.split('\n').filter(line => /^(PASS:|FAIL:|.*TESTS PASSED)/.test(line));
      result.status = /FAIL:/.test(text) ? 'failed' : 'passed';
      if (result.status !== 'passed') process.exitCode = 1;
    } finally { clearInterval(poll); }
  } finally { await browser.close(); result.completedAt = new Date().toISOString(); persist(); }
})().catch(error => { result.status = 'runner_error'; result.error = `${error.name}: ${error.message}`; result.completedAt = new Date().toISOString(); persist(); console.error(result.error); process.exitCode = 1; });
