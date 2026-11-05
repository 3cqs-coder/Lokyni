'use strict';
// Similarity over past query outcomes — the retrieval half of outcome-aware
// retrieval. Given a new query, finds prior similar queries via Okapi BM25.
//
// Two consumers:
//   - "You asked something similar before" — surface a past query (and how it was
//     rated) when the new one closely matches it.
//   - Down-weight set — documents that led to 👎 answers on similar past queries,
//     so retrieval can gently penalize them for this query.
//
// BM25 over the query corpus (NOT embeddings): zero new dependencies, offline, instant
// at single-user scale. BM25 improves on plain TF-IDF cosine here because its term-
// frequency saturation and document-length normalization stop a longer, wordier past
// query from dominating a short precise one — a better ranking for short natural-language
// questions. Each score is normalized by the query's ideal self-match, so it lands in
// ~[0,1] (1.0 = an identical past query) and the similarity thresholds below stay
// meaningful. The quality filter is applied at query time (ratings don't affect the score,
// only which records count as positive/negative examples), so the index needn't rebuild on
// a rating change — only when the record count changes.

const outcomes = require('./outcomes');
const { tokenize } = require('./retrieval/keywords');

// Single-sourced as data in lib/ai/data/lexicon.json (similarityStopwords) via the shared lexicon loader.
const { SIMILARITY_STOPWORDS: STOPWORDS } = require('./retrieval/lexicon');

const toTerms = (text) => tokenize(String(text || ''))
  .filter(t => t.length >= 2 && !STOPWORDS.has(t));

// ── BM25 scoring ─────────────────────────────────────────────────────────────
// Standard Okapi parameters. The idf uses the Lucene/BM25+ form (log(1 + …)) so it is
// always non-negative — plain BM25 idf can go negative for a term present in most of a
// tiny corpus, which would perversely penalise a shared term.
const K1 = 1.2, B = 0.75;
const bm25Idf = (df, count) => Math.log(1 + (count - df + 0.5) / (df + 0.5));
const bm25Tf  = (tf, len, avgdl) => (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (len / (avgdl || 1))));
// Sum BM25 term contributions over the query's terms (each weighted by its query freq).
const bm25Score = (qTerms, doc, df, count, avgdl) => {
  let s = 0;
  for (const [t, qtf] of qTerms) {
    const dtf = doc.terms.get(t);
    if (dtf) s += qtf * bm25Idf(df.get(t) || 0, count) * bm25Tf(dtf, doc.len, avgdl);
  }
  return s;
};

// ── Per-workspace lazy index ─────────────────────────────────────────────────
// index: { count, avgdl, df: Map<term,docCount>, docs: [{ id, terms: Map<term,tf>, len,
//          docIds, rating }] }. Rebuilt when the outcome record count changes.
const _index = new Map();   // cacheDir → index

const buildIndex = (cacheDir) => {
  const records = outcomes.all(cacheDir);
  const df = new Map();
  let totalLen = 0;
  const docs = records.map(r => {
    const terms = new Map();
    for (const t of toTerms(r.query)) terms.set(t, (terms.get(t) || 0) + 1);
    for (const t of terms.keys()) df.set(t, (df.get(t) || 0) + 1);
    let len = 0; for (const tf of terms.values()) len += tf;
    totalLen += len;
    return { id: r.id, terms, len, docIds: r.docIds || [], rating: r.rating ?? null };
  });
  const count = docs.length;
  return { count, avgdl: count ? totalLen / count : 1, df, docs };
};

// Resolve the cache dir to a stable key. The socket read paths call in with `undefined`
// (meaning "the active workspace"), while invalidate() is called with the resolved
// CACHE_DIR — so the Map must be keyed by the resolved path in BOTH, or invalidate never
// matches the cached entry (a rating change would then not take effect until a new outcome
// is recorded) and two workspaces with equal record counts could share a stale index.
const keyFor = (cacheDir) => cacheDir || require('./config').CACHE_DIR;

const getIndex = (cacheDir) => {
  const dir = keyFor(cacheDir);
  // Check validity against the record COUNT only — outcomes.count avoids the full-array copy outcomes.all
  // would make on every query (this runs on the answer hot path when down-weighting is active).
  const cached = _index.get(dir);
  if (cached && cached.count === outcomes.count(dir)) return cached;
  const idx = buildIndex(dir);   // only here (a rebuild) do we actually read the records
  _index.set(dir, idx);
  return idx;
};

// ── Public: find similar past queries ────────────────────────────────────────
// Returns [{ id, score, docIds, rating }] sorted by score desc, above minScore.
// includeDown=false drops 👎-rated records (they're not positive examples).
const findSimilar = (cacheDir, query, { topK = 5, minScore = 0.12, includeDown = true } = {}) => {
  const idx = getIndex(cacheDir);
  if (idx.count === 0) return [];
  const qTerms = new Map();
  let qLen = 0;
  for (const t of toTerms(query)) { qTerms.set(t, (qTerms.get(t) || 0) + 1); qLen++; }
  if (qTerms.size === 0) return [];
  // Ideal = the query scored against a document identical to itself; dividing by it puts an
  // identical past query at 1.0 and everything else below, so the thresholds stay meaningful.
  let ideal = 0;
  for (const [t, qtf] of qTerms) ideal += qtf * bm25Idf(idx.df.get(t) || 0, idx.count) * bm25Tf(qtf, qLen, idx.avgdl);
  ideal = ideal || 1;

  const scored = [];
  for (const doc of idx.docs) {
    if (!includeDown && doc.rating === -1) continue;
    const score = bm25Score(qTerms, doc, idx.df, idx.count, idx.avgdl) / ideal;
    if (score >= minScore) scored.push({ id: doc.id, score, docIds: doc.docIds, rating: doc.rating });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
};

// The single best-matching PAST query that was rated 👍, for "you asked something
// similar before" surfacing. Returns { id, score, docIds } or null.
const bestRatedUpMatch = (cacheDir, query, { minScore = 0.25 } = {}) => {
  // Only 👍-rated past queries qualify, so exclude 👎 records from the candidate set rather
  // than fetching them and filtering after.
  const hits = findSimilar(cacheDir, query, { topK: 10, minScore, includeDown: false });
  const up = hits.find(h => h.rating === 1);
  return up || null;
};

// Documents that led to 👎 answers on queries SIMILAR to this one. Returns a
// Map<docId, penaltyWeight> where weight scales with how similar+how down-rated.
// Only considers records rated -1, and only above a similarity floor, so an
// unrelated bad answer never penalizes an unrelated document.
const downweightDocs = (cacheDir, query, { minScore = 0.30 } = {}) => {
  const hits = findSimilar(cacheDir, query, { topK: 20, minScore, includeDown: true });
  const penalties = new Map();
  for (const h of hits) {
    if (h.rating !== -1) continue;
    for (const docId of h.docIds) {
      // Penalty proportional to similarity — a closely-matching bad outcome counts
      // more than a loosely-matching one. Accumulate across multiple bad matches.
      penalties.set(docId, (penalties.get(docId) || 0) + h.score);
    }
  }
  return penalties;
};

// Drop cached index for a workspace (e.g. after a rating changes an example's class,
// though scores are rating-independent — mainly for tests/consistency).
const invalidate = (cacheDir) => { _index.delete(keyFor(cacheDir)); };

module.exports = { bestRatedUpMatch, downweightDocs, invalidate };
