'use strict';
// Corrective retrieval — the query-reformulation half of the CRAG-style recover-gate.
//
// When the corpus matches a query only weakly (something came back, but not a confident
// match), search.js calls this to rephrase the query once. The caller then retrieves again
// with the rephrasing and merges the results, giving the reranker a second, differently-
// worded shot at the right passage before it answers from a mediocre one.
//
// Deliberately small and safe: one bounded LLM call, and it returns null on any failure
// (timeout, unparseable, or a rephrasing identical to the original) so the caller simply
// proceeds with the results it already has. Only invoked when useCorrectiveRetrieval is on
// AND the match was weak, so it never touches the confident-answer path.

const { completeChat } = require('../llm');
const { withTimeout } = require('../llm-json');

const TIMEOUT_MS = require('./constants').AUX_LLM_TIMEOUT_MS;
const SYSTEM = 'You reformulate a search query so a document search finds the most relevant passages. Return ONLY the rephrased query — no quotes, no explanation, one line.';
const buildUser = (query) =>
  `Rephrase this question so a keyword-and-vector document search retrieves the most relevant passages. ` +
  `Preserve the meaning; where useful, add synonyms or more specific terms. Keep it to one line.\n\n` +
  `Question: ${query}\n\nRephrased query:`;

// Reformulate `query` for a second retrieval pass. Returns the rephrased string, or null
// if it failed or came back effectively unchanged (nothing to gain from re-retrieving).
const correctiveQuery = async (query) => {
  try {
    const raw = await withTimeout(completeChat(
      [{ role: 'system', content: SYSTEM }, { role: 'user', content: buildUser(query) }],
      { temperature: 0.2, maxTokens: 60, timeoutMs: TIMEOUT_MS },
    ), TIMEOUT_MS, 'corrective query');
    const out = String(raw || '').trim().replace(/^["']+|["']+$/g, '').split('\n')[0].trim();
    if (!out || out.toLowerCase() === String(query).trim().toLowerCase()) return null;
    return out.slice(0, 300);
  } catch { return null; }
};

module.exports = { correctiveQuery };
