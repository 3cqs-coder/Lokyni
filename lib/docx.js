'use strict';
// Build a REAL Word document (.docx / Office Open XML) from an answer's Markdown — not the old "HTML with a .doc
// extension" trick, which modern Word opens grudgingly and Pages refuses outright. A .docx is a small ZIP of XML
// parts; we assemble it with the already-bundled jszip, and parse the Markdown with the SAME vendored marked the
// browser uses. The result opens cleanly in Word, Pages, Google Docs, and LibreOffice.
//
// Scope: the constructs an answer actually contains — headings, paragraphs, bold/italic/strike/inline-code,
// links, bullet and numbered lists (rendered as indented, prefixed paragraphs so they open everywhere without a
// numbering part), block quotes, code blocks, tables, and rules. Formatting is applied directly on runs, so no
// styles part is strictly required; a tiny styles.xml just sets a clean default font. Unknown tokens degrade to
// their plain text — never dropped.

// The Markdown parser is the vendored marked (lib/public/vendor/marked/marked.umd.js), NOT the npm package:
// `marked` is a devDependency that the three production installs all drop (Docker/service `npm install --omit=dev`,
// and the desktop staging prune), so importing the npm package threw there and silently 500'd every .docx export.
// The vendored UMD is part of lib/, so it ships in all modes, it is the exact same marked version the browser
// renders with (one source of truth), and its UMD wrapper require()s cleanly in Node. It is loaded LAZILY inside
// markdownToDocx (below) so merely requiring this module for its MIME/extension constants — as settings-schema
// does to project them to the client — doesn't pull the parser into the startup path.

// ── XML helpers ──────────────────────────────────────────────────────────────────────────────────────────────
function xml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // Strip control chars that are illegal in XML 1.0 (keep tab/newline), so odd model output can't corrupt the file.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

// A run: text with optional bold/italic/strike/mono/link styling. Preserves newlines as <w:br/>.
function run(text, opt = {}) {
  const rpr = [];
  if (opt.b) rpr.push('<w:b/>');
  if (opt.i) rpr.push('<w:i/>');
  if (opt.strike) rpr.push('<w:strike/>');
  if (opt.mono) rpr.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>');
  if (opt.link) { rpr.push('<w:color w:val="0563C1"/>'); rpr.push('<w:u w:val="single"/>'); }
  if (opt.sz) rpr.push(`<w:sz w:val="${opt.sz}"/>` + `<w:szCs w:val="${opt.sz}"/>`);
  const rPr = rpr.length ? `<w:rPr>${rpr.join('')}</w:rPr>` : '';
  // Split on newlines so a hard line break inside a run renders as a Word break, not a space.
  const parts = String(text == null ? '' : text).split('\n');
  let body = '';
  parts.forEach((p, i) => {
    if (i > 0) body += '<w:br/>';
    body += `<w:t xml:space="preserve">${xml(p)}</w:t>`;
  });
  return `<w:r>${rPr}${body}</w:r>`;
}

// Walk marked INLINE tokens into an array of run XML strings, carrying style down.
function inlineRuns(tokens, inherit = {}) {
  const out = [];
  for (const t of tokens || []) {
    switch (t.type) {
      case 'strong':   out.push(...inlineRuns(t.tokens, { ...inherit, b: true })); break;
      case 'em':       out.push(...inlineRuns(t.tokens, { ...inherit, i: true })); break;
      case 'del':      out.push(...inlineRuns(t.tokens, { ...inherit, strike: true })); break;
      case 'codespan': out.push(run(t.text, { ...inherit, mono: true })); break;
      case 'br':       out.push(run('\n', inherit)); break;
      case 'link': {
        // Keep the link text; append the URL in parentheses when it adds information (not for a bare autolink).
        out.push(...inlineRuns(t.tokens, { ...inherit, link: true }));
        if (t.href && t.href !== t.text) out.push(run(` (${t.href})`, inherit));
        break;
      }
      case 'image':    out.push(run(t.text || t.href || '[image]', inherit)); break;
      case 'escape':
      case 'text':     out.push(t.tokens ? inlineRuns(t.tokens, inherit).join('') : run(t.text, inherit)); break;
      default:         out.push(run(t.raw != null ? t.raw : (t.text || ''), inherit));
    }
  }
  return out;
}

function para(runsXml, pprXml = '') {
  const pPr = pprXml ? `<w:pPr>${pprXml}</w:pPr>` : '';
  return `<w:p>${pPr}${runsXml}</w:p>`;
}

const HEADING_SZ = { 1: 36, 2: 32, 3: 28, 4: 26, 5: 24, 6: 24 };   // half-points (18pt … 12pt)

