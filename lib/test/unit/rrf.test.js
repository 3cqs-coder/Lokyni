'use strict';
// Functional test for reciprocalRankFusion (lib/retrieval/rrf.js) — the primary hybrid fusion that
// merges the FAISS dense ranking and the BM25 keyword ranking on every hybrid query. A silent change
// to the rank offset, the weighting, the id keying, or the sort would re-order every answer's sources
// with no other test catching it. Also checks the config fail-safe: non-finite hand-edited weights must
// fall back to the documented defaults (0.3 / 0.7 / 60), not produce NaN scores that drop all results.
// Pure math, no model/network. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { reciprocalRankFusion } = require(path.join(PROJECT, 'lib', 'retrieval', 'rrf'));
const cfg = require(path.join(PROJECT, 'lib', 'config'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };
const near = (a, b, m) => { checks++; assert.ok(Math.abs(a - b) < 1e-9, `${m} (got ${a}, want ${b})`); };

// FAISS results are [doc, cosine] with an id in metadata; BM25 results are [docId, score].
const fdoc = (id) => [{ metadata: { parentId: id } }, 0.9];

try {
  // ── A doc ranked by BOTH retrievers accumulates both contributions ──
  {
    const faiss = [fdoc('A'), fdoc('B')];
    const bm25  = [['A', 5], ['C', 3]];
    const fused = reciprocalRankFusion(faiss, bm25, 0.3, 0.7);
    const map = new Map(fused);
    const k = 60;
    near(map.get('A'), 0.3 * (1 / (k + 1)) + 0.7 * (1 / (k + 1)), 'A gets both FAISS rank-0 and BM25 rank-0 contributions');
    near(map.get('B'), 0.3 * (1 / (k + 2)), 'B (FAISS only, rank 1) gets just the weighted FAISS term');
    near(map.get('C'), 0.7 * (1 / (k + 2)), 'C (BM25 only, rank 1) gets just the weighted BM25 term');
    // A appears in both so it must rank first.
    eq(fused[0][0], 'A', 'the doc found by both retrievers ranks first');
    console.log('✓ rrf: contributions from both retrievers accumulate and the shared doc wins');
  }

  // ── A term only BM25 ranks still surfaces (hybrid recall) ──
  {
    const fused = reciprocalRankFusion([fdoc('X')], [['keyword-only', 9]], 0.3, 0.7);
    ok(fused.some(([id]) => id === 'keyword-only'), 'a BM25-only match is present in the fused list');
    console.log('✓ rrf: a keyword-only match still surfaces through fusion');
  }

  // ── Weighting shifts the order ──
  {
    // Same doc set, FAISS prefers P (rank 0), BM25 prefers Q (rank 0).
    const faiss = [fdoc('P'), fdoc('Q')];
    const bm25  = [['Q', 5], ['P', 3]];
    const bm25Heavy = new Map(reciprocalRankFusion(faiss, bm25, 0.1, 0.9));
    const faissHeavy = new Map(reciprocalRankFusion(faiss, bm25, 0.9, 0.1));
    ok(bm25Heavy.get('Q') > bm25Heavy.get('P'), 'with BM25-heavy weights, the BM25-preferred doc leads');
    ok(faissHeavy.get('P') > faissHeavy.get('Q'), 'with FAISS-heavy weights, the FAISS-preferred doc leads');
    console.log('✓ rrf: weighting shifts the fused order as expected');
  }

  // ── Docs with no id are skipped; result is sorted descending ──
  {
    const faiss = [[{ metadata: {} }, 0.9], fdoc('R')];   // first has no parentId/docId
    const fused = reciprocalRankFusion(faiss, [], 0.3, 0.7);
    eq(fused.length, 1, 'a FAISS doc with no id is skipped, not fused as undefined');
    eq(fused[0][0], 'R', 'the only valid doc is returned');
    const two = reciprocalRankFusion([fdoc('lo'), fdoc('hi')], [['hi', 1]], 0.3, 0.7);
    ok(two[0][1] >= two[1][1], 'the fused list is sorted by descending score');
    console.log('✓ rrf: idless docs skipped; output sorted descending');
  }

  // ── A FAISS row that lacks metadata ENTIRELY is skipped, not thrown (runs outside a try/catch on the hot path) ──
  {
    const faiss = [[{ pageContent: 'no metadata here' }, 0.9], [null, 0.8], fdoc('S')];
    let fused;
    assert.doesNotThrow(() => { fused = reciprocalRankFusion(faiss, [], 0.3, 0.7); },
      'a row with no .metadata (or a null doc) must not throw out of fusion');
    eq(fused.length, 1, 'rows with no metadata are skipped, leaving only the valid doc');
    eq(fused[0][0], 'S', 'the valid doc survives alongside metadata-less rows');
    console.log('✓ rrf: a metadata-less FAISS row is skipped rather than crashing the fusion');
  }

  // ── Config fail-safe: non-finite hand-edited weights fall back to defaults, never NaN ──
  {
    const saved = { f: cfg.rrfFaissWeight, b: cfg.rrfBm25Weight, k: cfg.rrfK };
    try {
      cfg.rrfFaissWeight = NaN; cfg.rrfBm25Weight = undefined; cfg.rrfK = 'oops';
      // Call WITHOUT explicit weights so it must read config and apply the fallbacks.
      const fused = reciprocalRankFusion([fdoc('A')], [['A', 1]], undefined, undefined);
      const score = new Map(fused).get('A');
      ok(Number.isFinite(score) && score > 0, 'a non-finite config produces a finite fused score (defaults applied, not NaN)');
      // The applied defaults come from config.RRF_DEFAULTS — the single place these values live (config uses it
      // for its own defaults AND rrf.js falls back to it), so A (rank 0 in both) = (faiss + bm25) / (k + 1).
      const D = cfg.RRF_DEFAULTS;
      near(score, (D.faissWeight + D.bm25Weight) / (D.k + 1), 'the single-sourced default weights/k are used when config is invalid');
    } finally {
      cfg.rrfFaissWeight = saved.f; cfg.rrfBm25Weight = saved.b; cfg.rrfK = saved.k;
    }
    // Guard the single source itself: these are the documented defaults, in exactly one place.
    ok(cfg.RRF_DEFAULTS && cfg.RRF_DEFAULTS.faissWeight === 0.3 && cfg.RRF_DEFAULTS.bm25Weight === 0.7 && cfg.RRF_DEFAULTS.k === 60,
      'config.RRF_DEFAULTS holds the documented 0.3 / 0.7 / 60 (single source for the config defaults and the rrf.js fallbacks)');
    console.log('✓ rrf: invalid config weights fall back to the single-sourced documented defaults (fail-safe)');
  }

  // ── A non-positive hand-edited rrfK must fall back to the default, never divide by zero ──
  // The fusion term is 1/(k + rank + 1); a k <= 0 makes the denominator reach 0 at rank = -(k+1), poisoning
  // every score with Infinity/NaN and scrambling the ranking. The guard falls back to k=60 instead.
  {
    const saved = cfg.rrfK;
    try {
      for (const bad of [-1, 0, -60]) {
        cfg.rrfK = bad;
        // With bad k = -1, rank 0 would be 1/(-1+0+1) = 1/0 = Infinity if unguarded.
        const fused = reciprocalRankFusion([fdoc('A'), fdoc('B')], [['A', 1]], 0.3, 0.7);
        for (const [, score] of fused) ok(Number.isFinite(score), `rrfK=${bad} still yields finite scores (no div-by-zero)`);
        const a = new Map(fused).get('A');
        near(a, (0.3 + 0.7) / 61, `rrfK=${bad} falls back to the default k=60`);
      }
    } finally {
      cfg.rrfK = saved;
    }
    console.log('✓ rrf: a non-positive rrfK config falls back to the default (no Infinity/NaN in the ranking)');
  }

  console.log(`\nALL RRF UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ RRF UNIT TEST FAILED:', e && e.message, e && e.stack);
  process.exit(1);
}
