'use strict';

// RRF fusion weights and the rank constant come from config so they can be tuned per corpus
// without editing code (a paraphrase-heavy corpus benefits from a higher FAISS weight; a
// code/identifier corpus from BM25). They are read LIVE at call time, not captured at import:
// they are tunable config.json knobs, and the semantic-answer cache signature includes them, so
// editing them must actually change fusion (not just invalidate the cache) without a restart.
// Defaults preserve the original 0.3 / 0.7 / 60 behavior exactly.
// k must be strictly positive: the fusion term is 1/(k + rank + 1), and a non-positive k (a bad hand-edit
// of the config knob) makes the denominator reach 0 at rank = -(k+1), poisoning every fused score with
// Infinity/NaN and scrambling the ranking. Fall back to the default when the configured value is not a
// positive finite number, matching the weight guards below. The default VALUES come from config.RRF_DEFAULTS
// (the single source config itself uses), so these defense-in-depth fallbacks can't drift from the real
// defaults. config already clamps these to valid ranges, so in practice the fallbacks never fire.
const _rrfK        = () => { const c = require('../config'); const v = c.rrfK;          return (Number.isFinite(v) && v > 0) ? v : c.RRF_DEFAULTS.k; };
const _faissWeight = () => { const c = require('../config'); const v = c.rrfFaissWeight; return Number.isFinite(v) ? v : c.RRF_DEFAULTS.faissWeight; };
const _bm25Weight  = () => { const c = require('../config'); const v = c.rrfBm25Weight;  return Number.isFinite(v) ? v : c.RRF_DEFAULTS.bm25Weight; };

const reciprocalRankFusion = (faissResults, bm25Results, faissWeight, bm25Weight) => {
  const fw = Number.isFinite(faissWeight) ? faissWeight : _faissWeight();
  const bw = Number.isFinite(bm25Weight)  ? bm25Weight  : _bm25Weight();
  const k  = _rrfK();
  const scores = new Map();

  faissResults.forEach(([doc], rank) => {
    // Guard metadata the same way fuseDenseLists does below: a FAISS row that somehow lacks metadata must
    // be skipped, not throw out of the fusion (this runs outside a try/catch on the answer hot path).
    const docId = doc && doc.metadata && (doc.metadata.parentId || doc.metadata.docId);
    if (!docId) return;
    scores.set(docId, (scores.get(docId) || 0) + fw * (1 / (k + rank + 1)));
  });

  bm25Results.forEach(([docId], rank) => {
    scores.set(docId, (scores.get(docId) || 0) + bw * (1 / (k + rank + 1)));
  });

  return [...scores.entries()].sort((a, b) => b[1] - a[1]);
};

// Fuse several dense (FAISS) candidate lists into one, for RAG-Fusion. Each input list is a
// ranked array of [doc, cosine] (best-first), one per query phrasing. Chunks are identified
// by their stable chunk id so the same passage found by different phrasings reinforces each
// other, and the merged list is ordered by reciprocal-rank-fusion of each chunk's ranks
// across the lists. The COSINE is preserved (the max seen for that chunk), so downstream
// gates that read a real similarity value keep working — only the ordering and the breadth of
// candidates change. Returns [doc, cosine] best-first. Chunks with no usable key are dropped.
//
// The key is the chunk's own id (metadata.childId), not its text: two DIFFERENT parent
// documents can contain an identical chunk (a shared header, a boilerplate notice, a
// duplicated file), and keying by text would collapse them into one entry — silently dropping
// whichever parent was surfaced only through that shared chunk. Text is the fallback for a
// chunk that somehow lacks an id.
const fuseDenseLists = (lists) => {
  const fused = new Map();   // key -> { doc, cosine, score }
  const k = _rrfK();
  for (const list of (lists || [])) {
    if (!Array.isArray(list)) continue;
    list.forEach(([doc, cosine], rank) => {
      const key = doc && ((doc.metadata && doc.metadata.childId) || doc.pageContent);
      if (!key) return;
      const contrib = 1 / (k + rank + 1);
      const prev = fused.get(key);
      if (prev) {
        prev.score += contrib;
        if (typeof cosine === 'number' && cosine > prev.cosine) prev.cosine = cosine;
      } else {
        fused.set(key, { doc, cosine: typeof cosine === 'number' ? cosine : 0, score: contrib });
      }
    });
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ doc, cosine }) => [doc, cosine]);
};

module.exports = { reciprocalRankFusion, fuseDenseLists };
