'use strict';
// Web-grounded answering. When the user enables web search for a message, this
// runs the search, fetches the top pages, and produces a grounded answer stream
// plus web-URL "sources" — reusing the same buildMessages grounding flow and the
// same source-pill shape used for local documents, so the rest of the pipeline
// (socket streaming, citation UI) needs no special-casing.
//
// Web follow-ups stay grounded: after a web answer, the fetched pages are stored on
// the conversation context. A follow-up that continues the same subject ("what date
// is that from?") reuses those pages instead of running a fresh search on the raw
// follow-up text — the same continuation principle used for local documents.
// useWebResultRanking is a writable Settings toggle and the web counts are advanced knobs; all are
// read LIVE inside answerFromWeb (below) so a Settings change takes effect without a restart, never
// destructured at import where reloadConfig() could not reach them.
const { DEBUG } = require('../config');
const { streamChat, buildMessages } = require('../llm');
const { searchWeb, fetchPageText } = require('../websearch');
const { rankWebResults } = require('./webrank');
const { isVagueContinuation } = require('./expand');

// A follow-up is a "web continuation" when we have stored web pages from a previous
// web answer AND the message carries no new concrete subject of its own — a vague
// continuation ("tell me more") or a short reference/clarifier ("what date is that
// from?", "and the source?"). Such turns should reuse the fetched pages.
// Matches short clarifiers that ask about an attribute of the prior answer: an
// optional connective/question-word lead-in, an optional article, then an attribute
// noun (date, source, year, author, …) or a bare pronoun reference.
const REFERENCE_FOLLOWUP_RE = /^(and |but |so |ok |okay )?(what|when|where|who|which|how)?\s*(is|was|are|were|about)?\s*(the |that |this |it |its )?(date|time|source|url|link|year|month|day|number|price|cost|author|title|name|when|where|published|updated|from)\b/i;

const isWebContinuation = (query, ctx) => {
  if (!Array.isArray(ctx.webPages) || ctx.webPages.length === 0) return false;
  const q = query.trim();
  // PRIMARY signal — LANGUAGE-AGNOSTIC: the shared classifier recognizes "no new subject of its own" structurally
  // (a query with zero corpus-distinctive keywords), so a vague follow-up in ANY script/phrasing reuses the pages.
  if (isVagueContinuation(q)) return true;
  // SECONDARY refinement — English attribute-clarifiers ("what date is that from?") and pronoun-tail questions
  // whose attribute word happens to be corpus-distinctive (so the structural test above does not fire). These two
  // regexes are English by nature and ADDITIVE: they only ever ADD matches for English and never block another
  // language (whose coverage comes from the language-agnostic signal above). A fully language-agnostic version
  // would need a per-language attribute lexicon the project does not maintain, so this stays an English-only net.
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length <= 6) {
    const hasNewProper = words.slice(1).some(w => /^[A-Z][a-z]{2,}/.test(w));
    if (!hasNewProper) {
      // (a) asks about an attribute of the prior answer (date, source, author, …)
      if (REFERENCE_FOLLOWUP_RE.test(q)) return true;
      // (b) a short question that ends in a bare pronoun referring back to the
      //     previous answer ("who wrote it", "how does that work", "why is this").
      if (/\b(it|that|this|they|them|those|these)\b[?.!]*$/i.test(q) &&
          /^(what|who|when|where|why|how|which|is|are|was|were|does|do|did|can|could|will)\b/i.test(q)) {
        return true;
      }
    }
  }
  return false;
};

