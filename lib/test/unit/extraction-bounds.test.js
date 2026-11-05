'use strict';
// Guards two OOM bounds in the synchronous parsers (lib/indexing/parsecore.js):
//   • jsonToText skips JSON.parse above JSON_PARSE_MAX and indexes the raw (capped) text, so a huge but
//     valid .json can't exhaust the heap re-building its object graph + a re-indented copy.
//   • xlsxToText clamps an oversized declared sheet range to MAX_SHEET_CELLS before sheet_to_csv, so a
//     crafted sparse sheet (a tiny workbook declaring A1:XFD1048576) can't emit billions of characters and
//     hit a V8 "Invalid string length" RangeError or OOM before capText could trim it.
// The JSON bound is exercised functionally (cheap); the XLSX clamp is guarded by a normal round-trip plus
// source inspection — constructing a genuinely huge-range workbook also blows up the WRITER, so it can't be
// built safely in a test. No network. Run: `npm run test:unit`.

const path = require('path'), fs = require('fs'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const pc = require(path.join(PROJECT, 'lib', 'indexing', 'parsecore'));
const XLSX = require(path.join(PROJECT, 'node_modules', 'xlsx'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // ── JSON input bound ──
  ok(pc.JSON_PARSE_MAX >= 16 * 1024 * 1024, 'JSON_PARSE_MAX is a sane, generous bound');
  // A valid JSON larger than the bound is kept as raw (capped) text, NOT parsed — and never throws/OOMs.
  const huge = '[' + '0,'.repeat(Math.ceil(pc.JSON_PARSE_MAX / 2) + 10) + '0]';   // valid JSON, > JSON_PARSE_MAX chars
  ok(huge.length > pc.JSON_PARSE_MAX, 'the fixture exceeds the parse bound');
  const out = pc.jsonToText(huge);
  ok(typeof out === 'string' && out.length <= pc.MAX_TEXT_CHARS + pc.TRUNC_MARK.length, 'an over-bound JSON is returned capped, not parsed');
  ok(!/\n {2}/.test(out.slice(0, 200)), 'an over-bound JSON is NOT pretty-printed (indented) — it was indexed raw');
  // A normal JSON under the bound still pretty-prints (keys/values on their own newlines, chunkable).
  const pretty = pc.jsonToText('{"name":"Ada","city":"London"}');
  ok(/\n {2}"name": "Ada"/.test(pretty) && /\n {2}"city": "London"/.test(pretty), 'a normal JSON is pretty-printed');
  // Malformed JSON still falls back to raw text (not dropped).
  ok(pc.jsonToText('{ not valid ]') === '{ not valid ]', 'malformed JSON falls back to raw text');
  console.log('✓ extraction-bounds: a huge valid JSON is indexed raw (no parse OOM); normal/malformed JSON unchanged');

  // ── XLSX: a normal workbook still extracts fully (regression safety) ──
  const ws = XLSX.utils.aoa_to_sheet([['Name', 'City'], ['Ada', 'London'], ['Alan', 'Manchester']]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'People');
  const text = pc.xlsxToText(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  ok(/Ada/.test(text) && /London/.test(text) && /Manchester/.test(text), 'a normal workbook extracts every row');
  console.log('✓ extraction-bounds: a normal workbook extracts fully');

  // ── XLSX clamp is present (source guard — the malicious fixture can't be built without the same blow-up) ──
  const src = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'parsecore.js'), 'utf-8');
  ok(/const MAX_SHEET_CELLS = /.test(src), 'a sheet-cell cap is defined');
  ok(/decode_range\(ws\['!ref'\]\)/.test(src) && /MAX_SHEET_CELLS \/ cols/.test(src) && /encode_range\(r\)/.test(src),
    'xlsxToText clamps an oversized declared range to MAX_SHEET_CELLS before flattening');
  console.log('✓ extraction-bounds: xlsxToText clamps an oversized sheet range before emitting CSV');

  console.log(`\nALL EXTRACTION-BOUNDS UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ EXTRACTION-BOUNDS UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
