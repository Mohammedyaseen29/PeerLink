const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const resultPath = process.env.PEERLINK_RESULTS_PATH || path.join(__dirname, 'reliability-results.json');
const baseUrl = process.env.PEERLINK_TEST_BASE_URL || 'http://127.0.0.1:5173';
const chromePath = process.env.PEERLINK_CHROME_EXECUTABLE || process.env.CHROME_EXECUTABLE || undefined;
const result = { startedAt: new Date().toISOString(), status: 'running', stages: [], ownedPids: [process.pid] };
const persist = () => fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
persist();

(async () => {
  const browser = await chromium.launch({ headless: true, ...(chromePath ? { executablePath: chromePath } : {}) });
  const page = await browser.newPage();
  page.on('pageerror', error => { result.pageErrors = [...(result.pageErrors || []), error.name]; persist(); });
  await page.goto(`${baseUrl}/transfer-test.html?${process.env.PEERLINK_TEST_QUERY || 'quick'}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.getByRole('button', { name: 'Run integration tests' }).click();
  const timer = setInterval(async () => {
    try {
      const lines = (await page.locator('pre').innerText()).split('\n').filter(Boolean);
      result.stages = lines.slice(-6);
      persist();
      console.log('PROGRESS', result.stages.join(' | '));
    } catch {}
  }, 10000);
  try {
    await page.waitForFunction(() => /ALL TESTS PASSED|FAIL:/.test(document.querySelector('pre')?.textContent || ''), null, { timeout: 900000 });
    const output = await page.locator('pre').innerText();
    result.status = output.includes('ALL TESTS PASSED') ? 'passed' : 'failed';
    result.output = output.split('\n').filter(line => /^(PASS:|FAIL:|ALL TESTS)/.test(line));
    if (result.status !== 'passed') process.exitCode = 1;
  } finally {
    clearInterval(timer);
    await browser.close();
    result.completedAt = new Date().toISOString();
    persist();
  }
})().catch(error => {
  result.status = 'runner_error';
  result.error = `${error.name}: ${error.message}`;
  result.completedAt = new Date().toISOString();
  persist();
  console.error(result.error);
  process.exitCode = 1;
});
