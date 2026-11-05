'use strict';
// Guards the desktop build wrapper's macOS DMG policy. Tauri styles the disk image through Finder, which is
// flaky and can fail after the app has built. A retry would rebuild the staged app and compile again, so local
// macOS builds use the plain CI layout by default and the Finder-styled layout is opt-in. This checks that the
// wrapper runs tauri exactly once, honors the opt-in, and documents the behavior.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  const build = read('src-tauri/tauri-build.js');
  const docs = read('src-tauri/README.md');

  ok(/process\.platform === 'darwin'/.test(build), 'the DMG policy is limited to macOS');
  ok(/LOKYNI_DMG_STYLE === '1'/.test(build), 'the Finder-styled layout is an explicit opt-in');
  ok(/env\.CI = 'true'/.test(build), 'the default macOS build selects the plain CI layout');
  ok(/delete env\.TAURI_BUNDLER_DMG_IGNORE_CI/.test(build),
    'the default clears an explicit opt-out so the plain layout is actually used');
  ok((build.match(/await run\(\)/g) || []).length === 1,
    'the wrapper runs tauri exactly once; a Finder failure never triggers a rebuild');
  ok(!/Retrying with the CI layout|finderDmgFailure/.test(build), 'no retry path remains');
  ok(/Unset LOKYNI_DMG_STYLE/.test(build), 'a failed opt-in explains the one-pass alternative');
  ok(/child\.once\('close'/.test(build) && /process\.exitCode/.test(build),
    'the wrapper still forwards the build result');

  ok(/LOKYNI_DMG_STYLE=1 npm run tauri:build/.test(docs), 'the docs name the styled opt-in');
  ok(/plain CI DMG layout by default/.test(docs), 'the docs state the one-pass default');

  console.log(`\nALL DESKTOP-BUILD UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ DESKTOP-BUILD UNIT TEST FAILED:', e && e.message);
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
}
