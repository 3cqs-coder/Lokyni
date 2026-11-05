'use strict';
// Guards the relevance gate and the L2→cosine conversion in lib/embeddings.js.
//
// Three properties, each a real bug this locks down:
//   1. l2ToCosine converts a SQUARED L2 distance (what faiss-node's IndexFlatL2 returns) to a true
//      cosine with `1 − d²/2`. A prior version squared the already-squared distance (`1 − d⁴/2`),
//      warping the score space so the documented minCosineScore threshold refused a band of genuinely
//      relevant queries. The order of hits was unaffected (both forms are monotonic), so only the
//      absolute-threshold gate was mis-calibrated — exactly what this checks.
//   2. The BM25 fast-path admits a keyword hit that beats the corpus's typical (median) top-1 score,
//      not a fixed absolute constant, so a low-scoring corpus isn't held to a bar it can't clear and a
//      high-scoring one can't wave an off-topic single-token match through.
//   3. When dense search produces nothing (an empty index, or a transient embed-provider outage),
//      the gate degrades to keyword presence instead of scoring the absent result as cosine 0 and
//      hard-refusing the query — while a genuinely empty corpus (no keyword match either) is declined.
// Fully functional: the gate takes the caller's cosine directly, so no live provider is needed.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { NUMERIC_RANGES } = require(path.join(PROJECT, 'lib', 'settings-schema'));
const { l2ToCosine, isQueryRelevant } = require(path.join(PROJECT, 'lib', 'embeddings'));
const { MIN_COSINE_SCORE } = require(path.join(PROJECT, 'lib', 'config'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const near = (a, b, m) => { checks++; assert.ok(Math.abs(a - b) < 1e-9, `${m} (got ${a}, want ${b})`); };

// A fake index: liveBM25.engine.search(query, k) returns [[docId, score]] (or [] for no match);
// pass bm25Top=null for no BM25 engine at all (e.g. banks-only corpus with no keyword index).
const makeIdx = ({ bm25Top, median = 3.0 } = {}) => ({
  liveBM25: bm25Top === null || bm25Top === undefined ? null : {
    medianScore: median,
    engine: { search: () => (bm25Top === 'none' ? [] : [['doc-1', bm25Top]]) },
  },
});

try {
  // ── 1. l2ToCosine converts squared distance, and is NOT double-squared ──
  near(l2ToCosine(0), 1, 'd²=0 (identical vectors) → cosine 1');
  near(l2ToCosine(1), 0.5, 'd²=1 → cosine 0.5');
  near(l2ToCosine(2), 0, 'd²=2 (orthogonal) → cosine 0');
  near(l2ToCosine(4), 0, 'd²=4 (opposite) → clamped to 0, never negative');
  // The distinguishing case: at d²=0.5 the correct cosine is 0.75; the double-squared bug reported 0.875.
  near(l2ToCosine(0.5), 0.75, 'd²=0.5 → cosine 0.75 (not the double-squared 0.875)');
  const src = fs.readFileSync(path.join(PROJECT, 'lib', 'embeddings.js'), 'utf-8');
  ok(/1 - l2 \/ 2/.test(src) && !/1 - \(l2 \* l2\) \/ 2/.test(src),
    'l2ToCosine uses 1 - l2/2 (the squared distance is not squared again)');

  // ── 2. BM25 fast-path is median-relative, not the old absolute 2.0 ──
  // A keyword hit above the corpus median admits outright, even with a zero cosine.
  ok(isQueryRelevant(makeIdx({ bm25Top: 5.0, median: 3.0 }), 'q', 0) === true,
    'a BM25 top score above the corpus median admits the query outright');
  // A hit of 2.5 would have passed the old absolute `> 2.0` fast-path; with a median of 3.0 it must NOT
  // short-circuit, so a low cosine now correctly refuses it (proves the absolute constant is gone).
  ok(isQueryRelevant(makeIdx({ bm25Top: 2.5, median: 3.0 }), 'q', 0.1) === false,
    'a BM25 score below the corpus median does not short-circuit; a low cosine then refuses it');
  // Same 2.5 hit on a LOW-scoring corpus (median 1.0) is above median → admits, where the old fixed
  // bar behavior is now corpus-relative.
  ok(isQueryRelevant(makeIdx({ bm25Top: 2.5, median: 1.0 }), 'q', 0) === true,
    'the same keyword score admits on a low-scoring corpus (the bar scales to the corpus)');

  // ── 3. Cosine path uses the documented threshold in true-cosine space ──
  const above = MIN_COSINE_SCORE + 0.05, below = MIN_COSINE_SCORE - 0.05;
  ok(isQueryRelevant(makeIdx({ bm25Top: 1.0, median: 3.0 }), 'q', above) === true,
    'a cosine at/above minCosineScore admits (weak keyword, strong vector match)');
  ok(isQueryRelevant(makeIdx({ bm25Top: 1.0, median: 3.0 }), 'q', below) === false,
    'a cosine below minCosineScore refuses (weak keyword, weak vector match)');

  // ── 4. Dense outage / empty index degrades to keyword presence ──
  ok(isQueryRelevant(makeIdx({ bm25Top: 1.0, median: 3.0 }), 'q', null) === true,
    'no dense signal + a keyword match degrades to relevant (an embed blip is not a hard refusal)');
  ok(isQueryRelevant(makeIdx({ bm25Top: 'none', median: 3.0 }), 'q', null) === false,
    'no dense signal + no keyword match (empty corpus) is still correctly declined');
  ok(isQueryRelevant(makeIdx({ bm25Top: null }), 'q', null) === false,
    'no dense signal + no BM25 index at all is declined');
  // A non-finite cosine (NaN) must never read as relevant.
  ok(isQueryRelevant(makeIdx({ bm25Top: 'none', median: 3.0 }), 'q', NaN) === false,
    'a NaN cosine is treated as no signal, never as relevant');

  // ── 5. A precomputed BM25 result is REUSED, so the gate does not scan the corpus a second time ──
  // The caller (search.js) computes engine.search(standaloneQuery) once and passes it in; the gate must use
  // that instead of searching again. Here engine.search throws if called — proving the precomputed path wins.
  {
    let searchCalls = 0;
    const idxNoSearch = {
      liveBM25: { medianScore: 3.0, engine: { search: () => { searchCalls++; throw new Error('engine.search must not be called when a precomputed result is passed'); } } },
    };
    ok(isQueryRelevant(idxNoSearch, 'q', 0, [['doc-1', 5.0]]) === true,
      'a precomputed BM25 top score above median admits without calling engine.search');
    ok(isQueryRelevant(idxNoSearch, 'q', 0.1, [['doc-1', 2.5]]) === false,
      'a precomputed BM25 top score below median does not short-circuit (then a low cosine refuses)');
    ok(isQueryRelevant(idxNoSearch, 'q', null, []) === false,
      'a precomputed empty BM25 result with no dense signal is declined without calling engine.search');
    ok(searchCalls === 0, 'engine.search is never called when a precomputed BM25 result is supplied (no duplicate scan)');
  }

  // ── 6. Model-agnostic off-topic abstention on the cross-encoder score (lib/retrieval/search.js) ──
  // The cosine gate above is embedding-model-dependent (nomic, bge-m3 and every other model sit at
  // different cosine scales), so it cannot keep an off-topic question out across whatever model a user
  // picks. The companion gate abstains on the cross-encoder (reranker) score, whose scale is fixed by the
  // reranker model and does NOT move when the embedding model changes — so one absolute cutoff generalizes.
  // Config default and the shipped logic are source-guarded here (the live gate needs the reranker worker).
  {
    const cfg = require(path.join(PROJECT, 'lib', 'config'));
    ok(cfg.RERANKER_DROP_BELOW === -8, 'the cross-encoder off-topic cutoff defaults to -8 (below the weak-but-relevant -1..-5 band)');
    const confSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'config.js'), 'utf-8');
    ok(NUMERIC_RANGES.rerankerDropBelow.min === -20 && NUMERIC_RANGES.rerankerDropBelow.max === 10,
      'the cutoff is clamped via NUMERIC_RANGES so a hand-edited config cannot set an out-of-range value');
    ok(/RERANKER_DROP_BELOW = num\(providerConfig\.rerankerDropBelow, def\('rerankerDropBelow'\), NUMERIC_RANGES\.rerankerDropBelow\)/.test(confSrc),
      'the cutoff is clamped through num() like every peer knob (not a raw ?? default)');

    const ssrc = fs.readFileSync(path.join(PROJECT, 'lib', 'retrieval', 'search.js'), 'utf-8');
    // Fires only when the reranker actually scored (fail-open: a disabled/absent/timed-out reranker, or a
    // retry that skips reranking, leaves topRerankerScore null and the gate is skipped — exactly today's
    // behavior). The cutoff comes from config, not a magic literal in the branch.
    ok(/Number\.isFinite\(topRerankerScore\) && topRerankerScore < rerankerDropBelow/.test(ssrc),
      'the abstention fires only when the reranker scored AND every served doc is below the configured cutoff');
    ok(/const rerankerDropBelow = cfg\.RERANKER_DROP_BELOW;/.test(ssrc),
      'the branch reads the cutoff from config (model-agnostic, user-tunable), not a hard-coded number');
    // The SAME deliberate-context exceptions as the early gate — a low cross-encoder score on a hand-picked,
    // entity-bridged, entity-named, conversation-continued, or named-rescue serve is never abstained on — PLUS
    // cross-lingual mode: the English-trained cross-encoder under-scores a genuine cross-lingual match (the
    // document is in another language than the query), so the dense-trust decision must not be overridden here.
    ok(/const deliberateContext = focusMode \|\| entityBridged \|\| namesCorpusEntity \|\| namedGateRescued\s*\|\| crossLingualMode\s*\|\| conversationContext\.allowedDocIds\?\.length > 0;/.test(ssrc),
      'the abstention carries the same deliberate-context exceptions as the early relevance gate (plus cross-lingual mode)');
    ok(/&& !deliberateContext/.test(ssrc), 'a deliberate serve is never abstained on by the cross-encoder gate');
    // Skipped for a confidently non-English query (ms-marco MiniLM is English-trained and under-scores
    // genuine non-English matches). Fail-open: langdetect flags only CONFIDENT non-English.
    ok(/&& !require\('\.\.\/langdetect'\)\.isLikelyNonEnglish\(standaloneQuery\)/.test(ssrc),
      'the cross-encoder abstention is skipped for a confidently non-English query (fail-open language guard)');
    // Abstains with the web offer still open, mirroring the early out-of-scope return shape.
    const gi = ssrc.indexOf('const rerankerDropBelow = cfg.RERANKER_DROP_BELOW;');
    ok(gi !== -1, 'the cross-encoder abstention block is present');
    const gbody = ssrc.slice(gi, gi + 1100);
    ok(/outOfScope: true, canWebFallback: true/.test(gbody),
      'an all-off-topic served set abstains as out-of-scope with the web fallback available (not a dead end)');
  }

  console.log('✓ relevance-gate: cosine conversion is single-squared; the gate is corpus-relative, degrades on a dense outage, reuses a precomputed BM25 scan, and abstains model-agnostically on the cross-encoder score');
  console.log(`\nALL RELEVANCE-GATE UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ RELEVANCE-GATE UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
