'use strict';
// Lightweight, dependency-free entity extraction for the entity-graph phase.
//
// An efficient entity graph needs cheap entity extraction rather than a model call per chunk.
// A grammar library would do this, but Lokyni minimizes dependencies, so this does the
// equivalent with a pure-JS proper-noun / acronym scan — no model call and no new package. It
// is deliberately precision-leaning: it keeps multi-word capitalized phrases ("Acme
// Corporation", "Project Titan", "Bank of America"), acronyms ("NASA", "GDPR"), and single
// capitalized words only when they repeat (a lone sentence-initial capital is usually not an
// entity). That is enough to build a useful co-occurrence graph for "how are X and Y related"
// questions without the cost or fragility of LLM-based extraction.

// Lowercase connector words allowed INSIDE a proper-name phrase ("Bank of America",
// "Department of the Interior"). Deliberately excludes "and"/"&"/"for", which join separate
// entities in a list ("Globex Industries and NASA") rather than naming one.
// Connector words that join tokens WITHIN one multi-word entity, and common capitalized words that are never an
// entity on their own. Both are single-sourced as data in lib/ai/data/lexicon.json via the shared lexicon loader.
const { ENTITY_CONNECTORS: CONNECTORS, ENTITY_STOP_CAPS: STOP_CAPS } = require('./lexicon');

// Unicode-aware token handling. Cased scripts beyond Latin (Cyrillic, Greek, Armenian, and accented
// Latin) are real name-bearing scripts; the old ASCII-only rules discarded them before graph matching.
// Scripts without case (Han, Arabic, Devanagari, and similar) still need a name signal the extractor
// cannot infer from capitalization, so they remain outside this lightweight pass.
const cleanToken = (t) => String(t).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'’.-]+$/gu, '');
const isCapWord = (t) => /^\p{Lu}[\p{L}\p{N}\p{M}'’.-]*$/u.test(t) && t.replace(/[^\p{L}\p{N}]/gu, '').length >= 2;
const isAcronym = (t) => /^[\p{Lu}\p{N}]{2,6}s?$/u.test(t) && /\p{Lu}/u.test(t);
// NFC (not NFKD) keeps Indic vowel signs and other combining marks intact. Latin accents remain
// distinct here; the graph's own name matcher handles diacritic folding where it is appropriate.
const normKey = (name) => String(name).normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}&]+/gu, ' ').trim();

// Extract entities from text. Returns [{ name, key, count }] sorted by frequency, capped at
// `max`. `name` is the display form (first-seen casing), `key` the normalized match key.
const extractEntities = (text, { max = 30 } = {}) => {
  const words = String(text || '').split(/\s+/);
  const found = new Map();   // key -> { name, count }
  const bump = (rawName) => {
    // Trim trailing sentence punctuation from the DISPLAY name (a name may keep internal dots,
    // e.g. "U.S.A."), while the normalized key drops all punctuation anyway.
    const name = String(rawName).replace(/[.,;:!?]+$/, '').trim();
    const key = normKey(name);
    if (!key || key.length < 2) return;
    // Drop a single word that's a common capitalized stopword.
    if (!key.includes(' ') && STOP_CAPS.has(key)) return;
    const e = found.get(key);
    if (e) e.count++; else found.set(key, { name, count: 1 });
  };

  let phrase = [];
  const flush = () => {
    // A phrase is real if it has 2+ capitalized words (drop trailing connectors first).
    while (phrase.length && CONNECTORS.has(phrase[phrase.length - 1].toLowerCase())) phrase.pop();
    while (phrase.length && CONNECTORS.has(phrase[0].toLowerCase())) phrase.shift();
    const caps = phrase.filter(w => !CONNECTORS.has(w.toLowerCase()));
    if (caps.length >= 2) bump(phrase.join(' '));
    else if (caps.length === 1 && isAcronym(caps[0])) bump(caps[0]);   // a standalone acronym (NASA, GDPR)
    phrase = [];
  };

  for (let raw of words) {
    const t = cleanToken(raw);
    // A token that ended the sentence/clause (trailing . , ; : ! ?) closes the run AFTER it,
    // so a name can't bleed across a boundary ("Project Titan. Globex Industries" → two).
    const endsClause = /[.,;:!?]$/.test(raw);
    if (!t) { flush(); continue; }
    if (isCapWord(t)) { phrase.push(t); if (endsClause) flush(); continue; }
    if (phrase.length && !endsClause && CONNECTORS.has(t.toLowerCase())) { phrase.push(t.toLowerCase()); continue; }
    // Not part of a phrase: close any run, then record standalone acronyms.
    flush();
    if (isAcronym(t)) bump(t);
  }
  flush();

  // Single capitalized words that REPEAT are likely real entities (a name, a product), so add
  // them from a second pass — but only if they didn't already appear inside a multi-word phrase.
  const singleCounts = new Map();
  for (const raw of words) {
    const t = cleanToken(raw);
    if (isCapWord(t) && !isAcronym(t)) {
      const k = normKey(t);
      if (k && !STOP_CAPS.has(k)) singleCounts.set(k, (singleCounts.get(k) || 0) + 1);
    }
  }
  for (const [k, n] of singleCounts) {
    if (n >= 3 && !found.has(k) && ![...found.keys()].some(fk => fk.includes(' ' + k) || fk.includes(k + ' '))) {
      // Recover the display casing from the first occurrence.
      const disp = words.map(cleanToken).find(w => normKey(w) === k) || k;
      found.set(k, { name: disp, count: n });
    }
  }

  return [...found.entries()]
    .map(([key, v]) => ({ key, name: v.name, count: v.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, max);
};

module.exports = { extractEntities, normKey };
