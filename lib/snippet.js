'use strict';

// One place that turns a raw passage into the short, single-line preview shown on a citation (the
// hover card, the "answered from" strip). Keeping the cap and the normalization here means the
// retrieval paths that produce a snippet and the session store that re-caps it on save can never
// drift apart. A bounded prefix is sliced before whitespace is collapsed, so a large passage is
// never scanned in full — the work stays constant per source regardless of document size.

const { stripInvisibleChars } = require('./constants');

const SNIPPET_MAX_CHARS = 320;

// A citation preview is HTML-escaped before display (so no injection), but invisible/bidi "Trojan-Source"
// characters could still spoof the DISPLAY ORDER of the source preview on the hover/strip card. The strip
// is single-sourced as `stripInvisibleChars` in constants.js so it can never drift from the answer-egress
// sanitizer (verify.js); both leave ZWJ/ZWNJ alone, which emoji sequences and Indic/Arabic text need.

// Slice a string to `end` without cutting a surrogate pair in half. A plain .slice at an arbitrary
// character offset can end on a lone high surrogate (or the trailing prefix-bound below can), which renders
// as a broken U+FFFD glyph — visible on a citation card for emoji or astral CJK text. Dropping a trailing
// lone high surrogate keeps the preview clean.
function safeSlice(s, start, end) {
  let out = s.slice(start, end);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xD800 && last <= 0xDBFF) out = out.slice(0, -1);
  return out;
}

function makeSnippet(text) {
  return safeSlice(
    stripInvisibleChars(safeSlice(String(text || ''), 0, SNIPPET_MAX_CHARS * 6))  // bound the scan; leaves room for collapse
      .replace(/\s+/g, ' ')
      .trim(),
    0, SNIPPET_MAX_CHARS);
}

module.exports = { makeSnippet, safeSlice, SNIPPET_MAX_CHARS };
