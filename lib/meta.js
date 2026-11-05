'use strict';
// Handlers for turns that should NOT hit the vector store:
//   - meta-conversational questions answered from conversation state
//   - clarifying questions when a reference is genuinely ambiguous
//
// Both return an async generator (matching searchDocuments' stream shape) plus a
// small result envelope so socket.js can treat them uniformly with normal answers.
const { DEBUG } = require('./config');
// useMetaConversation and useClarifyingQuestions are read fresh at call time (not
// destructured here) so toggling them in Settings takes effect without a restart —
// reloadConfig() re-requires ./config, and a value captured at import would be stale.

// Lightweight regex backstop for meta questions when the intent classifier is off
// or unavailable. Deliberately narrow — only unambiguous conversation-about-the-
// conversation phrasings, so real document questions never get captured here.
const META_RE = /^(what did i (just )?ask|what was my (last |previous )?(question|message)|what have we (discussed|covered|talked about)|summari[sz]e (our|this|the) (conversation|chat|discussion)|which documents? have we (looked at|used|seen)|what documents? (have|did) we|recap (our|this|the) (conversation|chat)|what are we talking about)\b/i;

// The META_RE phrasings are English and anchored to the start, and the handlers reply in English, so this
// path is English-scoped. Guard it with the shared, fail-open language detector: a confidently non-English
// query is never treated as meta (it is answered normally), so a future loosening of META_RE can't misroute
// foreign input into an English canned reply. An English or ambiguous query is unaffected (detector → '').
const isMetaQuestion = (query) => {
  const q = String(query || '').trim();
  if (!require('./config').useMetaConversation || !q) return false;
  if (require('./langdetect').isLikelyNonEnglish(q)) return false;
  return META_RE.test(q);
};

const streamOf = (text) => (async function* () { yield text; })();

// Answer a meta question from conversation state without retrieval.
const handleMeta = (ctx, query) => {
  const history = ctx.history || [];
  const q = query.trim().toLowerCase();

  // "what did I just ask?" / "what was my last question?"
  if (/what did i (just )?ask|what was my (last|previous)?\s*(question|message)/i.test(q)) {
    // Last USER turn before this one.
    const prevUser = [...history].reverse().find(m => m.role === 'user');
    const text = prevUser
      ? `Your previous question was: "${prevUser.content}"`
      : `This is the first thing you've asked in our conversation.`;
    return { stream: streamOf(text), sources: [], outOfScope: false, handled: true };
  }

  // "which documents have we looked at?"
  if (/which documents?|what documents?/i.test(q)) {
    const docs = Array.isArray(ctx.consultedDocs) ? [...new Set(ctx.consultedDocs)] : [];
    const text = docs.length
      ? `So far we've drawn on: ${docs.join(', ')}.`
      : `We haven't pulled from any specific documents yet in this conversation.`;
    return { stream: streamOf(text), sources: [], outOfScope: false, handled: true };
  }

  // "summarize / recap our conversation" / "what have we covered?"
  if (/summari[sz]e|recap|covered|discussed|talked about|what are we talking about/i.test(q)) {
    if (ctx.summary && ctx.summary.trim()) {
      return { stream: streamOf(`Here's a recap of what we've covered:\n\n${ctx.summary.trim()}`), sources: [], outOfScope: false, handled: true };
    }
    // No rolling summary yet — build a quick one from the verbatim turns.
    const userTurns = history.filter(m => m.role === 'user').map(m => m.content);
    if (userTurns.length === 0) {
      return { stream: streamOf(`We're just getting started — you haven't asked anything yet.`), sources: [], outOfScope: false, handled: true };
    }
    const bullets = userTurns.slice(-6).map(t => `• ${t}`).join('\n');
    return { stream: streamOf(`So far you've asked about:\n\n${bullets}`), sources: [], outOfScope: false, handled: true };
  }

  // Fallback meta answer.
  const prevUser = [...history].reverse().find(m => m.role === 'user');
  const text = prevUser
    ? `We were discussing: "${prevUser.content}". What would you like to know next?`
    : `We're just getting started.`;
  return { stream: streamOf(text), sources: [], outOfScope: false, handled: true };
};

// Ask a single clarifying question instead of guessing on an ambiguous reference.
const handleClarify = (clarifyText) => {
  if (!require('./config').useClarifyingQuestions || !clarifyText) return null;
  if (DEBUG) console.log(`  ❓ Clarifying: ${clarifyText}`);
  return { stream: streamOf(clarifyText), sources: [], outOfScope: false, handled: true, isClarification: true };
};

module.exports = { isMetaQuestion, handleMeta, handleClarify };
