'use strict';
// Static regression guards for two hardening decisions that could silently be undone by a later
// edit:
//   1. The document-ingestion browser must NOT run with --disable-web-security. That flag lets a
//      page being ingested read cross-origin responses (a loopback service, a LAN host, the
//      cloud-metadata endpoint) and beacon them out, turning structurally-blind SSRF into a
//      readable one. Article extraction reads the rendered DOM under the page's own origin and
//      never needs it.
//   2. sharp must NOT be declared as a project dependency. Lokyni deliberately uses the single sharp
//      copy that @huggingface/transformers brings in (npm hoists it to the top-level node_modules);
//      declaring a second one installs a second libvips (the "implemented in both" crash risk) and
//      ships redundant native code. The README and lib/ocr.js document this, so a stray declaration
//      would contradict them.
// No model or network. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

try {
  const urlfetch = fs.readFileSync(path.join(PROJECT, 'lib', 'urlfetch.js'), 'utf-8');
  // Ignore the explanatory comment that names the flag; assert it is not an actual launch arg.
  const codeOnly = urlfetch.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  ok(!codeOnly.includes('--disable-web-security'), 'the ingestion browser does not launch with --disable-web-security');

  const pkg = require(path.join(PROJECT, 'package.json'));
  const inDeps = !!(pkg.dependencies && pkg.dependencies.sharp);
  const inOpt  = !!(pkg.optionalDependencies && pkg.optionalDependencies.sharp);
  ok(!inDeps && !inOpt, 'sharp is not declared as a dependency (the transformers-bundled copy is used)');

  console.log(`\nALL HARDENING-DEPS UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ HARDENING-DEPS UNIT TEST FAILED:', e.message);
  process.exit(1);
}
