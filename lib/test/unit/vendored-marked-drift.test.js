'use strict';
// Guards against the vendored browser copy of `marked` drifting from the installed dependency. The app does not
// load the npm `marked` at runtime (it is a devDependency, pruned in production); instead it ships a vendored
// UMD build at lib/public/vendor/marked/marked.umd.js that the browser loads directly. When the `marked`
// dependency is upgraded, that vendored file must be re-copied from node_modules, or the shipped renderer silently
// lags the declared version (and misses its fixes). This exact drift happened once: a `marked` bump to 18.2.1
// left the committed vendored copy at 18.2.0. This test asserts the vendored file is byte-identical to the
// installed marked UMD, so a forgotten re-vendor fails in CI instead of shipping.
//
// The vendored file is simply a copy of node_modules/marked/lib/marked.umd.js (no transform), so byte-identity is
// the correct invariant — it holds for any in-range patch update, unlike a version-string comparison. Runs in the
// dev/CI install where the devDependency is present; if marked is not installed (a production-only install), the
// byte check is skipped with a note. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  const vendored = path.join(PROJECT, 'lib', 'public', 'vendor', 'marked', 'marked.umd.js');
  const installed = path.join(PROJECT, 'node_modules', 'marked', 'lib', 'marked.umd.js');

  ok(fs.existsSync(vendored), 'the vendored marked.umd.js exists (the browser loads it directly)');

  if (fs.existsSync(installed)) {
    const a = fs.readFileSync(vendored), b = fs.readFileSync(installed);
    ok(a.equals(b),
      'the vendored marked.umd.js is byte-identical to the installed marked — re-copy node_modules/marked/lib/marked.umd.js into lib/public/vendor/marked/ after upgrading the marked dependency');
  } else {
    console.log('  (node_modules/marked absent — production-only install; skipping the byte-identity check)');
    // Even without node_modules, confirm the vendored file carries a version header, so a truncated/corrupt copy
    // is still caught.
    const head = fs.readFileSync(vendored, 'utf8').slice(0, 400);
    ok(/marked v\d+\.\d+\.\d+/.test(head), 'the vendored marked.umd.js carries a version header (not truncated/corrupt)');
  }

  console.log(`\nALL VENDORED-MARKED-DRIFT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ VENDORED-MARKED-DRIFT TEST FAILED:', e && e.message);
  process.exit(1);
}
