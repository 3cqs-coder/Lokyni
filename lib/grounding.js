'use strict';
// Citation guard — flag any document the ANSWER names that was NOT among the retrieved
// sources. Citing a file that was never retrieved is an invented citation, one of the most
// damaging document-Q&A fabrications, and it is invisible to a numbers/egress check.
//
// Precise by design, because Lokyni has twice removed over-eager substring checks that
// false-flagged ordinary prose: this matches ONLY filename-like tokens (a name ending in a
// known document extension), which are distinctive, and treats a cited file as present unless
// its base name matches no retrieved source either way (equal, or one containing the other).
// So a real citation never trips it, and only a genuinely absent file is flagged. It only
// adds a short note to the answer — it never blocks, alters, or retries it. Never throws.

// A filename-like token: name characters (no spaces, so it can't swallow the surrounding
// sentence) followed by a document extension. Built from the ONE canonical format list
// (lib/constants.js), so adding a format updates this guard automatically and an unsupported
// format (for example .rtf) is never mistaken for a retrievable source. Longest extension first
// so `tiff` wins over `tif` and `html` over `htm`; a multi-word real filename still matches via
// the lenient base-name comparison below on its trailing token.
const { SUPPORTED_EXTENSIONS, OCR_EXTENSIONS, MEDIA_EXTENSIONS } = require('./constants');
const { escapeRegExp } = require('./retrieval/keywords');
const CITATION_EXTENSIONS = [...new Set([...SUPPORTED_EXTENSIONS, ...OCR_EXTENSIONS, ...MEDIA_EXTENSIONS])]
  .map((e) => String(e).replace(/^\./, '').toLowerCase())
  .sort((a, b) => b.length - a.length)
  .map((e) => escapeRegExp(e));
const FILE_RE = new RegExp(
  `([A-Za-z0-9][\\w.()\\-\\[\\]&]{0,120}?\\.(?:${CITATION_EXTENSIONS.join('|')}))\\b`, 'gi');

// Base name, lowercased (drops any directory prefix and surrounding space).
const base = (p) => String(p || '').toLowerCase().replace(/^.*[\\/]/, '').trim();

// Does `full` (a retrieved source's base name, which may contain spaces) match the cited `tail`? The answer's
// FILE_RE captures only no-space tokens, so a space-separated source filename ("annual report summary.pdf")
// surfaces in the answer as just its trailing token ("summary.pdf"); we must still treat that as present.
// Match ONLY when `tail` is a whole trailing token of `full` — equal, or preceded by a whitespace/path
// separator. Crucially NOT an arbitrary substring (the old two-way `includes`): a hyphen/underscore is part of
// one filename token, so a fabricated "summary.pdf" must NOT match a real "annual-report-final-summary.pdf",
// and a real "a.pdf" must NOT make a fabricated "data.pdf" look present.
const matchesCited = (full, tail) => {
  if (full === tail) return true;
  if (!full.endsWith(tail)) return false;
  const prev = full[full.length - tail.length - 1];
  return prev === ' ' || prev === '\t' || prev === '/' || prev === '\\';
};

// Return the distinct file names the answer cites that are absent from every retrieved
// source. Empty when nothing is cited or every citation is a real source.
function citedButAbsentSources(answer, sources) {
  try {
    const text = String(answer || '');
    if (!text) return [];
    const known = [];
    for (const s of (sources || [])) {
      if (!s) continue;
      const b = base(s.source) || base(s.path) || base(s.id);
      if (b) known.push(b);
    }
    const flagged = [], seen = new Set();
    let m;
    FILE_RE.lastIndex = 0;
    while ((m = FILE_RE.exec(text)) !== null) {
      const name = m[1].trim();
      const key = base(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      // Present if the cited name equals a retrieved source base name, or is the whole trailing token of a
      // space-separated one (see matchesCited) — not merely a substring of it.
      const present = known.some(k => matchesCited(k, key));
      if (!present) flagged.push(name);
    }
    return flagged;
  } catch (_) {
    return [];
  }
}

// A short, plain caveat for the flagged names, or '' when there is nothing to add.
function caveatFor(answer, sources) {
  const absent = citedButAbsentSources(answer, sources);
  if (!absent.length) return '';
  const list = absent.slice(0, 5).join(', ');
  return `\n\n_Note: this answer refers to ${absent.length === 1 ? 'a document' : 'documents'} not among your retrieved sources (${list}). Treat ${absent.length === 1 ? 'it' : 'them'} with caution — ${absent.length === 1 ? 'it' : 'they'} may not be in your library._`;
}

module.exports = { citedButAbsentSources, caveatFor };
