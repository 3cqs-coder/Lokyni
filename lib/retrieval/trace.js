'use strict';
// Retrieval trace — a structured record of why an answer used the documents it did.
//
// The pipeline already makes a series of consequential decisions: rewriting the
// query, classifying intent, gating on BM25 strength, detecting a topic shift,
// reranking, dropping candidates below a threshold. All of that was computed and
// then thrown away except for console lines under DEBUG.
//
// That matters because the most common complaint about tools in this category is
// not missing features — it's that when an answer ignores a document the failure
// feels arbitrary. A user can see which sources were cited; they cannot see which
// documents were considered and rejected, or why. This module keeps that record so
// the UI can show it.
//
// Design constraints:
//
//   * Never change retrieval behavior. The trace is write-only from the pipeline's
//     perspective — nothing reads it back to make a decision.
//   * Cost nothing when unused. Recording is a few array pushes per query; no
//     scoring is repeated and no extra model calls are made.
//   * Survive being absent. Every call site uses optional chaining so a missing
//     trace can't break a query.

const MAX_CANDIDATES = 40;   // plenty for a "why" panel; keeps the payload small

class Trace {
  constructor(query) {
    this.query = query;
    this.startedAt = Date.now();
    this.steps = [];         // ordered decisions
    this.candidates = [];    // documents considered, with scores and outcome
    this.finalIds = [];      // what actually reached the model
  }

  // Record a decision. `detail` is shown verbatim, so it should read as an
  // explanation rather than an internal label.
  step(kind, detail, data = null) {
    this.steps.push({ kind, detail, ...(data ? { data } : {}) });
  }

  // Record a document that was considered. Called for every candidate, including
  // ones later dropped — the dropped ones are the interesting half.
  candidate(id, name, scores = {}) {
    if (this.candidates.length >= MAX_CANDIDATES) return;
    const existing = this.candidates.find(c => c.id === id);
    if (existing) { Object.assign(existing, scores); return; }
    this.candidates.push({ id, name, ...scores, used: false, dropped: null });
  }

  // Mark why a candidate didn't make it.
  drop(id, reason) {
    const c = this.candidates.find(x => x.id === id);
    if (c) c.dropped = reason;
  }

  // Mark the documents that were actually sent to the model.
  used(ids) {
    this.finalIds = ids;
    for (const c of this.candidates) if (ids.includes(c.id)) { c.used = true; c.dropped = null; }
  }

  // Serialize for the client. Sorted so the most relevant candidates lead, and
  // rounded because three decimal places of a cosine score is noise to a reader.
  toJSON() {
    const round = (n) => (typeof n === 'number' ? Math.round(n * 1000) / 1000 : n);
    return {
      query: this.query,
      elapsedMs: Date.now() - this.startedAt,
      steps: this.steps,
      candidates: this.candidates
        .map(c => ({
          ...c,
          rerank: round(c.rerank),
          cosine: round(c.cosine),
          bm25: round(c.bm25),
        }))
        .sort((a, b) => {
          if (a.used !== b.used) return a.used ? -1 : 1;
          return (b.rerank ?? b.cosine ?? b.bm25 ?? 0) - (a.rerank ?? a.cosine ?? a.bm25 ?? 0);
        }),
      usedCount: this.finalIds.length,
    };
  }
}

const newTrace = (query) => new Trace(query);

// A do-nothing trace with the exact same surface as Trace, returned when the user
// has the "Explain this answer" toggle off. Every recording method is a no-op and
// toJSON() returns undefined, so the pipeline's trace.* calls cost nothing and no
// retrieval_trace is emitted. `candidates` stays an (always empty) array because
// search.js iterates it directly. This keeps the call sites free of `trace &&`
// guards — the object is always present, it just doesn't record.
const NOOP_TRACE = {
  candidates: [],
  finalIds: [],
  steps: [],
  step() {},
  candidate() {},
  drop() {},
  used() {},
  toJSON() { return undefined; },
};
const newNoopTrace = () => NOOP_TRACE;

module.exports = { newTrace, newNoopTrace, Trace };
