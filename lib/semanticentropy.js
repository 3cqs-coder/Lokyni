'use strict';
// Semantic entropy — a self-consistency check for answer stability. It asks the model the SAME question a few
// times and clusters the replies by MEANING (embedding cosine, not string match). When the replies scatter —
// the model can't reproduce one answer — that is a confabulation signal grounding and numeric checks cannot
// catch, so confidence is lowered (and, with thin-evidence abstention on, the answer leads with a caveat).
//
// Language-agnostic: clustering is by embedding similarity, and the default bge-m3 embeddings are multilingual,
// so this works for an answer in any language with no per-language logic.
//
// Opt-in and OFF by default (one extra generation per sample is a real latency/compute cost on a local model).
// It is also post-hoc and fully fail-open: fewer than two samples, no embedder, or any error → null (no signal,
// no penalty, never blocks or throws). Dependency-injected (generate + embed are passed in) so it is unit-
// testable without a model and stays decoupled from the provider plumbing.

const { unitNormalize } = require('./embeddings');

const cosine = (a, b) => {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;   // inputs are unit-normalized, so the dot product IS the cosine
};

// Greedily cluster texts by meaning: each text joins the first cluster whose representative it is near enough
// to (cosine >= threshold), else it starts a new cluster. O(n·clusters) — n is tiny (a handful of samples).
const clusterByMeaning = (vectors, threshold) => {
  const clusters = [];   // each: { rep: vector, members: [index...] }
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i];
    let placed = false;
    for (const c of clusters) {
      if (cosine(v, c.rep) >= threshold) { c.members.push(i); placed = true; break; }
    }
    if (!placed) clusters.push({ rep: v, members: [i] });
  }
  return clusters;
};

// Run the self-consistency pass. Returns { agreement, unstable, samples, representativeIndex } or null.
//   generate()      -> Promise<string>  : produce one answer sample (at a non-zero temperature)
//   embed(text)     -> Promise<number[]>: embed a sample (any length; normalized here)
//   samples         : total replies to compare (>= 2 to mean anything; 1 or less -> null)
//   agreementFloor  : fraction of replies that must share the majority meaning to be "stable" (e.g. 0.6)
//   clusterThreshold: cosine at/above which two replies count as the same meaning (e.g. 0.88)
//   timeoutMs       : hard cap for the whole pass; on timeout -> null (no signal)
const assess = async ({ generate, embed, samples = 3, agreementFloor = 0.6, clusterThreshold = 0.88, timeoutMs = 30000 } = {}) => {
  try {
    const n = Math.floor(Number(samples) || 0);
    if (n < 2 || typeof generate !== 'function' || typeof embed !== 'function') return null;

    const work = (async () => {
      const texts = [];
      for (let i = 0; i < n; i++) {
        const t = await generate();
        if (typeof t === 'string' && t.trim()) texts.push(t.trim());
      }
      if (texts.length < 2) return null;   // not enough usable samples to compare

      const vectors = [];
      for (const t of texts) {
        const raw = await embed(t);
        if (Array.isArray(raw) && raw.length) vectors.push(unitNormalize(raw));
      }
      if (vectors.length < 2) return null;   // embedder unavailable → no signal

      const clusters = clusterByMeaning(vectors, clusterThreshold);
      const largest = clusters.reduce((a, c) => (c.members.length > a.members.length ? c : a), clusters[0]);
      const agreement = largest.members.length / vectors.length;
      return {
        agreement,
        unstable: agreement < agreementFloor,
        samples: vectors.length,
        representativeIndex: largest.members[0],   // a sample from the majority-meaning cluster
      };
    })();

    // Fail-open on timeout: resolve to null rather than hang the (already-streamed) answer's meta.
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), Math.max(1000, timeoutMs)); });
    if (timer && typeof timer.unref === 'function') timer.unref();
    const result = await Promise.race([work, timeout]);
    clearTimeout(timer);
    return result;
  } catch {
    return null;   // never throws — it is a best-effort confidence signal
  }
};

module.exports = { assess, clusterByMeaning };
