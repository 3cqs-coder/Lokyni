'use strict';
// Overconfidence wording — a model-free check for prose that sounds more CERTAIN than the evidence supports.
// It flags assertive / absolute certainty markers ("proves", "conclusively", "without a doubt", "clearly
// demonstrates") ONLY when the answer's computed confidence is already below the bar. It is a mismatch
// detector, not a word ban: the same wording in a strongly-supported answer is left alone.
//
// This is deliberately English-only — certainty markers are language-specific and a word list can't be
// language-agnostic. So the caller runs it ONLY on a confidently-English answer (see langdetect); on every
// other language it simply never runs and never fires, so it can't misflag. That keeps the overall confidence
// signal language-agnostic (this is an additive English refinement, never a penalty elsewhere).
//
// Pure, bounded, never throws. The pattern uses only word-boundary literal alternations with no nested
// quantifiers, so it cannot backtrack catastrophically (ReDoS-safe) on adversarial input.

// Certainty / absolute-proof markers. Chosen for precision: each strongly signals an overclaim. Everyday
// softer words ("clearly", "certainly", "obviously", "always", "never") are intentionally excluded on their
// own because they are too common to flag reliably; only their proof-claim forms ("clearly shows/proves") are.
const OVERCONFIDENT_RE = /\b(?:proves|proven|conclusively|undoubtedly|unquestionably|incontrovertibly|irrefutably|indisputably|definitively|guarantees|guaranteed|beyond (?:a |any )?doubt|without (?:a |any )?doubt|leaves no doubt|clearly (?:shows|demonstrates|proves))\b/gi;

// Cap the scanned length so a pathologically long answer can't spend unbounded time here (the regex is linear,
// but bounding the input keeps this trivially cheap on the answer hot path).
const MAX_SCAN = 20000;

// Returns { overconfident, phrases }. `belowBar` is true when the answer's confidence is NOT high — only then
// is assertive wording a mismatch worth flagging. Always returns the shape; never throws.
const check = (text, { belowBar } = {}) => {
  if (!belowBar) return { overconfident: false, phrases: [] };
  const s = String(text || '');
  if (!s) return { overconfident: false, phrases: [] };
  const scan = s.length > MAX_SCAN ? s.slice(0, MAX_SCAN) : s;
  const seen = new Set();
  let m;
  OVERCONFIDENT_RE.lastIndex = 0;
  while ((m = OVERCONFIDENT_RE.exec(scan)) !== null) {
    const phrase = m[0].toLowerCase().replace(/\s+/g, ' ');
    if (!seen.has(phrase)) seen.add(phrase);
    if (seen.size >= 10) break;   // enough to report; stop scanning
  }
  return { overconfident: seen.size > 0, phrases: [...seen] };
};

module.exports = { check };
