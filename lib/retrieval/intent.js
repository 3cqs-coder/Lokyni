'use strict';
// Unified intent classification for conversational retrieval.
//
// A single LLM pass reads the recent conversation, the current user message, and
// the list of documents already in play, then returns a structured decision:
//
//   {
//     intent:       'continue' | 'new_topic' | 'compare' | 'reference' | 'meta',
//     targetDocs:   [<filenames the answer should come from>],
//     resolvedQuery:'<self-contained retrieval query>',
//     ambiguous:    <bool>,
//     clarify:      '<one clarifying question, only if ambiguous>'
//   }
//
// This consolidates four heuristic systems that previously operated independently
// (topic-shift detection, comparison detection, continuation detection, query
// rewrite) into one decision made by the model that can actually read the thread.
//
// It is strictly ADDITIVE and fail-safe: on any error, timeout, disabled flag, or
// output that fails validation, callers fall back to the existing heuristic
// pipeline (getRetrievalQuery + search.js signal detection). Nothing is removed.
// useIntentClassifier / intentMaxTokens / intentModel are writable Settings keys, so they are
// read LIVE inside classifyIntent (below), never destructured at import — a captured value would
// leave the classifier permanently on or off regardless of what the user changes in Settings,
// since reloadConfig() only re-requires ./config and search.js calls classifyIntent unconditionally.
const { DEBUG } = require('../config');
const { completeChat } = require('../llm');
const { withTimeout, extractJson } = require('../llm-json');
const { tokenize } = require('./keywords');
const state = require('../state');

const INTENT_TIMEOUT_MS = require('./constants').AUX_LLM_TIMEOUT_MS;
const VALID_INTENTS = new Set(['continue', 'new_topic', 'compare', 'reference', 'meta']);

// Hard cap on how many documents a single classification may name. The prompt asks
// for at most 3, but a misbehaving model can ignore that and return every index in
// sequence ([1,2,3,…]), which both wastes the token budget and is never a useful
// answer. Capping in code makes the runaway harmless even when the instruction is
// ignored. A shift/compare rarely needs more than a couple of documents.
const MAX_TARGET_DOCS = 4;

// Request/style/filler words that carry no distinctive topic signal. A resolved
// query is only checked for grounding against the raw query's terms MINUS these,
// so pure continuations ("tell me more", "any more?") — which contain only these
// words — never trip the grounding guard, while a real subject term (a name,
// product, or acronym) must survive into the resolved query.
// Single-sourced as data in lib/ai/data/lexicon.json (groundingStop) via the shared lexicon loader.
const { GROUNDING_STOP } = require('./lexicon');

const INTENT_SYSTEM = require('../promptdata').read('intent-system.txt');

// Keep the classification prompt small: last few turns, compacted.
const compactHistory = (history, turns = 3) => {
  const aligned = history.length % 2 === 0 ? history : history.slice(0, -1);
  const recent = aligned.slice(-(turns * 2));
  const out = [];
  for (let i = 0; i < recent.length; i += 2) {
    const u = recent[i], a = recent[i + 1];
    if (!u || !a) continue;
    out.push(`USER: ${u.content}`);
    const ac = a.content.length > 300 ? a.content.slice(0, 300).trimEnd() + '…' : a.content;
    out.push(`ASSISTANT: ${ac}`);
  }
  return out.join('\n');
};

// The set of document basenames currently indexed — given to the model so it can
// name concrete targets. Capped to keep the prompt bounded on large corpora.
const availableDocNames = (limit = 60, idx = state) => {
  const names = [];
  for (const [, entry] of idx.parentMap) {
    const src = entry?.metadata?.source;
    if (src) names.push(require('path').basename(src));
    if (names.length >= limit) break;
  }
  return names;
};

