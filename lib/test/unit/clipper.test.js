'use strict';
// Guards the single-source clipper bookmarklet. The "Clip to Lokyni" button is built from one
// served template (lib/public/clipper-bookmarklet.txt): the client fills the install host and a
// new write-scoped key, strips the header comment, and collapses it to a one-line javascript: URL.
// This test replicates that exact transform and asserts the result is a valid, single-line
// bookmarklet with the values embedded and no leftover placeholders — so a future edit to the
// template (or a bad collapse) can't ship a broken clipper. No model or network. Run:
// `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const TEMPLATE = path.join(PROJECT, 'lib', 'public', 'clipper-bookmarklet.txt');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

// The exact transform the client (lib/public/js/chat.js) applies. Kept in sync with it on purpose;
// if the client transform changes, update it here too.
const build = (tpl, host, key) => tpl
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/__LOKYNI_HOST__/g, JSON.stringify(host))
  .replace(/__LOKYNI_KEY__/g, JSON.stringify(key))
  .replace(/\r?\n\s*/g, '')
  .trim();

try {
  const tpl = fs.readFileSync(TEMPLATE, 'utf-8');

  // The template carries both placeholders, UNQUOTED, so JSON-encoded values substitute in safely.
  ok(tpl.includes('__LOKYNI_HOST__') && tpl.includes('__LOKYNI_KEY__'), 'template has both placeholders');
  ok(!/'__LOKYNI_HOST__'|"__LOKYNI_HOST__"/.test(tpl) && !/'__LOKYNI_KEY__'|"__LOKYNI_KEY__"/.test(tpl),
    'placeholders are unquoted (values are inserted JSON-encoded, not into a bare string literal)');

  const host = 'http://127.0.0.1:7887';
  const key = 'lok_test_KEY-with_safe.chars';
  const code = build(tpl, host, key);

  ok(code.startsWith('javascript:'), 'the built bookmarklet is a javascript: URL');
  ok(!/__LOKYNI_/.test(code), 'no placeholder survives substitution');
  ok(!code.includes('/*') && !code.includes('*/'), 'the header comment is stripped');
  ok(!/\n/.test(code), 'the bookmarklet is a single line');
  ok(code.includes(JSON.stringify(host)) && code.includes(JSON.stringify(key)), 'the host and key are embedded, JSON-encoded');
  ok(code.includes('/api/v1/ingest-url'), 'it posts to the write-scoped ingest endpoint');

  // The collapsed body must be syntactically valid JS — catches a bad line-join that would ship a
  // broken bookmarklet. new Function only parses (it never runs the page-only globals it references).
  const body = code.replace(/^javascript:/, '');
  assert.doesNotThrow(() => new Function(body), 'the collapsed bookmarklet parses as valid JavaScript');
  checks++;

  // A key containing a quote must not break out of the literal (JSON.stringify handles it).
  const tricky = build(tpl, host, 'lok_"; alert(1);//');
  assert.doesNotThrow(() => new Function(tricky.replace(/^javascript:/, '')), 'a key with quotes is safely encoded');
  checks++;

  console.log(`\nALL CLIPPER UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ CLIPPER UNIT TEST FAILED:', e.message);
  process.exit(1);
}
