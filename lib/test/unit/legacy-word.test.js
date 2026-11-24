'use strict';
// Guards the Word-format branch in text extraction. A legacy Word 97-2003 file is an OLE2 compound
// document, not a ZIP. It is sometimes saved with a .docx name, and the ZIP bomb guard then rejected a
// valid resume as a bomb, so the file was indexed by name only and its content was unavailable.
// The real signature now selects the reader: Office Open XML (.docx) stays on the vetted ZIP path,
// and a legacy container goes to the pure-JavaScript OLE2 reader. No office suite is required.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const { docxKind, extractDocx } = require(path.join(ROOT, 'lib', 'indexing', 'extractcore'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

(async () => {
  try {
    // The two real container signatures, and a non-container.
    const ole2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0, 0]);
    ok(docxKind(ole2) === 'ole2', 'a legacy Word OLE2 header is detected');
    ok(docxKind(zip) === 'zip', 'an Office Open XML ZIP header is detected');
    ok(docxKind(Buffer.from('not a document')) === 'unknown', 'an unrecognized container is rejected');
    ok(docxKind(Buffer.alloc(4)) === 'unknown', 'a too-small buffer is rejected without throwing');

    // A legacy container must be read, not sent through the ZIP bomb guard.
    const src = read('lib/indexing/extractcore.js');
    ok(/kind === 'ole2'/.test(src) && /require\('word-extractor'\)/.test(src),
      'the legacy branch uses the pure-JavaScript OLE2 reader');
    ok(/doc\.getBody\(\)/.test(src), 'the legacy branch reads the document body');
    const ole2At = src.indexOf("kind === 'ole2'");
    const zipAt = src.indexOf("kind !== 'zip'");
    const guardAt = src.indexOf('assertSafeZip(buffer)', ole2At);
    ok(ole2At !== -1 && zipAt !== -1 && guardAt > zipAt,
      'the ZIP guard runs only after the container is known to be a ZIP');
    ok(/not a Word document \(expected an Office Open XML archive or a legacy Word file\)/.test(src),
      'an unknown container gives a clear format error instead of a zip-bomb error');

    const pkg = JSON.parse(read('package.json'));
    ok(pkg.dependencies && /^\^?1\./.test(pkg.dependencies['word-extractor'] || ''),
      'the legacy reader is a declared runtime dependency (shipped by every install path)');

    // A non-document still fails closed and never reaches a parser.
    let threw = '';
    try { await extractDocx(Buffer.from('plain text')); } catch (e) { threw = e.message; }
    ok(/not a Word document/.test(threw), 'extractDocx rejects an unknown container with a clear error');

    console.log(`\nALL LEGACY-WORD UNIT TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ LEGACY-WORD UNIT TEST FAILED:', e && e.message);
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  }
})();
