'use strict';
// Guards the dispatch-only Windows workflow. It must use the same Node pin and npm scripts as the other
// packaging paths, exercise Chromium on Windows, and silently install both installer formats without requiring
// a signing certificate or a GUI session. It also keeps the workflow from drifting back to a hard-coded product
// name or version. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  const wfPath = '.github/workflows/windows.yml';
  ok(fs.existsSync(path.join(PROJECT, wfPath)), 'the Windows workflow exists');
  const wf = read(wfPath);
  const docs = read('docs/README.md');

  // Dispatch-only until a hosted run is proven.
  ok(/workflow_dispatch:/.test(wf), 'the Windows workflow is dispatch-only');
  ok(/runs-on:\s*windows-latest/.test(wf), 'both jobs run on Windows');
  ok(/timeout-minutes:/.test(wf), 'the jobs are bounded by timeouts');

  // Browser coverage reuses the shared e2e command and the shared screenshot path.
  ok(/E2E_BROWSER:\s*chromium/.test(wf), 'the browser job selects Chromium');
  ok(/npx puppeteer browsers install chrome/.test(wf), 'the browser job installs Chromium');
  ok(/Install Chromium[\s\S]{0,220}PUPPETEER_SKIP_DOWNLOAD: '0'/.test(wf),
    'the explicit Chromium install overrides the build-only download skip');
  ok(/npm run test:e2e/.test(wf), 'the browser job runs the shared e2e command');
  ok(/test-results/.test(wf), 'the browser job uploads the shared screenshot path');

  // Installer smoke: build the shared Tauri bundle, find both formats by glob, install silently, verify the
  // packaged sidecar and the version, then uninstall. The product name and version are read from the build
  // sources rather than repeated here.
  ok(/npm run tauri:build/.test(wf), 'the installer job uses the shared desktop build command');
  ok(/\*setup\.exe/.test(wf) && /\*\.msi/.test(wf), 'both Windows installer formats are discovered');
  ok(/-ArgumentList '\/S'/.test(wf), 'the NSIS installer is silent');
  ok(/msiexec\.exe/.test(wf) && /\/qn/.test(wf), 'the MSI installs and uninstalls silently');
  ok(/tauri\.conf\.json.*productName/s.test(wf), 'the installer smoke reads the product name from the build config');
  ok(/package\.json.*\.version/s.test(wf), 'the installer smoke reads the expected version from package.json');
  ok(/ProductVersion/.test(wf), 'the installed executable version is checked');
  ok(/Find-App/.test(wf) && /VersionInfo\.ProductVersion/.test(wf),
    'the installed executable is found by its version resource, not assumed to match the product name');
  ok(/lokyni\.js/.test(wf), 'the installed sidecar is checked');
  ok(/Uninstall\*\.exe/.test(wf) && /\/x /.test(wf), 'both installer formats are uninstalled');

  // No certificate-dependent step may creep in; the macOS build keeps its existing ad-hoc signing.
  ok(!/signtool|notarytool|Authenticode|APPLE_ID/i.test(wf),
    'the Windows pass does not attempt certificate signing');

  ok(/Windows pass/.test(docs) || /windows\.yml/.test(docs), 'the docs mention the Windows workflow');

  console.log(`\nALL WINDOWS-PASS UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ WINDOWS-PASS UNIT TEST FAILED:', e && e.message);
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
}
