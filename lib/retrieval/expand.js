'use strict';
const path = require('path');
// maxHistory is a runtime-writable Setting, so read it live inside expandQuery (below) rather than
// freezing it at import — a Settings change must affect the next query's expansion window.
const { DEBUG } = require('../config');
const state = require('../state');
const { extractKeywords, extractSpecificKeywords, docNameTokens, nameTokens, GENERIC_WORDS } = require('./keywords');

// Vague continuation queries have no topic signal — never expand them.
// Expanding "tell me more" with history keywords pulls in wrong documents.
// This fast, index-free phrase table catches the common explicit continuations; isVagueContinuation() below
// generalizes it with a language-agnostic structural test for anything it does not spell out.
const VAGUE_CONTINUATION_RE = /^(tell me more|more|continue|go on|elaborate|keep going|and then|what else|anything else|what else can you tell me( about)?( it| that| this)?|what happened next|next|more details?|more info|expand|explain more|explain( it| this| that)? in detail|give me (a |an )?(more |elaborate |detailed? |full |complete |in[- ]depth )?(overview|summary|detail|details|elaboration|analysis|breakdown|explanation)|overview|summarize|summarise|analyze( it| this| that)?|analyse( it| this| that)?|break( it| this| that)? down|breakdown|in depth|in-depth|go deeper|dive deeper|tell me more about (it|that|this)|more about (it|that|this))\??\.?$/i;

// Single source of truth for "this follow-up carries no new subject of its own, so it must stay on the
// conversation's thread" — used by every follow-up decision (intent fast-path, query expansion, query rewrite,
// retry budget, web continuation). Two complementary signals so new phrasings never need a one-off patch:
//   1. The explicit phrase table above (fast, needs no index) for the common English continuations.
//   2. A LANGUAGE-AGNOSTIC structural test: a query whose tokens are all function/meta words (so
//      extractSpecificKeywords, which strips GENERIC_WORDS and keeps only corpus-distinctive terms, finds
//      nothing) carries no subject — whatever the language or phrasing. "what else does it talk about",
//      "¿de qué más habla?", and "他に何について" all reduce to zero specific terms, so all are recognized.
// A pivot to a real subject — in or out of the corpus — keeps that subject's distinctive term and is NOT vague.
const isVagueContinuation = (query, idx = state) => {
  const q = String(query || '').trim();
  if (!q) return false;
  if (VAGUE_CONTINUATION_RE.test(q)) return true;
  try {
    if (idx && idx.corpusIdf && idx.corpusIdf.size > 0) {
      return extractSpecificKeywords(q, 5, idx.corpusIdf).length === 0;
    }
  } catch (_) { /* fall back to the phrase table result (false) */ }
  return false;
};

