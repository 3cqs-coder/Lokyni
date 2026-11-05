'use strict';
// Unit tests for the suggested-follow-up parser (lib/suggest.js parseSuggestions). No
// network and no model call — the parser turns a raw multi-line LLM response into a clean,
// de-duplicated, capped list of short questions, dropping bullets, numbering, quotes, and a
// restatement of the original question. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { parseSuggestions } = require(path.join(PROJECT, 'lib', 'suggest'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };
const eq = (a, b, msg) => { checks++; assert.strictEqual(a, b, msg); };

try {
  // ── bullets, numbering, and quotes are stripped ──
  const a = parseSuggestions(
    '1. What was the total budget?\n- How did revenue change?\n* "When was it approved?"',
    'Summarize the report'
  );
  eq(a.length, 3, 'three questions parsed');
  eq(a[0], 'What was the total budget?', 'leading "1." removed');
  eq(a[1], 'How did revenue change?', 'leading "-" removed');
  eq(a[2], 'When was it approved?', 'surrounding quotes removed');
  console.log('✓ suggest: strips bullets, numbering, and quotes');

  // ── caps at three, drops duplicates and the original question ──
  const b = parseSuggestions(
    'Same question?\nSame question?\nOriginal query\nSecond question?\nThird question?\nFourth question?',
    'original query'
  );
  ok(b.length <= 3, 'never returns more than three');
  ok(!b.some(q => q.toLowerCase() === 'original query'), 'the original question is excluded');
  eq(new Set(b.map(s => s.toLowerCase())).size, b.length, 'no duplicates');
  console.log('✓ suggest: caps at three, drops duplicates and the original question');

  // ── empty / junk input yields an empty list ──
  eq(parseSuggestions('', 'q').length, 0, 'empty input -> []');
  eq(parseSuggestions(null, 'q').length, 0, 'null input -> []');
  eq(parseSuggestions('- \n* \n1. ', 'q').length, 0, 'bullets with no content -> []');
  console.log('✓ suggest: empty and junk inputs yield an empty list');

  // ── over-long questions are clamped, not dropped ──
  const long = 'A'.repeat(300) + '?';
  const c = parseSuggestions(long, 'q');
  eq(c.length, 1, 'a long line still yields one question');
  ok(c[0].length <= 100, 'the question is clamped to the max length');
  console.log('✓ suggest: over-long questions are clamped');

  console.log(`\nALL SUGGEST UNIT TESTS PASSED (${checks} checks)`);
  process.exitCode = 0;
} catch (e) {
  console.error('\n✗ SUGGEST UNIT TEST FAILED:', e && e.message);
  process.exitCode = 1;
}
