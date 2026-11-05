'use strict';
// Citation interoperability: parse reference-manager exports (RIS and CSL-JSON) and format a source list as
// BibTeX, RIS, or CSL-JSON. One module owns every field mapping, escape rule, and date rule, so import and
// export cannot drift. Pure and bounded; the import writer uses the shared atomic file helper.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { isWindowsReserved } = require('./paths');
const { writeFileAtomicAsync } = require('./disk');

const MAX_REFS = 500;
const MAX_FIELD = 5000;
const MAX_INPUT = 5 * 1024 * 1024;
const clean = (v, max = MAX_FIELD) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const firstYear = (v) => {
  const m = String(v == null ? '' : v).match(/\b(\d{4})\b/);
  const n = m ? Number(m[1]) : 0;
  return (n >= 1000 && n <= 3000) ? n : null;
};
const authorsOf = (v) => {
  if (!Array.isArray(v)) return [];
  return v.map((a) => {
    if (typeof a === 'string') return clean(a, 300);
    if (a && typeof a === 'object') return clean(a.literal || `${a.given || ''} ${a.family || ''}`, 300);
    return '';
  }).filter(Boolean).slice(0, 20);
};

// ── Parsers ────────────────────────────────────────────────────────────────────────────────────────────────
// RIS is a line format: a two-character tag, then "  - ", then the value. A record starts at TY and ends at ER.
const parseRIS = (text) => {
  const out = [];
  let cur = null;
  // A UTF-8 BOM is common in files saved by Windows reference tools; strip it or the first tag would not parse.
  const lines = String(text || '').replace(/^\uFEFF/, '').slice(0, MAX_INPUT).split(/\r?\n/);
  for (const line of lines) {
    const m = /^([A-Z][A-Z0-9])\s*-\s?(.*)$/.exec(line);
    if (!m) continue;
    const tag = m[1], val = clean(m[2]);
    if (tag === 'TY') { cur = { type: val, title: '', authors: [], year: null, venue: '', doi: '', url: '', abstract: '' }; continue; }
    if (!cur) continue;
    if (tag === 'ER') {
      if (cur.title || cur.url || cur.doi) out.push(cur);
      cur = null;
      if (out.length >= MAX_REFS) break;
      continue;
    }
    if (tag === 'TI' || tag === 'T1') cur.title = cur.title || val;
    else if (tag === 'AU' || tag === 'A1') cur.authors.push(val);
    else if (tag === 'PY' || tag === 'Y1' || tag === 'DA') cur.year = cur.year || firstYear(val);
    else if (tag === 'JO' || tag === 'JF' || tag === 'T2' || tag === 'JA') cur.venue = cur.venue || val;
    else if (tag === 'DO') cur.doi = cur.doi || val;
    else if (tag === 'UR' || tag === 'L2') cur.url = cur.url || val;
    else if (tag === 'AB' || tag === 'N2') cur.abstract = cur.abstract || val;
  }
  return out.slice(0, MAX_REFS).map((r) => ({ ...r, title: clean(r.title, 500), url: clean(r.url, 2000), doi: clean(r.doi, 300), abstract: clean(r.abstract) }));
};

