'use strict';
// Guards the unknown-named-subject gate's term extraction and vocabulary decision across scripts.
//
// The retrieval regression proves the gate end to end. This test isolates the pure helpers so a script
// regression (a casing rule that only works for Latin, a quoted name that stops being recognized, an
// acronym that starts hard-declining a valid expansion) fails directly and with a clear name.
//
// No model, network, or disk. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { extractNamedTerms, novelEntityGate } = require(path.join(PROJECT, 'lib', 'retrieval', 'search'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };
const eq = (a, b, msg) => { checks++; assert.deepStrictEqual(a, b, msg); };
const includes = (terms, value, msg) => ok(terms.some((t) => t.toLowerCase() === value.toLowerCase()), msg);

try {
  // ── Cased scripts: consecutive capitalized words form one name ──
  includes(extractNamedTerms('What is the launch code for Zephyria?'), 'Zephyria', 'Latin: a mid-sentence name is extracted');
  includes(extractNamedTerms('¿Cuál es el código del Proyecto Quilla?'), 'Proyecto Quilla', 'Spanish: adjacent capitalized words stay together');
  includes(extractNamedTerms('Wie lautet der Startcode für Projekt Falke?'), 'Projekt Falke', 'German: adjacent capitalized words stay together');
  includes(extractNamedTerms('Что такое Проект Вектор?'), 'Проект Вектор', 'Cyrillic: casing works beyond Latin');
  includes(extractNamedTerms('Ποιο είναι το σχέδιο Ορίων;'), 'Ορίων', 'Greek: casing works beyond Latin');

  // ── Any script: quoted names and letter-plus-digit identifiers ──
  includes(extractNamedTerms('ما هو رمز "زفيريا"؟'), 'زفيريا', 'Arabic: a quoted name is extracted without casing');
  includes(extractNamedTerms('What is the "麒麟" plan?'), '麒麟', 'Han: a quoted name is extracted without word spaces');
  includes(extractNamedTerms('What is the ZZ-0000 access phrase?'), 'ZZ-0000', 'identifier: a letter-plus-digit code is name-like');
  includes(extractNamedTerms('Show me ORB-7781.'), 'ORB-7781', 'identifier: a code at the end of a sentence is kept');

  // ── Conservative exclusions ──
  eq(extractNamedTerms('What is the launch code?'), [], 'ordinary words produce no name-like term');
  eq(extractNamedTerms('What is AI?'), [], 'a short all-caps acronym is left to semantic retrieval');
  eq(extractNamedTerms('What is NASA?'), [], 'a four-letter acronym is left to semantic retrieval');
  includes(extractNamedTerms('What is ORION?'), 'ORION', 'a five-letter all-caps name is still checked');
  eq(extractNamedTerms('Zephyria launch code?'), [], 'a sentence-initial capitalized word is not guessed to be a name');
  includes(extractNamedTerms("What does Zorvath's handbook say?"), "Zorvath's", 'a possessive keeps its base name');

  // ── The vocabulary decision ──
  const idf = new Map([
    ['launch', 1], ['code', 1], ['project', 1], ['zorvath', 1], ['zx', 1], ['9042', 1],
    ['مشروع', 1], ['صقر', 1], ['رمز', 1],
  ]);
  const idx = { corpusIdf: idf };
  const noCandidates = [];

  eq(novelEntityGate('What is the launch code for the Zephyria program?', idx, noCandidates),
    { terms: ['Zephyria'] }, 'an absent name in a familiar domain is blocked');
  eq(novelEntityGate('What is the launch code for Project Zorvath?', idx, noCandidates), null,
    'a known name is not blocked');
  eq(novelEntityGate('Compare Project Zorvath with the Zephyria program.', idx, noCandidates), null,
    'a known name alongside an unknown one is not blocked');
  eq(novelEntityGate('What is the ZZ-0000 access phrase?', idx, noCandidates),
    { terms: ['ZZ-0000'] }, 'an absent identifier is blocked');
  eq(novelEntityGate('What is the ZX-9042 code?', idx, noCandidates), null, 'a known identifier is not blocked');
  eq(novelEntityGate('ما هو رمز "زفيريا"؟', idx, noCandidates), { terms: ['زفيريا'] },
    'an absent quoted name in another script is blocked');
  eq(novelEntityGate('ما هو رمز "صقر"؟', idx, noCandidates), null, 'a known quoted name is not blocked');
  eq(novelEntityGate('What is the launch code?', idx, noCandidates), null, 'a question with no name is not blocked');
  eq(novelEntityGate('What is AI?', idx, noCandidates), null, 'a short acronym is not blocked');

  // A name indexed past the 50k BM25 head is still recognized when it appears in a top candidate chunk.
  const candidate = [[{ pageContent: 'The Zephyria program is described here.' }]];
  eq(novelEntityGate('What is the launch code for the Zephyria program?', idx, candidate), null,
    'a name present in a retrieved chunk is treated as known');
  eq(novelEntityGate('What is the launch code for Zephyria?', { corpusIdf: new Map() }, noCandidates), null,
    'an unbuilt vocabulary stays fail-open');

  // A document named in the question, but not in its text, is known through its file-name tokens.
  const namedIdx = {
    corpusIdf: new Map([['launch', 1], ['code', 1], ['program', 1]]),
    parentMap: new Map([['d1', { metadata: { source: '/corpus/orion-handbook.md' } }]]),
    lastIndexedAt: 1,
  };
  eq(novelEntityGate('What about the Orion program?', namedIdx, noCandidates), null,
    'a token from a document file name is treated as known');
  eq(novelEntityGate('What about the Zephyria program?', namedIdx, noCandidates), { terms: ['Zephyria'] },
    'an unknown name is still blocked when another file name exists');

  console.log(`\nALL NOVEL-ENTITY-GATE UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ NOVEL-ENTITY-GATE UNIT TEST FAILED:', e && e.message, e && e.stack);
  process.exit(1);
}