const expandQuery = async (history, question, allowedDocIds, idx = state) => {
  if (!allowedDocIds || allowedDocIds.length === 0) return question;
  if (!history || history.length === 0) return question;

  // Never expand vague continuation queries — they carry no topic signal
  // and expansion will pull in history keywords that match wrong documents.
  if (isVagueContinuation(question, idx)) {
    if (DEBUG) console.log(`  Pre-expansion: vague continuation — skipping expansion`);
    return question;
  }

  // Pre-expansion topic shift check: if BM25 strongly identifies a new topic
  // with specific keywords, skip expansion so the new topic query is sent cleanly.
  if (idx.liveBM25?.engine) {
    try {
      const rawCheck = idx.liveBM25.engine.search(question, 3);
      if (rawCheck && rawCheck.length > 0) {
        const topScore    = rawCheck[0][1];
        const topRawDocId = idx.liveBM25.idToDocId.get(Number(rawCheck[0][0]));
        const allowedSet  = new Set(allowedDocIds);
        const querySpecificKws = extractSpecificKeywords(question, 5, idx.corpusIdf);
        // Require at least 2 specific keywords — a single word like "detail" or
        // "perl" scoring high is not enough signal to confidently skip expansion.
        const hasSpecificKeyword = querySpecificKws.length >= 2;
        const dynamicThreshold = (idx.liveBM25.medianScore || 3.0) * 2.0;
        const allowedBm25Score = rawCheck.find(([id]) => allowedSet.has(idx.liveBM25.idToDocId.get(Number(id))))?.[1] ?? 0;

        if (hasSpecificKeyword && topRawDocId && !allowedSet.has(topRawDocId) &&
            topScore >= dynamicThreshold && topScore > allowedBm25Score * 1.3) {
          if (DEBUG) console.log(
            `  Pre-expansion check: strong BM25 hit (${topScore.toFixed(2)} ≥ ${dynamicThreshold.toFixed(2)}) ` +
            `on ${path.basename(idx.parentMap.get(topRawDocId)?.metadata?.source || topRawDocId)} — skipping expansion`
          );
          return question;
        }
      }
    } catch (_) {}
  }

  // If the query explicitly names a document that isn't in the allowed set,
  // skip expansion entirely — the user is clearly starting a new topic.
  // This catches a question naming a new subject after a conversation on another
  // even when BM25 still ranks the Bible higher due to shared terms.
  if (allowedDocIds && allowedDocIds.length > 0) {
    const allowedSet = new Set(allowedDocIds);
    const queryLower = question.toLowerCase();
    // Filename tokens come from the generation-cached index (built once per re-index), so this check is a
    // cheap lookup rather than an O(corpus) string rebuild on every query.
    let scanned = 0;
    for (const [docId, docTokens] of docNameTokens(idx)) {
      if (allowedSet.has(docId)) continue;
      if (docTokens.some(t => queryLower.includes(t))) {
        if (DEBUG) console.log(`  Pre-expansion: query names non-allowed doc "${docTokens.join(' ')}" — skipping expansion`);
        return question;
      }
      // Yield periodically so this per-document filename scan can't block the event loop on a very large
      // corpus (it runs on every follow-up query that is scoped to specific documents).
      if ((++scanned % 5000) === 0) await new Promise((r) => setImmediate(r));
    }
  }

  const aligned = history.length % 2 === 0 ? history : history.slice(0, -1);
  // Guard maxHistory <= 0: slice(-0) is slice(0), which returns the WHOLE history (the opposite of "keep
  // none") and would pull expansion keywords from the entire conversation; a negative value slices from the
  // front. Keep the last N pairs only when N is positive, mirroring the same guard in llm._recentHistory.
  const maxHistory = Number(require('../config').maxHistory);
  const recentHistory = maxHistory > 0 ? aligned.slice(-(maxHistory * 2)) : [];

  const historyKeywords = recentHistory
    .filter(e => e.role === 'user')
    .flatMap(e => extractKeywords(e.content, 10, idx.corpusIdf));

  if (historyKeywords.length === 0) return question;

  const queryKeywords   = new Set(extractKeywords(question, 10, idx.corpusIdf));
  // Extract doc-name tokens from the question itself — don't append expansion
  // terms that are doc-name tokens of OTHER documents. If the user asks about
  // a new subject, don't append terms from the previous query's topic.
  // Use the SAME Unicode-aware tokenizer as the filename map above (nameTokens), so accented/non-Latin names are
  // matched consistently on every path — not Unicode here and ASCII there.
  const questionDocTokens = new Set(nameTokens(question));
  // Also extract doc-name tokens from all currently allowed documents
  const allowedDocNames = new Set(
    (allowedDocIds || []).flatMap(id => nameTokens(path.basename(idx.parentMap.get(id)?.metadata?.source || '')))
  );

  // Generic/function/meta words never make useful expansion terms — single-sourced in keywords.js (GENERIC_WORDS)
  // so this filter and the specific-keyword extractor can never drift apart.
  const expansionTerms  = [...new Set(historyKeywords)]
    .filter(kw =>
      !queryKeywords.has(kw) &&
      kw.length > 3 &&
      !GENERIC_WORDS.has(kw) &&
      // Don't append terms that are doc-name tokens of allowed docs but NOT
      // referenced in the current question — a prior topic's terms on a new subject
      !(allowedDocNames.has(kw) && !questionDocTokens.has(kw))
    )
    .slice(0, 5);

  if (expansionTerms.length === 0) return question;

  if (DEBUG) console.log(`  Query expanded: "${question}" + [${expansionTerms.join(', ')}]`);
  return `${question} ${expansionTerms.join(' ')}`;
};

module.exports = { expandQuery, VAGUE_CONTINUATION_RE, isVagueContinuation };
