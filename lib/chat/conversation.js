'use strict';
// Shared conversation-state reset.
//
// The volatile per-conversation retrieval state used to be cleared in two places
// that had drifted out of sync: socket.js `resetContext` (New / consecutive
// failures) cleared the rolling summary and passage-tracking maps, but the in-search
// topic-shift branches (search.js) only cleared `history`/`allowedDocIds`/`docReadPos`
// — leaving the PREVIOUS topic's rolling summary and consulted-doc list injected into
// the new topic's answer. Routing both paths through this one helper keeps them
// consistent: a topic shift now genuinely starts fresh, exactly like "New".
//
// Cap the per-conversation "documents consulted" list. It only backs meta answers
// ("which documents have we looked at?"), so a long conversation that touches many
// files must not let it grow without bound — in memory or in the persisted session.
// The most recent distinct documents are kept. Shared so the producer (search.js) and
// the persister (sessions.js) bound it to the same ceiling.
const MAX_CONSULTED_DOCS = 200;

// The one ceiling on conversation TURNS (entries), shared by the live in-memory cap (lib/history.js
// MAX_LIVE_HISTORY) and the persisted cap (lib/sessions.js MAX_PERSISTED_TURNS). They MUST stay equal — a live
// cap above the persisted one silently shortens a conversation on reconnect; below it, live trims more than
// persistence ever needed — so both import this single value rather than each hard-coding 400.
const MAX_HISTORY_TURNS = 400;

// `resetHistory` is false only for callers that manage history themselves.
const clearConversationState = (ctx, { resetHistory = true } = {}) => {
  if (!ctx) return;
  if (resetHistory) ctx.history = [];
  ctx.allowedDocIds    = null;
  ctx.summary          = '';
  ctx.summarizedUpTo   = 0;
  ctx.consultedDocs    = [];
  ctx.docReadPos       = new Map();
  ctx.docExcludePos    = new Map();
  ctx.docPassages      = new Map();
  ctx.windowScoreCache = new Map();
  ctx.webPages         = null;
};

module.exports = { clearConversationState, MAX_CONSULTED_DOCS, MAX_HISTORY_TURNS };
