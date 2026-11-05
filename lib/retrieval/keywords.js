'use strict';
const state = require('../state');
const { INDEX_HEAD_CHARS, KEYWORD_SCAN_MAX_CHARS } = require('./constants');

// Escape a string for safe literal use inside a RegExp. Shared so the character class can't be
// copied incompletely to one call site — an incomplete class is a silent correctness or ReDoS bug.
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Is a code point in a script written WITHOUT word spaces (Han, Hiragana, Katakana, Hangul, CJK Ext-A/B,
// compatibility ideographs)? Those need bigram tokenization; every other script tokenizes on word breaks.
const isCjk = (cp) =>
  (cp >= 0x3040 && cp <= 0x30FF) ||   // Hiragana + Katakana
  (cp >= 0x3400 && cp <= 0x4DBF) ||   // CJK Ext-A
  (cp >= 0x4E00 && cp <= 0x9FFF) ||   // CJK Unified
  (cp >= 0xF900 && cp <= 0xFAFF) ||   // CJK compatibility ideographs
  (cp >= 0xAC00 && cp <= 0xD7A3) ||   // Hangul syllables
  (cp >= 0x20000 && cp <= 0x2FA1F);   // CJK Ext-B..F + compatibility supplement (astral)

// Unicode-aware tokenizer, shared by the corpus index (IDF + BM25) and the query, so the two always agree.
// It lowercases, then breaks on any run of non-letter/non-number under Unicode rules — so accented Latin
// ("café", "naïve") stays whole and every non-Latin word is kept, instead of the old ASCII-only regex that
// deleted all non-Latin text (making those documents invisible to keyword/BM25 search) and split accented
// words. For a spaceless script a whole run would be one giant token a shorter query never matches, so each
// CJK run is emitted as overlapping character bigrams (the standard approach for CJK in a term index); a
// single-character run is emitted as itself. Non-CJK tokens shorter than two characters are dropped, as before.
const tokenize = (text) => {
  const out = [];
  // Normalize to NFC first so a composed and a decomposed form of the same accented text produce identical
  // tokens — otherwise "café" typed as one query (NFC) would not match a document whose bytes are decomposed
  // (NFD), which is exactly what a macOS filesystem hands back for accented filenames. Both the index and the
  // query pass through here, so they always agree.
  for (const word of String(text || '').normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    let run = [];      // consecutive CJK characters awaiting bigram emission
    let latin = '';    // consecutive non-CJK characters awaiting whole-token emission
    const flushCjk = () => {
      if (run.length === 1) out.push(run[0]);
      else for (let i = 0; i < run.length - 1; i++) out.push(run[i] + run[i + 1]);
      run = [];
    };
    const flushLatin = () => { if (latin.length > 1) out.push(latin); latin = ''; };
    for (const ch of word) {                       // iterates by code point (astral-safe)
      if (isCjk(ch.codePointAt(0))) { flushLatin(); run.push(ch); }
      else { flushCjk(); latin += ch; }
    }
    flushCjk(); flushLatin();
  }
  return out;
};

// Async and cooperative: tokenizing every document's head is a corpus-sized synchronous span, so it yields
// the event loop every YIELD_EVERY documents — matching the BM25 addDoc loop — to keep other connections
// responsive while a large workspace's index builds. The only caller (buildBM25Index) already awaits it.
const IDF_YIELD_EVERY = 500;
const buildIdf = async (pMap) => {
  const df = new Map();
  const N  = pMap.size;
  let i = 0;
  for (const { content } of pMap.values()) {
    if (content) {   // a parent without content would throw on .slice; skip it
      const terms = new Set(tokenize(content.slice(0, INDEX_HEAD_CHARS)));
      for (const t of terms) df.set(t, (df.get(t) || 0) + 1);
    }
    if (++i % IDF_YIELD_EVERY === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  const idf = new Map();
  for (const [term, count] of df) {
    idf.set(term, Math.log((N + 1) / (count + 1)) + 1);
  }
  return idf;
};

// Default IDF for a term not present in the corpus IDF table. Such a term is rare
// by definition (it doesn't appear in indexed content, or appears very seldom), so
// it should be treated as DISTINCTIVE — a high value — not as a common word. Using
// a low default (1.0) previously caused genuinely specific query terms — a product
// name or acronym absent from the corpus — to be discarded, so a new-topic question
// got misread as a continuation.
const UNKNOWN_TERM_IDF = 3.0;
// IDF above which a term counts as "domain-specific" (rare in the corpus, so it carries real topic signal):
// used for topic-shift detection and to pick the specific query terms that drive the density scans. Single-
// sourced here so tuning it moves every gate together instead of leaving inline copies on the old value.
const SPECIFIC_IDF_MIN = 2.5;

// Generic words that never carry topic signal of their own (function words + meta/continuation/speech verbs, plus
// the multilingual continuation vocabulary). Single-sourced as DATA in lib/ai/data/lexicon.json and loaded via
// ./lexicon, so adding a word or a language is a data edit with no code change. Applied inside
// extractSpecificKeywords below, so every follow-up decision (expand vs keep, recap vs advance, topic-shift, the
// continuation drift gate) draws the same line and cannot drift apart. A genuine subject — a name, place, or
// domain term, in any language — is never listed, so it always survives as topic signal.
const { GENERIC_WORDS } = require('./lexicon');

// High-IDF terms (> 1.5) — meaningful but not ultra-rare
const extractKeywords = (text, topN = 10, corpusIdf = state.corpusIdf) => {
  const tokens = tokenize(text).filter(t => t.length > 1);
  if (corpusIdf.size === 0) {
    return [...new Set(tokens.filter(t => t.length > 3))].slice(0, topN);
  }
  const scored = [...new Set(tokens)]
    .map(t => [t, corpusIdf.get(t) ?? UNKNOWN_TERM_IDF])
    .filter(([, idf]) => idf > 1.5)
    .sort((a, b) => b[1] - a[1]);
  return scored.slice(0, topN).map(([t]) => t);
};

// Domain-specific terms only (IDF > SPECIFIC_IDF_MIN) — used for topic-shift detection, recap-vs-advance, and
// the continuation drift gate. GENERIC_WORDS are stripped first so a follow-up made entirely of function and
// meta/speech words ("what else does it talk about") yields no specific term at all — the language-agnostic
// signal that it carries no new subject — even when one of those words happens to be rare in a small corpus.
const extractSpecificKeywords = (text, topN = 5, corpusIdf = state.corpusIdf) => {
  const tokens = tokenize(text).filter(t => t.length > 2 && !GENERIC_WORDS.has(t));
  if (corpusIdf.size === 0) {
    return [...new Set(tokens.filter(t => t.length > 4))].slice(0, topN);
  }
  const scored = [...new Set(tokens)]
    .map(t => [t, corpusIdf.get(t) ?? UNKNOWN_TERM_IDF])
    .filter(([, idf]) => idf > SPECIFIC_IDF_MIN)
    .sort((a, b) => b[1] - a[1]);
  return scored.slice(0, topN).map(([t]) => t);
};

const checkDate = (docTimestamp, startDate, endDate) => {
  if (!startDate && !endDate) return true;
  const docDate = docTimestamp != null ? new Date(docTimestamp) : null;
  // Undated documents (common for pasted text / ingested URLs with no timestamp)
  // can't be proven out of range. Previously `new Date(undefined)` yielded an
  // Invalid Date whose comparisons are all false, so ANY date filter silently
  // dropped every undated document. Keep them instead — a date filter shouldn't
  // make a document vanish with no explanation just because it lacks a timestamp.
  if (!docDate || isNaN(docDate.getTime())) return true;
  const start = startDate ? new Date(startDate) : null;
  const end   = endDate   ? new Date(endDate)   : null;
  return (!start || docDate >= start) && (!end || docDate <= end);
};

// Count occurrences of `needle` in `haystack` (both already lower-cased by the callers),
// advancing by one after each hit so overlapping matches are counted — matching the inline
// indexOf loop this replaced at every sliding-window scoring site in search.js/passages.js.
// Returns 0 for an empty needle.
const countOccurrences = (haystack, needle) => {
  if (!needle) return 0;
  let count = 0, at = 0;
  while ((at = haystack.indexOf(needle, at)) !== -1) { count++; at++; }
  return count;
};

// Count occurrences of `needle` that begin within the range [start, end) of `haystack`, without allocating
// a substring. This is exactly equivalent to countOccurrences(haystack.slice(start, end), needle) — same
// overlap-counting semantics — but the sliding-window passage scans call it once per window step (windows
// overlap ~4x), so slicing there copied every character several times and churned the garbage collector on
// a large document. Scanning the original string in place keeps that work allocation-free.
const countOccurrencesInRange = (haystack, needle, start, end) => {
  if (!needle) return 0;
  const last = Math.min(end, haystack.length) - needle.length;   // last valid start index (inclusive)
  let count = 0, at = Math.max(0, start);
  while (at <= last) {
    const found = haystack.indexOf(needle, at);
    if (found === -1 || found > last) break;
    count++; at = found + 1;   // advance by one to count overlapping matches, matching countOccurrences
  }
  return count;
};

// ── Sliding-window keyword scan ───────────────────────────────────────────────
// The retrieval paths all locate the densest region of a document the same way: slide a fixed window
// across the text and score each window by how many query needles it contains. These two helpers are the
// single home for that loop (it was reimplemented ~6 times, each with its own bound/step and a drift risk).
// Both are allocation-free per window (countOccurrencesInRange scans in place) and hard-bounded to
// KEYWORD_SCAN_MAX_CHARS, so a multi-hundred-MB document can never make the synchronous scan blow up.
//
// `needles` are already-lowercased tokens; `lower` is the (optionally already-bounded) lowercased text.
// `window` is the width in chars; `step` defaults to a quarter window (so windows overlap ~4x); `start` is
// the first offset. When `idf` (a Map) is given, each needle's count is weighted by idf.get(needle) ?? 1.
const scoreWindow = (lower, needles, pos, end, idf) => {
  let s = 0;
  for (const t of needles) {
    const c = countOccurrencesInRange(lower, t, pos, end);
    s += idf ? c * (idf.get(t) ?? 1) : c;
  }
  return s;
};

// Return the single highest-scoring window as { pos, score }. `stopAtScore` lets a gate stop early as soon
// as a window reaches a threshold (it never needs the exhaustive maximum), keeping the scan cheap on a big
// document. For an empty/too-short text the loop never runs and { pos: start, score: -1 } is returned.
const scanWindowsMax = (lower, needles, { window, step = Math.floor(window / 4), start = 0, idf = null, stopAtScore = Infinity } = {}) => {
  const limit = Math.min(lower.length, KEYWORD_SCAN_MAX_CHARS);
  const stepN = Math.max(1, Math.floor(step) || 1);
  let bestPos = start, bestScore = -1;
  for (let pos = start; pos < limit && bestScore < stopAtScore; pos += stepN) {
    const score = scoreWindow(lower, needles, pos, pos + window, idf);
    if (score > bestScore) { bestScore = score; bestPos = pos; }
  }
  return { pos: bestPos, score: bestScore };
};

// Return EVERY window as [pos, score] pairs, sorted by score descending. When `excludePos` is given, windows
// within one window-width of it are skipped; if that leaves nothing, the scan runs again without the
// exclusion so a caller always gets at least the full ranking to choose from.
const scanWindowsRanked = (lower, needles, { window, step = Math.floor(window / 4), start = 0, idf = null, excludePos = null } = {}) => {
  const limit = Math.min(lower.length, KEYWORD_SCAN_MAX_CHARS);
  const stepN = Math.max(1, Math.floor(step) || 1);
  const collect = (useExclude) => {
    const out = [];
    for (let pos = start; pos < limit; pos += stepN) {
      if (useExclude && excludePos != null && Math.abs(pos - excludePos) < window) continue;
      out.push([pos, scoreWindow(lower, needles, pos, pos + window, idf)]);
    }
    return out;
  };
  let scores = collect(excludePos != null);
  if (scores.length === 0 && excludePos != null) scores = collect(false);   // nothing survived the exclusion
  scores.sort((a, b) => b[1] - a[1]);
  return scores;
};

// Per-document filename tokens (the significant words in each document's basename), cached on the index by
// generation (last-indexed time + document count) so a re-index rebuilds it and nothing goes stale. The
// pre-expansion "query names a non-allowed document" check used to rebuild these strings for EVERY parent on
// EVERY query — an O(corpus) synchronous pass with per-entry allocation on the answer path. Building the map
// once per generation keeps the per-query work to a cheap lookup. Returns a Map of docId -> string[] tokens.
// The ONE way to tokenize a filename (or a question, when matching it against filenames) into significant words.
// NFC + Unicode letter/number class (matching tokenize above), so an accented-Latin or non-Latin (CJK, Arabic,
// Cyrillic, …) name is tokenized instead of mangled: the old ASCII strip turned "café" into "caf" (then dropped
// it) and reduced a CJK/Arabic name to nothing, so such documents could never be referenced by name. Plain-ASCII
// names tokenize exactly as before. Single-sourced here so the filename map and the query-side matchers in
// expand.js can never drift apart (they did: one path was Unicode-aware, the others ASCII-only).
const nameTokens = (str) => String(str || '').normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 3);

const docNameTokens = (idx) => {
  const path = require('path');
  const gen = `${idx.lastIndexedAt || 0}:${idx.parentMap ? idx.parentMap.size : 0}`;
  if (idx._docNameTokens && idx._docNameTokens.gen === gen) return idx._docNameTokens.map;
  const map = new Map();
  if (idx.parentMap) {
    for (const [id, entry] of idx.parentMap) {
      const base = (entry && entry.metadata && entry.metadata.source) ? path.basename(entry.metadata.source) : '';
      map.set(id, nameTokens(base));
    }
  }
  idx._docNameTokens = { gen, map };
  return map;
};

// True if the token carries meaningful content on its own — a spaceless-script (CJK) token, whose meaningful
// units are 1–2 character bigrams, or any other-script token of length ≥ 3. A 1–2 char non-CJK token ("in",
// "no", "de", "и") is a function word/particle that carries negligible topic signal, so callers that want to
// reason about distinctive CONTENT (not just any rare token) filter with this. Language-agnostic: it defers to
// the same CJK classification the tokenizer uses, so CJK content is never discarded by a Latin length rule.
const hasCjk = (s) => { for (const ch of String(s)) if (isCjk(ch.codePointAt(0))) return true; return false; };
const isContentToken = (t) => t.length >= 3 || hasCjk(t);

module.exports = { tokenize, buildIdf, extractKeywords, extractSpecificKeywords, checkDate, countOccurrences, countOccurrencesInRange, escapeRegExp, scanWindowsMax, scanWindowsRanked, SPECIFIC_IDF_MIN, GENERIC_WORDS, docNameTokens, nameTokens, isCjk, hasCjk, isContentToken };
