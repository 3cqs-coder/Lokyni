'use strict';
// Guards the two-sided RELATIONAL intent detector (search.js isConnectiveTwoSided). A question that asks how two
// subjects relate — "how does A relate to B?", "connect A with B", "the relationship between A and B" — must be
// treated like an explicit "compare A and B" so retrieval serves BOTH subjects, not just the dominant one. The
// precision guard is "names two distinct subjects": a connective word with fewer than two subjects ("connect to
// the server", a pronoun continuation "how does that relate to B") must NOT be mistaken for a comparison. Pure,
// offline, no model. All names are synthetic. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { isConnectiveTwoSided } = require(path.join(PROJECT, 'lib', 'retrieval', 'search'));

const fails = [];
const expect = (q, want) => { const got = isConnectiveTwoSided(q); if (got !== want) fails.push(`  ✗ expected ${want}, got ${got}: "${q}"`); };

try {
  // TWO-SIDED relational questions (two synthetic subjects + a connective cue) → treat as comparison.
  const TWO_SIDED = [
    'how does Vexmor relate to Qubblen?',
    'connect Vexmor with Qubblen',
    'how is Vexmor linked to Qubblen?',
    'associate Vexmor with Qubblen',
    'tie Vexmor to Qubblen',
    'what is the relationship between Vexmor and Qubblen?',
    'what connection is there between Vexmor and Qubblen',
    'correlate Vexmor and Qubblen',
    'how does "Mibbly Crystal" relate to "Thaloria Works"?',   // quoted names (any script)
  ];
  for (const q of TWO_SIDED) expect(q, true);

  // Multilingual: the connective cue in the corpus/query language, two synthetic subjects → still two-sided. The
  // subject detection is language-agnostic (cased/quoted names), so only the cue word needs to be listed.
  const MULTILINGUAL = [
    '¿cómo se relaciona Vexmor con Qubblen?',   // es
    'quel est le lien entre Vexmor et Qubblen',  // fr
    'welche Beziehung besteht zwischen Vexmor und Qubblen',  // de
    'qual é a relação entre Vexmor e Qubblen',   // pt
    'che relazione c\'è tra Vexmor e Qubblen',   // it
    'какая связь между Vexmor и Qubblen',        // ru (Cyrillic cue)
  ];
  for (const q of MULTILINGUAL) expect(q, true);

  // NOT two-sided — the precision guard. A connective word but fewer than two named subjects, or no cue at all.
  const NOT_TWO_SIDED = [
    'connect to the server',                      // cue, zero named subjects
    'how does it relate to this',                 // cue, pronouns only
    'how does that relate to Qubblen?',           // cue, ONE named subject (a continuation)
    'what is the relationship status',            // cue, zero named subjects
    'tell me about Vexmor',                        // one subject, no cue
    'summarize Vexmor and Qubblen',               // two subjects but NO connective cue (a list, not a relation)
    'a pair of shoes',                             // no cue, no subjects
    'what did Vexmor establish about settlement',  // one subject, no cue
  ];
  for (const q of NOT_TWO_SIDED) expect(q, false);

  if (fails.length) {
    console.error(`\n✗ RELATION-INTENT — ${fails.length} failure(s):\n` + fails.join('\n'));
    process.exit(1);
  }
  console.log(`✓ relation-intent: ${TWO_SIDED.length} English + ${MULTILINGUAL.length} multilingual two-sided ` +
    `relational questions route to comparison; ${NOT_TWO_SIDED.length} near-misses correctly do not`);
  console.log('\nALL RELATION-INTENT TESTS PASSED');
  process.exit(0);
} catch (e) {
  console.error('\n✗ RELATION-INTENT TEST ERROR:', e && e.stack || e);
  process.exit(1);
}
