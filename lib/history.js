'use strict';
// Rolling conversation-summary compression with head preservation.
//
// Long conversations are compressed "middle-out": the FIRST exchange (which
// establishes the topic and the document under discussion) is kept verbatim, the
// most recent turns are kept verbatim, and the middle turns are folded into a
// structured running summary injected into the system prompt so the model can
// still resolve follow-up references to earlier discussion.
//
// Preserving the head matters for this retrieval system specifically: the opening
// user turn usually names the subject/document, and losing it to summarization can
// let long sessions drift off the original topic on vague follow-ups.
//
// State on conversationContext:
//   history        — array of {role, content} (user/assistant, aligned pairs)
//   summary        — running compressed summary string ('' until first fold)
//   summarizedUpTo — count of leading turns already folded into `summary`
//                    (counted from PROTECT_HEAD onward; the head is never folded)
const { DEBUG } = require('./config');
// The tunable summary settings below are read fresh at call time (not destructured
// here) so a Settings change takes effect without a restart — reloadConfig()
// re-requires ./config, and a value captured at import would be stale.
const { completeChat, fenceUntrustedDocs, untrustedNote } = require('./llm');

// Number of leading messages (one user+assistant exchange) always kept verbatim.
const PROTECT_HEAD = 2;

// Structured-heading summary prompt. Fixed headings surface exactly the things a
// document-Q&A follow-up is likely to reference (specific values, open threads),
// which also gives the intent classifier a cleaner base for resolving references.
const SUMMARIZE_SYSTEM = require('./promptdata').read('history-summarize-system.txt')
  .replace('{{UNTRUSTED_NOTE}}', untrustedNote('The conversation content to summarize is', 'text to summarize'));

const assistantTrim = (content, max = 700) =>
  content.length > max ? content.slice(0, max).trimEnd() + '…' : content;

// Drop turns already folded into the summary so memory stays bounded — but NEVER
// drop the protected head. Keeps a small buffer before the verbatim window.
const trimSummarized = (ctx, windowStart) => {
  const summarized = ctx.summarizedUpTo || 0;
  if (summarized <= 0) return;
  const BUFFER = 4;
  // Never trim into the protected head: the earliest droppable index is PROTECT_HEAD.
  const dropUpTo = Math.min(summarized, Math.max(0, windowStart - BUFFER));
  const dropStart = PROTECT_HEAD;
  if (dropUpTo <= dropStart) return;
  // Remove only the middle slice [PROTECT_HEAD, dropUpTo); keep the head intact.
  ctx.history = [...ctx.history.slice(0, dropStart), ...ctx.history.slice(dropUpTo)];
  ctx.summarizedUpTo = summarized - (dropUpTo - dropStart);
};

// Hard cap on the in-memory history, applied on EVERY turn regardless of the summary toggle. With the
// rolling summary ON, trimSummarized keeps the live array to roughly the protected head plus the verbatim
// window; with it OFF, nothing else trims the array, so a very long single session would grow it forever
// (each assistant turn also retains its sources). Keep the protected head plus the most recent turns up to
// this bound so per-connection memory stays flat. The LLM prompt window is separately bounded (llm.js), so
// this only limits what is retained for follow-up resolution and for persistence.
// entries (~200 exchanges). Single-sourced with the persisted-turn ceiling (sessions.js MAX_PERSISTED_TURNS) via
// conversation.js, so the live cap and the persisted cap can never drift apart (which would silently shorten a
// conversation on reconnect, or trim live more than persistence needs).
const MAX_LIVE_HISTORY = require('./conversation').MAX_HISTORY_TURNS;
const capHistory = (ctx) => {
  const h = ctx.history;
  if (!Array.isArray(h) || h.length <= MAX_LIVE_HISTORY) return;
  ctx.history = [...h.slice(0, PROTECT_HEAD), ...h.slice(-(MAX_LIVE_HISTORY - PROTECT_HEAD))];
  // Dropped middle turns were never folded into the summary here (this path bounds the summary-off case, or
  // backstops a summary that keeps failing), so a summarizedUpTo pointer into the old longer array is now
  // stale — clamp it to the head so it can never point past the trimmed array.
  if (ctx.summarizedUpTo && ctx.summarizedUpTo > PROTECT_HEAD) ctx.summarizedUpTo = PROTECT_HEAD;
};

