'use strict';
// Reorder retrieved documents by the cross-encoder reranker's judgment while leaving the fused RRF
// ranking otherwise intact.
//
// The reranker is the sharpest relevance signal in the pipeline — it cleanly separates a genuine match
// from a document that merely shares an incidental word — so a document it scores highest should be
// cited first and must survive the downstream context-budget trim, not stay wherever RRF's chunk
// multiplicity and keyword fusion happened to place it. Without this the reranker only chose the passage
// WITHIN a document; the document order shown to the model and the user was pure RRF, so the most
// relevant document could be cited below weaker ones or trimmed out of the context window entirely.
//
// The reorder is deliberately conservative: only the documents the reranker actually scored (the dense
// candidates) are moved, and only among the positions they already occupy. It is a stable in-place
// permutation of those "scored slots", so it can never add, drop, or globally scramble the ranking —
// documents with no reranker score (BM25-only hits, the tail past the candidate cut) keep their RRF
// order untouched. `scores` maps a docId to its best cross-encoder score, which may be negative; a
// lower-scoring scored document simply sinks within the scored slots, so an off-topic candidate with a
// stray positive chunk cannot leapfrog a genuine match, and a genuinely weak candidate cannot jump a
// solid BM25-only document sitting in a later slot.

// `ranked` is an array of [docId, rrfScore]. `downweightFactor` (optional) maps a docId to an outcome
// down-weight factor in [0, 0.15] (👎 feedback on similar past queries). Returns a NEW array; the input is
// never mutated.
const reorderByReranker = (ranked, scores, downweightFactor = null) => {
  if (!Array.isArray(ranked) || ranked.length < 2 || !scores || scores.size === 0) return ranked;
  const slots = [];    // indices in `ranked` that carry a reranker score
  const scored = [];    // the [docId, rrfScore] entries at those indices, in RRF order
  for (let i = 0; i < ranked.length; i++) {
    if (scores.has(ranked[i][0])) { slots.push(i); scored.push(ranked[i]); }
  }
  if (scored.length < 2) return ranked;   // 0 or 1 scored documents — nothing to reorder
  // Effective score = the cross-encoder score, nudged DOWN by any outcome down-weight so a document that led
  // to 👎 answers on similar queries sinks among the reranked slots instead of having its penalty erased by
  // this reorder (which previously sorted on the raw cross-encoder score alone). The nudge is scaled to the
  // score SPREAD — cross-encoder logits have no fixed scale, so a fractional penalty must be measured against
  // the local range — and bounded by the same <=15% cap as the fused-score down-weight, so a strong match
  // with a small penalty still ranks above a genuinely weaker one. With no down-weight this is a no-op and the
  // sort is byte-identical to the plain cross-encoder order.
  const hasDw = downweightFactor && downweightFactor.size > 0;
  let spread = 1;
  if (hasDw) {
    let mn = Infinity, mx = -Infinity;
    for (const e of scored) { const v = scores.get(e[0]); if (v < mn) mn = v; if (v > mx) mx = v; }
    spread = (mx - mn) || 1;
  }
  const eff = (docId) => scores.get(docId) - (hasDw ? (downweightFactor.get(docId) || 0) * spread : 0);
  // V8's Array.sort is stable, so equal effective scores keep their original RRF order.
  scored.sort((a, b) => eff(b[0]) - eff(a[0]));   // best score first
  const out = ranked.slice();
  for (let j = 0; j < slots.length; j++) out[slots[j]] = scored[j];
  return out;
};

module.exports = { reorderByReranker };
