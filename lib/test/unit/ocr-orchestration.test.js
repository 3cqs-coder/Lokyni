'use strict';
// Unit test for the shared OCR orchestration helpers (lib/ocr.js: ocrPdfCombined, ocrImageCached) — the single
// home for scan-detection + content-hash OCR cache + combine, used by BOTH the inline parse path (files.js) and
// the isolated child (extractcore.js). Stubs the OCR cache so a "hit" returns a known value and the recognizer
// (Tesseract) is never invoked, then drives the pure combine + cache-hit logic. A source guard pins that both
// callers route through the one leaf. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert'), fs = require('fs');
const PROJECT = path.resolve(__dirname, '..', '..', '..');

// Stub the OCR cache before ocr.js lazily requires it, so a cache "hit" returns our value and no recognizer
// runs. Each test file runs in its own process (see run.js), so this require.cache edit is isolated.
let _cacheGet = () => null;
let _setCalls = [];
require.cache[require.resolve(path.join(PROJECT, 'lib', 'ocrcache'))] = {
  id: 'ocrcache-stub', filename: 'ocrcache-stub', loaded: true, exports: {
    keyFor: () => 'k',
    get: (...a) => _cacheGet(...a),
    set: (...a) => { _setCalls.push(a); },
  },
};
const ocr = require(path.join(PROJECT, 'lib', 'ocr'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

(async () => {
  try {
    const buf = Buffer.from('bytes');
    const bigText = 'word '.repeat(500);   // ~2500 chars on 1 page → clearly a text layer, not a scan

    // ── ocrPdfCombined ──
    _cacheGet = () => { throw new Error('the cache must not be consulted when the PDF is not scanned'); };
    eq(await ocr.ocrPdfCombined(buf, bigText, 1), bigText, 'a text-layer PDF is returned as-is (not scanned → no OCR, no cache)');

    // Scanned (short/empty text over several pages) + a cache HIT → combine the cached OCR with the base text.
    _cacheGet = () => 'RECOGNIZED'; _setCalls = [];
    eq(await ocr.ocrPdfCombined(buf, 'BASE', 5), 'BASE\n\nRECOGNIZED', 'scanned + base text → base joined with the recognized text');
    eq(await ocr.ocrPdfCombined(buf, '', 5), 'RECOGNIZED', 'scanned + no base text → just the recognized text');
    eq(_setCalls.length, 0, 'a cache hit never re-writes the cache');
    _cacheGet = () => '';
    eq(await ocr.ocrPdfCombined(buf, 'BASE', 5), 'BASE', 'an empty recognized result returns the base text (no trailing separator)');

    // ── ocrImageCached ──
    _cacheGet = () => 'IMG-OCR'; _setCalls = [];
    eq(await ocr.ocrImageCached(buf), 'IMG-OCR', 'an image OCR cache hit returns the cached text');
    eq(_setCalls.length, 0, 'an image cache hit never re-OCRs or re-writes');
    console.log('✓ ocr-orchestration: ocrPdfCombined + ocrImageCached combine and cache correctly (no recognizer on a hit)');

    // ── Source guard: both the inline path and the isolated child route through the shared leaf ──
    const ec = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'extractcore.js'), 'utf-8');
    const filesSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'files.js'), 'utf-8');
    ok(/ocrPdfCombined\(buffer, r\.text, r\.pages\)/.test(ec), 'extractcore routes scanned-PDF OCR through the shared ocrPdfCombined');
    ok(/ocrImageCached\(buffer\)/.test(ec), 'extractcore routes image OCR through the shared ocrImageCached');
    ok(/ocrPdfCombined\(buffer, baseText, pages, \{ fileName, cacheDir \}\)/.test(filesSrc),
      'the inline ocrPdfFallback delegates to the shared ocrPdfCombined (no private scan/cache copy)');
    console.log('✓ ocr-orchestration: the inline path and the isolated child share one OCR orchestration leaf');

    console.log(`\nALL OCR-ORCHESTRATION UNIT TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ OCR-ORCHESTRATION UNIT TEST FAILED:', e && e.message);
    process.exit(1);
  }
})();
