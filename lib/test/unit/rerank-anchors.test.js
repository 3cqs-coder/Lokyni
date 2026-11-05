'use strict';
// Guards the passage-anchor selection fix (ACC-1) in lib/retrieval/search.js + the shared helper
// pickAnchorsByParent (lib/retrieval/passages.js).
//
// The bug: FAISS results were deduplicated to one chunk per document BEFORE reranking, so the
// cross-encoder and ColBERT only ever saw a single chunk per document — they could reorder documents
// but never pick a better PASSAGE within one (defeating ColBERT's whole purpose). The fix reranks the
// FULL candidate set (all chunks, multiple per document) and keeps each document's BEST-scored chunk as
// its anchor. Document-level ranking still uses the deduped FAISS list through RRF, so the set of
// documents and their order is unchanged — only WHICH passage anchors a document changes. The anchor
// grouping is unit-tested directly; the wiring is guarded by source inspection. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { pickAnchorsByParent } = require(path.join(PROJECT, 'lib', 'retrieval', 'passages'));
const src = fs.readFileSync(path.join(PROJECT, 'lib', 'retrieval', 'search.js'), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

try {
  // ── pickAnchorsByParent keeps each parent's BEST (first, since best-first order) chunk ──
  {
    // Reranked order (best first): A's best is a2 here, B's best is b1. Two docs interleaved.
    const ranked = [
      { parentId: 'A', id: 'a2' },
      { parentId: 'B', id: 'b1' },
      { parentId: 'A', id: 'a5' },   // a lower-ranked chunk of A — must be dropped at cap 1
      { parentId: 'A', id: 'a9' },
    ];
    const one = pickAnchorsByParent(ranked, 1);
    eq(one.get('A').length, 1, 'cap 1 keeps a single anchor for A');
    eq(one.get('A')[0], 'a2', "A's anchor is its BEST-ranked chunk (first seen), not a later one");
    eq(one.get('B')[0], 'b1', "B's anchor is its best-ranked chunk");
    eq([...one.keys()].join(','), 'A,B', 'parent order follows first encounter');
    console.log('✓ rerank-anchors: the best-ranked chunk per document becomes its anchor');
  }

  // ── The cap controls anchors per parent; best-first order is preserved ──
  {
    const ranked = [
      { parentId: 'A', id: 'a1' }, { parentId: 'A', id: 'a2' }, { parentId: 'A', id: 'a3' }, { parentId: 'B', id: 'b1' },
    ];
    const two = pickAnchorsByParent(ranked, 2);
    eq(two.get('A').join(','), 'a1,a2', 'cap 2 keeps the top two anchors for A, in order');
    eq(two.get('B').join(','), 'b1', 'B keeps its single anchor');
    console.log('✓ rerank-anchors: the per-parent cap is honored and order preserved');
  }

  // ── Malformed / empty items are skipped, never crash ──
  {
    const m = pickAnchorsByParent([null, { parentId: 'A' }, { id: 'x' }, { parentId: 'A', id: 'a1' }], 1);
    eq(m.get('A') && m.get('A')[0], 'a1', 'only well-formed items contribute; malformed ones are skipped');
    eq(pickAnchorsByParent(undefined, 1).size, 0, 'undefined input yields an empty map (no crash)');
    console.log('✓ rerank-anchors: malformed and empty inputs are handled safely');
  }

  // ── Source guard: the reranker sees the FULL candidate set, not one-per-document ──
  ok(/const MAX_ANCHORS_PER_PARENT = 1/.test(src), 'the per-parent anchor cap is defined');
  ok(/candidateChunks = faissResults\.slice\(0, FAISS_CANDIDATES\)\.flatMap/.test(src),
    'candidate chunks for reranking come from the full faissResults (every chunk), not the deduped list');
  ok(!/candidateChunks = faissDeduped\.slice/.test(src),
    'candidate chunks are NOT built from faissDeduped (the one-chunk-per-document bug is gone)');
  ok(/seenChunk\.has\(chunkId\)/.test(src), 'candidate chunks are de-duplicated by chunk id');
  ok(/pickAnchorsByParent\(ranked, MAX_ANCHORS_PER_PARENT\)/.test(src), 'the reranked path selects anchors via the shared helper');
  ok(/pickAnchorsByParent\(faissOrdered, MAX_ANCHORS_PER_PARENT\)/.test(src), 'the no-reranker path uses the same shared helper');
  // Document-level ranking must still use the deduped list (one per parent) so RRF is not double-counted. In
  // cross-lingual mode the BM25 list is dropped (dense-only fusion), since BM25 scores a cross-lingual query
  // against the wrong same-script documents; the deduped FAISS list is unchanged either way.
  ok(/reciprocalRankFusion\(faissDeduped, crossLingualMode \? \[\] : bm25Results\)/.test(src), 'document ranking still fuses the deduped FAISS list (no per-chunk double-counting; BM25 dropped only in cross-lingual mode)');

  console.log('✓ rerank-anchors: reranker scores all chunks; RRF document ranking unchanged');
  console.log(`\nALL RERANK-ANCHORS UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ RERANK-ANCHORS UNIT TEST FAILED:', e && e.message, e && e.stack);
  process.exit(1);
}
