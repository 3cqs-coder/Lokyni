'use strict';
// Guards EPUB text extraction against a malformed-href data-loss bug (lib/indexing/epub.js). An href in the
// OPF spine with a stray percent sign (e.g. a chapter literally named "50% off.xhtml") makes
// decodeURIComponent throw URIError; un-caught, that reduced the ENTIRE book to name-only. The resolver now
// falls back to the raw href, so at worst one chapter mis-resolves — never the whole book. Builds a tiny EPUB
// with the bundled jszip; no network. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { extractEpubText } = require(path.join(PROJECT, 'lib', 'indexing', 'epub'));
const JSZip = require(path.join(PROJECT, 'node_modules', 'jszip'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

const chapter = (title, body) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head>
<body><h1>${title}</h1><p>${body}</p></body></html>`;

(async () => {
  try {
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip');
    zip.file('META-INF/container.xml',
      '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">' +
      '<rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    // The first chapter's href carries a stray "%" (not a valid escape) — the exact trigger.
    zip.file('content.opf',
      '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest>' +
      '<item id="c1" href="50% off.xhtml" media-type="application/xhtml+xml"/>' +
      '<item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>' +
      '</manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>');
    zip.file('50% off.xhtml', chapter('Discount', 'The clearance sale gives fifty percent off everything.'));
    zip.file('ch2.xhtml', chapter('Returns', 'Returns are accepted within thirty days of purchase.'));
    const buf = await zip.generateAsync({ type: 'nodebuffer' });

    // The whole book must extract — the malformed-href chapter must not take the rest down with it.
    let text = '';
    let threw = false;
    try { text = await extractEpubText(buf); } catch { threw = true; }
    ok(!threw, 'extractEpubText does not throw on a malformed-href EPUB');
    ok(typeof text === 'string' && text.length > 0, 'the EPUB yields text rather than nothing (not reduced to name-only)');
    ok(/thirty days/i.test(text), 'the well-formed chapter is extracted');
    ok(/fifty percent/i.test(text), 'the malformed-href chapter is still recovered via the raw-href fallback');
    console.log('✓ epub-extract: a malformed spine href no longer loses the whole book');

    // A normal EPUB still extracts in spine order.
    const z2 = new JSZip();
    z2.file('META-INF/container.xml',
      '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">' +
      '<rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    z2.file('content.opf',
      '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest>' +
      '<item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest>' +
      '<spine><itemref idref="a"/></spine></package>');
    z2.file('a.xhtml', chapter('Intro', 'A single well-formed chapter.'));
    const t2 = await extractEpubText(await z2.generateAsync({ type: 'nodebuffer' }));
    ok(/well-formed chapter/i.test(t2), 'a normal EPUB extracts its chapter text');
    console.log('✓ epub-extract: a normal EPUB extracts correctly');

    console.log(`\nALL EPUB-EXTRACT UNIT TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ EPUB-EXTRACT UNIT TEST FAILED:', e && e.message);
    process.exit(1);
  }
})();
