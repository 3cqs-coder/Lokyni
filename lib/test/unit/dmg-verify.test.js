'use strict';
// Guards the macOS DMG verification command. It must check the artifact users actually download: mount the
// newest DMG read-only, verify the ad-hoc signature, bundle version, macOS floor, and packaged sidecar/runtime,
// then unmount it. It must never launch the app, touch user data, or require a signing certificate.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  const scriptPath = 'lib/test/desktop/dmg.js';
  ok(fs.existsSync(path.join(PROJECT, scriptPath)), 'the DMG verification script exists');
  const script = read(scriptPath);
  const pkg = JSON.parse(read('package.json'));
  const docs = read('docs/README.md');

  ok(pkg.scripts['verify:dmg'] === 'node lib/test/desktop/dmg.js', 'npm run verify:dmg is wired to the script');
  ok(/process\.platform !== 'darwin'/.test(script), 'the command skips cleanly on other operating systems');
  ok(/hdiutil.*attach/s.test(script) && /hdiutil.*detach/s.test(script), 'the DMG is mounted and always detached');
  ok(/codesign.*--verify/s.test(script), 'the app signature is verified');
  ok(/spctl/.test(script), 'notarization status is reported without failing an ad-hoc build');
  ok(/CFBundleShortVersionString/.test(script) && /LSMinimumSystemVersion/.test(script),
    'the bundle version and macOS floor are checked');
  ok(/package\.json/.test(script) && /tauri\.conf\.json/.test(script),
    'the expected version and floor come from the build sources');
  ok(/Contents\/Resources\/app\/lokyni\.js/.test(script) && /runtime\/node/.test(script),
    'the packaged sidecar and runtime are checked');
  ok(/DEVELOPER|notarized/.test(script), 'the notarization expectation is documented');
  ok(/verify:dmg/.test(docs), 'the docs name the DMG verification command');

  console.log(`\nALL DMG-VERIFY UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ DMG-VERIFY UNIT TEST FAILED:', e && e.message);
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
}
