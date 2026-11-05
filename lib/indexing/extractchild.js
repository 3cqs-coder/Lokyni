'use strict';
// Isolated child process for heavy document parsing — the memory/crash firewall for indexing.
// It reads ONE file and extracts its text in its own address space under hard caps, then sends
// the result back and exits so the OS reclaims all of its memory. A huge or crafted document
// that would OOM-kill or hard-crash the main server (a PDF text-stream bomb, a ZIP bomb in a
// DOCX/XLSX/EPUB, a native abort in a parser) instead only takes down this child; the parent
// then indexes the file by name. Symmetric with the parent supervisor in extractprocess.js.
//
// It also bounds ITSELF so it can never become a runaway if the parent goes away (a reindex
// cancel, or the app quitting): it samples its own RSS and exits past a budget, has a self
// wall-clock deadline, and exits when the IPC channel to the parent closes. (A purely
// synchronous parse blocks these JS-timer backstops; the parent's wall-clock kill covers that
// while the parent is alive, and the V8 heap cap the parent sets via execArgv bounds the JS
// heap of an allocation-heavy synchronous parse.)

const fs = require('fs');

if (typeof process.send === 'function') {
  // Parent gone — don't linger.
  try { process.once('disconnect', () => { try { process.exit(0); } catch (_) {} }); } catch (_) {}

  process.once('message', async (job) => {
    const rssLimitMb    = (job && job.rssLimitMb) || 0;
    const selfTimeoutMs = (job && job.selfTimeoutMs) || 0;
    let mon = null, deadline = null;
    if (rssLimitMb) {
      let base = 0; try { base = process.memoryUsage().rss; } catch (_) {}
      const limit = base + rssLimitMb * 1024 * 1024;
      mon = setInterval(() => {
        let rss = 0; try { rss = process.memoryUsage().rss; } catch (_) { return; }
        if (rss > limit) { try { process.exit(2); } catch (_) {} }
      }, 200);
      if (mon.unref) mon.unref();
    }
    if (selfTimeoutMs) {
      deadline = setTimeout(() => { try { process.exit(4); } catch (_) {} }, selfTimeoutMs);
      if (deadline.unref) deadline.unref();
    }

    // Point this fresh child at the workspace the parent is indexing BEFORE requiring the
    // extractor: config resolves CACHE_DIR from state.workspaceId (default in a fresh child),
    // and the OCR cache the child may write must land in the right workspace's directory.
    if (job && job.workspaceId) { try { require('../state').workspaceId = job.workspaceId; } catch (_) {} }

    // Keep OCR worker concurrency within this child's memory budget. Each Tesseract worker holds its own
    // WASM heap that grows during recognition (measured around 400-600 MB while OCRing a page), so running
    // several at once is what pushed the child past its RSS cap and got documents dropped. Budget ~800 MB
    // per worker; page slicing keeps memory flat across the document regardless of the worker count. A retry
    // can pass a smaller ocrMaxWorkers to fit memory a wider first attempt overran, so OCR gets a second,
    // gentler try before the caller falls back to a text-only parse.
    try {
      const ocrMod = require('../ocr');
      const perWorkerMb = ocrMod.MB_PER_OCR_WORKER || 800;
      let workerCap = Math.max(1, Math.floor(rssLimitMb / perWorkerMb));
      if (Number.isInteger(job.ocrMaxWorkers) && job.ocrMaxWorkers > 0) workerCap = Math.min(workerCap, job.ocrMaxWorkers);
      ocrMod.setWorkerCap(workerCap);
    } catch (_) {}

    let out;
    try {
      const { filePath, ext } = (job && job.args) || {};
      const buffer = fs.readFileSync(filePath);          // read inside the capped child, not the parent
      const result = await require('./extractcore').extract(buffer, ext, { ocr: job && job.ocr !== false });
      // Carry any truncation the extractor reported (e.g. a scanned-PDF page cap reported by ocrPdf) back to
      // the parent. These notes are pushed into THIS child's files.js skipReport, whose module instance dies
      // with the child — so without sending them back the parent's run summary silently omits "read N of M
      // pages" for exactly the huge/scanned PDFs we promise to handle.
      let skips = null; try { skips = require('./files').getSkipReport(); } catch (_) {}
      out = { ok: true, result, skips };
    } catch (e) {
      out = { ok: false, error: (e && e.message) || String(e) };
    }

    // Persist any OCR result cached during the parse before we exit — the parent's end-of-run
    // flush is a different process and cannot see this child's in-memory writes, so without
    // this the child's cache entries are lost and the scan is re-OCR'd next time. Best-effort.
    try { require('../ocrcache').flush(); } catch (_) {}

    if (mon) { try { clearInterval(mon); } catch (_) {} }
    if (deadline) { try { clearTimeout(deadline); } catch (_) {} }
    // Exit only after the reply is flushed, so the parent always receives it.
    try { process.send(out, () => process.exit(0)); } catch (_) { try { process.exit(0); } catch (__) {} }
  });
}
