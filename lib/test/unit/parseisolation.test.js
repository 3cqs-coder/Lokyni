'use strict';
// Drift guard for parse isolation. Most document formats are parsed in an isolated, memory-capped
// child process only once they cross the large-file threshold, because their hazard is memory, which
// scales with size. Two formats are the exception and are isolated at ANY size: spreadsheets (the
// bundled SheetJS build carries content-triggered advisories a tiny crafted workbook can trip) and
// PDFs (the parser has no decompression-budget guard and a crafted small PDF can drive it into
// pathological, synchronous CPU that a JS timeout cannot interrupt). This test locks that in, plus
// the untrusted-upload isolation, the worker-timeout behavior, the office-image zip guard, and the
// single-sourced text cap. No model or network. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const extractcore = require(path.join(PROJECT, 'lib', 'indexing', 'extractcore'));
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

try {
  // The always-isolate set exists and names the content-hazard formats (spreadsheets and PDF).
  ok(extractcore.ALWAYS_ISOLATE instanceof Set, 'ALWAYS_ISOLATE is a Set');
  for (const ext of ['.xlsx', '.xlsm', '.pdf']) {
    ok(extractcore.ALWAYS_ISOLATE.has(ext), `force-isolated at any size: ${ext}`);
  }

  // Everything force-isolated must also be isolatable, or the isolate decision's ISOLATABLE gate
  // would exclude it and the force never takes effect.
  for (const ext of extractcore.ALWAYS_ISOLATE) {
    ok(extractcore.ISOLATABLE.has(ext), `ALWAYS_ISOLATE subset of ISOLATABLE: ${ext}`);
  }

  // A purely size-gated format (hazard is memory, handled off-thread by the worker) stays out of the
  // always-isolate set so it still parses on the fast path when small.
  ok(!extractcore.ALWAYS_ISOLATE.has('.json'), 'JSON is size-gated, not force-isolated');

  // Replicate the isolate predicate: a tiny spreadsheet or PDF isolates; a tiny JSON does not.
  const wouldIsolate = (ext, size, minBytes) =>
    extractcore.ISOLATABLE.has(ext) && (extractcore.ALWAYS_ISOLATE.has(ext) || size >= (minBytes || 0));
  ok(wouldIsolate('.xlsx', 1, 4 * 1024 * 1024) === true, 'a 1-byte .xlsx is isolated despite being below the threshold');
  ok(wouldIsolate('.pdf', 1, 4 * 1024 * 1024) === true, 'a 1-byte .pdf is isolated (force-isolated, content hazard)');
  ok(wouldIsolate('.json', 1, 4 * 1024 * 1024) === false, 'a 1-byte .json is not force-isolated (below the threshold)');

  // Untrusted uploads (/attach) do not go through the size-gated folder path, so heavy parsers are
  // isolated there explicitly. The route must call the isolated extractor, not the inline one.
  const filesSrc = read('lib/indexing/files.js');
  // The upload-isolation set is derived from extractcore.ISOLATABLE (minus images) so it can't drift from the
  // main pipeline's isolation list when a heavy format is added.
  ok(/extractUploadText/.test(filesSrc) && /isolateOnUpload\(\)/.test(filesSrc)
    && /\[\.\.\.ec\.ISOLATABLE\]\.filter\(\(e\) => !ec\.IMAGE_EXTS\.has\(e\)\)/.test(filesSrc),
    'files.js has the isolated upload extractor, deriving the set from extractcore (no hardcoded copy)');
  // The upload staging temp goes in DATA_DIR/tmp/uploads with a .tmp suffix (which the stale-temp watchdog
  // scans), NOT os.tmpdir() with the document's extension (which the watchdog can't reclaim on a hard crash).
  ok(/path\.join\(require\('\.\.\/config'\)\.DATA_DIR, 'tmp', 'uploads'\)/.test(filesSrc)
    && /lokyni-attach-[^`]*\.tmp`/.test(filesSrc) && !/os\.tmpdir\(\)/.test(filesSrc),
    'the upload staging temp lives under DATA_DIR/tmp/uploads as a .tmp (watchdog-reclaimable), not os.tmpdir()');
  const docsRoute = read('lib/routes/documents.js');
  ok(/extractUploadText\(req\.file\.buffer/.test(docsRoute), 'the /attach route uses the isolated upload extractor');
  ok(!/processFileContent\(req\.file\.buffer/.test(docsRoute), 'the /attach route no longer parses uploads inline');

  // A worker timeout must terminate the (hung) worker rather than re-running the same heavy parse
  // inline on the main thread.
  ok(/timed out[\s\S]*terminate\(\)/.test(read('lib/workerrpc.js')), 'workerrpc terminates a worker that blew its deadline');
  const parseworker = read('lib/indexing/parseworker.js');
  // The inline re-parse must run ONLY when the worker was unavailable (nothing ran). A timeout OR a worker
  // DEATH (an OOM crash on this input) must NOT re-run the same heavy parse on the main thread — both would
  // just stall or crash it. So the fallback is gated on e.unavailable, not on e.timeout.
  ok(/if \(e && e\.unavailable\) return _core\(\)\.xlsxToText/.test(parseworker) && /if \(e && e\.unavailable\) return _core\(\)\.jsonToText/.test(parseworker),
    'parseworker only re-parses inline when the worker was unavailable (not on timeout or death)');
  ok(/Object\.assign\(new Error\(`\$\{this\.name\} worker unavailable`\), \{ unavailable: true \}\)/.test(read('lib/workerrpc.js')),
    'workerrpc tags the unavailable rejection so callers can distinguish it from a death/timeout');

  // The office visual-ingest image path (main process) vets the archive for a zip bomb before it
  // inflates any media entry.
  ok(/zipWithinBudget\(buffer\)/.test(read('lib/indexing/officedocs.js')), 'office visual ingest guards the archive with zipWithinBudget');

  // The per-file text cap is single-sourced in parsecore and imported by extractcore (no drift).
  const parsecore = read('lib/indexing/parsecore.js');
  ok(/module\.exports = \{[^}]*capText/.test(parsecore), 'parsecore exports the shared capText');
  ok(/require\('\.\/parsecore'\)[\s\S]*capText/.test(read('lib/indexing/extractcore.js')) || /\{\s*capText\s*\}\s*=\s*require\('\.\/parsecore'\)/.test(read('lib/indexing/extractcore.js')), 'extractcore imports capText from parsecore');

  console.log(`\nALL PARSE-ISOLATION UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ PARSE-ISOLATION UNIT TEST FAILED:', e.message);
  process.exit(1);
}
