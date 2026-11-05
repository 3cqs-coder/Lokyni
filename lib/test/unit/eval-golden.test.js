'use strict';
// Offline deterministic gate for the retrieval-eval golden set. The full evals (npm run eval / eval:recall)
// need a live model, so they do NOT run in CI — this unit test does, with no model and no network. It guards
// the golden set's INTEGRITY (so a drifted or malformed cases.json is caught here, not only when someone runs
// the live eval) and the hardened loader's FAIL-SAFE behavior (a bad file can never crash the harness). Run:
// `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const golden = require(path.join(PROJECT, 'lib', 'test', 'eval', 'golden'));
const FIXTURES = path.join(PROJECT, 'lib', 'test', 'eval', 'fixtures');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

try {
  // ── The real golden set loads, parses, and is non-trivial ──
  const { cases, conversations, corpusChecks } = golden.load();
  // Read the RAW file too, so the gate can see what the loader might have DROPPED (asserting only on the
  // loader's own output would be blind to a silent drop — exactly the bug class this gate must catch).
  const raw = JSON.parse(fs.readFileSync(path.join(PROJECT, 'lib', 'test', 'eval', 'cases.json'), 'utf-8'));
  ok(Array.isArray(raw.cases) && raw.cases.length >= 5, 'the raw golden set has a non-trivial number of cases');
  ok(Array.isArray(conversations), 'conversations is an array');
  ok(Array.isArray(corpusChecks), 'corpusChecks is an array');

  // THE no-silent-drop guard: the hardened loader must keep EVERY case. A mismatch means golden.VALID_EXPECT
  // drifted out of sync with the expectations cases.json uses (and run.js judges) — which would quietly
  // delete real eval cases, including the strongest fabrication traps.
  eq(cases.length, raw.cases.length, 'the hardened loader drops NO case from the golden set');

  // Every RAW expectation must be one the loader recognizes AND run.js's judge() handles — the direct
  // drift guard (its failure is what the drop above would have been a symptom of).
  const JUDGED = new Set(['answer', 'nodata', 'nofab', 'refuse']);   // mirrors run.js judge()
  for (const c of raw.cases) {
    ok(c && typeof c.query === 'string' && c.query.trim().length > 0, `raw case has a non-empty query: ${JSON.stringify(c && c.query)}`);
    ok(JUDGED.has(c.expect), `raw case "${c && c.query}" uses an expectation run.js judges (got ${c && c.expect})`);
    ok(golden.VALID_EXPECT.has(c.expect), `the loader recognizes expectation "${c && c.expect}" (so it is not dropped)`);
  }

  // Loaded cases: every expectDoc resolves to a real fixture, no duplicate queries, both halves present, and
  // the strongest trap (a refusal case carrying a forbid term) survives loading.
  const seen = new Set();
  let answers = 0, refuseTraps = 0, forbidTraps = 0;
  for (const c of cases) {
    ok(!seen.has(c.query), `no duplicate query: "${c.query}"`);
    seen.add(c.query);
    if (c.expectDoc) ok(fs.existsSync(path.join(FIXTURES, c.expectDoc)), `expectDoc resolves to a real fixture: ${c.expectDoc}`);
    if (c.expect === 'answer') { answers++; ok(c.expectDoc, `an 'answer' case names its expected document: "${c.query}"`); }
    else refuseTraps++;
    if (c.forbid.length > 0) forbidTraps++;
  }
  ok(answers >= 1, 'the golden set contains grounded-answer cases');
  ok(refuseTraps >= 1, 'the golden set contains refusal/no-fabrication traps');
  ok(forbidTraps >= 1, 'a refusal trap carrying a forbid term survives loading (the strongest honesty assertion)');

  // ── The loader FAIL-SAFES on bad input (deterministic, synthetic) ──
  eq(golden.normalizeCase(null), null, 'normalizeCase(null) → null');
  eq(golden.normalizeCase({ expect: 'answer' }), null, 'a case with no query is dropped');
  eq(golden.normalizeCase({ query: 'x', expect: 'bogus' }), null, 'a case with an unknown expectation is dropped');
  const norm = golden.normalizeCase({ query: '  trimmed  ', expect: 'answer', mustInclude: 'one', forbid: ['a', '', 2] });
  eq(norm.query, 'trimmed', 'the query is trimmed');
  assert.deepStrictEqual(norm.mustInclude, ['one'], 'a scalar mustInclude is coerced to an array'); checks++;
  assert.deepStrictEqual(norm.forbid, ['a', '2'], 'forbid is coerced to non-empty strings'); checks++;
  assert.deepStrictEqual(golden.validateCases('not an array'), [], 'validateCases of a non-array → []'); checks++;
  assert.deepStrictEqual(golden.validateCases([{ bad: true }, { query: 'ok', expect: 'answer' }]).length, 1, 'bad cases are dropped, good ones kept'); checks++;
  // A huge array is capped.
  const huge = Array.from({ length: golden.MAX_CASES + 50 }, (_, i) => ({ query: 'q' + i, expect: 'answer' }));
  ok(golden.validateCases(huge).length === golden.MAX_CASES, 'the case count is capped at MAX_CASES');
  // A missing / unreadable file yields empty sets, never a throw.
  const empty = golden.load(path.join(PROJECT, 'lib', 'test', 'eval', 'does-not-exist.json'));
  assert.deepStrictEqual(empty, { cases: [], conversations: [], corpusChecks: [] }, 'a missing file fails safe to empty sets'); checks++;

  // ── The harnesses load through the hardened loader (not a bare require of the raw JSON) ──
  const runSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'test', 'eval', 'run.js'), 'utf-8');
  const recallSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'test', 'eval', 'recall.js'), 'utf-8');
  ok(/require\('\.\/golden'\)\.load\(\)/.test(runSrc), 'run.js loads via the hardened loader');
  ok(/require\('\.\/golden'\)\.load\(\)/.test(recallSrc), 'recall.js loads via the hardened loader');

  console.log(`\nALL EVAL-GOLDEN TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ EVAL-GOLDEN UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
