'use strict';
// Guards citation-offset integrity in getPassageContext (lib/retrieval/passages.js). The ranges it
// returns become the citation offsets and are re-sliced by the raw /search API, so they must describe
// EXACTLY the text that was served — not the full merged set. When the character budget truncates, the
// trailing passages are never served and the last one is clipped; returning the un-clipped/undropped
// ranges would make a citation (and the API's re-slice) point at text the model never saw. This test
// drives getPassageContext with a hand-built passage map (no model/index) and asserts the returned
// ranges match the emitted text exactly. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { getPassageContext } = require(path.join(PROJECT, 'lib', 'retrieval', 'passages'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

// A long document with NO blank-line breaks, so the paragraph snapping is a no-op and the windows are
// deterministic. Fill with a repeating non-'\n\n' pattern.
const fullText = 'x '.repeat(15000);   // 30000 chars, no "\n\n"
// Two chunks far apart (non-contiguous → they won't merge, which is >200 chars apart).
const bundle = { passageMap: new Map([
  ['a', { startChar: 1000, endChar: 1100 }],
  ['b', { startChar: 20000, endChar: 20100 }],
]) };

const SEP = '\n\n---\n\n';

try {
  // ── Untruncated: both windows fit; ranges describe exactly the served text ──
  {
    const r = getPassageContext('doc', ['a', 'b'], fullText, 12000, bundle);
    ok(r && Array.isArray(r.ranges), 'returns text + ranges');
    // Every returned range lies within the document and its slice appears in the served text.
    for (const [s, e] of r.ranges) {
      ok(s >= 0 && e <= fullText.length && e > s, `range [${s},${e}] is within the document`);
      ok(r.text.includes(fullText.slice(s, e)), 'each returned range slice is present in the served text');
    }
    // The served text length equals the sum of range lengths plus the separators between them.
    const sumLen = r.ranges.reduce((n, [s, e]) => n + (e - s), 0);
    eq(r.text.length, sumLen + SEP.length * (r.ranges.length - 1), 'served text length == sum of range lengths + separators');
    console.log('✓ passages-offsets: untruncated ranges describe exactly the served text');
  }

  // ── Truncated by a small budget: the far window is dropped and/or the last is clipped ──
  {
    const budget = 4000;
    const r = getPassageContext('doc', ['a', 'b'], fullText, budget, bundle);
    const sumLen = r.ranges.reduce((n, [s, e]) => n + (e - s), 0);
    ok(sumLen <= budget, `emitted ranges stay within the ${budget}-char budget (got ${sumLen})`);
    // No returned range may extend past what is actually in the served text.
    for (const [s, e] of r.ranges) ok(r.text.includes(fullText.slice(s, e)), 'a truncated result still only reports ranges that are in the text');
    // The far second window (start 20000) must NOT be reported as fully served when the budget was spent
    // on the first — its emitted end cannot exceed start+remaining.
    const reportsUnservedTail = r.ranges.some(([s, e]) => s === 20000 && e - s > budget);
    ok(!reportsUnservedTail, 'a range never reports more than the budget allowed for it');
    console.log('✓ passages-offsets: a budget-truncated result reports only the ranges actually served');
  }

  // ── No matched chunks with a resolvable offset → null (caller falls back) ──
  {
    const r = getPassageContext('doc', ['missing'], fullText, 12000, bundle);
    ok(r === null, 'no resolvable chunk offsets returns null');
    console.log('✓ passages-offsets: unresolvable chunks return null');
  }

  // ── Sibling guard: the keyword/retry passage helpers in search.js record a range whose end is CLAMPED to
  //    the document length. They serve fullText.slice(start, start+WINDOW) (clamped) but used to record
  //    end = start+WINDOW unclamped, over-reporting the citation span (viewer highlight past EOF, "%
  //    through document" over 100%) for a window running past the end. These helpers are internal to
  //    search.js and not reachable without an index, so this guards the clamp at the source instead. ──
  {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(PROJECT, 'lib', 'retrieval', 'search.js'), 'utf-8');
    const clampCount = (src.match(/const end = Math\.min\(fullText\.length, (?:startPos|chosen\[0\]) \+ WINDOW\)/g) || []).length;
    ok(clampCount >= 3, `the three keyword/retry passage helpers clamp the recorded range end to the text length (found ${clampCount})`);
    ok(!/end: (?:startPos|chosen\[0\]) \+ WINDOW \}/.test(src),
      'no keyword/retry helper records an unclamped end: start + WINDOW range');
    console.log('✓ passages-offsets: the keyword/retry helpers clamp the recorded citation range to the document length');
  }

  console.log(`\nALL PASSAGES-OFFSETS UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ PASSAGES-OFFSETS UNIT TEST FAILED:', e && e.message, e && e.stack);
  process.exit(1);
}
