'use strict';
// Guards the document-level second-stage rerank in lib/retrieval/rerankorder.js. The cross-encoder is
// the sharpest relevance signal, so it must reorder the DOCUMENTS (not just pick a passage within one):
// the best-scored document has to be cited first and survive the context-budget trim. The reorder must
// be safe — a stable permutation of only the scored documents, never adding, dropping, or scrambling the
// rest — so this exercises the algorithm directly and source-guards how search.js wires it in.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { reorderByReranker } = require(path.join(PROJECT, 'lib', 'retrieval', 'rerankorder'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };

try {
  // ── Reorders scored docs best-first, within their own slots; unscored docs keep their positions ──
  {
    const ranked = [['A', 0.9], ['B', 0.8], ['C', 0.7], ['D', 0.6]];
    const scores = new Map([['A', 1], ['B', 5], ['D', -2]]);   // C is unscored (BM25-only / tail)
    const out = reorderByReranker(ranked, scores);
    eq(out.map(r => r[0]), ['B', 'A', 'C', 'D'], 'the highest cross-encoder score is promoted to the front');
    ok(out[2][0] === 'C', 'an unscored document keeps its exact position');
    ok(out[3][0] === 'D', 'a negative-scored document sinks to the bottom of the scored slots');
    // The rrfScore paired with each doc travels with it (needed by the downstream co-source filter).
    ok(out[0][1] === 0.8 && out[1][1] === 0.9, 'each document keeps its own rrfScore after the move');
  }

  // ── Stable for ties: equal reranker scores keep their original RRF order ──
  {
    const ranked = [['A', 0.9], ['B', 0.8], ['C', 0.7]];
    const scores = new Map([['A', 3], ['B', 3], ['C', 3]]);
    eq(reorderByReranker(ranked, scores).map(r => r[0]), ['A', 'B', 'C'], 'a tie preserves the RRF order (stable sort)');
  }

  // ── Input is never mutated (a new array is returned) ──
  {
    const ranked = [['A', 0.9], ['B', 0.8]];
    const before = JSON.stringify(ranked);
    reorderByReranker(ranked, new Map([['A', 1], ['B', 9]]));
    ok(JSON.stringify(ranked) === before, 'the input array is not mutated');
  }

  // ── Every document survives (permutation, never a drop or duplicate) ──
  {
    const ranked = [['A', 5], ['B', 4], ['C', 3], ['D', 2], ['E', 1]];
    const out = reorderByReranker(ranked, new Map([['B', 9], ['D', 8], ['E', 7]]));
    eq([...out.map(r => r[0])].sort(), ['A', 'B', 'C', 'D', 'E'], 'no document is dropped or duplicated');
    ok(out.length === 5, 'the ranking length is unchanged');
    // A and C were unscored: they must remain at their original indices (0 and 2).
    ok(out[0][0] === 'A' && out[2][0] === 'C', 'unscored documents stay in place; only scored slots (1,3,4) are permuted');
  }

  // ── Edge cases: nothing to reorder ──
  {
    const ranked = [['A', 0.9], ['B', 0.8]];
    ok(reorderByReranker(ranked, new Map()) === ranked, 'an empty score map returns the input unchanged');
    ok(reorderByReranker(ranked, new Map([['A', 1]])) === ranked, 'a single scored doc returns the input unchanged');
    ok(reorderByReranker([], new Map([['A', 1]])) .length === 0, 'an empty ranking is handled');
    ok(reorderByReranker([['A', 1]], new Map([['A', 1]]))[0][0] === 'A', 'a one-doc ranking is handled');
  }
  // ── Outcome down-weight folds into the reorder (so it is not erased by it) ──
  {
    const ranked = [['A', 0.03], ['B', 0.02], ['C', 0.01]];
    const scores = new Map([['A', 5], ['B', 4.9], ['C', 1]]);   // A tops the cross-encoder; spread = 4
    ok(reorderByReranker(ranked, scores)[0][0] === 'A', 'no down-weight: the top cross-encoder doc leads');
    // A penalized at the 15% cap sinks below the near-scored clean doc B (nudge 0.15 * spread 4 = 0.6).
    const out = reorderByReranker(ranked, scores, new Map([['A', 0.15]]));
    ok(out[0][0] === 'B' && out[1][0] === 'A', 'a penalized top doc sinks below a near-scored clean doc');
    ok(out[2][0] === 'C', 'the clearly-weaker doc stays last');
    // A capped penalty cannot flip a clear cross-encoder lead (the nudge is <= 15% of the spread).
    const out2 = reorderByReranker([['A', 0.03], ['B', 0.02]], new Map([['A', 5], ['B', 4]]), new Map([['A', 0.15]]));
    ok(out2[0][0] === 'A', 'a capped penalty cannot flip a clear cross-encoder lead');
  }
  console.log('✓ rerank-order: documents are reordered by cross-encoder score, safely and stably');
  console.log('✓ rerank-order: a 👎 down-weight sinks a penalized doc among the reranked slots (not erased by the reorder)');

  // ── Source guards: search.js wires the reorder in correctly ──
  const src = fs.readFileSync(path.join(PROJECT, 'lib', 'retrieval', 'search.js'), 'utf-8');
  ok(/require\('\.\/rerankorder'\)/.test(src), 'search.js imports the reorder helper');
  // The reorder is also skipped in cross-lingual mode: a cross-encoder reranker scores query-passage relevance by
  // surface token interaction, so it is as cross-lingual-weak as BM25 and would push the correct cross-language
  // document DOWN — in that mode the dense-only fused order is the trusted signal and must stand.
  ok(/if \(USE_RERANKER && !isRetry && !crossLingualMode && rerankByParent\.size > 0\) \{\s*rankedDocIds = reorderByReranker\(rankedDocIds, rerankByParent, downweightFactor\);/.test(src),
    'the reorder runs only with the reranker on, off the retry path, out of cross-lingual mode, and when there are scores, and folds in the down-weight');
  // The reorder must precede the assembly loop (so it drives citation order and the budget trim).
  ok(src.indexOf('reorderByReranker(rankedDocIds, rerankByParent, downweightFactor)') < src.indexOf('for (const [docId, rrfScore] of rankedDocIds)'),
    'the reorder happens before the document assembly loop');
  // topRrfScore must be the GENUINE pre-boost top fused score — captured before the +0.05 promotions AND before
  // the reorder — so the co-source filter stays anchored to the natural maximum, never a promoted score or a
  // lower-RRF document the reorder moved to the front.
  ok(/const naturalTopRrfScore = fusedRanking\.length > 0 \? fusedRanking\[0\]\[1\] : 0;/.test(src)
    && /const topRrfScore = naturalTopRrfScore;/.test(src),
    'topRrfScore is the genuine pre-boost top fused score (stable under the promotions and the reorder)');
  ok(src.indexOf('const naturalTopRrfScore =') !== -1
    && src.indexOf('const naturalTopRrfScore =') < src.indexOf('reorderByReranker(rankedDocIds, rerankByParent, downweightFactor)'),
    'the genuine top score is captured before the reorder');
  console.log('✓ rerank-order: search.js applies the reorder before assembly and anchors topRrfScore to the genuine pre-boost max');

  // ── Worker (re)load + score hardening (rerankworker.js) ──
  const rw = fs.readFileSync(path.join(PROJECT, 'lib', 'retrieval', 'rerankworker.js'), 'utf-8');
  ok(/if \(!_ready\) \{[\s\S]*?_rpc\.request\(\{ op: 'init' \}, \{ timeoutMs: INIT_TIMEOUT_MS \}\)/.test(rw),
    'a cold/respawned worker is initialized under the LONG init budget before scoring (no degrade loop when a model reload overruns the short score timeout)');
  ok(/scores\.some\(s => !Number\.isFinite\(s\)\)/.test(rw),
    'the score guard rejects non-finite scores (NaN AND ±Infinity), not only NaN');

  // ── Web-fetch hardening (websearch.js) ──
  const ws = fs.readFileSync(path.join(PROJECT, 'lib', 'websearch.js'), 'utf-8');
  ok(/if \(!\/\^text\\\/\|application[\s\S]*?\.test\(contentType\)\) return \{ ok: true, text: '' \};/.test(ws),
    'fetchPageText requires an explicit text-ish Content-Type (a missing header is treated as non-text, not ingested)');
  ok(/target\.protocol !== 'http:' && target\.protocol !== 'https:'\) return null;/.test(ws),
    'the DDG redirect decoder drops non-http(s) targets (file:/data:/javascript:)');
  console.log('✓ rerank-order: worker reload uses the long init budget + finite-score guard; web fetch is content-type + scheme hardened');

  console.log(`\nALL RERANK-ORDER UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ RERANK-ORDER UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
