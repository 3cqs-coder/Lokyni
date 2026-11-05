'use strict';
// Query complexity assessment for adaptive retrieval routing.
//
// A cheap, deterministic (no-LLM) read of how involved a question is, used to route the
// expensive retrieval augmentations. A short factual lookup ("who wrote the report?") gains
// little from expanding into several phrasings and searching each, whereas a broad or
// multi-part question ("compare the Q2 and Q3 findings and their causes") benefits from the
// wider recall. When adaptive routing is on, search.js runs RAG-Fusion only for queries this
// module rates "complex", saving the extra model call and vector searches on simple ones.
//
// Pure text heuristics, so it adds no latency and works on the very first query (before any
// conversation exists for the intent classifier to read). Conservative by design: a query is
// "simple" unless a clear complexity signal is present, so the cheap path is the default.

// Multi-part / comparative cues — a strong signal on their own.
const COMPARE_RE = /\b(compare|compared|comparison|versus|vs\.?|difference(s)? between|differ|contrast|pros and cons|trade[- ]?offs?|relationship between|correlat)\b/i;
// "How/why/analyze/summarize across…" style asks that usually span material.
const ANALYTIC_RE = /\b(analy[sz]e|synthesi[sz]e|evaluate|assess|implications?|explain why|walk me through|step by step|comprehensive|in depth|in-depth|across (all|the|these|every))\b/i;

// Count how many separate clauses a conjunction joins, ignoring trivial noun pairs.
const conjunctionClauses = (q) => (q.match(/\b(and|or)\b/gi) || []).length;

// Rough count of distinct named entities mentioned mid-sentence — a proxy for a cross-entity
// question. A RUN of consecutive capitalized words counts as ONE entity, so a person's full
// name ("Matilda MacElroy") or a multi-word title ("Acme Corp") is a single entity rather
// than several. The first word is ignored (it is always capitalized at the start of a
// sentence), so a leading question word does not inflate the count.
const namedEntities = (q) => {
  const words = q.split(/\s+/);
  let groups = 0, inRun = false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i].replace(/[^A-Za-z0-9]/g, '');
    const isCap = w.length > 1 && /^[A-Z][a-z]/.test(w);
    if (isCap && !inRun) groups++;   // start of a new capitalized run
    inRun = isCap;
  }
  return groups;
};

// Assess a query. Returns { level: 'simple' | 'complex', reasons: [<string>] }.
const assessComplexity = (query) => {
  const q = String(query || '').trim();
  const reasons = [];
  if (!q) return { level: 'simple', reasons };

  const wordCount = q.split(/\s+/).filter(Boolean).length;
  const questionMarks = (q.match(/[?？]/g) || []).length;   // Latin '?' and the full-width '？' (CJK)
  // Word count misreads a space-free script (Chinese, Japanese, Korean) — which carries a whole question
  // in one "word" — as trivially short, so such a query would always take the cheap path no matter how
  // involved it is. Count CJK/kana/Hangul characters as a language-agnostic length signal alongside the
  // word count, so a long question routes to the wider-recall path in any language.
  const cjkChars = (q.match(/[㐀-鿿぀-ヿ가-힯豈-﫿]/g) || []).length;

  if (COMPARE_RE.test(q))  reasons.push('comparative');
  if (ANALYTIC_RE.test(q)) reasons.push('analytic');
  if (questionMarks >= 2)  reasons.push('multiple-questions');
  // A conjunction only signals complexity in a reasonably long question — "cats and dogs"
  // should not qualify, but "the causes and the effects and who was responsible" should.
  if (conjunctionClauses(q) >= 1 && wordCount >= 12) reasons.push('multi-clause');
  if (conjunctionClauses(q) >= 2) reasons.push('multi-clause');
  if (namedEntities(q) >= 2) reasons.push('multi-entity');
  // "Long" in a space-separated script (>= 18 words) OR a long space-free CJK question (>= 24 CJK chars).
  if (wordCount >= 18 || cjkChars >= 24) reasons.push('long');

  return { level: reasons.length > 0 ? 'complex' : 'simple', reasons };
};

module.exports = { assessComplexity };
