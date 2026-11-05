'use strict';
// Guards the late-interaction (ColBERT-style) reranker's pure scoring math and its non-regressive,
// fail-open wiring. The MaxSim operator and the token-matrix normalization are deterministic and are
// tested directly (no model load). The wiring guards assert the feature is off by default, re-sorts the
// cross-encoder candidates without touching the relevance-gate signal, and returns candidates unchanged
// on any failure — so enabling it can sharpen passage-anchor selection but never block or regress. Run:
// `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const core = require(path.join(PROJECT, 'lib', 'retrieval', 'colbertcore'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

try {
  // ── tokenMatrix: [1, tokens, dim] tensor → L2-normalized rows ──
  // Two tokens: [3,4,0] (norm 5) and [0,0,2] (norm 2) → unit rows [0.6,0.8,0] and [0,0,1].
  const m = core.tokenMatrix({ dims: [1, 2, 3], data: [3, 4, 0, 0, 0, 2] });
  ok(m.length === 2 && m[0].length === 3, 'tokenMatrix returns one row per token');
  ok(approx(m[0][0], 0.6) && approx(m[0][1], 0.8) && approx(m[0][2], 0), 'tokenMatrix L2-normalizes each token row');
  ok(approx(Math.hypot(m[1][0], m[1][1], m[1][2]), 1), 'every token row is unit length');

  // ── maxSim: for each query token, the max cosine to any passage token, summed ──
  const qx = [1, 0, 0], qy = [0, 1, 0];
  // A passage that contains both query directions → each query token maxes at 1 → total 2.
  ok(approx(core.maxSim([qx, qy], [qx, qy]), 2), 'maxSim sums a perfect per-token match to the query token count');
  // A passage orthogonal to the query → ~0.
  ok(approx(core.maxSim([qx], [[0, 1, 0]]), 0), 'maxSim is ~0 for an orthogonal passage');
  // A passage covering only one of two query tokens → ~1 (the other query token maxes at 0).
  ok(approx(core.maxSim([qx, qy], [qx]), 1), 'maxSim rewards partial coverage proportionally');
  // Empty inputs are safe.
  ok(core.maxSim([], [qx]) === 0 && core.maxSim([qx], []) === 0, 'maxSim returns 0 for empty inputs');

  // A passage that covers each query token somewhere outscores one that covers only one — the whole
  // point of late interaction over a single pooled score.
  const covers = core.maxSim([qx, qy], [qx, qy, [0, 0, 1]]);
  const partial = core.maxSim([qx, qy], [qx, [0, 0, 1]]);
  ok(covers > partial, 'a passage covering all query tokens scores higher than one covering fewer');

  // ── Wiring: off by default, config round-trips, fail-open, gate signal untouched ──
  const cfg = require(path.join(PROJECT, 'lib', 'config'));
  ok(cfg.USE_COLBERT_RERANK === false, 'the late-interaction reranker is OFF by default');
  ok(typeof cfg.COLBERT_MODEL === 'string' && cfg.COLBERT_MODEL.length > 0, 'a default token-embedding model id is set');

  const mgr = fs.readFileSync(path.join(PROJECT, 'lib', 'retrieval', 'colbert.js'), 'utf-8');
  ok(/makeRerankWorker\(\{/.test(mgr) && /availableKey:\s*'USE_COLBERT_RERANK'/.test(mgr),
    'the colbert manager is built from the shared rerank-worker factory, toggled live by USE_COLBERT_RERANK');
  // The worker isolation + fail-open + live-toggle invariants live in the shared factory now.
  const factory = fs.readFileSync(path.join(PROJECT, 'lib', 'retrieval', 'rerankworker.js'), 'utf-8');
  ok(/WorkerRpc/.test(factory), 'model work runs in a worker (never the main event loop)');
  ok(/return chunks;/.test(factory) && /available:\s*\(\) => require\('\.\.\/config'\)\[availableKey\]/.test(factory),
    'the shared factory reads the toggle live and returns the input order on failure (fail-open)');

  const search = fs.readFileSync(path.join(PROJECT, 'lib', 'retrieval', 'search.js'), 'utf-8');
  ok(/require\('\.\.\/config'\)\.USE_COLBERT_RERANK/.test(search) && /colbertRerank\(standaloneQuery, reranked\)/.test(search),
    'search re-sorts the reranked candidates through colbert when enabled (read live)');
  ok(/pickAnchorsByParent\(ranked,/.test(search), 'anchor selection uses the (optionally) colbert-refined order');
  // The cross-encoder rerankByParent (the gate signal) is still built from `reranked`, not `ranked`.
  ok(/rerankByParent\.set\(chunk\.parentId/.test(search), 'the cross-encoder score still feeds the relevance/web-offer gate (unchanged)');

  console.log(`\nALL COLBERT UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ COLBERT UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
