'use strict';
// Reference-free RAG quality metrics — the kind a standard evaluation suite reports, computed entirely
// with the local model and embeddings over the user's own documents, so nothing leaves the machine and
// no hand-labeled "correct answers" are needed. Four metrics, each 0..1 (higher is better):
//
//   • faithfulness      — the fraction of the answer's claims the cited sources actually support
//                         (reuses the existing faithfulness judge). Catches confident-but-unsupported text.
//   • answerRelevancy   — how on-topic the answer is for the question (cosine of their embeddings).
//                         Catches an answer that wanders off or dodges the question.
//   • contextPrecision  — the fraction of the retrieved passages that are actually relevant to the
//                         question (a bounded, language-agnostic boolean judge per passage). Measures
//                         retrieval's signal-to-noise.
//   • citationAttribution — a deterministic F1 over whether each citation does real work: the share of
//                           answer sentences traceable to a cited source (precision) and the share of
//                           cited sources that support at least one sentence (recall). Catches a padded
//                           citation list and sentences with no support.
//
// The aggregation and delta math are pure and unit-tested. The metric functions reuse existing
// bounded helpers and are best-effort: any failure returns null (the metric is reported as "n/a" and
// left out of the average) so evaluation can never throw into or block anything, and never runs on the
// answer hot path (it is an explicit, on-demand batch).

const METRIC_KEYS = Object.freeze(['faithfulness', 'answerRelevancy', 'contextPrecision', 'citationAttribution']);
// Display labels live with the metric definitions, so the dashboard, the CLI, and any future surface read one
// list instead of keeping parallel copies that can drift when a metric is added.
const METRIC_LABELS = Object.freeze({
  faithfulness: 'Faithfulness',
  answerRelevancy: 'Answer relevancy',
  contextPrecision: 'Context precision',
  citationAttribution: 'Citation attribution F1',
});
// Which direction is better for each metric, kept beside the labels so a new metric cannot be added without
// stating it (the A/B comparison uses this to mark the stronger run). All four current metrics are 0..1 with
// higher better; an explicit map leaves room for a cost- or latency-style metric later.
const METRIC_HIGHER_IS_BETTER = Object.freeze({
  faithfulness: true,
  answerRelevancy: true,
  contextPrecision: true,
  citationAttribution: true,
});

// Faithfulness as a ratio from the existing judge's counts: supported / graded-claims. A claim graded
// "partial" counts as half. Returns null when the judge had nothing to grade (web answer, no claims).
const faithfulnessFromCounts = (counts) => {
  if (!counts) return null;
  const total = (counts.supported || 0) + (counts.partial || 0) + (counts.unsupported || 0);
  if (total === 0) return null;
  return ((counts.supported || 0) + 0.5 * (counts.partial || 0)) / total;
};

// Cosine similarity of two equal-length vectors, clamped to 0..1 (embeddings can dip slightly
// negative for unrelated text; a negative "relevancy" is not meaningful, so floor at 0).
const cosine = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return null;
  return Math.max(0, Math.min(1, dot / (Math.sqrt(na) * Math.sqrt(nb))));
};

// Average the numeric (non-null) values of each metric across a list of per-question metric objects.
// A metric that was n/a for every question is omitted. Pure.
const aggregate = (perQuestion) => {
  const out = {};
  for (const key of METRIC_KEYS) {
    let sum = 0, n = 0;
    for (const q of perQuestion || []) {
      const v = q && q.metrics && q.metrics[key];
      if (typeof v === 'number' && !Number.isNaN(v)) { sum += v; n += 1; }
    }
    if (n > 0) out[key] = sum / n;
  }
  return out;
};

// Per-metric change from a previous averages object to the current one (current − previous). Only
// metrics present in BOTH are included, so a first run (no previous) yields an empty delta. Pure.
const deltaVs = (previousAverages, currentAverages) => {
  const out = {};
  if (!previousAverages || !currentAverages) return out;
  for (const key of METRIC_KEYS) {
    if (typeof previousAverages[key] === 'number' && typeof currentAverages[key] === 'number') {
      out[key] = currentAverages[key] - previousAverages[key];
    }
  }
  return out;
};

