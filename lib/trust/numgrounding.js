'use strict';
// Numeric grounding — a deterministic check that every significant figure an answer states can be
// traced to a number in the cited source text. It targets the specific, high-impact fabrication a
// language-model fact-check is weakest at: a plausible number pulled from the model's own training —
// a price, percentage, count, amount, or rate — that the sources never state (the classic "the current
// price is $28,000" invention). It complements the claim-level judge, which is better at non-numeric
// claims but unreliable on exact numbers.
//
// Design (precision-first, because a false flag on a real number erodes trust more than missing one):
//   • Match by VALUE, never by rewriting the answer. A figure is grounded when its value matches ANY
//     source number within a small tolerance, so an honestly rounded or restated figure ("about 85,000"
//     for "84,583") is never flagged — only a figure that matches NOTHING is.
//   • Normalize before comparing: a magnitude word ("5 billion"), a currency symbol ("$1.2M"), and a
//     percent are folded into the value so the same quantity written differently compares equal, and a
//     percent is also checked against its fraction ("40%" vs a source "0.40").
//   • Skip the noise classes that cause false alarms: bare four-digit years, small bare counts, and
//     numbers that are plainly references ("page 12", "section 3", "#42", "step 4").
//   • It only ever FLAGS (reports which figures are unsupported); it never alters the answer. Bounded
//     and pure, so it adds no blocking work, cannot throw into a caller, and cannot grow memory.

// A magnitude word or suffix attached to a number, so "5 billion" and "5,000,000,000" compare equal.
const MAGNITUDE_MULT = {
  k: 1e3, thousand: 1e3,
  m: 1e6, mn: 1e6, million: 1e6,
  b: 1e9, bn: 1e9, billion: 1e9,
  t: 1e12, tn: 1e12, trillion: 1e12,
};

// Zero code points for the common decimal-digit scripts (each is a run of ten: zero..nine). Used to fold
// non-ASCII digits to ASCII before the value scan, so a figure written in Arabic-Indic, Devanagari, or
// full-width numerals is extracted and compared the same as its ASCII form. Without this, `\d` (ASCII-only
// in JS) would miss such a number in the SOURCE while catching the ASCII form in the ANSWER, and flag a real
// figure as ungrounded — a false alarm. Folding only changes digit GLYPHS, never values, so it can never let
// a fabricated figure through; it only removes the cross-script false positive.
const DIGIT_ZEROS = [0x0660, 0x06F0, 0x0966, 0x09E6, 0x0A66, 0x0AE6, 0x0B66, 0x0BE6, 0x0C66, 0x0CE6, 0x0D66, 0x0E50, 0x0ED0, 0x0F20, 0xFF10];
const asciifyDigits = (s) => {
  if (!/[^\x00-\x7F]/.test(s)) return s;   // fast path: pure ASCII has nothing to fold
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    let mapped = ch;
    for (const z of DIGIT_ZEROS) { if (cp >= z && cp <= z + 9) { mapped = String.fromCharCode(48 + (cp - z)); break; } }
    out += mapped;
  }
  return out;
};

const MAX_SCAN_CHARS = 200000;   // bound the source scan so a very large cited passage can't spike CPU
const DEFAULT_TOLERANCE = 0.02;  // 2% — absorbs honest rounding and light restatement, not an invented figure
// A DERIVED value (a pairwise sum/difference of source numbers) is exact arithmetic, and the pool of them is
// large, so the 2% window would let an invented figure land near SOME pair by chance. Match derived values
// tightly (a computed total is restated near-exactly) to keep that guard meaningful while still grounding real
// sums/differences.
const DERIVED_TOLERANCE = 0.005;  // 0.5%

// Words that mark a number as a reference or identifier rather than a factual quantity ("page 12",
// "section 3", "step 4", "invoice 4521", "account 90210"). A figure right after one of these is skipped in
// significant mode so a document reference or an identifier is never fact-checked as a quantity. Note a
// prefix only matches BEFORE the number, so "unit 5" (a reference) is skipped while "5 units" (a quantity)
// is kept.
const REFERENCE_PREFIX = /\b(?:page|pages|pg|pp|section|sec|chapter|ch|figure|fig|table|step|item|version|ver|no|num|number|question|line|row|column|col|note|ref|rev|part|volume|vol|appendix|clause|paragraph|para|slide|invoice|inv|account|acct|order|id|zip|postcode|phone|tel|fax|ext|serial|sku|upc|isbn|case|ticket|po|room|suite|apt|unit|box|pin|badge|seat|gate|lot|bay|aisle|bin)\.?\s*$|[#§]\s*$/i;

// Pull the numbers out of a piece of text as { raw, value, isPercent } entries. A currency symbol, a
// percent, or a magnitude word is folded into the value so the same quantity written different ways
// compares equal. With significantOnly, only the figures worth fact-checking are returned — money,
// percentages, magnitudes, decimals, and integers of a thousand or more — while small bare counts,
// bare four-digit years, and reference numbers are skipped as noise, since those are not the fabrication
// risk and are often not written verbatim in the source.
const extractNumbers = (text, { significantOnly = false } = {}) => {
  const out = [];
  // Fold non-ASCII decimal digits (Arabic-Indic, Devanagari, full-width, …) to ASCII first, so a figure in
  // any digit script is extracted and compared like its ASCII form (see asciifyDigits).
  const src = asciifyDigits(String(text == null ? '' : text));
  // The magnitude lookahead sits INSIDE the optional group so it constrains a present magnitude only,
  // never the bare digits: "5 members" must not parse as "5 m" (five million), while "12000km" keeps the
  // full 12000 rather than truncating to 1200.
  const re = /([$€£¥])?\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s?(percent|%|thousand|million|billion|trillion|k|m|mn|bn|b|tn|t)(?![a-zA-Z]))?/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const currency = m[1] || '';
    const digits = m[2];
    const suffixRaw = (m[3] || '').trim().toLowerCase();
    if (!digits) continue;
    let value = Number(digits.replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    const isPercent = suffixRaw === 'percent' || suffixRaw === '%';
    const mult = isPercent ? 1 : (MAGNITUDE_MULT[suffixRaw] || 1);
    value *= mult;
    const hasDecimal = digits.indexOf('.') !== -1;
    const hasComma = digits.indexOf(',') !== -1;
    if (significantOnly) {
      const bareInt = !currency && !isPercent && !MAGNITUDE_MULT[suffixRaw] && !hasDecimal;
      // Skip small bare integers (noise) and bare four-digit years (not a fact figure here).
      if (bareInt && value < 1000) continue;
      if (bareInt && !hasComma && value >= 1800 && value <= 2099) continue;
      // Skip a long run of digits with no grouping (7+) — a phone number, account, order, or other
      // identifier, never a prose quantity (a real quantity that large is written with separators or a
      // magnitude word). This keeps identifiers from being fact-checked as amounts.
      if (bareInt && !hasComma && digits.length >= 7) continue;
      // Skip a number that is plainly a reference, not a quantity ("page 12", "#42", "step 4").
      const before = src.slice(Math.max(0, m.index - 24), m.index + (currency ? 1 : 0));
      if (REFERENCE_PREFIX.test(before)) continue;
    }
    out.push({ raw: (currency + digits + (suffixRaw ? ' ' + suffixRaw : '')).trim(), value, isPercent });
  }
  return out;
};

