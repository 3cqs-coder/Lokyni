'use strict';
// Guards per-citation attribution: deterministic sentence-to-source matching, the precision/recall/F1
// definitions, exact served-text scoping, web-source fallback, scripts without spaces, and total handling of
// empty/garbage input. Also guards that the Quality evaluation panel reports it from the same definition.
// No model, network, or disk. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');
const at = require(path.join(PROJECT, 'lib', 'attribution'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };
const near = (a, b, m) => { checks++; assert.ok(Math.abs(a - b) <= 0.002, `${m} (got ${a}, expected ~${b})`); };

const aText = 'The Orion Project launch code is ZX-9042. The review meeting is on Tuesday morning.';
const bText = 'The approved budget is 7.5 million dollars for the coming year.';
const idx = { parentMap: new Map([
  ['a', { content: aText }],
  ['b', { content: bText }],
]) };
const sources = [
  { id: 'a', source: 'Orion brief.md', servedRanges: [{ start: 0, end: aText.length }] },
  { id: 'b', source: 'Budget.xlsx', servedRanges: [{ start: 0, end: bText.length }] },
];

try {
  // ── Sentence splitting is decimal- and script-safe ──
  eq(at.sentencesOf('The budget is 7.5 million dollars. It grew.').length, 2, 'a decimal point does not split a sentence');
  eq(at.sentencesOf('这是项目计划。团队已经完成。').length, 2, 'CJK punctuation splits without a space');
  eq(at.sentencesOf('').length, 0, 'empty text has no sentences');

  // ── Both citations used → perfect attribution ──
  const perfect = at.attribute('The launch code is ZX-9042. The approved budget is 7.5 million dollars.', sources, idx);
  eq(perfect.precision, 1, 'every sentence is attributable');
  eq(perfect.recall, 1, 'every citation supports something');
  eq(perfect.f1, 1, 'both used → F1 1');
  eq(perfect.unused, [], 'no citation is reported unused');

  // ── One citation used, one padded → recall (and F1) drop ──
  const padded = at.attribute('The launch code is ZX-9042.', sources, idx);
  eq(padded.precision, 1, 'the only sentence is attributable');
  eq(padded.recall, 0.5, 'one of two citations supported nothing');
  near(padded.f1, 0.667, 'F1 reflects the padded citation');
  eq(padded.unused, ['Budget.xlsx'], 'the unused citation is named');

  // ── An unsupported sentence lowers precision ──
  const mixed = at.attribute('The launch code is ZX-9042. The moon is made of cheese and glass.', [sources[0]], idx);
  eq(mixed.precision, 0.5, 'an unattributable sentence lowers precision');
  eq(mixed.recall, 1, 'the single citation is still used');
  near(mixed.f1, 0.667, 'F1 combines the two');

  // ── Only the SERVED text counts, not the whole document ──
  const part = [{ id: 'a', source: 'Orion brief.md', servedRanges: [{ start: 0, end: 50 }] }];
  const notServed = at.attribute('The review meeting is on Tuesday morning.', part, idx);
  eq(notServed.f1, 0, 'a sentence outside the served range is unattributed');
  eq(notServed.usedCount, 0, 'the citation supported nothing');

  // ── Web sources fall back to their own text (no document entry) ──
  const web = at.attribute('The launch code is ZX-9042.', [{ id: 'w', source: 'Example', isWeb: true, text: aText }], { parentMap: new Map() });
  eq(web.f1, 1, 'a web source with text is attributable');

  // ── Scripts without spaces ──
  const cjkText = '这是项目计划中非常重要的一部分内容，团队已经完成了审查。';
  const cjkIdx = { parentMap: new Map([['c', { content: cjkText }]]) };
  const cjk = at.attribute('这是项目计划中非常重要的一部分内容。', [{ id: 'c', source: '计划.pdf', servedRanges: [{ start: 0, end: cjkText.length }] }], cjkIdx);
  eq(cjk.f1, 1, 'a CJK sentence is attributed');
  const cjkBad = at.attribute('这是完全不同且没有出现过的内容。', [{ id: 'c', source: '计划.pdf', servedRanges: [{ start: 0, end: cjkText.length }] }], cjkIdx);
  eq(cjkBad.f1, 0, 'a fabricated CJK sentence is unattributed');

  // ── Nothing to score → null, never a throw ──
  eq(at.attribute('', sources, idx), null, 'an empty answer has nothing to attribute');
  eq(at.attribute('The launch code is ZX-9042.', [], idx), null, 'no sources → null');
  eq(at.attribute('The launch code is ZX-9042.', [{ id: 'x' }], { parentMap: new Map() }), null, 'no resolvable text → null');
  eq(at.attribute(null, null, null), null, 'missing input is handled safely');

  // ── Wired into the Quality evaluation from one definition ──
  const m = require(path.join(PROJECT, 'lib', 'evalmetrics'));
  ok(m.METRIC_KEYS.includes('citationAttribution'), 'the metric is part of the evaluation averages');
  ok(/citationAttribution: attr \? attr\.f1 : null/.test(read('lib/eval.js')), 'the run scores it from attribution.attribute');
  ok(/entry\.citationAttribution = \{[\s\S]{0,300}?unused: attr\.unused/.test(read('lib/eval.js')),
    'the per-question detail keeps the unused citations');
  const chat = read('lib/public/js/chat.js');
  ok(/citationAttribution: 'Citation attribution F1'/.test(read('lib/evalmetrics.js')), 'the metric label lives with the metric definition');
  ok(/EVAL_METRICS = data\.metrics\.map/.test(chat), 'the dashboard renders the server metric catalog');
  ok(/citation\$\{ca\.unused\.length === 1 \? '' : 's'\} unused/.test(chat), 'the breakdown names unused citations');
  ok(/METRIC_LABELS: LABELS/.test(read('lokyni.js')), 'the CLI reports the metric from the shared label catalog');
  ok(/Citation attribution F1/.test(read('docs/README.md')), 'the guide documents the metric');

  console.log(`\nALL ATTRIBUTION UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ ATTRIBUTION UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
