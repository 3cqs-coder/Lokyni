'use strict';
// Guards that the per-item extraction caches (OCR, visual-ingest, document summary) can be scoped to
// a specific workspace's cache directory. When the API warms a NON-active workspace, loadSingleDocument
// passes that workspace's cache dir so its OCR/visual/summary results — and the figure crops keyed
// alongside them — are written into THAT workspace's directory, not the active one's. Without this a
// background warm polluted the active caches and saved figure crops away from the manifest that
// references them (so those figures could never be found). A scoped write is BATCHED in memory and
// flushed ONCE at warm-end (the per-set flush was O(K²) across a K-document warm); it stays isolated to
// its own directory. No model or network; uses temp dirs and the caches' own dir override.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const ocr = require(path.join(PROJECT, 'lib', 'ocrcache'));
const visual = require(path.join(PROJECT, 'lib', 'visualcache'));
const summary = require(path.join(PROJECT, 'lib', 'summarycache'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

const A = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-wsA-'));
const B = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-wsB-'));
const cleanup = (code) => {
  for (const d of [A, B]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  process.exit(code);
};

try {
  const buf = Buffer.from('the quick brown fox jumped over the lazy dog, repeatedly, for OCR.');

  // ── OCR cache: a scoped write batches in memory, reads back immediately, and persists on flush ──
  const kOcr = ocr.keyFor(buf);
  ocr.set(kOcr, 'OCR TEXT A', A);
  ok(ocr.get(kOcr, A) === 'OCR TEXT A', 'the scoped OCR entry reads back from its own dir before flush (batched in memory)');
  ok(!fs.existsSync(path.join(A, 'ocr-cache.json')), 'a scoped OCR write does NOT rewrite the file per set (batched, not per-item flushed)');
  ocr.flush(A);   // warm-end flush (what the bundle warm now calls once, instead of flushing per document)
  ok(fs.existsSync(path.join(A, 'ocr-cache.json')), 'the warm-end flush writes the scoped OCR cache to the target dir');
  ok(ocr.get(kOcr, A) === 'OCR TEXT A', 'the scoped OCR entry reads back after flush');
  ok(ocr.get(kOcr, B) === null, 'the OCR entry is NOT visible from a different workspace dir (isolated)');
  ok(!fs.existsSync(path.join(B, 'ocr-cache.json')), 'writing workspace A never created a cache file in workspace B');

  // ── Visual cache: same isolation, and the figure manifest round-trips (after the warm-end flush) ──
  const kVis = visual.keyFor(buf);
  visual.set(kVis, 'VISUAL DESC A', [{ id: 'fig1' }], A);
  visual.flush(A);
  ok(fs.existsSync(path.join(A, 'visual-cache.json')), 'the warm-end flush writes the scoped visual cache to the target dir');
  const recA = visual.getRecord(kVis, A);
  ok(recA && recA.text === 'VISUAL DESC A' && Array.isArray(recA.figures) && recA.figures[0].id === 'fig1',
    'the scoped visual record (text + figure manifest) reads back from its own dir');
  ok(visual.getRecord(kVis, B) === null, 'the visual entry is isolated to workspace A');

  // ── Summary cache: same isolation ──
  const kSum = summary.keyFor('a long enough document body to summarize into a labeled block');
  summary.set(kSum, 'SUMMARY A', A);
  summary.flush(A);
  ok(summary.get(kSum, A) === 'SUMMARY A', 'the scoped summary reads back from its own dir');
  ok(summary.get(kSum, B) === null, 'the summary entry is isolated to workspace A');

  // ── Source guard: loadSingleDocument resolves the target workspace dir and threads it through ──
  const files = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'files.js'), 'utf-8');
  ok(/require\('\.\.\/workspaces'\)\.cacheDirFor\(cfg\.DATA_DIR, opts\.workspaceId\)/.test(files)
    && /if \(target && target !== cfg\.CACHE_DIR\) cacheDir = target;/.test(files),
    'loadSingleDocument resolves the non-active workspace cache dir (and only when it differs from active)');
  ok(/processFileContent\(buffer, ext, filePath, cacheDir\)/.test(files),
    'the cache dir is threaded into inline extraction');
  ok(/describePdfVisuals\(buffer, filePath, cacheDir\)/.test(files) && /describeOfficeImages\(buffer, filePath, cacheDir\)/.test(files),
    'the cache dir is threaded into visual ingest (so figure crops land in the right workspace)');
  ok(/summaryBlockFor\(content, filePath, cacheDir\)/.test(files), 'the cache dir is threaded into document summary');
  ok(/cache\.set\(cache\.keyFor\(buffer\), content, cacheDir\)/.test(files), 'the isolated-image vision fallback caches into the right workspace');

  // ── Source guard: the bundle warm flushes the scoped caches ONCE at warm-end (the batched writes above must
  //    have a guaranteed flush point, or they would never reach disk for a non-active workspace warm). ──
  const bundleSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'bundle.js'), 'utf-8');
  ok(/require\('\.\.\/ocrcache'\)\.flush\(cacheDir\)/.test(bundleSrc)
    && /require\('\.\.\/summarycache'\)\.flush\(cacheDir\)/.test(bundleSrc)
    && /require\('\.\.\/visualcache'\)\.flush\(cacheDir\)/.test(bundleSrc),
    'the bundle warm flushes the OCR, summary, and visual caches once at warm-end');

  console.log(`\nALL CACHE-WORKSPACE-SCOPING UNIT TESTS PASSED (${checks} checks)`);
  cleanup(0);
} catch (e) {
  console.error('\n✗ CACHE-WORKSPACE-SCOPING UNIT TEST FAILED:', e && e.message);
  cleanup(1);
}
