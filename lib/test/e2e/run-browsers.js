'use strict';
// Run the browser regression twice: Chromium and Firefox. Puppeteer ships Chromium for URL ingestion;
// Firefox is installed once with `npx puppeteer browsers install firefox`. WebKit is not available
// through Puppeteer, so Safari is covered separately by `npm run e2e:safari`.

const path = require('path');
const { spawn } = require('child_process');

const TEST_FILE = path.join(__dirname, 'app.e2e.test.js');
const requested = (process.env.E2E_BROWSER || '').trim().toLowerCase();
const browsers = requested ? [requested] : ['chromium', 'firefox'];

const run = (browser) => new Promise((resolve) => {
  const child = spawn(process.execPath, [
    '--test',
    '--test-concurrency=1',
    '--test-reporter=spec',
    TEST_FILE,
  ], {
    stdio: 'inherit',
    env: { ...process.env, E2E_BROWSER: browser },
  });
  child.once('error', (error) => {
    console.error(`Could not start the ${browser} test process:`, error.message);
    resolve(1);
  });
  child.once('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
});

(async () => {
  let failed = 0;
  for (const browser of browsers) {
    console.log(`\n── ${browser} ──`);
    if (await run(browser)) failed++;
  }
  if (failed) console.error(`\n${failed} browser run(s) failed.`);
  process.exitCode = failed ? 1 : 0;
})();
