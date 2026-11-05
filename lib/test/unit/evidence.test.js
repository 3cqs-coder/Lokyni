'use strict';
// Guards evidence snapshots for scheduled automations: stable source identities, content fingerprints,
// added/removed/changed detection, the answer-change flag, the plain-text note, and bounds. Also guards the
// wiring so a saved question persists its snapshot and reports the diff in the delivered body.
// No model, network, or disk. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');
const ev = require(path.join(PROJECT, 'lib', 'evidence'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };

const aText = 'The launch code is ZX-9042 and the review is on Tuesday.';
const bText = 'The approved budget is 7.5 million dollars for the year.';
const cText = 'The vendor contract renews in March next year.';
const idx = { parentMap: new Map([
  ['a', { content: aText }],
  ['b', { content: bText }],
  ['c', { content: cText }],
]) };
const src = (id, label, text) => ({ id, source: label, servedRanges: [{ start: 0, end: text.length }] });

try {
  // ── A snapshot is stable and carries no document text ──
  const first = ev.snapshot([src('a', 'Brief.md', aText), src('b', 'Budget.xlsx', bText)], idx, 'The launch code is ZX-9042.');
  eq(first.entries.length, 2, 'every cited source is recorded');
  ok(first.entries.every((e) => e.key && e.label && /^[a-f0-9]{16}$/.test(e.digest)), 'each entry has a key, label, and short digest');
  ok(!JSON.stringify(first).includes('9042'), 'the snapshot stores no source text');
  eq(first.entries.map((e) => e.key).join(','), [...first.entries.map((e) => e.key)].sort().join(','),
    'entries are sorted by key for stable comparison');

  // ── First run has nothing to compare, so no note ──
  const d0 = ev.diff(undefined, first);
  ok(d0.first, 'a first run is marked as such');
  eq(ev.note(d0), '', 'a first run adds no header');

  // ── Added, removed, changed, and an answer change are all detected ──
  const changedA = 'The launch code is ZX-9042 and the review moved to Thursday.';
  const idx2 = { parentMap: new Map([
    ['a', { content: changedA }],
    ['c', { content: cText }],
  ]) };
  const second = ev.snapshot([src('a', 'Brief.md', changedA), src('c', 'Vendor.md', cText)], idx2, 'The launch code is ZX-9042.');
  const d = ev.diff(first, second);
  eq(d.added, ['Vendor.md'], 'a newly cited source is listed');
  eq(d.removed, ['Budget.xlsx'], 'a source no longer cited is listed');
  eq(d.changed, ['Brief.md'], 'a cited source whose served text changed is listed');
  eq(d.answerChanged, false, 'an identical answer is not marked changed');
  ok(d.any, 'any difference is summarized');
  const note = ev.note(d);
  ok(/^Evidence since the last run:/.test(note), 'the header is explicit');
  ok(/New source: Vendor\.md/.test(note) && /No longer cited: Budget\.xlsx/.test(note) && /Changed source: Brief\.md/.test(note),
    'each kind of change is named');

  // ── An answer change alone is reported, and no change says so ──
  const third = ev.snapshot([src('a', 'Brief.md', changedA), src('c', 'Vendor.md', cText)], idx2, 'A different answer.');
  const d2 = ev.diff(second, third);
  eq(d2.answerChanged, true, 'an answer change is detected');
  ok(/The answer changed\./.test(ev.note(d2)), 'the note says the answer changed');
  const d3 = ev.diff(third, third);
  ok(!d3.any, 'an identical run has no differences');
  ok(/No change in sources or answer\./.test(ev.note(d3)), 'the note states that nothing changed');

  // ── Bounds: entries and labels are capped ──
  const many = Array.from({ length: 80 }, (_, i) => src(`d${i}`, `Source ${i}`, `text ${i}`));
  const big = ev.snapshot(many, { parentMap: new Map(many.map((s) => [s.id, { content: `text ${s.id}` }])) }, 'x');
  eq(big.entries.length, ev.MAX_ENTRIES, 'the entry list is capped');
  const longLabel = ev.labelOf({ source: 'x'.repeat(500) });
  ok(longLabel.length <= 160 && /…$/.test(longLabel), 'a long label is shortened');
  eq(ev.keyOf({ id: 'd1' }), 'doc:d1', 'a document keys by its stable id');
  eq(ev.keyOf({ url: 'https://example.org/x' }), 'web:https://example.org/x', 'a web page keys by URL');
  eq(ev.keyOf({ id: 'web-0', isWeb: true, url: 'https://example.org/x' }), 'web:https://example.org/x',
    'a web source ignores its per-answer id, which is not stable across runs');
  eq(ev.keyOf(null), '', 'a missing source has no key');
  eq(ev.snapshot(null, null, '').entries.length, 0, 'missing sources produce an empty snapshot without throwing');

  // ── Wired into a saved-question automation ──
  const auto = read('lib/automations.js');
  ok(/const evidence = require\('\.\/evidence'\)/.test(auto), 'the automation uses the shared evidence module');
  ok(/evidence\.snapshot\(r\.sources \|\| \[\], r\.idx, body\)/.test(auto), 'each query run snapshots its cited evidence');
  ok(/evidence\.diff\(rec\.evidenceSnapshot, snap\)/.test(auto), 'it compares against the saved snapshot');
  ok(/body: evidence\.note\(d\) \+ body/.test(auto), 'the delivered body opens with the change note');
  ok(/\.\.\.\(result\.snapshot \? \{ evidenceSnapshot: result\.snapshot \} : \{\}\)/.test(auto),
    'the snapshot is persisted for the next run');
  ok(/Evidence\s+since\s+the\s+last\s+run/.test(read('docs/README.md')), 'the guide documents the change header');

  console.log(`\nALL EVIDENCE-SNAPSHOT UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ EVIDENCE-SNAPSHOT UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
