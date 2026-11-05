'use strict';
// Guards the memory-bounded OCR path and the "never give up on a document" fallback.
//
// A scanned PDF is OCR'd inside a resource-capped child process. Rendering every page up front held the
// whole document's bitmaps in memory at once, which on a large or high-resolution scan blew the child's RSS
// budget — the child exited and the parent then DROPPED the document. Two fixes are locked down here:
//   1. ocrPdf renders and OCRs pages in bounded slices from a single open parser (render → OCR → release →
//      repeat), so peak memory stays flat regardless of page count.
//   2. extractcore.extract accepts { ocr:false } so a parse whose OCR pass failed can be retried
//      text-layer-only, and a document with no extractable text at all is indexed by its file name rather
//      than dropped (covered functionally in files-skipreport.test.js).
// OCR itself needs the Tesseract model and scanned fixtures, so the slicing structure is guarded by source
// inspection; the OCR-skip switch is exercised functionally. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

(async () => {
  try {
    const ocrSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'ocr.js'), 'utf-8');

    // ── ocrPdf renders in bounded slices from one open parser, not all pages at once ──
    ok(/const OCR_PAGES_PER_SLICE = \d+;/.test(ocrSrc), 'a per-slice page budget is defined');
    ok(/const openPdf = async \(buffer\) =>/.test(ocrSrc) && /const renderRange = async \(parser, first, last\) =>/.test(ocrSrc),
      'the PDF is opened once and pages are rendered by range');
    const ocrPdfIdx = ocrSrc.indexOf('const ocrPdf = async');
    ok(ocrPdfIdx !== -1, 'ocrPdf exists');
    const body = ocrSrc.slice(ocrPdfIdx, ocrPdfIdx + 6000);
    ok(/for \(let start = 1; start <= limit/.test(body) && /start \+= sliceSize/.test(body),
      'ocrPdf loops over the document in page slices');
    ok(/const sliceSize = Math\.max\(1, Math\.min\(poolSize\(\), OCR_PAGES_PER_SLICE\)\)/.test(body),
      'the render slice is tied to the worker-pool width, so resident pages match concurrency');
    ok(/await renderRange\(parser, start, end\)/.test(body), 'each slice renders only its own page range');
    ok(/images\.length === 0\) \{ reachedEnd = true; break; \}/.test(body) && /images\.length < want\) \{ reachedEnd = true; break; \}/.test(body),
      'the slice loop terminates at the end of the document (empty or short slice)');
    ok(/await openPdf\(buffer\)/.test(body) && /parser\.destroy\(\)/.test(body),
      'ocrPdf opens one parser and destroys it when done');
    // The old whole-document render is gone from ocrPdf.
    ok(!/renderPdfPages\(buffer, \{ maxPages/.test(body), 'ocrPdf no longer renders every page up front');
    console.log('✓ ocr-slicing: scanned PDFs are rendered and OCR\'d in bounded slices (flat memory)');

    // ── visual ingest streams pages one slice at a time, too (OOM-proof on long / high-res scans) ──
    // The old path rendered every page up front (renderPdfPages) and held all bitmaps while the sequential
    // vision calls ran. iterPdfPages yields one slice at a time and destroys the parser in a finally, so a
    // consumer that breaks early still releases it.
    ok(/async function\* iterPdfPages\(buffer, \{ maxPages = null, sliceSize/.test(ocrSrc),
      'iterPdfPages is a generator that streams pages lazily');
    const iterIdx = ocrSrc.indexOf('async function* iterPdfPages');
    const iterBody = ocrSrc.slice(iterIdx, iterIdx + 1400);
    ok(/await renderRange\(parser, start, end\)/.test(iterBody) && /start \+= step/.test(iterBody),
      'iterPdfPages renders only the current slice\'s range, advancing a slice at a time');
    ok(/finally \{[\s\S]*?parser\.destroy\(\)/.test(iterBody),
      'iterPdfPages destroys the parser even when the consumer stops early');
    ok(/images\.length < want\) break;/.test(iterBody) && /!images\.length\) break;/.test(iterBody),
      'iterPdfPages terminates at the end of the document (empty or short slice)');
    const vdSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'visualdocs.js'), 'utf-8');
    ok(/for await \(const \{ pageNum, image \} of require\('\.\.\/ocr'\)\.iterPdfPages\(/.test(vdSrc),
      'visual ingest consumes pages through the streaming iterator');
    ok(!/renderPdfPages\(/.test(vdSrc),
      'visual ingest no longer renders the whole document up front (no renderPdfPages)');
    // Functional: the iterator opens, fails to render a non-PDF, and cleans up without yielding or throwing.
    const ocrMod = require(path.join(PROJECT, 'lib', 'ocr'));
    let yielded = 0;
    for await (const _ of ocrMod.iterPdfPages(Buffer.from('not a pdf at all'), { maxPages: 3 })) yielded++;
    ok(yielded === 0, 'iterPdfPages yields nothing for a non-PDF buffer and completes cleanly (parser destroyed)');
    console.log('✓ ocr-slicing: visual ingest streams pages one slice at a time (flat memory)');

    // ── extractcore.extract honors { ocr:false }: an image with OCR off yields empty, no recognizer run ──
    const extractcore = require(path.join(PROJECT, 'lib', 'indexing', 'extractcore'));
    const r = await extractcore.extract(Buffer.from('not a real image'), '.png', { ocr: false });
    ok(r && r.text === '', 'an image extracted with ocr:false returns empty text without running OCR');
    // Source guard: the PDF branch skips OCR when disabled, and the child/parent thread the flag through.
    const coreSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'extractcore.js'), 'utf-8');
    ok(/const useOcr = opts\.ocr !== false;/.test(coreSrc)
      && /if \(!useOcr\) return \{ kind: 'pdf', text: r\.text/.test(coreSrc)
      && /ocrPdfCombined\(buffer, r\.text, r\.pages\)/.test(coreSrc),
      'the PDF branch skips OCR when disabled, else routes through the shared ocrPdfCombined (scan-detect inside)');
    const procSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'extractprocess.js'), 'utf-8');
    ok(/ocr: opts\.ocr !== false/.test(procSrc), 'extractInChild threads the ocr flag to the child');
    ok(/rssLimitMb: opts\.rssLimitMb \|\| dynamicRssMb\(\)/.test(procSrc) && /Math\.min\(MAX_RSS_MB, Math\.floor\(totalMb \* 0\.25\)\)/.test(procSrc),
      'the child memory budget scales with host RAM (dynamic, clamped)');
    ok(/ocrMaxWorkers: Number\.isInteger\(opts\.ocrMaxWorkers\)/.test(procSrc), 'a retry can force a smaller OCR pool via ocrMaxWorkers');

    // ── the isolation child caps OCR concurrency to its RSS budget and honors a per-job override ──
    const childSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'extractchild.js'), 'utf-8');
    ok(/Math\.floor\(rssLimitMb \/ perWorkerMb\)/.test(childSrc) && /ocrMod\.setWorkerCap\(workerCap\)/.test(childSrc),
      'the parse child caps OCR workers to ~one per MB_PER_OCR_WORKER of its memory budget (a normal page needs ~400-600 MB)');
    ok(/job\.ocrMaxWorkers > 0\) workerCap = Math\.min\(workerCap, job\.ocrMaxWorkers\)/.test(childSrc),
      'the child honors a per-job worker cap for a gentler retry');

    // ── dynamic worker count: one source of truth, factoring cores AND memory, always >= 1 ──
    const ocr = require(path.join(PROJECT, 'lib', 'ocr'));
    ok(typeof ocr.setWorkerCap === 'function' && typeof ocr.recommendedWorkers === 'function',
      'ocr exports setWorkerCap and recommendedWorkers');
    const rec = ocr.recommendedWorkers();
    ok(Number.isInteger(rec) && rec >= 1 && rec <= 8, `recommendedWorkers returns a sane count (got ${rec})`);
    const serverSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'server.js'), 'utf-8');
    ok(/ocrWorkersAuto:\s*require\('\.\/ocr'\)\.recommendedWorkers\(\)/.test(serverSrc),
      'the settings UI reports the same recommendedWorkers the child uses (no drift)');

    // ── escalation: single-worker OCR, then text-only, then index-by-name — never dropped for memory ──
    const filesSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'files.js'), 'utf-8');
    ok(/extractInChild\(filePath, ext, \{ workspaceId: opts\.workspaceId, ocrMaxWorkers: 1 \}\)/.test(filesSrc),
      'a failed parse first retries OCR with a single worker (keeps the scanned content)');
    ok(/extractInChild\(filePath, ext, \{ workspaceId: opts\.workspaceId, ocr: false \}\)/.test(filesSrc),
      'then retries text-layer-only before giving up on OCR');
    ok(/metadata\.indexedByName = true/.test(filesSrc) && /skipReport\.nameOnly\.push/.test(filesSrc),
      'a document with no extractable text is indexed by name, not dropped');
    console.log('✓ ocr-slicing: a failed OCR parse retries without OCR, and a text-less document is indexed by name');

    // ── retry-pending: a name-only doc from a PARSE FAILURE (memory) is re-attempted next run, not frozen ──
    ok(/parsePending: indexedByName && isolateFailed/.test(filesSrc),
      'a name-only entry from a parse failure is flagged parsePending (transient, not a genuine no-text doc)');
    const deltaSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'delta.js'), 'utf-8');
    ok(/doc\.parsePending\)/.test(deltaSrc) && /embedPending: true[\s\S]{0,80}continue;/.test(deltaSrc.slice(deltaSrc.indexOf('doc.parsePending'))),
      'delta records a parsePending doc retry-pending (no fileHash), like a transient embed failure');

    // ── config invalidation: turning OCR / vision on re-reads name-only scans ──
    ok(/m\._ocrEnabled\s*=\s*!!cfg\.USE_OCR/.test(deltaSrc) && /m\._visionEnabled\s*=\s*!!cfg\.VISION_DESCRIBE/.test(deltaSrc),
      'the manifest records whether OCR/vision were enabled when it was built');
    const initSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'init.js'), 'utf-8');
    ok(/cfg\.USE_OCR && manifest\._ocrEnabled === false\) return 'OCR was turned on'/.test(initSrc),
      'turning OCR on rebuilds so name-only scans are re-OCR\'d');

    // ── raising the OCR page cap (or switching engine/model) re-OCRs, so a truncated scan is never frozen ──
    // The manifest records the OCR settings that change the extracted text, and a change forces a rebuild
    // (which wipes the OCR cache and re-OCRs) — otherwise "raise Max pages and re-index" would silently serve
    // the old truncated text from cache.
    ok(/m\._ocrMaxPages\s*=\s*cfg\.USE_OCR \? cfg\.OCR_MAX_PAGES/.test(deltaSrc) && /m\._ocrEngine\s*=/.test(deltaSrc),
      'the manifest records the OCR page cap and engine the index was built with');
    ok(/manifest\._ocrMaxPages !== undefined && manifest\._ocrMaxPages !== cfg\.OCR_MAX_PAGES/.test(initSrc),
      'raising the OCR page cap forces a rebuild so the scan is re-OCR\'d at the new limit (not served truncated from cache)');
    ok(/manifest\._ocrEngine !== undefined && manifest\._ocrEngine !==/.test(initSrc),
      'switching the OCR engine forces a rebuild so documents are re-OCR\'d with the new engine');

    // ── the eager main-process OCR pool is gone (it double-counted the child\'s memory budget) ──
    ok(!/warmUp\(\)\.catch/.test(deltaSrc), 'delta no longer eagerly warms a main-process OCR pool');

    // ── L4: an error AFTER a successful spawn is NOT treated as forkFailed (no inline parse of a huge file) ──
    ok(/child\.on\('spawn', \(\) => \{ spawned = true; \}\)/.test(procSrc) && /e\.forkFailed = !spawned/.test(procSrc),
      'a post-spawn channel error takes the escalation path, not the inline fallback');

    // ── L2: the per-worker memory constant is single-sourced ──
    ok(/ocrMod\.MB_PER_OCR_WORKER \|\| 800/.test(childSrc), 'the child divides its budget by the shared MB_PER_OCR_WORKER');
    console.log('✓ ocr-slicing: memory-failed docs retry, OCR-enable rebuilds, no eager pool, post-spawn errors escalate');

    console.log(`\nALL OCR-SLICING UNIT TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ OCR-SLICING UNIT TEST FAILED:', e && e.message);
    process.exit(1);
  }
})();