// Validate + normalize a parsed classification against the known document set.
const normalize = (parsed, query, idx = state, shownDocs = null) => {
  if (!parsed || typeof parsed !== 'object') return null;
  const intent = VALID_INTENTS.has(parsed.intent) ? parsed.intent : null;
  if (!intent) return null;

  // targetDocs come back as NUMBERS indexing the AVAILABLE DOCUMENTS list shown to
  // the model (1-based). Map them back to filenames here, so every downstream
  // consumer still receives an array of filename strings exactly as before — the
  // index scheme is contained entirely within the model round-trip. Tolerate a model
  // that ignores the instruction and returns a filename string anyway (fall back to
  // the legacy name-matching for those entries).
  const known = new Set(availableDocNames(1000, idx).map(n => n.toLowerCase()));
  const list = Array.isArray(shownDocs) ? shownDocs : availableDocNames(60, idx);
  const resolveTarget = (d) => {
    if (typeof d === 'number' && Number.isInteger(d) && d >= 1 && d <= list.length) {
      return list[d - 1];
    }
    if (typeof d === 'string') {
      const asNum = Number(d.trim());               // a bare numeric string ("3")
      if (Number.isInteger(asNum) && asNum >= 1 && asNum <= list.length) return list[asNum - 1];
      const base = require('path').basename(d);      // legacy filename fallback
      return known.has(base.toLowerCase()) ? base : null;
    }
    return null;
  };
  const targetDocs = Array.isArray(parsed.targetDocs)
    ? parsed.targetDocs.map(resolveTarget).filter(Boolean).slice(0, MAX_TARGET_DOCS)
    : [];

  let resolvedQuery = typeof parsed.resolvedQuery === 'string' ? parsed.resolvedQuery.trim() : '';
  // Guard against the model answering instead of producing keywords.
  if (resolvedQuery.length > 120 || resolvedQuery.split(/\s+/).length > 16) resolvedQuery = query;
  if (resolvedQuery.length < 2) resolvedQuery = query;

  // GROUNDING GUARD: the resolved query must stay grounded in the CURRENT user
  // message. If the raw message has its own distinctive content terms (a new name,
  // topic, or keyword) and NONE of them survive into the resolved query or the named
  // target docs, the classifier has drifted onto the previous topic — reject the
  // whole classification so the caller falls back to the heuristic pipeline, which
  // will correctly detect the new topic. This catches both capitalized subjects
  // (a person or place name) and lowercase ones (an acronym or product name) that
  // the model wrongly resolved to a prior-topic query. Pure continuations ("tell me
  // more", "any more?") have no content terms of their own, so this guard correctly
  // does not fire on them.
  const rawContentTerms = [...new Set(tokenize(query))]
    .filter(t => t.length > 2 && !GROUNDING_STOP.has(t));
  // Skip the guard for 'reference' and 'meta': there the raw message is deliberately a
  // pronoun/ordinal that the classifier RESOLVES to a subject absent from the raw text
  // ("who was she?" → "Marie Curie"), so requiring a raw term to survive would wrongly
  // discard exactly the classifications this feature exists to produce.
  if (rawContentTerms.length > 0 && intent !== 'reference' && intent !== 'meta') {
    const resolvedTokens = new Set(tokenize(resolvedQuery));
    const targetTokens = new Set(
      targetDocs.flatMap(d => tokenize(d.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ')))
    );
    const covered = rawContentTerms.some(t => resolvedTokens.has(t) || targetTokens.has(t));
    if (!covered) {
      if (DEBUG) console.log(`  🧭 Intent: rejected — raw content term(s) [${rawContentTerms.join(', ')}] absent from resolved query "${resolvedQuery}" and targets; drifted off topic`);
      return null;
    }
  }

  const ambiguous = parsed.ambiguous === true;
  const clarify = ambiguous && typeof parsed.clarify === 'string' ? parsed.clarify.trim() : '';

  return { intent, targetDocs, resolvedQuery, ambiguous, clarify };
};

// Classify the current turn. Returns the normalized decision, or null to signal
// "fall back to the heuristic pipeline".
const classifyIntent = async (ctx, query, idx = state) => {
  const cfg = require('../config');
  if (!cfg.useIntentClassifier) return null;
  const history = ctx.history || [];
  // First turn has no context to switch from — let the normal first-query path run.
  if (history.length === 0) return null;

  const docs = availableDocNames(60, idx);
  // Present documents as a numbered list. The model returns targetDocs as indices
  // (small integers) rather than echoing full filenames back — a long title like
  // "Annual Infrastructure Assessment 2024 — Consolidated Findings…" repeated in the
  // response can otherwise blow the tight token budget mid-JSON, wasting the whole
  // classification call. Indices are mapped back to filenames after parsing (see normalize()).
  const numberedDocs = docs.map((n, i) => `${i + 1}. ${n}`).join('\n');
  const userBlock =
    `AVAILABLE DOCUMENTS:\n${numberedDocs}\n\n` +
    `CONVERSATION SO FAR:\n${compactHistory(history)}\n\n` +
    `LATEST USER MESSAGE:\n${query}\n\n` +
    `Return the JSON decision.`;

  try {
    const opts = { temperature: 0, maxTokens: cfg.intentMaxTokens, timeoutMs: INTENT_TIMEOUT_MS };
    if (cfg.intentModel) opts.model = cfg.intentModel;
    const raw = await withTimeout(completeChat(
      [{ role: 'system', content: INTENT_SYSTEM }, { role: 'user', content: userBlock }],
      opts,
    ), INTENT_TIMEOUT_MS, 'intent classify');

    const decision = normalize(extractJson(raw), query, idx, docs);
    if (!decision) {
      if (DEBUG) console.log(`  🧭 Intent: unparseable/invalid ("${(raw || '').slice(0, 80)}") — heuristic fallback`);
      return null;
    }

    // A "continue" or "reference" turn stays on the current conversation. It must
    // NOT introduce documents that aren't already in play — the classifier
    // sometimes hallucinates extra target docs (e.g. adding an unrelated file to a
    // "tell me more"). Intersect its targets with the conversation's allowed docs;
    // if it named only new docs, drop them and let the existing conversation docs
    // stand (the promotion/injection logic in search.js handles those).
    if ((decision.intent === 'continue' || decision.intent === 'reference') &&
        Array.isArray(ctx.allowedDocIds) && ctx.allowedDocIds.length > 0) {
      const allowedNames = new Set(
        ctx.allowedDocIds
          .map(id => idx.parentMap.get(id)?.metadata?.source)
          .filter(Boolean)
          .map(src => require('path').basename(src).toLowerCase())
      );
      const filtered = decision.targetDocs.filter(d => allowedNames.has(d.toLowerCase()));
      if (filtered.length !== decision.targetDocs.length) {
        if (DEBUG) console.log(`  🧭 Intent: dropped non-conversation target doc(s) on ${decision.intent} — kept [${filtered.join(', ')}]`);
        decision.targetDocs = filtered;
      }
    }

    if (DEBUG) console.log(`  🧭 Intent: ${decision.intent}${decision.targetDocs.length ? ' → [' + decision.targetDocs.join(', ') + ']' : ''}${decision.ambiguous ? ' (ambiguous)' : ''} | q="${decision.resolvedQuery}"`);
    return decision;
  } catch (err) {
    if (DEBUG) console.log(`  🧭 Intent: classify failed (${err.message}) — heuristic fallback`);
    return null;
  }
};

module.exports = { classifyIntent };
