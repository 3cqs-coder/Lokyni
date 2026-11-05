'use strict';

// ── parsecore — the CPU-heavy synchronous document parsers, isolated ──────────
//
// Pure parsing logic with no config and no worker plumbing, so it runs identically
// inside a worker_thread (its normal home, off the event loop — see parseworker.js)
// or inline as a fallback. These two formats are the ones whose parsing is both
// synchronous and potentially large enough to stall the server's event loop: an XLSX
// workbook (XLSX.read + sheet_to_csv) and a big JSON document (JSON.parse + pretty
// stringify). Everything else the indexer reads is either already async or trivially
// cheap, so it stays inline.

// Bound the extracted text per file so a pathological document (a spreadsheet that flattens to
// enormous CSV, a JSON whose re-indentation balloons) can't grow memory without limit. This is the
// single source of the cap and is applied on every path — the worker thread, the inline fallback,
// and the isolated child (which imports it via extractcore). Generous, so a real book or large
// workbook is kept whole; the slice is surrogate-safe so it never cuts an astral character in half.
const MAX_TEXT_CHARS = 16 * 1024 * 1024;
// Appended when capText trims, so a caller can detect that the content was cut (and surface it in the
// run summary) without re-deriving the length threshold.
const TRUNC_MARK = '\n[...truncated]';
const { surrogateSafeSlice } = require('../surrogate');
const capText = (s) => {
  if (typeof s !== 'string' || s.length <= MAX_TEXT_CHARS) return s;
  return surrogateSafeSlice(s, MAX_TEXT_CHARS) + TRUNC_MARK;
};

// Above this INPUT size, skip JSON.parse and index the raw text instead. JSON.parse of a huge (but valid)
// document builds the whole object graph plus a re-indented copy — several times the input in memory — which
// can OOM-crash the parser on a multi-hundred-MB file that capText would only trim AFTER the fact. The raw
// text is already searchable, so a very large JSON is kept (capped), never dropped. Generous: real JSON
// documents are far smaller, so they still get the pretty-printed, newline-chunkable form.
const JSON_PARSE_MAX = 64 * 1024 * 1024;
// Bound the flattened spreadsheet grid. A crafted workbook can declare a huge used range (e.g. the whole
// A1:XFD1048576) with almost no real cells; sheet_to_csv would expand that to billions of characters — a V8
// "Invalid string length" RangeError or an OOM — before capText could trim it. Clamp the range to this many
// cells first. Generous enough to keep a real large workbook whole.
const MAX_SHEET_CELLS = 2_000_000;

// Flatten each sheet of a workbook to labeled CSV, so the whole workbook becomes one
// searchable text document. `buffer` is a Buffer (or any TypedArray Buffer.from accepts).
const xlsxToText = (buffer) => {
  const buf = Buffer.from(buffer);
  // An XLSX/XLSM is a ZIP, so vet it for a decompression ("zip bomb") BEFORE XLSX.read — a
  // small crafted workbook can inflate to gigabytes and OOM the process. Guarding here, rather
  // than only in the isolated-child path, covers EVERY caller: the worker thread, the inline
  // fallback when the worker is unavailable or was memory-killed, and the isolated child.
  if (!require('./zipguard').zipWithinBudget(buf)) {
    throw new Error('Refusing to parse a spreadsheet that decompresses far beyond its size (possible zip bomb)');
  }
  const XLSX = require('xlsx');
  const wb = XLSX.read(buf, { type: 'buffer' });
  const parts = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    // Clamp an oversized declared range before flattening, so a crafted sparse sheet can't emit billions of
    // characters. Keep as many whole rows as fit MAX_SHEET_CELLS for the sheet's column count; real data sits
    // near the top, and capText trims the rest anyway.
    if (ws && ws['!ref']) {
      try {
        const r = XLSX.utils.decode_range(ws['!ref']);
        const cols = Math.max(1, r.e.c - r.s.c + 1);
        const maxRows = Math.max(1, Math.floor(MAX_SHEET_CELLS / cols));
        if ((r.e.r - r.s.r + 1) > maxRows) { r.e.r = r.s.r + maxRows - 1; ws['!ref'] = XLSX.utils.encode_range(r); }
      } catch { /* an unparseable ref — let sheet_to_csv handle it as before */ }
    }
    const csv = XLSX.utils.sheet_to_csv(ws);
    if (csv.trim()) parts.push(`--- Sheet: ${sheetName} ---\n${csv.trim()}`);
  }
  return capText(parts.join('\n\n'));
};

// Index JSON as pretty-printed text so keys and values are both searchable and minified
// single-line JSON still chunks sensibly on newlines. Malformed JSON falls back to the
// raw text rather than dropping the document.
const jsonToText = (text) => {
  // A very large (but valid) JSON would OOM on JSON.parse + re-stringify; index the raw text instead. The
  // raw form is already searchable and capText bounds it, so the document is kept rather than dropped.
  if (typeof text === 'string' && text.length > JSON_PARSE_MAX) return capText(text);
  try { return capText(JSON.stringify(JSON.parse(text), null, 2)); }
  catch { return capText(text); }
};

module.exports = { xlsxToText, jsonToText, capText, MAX_TEXT_CHARS, TRUNC_MARK, JSON_PARSE_MAX, MAX_SHEET_CELLS };
