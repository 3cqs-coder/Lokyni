'use strict';
// Guards the keyword/passage-location scan bound in lib/retrieval/search.js. Those helpers step a
// sliding window across a document's FULL text synchronously on the socket answer path. MAX_FILE_SIZE
// allows very large files, so an indexed multi-hundred-MB text file would freeze the event loop for
// every connected client. Each scan loop must cap its span at KEYWORD_SCAN_MAX_CHARS. The bug this
// guards against: a loop reintroduced with `pos < fullText.length` (or `parentEntry.content.length`)
// and no cap. Source inspection plus a check that the constant is sane. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const src = fs.readFileSync(path.join(PROJECT, 'lib', 'retrieval', 'search.js'), 'utf-8');
const passagesSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'retrieval', 'passages.js'), 'utf-8');
const keywordsSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'retrieval', 'keywords.js'), 'utf-8');
const { KEYWORD_SCAN_MAX_CHARS } = require(path.join(PROJECT, 'lib', 'retrieval', 'constants'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // The constant is sane (large enough to cover real documents, small enough to bound work).
  ok(Number.isFinite(KEYWORD_SCAN_MAX_CHARS) && KEYWORD_SCAN_MAX_CHARS >= 500000 && KEYWORD_SCAN_MAX_CHARS <= 20000000,
    'KEYWORD_SCAN_MAX_CHARS is a sane bound (0.5–20 MB)');

  // The sliding-window scan is now implemented ONCE, in keywords.js (scanWindowsMax / scanWindowsRanked),
  // and BOTH helpers cap their span via Math.min(lower.length, KEYWORD_SCAN_MAX_CHARS) — so every caller is
  // bounded by construction, not by each remembering to cap its own loop. (Behavior equivalence to the old
  // inline loops is proven in scan-windows.test.js.)
  ok(/const scanWindowsMax = /.test(keywordsSrc) && /const scanWindowsRanked = /.test(keywordsSrc),
    'the shared sliding-window scan helpers live in keywords.js');
  const capCount = (keywordsSrc.match(/Math\.min\(lower\.length,\s*KEYWORD_SCAN_MAX_CHARS\)/g) || []).length;
  ok(capCount >= 2, `both scan helpers cap their span via Math.min(lower.length, KEYWORD_SCAN_MAX_CHARS) (found ${capCount})`);

  // The callers go through the shared helpers and no longer hand-roll a scan loop that could be
  // reintroduced uncapped (`pos < fullText.length` / `parentEntry.content.length`, stepping by a window).
  ok(/scanWindowsMax\(|scanWindowsRanked\(/.test(src), 'search.js scans via the shared helpers');
  ok(/scanWindowsMax\(/.test(passagesSrc), 'passages.js scans via the shared helper');
  const uncapped = src.match(/for \(let pos = [^;]+; pos < (?:fullText\.length|parentEntry\.content\.length)[^;]*; pos \+=/g) || [];
  ok(uncapped.length === 0, `search.js has no uncapped full-length scan loop (found ${uncapped.length})`);
  const uncappedP = passagesSrc.match(/for \(let pos = [^;]+; pos < fullText\.length[^;]*; pos \+=/g) || [];
  ok(uncappedP.length === 0, `passages.js has no uncapped full-length scan loop (found ${uncappedP.length})`);

  console.log('✓ search-scan-bound: the scan is single-sourced in keywords.js and hard-bounded for every caller');

  // The scan LOOP being bounded is not enough: lowercasing the WHOLE document to feed those loops is
  // itself an unbounded synchronous cost on a huge file. The per-candidate keyword/entity gates must use
  // the bounded lower (boundedLowerOf), and the standalone location scanners must use boundedLower(text) —
  // never a full content.toLowerCase()/fullText.toLowerCase(), which would reintroduce the whole-document
  // copy on the answer path for candidates the gate then rejects.
  // The one full-document lowercase (the memoized full-lower reserved for passage extraction of surviving
  // documents) is itself hard-bounded by FULL_LOWER_MAX_CHARS, so even that path cannot lowercase + scan an
  // unbounded document; and no UNBOUNDED whole-content lowercase remains.
  ok(/const FULL_LOWER_MAX_CHARS\s*=\s*\d/.test(src), 'a hard ceiling FULL_LOWER_MAX_CHARS is defined');
  ok(!/parentEntry\.content\.toLowerCase\(\)/.test(src), 'no unbounded parentEntry.content.toLowerCase() remains');
  const boundedFullLower = (src.match(/content\.slice\(0, FULL_LOWER_MAX_CHARS\)/g) || []).length;
  ok(boundedFullLower === 1, `the full-document lowercase is bounded by FULL_LOWER_MAX_CHARS, exactly once (found ${boundedFullLower})`);
  const fullTextLower = (src.match(/fullText\.toLowerCase\(\)/g) || []).length;
  ok(fullTextLower === 0, `no scanner lowercases the whole fullText — all use boundedLower(text) (found ${fullTextLower})`);
  const gateBounded = (src.match(/boundedLowerOf\(\)/g) || []).length;
  ok(gateBounded >= 2, `the named-entity and co-source gates read the bounded lower, not the full document (found ${gateBounded})`);
  console.log('✓ search-scan-bound: the gates lowercase only a bounded prefix, never the whole document');

  // The sliding-window scans count keyword hits over a RANGE of the bounded lower string in place, rather
  // than allocating an overlapping substring per window step (~4x char copies + GC churn on a large doc).
  // countOccurrencesInRange must stay exactly equivalent to slice()+countOccurrences, and no scan site may
  // reintroduce a per-window fullLower.slice(pos, ...).
  const { countOccurrences, countOccurrencesInRange } = require(path.join(PROJECT, 'lib', 'retrieval', 'keywords'));
  const hay = ('abcab aabbaa xyzabcabc ab a ').repeat(40);
  let mism = 0, fuzz = 0;
  for (const n of ['ab', 'a', 'abc', 'aa', 'zz', '']) {
    for (let st = 0; st < hay.length; st += 11) {
      for (const w of [1, 4, 13, 100, 5000]) {
        fuzz++;
        if (countOccurrences(hay.slice(st, st + w), n) !== countOccurrencesInRange(hay, n, st, st + w)) mism++;
      }
    }
  }
  ok(fuzz > 500 && mism === 0, `countOccurrencesInRange equals slice()+countOccurrences across ${fuzz} cases (${mism} mismatches)`);
  // The shared helper counts in place over a RANGE of the bounded lower string; it must not reintroduce a
  // per-window substring allocation (~4x char copies + GC churn on a large doc), in the helper OR a caller.
  ok(!/\.slice\(pos,\s*(?:pos\s*\+|end)/.test(keywordsSrc), 'the scan helper allocates no per-window substring');
  ok(!/fullLower\.slice\(pos/.test(src) && !/fullLower\.slice\(pos/.test(passagesSrc), 'no caller reintroduces a per-window substring');
  ok(/countOccurrencesInRange\(lower,/.test(keywordsSrc), 'the shared scan helper uses the allocation-free range counter');
  console.log('✓ search-scan-bound: the window scan counts in place (no per-window slice), equivalent to the slice form');
  console.log(`\nALL SEARCH-SCAN-BOUND UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ SEARCH-SCAN-BOUND UNIT TEST FAILED:', e.message);
  process.exit(1);
}