// Build the cells of one table row.
function tableRow(cells, { header } = {}) {
  const tcs = cells.map((cell) => {
    const runs = inlineRuns(cell.tokens, header ? { b: true } : {}).join('') || run('');
    return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${para(runs)}</w:tc>`;
  }).join('');
  return `<w:tr>${tcs}</w:tr>`;
}

// Walk marked BLOCK tokens into body XML. `indent` (twips) supports nested lists.
function blocks(tokens, indent = 0) {
  let out = '';
  const ind = indent ? `<w:ind w:left="${indent}"/>` : '';
  for (const t of tokens || []) {
    switch (t.type) {
      case 'heading': {
        const sz = HEADING_SZ[t.depth] || 24;
        out += para(inlineRuns(t.tokens, { b: true, sz }).join(''), `${ind}<w:spacing w:before="160" w:after="80"/>`);
        break;
      }
      case 'paragraph':
        out += para(inlineRuns(t.tokens).join(''), `${ind}<w:spacing w:after="120"/>`);
        break;
      case 'text':
        out += para(t.tokens ? inlineRuns(t.tokens).join('') : run(t.text), ind);
        break;
      case 'blockquote':
        // Indent the quoted block. The recursive call already applies the deeper `indent` to each child
        // paragraph's single <w:pPr>, so we must NOT post-process the string to inject another one — doing so
        // produced two <w:pPr> per <w:p> (three when nested, and it also hit table-cell paragraphs), which is
        // invalid OOXML (CT_P allows one) and makes strict consumers prompt to repair or drop the formatting.
        out += blocks(t.tokens, indent + 360);
        break;
      case 'list': {
        let n = typeof t.start === 'number' && t.start ? t.start : 1;
        for (const item of t.items || []) {
          const prefix = t.ordered ? `${n}. ` : '• ';
          // An item's first paragraph carries the bullet; nested blocks indent further.
          const itemTokens = item.tokens || [];
          const lead = [];
          const rest = [];
          let placedPrefix = false;
          for (const it of itemTokens) {
            if (!placedPrefix && (it.type === 'text' || it.type === 'paragraph')) {
              const runs = run(prefix) + (it.tokens ? inlineRuns(it.tokens).join('') : run(it.text));
              lead.push(para(runs, `<w:ind w:left="${indent + 360}" w:hanging="360"/><w:spacing w:after="40"/>`));
              placedPrefix = true;
            } else if (it.type === 'list') {
              rest.push(blocks([it], indent + 360));
            } else {
              rest.push(blocks([it], indent + 360));
            }
          }
          if (!placedPrefix) lead.push(para(run(prefix), `<w:ind w:left="${indent + 360}" w:hanging="360"/>`));
          out += lead.join('') + rest.join('');
          n++;
        }
        break;
      }
      case 'code': {
        // Each source line as a monospaced run separated by breaks, in one shaded paragraph.
        const text = String(t.text == null ? '' : t.text);
        out += para(run(text, { mono: true }), `${ind}<w:shd w:val="clear" w:fill="F4F4F4"/><w:spacing w:after="120"/>`);
        break;
      }
      case 'table': {
        const header = tableRow(t.header || [], { header: true });
        const rows = (t.rows || []).map((r) => tableRow(r)).join('');
        const borders = '<w:tblBorders>' +
          ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
            .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`).join('') +
          '</w:tblBorders>';
        out += `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>${borders}</w:tblPr>${header}${rows}</w:tbl>` + para('');
        break;
      }
      case 'hr':
        out += para('', `<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr>`);
        break;
      case 'space':
        break;
      case 'html':
        // Raw HTML isn't rendered (the chat sanitizes it out anyway) — keep any visible text.
        if (t.text && t.text.trim() && !/^<[^>]+>$/.test(t.text.trim())) out += para(run(t.text.replace(/<[^>]*>/g, ' ')));
        break;
      default:
        if (t.tokens) out += blocks(t.tokens, indent);
        else if (t.text) out += para(run(t.text), ind);
    }
  }
  return out;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr/></w:style></w:styles>`;

// Build the .docx as a Buffer from Markdown. Async because jszip compresses asynchronously.
async function markdownToDocx(markdown) {
  const JSZip = require('jszip');
  const { marked } = require('./public/vendor/marked/marked.umd.js');   // lazy — see the note at the top of the file
  let body = '';
  try {
    body = blocks(marked.lexer(String(markdown == null ? '' : markdown)));
  } catch (e) {
    // Never fail the export on a parser hiccup — fall back to the raw text as paragraphs.
    body = String(markdown == null ? '' : markdown).split(/\n{2,}/).map((p) => para(run(p))).join('');
  }
  if (!body) body = para(run(''));
  const sectPr = '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>';
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}${sectPr}</w:body></w:document>`;

  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.folder('_rels').file('.rels', ROOT_RELS);
  const word = zip.folder('word');
  word.file('document.xml', document);
  word.file('styles.xml', STYLES);
  word.folder('_rels').file('document.xml.rels', DOC_RELS);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

// The download identity of an exported answer — the SINGLE source for the MIME type, extension, and base label.
// The server uses these for the response's Content-Type + Content-Disposition; the client reads the same three
// (projected via CLIENT_SETTINGS.export) for the Save-As picker and anchor download, so the two can't drift.
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOCX_EXT = 'docx';
const ANSWER_BASE_LABEL = 'Lokyni answer';
// `Lokyni answer YYYY-MM-DD.docx` from a Date (defaults to now). ISO date — language/locale-independent.
const exportFileName = (date = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${ANSWER_BASE_LABEL} ${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}.${DOCX_EXT}`;
};

module.exports = { markdownToDocx, DOCX_MIME, DOCX_EXT, ANSWER_BASE_LABEL, exportFileName };
