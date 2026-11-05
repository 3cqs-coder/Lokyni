'use strict';

// ── colbertcore — late-interaction (ColBERT-style) scoring, isolated from everything else ──
//
// Pure model logic: load a token-embedding model once, embed the query and each passage into a
// matrix of PER-TOKEN vectors (not one pooled vector), and score each passage by the late-interaction
// "MaxSim" operator — for every query token, take its greatest cosine similarity to any passage token,
// and sum those maxima. That rewards a passage that covers each part of the query somewhere in its
// text, giving token-level precision a single pooled embedding loses. With a ColBERT-trained model the
// per-token vectors are the ColBERT projection; with a general sentence model they are its token
// embeddings — either way the scoring is genuine late interaction.
//
// No config, no worker plumbing, no I/O beyond the one-time model load — so it runs identically inside
// a worker_thread (its normal home, off the event loop; see lib/retrieval/colbert.js) and would run
// inline unchanged. The caller passes an already-resolved model id, keeping this file free of the
// config module (which pulls in heavy deps and must not load in a worker). The MaxSim math is exported
// on its own so it can be unit-tested without loading any model.

const { makeLoader, MAX_INPUT_CHARS } = require('./modelload');

let _extractor = null;

// Load the feature-extraction pipeline once (per-token output: pooling 'none'), cached for the module's
// lifetime, through the shared offline-first loader (concurrent-load dedup, post-failure cooldown, cache-probe,
// and remote-retry live there). Only the model build differs: prefer 8-bit quantized weights, full precision
// otherwise — the library no longer quantizes by default, so precision is set explicitly.
const init = makeLoader({
  isLoaded: () => !!_extractor,
  reset:    () => { _extractor = null; },
  load: async (transformers, modelId) => {
    const { pipeline } = transformers;
    try { _extractor = await pipeline('feature-extraction', modelId, { dtype: 'q8' }); }
    catch (_) { _extractor = await pipeline('feature-extraction', modelId, { dtype: 'fp32' }); }
  },
});

// Turn a transformers.js feature-extraction Tensor (dims [1, tokens, dim] with pooling 'none') into a
// plain array of L2-normalized token vectors, so MaxSim can use a plain dot product for cosine.
function tokenMatrix(tensor) {
  const dims = tensor && tensor.dims;
  const data = tensor && tensor.data;
  if (!data || !dims || dims.length < 2) throw new Error(`unexpected feature-extraction shape (${dims})`);
  const tokens = dims.length === 3 ? dims[1] : dims[0];
  const dim    = dims[dims.length - 1];
  const rows = new Array(tokens);
  for (let t = 0; t < tokens; t++) {
    const row = new Float32Array(dim);
    let norm = 0;
    for (let d = 0; d < dim; d++) { const v = Number(data[t * dim + d]); row[d] = v; norm += v * v; }
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dim; d++) row[d] /= norm;
    rows[t] = row;
  }
  return rows;
}

// The late-interaction MaxSim score of a query token matrix against a passage token matrix: for each
// query token, its maximum dot product (cosine, since rows are unit-normalized) with any passage
// token, summed over query tokens. Pure — exported for tests. Returns 0 for empty inputs.
function maxSim(queryRows, passageRows) {
  if (!queryRows || !passageRows || queryRows.length === 0 || passageRows.length === 0) return 0;
  const dim = queryRows[0].length;
  let total = 0;
  for (const q of queryRows) {
    let best = -Infinity;
    for (const p of passageRows) {
      let dot = 0;
      for (let d = 0; d < dim; d++) dot += q[d] * p[d];
      if (dot > best) best = dot;
    }
    total += best;
  }
  return total;
}

// Score each passage against the query by MaxSim, aligned to input order. Higher = better late
// interaction match. Throws if the model isn't loaded so the caller can keep the prior order.
// Cap input length before extraction (MAX_INPUT_CHARS is shared with the reranker via modelload). The
// feature-extraction pipeline already truncates to the model's token window, but bounding the string first
// avoids tokenizing (and building a per-token matrix from) text the model would discard — and keeps MaxSim,
// which is O(query_tokens x passage_tokens), bounded.
const clip = (t) => String(t == null ? '' : t).slice(0, MAX_INPUT_CHARS);

async function score(query, texts) {
  if (!_extractor) throw new Error('colbert model not initialized');
  if (!texts || texts.length === 0) return [];
  const q = tokenMatrix(await _extractor(clip(query), { pooling: 'none' }));
  const out = new Array(texts.length);
  for (let i = 0; i < texts.length; i++) {
    try {
      const p = tokenMatrix(await _extractor(clip(texts[i]), { pooling: 'none' }));
      out[i] = maxSim(q, p);
    } catch { out[i] = 0; }   // one bad passage never sinks the batch
  }
  return out;
}

module.exports = { init, score, maxSim, tokenMatrix };
