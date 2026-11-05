'use strict';
// Guards the generation-cached document-name token index (lib/retrieval/keywords.docNameTokens) and its use
// in the pre-expansion "query names a non-allowed document" check (lib/retrieval/expand.js). That check used
// to rebuild a basename string for EVERY parent on EVERY query — an O(corpus) synchronous pass with per-entry
// allocation on the answer path — and dereferenced entry.metadata.source without a guard (a parent missing a
// source threw and failed the whole query). This test locks in: the tokens match the original extraction, the
// map is cached per index generation and rebuilt when the generation changes, a missing source yields [] (no
// throw), and expand.js consumes the cached index. Tokenization is Unicode-aware (NFC + letter/number
// class, matching tokenize()), so accented-Latin and non-Latin filenames are tokenized rather than mangled.
// No model, no network. Run: `npm run test:unit`.

const path = require('path'), fs = require('fs'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { docNameTokens } = require(path.join(PROJECT, 'lib', 'retrieval', 'keywords'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

// The extraction the helper performs: NFC + Unicode letter/number class (same character class as
// tokenize()), significant words only. Used to prove the helper matches across scripts.
const refTokens = (source) => path.basename(source).normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t.length > 3);

try {
  const mk = (gen, entries) => ({ lastIndexedAt: gen, parentMap: new Map(entries) });

  // ── extraction matches the original form, across tricky names ──
  for (const src of ['/docs/Quarterly Report-2025.pdf', '/a/b/THE_bible.txt', '/x/réseau données.md', '/y/ab cd.pdf', 'plain.txt']) {
    const idx = mk(1, [['d', { metadata: { source: src } }]]);
    assert.deepStrictEqual(docNameTokens(idx).get('d'), refTokens(src), `tokens match the original extraction for ${src}`);
  }
  checks++;
  console.log('✓ docname-tokens: extraction matches the Unicode-aware tokenization across scripts');

  // ── accented-Latin and non-Latin filenames are tokenized, not mangled (the ASCII strip used to drop them) ──
  const fr = docNameTokens(mk(1, [['d', { metadata: { source: '/x/café résumé.pdf' } }]])).get('d');
  ok(fr.includes('café') && fr.includes('résumé'), 'accented-Latin filename words are kept whole, not stripped to "caf"/"r sum"');
  const zh = docNameTokens(mk(1, [['d', { metadata: { source: '/x/季度报告摘要.pdf' } }]])).get('d');
  ok(zh.length > 0, 'a non-Latin (Chinese) filename yields a usable token instead of nothing');
  console.log('✓ docname-tokens: accented-Latin and non-Latin filenames are tokenized (language-agnostic)');

  // ── cached by generation: same object returned until the generation changes ──
  const idx = mk(10, [['d1', { metadata: { source: '/a/alpha beta.pdf' } }]]);
  const first = docNameTokens(idx);
  ok(docNameTokens(idx) === first, 'the token map is cached (same reference) within a generation');
  idx.parentMap.set('d2', { metadata: { source: '/a/gamma delta.pdf' } });   // size change → new generation
  const second = docNameTokens(idx);
  ok(second !== first, 'a generation change (document count) rebuilds the cache');
  ok(second.has('d2') && second.get('d2').includes('gamma'), 'the rebuilt cache includes the new document');
  idx.lastIndexedAt = 11;   // re-index time change → new generation
  ok(docNameTokens(idx) !== second, 'a re-index (lastIndexedAt change) rebuilds the cache');

  // ── a parent with no source yields [] instead of throwing (the crash fix) ──
  const noSrc = mk(1, [['bad', { metadata: {} }], ['worse', {}], ['none', { metadata: { source: '' } }]]);
  let threw = false;
  try { const m = docNameTokens(noSrc); ok(m.get('bad').length === 0 && m.get('worse').length === 0 && m.get('none').length === 0, 'missing/empty sources produce empty token lists'); }
  catch { threw = true; }
  ok(!threw, 'a parent entry without metadata.source never throws');

  // ── expand.js consumes the cached index (not an inline per-query rebuild) ──
  const expandSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'retrieval', 'expand.js'), 'utf-8');
  ok(/docNameTokens\(idx\)/.test(expandSrc), 'expand.js iterates the cached doc-name token index');
  ok(!/require\('path'\)\.basename\(entry\.metadata\.source\)/.test(expandSrc), 'expand.js no longer rebuilds the basename per parent per query');

  console.log('✓ docname-tokens: cached by generation, crash-safe on missing source, used by expand.js');
  console.log(`\nALL DOCNAME-TOKENS UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ DOCNAME-TOKENS UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
