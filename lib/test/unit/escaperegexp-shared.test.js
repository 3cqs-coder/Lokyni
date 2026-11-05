'use strict';
// Guards the shared RegExp-escape helper against re-duplication. The character class
// /[.*+?^${}()|[\]\\]/g was copied to several call sites; an incomplete copy at one site is a silent
// correctness or ReDoS bug. There are now exactly two definitions — one server-side (lib/retrieval/
// keywords.escapeRegExp) and one client-side (lib/public/js/chat.js, which can't import a Node module) —
// and every other site must call one of them, never re-inline the class. This test fails if a third
// inline copy appears in non-test source. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // The server helper exists, is exported, and escapes correctly.
  const kw = require(path.join(PROJECT, 'lib', 'retrieval', 'keywords'));
  ok(typeof kw.escapeRegExp === 'function', 'keywords exports escapeRegExp');
  ok(kw.escapeRegExp('a.b*c+?') === 'a\\.b\\*c\\+\\?', 'escapeRegExp escapes every metacharacter');
  ok(new RegExp(kw.escapeRegExp('c++')).test('c++'), 'an escaped literal matches itself (no throw, no over-match)');

  // The inline escape-class pattern (matches `.replace(/[.*+?^${}()|[\]\\]/g`).
  const INLINE = /replace\(\/\[\.\*\+\?\^\$\{\}\(\)\|\[\\\]\\\\\]\/g/;

  // The client defines its own (browser code can't require a Node module), and the class appears
  // on the definition line.
  const chat = fs.readFileSync(path.join(PROJECT, 'lib', 'public', 'js', 'chat.js'), 'utf-8');
  const chatDefLine = chat.split('\n').find(l => /const escapeRegExp =/.test(l)) || '';
  ok(INLINE.test(chatDefLine), 'chat.js defines its own escapeRegExp helper (the class is on the definition line)');

  // No NON-test source file may re-inline the escape class, except the two helper definitions themselves.
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!/node_modules|vendor|\btest\b/.test(e.name)) walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const src = fs.readFileSync(p, 'utf-8');
      if (!INLINE.test(src)) continue;
      const rel = path.relative(PROJECT, p);
      // Allow exactly the two helper definitions.
      const isHelperDef = /const escapeRegExp = \(s\) => String\(s\)\.replace\(/.test(src);
      const onlyDef = src.split('\n').filter(l => INLINE.test(l)).every(l => /const escapeRegExp =/.test(l));
      if (!(isHelperDef && onlyDef)) offenders.push(rel);
    }
  };
  walk(path.join(PROJECT, 'lib'));
  ok(offenders.length === 0, `no file re-inlines the escape class outside the shared helper (offenders: ${offenders.join(', ') || 'none'})`);

  console.log('✓ escaperegexp-shared: one server + one client helper, no re-inlined copies');
  console.log(`\nALL ESCAPEREGEXP-SHARED UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ ESCAPEREGEXP-SHARED UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
