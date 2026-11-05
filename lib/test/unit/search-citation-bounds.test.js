'use strict';
// Guards four correctness/OOM fixes in the core retrieval pipeline (lib/retrieval/search.js) that live deep in
// searchDocuments/_followUpPassage/ephemeralRetrieve and can't be isolated without the full index+model stack.
// The citation/offset BEHAVIOR is covered by passages-offsets/citations-ux; this pins the specific fixes so a
// refactor can't silently reintroduce them:
//   • the cited-span summary uses min(start)/max(end) over served windows (serve order != document order) so it
//     can never invert (start > end) and produce a broken viewer highlight;
//   • sequential follow-up reading can reach the final ~5% of a large document (the ending), not clip it away;
//   • on-the-fly attachment retrieval bounds its INPUT before chunking+embedding (no OOM on a huge attachment);
//   • the empty-retrieval conversation-doc fallback records the contiguous slice it actually served.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const src = fs.readFileSync(path.join(PROJECT, 'lib', 'retrieval', 'search.js'), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // F1 — cited span is min/max over served windows, not first/last in serve order.
  ok(/const pStarts = \(Array\.isArray\(passages\) \? passages : \[\]\)\.map\(p => p && p\.start\)\.filter\(Number\.isFinite\)/.test(src),
    'the cited-span start is the MIN over served windows');
  ok(/const passageStart = pStarts\.length \? Math\.min\(\.\.\.pStarts\) : 0;/.test(src) &&
     /const passageEnd   = pEnds\.length \? Math\.max\(\.\.\.pEnds\) : 0;/.test(src),
    'the cited span uses min(start)/max(end) so it cannot invert');
  ok(!/const passageStart = passages\?\.\[0\]\?\.start/.test(src), 'the old first/last serve-order span is gone');

  // F2 — the maxSafe clip no longer strands the document tail.
  ok(/nextEnd > maxSafe && nextEnd < fullText\.length && nextStart < maxSafe/.test(src),
    'the trailing-sentence clip is skipped once the window start is in the tail (the ending stays reachable)');

  // F3 — ephemeral attachment retrieval bounds its input before chunk+embed.
  ok(/EPHEMERAL_SCAN_MAX = 2 \* 1024 \* 1024/.test(src), 'ephemeral retrieval caps the scanned attachment text');
  ok(/const scanText = \(typeof text === 'string' \? text : ''\)\.slice\(0, EPHEMERAL_SCAN_MAX\)/.test(src),
    'the attachment is sliced to the cap BEFORE splitText (no unbounded chunk/embed allocation)');
  ok(/chunks\.length > MAX_EPHEMERAL_CHUNKS\) chunks = chunks\.slice\(0, MAX_EPHEMERAL_CHUNKS\)/.test(src),
    'the chunk count is also hard-capped (belt-and-suspenders against a tiny CHUNK_TARGET)');

  // F8 — the empty-retrieval fallback records the contiguous served range.
  ok(/conversationContext\.docPassages\.set\(aDocId, \[\{ start: rStart, end: rEnd \}\]\)/.test(src),
    'the empty-retrieval conversation-doc fallback records the contiguous slice it served (citation matches)');

  console.log(`✓ search-citation-bounds: span cannot invert, the ending stays reachable, attachments are input-bounded, the fallback citation matches (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('✗ search-citation-bounds:', e && e.message);
  process.exit(1);
}
