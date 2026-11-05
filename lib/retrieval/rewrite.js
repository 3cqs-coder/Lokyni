'use strict';
// Conversational query rewriting for follow-up questions.
//
// Follow-ups like "what about the second one?" or "how does that compare?"
// carry references that a retrieval engine can't resolve on its own. We ask
// the LLM to rewrite the latest message into a single self-contained search
// query using the conversation history, then feed THAT to FAISS/BM25. The
// original user message is still sent to the generator unchanged — rewrite is
// only for retrieval (standard conversational-RAG pattern).
//
// Safe fallbacks preserve prior behavior when the LLM is unavailable or the
// feature is disabled:
//   - vague continuations ("tell me more") short-circuit (no rewrite, no
//     expansion) so search.js keeps its sequential-reading behavior;
//   - on any error/empty/refusal output we fall back to expandQuery() (keyword
//     append), which is what the system did before.
const { DEBUG } = require('../config');
// useQueryRewrite / rewriteMaxTokens / rewriteModel are read LIVE inside getRetrievalQuery (not
// destructured here) so toggling "Query Rewrite" in Settings takes effect on the next question,
// like the other retrieval toggles — a value captured at import would need a restart.
const { completeChat } = require('../llm');
const { withTimeout } = require('../llm-json');
const { expandQuery, isVagueContinuation } = require('./expand');
const { tokenize } = require('./keywords');

const REWRITE_TIMEOUT_MS = require('./constants').AUX_LLM_TIMEOUT_MS;
const MAX_REWRITE_LEN    = 100;   // matches isAnswerLike's length bound, so a clamped rewrite isn't then discarded

const REWRITE_SYSTEM = require('../promptdata').read('rewrite-system.txt');

const REFUSAL_RE = /^(as an ai|i can'?t|i'm unable|sorry|i cannot|i do not|unable to)/i;

// Compact the conversation into the last few turns for the rewrite prompt.
const compactHistory = (history, turns = 3) => {
  const aligned = history.length % 2 === 0 ? history : history.slice(0, -1);
  const recent = aligned.slice(-(turns * 2));
  const out = [];
  for (let i = 0; i < recent.length; i += 2) {
    const u = recent[i], a = recent[i + 1];
    if (!u || !a) continue;
    out.push({ role: 'user', content: u.content });
    const aContent = a.content.length > 500 ? a.content.slice(0, 500).trimEnd() + '…' : a.content;
    out.push({ role: 'assistant', content: aContent });
  }
  return out;
};

const cleanRewrite = (raw) => {
  if (!raw) return '';
  let s = raw.trim();
  // Models occasionally add a trailing note — keep only the first non-empty line.
  const firstLine = s.split('\n').map(l => l.trim()).filter(Boolean)[0];
  if (firstLine) s = firstLine;
  // Strip a single pair of surrounding quotes if present.
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) || (s.startsWith('`') && s.endsWith('`'))) {
    s = s.slice(1, -1).trim();
  }
  if (s.length > MAX_REWRITE_LEN) s = s.slice(0, MAX_REWRITE_LEN).trimEnd();
  return s;
};

const isRefusal = (s) => REFUSAL_RE.test(s.trim());

// The rewrite LLM sometimes ANSWERS the question instead of producing a search
// query (e.g. returning "her fate remains unclear... she was reportedly killed...
// but other accounts say she survived"). That declarative narrative
// pollutes retrieval with the model's own (often hallucinated) wording and sends
// passage selection to the wrong region. Reject it and fall back.
const isAnswerLike = (s) => {
  const words = s.split(/\s+/).filter(Boolean);
  if (s.length > 100 || words.length > 12) return true;            // a search query is short
  if (/\b(she|he|they|it|this|that)\b\s+\b(was|were|is|are|remains|claims?|suggests?|killed|survived|died|silenced)\b/i.test(s)) return true;
  return false;
};

// Reject rewrites with no connection to the conversation. The rewrite LLM
// sometimes hallucinates a stray word (e.g. "caskets") that then hijacks retrieval.
// A good reference rewrite resolves to entities/terms present in the recent
// conversation; one sharing NO token with the history is almost certainly a
// hallucination. Genuinely new-topic queries are still found via the raw query's
// BM25 match in search.js, so this only filters bad rewrites.
const isGroundedInConversation = (rewritten, history) => {
  const reTokens = new Set(tokenize(rewritten).filter(t => t.length > 2));
  if (reTokens.size === 0) return false;
  const histTokens = new Set();
  // Same length threshold on both sides (> 2). A tighter history filter (> 3) meant a
  // 3-letter acronym (SQL, API, GDP) in the rewrite could never match the history, so a
  // valid acronym-grounded rewrite was wrongly discarded.
  for (const m of (history || [])) {
    for (const t of tokenize(m.content || '')) if (t.length > 2) histTokens.add(t);
  }
  for (const t of reTokens) if (histTokens.has(t)) return true;
  return false;
};

// Produce the query to use for retrieval (FAISS/BM25), resolving follow-up
// references from conversation history.
// Returns { standaloneQuery, source } where source is one of:
//   'first' | 'vague' | 'rewrite' | 'expand' | 'fallback'
const getRetrievalQuery = async (ctx, query, idx = require('../state')) => {
  const { useQueryRewrite, rewriteMaxTokens, rewriteModel } = require('../config');   // live, so a Settings toggle applies immediately
  const history = ctx.history || [];

  // First message — nothing to resolve yet.
  if (history.length === 0) return { standaloneQuery: query, source: 'first' };

  // Vague continuations carry no topic signal — keep them verbatim so search.js
  // applies its allowed-doc promotion / sequential-reading behavior. Skipping
  // here also avoids an unnecessary LLM round trip.
  if (isVagueContinuation(query, idx)) {
    if (DEBUG) console.log(`  Rewrite: vague continuation — using raw query`);
    return { standaloneQuery: query, source: 'vague' };
  }

  if (useQueryRewrite) {
    try {
      const opts = { temperature: 0, maxTokens: rewriteMaxTokens, timeoutMs: REWRITE_TIMEOUT_MS };
      if (rewriteModel) opts.model = rewriteModel;
      const messages = [
        { role: 'system', content: REWRITE_SYSTEM },
        ...compactHistory(history),
        { role: 'user', content: query },
      ];
      const raw = await withTimeout(completeChat(messages, opts), REWRITE_TIMEOUT_MS, 'rewrite');
      const rewritten = cleanRewrite(raw);
      if (rewritten.length >= 3 && !isRefusal(rewritten) && !isAnswerLike(rewritten) && isGroundedInConversation(rewritten, history)) {
        if (DEBUG) console.log(`  Rewrite: "${query}" -> "${rewritten}"`);
        return { standaloneQuery: rewritten, source: 'rewrite' };
      }
      if (DEBUG) console.log(`  Rewrite: rejected answer-like/invalid/ungrounded output ("${(raw || '').slice(0, 100)}") — falling back to expansion`);
    } catch (err) {
      if (DEBUG) console.log(`  Rewrite: failed (${err.message}) — falling back to expansion`);
    }
  }

  // Fallback: keyword expansion (previous behavior).
  const expanded = await expandQuery(history, query, ctx.allowedDocIds, idx);
  return { standaloneQuery: expanded, source: expanded === query ? 'fallback' : 'expand' };
};

module.exports = { getRetrievalQuery };