// Compare two averages objects for the A/B view. `delta` is B − A. A change under `tolerance` is treated as
// a tie so a meaningless rounding difference is not presented as a win. A metric missing from either side is
// reported as n/a with no winner. Pure.
const compareAverages = (a, b, tolerance = 0.005) => {
  const rows = [];
  for (const key of METRIC_KEYS) {
    const av = a && typeof a[key] === 'number' && !Number.isNaN(a[key]) ? a[key] : null;
    const bv = b && typeof b[key] === 'number' && !Number.isNaN(b[key]) ? b[key] : null;
    const delta = (av != null && bv != null) ? bv - av : null;
    let winner = null;
    if (delta != null && Math.abs(delta) >= tolerance) {
      const higher = METRIC_HIGHER_IS_BETTER[key] !== false;
      winner = ((delta > 0) === higher) ? 'b' : 'a';
    }
    rows.push({ key, a: av, b: bv, delta, winner });
  }
  return rows;
};

// ── Model-backed metric functions (best-effort; null on any failure) ──

// Faithfulness for one answer against its cited sources, via the existing judge.
const faithfulness = async (answer, sources, idx, question) => {
  try {
    const r = await require('./faithfulness').scoreAnswer(answer, sources, idx, question);
    return faithfulnessFromCounts(r && r.counts);
  } catch { return null; }
};

// Answer relevancy: cosine between the question's and the answer's embeddings.
const answerRelevancy = async (question, answer) => {
  try {
    if (!question || !answer) return null;
    const embeddings = require('./embeddings').makeEmbeddings();
    const { embedBounded } = require('./embeddings');
    const [qv, av] = await Promise.all([
      embedBounded(embeddings.embedQuery(question)),
      embedBounded(embeddings.embedQuery(answer.slice(0, 4000))),
    ]);
    return cosine(qv, av);
  } catch { return null; }
};

// Context precision: the fraction of retrieved passages a bounded yes/no judge rates relevant to the
// question. Judges at most `cap` passages (cost control) with the auxiliary-LLM timeout; a passage the
// judge errors on is skipped, and if none could be judged the metric is n/a (null).
const RELEVANCE_SCHEMA = { type: 'object', properties: { relevant: { type: 'boolean' } }, required: ['relevant'], additionalProperties: false };

const contextPrecision = async (question, sources, idx, cap = 6) => {
  try {
    const bundle = idx || require('./state');
    const list = (sources || []).slice(0, cap);
    if (list.length === 0) return null;
    const { completeJson } = require('./llm');
    const { withTimeout } = require('./llm-json');
    const cfg = require('./config');
    const timeoutMs = cfg.AUX_LLM_TIMEOUT_MS || 12000;
    let relevant = 0, judged = 0;
    for (const s of list) {
      const entry = bundle.parentMap && bundle.parentMap.get(s.id);
      const passage = (entry && entry.content ? entry.content : (s.text || s.snippet || '')).slice(0, 1500);
      if (!passage.trim()) continue;
      try {
        // Language-agnostic judge: ask for a BOOLEAN via the shared structured-output path (completeJson),
        // not an English "yes"/"no" string. A boolean verdict is the same in any language, so the metric works
        // for a non-English corpus and any model; completeJson falls back to prose + extractJson on a provider
        // that ignores json-mode, so it stays provider-agnostic. A reply without a clean boolean is SKIPPED
        // (not scored "irrelevant"), so an unparseable judgment never biases precision downward.
        const obj = await withTimeout(completeJson(
          [{ role: 'system', content: 'You judge whether a passage is relevant to a question. Reply with ONLY a JSON object: {"relevant": true} or {"relevant": false}.' },
           { role: 'user', content: `Question: ${question}\n\nPassage:\n${passage}\n\nIs this passage relevant to the question?` }],
          { temperature: 0, maxTokens: 20, schema: RELEVANCE_SCHEMA, schemaName: 'relevance', timeoutMs },
        ), timeoutMs, 'eval-context');
        if (obj && typeof obj.relevant === 'boolean') { judged += 1; if (obj.relevant) relevant += 1; }
      } catch { /* skip a passage the judge couldn't grade */ }
    }
    return judged === 0 ? null : relevant / judged;
  } catch { return null; }
};

// Citation attribution as one number: the F1 of sentence coverage and citation usage. Deterministic (no model
// call) and bounded; null when there is nothing to attribute (a web answer, or no resolvable served text).
const citationAttribution = (answer, sources, idx) => {
  try {
    const r = require('./attribution').attribute(answer, sources, idx);
    return r ? r.f1 : null;
  } catch { return null; }
};

module.exports = {
  METRIC_KEYS, METRIC_LABELS, METRIC_HIGHER_IS_BETTER, faithfulnessFromCounts, cosine, aggregate, deltaVs, compareAverages,
  faithfulness, answerRelevancy, contextPrecision, citationAttribution,
};
