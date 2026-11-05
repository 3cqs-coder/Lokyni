'use strict';
// Guards the shared Content-Disposition builder (lib/contentdisposition.js) — the ONE place every download route
// encodes a filename, so a name in any language/script survives the download instead of being mangled. Verifies
// the RFC 6266 shape (ASCII fallback + filename*=UTF-8''…), that non-Latin names round-trip, and that nothing
// unsafe (quote, backslash, control, CR/LF) can break out of the header. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { contentDisposition, asciiFallback, rfc5987 } = require(path.join(PROJECT, 'lib', 'contentdisposition'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

try {
  // ── Shape: disposition + ASCII filename + RFC 5987 filename* ──
  const h = contentDisposition('report.docx');
  ok(/^attachment; filename="report\.docx"; filename\*=UTF-8''report\.docx$/.test(h), 'ASCII name: both params present and correct');
  ok(/^inline; /.test(contentDisposition('a.pdf', 'inline')), 'disposition is honored (inline)');

  // ── Non-Latin names round-trip via filename* (the whole point) ──
  const jp = contentDisposition('日本語.pdf');
  ok(/filename\*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E\.pdf/.test(jp), 'a CJK name is UTF-8 percent-encoded in filename*');
  ok(/filename="[\x20-\x7e]*"/.test(jp) && !/filename="[^"]*[^\x00-\x7f]/.test(jp), 'the filename= fallback is pure ASCII (non-Latin replaced)');
  const accent = contentDisposition('résumé.pdf');
  ok(/filename\*=UTF-8''r%C3%A9sum%C3%A9\.pdf/.test(accent), 'an accented name is UTF-8 encoded in filename*');

  // ── Header-injection safety: quotes, backslashes, and CR/LF can't break out ──
  const nasty = contentDisposition('a"b\\c\r\nSet-Cookie: x.txt');
  ok(!/[\r\n]/.test(nasty), 'no CR/LF survives into the header value (no header injection)');
  ok(!/filename="[^"]*"[^;]/.test(nasty.replace(/filename\*=[^;]*/, '')), 'the quoted fallback contains no stray unescaped quote');
  eq(asciiFallback('a"b\\c\td.txt'), 'a_b_c_d.txt', 'quote, backslash, and control chars become _ in the ASCII fallback');

  // ── Basename only (a path never leaks a directory into the name) ──
  eq(asciiFallback('/etc/passwd'), 'passwd', 'only the basename is used');
  ok(/filename\*=UTF-8''passwd$/.test(contentDisposition('/var/data/passwd')), 'filename* is the basename too');

  // ── Edge cases degrade, never throw ──
  eq(asciiFallback(''), 'download', 'an empty name falls back to "download"');
  eq(asciiFallback(null), 'download', 'a null name falls back to "download"');
  eq(rfc5987('a (b) *c.txt'), 'a%20%28b%29%20%2Ac.txt', "rfc5987 percent-encodes space and the non-attr-chars ( ) *");
  ok(!/[()'*]/.test(rfc5987("'()*")), "rfc5987 leaves no literal ' ( ) *");

  console.log(`\nALL CONTENT-DISPOSITION TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ CONTENT-DISPOSITION TEST FAILED:', e && e.message);
  process.exit(1);
}
