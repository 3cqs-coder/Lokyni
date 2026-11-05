'use strict';
// Behavior + equivalence tests for the shared sliding-window scan helpers (lib/retrieval/keywords.js:
// scanWindowsMax / scanWindowsRanked). These replaced ~6 near-identical inline loops across search.js and
// passages.js. This locks in that the helpers produce EXACTLY what those loops did — a reference built from
// the pre-refactor form (slice + countOccurrences) is fuzz-compared to the helpers across unweighted, IDF-
// weighted, offset-start, early-exit, and exclude-position variants — and that the scan stays hard-bounded
// to KEYWORD_SCAN_MAX_CHARS so a huge document can never make it blow up. No model, no network.
// Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { scanWindowsMax, scanWindowsRanked, countOccurrences } = require(path.join(PROJECT, 'lib', 'retrieval', 'keywords'));
const { KEYWORD_SCAN_MAX_CHARS } = require(path.join(PROJECT, 'lib', 'retrieval', 'constants'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

// Reference implementations in the ORIGINAL inline form (slice + countOccurrences), so a match proves the
// helpers preserved the pre-refactor behavior rather than just agreeing with themselves.
const refScore = (lower, needles, pos, end, idf) =>
  needles.reduce((s, t) => s + countOccurrences(lower.slice(pos, end), t) * (idf ? (idf.get(t) ?? 1) : 1), 0);

const refMax = (lower, needles, { window, step = Math.floor(window / 4), start = 0, idf = null, stopAtScore = Infinity }) => {
  const limit = Math.min(lower.length, KEYWORD_SCAN_MAX_CHARS);
  const stepN = Math.max(1, Math.floor(step) || 1);
  let bestPos = start, bestScore = -1;
  for (let pos = start; pos < limit && bestScore < stopAtScore; pos += stepN) {
    const sc = refScore(lower, needles, pos, pos + window, idf);
    if (sc > bestScore) { bestScore = sc; bestPos = pos; }
  }
  return { pos: bestPos, score: bestScore };
};

const refRanked = (lower, needles, { window, step = Math.floor(window / 4), start = 0, idf = null, excludePos = null }) => {
  const limit = Math.min(lower.length, KEYWORD_SCAN_MAX_CHARS);
  const stepN = Math.max(1, Math.floor(step) || 1);
  const collect = (useExclude) => {
    const out = [];
    for (let pos = start; pos < limit; pos += stepN) {
      if (useExclude && excludePos != null && Math.abs(pos - excludePos) < window) continue;
      out.push([pos, refScore(lower, needles, pos, pos + window, idf)]);
    }
    return out;
  };
  let scores = collect(excludePos != null);
  if (scores.length === 0 && excludePos != null) scores = collect(false);
  scores.sort((a, b) => b[1] - a[1]);
  return scores;
};

try {
  const text = ('The quarterly revenue report shows revenue up. costs fell. revenue revenue. '
    + 'margins improved while revenue stayed flat. the revenue team met. ').repeat(60).toLowerCase();
  const idf = new Map([['revenue', 2.5], ['costs', 1.2], ['margins', 3.1], ['team', 0.8]]);

  // ── fuzz equivalence: helpers === the original inline form, across the real option combinations ──
  let maxCases = 0, maxMism = 0, rankCases = 0, rankMism = 0;
  for (const needles of [['revenue'], ['revenue', 'costs'], ['margins', 'team', 'revenue'], ['absent']]) {
    for (const window of [40, 200, 1500]) {
      for (const start of [0, 37, 900]) {
        for (const useIdf of [false, true]) {
          const optsBase = { window, start, idf: useIdf ? idf : null };
          // scanWindowsMax, including the early-exit (stopAtScore) variant used by the co-source gate.
          for (const stopAtScore of [Infinity, 3, 1]) {
            maxCases++;
            const a = scanWindowsMax(text, needles, { ...optsBase, stopAtScore });
            const b = refMax(text, needles, { ...optsBase, stopAtScore });
            if (a.pos !== b.pos || a.score !== b.score) maxMism++;
          }
          // scanWindowsRanked, including the exclude-position variant used by the keyword-location scan.
          for (const excludePos of [null, 0, 600]) {
            rankCases++;
            const a = scanWindowsRanked(text, needles, { ...optsBase, excludePos });
            const b = refRanked(text, needles, { ...optsBase, excludePos });
            if (JSON.stringify(a) !== JSON.stringify(b)) rankMism++;
          }
        }
      }
    }
  }
  ok(maxCases > 100 && maxMism === 0, `scanWindowsMax matches the reference across ${maxCases} cases (${maxMism} mismatches)`);
  ok(rankCases > 100 && rankMism === 0, `scanWindowsRanked matches the reference across ${rankCases} cases (${rankMism} mismatches)`);
  console.log('✓ scan-windows: both helpers reproduce the original inline-loop behavior exactly');

  // ── explicit behavior checks ──
  // Densest window wins; an empty/too-short text yields the sentinel (never throws).
  ok(scanWindowsMax('', ['x'], { window: 10 }).score === -1, 'an empty text returns the -1 sentinel, no throw');
  const ranked = scanWindowsRanked(text, ['revenue'], { window: 100 });
  ok(Array.isArray(ranked) && ranked.length > 1 && ranked[0][1] >= ranked[1][1], 'ranked results are sorted best-first');
  // stopAtScore returns as soon as a window reaches the threshold (used by the gate — never the full max).
  const gated = scanWindowsMax(text, ['revenue'], { window: 100, stopAtScore: 2 });
  ok(gated.score >= 2, 'stopAtScore returns a window that has reached the threshold');
  // excludePos skips windows near the excluded position; the fallback still returns something when all are near.
  const near = scanWindowsRanked(text, ['revenue'], { window: 100, excludePos: 50 });
  ok(near.every(([pos]) => Math.abs(pos - 50) >= 100), 'excludePos skips windows within one window of the excluded position');
  const allNear = scanWindowsRanked('revenue here', ['revenue'], { window: 10000, excludePos: 0 });
  ok(allNear.length > 0, 'when every window is excluded, the fallback scan still returns the full ranking');
  console.log('✓ scan-windows: densest-window, early-exit, and exclude-with-fallback behave correctly');

  // ── hard bound: a document longer than the cap is only scanned over its prefix ──
  const big = 'q'.repeat(KEYWORD_SCAN_MAX_CHARS + 50000) + ' needle';   // the needle sits BEYOND the cap
  const beyond = scanWindowsMax(big, ['needle'], { window: 500 });
  ok(beyond.score === 0, 'content past KEYWORD_SCAN_MAX_CHARS is never scanned (a needle beyond the cap is not found)');
  ok(scanWindowsRanked(big, ['needle'], { window: 500 }).every(([pos]) => pos < KEYWORD_SCAN_MAX_CHARS),
    'no ranked window position is at or past the scan cap');
  console.log('✓ scan-windows: the scan is hard-bounded to KEYWORD_SCAN_MAX_CHARS (OOM-safe on huge docs)');

  console.log(`\nALL SCAN-WINDOWS UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ SCAN-WINDOWS UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
