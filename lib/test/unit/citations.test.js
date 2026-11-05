'use strict';
// Guards citation interoperability: RIS, BibTeX, and CSL-JSON parse into one shared reference shape, format back
// out without losing fields, escape BibTeX, and never invent a 1970 date. The import writer is exercised in a
// temporary folder. Also checks that the API and UI are wired to this one module. No network or model.
// Run: `npm run test:unit`.

const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');
const cite = require(path.join(PROJECT, 'lib', 'citations'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };

const sources = [
  { source: 'Planning brief.pdf', fileType: 'pdf', viewerLink: '/document/x', snippet: 'A short summary.' },
  { source: 'Field notes', isWeb: true, url: 'https://example.org/notes', snippet: 'Page summary.' },
];

(async () => {
try {
  // ── Export then re-parse (RIS) round-trips the shared fields ──
  const refs = cite.sourcesToReferences(sources);
  eq(refs.length, 2, 'every source becomes a reference');
  eq(refs[0].title, 'Planning brief.pdf', 'the document name is the title');
  eq(refs[0].url, '', 'an in-app viewer link is not exported as a URL');
  eq(refs[1].url, 'https://example.org/notes', 'a web source keeps its URL');
  eq(refs[1].type, 'webpage', 'a web source is typed as a webpage');

  const ris = cite.formatReferences(refs, 'ris');
  const fromRis = cite.parseReferences(ris, 'ris');
  eq(fromRis.length, 2, 'RIS round-trips both entries');
  eq(fromRis[0].title, 'Planning brief.pdf', 'RIS keeps the title');
  eq(fromRis[1].url, 'https://example.org/notes', 'RIS keeps the URL');

  // ── CSL-JSON round-trip, and it is valid JSON ──
  const cslText = cite.formatReferences(refs, 'csl', '2026-10-28');
  const parsedJson = JSON.parse(cslText);
  ok(Array.isArray(parsedJson) && parsedJson.length === 2, 'CSL export is a JSON array');
  const fromCsl = cite.parseReferences(cslText, 'csl');
  eq(fromCsl[1].url, 'https://example.org/notes', 'CSL keeps the URL');
  eq(fromCsl[0].title, 'Planning brief.pdf', 'CSL keeps the title');

  // ── BibTeX escaping and keys ──
  const tricky = [{ type: 'document', title: 'Cost & benefit: 50% of $5 for #1', authors: ['Ada Lovelace'], year: 2024, venue: 'Journal of {Tests}', doi: '', url: 'https://example.org/a_b', abstract: '' }];
  const bib = cite.formatReferences(tricky, 'bibtex');
  ok(/@misc\{/.test(bib), 'BibTeX uses a citeable @misc entry');
  ok(/Cost \\& benefit: 50\\% of \\\$5 for \\#1/.test(bib), 'BibTeX escapes & % $ #');
  ok(/author = \{Ada Lovelace\}/.test(bib), 'BibTeX keeps the author');
  const fromBib = cite.parseReferences(bib, 'auto');
  eq(fromBib.length, 1, 'BibTeX parses back');
  eq(fromBib[0].year, 2024, 'BibTeX keeps the year');
  ok(/Cost & benefit/.test(fromBib[0].title), 'BibTeX unescapes into readable text');
  const slash = [{ type: 'document', title: 'A \\& B', authors: [], year: null, venue: '', doi: '', url: '', abstract: '' }];
  eq(cite.parseReferences(cite.formatReferences(slash, 'bibtex'), 'auto')[0].title, 'A \\& B',
    'a literal backslash before an escaped character survives the round trip');

  // ── A value with a newline cannot inject a second RIS tag ──
  const injected = cite.formatReferences([{ type: 'document', title: 'Plan\nTI  - Injected', authors: [], year: null, venue: '', doi: '', url: '', abstract: '' }], 'ris');
  eq((injected.match(/^TI  - /gm) || []).length, 1, 'a newline in a title cannot add another TI line');

  // ── No fabricated date: an absent year stays absent ──
  const noYear = cite.sourcesToReferences([{ source: 'Undated note' }]);
  eq(noYear[0].year, null, 'a source with no date has no year');
  ok(!/1970/.test(cite.formatReferences(noYear, 'csl')), 'CSL export never emits a 1970 date');
  ok(!/year = \{1970\}/.test(cite.formatReferences(noYear, 'bibtex')), 'BibTeX export never emits a 1970 year');

  // ── Format detection and malformed input are total ──
  eq(cite.detectFormat('TY  - GEN\nTI  - A\nER  - '), 'ris', 'RIS is detected');
  eq(cite.detectFormat('[{"title":"A"}]'), 'csl', 'CSL is detected');
  eq(cite.detectFormat('@article{k, title={A}}'), 'bib', 'BibTeX is detected');
  eq(cite.detectFormat('\uFEFF  [{"title":"A"}]'), 'csl', 'a BOM and leading space do not break detection');
  eq(cite.parseReferences('\uFEFFTY  - GEN\nTI  - BOM entry\nER  - ', 'auto')[0].title, 'BOM entry',
    'a BOM before the first RIS tag is stripped');
  eq(cite.parseReferences('[{"title":"BOM CSL"}]'.replace('[', '\uFEFF['), 'auto')[0].title, 'BOM CSL',
    'a BOM before CSL-JSON is stripped');
  eq(cite.parseReferences('\uFEFF@article{k, title={BOM Bib}}', 'auto')[0].title, 'BOM Bib',
    'a BOM before a BibTeX entry is stripped');
  eq(cite.parseReferences('not a reference file'), [], 'unrecognized text yields no references');
  eq(cite.parseReferences('{ not json'), [], 'malformed JSON yields no references');
  eq(cite.parseReferences('@article{broken'), [], 'a truncated BibTeX entry is skipped');
  eq(cite.parseReferences(''), [], 'empty text yields no references');

  // ── Bounds: a huge input cannot produce an unbounded list ──
  const many = Array.from({ length: cite.MAX_REFS + 50 }, (_, i) => `TY  - GEN\nTI  - Ref ${i}\nER  - `).join('\n');
  ok(cite.parseReferences(many, 'ris').length <= cite.MAX_REFS, 'the reference count is capped');

  // ── Import writes ordinary documents, atomically and without collision ──
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-cite-'));
  try {
    const text = 'TY  - GEN\nTI  - First reference\nAU  - Doe, Jane\nPY  - 2023\nER  - \n';
    const r1 = await cite.importReferences(text, 'ris', tmp);
    eq(r1.count, 1, 'one reference is written');
    ok(fs.existsSync(path.join(tmp, r1.files[0])), 'the document exists on disk');
    ok(/^First reference\n/.test(fs.readFileSync(path.join(tmp, r1.files[0]), 'utf-8')),
      'the title is the first line, so the indexer and document list present it naturally');
    const r2 = await cite.importReferences(text, 'ris', tmp);
    ok(r2.files[0] !== r1.files[0], 'a repeated import does not overwrite the earlier document');
    await assert.rejects(() => cite.importReferences('', 'ris', tmp), /No references/,
      'an empty import is rejected with a clear message');

    // Windows device names and trailing dots/spaces are not valid file names there; the writer neutralizes
    // them so an import never fails just because a paper is titled "CON" or ends with a period.
    const win = await cite.importReferences('TY  - GEN\nTI  - CON\nER  - \nTY  - GEN\nTI  - AUX\nER  - \n', 'ris', tmp);
    eq(win.count, 2, 'reserved-name titles still import');
    ok(win.files.every((f) => !/^(con|aux)\.txt$/i.test(f)), 'reserved device names are prefixed, not written raw');
    ok(cite.safeFileBase('trailing. ', 'fallback') === 'trailing', 'trailing dots and spaces are removed');
    ok(cite.safeFileBase('', 'fallback') === 'fallback', 'an empty base falls back');

    // The writer is async (no event-loop block) and uses the shared atomic writer.
    const srcText = read('lib/citations.js');
    ok(/const importReferences = async \(text, format, docsDir\)/.test(srcText) &&
       /await writeFileAtomicAsync\(/.test(srcText) && !/writeFileAtomic\(/.test(srcText.replace(/writeFileAtomicAsync\(/g, '')),
      'references are written asynchronously through the atomic writer');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  // ── One format list drives the server, the view, and the client ──
  eq(cite.FORMATS.map((f) => f.id), ['bibtex', 'ris', 'csl'], 'the format list is the single source');
  ok(cite.formatById('nope').id === 'bibtex' && cite.formatById('ris').ext === 'ris', 'an unknown format falls back to the default');
  const ejsFormats = read('lib/views/chat.ejs');
  ok(/citationFormats/.test(ejsFormats) && /data-ext="<%= f\.ext %>"/.test(ejsFormats), 'the export dialog renders its formats from the shared list');
  const serverSrc = read('lib/server.js');
  ok(/citationFormats: require\('\.\/citations'\)\.FORMATS/.test(serverSrc), 'the view receives the same list');
  const chatSrc = read('lib/public/js/chat.js');
  ok(/opt\.dataset\.ext/.test(chatSrc) && !/format === 'ris' \? 'ris'/.test(chatSrc), 'the client reads the extension from the option, not a second mapping');

  // ── API + UI are wired to the shared module ──
  const routes = read('lib/routes/documents.js');
  ok(/router\.post\('\/citations\/export', docRead/.test(routes), 'the export route needs document read access');
  ok(/router\.post\('\/citations\/import', authmw\.requirePrimary, docWrite/.test(routes), 'the import route needs document write access');
  ok(/cite\.formatReferences\(refs, format, today\)/.test(routes) && /const cite = require\('\.\.\/citations'\)/.test(routes),
    'the export route formats through the shared module');
  ok(/await require\('\.\.\/citations'\)\.importReferences\(text, body\.format, docsDir\)/.test(routes),
    'the import route writes through the shared module');
  ok(/await reflectDocChange\(wsId\)/.test(routes.slice(routes.indexOf("'/citations/import'"))),
    'a successful import is reflected into the index');

  const chat = read('lib/public/js/chat.js');
  ok(/function downloadCitations\(/.test(chat) && /\/api\/documents\/citations\/export/.test(chat),
    'the client exports through the shared route');
  ok(/function importCitations\(/.test(chat) && /\/api\/documents\/citations\/import/.test(chat),
    'the client imports through the shared route');
  ok(/ans-cite-export/.test(chat) && /Export citations/.test(chat), 'the answer menu offers citation export');
  const ejs = read('lib/views/chat.ejs');
  ok(/id="cite-export-overlay"/.test(ejs) && /id="cite-import-overlay"/.test(ejs),
    'both citation dialogs exist');
  const panel = read('lib/views/partials/doc-panel.ejs');
  ok(/id="cite-import-btn"/.test(panel), 'the document panel offers reference import');
  ok(/id="cite-import-text"[^>]*dir="auto"/.test(ejsFormats), 'pasted references display in their own direction (RTL-safe)');

  console.log(`\nALL CITATION UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ CITATION UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
})();
