'use strict';
// RAG-Fusion — the query-expansion half of multi-query retrieval.
//
// When useRagFusion is on, search.js calls this to expand a query into a few alternative
// phrasings. The caller runs a dense search for each, then fuses the candidate lists with
// reciprocal rank fusion (see fuseDenseLists in ./rrf), widening recall: a passage the
// user's exact wording missed but a paraphrase finds is surfaced for the reranker.
//
// Deliberately small and safe: one bounded LLM call, returning [] on any failure (timeout,
// unparseable, or nothing usefully different) so the caller simply proceeds with the single
// original query. Only invoked on a fresh, non-focus, non-attachment query.

const { completeChat } = require('../llm');
const { withTimeout } = require('../llm-json');

const TIMEOUT_MS = require('./constants').AUX_LLM_TIMEOUT_MS;
const MAX_VARIANT_LEN = 200;

const SYSTEM =
  'You expand a search query into alternative phrasings for a document search engine. ' +
  'Each phrasing should capture the same information need using different words — synonyms, ' +
  'a more specific angle, or a related sub-question. Output ONLY the phrasings, one per line, ' +
  'with no numbering, bullets, quotes, or preamble.';

const buildUser = (query, n) =>
  `Write ${n} alternative search phrasings for this question. ` +
  `Keep each on one line and under twenty words. Do not answer the question.\n\n` +
  `Question: ${query}`;

// Clean a raw multi-line response into distinct variants, excluding a restatement of the
// original query and any duplicates. Exported for unit testing.
const parseVariants = (raw, original, max) => {
  if (!raw) return [];
  const origNorm = String(original || '').trim().toLowerCase();
  const seen = new Set([origNorm]);
  const out = [];
  for (let line of String(raw).split('\n')) {
    line = line.trim()
      .replace(/^[-*•\d.)\s]+/, '')   // strip a leading bullet or "1." / "1)" marker
      .replace(/^["'`]|["'`]$/g, '')  // strip surrounding quotes
      .trim();
    if (!line) continue;
    if (line.length > MAX_VARIANT_LEN) line = line.slice(0, MAX_VARIANT_LEN).trimEnd();
    const norm = line.toLowerCase();
    if (norm.length < 3 || seen.has(norm)) continue;
    seen.add(norm);
    out.push(line);
    if (out.length >= max) break;
  }
  return out;
};

// Generate up to `count` alternative phrasings of `query`. Returns [] on any failure.
const expandQueries = async (query, count = 3, opts = {}) => {
  const n = Math.max(1, Math.min(6, count | 0));
  try {
    const callOpts = { temperature: 0.4, maxTokens: 40 + n * 24, timeoutMs: TIMEOUT_MS };
    if (opts.model) callOpts.model = opts.model;
    const raw = await withTimeout(completeChat(
      [{ role: 'system', content: SYSTEM }, { role: 'user', content: buildUser(query, n) }],
      callOpts,
    ), TIMEOUT_MS, 'rag-fusion expand');
    return parseVariants(raw, query, n);
  } catch { return []; }
};

module.exports = { expandQueries, parseVariants };
