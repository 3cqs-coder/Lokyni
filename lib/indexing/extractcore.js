'use strict';
// Text extraction for the "heavy" document formats — the ones whose parsers can spike memory
// or crash the process on a large or crafted file (a PDF text layer, a ZIP-based Office or
// EPUB archive that inflates hugely, a big JSON). Kept as one reusable module so the SAME code
// runs both inline (small files, through processFileContent) and inside the isolated child
// process (large files, through extractprocess.js). Each function takes an already-read buffer
// and returns text; the child reads the file into that buffer within its own capped memory.

// The heavy parsers are required lazily, so a child forked to read a JSON or XLSX file never
// pays to load the PDF or DOCX libraries it won't use — keeping the isolated-parse startup lean.

// The per-file text cap lives in parsecore (the lowest-level parser module) so a single definition
// bounds every path — the worker thread, the inline fallback, and this isolated-child code. Imported
// here rather than redefined, so the two can never drift.
const { capText } = require('./parsecore');

// PDF text layer only — no OCR. Returns { text, pages } so the caller can decide whether the
// document is a scan that needs OCR; that step stays with the caller, which owns the OCR pool.
async function extractPdf(buffer) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  // getText() loads the pdfjs document (and its worker/buffers) and leaves it open — only destroy() tears it
  // down. Release it in a finally so the INLINE path (processFileContent, used when parse isolation is off or the
  // host cannot fork) does not leak one pdfjs document + worker per PDF and grow RSS across a large folder. In the
  // isolated-child path the process exit reclaims it regardless; this makes the inline path just as safe. Mirrors
  // the destroy-in-finally pattern the OCR module already uses at every parser open site.
  try {
    const data = await parser.getText();
    return { text: capText(data.text || ''), pages: (data.pages && data.pages.length) || 1 };
  } finally {
    try { await parser.destroy(); } catch { /* best-effort release */ }
  }
}

// DOCX/XLSX/EPUB are ZIP archives whose readers inflate the whole thing before any limit
// applies, so each is vetted for a decompression bomb first (see zipguard). A bomb throws here,
// which the caller turns into "index this file by name" rather than letting it balloon memory.
const assertSafeZip = (buffer) => {
  if (!require('./zipguard').zipWithinBudget(buffer)) {
    throw new Error('archive exceeds the safe decompression budget (possible zip bomb)');
  }
};
const extractDocx = async (buffer) => { assertSafeZip(buffer); return capText((await require('mammoth').extractRawText({ buffer })).value); };
const extractEpub = async (buffer) => { assertSafeZip(buffer); return capText(await require('./epub').extractEpubText(buffer)); };   // ZIP of XHTML chapters
const extractPptx = async (buffer) => { assertSafeZip(buffer); return capText(await require('./officedocs').extractPptxText(buffer)); }; // ZIP of slide XML
const extractXlsx = (buffer) => { return capText(require('./parsecore').xlsxToText(buffer)); };   // xlsxToText vets the zip itself
const extractJson = (buffer) => capText(require('./parsecore').jsonToText(require('../textdecode').decodeTextBuffer(buffer)));

// Image formats whose OCR (sharp's native libvips resize/deskew, plus the Tesseract engine)
// is the other place a crafted file could crash or exhaust the process. Routed through the
// child too, so that native work is isolated. Single-sourced from OCR_EXTENSIONS so discovery
// (files.isTextFile) and this extract dispatch can't disagree when a format is added. (constants.js
// is a pure leaf with no config dependency, so it is safe to require inside the scrubbed child.)
const IMAGE_EXTS = new Set(require('../constants').OCR_EXTENSIONS);

// Formats routed through the isolated child for large files.
const ISOLATABLE = new Set(['.pdf', '.docx', '.epub', '.pptx', '.xlsx', '.xlsm', '.json', ...IMAGE_EXTS]);

// Formats isolated at ANY size, not just past the large-file threshold. Most isolatable formats are
// size-gated because their hazard is memory growth, which scales with the file. Two are different and
// are isolated regardless of size:
//   - The spreadsheet parser runs the frozen SheetJS build, whose known advisories (prototype
//     pollution, quadratic-time parsing) are triggered by crafted CONTENT, not size — a tiny
//     malicious workbook is as dangerous as a large one.
//   - PDF text extraction has no decompression-budget guard (unlike the ZIP formats), and a crafted
//     small PDF can drive the parser into pathological CPU or a gigantic decoded text layer. Because
//     that work is synchronous, a JS timeout cannot interrupt it, so a small malicious PDF parsed
//     inline would freeze the whole event loop. Isolating every PDF keeps that off the main process.
// Where a helper cannot be forked, the caller still falls back to inline parsing so the file is
// never simply dropped.
const ALWAYS_ISOLATE = new Set(['.xlsx', '.xlsm', '.pdf']);

// Dispatcher used by the child: (buffer, ext) -> { kind, text, pages? }. The child performs
// the memory-heavy and native work — including OCR for images and scanned PDFs (sharp +
// Tesseract) — so a crash or memory bomb there takes down only the child. Vision-describe
// (which needs the model API key, deliberately kept out of the child's scrubbed environment)
// is NOT done here; it stays on the inline path, so a large isolated image indexes by its OCR
// text alone. `kind:'pdf'` carries the page count for the caller.
async function extract(buffer, ext, opts = {}) {
  const e = String(ext).toLowerCase();
  const useOcr = opts.ocr !== false;   // a retry can request text-layer-only (no OCR) so a doc whose OCR
                                        // pass failed is still captured by its embedded text rather than dropped.
  if (IMAGE_EXTS.has(e)) {
    // An image has no text layer, so with OCR off there is nothing to extract — return empty rather than
    // running the recognizer the caller asked to skip. The OCR + content-hash cache is the shared helper
    // (ocr.ocrImageCached), the same one the inline path uses, so a large isolated image is never re-OCR'd on
    // a warm start. Vision-describe is NOT done here — it needs the model key the child's scrubbed env lacks.
    if (!useOcr) return { kind: 'text', text: '' };
    return { kind: 'text', text: capText(await require('../ocr').ocrImageCached(buffer)) };
  }
  switch (e) {
    case '.pdf': {
      const r = await extractPdf(buffer);
      if (!useOcr) return { kind: 'pdf', text: r.text, pages: r.pages };
      // Scan-detect + OCR (cached by content hash) + combine, via the shared helper the inline path also uses.
      const combined = await require('../ocr').ocrPdfCombined(buffer, r.text, r.pages);
      return { kind: 'pdf', text: capText(combined), pages: r.pages };
    }
    case '.docx': return { kind: 'text', text: await extractDocx(buffer) };
    case '.epub': return { kind: 'text', text: await extractEpub(buffer) };
    case '.pptx': return { kind: 'text', text: await extractPptx(buffer) };
    case '.xlsx':
    case '.xlsm': return { kind: 'text', text: extractXlsx(buffer) };
    case '.json': return { kind: 'text', text: extractJson(buffer) };
    default:      return { kind: 'text', text: null };
  }
}

module.exports = { extractPdf, extractDocx, extractEpub, extractPptx, extract, ISOLATABLE, ALWAYS_ISOLATE, IMAGE_EXTS };
