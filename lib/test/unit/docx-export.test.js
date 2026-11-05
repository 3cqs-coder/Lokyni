'use strict';
// Guards the REAL Word export (.docx). The old "Word" download was HTML with a .doc extension, which modern Word
// opens grudgingly and Pages refuses; now the server builds a genuine Office Open XML package (jszip + marked).
// This verifies the package is structurally valid (the parts Word requires), that Markdown maps to the right
// WordprocessingML (headings, bold, lists, links, tables), that XML is escaped (odd model output can't corrupt
// the file), and that the frontend + route are wired to it. Run: `npm run test:unit`.

const path = require('path'), fs = require('fs'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const docx = require(path.join(PROJECT, 'lib', 'docx'));
const { markdownToDocx } = docx;
const JSZip = require('jszip');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

(async () => {
  try {
    const md = [
      '# Title Heading',
      '',
      'A **bold** and *italic* line with `code`, a [link](https://example.com), and A < B & C.',
      '',
      '- first bullet',
      '- second bullet',
      '',
      '1. step one',
      '2. step two',
      '',
      '> a quote',
      '',
      '```',
      'const x = 1;',
      '```',
      '',
      '| H1 | H2 |',
      '| --- | --- |',
      '| a | b |',
      '',
      '---',
    ].join('\n');

    const buf = await markdownToDocx(md);
    ok(Buffer.isBuffer(buf), 'returns a Buffer');
    eq(buf.slice(0, 2).toString('latin1'), 'PK', 'is a ZIP container (OOXML)');

    // ── the package has the parts Word requires ──────────────────────────────────────────────────────────────
    const zip = await JSZip.loadAsync(buf);
    for (const part of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels']) {
      ok(zip.file(part), `package contains ${part}`);
    }
    const ct = await zip.file('[Content_Types].xml').async('string');
    ok(/wordprocessingml\.document\.main\+xml/.test(ct), 'content types declare a Word main document');

    const doc = await zip.file('word/document.xml').async('string');
    ok(/^<\?xml /.test(doc) && /<w:document[\s>]/.test(doc) && /<\/w:document>$/.test(doc.trim()), 'document.xml is a WordprocessingML document');
    ok(/<w:b\/>/.test(doc), 'bold maps to <w:b/>');
    ok(/<w:i\/>/.test(doc), 'italic maps to <w:i/>');
    ok(/Consolas/.test(doc), 'inline code / code block uses a monospace font');
    ok(/<w:tbl>/.test(doc) && /<w:tr>/.test(doc) && /<w:tc>/.test(doc), 'a Markdown table becomes a real Word table');
    ok(/•|\d+\. /.test(doc), 'list items carry a bullet / number prefix');
    ok(/0563C1/.test(doc), 'links are styled (colored + underlined)');

    // ── XML is escaped (a stray <, & or control char can never corrupt the package) ──────────────────────────
    ok(/A &lt; B &amp; C/.test(doc), 'special characters are XML-escaped in the text');
    ok(!/A < B & C/.test(doc), 'no raw unescaped special characters leak into the XML');

    // ── blockquote is valid OOXML: ONE <w:pPr> per paragraph (a regex post-process once injected a second,
    //    producing <w:p> with two/three <w:pPr> — invalid CT_P that strict consumers prompt to repair) ──────────
    ok(/a quote/.test(doc), 'the blockquote text is present');
    ok(!/<\/w:pPr>\s*<w:pPr>/.test(doc), 'no paragraph carries two consecutive <w:pPr> (blockquote emits valid OOXML)');
    const nested = await (await JSZip.loadAsync(await markdownToDocx('> > deeply quoted'))).file('word/document.xml').async('string');
    ok(!/<\/w:pPr>\s*<w:pPr>/.test(nested), 'a NESTED blockquote also emits one <w:pPr> per paragraph');
    ok(/w:ind w:left="720"/.test(nested), 'a nested blockquote indents deeper (720 twips) — the recursion applies the indent');

    // ── download identity is single-sourced (lib/docx.js) for the server AND the client ──────────────────────
    ok(docx.DOCX_MIME === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'DOCX_MIME is the OOXML word type');
    ok(docx.DOCX_EXT === 'docx', 'DOCX_EXT is "docx"');
    ok(typeof docx.exportFileName === 'function' && /^.+ \d{4}-\d{2}-\d{2}\.docx$/.test(docx.exportFileName(new Date('2026-01-02T00:00:00'))), 'exportFileName builds "<label> YYYY-MM-DD.docx"');

    // Degrades, never throws: empty input still yields a valid (if near-empty) package.
    const empty = await markdownToDocx('');
    eq(empty.slice(0, 2).toString('latin1'), 'PK', 'empty input still yields a valid package');

    // ── wiring: the route and the frontend use the real .docx path ───────────────────────────────────────────
    const serverSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'server.js'), 'utf-8');
    ok(/\/api\/export\/docx/.test(serverSrc) && /markdownToDocx/.test(serverSrc), 'the server exposes POST /api/export/docx backed by markdownToDocx');
    ok(/Content-Type', docx\.DOCX_MIME/.test(serverSrc), 'the route returns the single-sourced Word content type (docx.DOCX_MIME, not a duplicated literal)');
    ok(/contentDisposition\(docx\.exportFileName\(\)\)/.test(serverSrc), 'the route names the file via the shared Content-Disposition helper (self-describing, RFC 6266)');
    const chatJs = fs.readFileSync(path.join(PROJECT, 'lib', 'public', 'js', 'chat.js'), 'utf-8');
    ok(/\/api\/export\/docx/.test(chatJs) && /base \+ '\.' \+ DOCX_EXT/.test(chatJs), 'the Word download fetches a real .docx from the server, naming it from the single-sourced extension');
    ok(/SETTINGS_META\.export/.test(chatJs), 'the client reads the docx MIME/ext/label from the injected settings (single source with the backend)');
    ok(!/application\/msword/.test(chatJs), 'the old HTML-as-.doc export is gone');

    // ── production-mode guard: docx.js must NOT require the npm `marked` (a devDependency the Docker, service,
    //    and desktop installs all drop) — it loads the vendored UMD that ships in lib/ in every mode. This is
    //    exactly the regression that silently 500'd every .docx export in production while passing in dev. ──
    const docxSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'docx.js'), 'utf-8');
    ok(!/require\(\s*['"]marked['"]\s*\)/.test(docxSrc),
      'docx.js does NOT require the npm "marked" package (a pruned devDependency — would 500 in production)');
    ok(/require\(\s*['"]\.\/public\/vendor\/marked\/marked\.umd\.js['"]\s*\)/.test(docxSrc),
      'docx.js loads the vendored marked UMD, which ships in standalone, Docker, and the desktop app');
    // And the vendored file it depends on actually exists and require()s with a usable lexer.
    const vendored = require(path.join(PROJECT, 'lib', 'public', 'vendor', 'marked', 'marked.umd.js'));
    ok(vendored && vendored.marked && typeof vendored.marked.lexer === 'function',
      'the vendored marked UMD exposes marked.lexer (the API docx.js uses)');

    console.log(`\nALL DOCX-EXPORT TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ DOCX-EXPORT TEST FAILED:', e && e.message);
    process.exit(1);
  }
})();
