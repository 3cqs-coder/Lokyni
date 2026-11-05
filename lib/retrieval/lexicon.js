'use strict';
// Single source of truth for every FIXED word list a retrieval decision depends on. The words themselves live in
// lib/ai/data/lexicon.json (externalized data, shipped with the build); this module loads them ONCE, turns each
// into a Set, and documents which DECISION each list serves. Keeping them here means a list is defined in exactly
// one place and read everywhere by name, so copies can never drift apart, and a new word or a new language is a
// data edit with no code change (future-proof).
//
// Each list is a SEPARATE decision — not one list reused five ways. They overlap because generic words are
// generic, but each is tuned for its own gate, so they are co-located (one file, named keys) rather than merged;
// merging would couple unrelated behavior. A genuine subject — a name, place, or domain term, in any language —
// is never listed in any of them, so it always survives as signal.
//
// Crash-proof: a missing or corrupt data file degrades to empty sets with one loud warning instead of failing to
// boot. Empty sets only weaken ranking heuristics (nothing is stripped); they never throw. The unit test
// (lexicon.test.js) and the syntax gate guarantee the file is present and well-formed in real builds, so this
// degraded path is only ever reached by a broken package.
//
// NOT here on purpose: the hands-free turn-detector's continuation words (lib/public/js/vad.js). That is a
// different decision (acoustic end-of-turn, not topic signal) with a single consumer, and vad.js must stay a
// pure, dependency-free UMD the browser loads as a plain script — it cannot synchronously require() this JSON.
// It is single-sourced in its own module and pinned by its own test; pulling it here would create a Node copy
// plus a browser fallback, i.e. the drift this file exists to prevent.

let data = {};
try {
  data = require('../ai/data/lexicon.json');
} catch (e) {
  try {
    console.warn(`⚠️  Lexicon data file lib/ai/data/lexicon.json could not be read (${e && e.message}). ` +
      `Retrieval word-lists are empty — generic-word stripping is disabled until it is restored. ` +
      `Check that lib/ai/data/ shipped in this build.`);
  } catch (_) { /* console may be unavailable */ }
}

// Build a read-only Set from a named list, tolerating a missing/mistyped key (empty set, not a crash). Each set is
// a SHARED singleton (Node caches this module), so a stray mutation in one consumer would corrupt every other
// consumer. The mutators are replaced to throw, turning that programming error into an immediate, obvious failure
// the test suite catches — never silent cross-module corruption. Reads (.has, iteration, .size) are unaffected.
const setOf = (name) => {
  const s = new Set(Array.isArray(data[name]) ? data[name] : []);
  const readOnly = () => { throw new Error(`lexicon "${name}" is a shared read-only set and must not be mutated`); };
  s.add = s.delete = s.clear = readOnly;
  return s;
};

module.exports = {
  // Topic-term extraction (keywords.js → extractSpecificKeywords): generic/function/meta words stripped before
  // IDF so a follow-up made only of them ("what else does it talk about", "cuéntame más") carries no specific
  // term — the language-agnostic signal that it names no new subject. Also covers the multilingual continuation
  // vocabulary, since those imperatives rarely appear in a document corpus.
  GENERIC_WORDS: setOf('genericWords'),
  // Topic-shift signal (search.js): request/meta words removed from a query's specific terms so only a real new
  // subject counts. Carries ending-intent vocabulary ("conclusion", "outcome") that topic-shift must ignore.
  REQUEST_WORDS: setOf('requestWords'),
  // Co-source raw-keyword fallback (search.js): generic words removed when picking RAW query tokens as a locating
  // signal for the co-source gate (used only when no IDF-specific keyword exists).
  STOP_WORDS_GATE: setOf('stopWordsGate'),
  // Proper-noun heuristic (search.js): capitalized words that begin sentences or are question words, so they are
  // not mistaken for a named entity / new topic.
  PROPER_NOUN_STOP: setOf('properNounStop'),
  // Grounding term-survival guard (intent.js): request/function words that must never, by themselves, trip the
  // guard — a real subject term has to survive into the resolved query.
  GROUNDING_STOP: setOf('groundingStop'),
  // Entity extraction (entities.js): common capitalized words that start sentences or are generic, never an
  // entity on their own.
  ENTITY_STOP_CAPS: setOf('entityStopCaps'),
  // Entity extraction (entities.js): small connector words that join tokens WITHIN one multi-word entity
  // ("Department of the Interior"); excludes "and"/"for", which separate entities in a list.
  ENTITY_CONNECTORS: setOf('entityConnectors'),
  // Similarity / near-duplicate scoring (similarity.js): function words removed before term overlap.
  SIMILARITY_STOPWORDS: setOf('similarityStopwords'),
  // Ending/recap detection (search.js): death/ending vocabulary used to tell whether a passage already shown
  // discussed the conclusion, so an "how did it end?" follow-up recaps rather than re-scanning.
  ENDING_DEATH_TERMS: setOf('endingDeathTerms'),
  // Connective/relational cue words (search.js): relate / connect / link / tie / associate / relationship, across
  // languages. Combined with "the query names two distinct subjects" they mark a two-sided relational question
  // ("how does A relate to B?"), which wants BALANCED retrieval of both subjects, just like an explicit compare.
  CONNECTIVE_CUES: setOf('connectiveCues'),
};
