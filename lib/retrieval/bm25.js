'use strict';
const BM25 = require('wink-bm25-text-search');
const { DEBUG } = require('../config');
const state = require('../state');
const { buildIdf, tokenize } = require('./keywords');
const { INDEX_HEAD_CHARS } = require('./constants');

// Build the BM25 index for a corpus. Async and cooperative: the per-document tokenization loop yields
// the event loop every YIELD_EVERY documents so building a large workspace's index — at boot, during a
// delta, or on the first query to a non-active workspace — never stalls other connections for the whole
// build. The engine is built into a local instance and only assigned onto the live index by the caller
// after this resolves, so a mid-build yield never exposes a half-built index; the previous index stays
// live until the swap. (wink-bm25's consolidate step is a single atomic call and cannot be subdivided.)
const YIELD_EVERY = 500;
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));
const buildBM25Index = async (pMap, pinnedMedian = null, target = state) => {
  // Compute the IDF table into a LOCAL, not straight onto `target`. For the active workspace `target`
  // is the live global state, and this build now yields the event loop mid-way — so assigning corpusIdf
  // here would let a query that runs during a yield see the NEW corpusIdf paired with the OLD BM25
  // engine (the caller swaps liveBM25 only after this resolves). corpusIdf is published onto `target`
  // only in the final synchronous run before each return, so it swaps together with the caller's
  // liveBM25 assignment (no await between them) and a query never observes a mismatched pair.
  const idf = await buildIdf(pMap);
  if (DEBUG) console.log(`✅ TF-IDF built — ${idf.size} unique terms`);

  const engine = BM25();
  engine.defineConfig({ fldWeights: { text: 1 } });
  // Tokenize documents and queries with the one shared Unicode-aware tokenizer (accented Latin kept whole,
  // non-Latin words indexed, CJK as bigrams), so the postings and the query terms always agree. A single
  // prep task returning the token array replaces the old inline ASCII-only chain.
  engine.definePrepTasks([(s) => tokenize(s)]);

  const idToDocId = new Map();
  let numId = 0;
  for (const [docId, { content }] of pMap) {
    idToDocId.set(numId, docId);
    engine.addDoc({ text: content.slice(0, INDEX_HEAD_CHARS) }, numId);
    numId++;
    if (numId % YIELD_EVERY === 0) await yieldToLoop();   // keep the event loop responsive on a big corpus
  }

  // wink-bm25 refuses to consolidate a very small collection ("document collection
  // is too small for consolidation"). That's a legitimate state — an empty or
  // nearly-empty workspace — not an error, so return a stub the rest of the pipeline
  // can query safely instead of letting the throw abort the whole index run.
  // The count is guarded AND the call is wrapped, because the library's exact
  // minimum is an internal detail that could change.
  if (numId === 0) {
    if (DEBUG) console.log('  ℹ️  No documents — BM25 index skipped');
    target.corpusIdf = idf;
    return { engine: null, idToDocId, medianScore: pinnedMedian ?? 3.0, empty: true };
  }
  try {
    engine.consolidate();
  } catch (e) {
    if (DEBUG) console.log(`  ℹ️  BM25 consolidation skipped (${numId} doc(s)): ${e.message}`);
    target.corpusIdf = idf;
    return { engine: null, idToDocId, medianScore: pinnedMedian ?? 3.0, empty: true };
  }

  let medianScore = pinnedMedian ?? 3.0;
  if (pinnedMedian == null) {
    try {
      // Estimate the corpus's typical top-1 BM25 score from a sample of mid-IDF terms; the median drives
      // the topic-shift and out-of-scope gates downstream. Sample the mid-IDF band EVENLY (sorted by IDF,
      // then strided) rather than taking the alphabetically-first terms — an alphabetical slice biases the
      // estimate toward whatever the corpus's early-alphabet terms happen to score, which is not
      // representative and can make the gates misfire. Deterministic (no per-boot variance) and covers
      // the whole band.
      const midIdf = [...idf.entries()]
        .filter(([, v]) => v > 1.5 && v < 3.5)
        .sort((a, b) => a[1] - b[1]);
      const SAMPLE_MAX = 60;
      let sampleTerms;
      if (midIdf.length <= SAMPLE_MAX) {
        sampleTerms = midIdf.map(([t]) => t);
      } else {
        const stride = midIdf.length / SAMPLE_MAX;
        sampleTerms = [];
        for (let i = 0; i < SAMPLE_MAX; i++) sampleTerms.push(midIdf[Math.floor(i * stride)][0]);
      }
      const scores = sampleTerms.flatMap(t => {
        const r = engine.search(t, 1);
        return r.length > 0 ? [r[0][1]] : [];
      }).sort((a, b) => a - b);
      if (scores.length > 0) medianScore = scores[Math.floor(scores.length / 2)];
    } catch {}
  }

  if (DEBUG) console.log(
    `  BM25 median score: ${medianScore.toFixed(2)} ` +
    `(topic-shift threshold: ${(medianScore * 2).toFixed(2)})` +
    `${pinnedMedian != null ? ' [pinned]' : ' [computed]'}`
  );

  // Publish the IDF table now, in the same synchronous run as this return — the caller assigns liveBM25
  // from the resolved value with no await in between, so corpusIdf and liveBM25 swap as one to any query.
  target.corpusIdf = idf;
  return { engine, idToDocId, medianScore };
};

// The text index (BM25 + IDF) depends only on a document's id and text, not on its vectors. During an
// embedding-bank consolidation every document is re-parsed and re-embedded in bounded batches while its text
// stays the same, so rebuilding this index for the whole corpus in every batch is wasted work. Compare by
// value rather than identity because a re-parse creates a new string for the same bytes. The full text is
// compared (not just the indexed head), which is stricter than BM25 needs: a tail-only edit rebuilds, which
// is the safe direction and edits are rare. Pure, synchronous, and O(documents).
const sameTextCorpus = (a, b) => {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const [docId, doc] of a) {
    const other = b.get(docId);
    if (!other || (doc && doc.content) !== (other && other.content)) return false;
  }
  return true;
};

// Build the BM25 index, or keep the previous one when every document's text is unchanged. `previous` is
// `{ bm25, idf, map }` from the live index. The previous engine is immutable after consolidate, so returning
// it is safe; the caller swaps it together with the other index fields in one synchronous step. A previous
// index without an engine (an empty or too-small corpus) is rebuilt, which is cheap.
const buildOrReuseBM25Index = async (pMap, pinnedMedian = null, target = state, previous = null) => {
  if (previous && previous.bm25 && previous.bm25.engine && previous.idf &&
      previous.map && sameTextCorpus(pMap, previous.map)) {
    target.corpusIdf = previous.idf;
    if (DEBUG) console.log(`  ♻️  BM25 reused — ${pMap.size} document(s) unchanged`);
    return previous.bm25;
  }
  return buildBM25Index(pMap, pinnedMedian, target);
};

module.exports = { buildBM25Index, buildOrReuseBM25Index, sameTextCorpus };