// Answer the query from live web results. Returns the same envelope shape as
// searchDocuments: { stream, sources, outOfScope, web: true }.
const answerFromWeb = async (query, conversationContext, signal = null) => {
  const { webSearchResultCount, webSearchFetchCount, useWebResultRanking } = require('../config');
  // Web continuation — reuse the pages already fetched for this conversation rather
  // than running a fresh search on a follow-up that can't stand alone.
  if (isWebContinuation(query, conversationContext)) {
    if (DEBUG) console.log(`  🌐 Web follow-up — reusing ${conversationContext.webPages.length} fetched page(s), no new search`);
    const pages = conversationContext.webPages;
    const webContext = pages.map(r => `[${r.title} — ${r.url}]\n${r.text}`).join('\n\n---\n\n');
    // Shared with the caller on the result: streamChat sets genOpts.truncated on a mid-stream idle timeout,
    // and the socket surfaces the caveat as a separate UI message (kept OUT of stored history), exactly like
    // the document path — rather than yielding it into the stream where it would be saved and re-sent.
    const genOpts = {};
    async function* contStream() {
      const messages = buildMessages(webContext, conversationContext.history, query,
        conversationContext.summary || '', { isWeb: true });
      yield* streamChat(messages, genOpts);
    }
    return {
      stream: contStream(), outOfScope: false, web: true, genOpts,
      sources: pages.map((r, i) => webSource(r, i)),
    };
  }

  let { results, error } = await searchWeb(query, webSearchResultCount, signal);

  // Drop duplicate result URLs (search engines return desktop/mobile variants that decode to the same
  // href) so a page isn't fetched, grounded on, and shown as a source twice.
  if (Array.isArray(results) && results.length > 1) {
    const seen = new Set();
    results = results.filter(r => {
      let key = r && r.url;
      try { const u = new URL(r.url); u.hash = ''; key = u.href; } catch {}
      if (!key || seen.has(key)) return false;
      seen.add(key); return true;
    });
  }

  // Reorder by the source prior so the pages we fetch and ground on are the most
  // authoritative and on-topic, not just whatever order the engine returned.
  if (useWebResultRanking && results && results.length > 1) {
    const before = results.map(r => r.url);
    results = rankWebResults(query, results);
    if (DEBUG && results.map(r => r.url).join('|') !== before.join('|')) {
      console.log('  🌐 Web results reordered by source prior');
    }
  }

  if (!results || results.length === 0) {
    const msg = error
      ? `I couldn't reach web search just now (${error}). Please try again in a moment, or ask about your indexed documents instead.`
      : `I searched the web but didn't find any results for that. Try rephrasing, or ask about your indexed documents instead.`;
    async function* failStream() { yield msg; }
    return { stream: failStream(), sources: [], outOfScope: true, web: true };
  }

  // Fetch full readable text for the top N results; fall back to the snippet when a
  // page can't be fetched (blocked, JS-only, timed out) so we still have something.
  const toFetch = results.slice(0, webSearchFetchCount);
  const fetched = await Promise.all(toFetch.map(async (r) => {
    // Guard per page so one rejecting fetch can't reject the whole batch and lose every page (parity with
    // deepresearch's researchWeb); fetchPageText already returns '' on failure, this is defense in depth.
    try {
      const text = await fetchPageText(r.url, signal);
      return { ...r, text: text && text.length > 100 ? text : (r.snippet || '') };
    } catch { return { ...r, text: r.snippet || '' }; }
  }));

  // Any remaining results (not fetched) contribute their snippet as light context
  // and appear as sources the user can click.
  const extra = results.slice(webSearchFetchCount).map(r => ({ ...r, text: r.snippet || '' }));
  const all0 = [...fetched, ...extra].filter(r => r.text && r.text.trim().length > 0);

  // Collapse syndicated/mirrored copies (the same article under different URLs/outlets) to a single
  // representative, keeping the best-ranked. Without this, one story mirrored across sites is grounded on and
  // cited several times — inflating apparent corroboration and wasting context budget. Same-site but DIFFERENT
  // pages are kept (they can carry different information); only near-duplicate CONTENT is dropped.
  const { kept: all, dropped: dupPages } = require('../sourceindependence').dedupeByContent(all0);
  if (DEBUG && dupPages > 0) console.log(`  🌐 Collapsed ${dupPages} near-duplicate web page(s) to independent sources`);

  if (all.length === 0) {
    async function* emptyStream() {
      yield `I found web results but couldn't read their contents (the pages may be blocked or require JavaScript). Here are the links I found:\n\n${results.map(r => `- ${r.title}: ${r.url}`).join('\n')}`;
    }
    return {
      stream: emptyStream(), outOfScope: false, web: true,
      sources: results.map((r, i) => webSource(r, i)),
    };
  }

  if (DEBUG) console.log(`  🌐 Web answer grounded on ${all.length} source(s)`);

  // Store the fetched pages so follow-ups can reuse them without re-searching.
  conversationContext.webPages = all.map(r => ({ title: r.title, url: r.url, text: r.text }));

  const webContext = all.map(r => `[${r.title} — ${r.url}]\n${r.text}`).join('\n\n---\n\n');

  // Shared on the result so the socket can surface a mid-stream truncation as a separate UI message (kept
  // out of stored history), mirroring the document path — see the continuation branch above.
  const genOpts = {};
  async function* webStream() {
    const messages = buildMessages(webContext, conversationContext.history, query,
      conversationContext.summary || '', { isWeb: true });
    yield* streamChat(messages, genOpts);
  }

  return {
    stream: webStream(),
    outOfScope: false,
    web: true,
    genOpts,
    sources: all.map((r, i) => webSource(r, i)),
  };
};

// Build a source pill for a web result. Mirrors the local-document source shape
// but points at the live URL and marks itself as a web source for the UI. Carries the
// readable text Lokyni already fetched (or the snippet) so the in-app viewer can show the
// same content the answer was grounded on, without embedding the live third-party page.
// The text is capped so a long article can't bloat the socket payload.
const WEB_SOURCE_TEXT_CAP = 20000;
const webSource = (r, i) => ({
  id: `web-${i}`,
  source: r.title || r.url,
  fileType: 'web',
  viewerLink: r.url,     // external URL — also offered as an "open original" link
  isWeb: true,
  url: r.url,
  // A transparent credibility tier (official / established / forum-social), reused from the ranking prior,
  // so the reader can weigh a cited page. '' for the neutral majority (no badge).
  ...(() => { const t = require('./webrank').sourceTier(r.url); return t.tier ? { tier: t.tier, tierLabel: t.label } : {}; })(),
  ...(() => { const c = require('../credibility').flagsFor({ source: r.url, title: r.title, text: r.text }); return c ? { credibility: c } : {}; })(),
  snippet: r.snippet || '',
  text: (r.text && r.text !== r.snippet) ? String(r.text).slice(0, WEB_SOURCE_TEXT_CAP) : '',
  passageStart: 0,
  passageEnd: 0,
  docLength: 0,
});

module.exports = { answerFromWeb, isWebContinuation };
