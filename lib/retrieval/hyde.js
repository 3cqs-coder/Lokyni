'use strict';
// HyDE — Hypothetical Document Embeddings.
//
// When useHyde is on, search.js calls this to draft a short hypothetical passage that WOULD
// answer the question. The caller embeds that passage and uses it as an extra dense query,
// then fuses its results with the others (see fuseDenseLists in ./rrf). The draft sits in
// "answer space" — phrased like the documents rather than like a question — so it surfaces
// passages a bare question vector can miss.
//
// The draft is ONLY ever a retrieval probe: it is never shown to the user and never used as
// an answer, so an inaccurate hypothetical cannot introduce fabrication. Deliberately small
// and safe: one bounded LLM call, returning null on any failure so the caller proceeds with
// the query it already has.

const { completeChat } = require('../llm');
const { withTimeout } = require('../llm-json');

const TIMEOUT_MS = require('./constants').AUX_LLM_TIMEOUT_MS;
const MAX_CHARS   = 1200;   // a probe, not a document — cap what we embed

const SYSTEM =
  'You write a brief, plausible passage that could appear in a document answering the ' +
  "user's question. Write it as a factual excerpt, not as a reply to a person: no preamble, " +
  'no hedging, no "I". Two or three sentences. It is used only to search a document ' +
  'collection, so realistic terminology matters more than correctness.';

const buildUser = (query) => `Question: ${query}\n\nWrite the hypothetical passage:`;

// Draft a hypothetical answer passage for `query`. Returns the passage string, or null on
// failure or an empty/refusal-shaped result.
const hypotheticalDoc = async (query, opts = {}) => {
  try {
    const callOpts = { temperature: 0.3, maxTokens: opts.maxTokens || 200, timeoutMs: TIMEOUT_MS };
    if (opts.model) callOpts.model = opts.model;
    const raw = await withTimeout(completeChat(
      [{ role: 'system', content: SYSTEM }, { role: 'user', content: buildUser(query) }],
      callOpts,
    ), TIMEOUT_MS, 'hyde');
    let out = String(raw || '').trim();
    // Drop a model that refused or produced nothing usable.
    if (out.length < 20) return null;
    if (/^(as an ai|i can'?t|i'm unable|sorry|i cannot)/i.test(out)) return null;
    if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS).trimEnd();
    return out;
  } catch { return null; }
};

module.exports = { hypotheticalDoc };
