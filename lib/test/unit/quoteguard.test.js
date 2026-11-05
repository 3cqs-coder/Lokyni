'use strict';
// Guards the deterministic verbatim-quotation check. A substantial quoted span must appear in the text the
// model was actually served; otherwise a neutral caveat is added. Precision matters: punctuation, case, curly
// quotes, ellipses, and scripts without spaces must not create a false caveat, and a short scare quote or a
// quote inside code must be ignored. Missing/foreign served text must never produce a guess. No model, network,
// or disk. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const f = require(path.join(PROJECT, 'lib', 'faithfulness'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };

const content = 'The launch code is ZX-9042 and the team met on Tuesday. The project is on schedule.';
const idx = { parentMap: new Map([['d1', { content }]]) };
const sources = [{ id: 'd1', source: 'brief.pdf', servedRanges: [{ start: 0, end: content.length }] }];

try {
  // ── A real quotation is accepted, including typographic variations ──
  ok(f.checkQuotes('The lead said "The launch code is ZX-9042" in the brief.', sources, idx) === null,
    'an exact quotation is grounded');
  ok(f.checkQuotes('The lead said “the launch code is zx-9042!” in the brief.', sources, idx) === null,
    'case, curly quotes, and punctuation do not cause a false caveat');
  ok(f.checkQuotes('As noted: «The launch code is ZX-9042».', sources, idx) === null,
    'guillemets are recognized');
  ok(f.checkQuotes('As noted: "The launch code is ZX-9042 … the team met on Tuesday".', sources, idx) === null,
    'an ellipsis joining two served passages is accepted');

  // ── A fabricated quotation is caught, and only the quoted span is checked ──
  const fake = f.checkQuotes('The lead said "The launch code is AB-1111" in the brief.', sources, idx);
  ok(fake && fake.ungrounded.length === 1, 'a fabricated quotation is flagged');
  ok(/AB-1111/.test(fake.ungrounded[0].raw), 'the flagged report names the quotation');
  ok(/could not be found in the cited sources/.test(f.quoteCaveatFor('He said "The launch code is AB-1111".', sources, idx)),
    'a neutral caveat is produced');
  ok(f.checkQuotes('The lead said "The launch code is ZX-9042 … the launch code is AB-1111".', sources, idx) !== null,
    'one fabricated segment in an ellipsis-joined quotation is enough to flag it');

  // ── Precision guards: short quotes and code are not claims ──
  ok(f.checkQuotes('The code "ZX-9042" is in the brief.', sources, idx) === null,
    'a short term in quotes is not treated as a quotation');
  ok(f.checkQuotes('Example:\n```\n"The launch code is AB-1111"\n```\nEnd.', sources, idx) === null,
    'a quotation inside a fenced code block is ignored');
  ok(f.checkQuotes('Use `"The launch code is AB-1111"` as a placeholder.', sources, idx) === null,
    'a quotation inside inline code is ignored');
  eq(f.checkQuotes('No quotes here at all.', sources, idx), null, 'no substantial quote -> no report');

  // ── Only the SERVED range is checked, not the whole document ──
  const served = [{ id: 'd1', source: 'brief.pdf', servedRanges: [{ start: 0, end: 40 }] }];
  ok(f.checkQuotes('He said "the team met on Tuesday" in the brief.', served, idx) !== null,
    'a quotation outside the served range is flagged even though the full document contains it');

  // ── Missing/foreign served text is never guessed at ──
  eq(f.checkQuotes('He said "The launch code is AB-1111".', sources, { parentMap: new Map() }), null,
    'no resolvable served text -> no caveat');
  eq(f.checkQuotes('He said "The launch code is AB-1111".', [], idx), null,
    'no sources -> no caveat');
  eq(f.checkQuotes('He said "The launch code is AB-1111".', sources, undefined), null,
    'no index and an empty active corpus -> no caveat');

  // ── Scripts without spaces ──
  const cjk = '这是项目计划中非常重要的一部分内容，团队已经完成了审查。';
  const cjkIdx = { parentMap: new Map([['c1', { content: cjk }]]) };
  const cjkSrc = [{ id: 'c1', source: '计划.pdf', servedRanges: [{ start: 0, end: cjk.length }] }];
  ok(f.checkQuotes('报告指出「这是项目计划中非常重要的一部分内容」。', cjkSrc, cjkIdx) === null,
    'a CJK quotation is matched without requiring spaces');
  ok(f.checkQuotes('报告指出「这是完全不同且没有出现过的内容」。', cjkSrc, cjkIdx) !== null,
    'a fabricated CJK quotation is flagged');

  // ── Bounds: duplicates collapse and the list is capped ──
  const repeated = Array.from({ length: 30 }, () => '"The launch code is AB-1111"').join(' ');
  const ex = f.extractQuotes(repeated);
  eq(ex.length, 1, 'duplicate quotations collapse to one');

  console.log(`\nALL QUOTE-GUARD UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ QUOTE-GUARD UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
