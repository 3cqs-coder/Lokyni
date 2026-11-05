'use strict';
// Guards the shared Unicode-aware tokenizer (lib/retrieval/keywords.js tokenize), which the corpus index
// (IDF + BM25) and the query both use. English behavior must be unchanged, accented Latin must stay whole
// (the old ASCII tokenizer split it), non-Latin words must produce tokens at all (they used to vanish, so
// those documents were invisible to keyword/BM25 search), and spaceless scripts must tokenize as bigrams so
// a query in the same script matches. The index format version must be bumped so existing indexes rebuild
// with this tokenizer rather than serving mismatched ASCII-only postings. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { tokenize } = require(path.join(PROJECT, 'lib', 'retrieval', 'keywords'));
const { INDEX_FORMAT_VERSION } = require(path.join(PROJECT, 'lib', 'constants'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };

try {
  // ── English / ASCII behavior is unchanged ──
  eq(tokenize('The quick brown fox'), ['the', 'quick', 'brown', 'fox'], 'plain English tokenizes as before');
  eq(tokenize("don't stop 3.14 co2"), ['don', 'stop', '14', 'co2'], 'apostrophes, decimals, and short tokens behave as before');
  eq(tokenize(''), [], 'empty text yields no tokens');

  // ── accented Latin is kept whole (was split into fragments by the ASCII tokenizer) ──
  eq(tokenize('Café Müller naïve'), ['café', 'müller', 'naïve'], 'accented Latin words are kept whole and lowercased');
  // NFC normalization: a decomposed "café" (e + combining acute) tokenizes identically to the composed form,
  // so a query in one form matches a document stored in the other (macOS hands back decomposed filenames).
  eq(tokenize('café'), tokenize('café'), 'decomposed (NFD) and composed (NFC) accented text tokenize identically');

  // ── non-Latin words now produce tokens (they used to vanish entirely) ──
  eq(tokenize('квантовые вычисления'), ['квантовые', 'вычисления'], 'Cyrillic words are tokenized (not dropped)');
  ok(tokenize('Ελληνικά').length === 1, 'a Greek word yields a token');

  // ── spaceless scripts tokenize as overlapping bigrams; a same-script query overlaps the index ──
  eq(tokenize('量子计算'), ['量子', '子计', '计算'], 'a CJK run becomes overlapping bigrams');
  ok(tokenize('量子计算的基本原理').includes('计算'), 'a CJK query bigram is present so it can match the indexed bigrams');
  eq(tokenize('水'), ['水'], 'a single CJK character is kept as itself');
  eq(tokenize('iphone手机'), ['iphone', '手机'], 'a mixed Latin+CJK token splits into a Latin word and a CJK bigram');

  // ── emoji and symbols are not search terms and are dropped from tokens ──
  eq(tokenize('go 😀 now'), ['go', 'now'], 'emoji are not tokens');
  console.log('✓ tokenize: English unchanged; accented Latin whole; non-Latin indexed; CJK bigrams');

  // ── the index format version was bumped so existing indexes rebuild with this tokenizer ──
  ok(INDEX_FORMAT_VERSION >= 2, `INDEX_FORMAT_VERSION was bumped for the tokenizer change (is ${INDEX_FORMAT_VERSION})`);
  console.log('✓ tokenize: index format version bumped so old ASCII-only indexes rebuild');

  console.log(`\nALL TOKENIZE UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ TOKENIZE UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
