'use strict';
// Shared UTF-16 surrogate-safe string helpers. Slicing a JavaScript string at an arbitrary index can split a
// surrogate PAIR (the two code units that together encode one astral character — many emoji and some CJK), leaving
// a lone half that is an invalid, often mojibake, character and can corrupt a downstream embed, hash, or compare.
// These keep a slice valid. One definition so the parser's text cap, the article-extract cap, and the chunker's
// cut point can never drift apart in how they handle the boundary.

// True when `code` is a HIGH surrogate (the first half of a pair): slicing right AFTER it would strand it.
const isHighSurrogate = (code) => code >= 0xD800 && code <= 0xDBFF;

// Return s.slice(0, max) adjusted so the result never ends on a lone high surrogate. Non-strings become ''. The
// caller appends any truncation marker itself (the different callers want different markers, or none).
const surrogateSafeSlice = (s, max) => {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  if (out.length && isHighSurrogate(out.charCodeAt(out.length - 1))) out = out.slice(0, -1);
  return out;
};

module.exports = { isHighSurrogate, surrogateSafeSlice };
