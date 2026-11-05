'use strict';
// Guards two web-extraction robustness features:
//   1. Charset-aware decoding (lib/websearch.js _decodeBuffer): a legacy-encoded page is read as real
//      text, not mojibake, using the Content-Type charset, then a <meta charset> sniff, else UTF-8.
//   2. The article "completeness" guard (lib/urlfetch.js): when the readability extractor returns far
//      less text than a plain block-strip of the (already boilerplate-cleaned) page, the fuller strip is
//      used so a truncated multi-section article is indexed whole. Asserted by source + a strip check.
// Pure/offline. Run: `npm run test:unit` (or `node lib/test/unit/extraction-robustness.test.js`).

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { _decodeBuffer: decodeBuffer } = require(path.join(PROJECT, 'lib', 'websearch'));
const { stripTags } = require(path.join(PROJECT, 'lib', 'htmlstrip'));
const read = (...p) => fs.readFileSync(path.join(PROJECT, ...p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

try {
  // ── Charset decode ──
  // "café" in windows-1252: é = 0xE9. Decoded as UTF-8 it would be a replacement char; as 1252 it is "é".
  const cp1252 = Buffer.from([0x63, 0x61, 0x66, 0xE9]);   // c a f é
  eq(decodeBuffer(cp1252, 'text/html; charset=windows-1252'), 'café', 'decodes a windows-1252 body from the Content-Type charset');
  ok(decodeBuffer(cp1252, 'text/html').includes('caf'), 'a 1252 body with no header charset still decodes (UTF-8 fallback does not throw)');
  // A <meta charset> drives decoding when the header does not carry one.
  const metaDoc = Buffer.concat([Buffer.from('<html><head><meta charset="iso-8859-1"></head><body>'), Buffer.from([0xE9]), Buffer.from('</body></html>')]);
  ok(decodeBuffer(metaDoc, '').includes('é'), 'falls back to the <meta charset> when the header has none');
  // UTF-8 is the default and round-trips multibyte text.
  eq(decodeBuffer(Buffer.from('héllo → 世界', 'utf8'), 'text/html; charset=utf-8'), 'héllo → 世界', 'UTF-8 multibyte round-trips');
  eq(decodeBuffer(Buffer.from('plain', 'utf8'), ''), 'plain', 'no charset anywhere → UTF-8');
  // An unknown/garbage label never throws — it degrades to UTF-8.
  ok(typeof decodeBuffer(Buffer.from('x'), 'text/html; charset=totally-made-up') === 'string', 'an unknown charset label degrades to UTF-8 without throwing');

  // ── Completeness guard: a block-strip of pre-cleaned HTML yields the full text the extractor may drop ──
  const longBody = Array.from({ length: 8 }, (_, i) => `<p>Section ${i + 1}. ${'This is a full paragraph of real article text. '.repeat(10)}</p>`).join('');
  const page = `<html><body><article>${longBody}</article></body></html>`;
  const stripped = stripTags(page, { block: true }).replace(/\s+/g, ' ').trim();
  const firstSectionOnly = 'Section 1. ' + 'This is a full paragraph of real article text. '.repeat(10);
  ok(stripped.length > 1000, 'the block-strip recovers the whole multi-section article');
  ok(firstSectionOnly.length < stripped.length * 0.5, 'a first-section-only extraction is under half the full strip (the guard would prefer the strip)');

  // ── SOURCE GUARD: the completeness guard is wired into URL ingestion ──
  const uf = read('lib', 'urlfetch.js');
  ok(/stripTags\(html, \{ block: true \}\)/.test(uf), 'URL ingestion computes a block-strip of the captured page');
  ok(/text\.length < stripped\.length \* 0\.5/.test(uf) && /text = stripped/.test(uf), 'it prefers the fuller strip when the extractor truncated the article');
  const ws = read('lib', 'websearch.js');
  ok(/new TextDecoder\(charset/.test(ws) && /decodeBuffer\(Buffer\.concat/.test(ws), 'web-page reads decode with the detected charset');

  console.log(`\nALL EXTRACTION-ROBUSTNESS TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ EXTRACTION-ROBUSTNESS UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
