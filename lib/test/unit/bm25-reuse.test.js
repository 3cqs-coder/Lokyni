'use strict';
// Guards BM25 reuse during a bank consolidation. Every consolidation batch re-parses and re-embeds a bounded
// slice while the corpus text stays the same, so rebuilding the whole BM25/IDF index per batch is wasted work.
// The helper must reuse the live engine only when the document text is truly unchanged, and must rebuild on
// any content, add, or removal. Also guards that the delta path actually calls the helper. Small synthetic
// corpus; no model or network. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { buildBM25Index, buildOrReuseBM25Index, sameTextCorpus } = require(path.join(PROJECT, 'lib', 'retrieval', 'bm25'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

const makeCorpus = (n = 24) => {
  const map = new Map();
  for (let i = 0; i < n; i++) {
    map.set(`doc-${i}`, {
      content: `orion handbook section ${i} launch code zx-${9000 + i} budget ${i} million`,
      metadata: { source: `/docs/${i}.txt` },
    });
  }
  return map;
};

(async () => {
try {
  const corpus = makeCorpus();
  const target = { corpusIdf: null };
  const first = await buildBM25Index(corpus, 2.5, target);
  ok(first && first.engine, 'the baseline corpus builds a real BM25 engine');
  const firstIdf = target.corpusIdf;

  // ── Identical text in a fresh Map and fresh strings is reused ──
  const reparsed = new Map([...corpus.entries()].map(([id, doc]) => [id, { ...doc, content: String(doc.content) }]));
  ok(sameTextCorpus(reparsed, corpus), 'sameTextCorpus accepts a value-equal clone');
  const reuseTarget = { corpusIdf: null };
  const reused = await buildOrReuseBM25Index(reparsed, 2.5, reuseTarget,
    { bm25: first, idf: firstIdf, map: corpus });
  eq(reused, first, 'unchanged text returns the very same engine object');
  eq(reuseTarget.corpusIdf, firstIdf, 'reuse republishes the existing IDF table');
  eq(reused.medianScore, first.medianScore, 'reuse keeps the baseline median (the gates stay calibrated)');

  // Insertion order can change when a batch purges and re-adds documents; numeric ids are resolved through
  // idToDocId, so the same set in a different order is still the same text corpus.
  const reordered = new Map([...corpus.entries()].reverse());
  ok(sameTextCorpus(reordered, corpus), 'sameTextCorpus is order-independent');
  const reorderTarget = { corpusIdf: null };
  eq(await buildOrReuseBM25Index(reordered, 2.5, reorderTarget, { bm25: first, idf: firstIdf, map: corpus }), first,
    'a re-ordered but text-identical corpus is reused');

  // ── Any real change rebuilds ──
  const edited = new Map(reparsed);
  edited.set('doc-7', { ...edited.get('doc-7'), content: `${edited.get('doc-7').content} changed tail` });
  ok(!sameTextCorpus(edited, corpus), 'a single edited document is not the same corpus');
  const editTarget = { corpusIdf: null };
  const rebuilt = await buildOrReuseBM25Index(edited, 2.5, editTarget, { bm25: first, idf: firstIdf, map: corpus });
  ok(rebuilt !== first, 'an edit rebuilds the index instead of serving stale scores');
  ok(editTarget.corpusIdf !== firstIdf, 'a rebuild publishes a new IDF table');

  const added = new Map(reparsed);
  added.set('doc-new', { content: 'a newly added document about the orion project' });
  ok(!sameTextCorpus(added, corpus), 'an added document is not the same corpus');
  ok(await buildOrReuseBM25Index(added, 2.5, { corpusIdf: null }, { bm25: first, idf: firstIdf, map: corpus }) !== first,
    'an added document rebuilds');

  const removed = new Map(reparsed);
  removed.delete('doc-0');
  ok(!sameTextCorpus(removed, corpus), 'a removed document is not the same corpus');
  ok(await buildOrReuseBM25Index(removed, 2.5, { corpusIdf: null }, { bm25: first, idf: firstIdf, map: corpus }) !== first,
    'a removed document rebuilds');

  // ── Degenerate previous indexes fall back to a build instead of returning a stub ──
  const emptyTarget = { corpusIdf: null };
  const empty = await buildOrReuseBM25Index(new Map(), 2.5, emptyTarget, { bm25: first, idf: firstIdf, map: corpus });
  ok(empty !== first && empty.empty === true, 'an emptied corpus builds the safe empty stub');
  const noPrevious = await buildOrReuseBM25Index(reparsed, 2.5, { corpusIdf: null }, null);
  ok(noPrevious && noPrevious.engine, 'no previous index builds normally');
  const stubPrevious = { engine: null, idToDocId: new Map(), medianScore: 3 };
  const fromStub = await buildOrReuseBM25Index(reparsed, 2.5, { corpusIdf: null },
    { bm25: stubPrevious, idf: firstIdf, map: corpus });
  ok(fromStub && fromStub.engine, 'a previous stub is rebuilt rather than reused');

  // ── The delta path uses the helper in both the empty and the normal swap paths ──
  const delta = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'delta.js'), 'utf-8');
  const calls = (delta.match(/buildOrReuseBM25Index\(/g) || []).length;
  eq(calls, 2, 'both the empty-corpus and normal delta paths call the reuse helper');
  ok(/bm25: state\.liveBM25, idf: state\.corpusIdf, map: state\.parentMap/.test(delta),
    'the helper receives the live engine, IDF table, and the map they were built from');
  ok(!/buildBM25Index\(/.test(delta), 'the delta no longer rebuilds BM25 unconditionally');

  console.log(`\nALL BM25-REUSE UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\nBM25-REUSE UNIT TESTS FAILED');
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
}
})();
