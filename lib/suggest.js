'use strict';
// Suggested follow-up questions.
//
// After a grounded answer, a short auxiliary LLM pass proposes a few natural next questions
// the user might ask, shown as one-click chips under the answer. This runs AFTER the answer
// has finished streaming, is bounded by a timeout, and fails open to an empty list — so it
// can never delay, block, or break the answer it follows.
//
// Only the model's own answer text and the source document NAMES are sent to the suggestion
// call — never raw retrieved document text — so a crafted document cannot smuggle
// instructions into this prompt.
// The suggested-questions toggle, token budget, and model are writable Settings keys, read LIVE
// inside suggestQuestions (below). The socket layer already gates the call on the live value; a
// captured copy here would re-check a stale flag and return [] forever after the user enables the
// feature (or keep running it after they disable it) until a restart.
const { DEBUG } = require('./config');
const { completeChat } = require('./llm');
const { withTimeout } = require('./llm-json');

const SUGGEST_TIMEOUT_MS = 12000;
const MAX_SUGGESTIONS     = 3;
const MAX_QUESTION_LEN    = 100;   // a follow-up chip is short; clamp anything longer
const MAX_ANSWER_CHARS    = 1500;  // enough context to propose good follow-ups, cheap to send

const SUGGEST_SYSTEM = require('./promptdata').read('suggest-system.txt');

// Turn a raw multi-line model response into a clean, de-duplicated list of short questions.
const parseSuggestions = (raw, originalQuery) => {
  if (!raw) return [];
  const seen = new Set();
  const origNorm = (originalQuery || '').trim().toLowerCase();
  const out = [];
  for (let line of String(raw).split('\n')) {
    line = line.trim()
      .replace(/^[-*•\d.)\s]+/, '')   // strip a leading bullet or "1." / "1)" marker
      .replace(/^["'`]|["'`]$/g, '')  // strip surrounding quotes
      .trim();
    if (!line) continue;
    if (line.length > MAX_QUESTION_LEN) line = line.slice(0, MAX_QUESTION_LEN).trimEnd();
    // Require something question-shaped, and drop a restatement of the original query.
    const norm = line.toLowerCase();
    if (norm.length < 6) continue;
    if (norm === origNorm) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(line);
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
};

// Generate follow-up questions for a completed answer. Returns [] on any failure or when the
// feature is off — the caller treats an empty list as "no chips".
const suggestQuestions = async ({ query, answer, sources } = {}) => {
  const cfg = require('./config');
  if (!cfg.useSuggestedQuestions) return [];
  const a = (answer || '').trim();
  if (!a) return [];
  const names = (Array.isArray(sources) ? sources : [])
    .map(s => s && (s.source || s.url))
    .filter(Boolean)
    .slice(0, 12);
  try {
    const opts = { temperature: 0.3, maxTokens: cfg.suggestedQuestionsMaxTokens, timeoutMs: SUGGEST_TIMEOUT_MS };
    if (cfg.suggestedQuestionsModel) opts.model = cfg.suggestedQuestionsModel;
    const userBlock =
      `Question: ${query || ''}\n\n` +
      `Answer: ${a.length > MAX_ANSWER_CHARS ? a.slice(0, MAX_ANSWER_CHARS).trimEnd() + '…' : a}` +
      (names.length ? `\n\nDocuments: ${names.join(', ')}` : '');
    const messages = [
      { role: 'system', content: SUGGEST_SYSTEM },
      { role: 'user', content: userBlock },
    ];
    const raw = await withTimeout(completeChat(messages, opts), SUGGEST_TIMEOUT_MS, 'suggest');
    const list = parseSuggestions(raw, query);
    if (DEBUG) console.log(`  💡 Suggested ${list.length} follow-up question(s)`);
    return list;
  } catch (err) {
    if (DEBUG) console.log(`  💡 Suggestion generation failed (${err.message}) — no chips`);
    return [];
  }
};

module.exports = { suggestQuestions, parseSuggestions };