// Fold the turns that just fell out of the verbatim window into ctx.summary.
// Idempotent: a no-op when the window has not advanced past what is summarized.
const updateConversationSummary = async (ctx, signal = null) => {
  const { maxHistory, useConversationSummary, historySummaryThresholdChars,
          historyProtectLastN, summaryMaxTokens, rewriteModel } = require('./config');
  capHistory(ctx);   // unconditional in-memory bound, even when the rolling summary is off
  if (!useConversationSummary) return;
  const history = ctx.history;
  if (!Array.isArray(history) || history.length === 0) return;

  const rawProtect = historyProtectLastN || maxHistory * 2;
  // Keep the verbatim window aligned to user/assistant pairs.
  const protect = rawProtect % 2 === 0 ? rawProtect : rawProtect + 1;

  const windowStart = Math.max(0, history.length - protect);
  // Summarization starts after the protected head — the head stays verbatim.
  const summarizeFrom = Math.max(PROTECT_HEAD, ctx.summarizedUpTo || 0);

  // Nothing new to fold if the recent-window boundary hasn't passed the head, or
  // hasn't advanced past what's already summarized.
  if (windowStart <= summarizeFrom) {
    trimSummarized(ctx, windowStart);
    return;
  }

  // Only spend an LLM call once the conversation is long enough to benefit.
  const totalChars = history.reduce((s, m) => s + (m.content ? m.content.length : 0), 0);
  if (totalChars < historySummaryThresholdChars) {
    trimSummarized(ctx, windowStart);
    return;
  }

  const newTurns = history.slice(summarizeFrom, windowStart);
  if (newTurns.length === 0) { trimSummarized(ctx, windowStart); return; }

  const turnsText = newTurns.map(m =>
    `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.role === 'assistant' ? assistantTrim(m.content) : m.content}`
  ).join('\n');

  // Include the head exchange as context so the summary stays anchored to the
  // original topic even as the middle is compressed.
  const headText = history.slice(0, PROTECT_HEAD).map(m =>
    `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.role === 'assistant' ? assistantTrim(m.content, 400) : m.content}`
  ).join('\n');
  // Fence the conversation text (untrusted — an assistant turn may quote a document that
  // tried to inject instructions) so the summarizer treats it purely as data. The existing
  // running summary is a prior controlled paraphrase, but fence it too for consistency.
  const headBlock = headText ? `Original opening exchange (for context — keep the summary anchored to this topic):\n${fenceUntrustedDocs(headText)}\n\n` : '';

  const userContent = ctx.summary
    ? `${headBlock}Existing running summary:\n${fenceUntrustedDocs(ctx.summary)}\n\nNew exchanges to fold in:\n${fenceUntrustedDocs(turnsText)}\n\nProduce the updated running summary under the required headings.`
    : `${headBlock}Conversation exchanges:\n${fenceUntrustedDocs(turnsText)}\n\nProduce a running summary under the required headings.`;

  try {
    const summary = await completeChat(
      [
        { role: 'system', content: SUMMARIZE_SYSTEM },
        { role: 'user', content: userContent },
      ],
      // Bound this like every other auxiliary LLM call. It is awaited on the answer path
      // before chat_end/sources are emitted, so an unbounded call would let a stalled summary
      // model hang the spinner (and pin state.activeQueries) for the full idle timeout after
      // the answer already streamed. timeoutMs is passed through to streamChat, which aborts
      // the abandoned generation at this bound instead of the 120s idle bound. The caller's abort
      // signal is threaded in too, so a client disconnect cancels this call immediately (freeing the
      // generation slot) rather than pinning it until the timeout fires.
      { temperature: 0, maxTokens: summaryMaxTokens, timeoutMs: require('./retrieval/constants').AUX_LLM_TIMEOUT_MS, ...(signal ? { signal } : {}), ...(rewriteModel ? { model: rewriteModel } : {}) }
    );
    if (summary && summary.trim().length > 0) {
      ctx.summary = summary.trim();
      ctx.summarizedUpTo = windowStart;
      if (DEBUG) console.log(`  Rewrote conversation summary (${ctx.summary.length} chars, folded ${newTurns.length} msgs, head preserved)`);
    }
  } catch (err) {
    if (DEBUG) console.log(`  Summary update failed (${err.message}) — keeping prior summary`);
  }

  trimSummarized(ctx, windowStart);
};

module.exports = { updateConversationSummary, capHistory, MAX_LIVE_HISTORY, PROTECT_HEAD };
