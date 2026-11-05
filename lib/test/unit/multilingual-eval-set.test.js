'use strict';
// Offline guard for the multilingual retrieval eval SET (lib/test/eval/multilingual.js + its fixtures). It does
// not run the model — it checks the eval set is well-formed so a bad edit (a renamed fixture, a typo'd expectDoc,
// a stray group) is caught in CI rather than surfacing as a confusing miss when the slow eval is run by hand.
// Pure, offline, no model. All names are synthetic. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert'), fs = require('fs');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { CASES, FIXTURES_DIR, declineCases, journeys } = require(path.join(PROJECT, 'lib', 'test', 'eval', 'multilingual'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // The fixture corpus exists and every fixture is a readable, non-empty file.
  ok(fs.existsSync(FIXTURES_DIR) && fs.statSync(FIXTURES_DIR).isDirectory(), 'the multilingual fixtures directory exists');
  const fixtures = fs.readdirSync(FIXTURES_DIR).filter(f => fs.statSync(path.join(FIXTURES_DIR, f)).isFile());
  ok(fixtures.length >= 8, `fixtures cover several languages (${fixtures.length} documents)`);
  for (const f of fixtures) ok(fs.readFileSync(path.join(FIXTURES_DIR, f), 'utf-8').trim().length > 0, `fixture ${f} is non-empty`);
  const fixtureSet = new Set(fixtures);

  // The cases are well-formed: each has a query, an expectDoc that is a real fixture, and a known group.
  const GROUPS = new Set(['same-lang', 'cross-lingual']);
  ok(Array.isArray(CASES) && CASES.length >= 20, `the eval has a meaningful number of cases (${CASES.length})`);
  const seen = new Set();
  for (const c of CASES) {
    ok(typeof c.query === 'string' && c.query.trim().length > 0, 'each case has a non-empty query');
    ok(GROUPS.has(c.group), `case group is valid: ${JSON.stringify(c.group)}`);
    ok(fixtureSet.has(c.expectDoc), `case expectDoc "${c.expectDoc}" is a real fixture`);
    ok(!seen.has(c.query), `no duplicate case query: "${c.query.slice(0, 40)}"`);
    seen.add(c.query);
  }

  // Both groups are represented, and cross-lingual queries must NOT contain their target's subject name — a
  // cross-lingual case that names the subject would pass by lexical match and not test meaning alignment. The
  // subject is the fixture's name stem (e.g. "kaelthorn-de.md" → "kaelthorn").
  const byGroup = g => CASES.filter(c => c.group === g);
  ok(byGroup('same-lang').length >= 10, 'at least ten same-language cases');
  ok(byGroup('cross-lingual').length >= 10, 'at least ten cross-lingual cases');
  for (const c of byGroup('cross-lingual')) {
    const subject = c.expectDoc.replace(/-[a-z]{2}\.md$/i, '').replace(/\.md$/i, '');
    ok(!c.query.toLowerCase().includes(subject.toLowerCase()),
      `cross-lingual case must not name its subject "${subject}" (would pass by lexical match): "${c.query.slice(0, 40)}"`);
  }

  // Off-corpus honesty cases: these must be genuinely out-of-corpus (their answer is NOT in any fixture), so they
  // guard that cross-lingual mode never answers an unknown subject. Validate they are well-formed and that none
  // names a real fixture subject (which would make the "decline" expectation meaningless). They span scripts, so
  // the honesty guarantee is shown to hold across languages, not just English.
  ok(Array.isArray(declineCases) && declineCases.length >= 4, `there are off-corpus honesty cases (${declineCases && declineCases.length})`);
  const subjects = CASES.map(c => c.expectDoc.replace(/-[a-z]{2}\.md$/i, '').replace(/\.md$/i, '').toLowerCase());
  for (const c of declineCases) {
    ok(typeof c.query === 'string' && c.query.trim().length > 0, 'each decline case has a non-empty query');
    ok(!seen.has(c.query), `a decline case is not also a recall case: "${c.query.slice(0, 40)}"`);
    ok(!('expectDoc' in c), 'a decline case names no expected document (it must be declined, not served)');
    ok(!subjects.some(s => c.query.toLowerCase().includes(s)),
      `a decline case must not name a real corpus subject (it would not be off-corpus): "${c.query.slice(0, 40)}"`);
    seen.add(c.query);
  }

  // Multi-turn journeys: each is a named sequence of turns; every turn has a query, and any expectDoc/notExpectDoc
  // names a real fixture. These guard cross-lingual behavior ACROSS turns (continuation stays on the document).
  ok(Array.isArray(journeys) && journeys.length >= 1, `there are multi-turn journeys (${journeys && journeys.length})`);
  let journeyTurns = 0;
  for (const j of journeys) {
    ok(typeof j.name === 'string' && j.name.trim().length > 0, 'each journey has a name');
    ok(Array.isArray(j.turns) && j.turns.length >= 2, `journey "${j.name}" has at least two turns`);
    for (const t of j.turns) {
      journeyTurns++;
      ok(typeof t.query === 'string' && t.query.trim().length > 0, `each turn in "${j.name}" has a non-empty query`);
      if (t.expectDoc) ok(fixtureSet.has(t.expectDoc), `turn expectDoc "${t.expectDoc}" is a real fixture`);
      if (t.notExpectDoc) ok(fixtureSet.has(t.notExpectDoc), `turn notExpectDoc "${t.notExpectDoc}" is a real fixture`);
    }
  }

  console.log(`✓ multilingual-eval-set: ${fixtures.length} fixtures, ${CASES.length} cases ` +
    `(${byGroup('same-lang').length} same-lang, ${byGroup('cross-lingual').length} cross-lingual), ` +
    `${declineCases.length} off-corpus honesty cases, ${journeys.length} journeys (${journeyTurns} turns), all well-formed`);
  console.log(`\nALL MULTILINGUAL-EVAL-SET TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ MULTILINGUAL-EVAL-SET TEST FAILED:', e.message);
  process.exit(1);
}
