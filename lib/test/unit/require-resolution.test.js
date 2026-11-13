'use strict';
// Guards that every relative require() and require.resolve() in the server's source modules points at a file
// that actually exists. `node --check` (syntax.test) only PARSES each module — a require with a wrong path
// parses cleanly and fails only at runtime, and only on the code path that reaches it (a lazy require in a rare
// error branch can stay broken for a long time). A folder move or a typo'd path is exactly this failure. This
// test resolves every require statically, so a dangling one fails loudly here instead of in production.
//
// It scans real CODE only: a hand-written character scanner skips comments, strings, and template literals, so
// require-shaped text inside a string or a doc comment (common in the guard tests themselves) is never mistaken
// for a call. Scope is the server's own modules — not lib/test (whose assertions quote require specifiers as
// data), not lib/public (browser scripts) or lib/views (templates). Pure static analysis, no module executed,
// cross-platform (resolution is by fs existence, slash-agnostic). Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

// Extract genuine require('<literal>') / require.resolve('<literal>') specifiers from source, skipping anything
// inside a line/block comment, a string, or a template literal. Returns the relative specifiers only.
function genuineRequires(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {                 // skip a string / template body
      const q = c; i++;
      while (i < n) { if (src[i] === '\\') { i += 2; continue; } if (src[i] === q) { i++; break; } i++; }
      continue;
    }
    // at a code position: is this `require(` or `require.resolve(` with a string-literal arg?
    if (src.startsWith('require', i) && /[^A-Za-z0-9_$]/.test(src[i - 1] || ' ')) {
      const m = src.slice(i).match(/^require(?:\.resolve)?\(\s*(['"])((?:\\.|[^'"\\])*)\1\s*\)/);
      if (m) { if (m[2].startsWith('.')) out.push(m[2]); i += m[0].length; continue; }
    }
    i++;
  }
  return out;
}

const resolvesTo = (fromDir, spec) => {
  const base = path.resolve(fromDir, spec);
  return [base, base + '.js', base + '.json', path.join(base, 'index.js')].some((p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  });
};

// Every tracked .js under lib/, minus the areas whose "requires" are data or run in the browser.
const listSrc = () => require('child_process')
  .execFileSync('git', ['ls-files', 'lib/**/*.js', 'lokyni.js'], { cwd: PROJECT, encoding: 'utf8' })
  .split('\n').map((s) => s.trim()).filter(Boolean)
  .filter((p) => !p.startsWith('lib/test/') && !p.startsWith('lib/public/') && !p.startsWith('lib/views/'));

try {
  const files = listSrc();
  ok(files.length > 100, `found the server source modules to scan (${files.length})`);
  const dangling = [];
  let scanned = 0;
  for (const rel of files) {
    const abs = path.join(PROJECT, rel);
    const dir = path.dirname(abs);
    for (const spec of genuineRequires(fs.readFileSync(abs, 'utf8'))) {
      scanned++;
      if (!resolvesTo(dir, spec)) dangling.push(`${rel}: require('${spec}')`);
    }
  }
  ok(dangling.length === 0,
    `every relative require resolves to a real file (dangling: ${dangling.join('; ') || 'none'})`);
  console.log(`✓ require-resolution: ${scanned} relative requires across ${files.length} source modules all resolve`);
  console.log(`\nALL REQUIRE-RESOLUTION TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ REQUIRE-RESOLUTION TEST FAILED:', e && e.message);
  process.exit(1);
}