// Which significant figures in `answer` cannot be traced to a number in `sourceText`? Matching is by
// value with a rounding tolerance, so a correctly rounded figure is never flagged; a percent also
// matches its fraction form. Returns { checked, ungrounded: [{ raw, value }] }, de-duplicated by how the
// figure is written so the same invented number mentioned twice is reported once. Never throws.
const ungroundedFigures = (answer, sourceText, { tolerance = DEFAULT_TOLERANCE } = {}) => {
  try {
    const figures = extractNumbers(answer, { significantOnly: true });
    if (figures.length === 0) return { checked: 0, ungrounded: [] };
    const sourceNums = extractNumbers(String(sourceText || '').slice(0, MAX_SCAN_CHARS)).map((n) => n.value);
    const near = (v, pool, tol = tolerance) => pool.some((u) => {
      const scale = Math.max(Math.abs(v), Math.abs(u), 1);
      return Math.abs(v - u) <= tol * scale;
    });
    // Correct totals and differences of source figures (the bread-and-butter of summarization) do not
    // appear verbatim in the source, so a plain value match would wrongly flag them. Treat a figure that
    // equals the sum OR the absolute difference of two source numbers — OR the running sum of a consecutive
    // run of source figures (a list of line items followed by its total is the common 3-or-more-term case) —
    // as grounded. Built once, lazily (only when a figure is not already a direct match), and bounded to the
    // first 200 source numbers so a number-dense passage stays cheap (~20k entries worst case). Erring toward
    // MORE derived values is the precision-first choice here: a false flag on a correct total erodes trust more
    // than missing a fabricated one, and the derived tolerance stays tight.
    let derived = null;
    const buildDerived = () => {
      const base = sourceNums.slice(0, 200);
      const d = [];
      for (let i = 0; i < base.length; i++) {
        for (let j = i + 1; j < base.length; j++) { d.push(base[i] + base[j]); d.push(Math.abs(base[i] - base[j])); }
      }
      // Running sums of consecutive source figures (covers totals of 3+ line items; length-2 runs overlap the
      // pairwise sums above, harmlessly).
      for (let i = 0; i < base.length; i++) {
        let run = base[i];
        for (let j = i + 1; j < base.length; j++) { run += base[j]; d.push(run); }
      }
      return d;
    };
    const grounded = (f) => {
      if (near(f.value, sourceNums)) return true;
      // A percent matches its fraction form, and a bare fraction matches its percent form — so "40%",
      // a source "0.40", and an answer "0.40" against a source "40%" all compare equal (the bridge is
      // symmetric so neither direction is a false flag).
      if (f.isPercent && near(f.value / 100, sourceNums)) return true;
      if (!f.isPercent && f.value > 0 && f.value <= 1 && near(f.value * 100, sourceNums)) return true;
      if (derived === null) derived = buildDerived();
      return near(f.value, derived, DERIVED_TOLERANCE);   // exact arithmetic → tight match (see DERIVED_TOLERANCE)
    };
    const seen = new Set();
    const ungrounded = [];
    for (const f of figures) {
      if (grounded(f)) continue;
      if (seen.has(f.raw)) continue;
      seen.add(f.raw);
      ungrounded.push({ raw: f.raw, value: f.value });
    }
    return { checked: figures.length, ungrounded };
  } catch (_) {
    return { checked: 0, ungrounded: [] };   // best-effort: a check must never break answering
  }
};

// MAX_SCAN_CHARS is exported so faithfulness.js bounds the context it assembles to the SAME value this
// module re-slices to — otherwise the two 200000 caps could drift and faithfulness would build context the
// figure check then silently truncates. (MAGNITUDE_MULT / DEFAULT_TOLERANCE are internal only.)
module.exports = { extractNumbers, ungroundedFigures, MAX_SCAN_CHARS };
