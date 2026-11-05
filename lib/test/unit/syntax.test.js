'use strict';
// Offline syntax + data-integrity gate. Some modules (server.js, socket.js, the route
// handlers) are only ever loaded by the running webserver — no unit test or the eval
// require()s them, so a stray syntax error in one would slip past the whole suite and only
// surface when the live instance failed to boot. `node --check` parses every lib module
// without executing it, and the shipped AI prompt/text files are checked present + non-empty
// (an empty grounding-rules.txt would silently gut the system prompt). No model, no network.
// Run: `npm run test:unit`.

const path = require('path'), fs = require('fs'), assert = require('assert');
const { execFileSync } = require('child_process');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const LIB = path.join(PROJECT, 'lib');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

// Walk lib/ for .js files, skipping node_modules and the test tree itself.
function jsFiles(dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name === 'node_modules' || e.name === 'test') continue; out = out.concat(jsFiles(p)); }
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

try {
  const files = jsFiles(LIB).concat([path.join(PROJECT, 'lokyni.js')]);
  ok(files.length > 20, `found ${files.length} modules to check`);
  const broken = [];
  for (const f of files) {
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
    catch (e) { broken.push(path.relative(PROJECT, f)); }
  }
  ok(broken.length === 0, `these modules failed node --check: ${broken.join(', ')}`);
  console.log(`✓ syntax: ${files.length} modules parse cleanly`);

  // Client-side bundle is loaded in the browser, not require()d — check it parses too.
  const clientJs = jsFiles(path.join(LIB, 'public', 'js'));
  for (const f of clientJs) {
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
    catch (e) { ok(false, `client script failed node --check: ${path.relative(PROJECT, f)}`); }
  }
  console.log(`✓ syntax: ${clientJs.length} client scripts parse cleanly`);

  // The shipped AI prompt/text files must exist and be non-empty — an empty one would
  // silently strip a rule or note from the prompt.
  const dataDir = path.join(LIB, 'ai', 'data');
  const required = ['grounding-rules.txt', 'persona.txt', 'mode-comparison.txt', 'mode-partial.txt', 'mode-web.txt', 'leak-refusal.txt', 'lexicon.json', 'languages.json'];
  for (const name of required) {
    const p = path.join(dataDir, name);
    ok(fs.existsSync(p) && fs.readFileSync(p, 'utf-8').trim().length > 0, `AI data file present + non-empty: ${name}`);
  }
  console.log(`✓ syntax: ${required.length} AI prompt/data files present and non-empty`);

  // Regression guard for the "tell me more" grounding rule. It once told the model there is
  // "always more specific detail to draw out" and to never say it lacked information — which
  // induced fabrication on a thin document (the model padded from training knowledge). The
  // rule must instead bound "go deeper" to the documents and forbid outside-fact padding.
  const grounding = fs.readFileSync(path.join(dataDir, 'grounding-rules.txt'), 'utf-8');
  ok(!/always more specific detail/i.test(grounding), 'grounding rules must not tell the model there is "always more" to produce (fabrication inducement)');
  ok(/training knowledge/i.test(grounding), 'grounding rules explicitly forbid using training knowledge to fill gaps');
  console.log('✓ syntax: grounding rules keep the anti-fabrication wording (no "always more" inducement)');

  console.log(`\nALL SYNTAX GATE CHECKS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ SYNTAX GATE FAILED:', e.message);
  process.exit(1);
}
