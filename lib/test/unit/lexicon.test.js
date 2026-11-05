'use strict';
// Guards the shared word lexicon (lib/ai/data/lexicon.json + lib/retrieval/lexicon.js) — the single source of
// truth for every fixed word list a retrieval decision depends on. It checks the data file is well-formed, every
// decision's list is present and non-trivial, the loader turns each into a Set, and a few sentinel words are where
// they must be — so a bad data edit (a dropped key, an accidental subject word) is caught here, not in production.
// Pure, offline, no model. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert'), fs = require('fs');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const DATA = path.join(PROJECT, 'lib', 'ai', 'data', 'lexicon.json');
const L = require(path.join(PROJECT, 'lib', 'retrieval', 'lexicon'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

try {
  // The data file exists, parses, and every value is an array of non-empty strings.
  ok(fs.existsSync(DATA), 'lexicon.json exists');
  const raw = JSON.parse(fs.readFileSync(DATA, 'utf-8'));
  for (const [key, arr] of Object.entries(raw)) {
    ok(Array.isArray(arr) && arr.length > 0, `${key} is a non-empty array`);
    ok(arr.every(w => typeof w === 'string' && w.length > 0), `${key} holds only non-empty strings`);
  }

  // The loader exposes a Set for every decision, each populated.
  const EXPECTED = ['GENERIC_WORDS', 'REQUEST_WORDS', 'STOP_WORDS_GATE', 'PROPER_NOUN_STOP',
    'GROUNDING_STOP', 'ENTITY_STOP_CAPS', 'ENTITY_CONNECTORS', 'SIMILARITY_STOPWORDS', 'ENDING_DEATH_TERMS',
    'CONNECTIVE_CUES'];
  for (const name of EXPECTED) {
    ok(L[name] instanceof Set && L[name].size > 0, `${name} is a non-empty Set`);
  }
  console.log(`✓ lexicon: ${EXPECTED.length} word lists load from data as non-empty Sets`);

  // Sentinel membership — the continuation-classification guarantees depend on these. Generic/meta/multilingual
  // continuation words MUST be present (so a follow-up made of them carries no topic signal); subject-like words
  // MUST be absent (so a real subject always survives as signal).
  const mustHave = ['talk', 'else', 'about', 'what', 'more', 'continue', 'continua', 'más', 'mehr', 'больше', 'cuéntame'];
  for (const w of mustHave) ok(L.GENERIC_WORDS.has(w), `GENERIC_WORDS contains the generic/continuation word "${w}"`);
  const mustNotHave = ['tokenization', 'settlement', 'vexmor', 'ledger', 'protocol', 'quantum'];
  for (const w of mustNotHave) ok(!L.GENERIC_WORDS.has(w), `GENERIC_WORDS must NOT contain the subject word "${w}"`);
  console.log('✓ lexicon: generic/continuation words present, subject words absent (classification invariant)');

  // The entity connector list must not swallow list separators ("and"/"for") that join SEPARATE entities.
  ok(!L.ENTITY_CONNECTORS.has('and') && !L.ENTITY_CONNECTORS.has('for'), 'ENTITY_CONNECTORS excludes list separators');

  // The sets are shared singletons, so they must be read-only — a stray mutation would corrupt every consumer.
  let threw = false;
  try { L.GENERIC_WORDS.add('__mutation__'); } catch (_) { threw = true; }
  ok(threw && !L.GENERIC_WORDS.has('__mutation__'), 'a shared lexicon set rejects mutation (read-only singleton)');

  console.log(`\nALL LEXICON UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ LEXICON UNIT TEST FAILED:', e.message);
  process.exit(1);
}
