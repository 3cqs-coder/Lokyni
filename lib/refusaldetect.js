'use strict';

// Language-agnostic refusal detection — the semantic layer beneath the fast English regex.
//
// When retrieval returns documents but they don't answer the question, the model may refuse IN THE QUESTION'S
// LANGUAGE ("Je n'ai pas cette information dans les documents", "文書にはその情報がありません"). The English
// regex (isFailedResponse in socket.js) misses that, so the refusal would be treated as a real answer: pushed
// into history, cached, and never offered a web fallback the way an English refusal is.
//
// This catches it by MEANING, not words: embed the answer and compare it (cosine) to a few canonical refusal
// prototypes. The default embedding model (bge-m3) is strongly cross-lingual, so a refusal in any language lands
// near the English prototype, while a real answer ("La capitale est Paris") sits far away. It is deliberately
// conservative to avoid ever misreading a real answer as a refusal (that would wrongly suppress a good answer):
//   • only runs on a SHORT answer (a genuine refusal is brief; a substantive answer is not),
//   • requires a cosine at or above a high threshold,
//   • is dependency-injected (the embed function is passed in) so it is unit-testable with no model, and
//   • is FULLY fail-open — no embedder, a long answer, an embed error, or a malformed vector all return false,
//     leaving the regex result in force. It can only ever ADD a refusal verdict the regex missed, never remove
//     a real answer on its own beyond the short + high-similarity bar.
//
// The prototype embeddings are memoized, so the per-answer cost is a single embed of the answer, only on the
// rare path (a short answer the regex did not already flag). node:crypto-free, non-blocking, language-agnostic.

const { unitNormalize } = require('./embeddings');
const { OUT_OF_SCOPE_MESSAGE, NO_RELEVANT_INFO_MESSAGE } = require('./constants');

// The canonical refusal prototypes to compare against. Single-sourced from the same constants the pipeline
// emits for its own no-answers, plus one generic phrasing, so there is nothing to keep in sync by hand. The
// default embedding model (bge-m3) is cross-lingual, so these English prototypes match a refusal in any language.
const REFUSAL_PROTOTYPES = Object.freeze([
  NO_RELEVANT_INFO_MESSAGE,
  OUT_OF_SCOPE_MESSAGE,
  'I do not have that information in the documents.',
]);

// Cosine of two vectors (unit-normalized here, so the dot product IS the cosine).
const cosine = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
};

// Memoized prototype vectors, keyed by the prototype text. Cleared by _reset() for tests.
const _protoCache = new Map();
const _protoVector = async (text, embed) => {
  if (_protoCache.has(text)) return _protoCache.get(text);
  const v = unitNormalize(await embed(text));
  _protoCache.set(text, v);
  return v;
};

// Is `text` semantically a refusal? Returns a Promise<boolean>; never throws.
//   text       : the model's answer
//   embed      : (s) => Promise<number[]>  — embeds one string (bge-m3 or any provider)
//   prototypes : canonical refusal strings to compare against (a short, fixed list)
//   threshold  : minimum cosine to call it a refusal (conservative; default tuned for bge-m3)
//   maxChars   : only short answers are candidates (a long answer is never a refusal)
const isSemanticRefusal = async ({ text, embed, prototypes, threshold = 0.72, maxChars = 400 } = {}) => {
  try {
    const t = String(text == null ? '' : text).trim();
    if (!t || t.length > maxChars) return false;
    if (typeof embed !== 'function' || !Array.isArray(prototypes) || prototypes.length === 0) return false;
    const answerVec = unitNormalize(await embed(t));
    if (!Array.isArray(answerVec) || answerVec.length === 0) return false;
    for (const p of prototypes) {
      const pv = await _protoVector(p, embed);
      if (Array.isArray(pv) && pv.length === answerVec.length && cosine(answerVec, pv) >= threshold) return true;
    }
    return false;
  } catch { return false; }
};

// Test-only: forget memoized prototype vectors so a test can swap the embed function / prototypes.
const _reset = () => { _protoCache.clear(); };

module.exports = { isSemanticRefusal, REFUSAL_PROTOTYPES, _reset };
