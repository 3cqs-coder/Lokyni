'use strict';
// Guards the dispatch-only Linux installer workflow and the shared Linux build-dependency script. The workflow
// must build the real installers, install the .deb, run the packaged sidecar without a GUI, check the RPM
// metadata and contents, and clean up. It must also use the same Node pin, npm command, and dependency script as
// the release build, so the smoke and the release cannot drift apart.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  const wfPath = '.github/workflows/linux.yml';
  ok(fs.existsSync(path.join(PROJECT, wfPath)), 'the Linux workflow exists');
  const wf = read(wfPath);
  const desktop = read('.github/workflows/desktop.yml');
  const docs = read('docs/README.md');
  const deps = read('src-tauri/linux-build-deps.sh');

  ok(/workflow_dispatch:/.test(wf), 'the Linux workflow is dispatch-only');
  ok(/runs-on:\s*ubuntu-22\.04/.test(wf), 'the Linux workflow runs on the supported Ubuntu base');
  ok(/timeout-minutes:/.test(wf), 'the job is bounded by a timeout');
  ok(/NODE_VERSION:\s*'24\.11\.1'/.test(wf), 'the Linux workflow pins the shared Node version');

  // One dependency list for the release build and the smoke.
  ok(/apt-get install/.test(deps) && /libwebkit2gtk-4\.1-dev/.test(deps), 'the shared script installs the build dependencies');
  ok(/bash src-tauri\/linux-build-deps\.sh/.test(wf), 'the Linux pass uses the shared dependency script');
  ok(/bash src-tauri\/linux-build-deps\.sh/.test(desktop), 'the release build uses the same dependency script');

  ok(/npm run tauri:build/.test(wf), 'the Linux pass uses the shared desktop build command');
  ok(/\*\.deb/.test(wf) && /\*\.rpm/.test(wf), 'both Linux installer formats are discovered');
  ok(/dpkg-deb -f/.test(wf) && /dpkg-deb -c/.test(wf), 'the .deb metadata and contents are checked');
  ok(/rpm -qp/.test(wf) && /rpm -qpl/.test(wf), 'the .rpm metadata and contents are checked');
  ok(/apt-get install -y "\$deb"/.test(wf), 'the .deb is installed');
  ok(/apt-get purge -y/.test(wf), 'the .deb is purged');
  ok(/dpkg -L/.test(wf) && /app\/runtime\/node/.test(wf), 'the installed package is checked for the sidecar and runtime');
  ok(/lokyni\.js/.test(wf) && /--data-dir/.test(wf) && /\/status/.test(wf),
    'the packaged sidecar is started and queried');
  ok(/package\.json/.test(wf), 'the expected version comes from package.json');
  ok(/linux-installers/.test(wf), 'the installers are uploaded');
  ok(!/signtool|notarytool|Authenticode|APPLE_ID/i.test(wf), 'the Linux pass does not attempt certificate signing');

  ok(/Linux pass/.test(docs) || /linux\.yml/.test(docs), 'the docs mention the Linux workflow');

  console.log(`\nALL LINUX-PASS UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ LINUX-PASS UNIT TEST FAILED:', e && e.message);
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
}
