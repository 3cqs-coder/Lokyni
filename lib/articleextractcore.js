'use strict';
// Pure article extraction: run the readability extractor on already-fetched HTML and return its data object
// (title, content, image, author, published) or null. SHARED by the inline path and the worker body (see
// articleextract.js) so the two can never drift. Never throws — a parse failure yields null (the page simply
// had no extractable article).
//
// Security: it calls extractFromHtml(html, url) — which parses the GIVEN html and only uses the url as the
// base for resolving relative links. It never fetches, so it cannot be steered into an SSRF request (unlike
// the extractor's fetch-capable extract(input) entry, which must never be used here).
//
// The content field is capped so a hostile or enormous DOM cannot produce an unbounded string — important
// because this value is structured-cloned across the worker boundary, where an uncapped result would spike
// the main thread's heap on the way back.

const MAX_CONTENT_CHARS = 4 * 1024 * 1024;   // ~4M chars — generous for any real article, bounds a hostile DOM

// Truncate without splitting a surrogate pair (so the capped string is always valid UTF-16). Shared helper so the
// boundary handling is single-sourced with the parser and chunker caps.
const { surrogateSafeSlice: capText } = require('./surrogate');

const extract = async (html, url, { maxChars = MAX_CONTENT_CHARS } = {}) => {
  try {
    const { extractFromHtml } = require('@extractus/article-extractor');
    const data = await extractFromHtml(String(html || ''), url);
    if (!data || typeof data !== 'object') return null;
    if (typeof data.content === 'string') data.content = capText(data.content, maxChars);
    return data;
  } catch { return null; }
};

module.exports = { extract, capText, MAX_CONTENT_CHARS };
