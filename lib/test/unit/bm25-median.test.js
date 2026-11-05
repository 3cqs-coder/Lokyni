'use strict';
// Guards the BM25 corpus-median estimate (lib/retrieval/bm25.js), which drives the topic-shift and
// out-of-scope gates. The median is estimated from a sample of mid-IDF terms; that sample must be taken
// EVENLY across the IDF band (stratified), not from the alphabetically-first terms — an alphabetical
// slice biases the estimate and makes the gates misfire (admitting off-topic docs or rejecting valid
// queries). This test builds a small real corpus into a throwaway target (not global state), asserts the
// median is finite/positive/deterministic and that a pinned median is respected, plus a source guard
// that the sampling sorts by IDF rather than alphabetically. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { buildBM25Index } = require(path.join(PROJECT, 'lib', 'retrieval', 'bm25'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

// Build a corpus with a spread of term frequencies so corpusIdf populates the mid-IDF band the sampler
// targets. Common words appear everywhere (low IDF), themed words in some docs (mid IDF), unique tags in
// one doc each (high IDF).
const makeCorpus = () => {
  const pMap = new Map();
  const themes = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
  for (let i = 0; i < 30; i++) {
    const common = 'the report describes the system and its behavior in detail';
    const themed = themes.filter((_, j) => (i % themes.length) === j || (i % 3 === 0 && j < 3)).join(' ');
    const uniq = `tag${i} marker${i} token${i}`;
    pMap.set(`doc-${i}`, { content: `${common} ${themed} ${themed} ${uniq}`, metadata: { source: `/d/${i}.txt` } });
  }
  return pMap;
};

(async () => {
  const src = fs.readFileSync(path.join(PROJECT, 'lib', 'retrieval', 'bm25.js'), 'utf-8');
  // ── Source guard: the mid-IDF sample is stratified by IDF, not alphabetical ──
  ok(/\.sort\(\(a, b\) => a\[1\] - b\[1\]\)/.test(src), 'the median sample sorts mid-IDF terms by IDF value');
  ok(!/localeCompare/.test(src), 'the median sample no longer uses an alphabetical (localeCompare) slice');
  ok(/stride/.test(src), 'the sample strides evenly across the IDF band');

  // ── Source guard: the build yields the event loop cooperatively so a large corpus never stalls it ──
  ok(/const buildBM25Index = async /.test(src) && /setImmediate/.test(src) && /await yieldToLoop\(\)/.test(src),
    'the BM25 build is async and yields the event loop during the per-document loop');
  // The IDF pass (roughly half the tokenization work) is corpus-sized too, so it yields as well.
  const kwSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'retrieval', 'keywords.js'), 'utf-8');
  ok(/const buildIdf = async \(pMap\)/.test(kwSrc) && /setImmediate/.test(kwSrc),
    'buildIdf is async and yields the event loop while tokenizing the corpus');

  // ── Source guard: corpusIdf is published only AFTER the document loop, so it swaps atomically with the
  // caller's liveBM25 assignment. Assigning it before the yielding loop would let a query mid-build see a
  // new corpusIdf paired with the old BM25 engine. ──
  ok(/const idf = await buildIdf\(pMap\)/.test(src), 'the IDF table is computed (cooperatively) into a local, not straight onto the live target');
  ok(src.indexOf('target.corpusIdf = idf') > src.indexOf('engine.addDoc'),
    'corpusIdf is published onto the target only after the document loop (atomic swap with liveBM25)');
  ok(!/target\.corpusIdf = buildIdf/.test(src), 'the IDF table is no longer assigned onto the live target before the yielding loop');

  // ── Functional: a real build yields a finite, positive, deterministic median ──
  const t1 = {}, t2 = {};
  const a = await buildBM25Index(makeCorpus(), null, t1);
  const b = await buildBM25Index(makeCorpus(), null, t2);
  ok(a.engine, 'the BM25 engine builds');
  ok(Number.isFinite(a.medianScore) && a.medianScore > 0, 'the computed median is finite and positive');
  eq(a.medianScore, b.medianScore, 'the median is deterministic across identical builds (no per-boot variance)');

  // ── A pinned median is respected verbatim (warm-load path) ──
  const pinned = await buildBM25Index(makeCorpus(), 4.2, {});
  eq(pinned.medianScore, 4.2, 'a pinned median is used as-is, not recomputed');

  // ── The throwaway target received the corpus IDF; global state was not required ──
  ok(t1.corpusIdf && t1.corpusIdf.size > 0, 'building into an explicit target populates its corpusIdf');

  console.log('✓ bm25-median: stratified IDF sampling, deterministic finite median, pinned respected, cooperative build');
  console.log(`\nALL BM25-MEDIAN UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
})().catch((e) => {
  console.error('\n✗ BM25-MEDIAN UNIT TEST FAILED:', e && e.message, e && e.stack);
  process.exit(1);
});