// BibTeX: `@type{key, field = {value}, …}`. Values may be braced (so they can nest), quoted, or bare. Only the
// fields the shared reference shape carries are read; everything is bounded and a malformed entry is skipped
// rather than failing the whole import.
const bibUnescape = (s) => String(s == null ? '' : s)
  // Simple escapes first, then the text commands, so a literal "\\&" survives the round trip instead of the
  // backslash being consumed in the wrong order.
  .replace(/\\([&%$#_{}])/g, '$1')
  .replace(/\\textbackslash\{\}/g, '\\')
  .replace(/\\textasciitilde\{\}/g, '~')
  .replace(/\\textasciicircum\{\}/g, '^');
const readBibField = (block, name) => {
  const m = new RegExp(`(?:^|[,{\\s])${name}\\s*=\\s*`, 'i').exec(block);
  if (!m) return '';
  const i = m.index + m[0].length;
  if (block[i] === '{') {
    let depth = 0, j = i;
    for (; j < block.length; j++) {
      if (block[j] === '{') depth++;
      else if (block[j] === '}') { depth--; if (depth === 0) break; }
    }
    return j > i ? block.slice(i + 1, j) : '';
  }
  if (block[i] === '"') {
    const j = block.indexOf('"', i + 1);
    return j > i ? block.slice(i + 1, j) : '';
  }
  const comma = block.indexOf(',', i);
  return block.slice(i, comma === -1 ? block.length : comma);
};
const parseBibTeX = (text) => {
  const src = String(text || '').replace(/^\uFEFF/, '').slice(0, MAX_INPUT);
  const out = [];
  const entryRe = /@([a-zA-Z]+)\s*([{(])/g;
  let m;
  while ((m = entryRe.exec(src)) !== null && out.length < MAX_REFS) {
    const type = m[1].toLowerCase();
    const open = m[2], close = open === '{' ? '}' : ')';
    let depth = 0, i = m.index + m[0].length - 1, end = -1;
    for (; i < src.length; i++) {
      if (src[i] === open) depth++;
      else if (src[i] === close) { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) break;
    const block = src.slice(m.index + m[0].length, end);
    entryRe.lastIndex = end + 1;
    if (type === 'comment' || type === 'string' || type === 'preamble') continue;
    const title = bibUnescape(clean(readBibField(block, 'title'), 500));
    const authors = readBibField(block, 'author').split(/\s+and\s+/).map((a) => bibUnescape(clean(a, 300))).filter(Boolean).slice(0, 20);
    const year = firstYear(readBibField(block, 'year') || readBibField(block, 'date'));
    const venue = bibUnescape(clean(readBibField(block, 'journal') || readBibField(block, 'booktitle') || readBibField(block, 'publisher'), 500));
    const doi = clean(readBibField(block, 'doi'), 300);
    const url = clean(readBibField(block, 'url'), 2000);
    const abstract = bibUnescape(clean(readBibField(block, 'abstract')));
    if (title || url || doi) out.push({ type, title, authors, year, venue, doi, url, abstract });
  }
  return out;
};

// CSL-JSON is an array of items (or an object with `items`). Authors can be {given,family}, {literal}, or strings.
const parseCSLJSON = (text) => {
  try {
    const data = JSON.parse(String(text || '').replace(/^\uFEFF/, '').slice(0, MAX_INPUT));
    const items = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : []);
    return items.slice(0, MAX_REFS).map((it) => {
      if (!it || typeof it !== 'object') return null;
      const year = it.issued && Array.isArray(it.issued['date-parts']) && Array.isArray(it.issued['date-parts'][0])
        ? firstYear(it.issued['date-parts'][0][0]) : firstYear(it.issued);
      return {
        type: clean(it.type, 40),
        title: clean(it.title || it['title-short'], 500),
        authors: authorsOf(it.author),
        year,
        venue: clean(it['container-title'] || it.publisher, 500),
        doi: clean(it.DOI, 300),
        url: clean(it.URL, 2000),
        abstract: clean(it.abstract),
      };
    }).filter((r) => r && (r.title || r.url || r.doi));
  } catch { return []; }
};

const detectFormat = (text) => {
  const head = String(text || '').replace(/^\uFEFF/, '').trimStart();
  if (/^[\[{]/.test(head)) return 'csl';
  if (/^@\w+\s*[{(]/.test(head)) return 'bib';
  return 'ris';
};
const parseReferences = (text, format = 'auto') => {
  const fmt = ['ris', 'csl', 'bib'].includes(format) ? format : detectFormat(text);
  if (fmt === 'csl') return parseCSLJSON(text);
  if (fmt === 'bib') return parseBibTeX(text);
  return parseRIS(text);
};

// ── Export formatting ──────────────────────────────────────────────────────────────────────────────────────
const sourceToRef = (s) => ({
  type: s && s.isWeb ? 'webpage' : 'document',
  title: clean(s && (s.source || s.title || s.url), 500) || 'Untitled source',
  authors: [],
  year: firstYear(s && s.published),
  venue: '',
  doi: clean(s && s.doi, 300),
  // Only a real external URL belongs in a reference. A local document's viewerLink is an in-app route that
  // would be meaningless in another application.
  url: clean(s && s.url, 2000),
  abstract: clean(s && (s.snippet || s.text)),
});
const sourcesToReferences = (sources) => (Array.isArray(sources) ? sources.slice(0, MAX_REFS).map(sourceToRef) : []);

const bibEscape = (s) => String(s == null ? '' : s)
  .replace(/\\/g, '\\textbackslash{}').replace(/([&%$#_{}])/g, '\\$1')
  .replace(/~/g, '\\textasciitilde{}').replace(/\^/g, '\\textasciicircum{}');
const bibKey = (ref, i, used) => {
  const base = (ref.authors[0] || ref.title || 'ref').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24) || 'ref';
  let key = `${base}${ref.year || ''}`;
  if (!key) key = 'ref';
  while (used.has(key)) key = `${key}${i + 1}`;
  used.add(key);
  return key;
};
const toBibTeX = (refs, accessed) => {
  const used = new Set();
  return refs.map((r, i) => {
    const lines = [`  title = {${bibEscape(r.title)}}`];
    if (r.authors.length) lines.push(`  author = {${r.authors.map(bibEscape).join(' and ')}}`);
    if (r.year) lines.push(`  year = {${r.year}}`);
    if (r.venue) lines.push(`  howpublished = {${bibEscape(r.venue)}}`);
    if (r.doi) lines.push(`  doi = {${bibEscape(r.doi)}}`);
    if (r.url) lines.push(`  url = {${bibEscape(r.url)}}`);
    if (accessed) lines.push(`  note = {Accessed ${accessed}}`);
    if (r.abstract) lines.push(`  abstract = {${bibEscape(r.abstract)}}`);
    return `@misc{${bibKey(r, i, used)},\n${lines.join(',\n')}\n}`;
  }).join('\n\n');
};
// RIS is line-based: a newline inside a value would inject a new tag (a document name can legally contain
// one), so every value is collapsed to one line.
const risLine = (tag, value) => `${tag}  - ${String(value == null ? '' : value).replace(/\s+/g, ' ').trim()}`;
const toRIS = (refs) => refs.map((r) => {
  const lines = [risLine('TY', r.type === 'webpage' ? 'ELEC' : 'GEN'), risLine('TI', r.title)];
  for (const a of r.authors) lines.push(risLine('AU', a));
  if (r.year) lines.push(risLine('PY', r.year));
  if (r.venue) lines.push(risLine('JO', r.venue));
  if (r.doi) lines.push(risLine('DO', r.doi));
  if (r.url) lines.push(risLine('UR', r.url));
  if (r.abstract) lines.push(risLine('AB', r.abstract));
  lines.push('ER  - ');
  return lines.join('\n');
}).join('\n\n');
const toCSLJSON = (refs, accessed) => {
  const dateParts = (() => {
    const m = String(accessed || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? [[Number(m[1]), Number(m[2]), Number(m[3])]] : null;
  })();
  return JSON.stringify(refs.map((r, i) => ({
    id: `ref-${i + 1}`,
    type: r.type === 'webpage' ? 'webpage' : 'document',
    title: r.title,
    ...(r.authors.length ? { author: r.authors.map((a) => ({ literal: a })) } : {}),
    ...(r.year ? { issued: { 'date-parts': [[r.year]] } } : {}),
    ...(r.venue ? { 'container-title': r.venue } : {}),
    ...(r.doi ? { DOI: r.doi } : {}),
    ...(r.url ? { URL: r.url } : {}),
    ...(r.abstract ? { abstract: r.abstract } : {}),
    ...(dateParts ? { accessed: { 'date-parts': dateParts } } : {}),
  })), null, 2);
};
const formatReferences = (refs, format = 'bibtex', accessed = '') => {
  if (format === 'ris') return toRIS(refs);
  if (format === 'csl') return toCSLJSON(refs, accessed);
  return toBibTeX(refs, accessed);
};
// The export formats, in one place: the Settings/answer dialog renders its options from this list (through the
// view locals), the server sets the content type from it, and the client reads the selected option's data
// attributes. Adding a format therefore needs no parallel list in the client or a second mapping in a route.
const FORMATS = Object.freeze([
  { id: 'bibtex', label: 'BibTeX (.bib)', ext: 'bib', mime: 'application/x-bibtex' },
  { id: 'ris', label: 'RIS (.ris)', ext: 'ris', mime: 'application/x-research-info-systems' },
  { id: 'csl', label: 'CSL-JSON (.json)', ext: 'json', mime: 'application/json' },
]);
const formatById = (format) => FORMATS.find((f) => f.id === format) || FORMATS[0];
const extensionFor = (format) => formatById(format).ext;
const mimeFor = (format) => formatById(format).mime;

// ── Import writer ─────────────────────────────────────────────────────────────────────────────────────────
// One reference becomes a small searchable text document. The first line is the title, so the normal indexer
// and the document list present it naturally. Filenames are ASCII-safe, collision-suffixed, and never derived
// from a path.
const referenceText = (r) => {
  // One readable title line, even if the source title wrapped in the imported file.
  const head = [String(r.title || '').replace(/\s+/g, ' ').trim()];
  if (r.authors.length || r.year || r.venue) {
    head.push([r.authors.join(', '), r.year ? `(${r.year})` : '', r.venue].filter(Boolean).join(' '));
  }
  if (r.doi) head.push(`DOI: ${r.doi}`);
  if (r.url) head.push(`URL: ${r.url}`);
  if (r.abstract) head.push('', r.abstract);
  return head.join('\n').trim() + '\n';
};
const slug = (s) => String(s || '').normalize('NFKD').replace(/[^\x00-\x7F]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
// Windows reserves these device names (with or without an extension) in every directory; a file called
// con.txt cannot be created there. Prefixing keeps the reference import working on Windows without a special
// error, and the same rule is harmless on macOS/Linux. Trailing dots/spaces are also illegal on Windows.
const safeFileBase = (base, fallback) => {
  let b = String(base || '').replace(/[. ]+$/g, '').slice(0, 80);
  if (!b) b = fallback;
  if (isWindowsReserved(b)) b = `reference-${b}`;
  return b;
};
// Async so an import of hundreds of references never blocks the event loop; each file is still written with the
// shared atomic writer, so a crash cannot leave a half-written reference.
const importReferences = async (text, format, docsDir) => {
  const refs = parseReferences(text, format);
  if (!refs.length) throw new Error('No references were found in that file.');
  if (!docsDir || typeof docsDir !== 'string') throw new Error('No document folder is available.');
  await fsp.mkdir(docsDir, { recursive: true });
  const files = [];
  const used = new Set();
  let n = 0;
  for (const r of refs) {
    const base = safeFileBase(slug(r.title), `reference-${++n}`);
    let name = `${base}.txt`;
    let suffix = 2;
    while (used.has(name) || await fsp.access(path.join(docsDir, name)).then(() => true).catch(() => false)) {
      if (suffix > 1000) throw new Error('Too many documents share that name — rename or remove some, then try again.');
      name = `${base}-${suffix++}.txt`;
    }
    used.add(name);
    await writeFileAtomicAsync(path.join(docsDir, name), referenceText(r));
    files.push(name);
  }
  return { count: files.length, files };
};

module.exports = {
  parseRIS, parseBibTeX, parseCSLJSON, detectFormat, parseReferences, sourcesToReferences, sourceToRef,
  toBibTeX, toRIS, toCSLJSON, formatReferences, extensionFor, mimeFor, importReferences, referenceText,
  FORMATS, formatById, safeFileBase, MAX_REFS,
};
