'use strict';
// EPUB text extraction. An EPUB is a ZIP of XHTML content documents plus an OPF
// package file that lists them and gives their reading order (the "spine"). We read
// the spine for correct order and extract each content document's text — reusing the
// same readable-text extractor the web-search and .html paths use, so an EPUB chapter
// is cleaned exactly like a saved web page. No new dependency: jszip is already present
// (a transitive dep), and the HTML→text step is shared.

const JSZip = require('jszip');

// Join and normalize a zip-internal path relative to a base directory (POSIX-style;
// zip entries always use forward slashes). Strips any URL fragment.
const resolveZipPath = (base, href) => {
  const raw = String(href).split('#')[0];
  // A single malformed percent-escape (e.g. a literal "50% off.xhtml" slipped into an href) makes
  // decodeURIComponent throw URIError. Un-caught, that would propagate out of the spine loop and reduce the
  // ENTIRE book to name-only. Fall back to the raw href so at worst one chapter mis-resolves, never the book.
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { decoded = raw; }
  const parts = (base ? base.split('/') : []).concat(decoded.split('/'));
  const out = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
};

const extractEpubText = async (buffer) => {
  const { _extractReadableText } = require('../websearch');   // lazy: avoid load cycle
  const zip = await JSZip.loadAsync(buffer);
  const readText = (p) => { const f = zip.file(p); return f ? f.async('string') : Promise.resolve(null); };

  // 1. Find the OPF package file — normally via META-INF/container.xml, else the
  //    first .opf anywhere in the archive.
  let opfPath = null;
  const container = await readText('META-INF/container.xml');
  if (container) {
    const m = container.match(/<rootfile[^>]*\bfull-path="([^"]+)"/i);
    if (m) opfPath = m[1];
  }
  if (!opfPath) opfPath = Object.keys(zip.files).find(n => n.toLowerCase().endsWith('.opf')) || null;

  // 2. From the OPF, map manifest ids → hrefs (html/xml items only), then read the
  //    spine to get the content documents in reading order.
  const contentPaths = [];
  if (opfPath) {
    const opf = await readText(opfPath);
    if (opf) {
      const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
      const idToHref = new Map();
      let im; const itemRe = /<item\b[^>]*>/gi;
      while ((im = itemRe.exec(opf))) {
        const tag = im[0];
        const id    = (tag.match(/\bid="([^"]+)"/i) || [])[1];
        const href  = (tag.match(/\bhref="([^"]+)"/i) || [])[1];
        const media = (tag.match(/\bmedia-type="([^"]+)"/i) || [])[1] || '';
        if (id && href && /html|xml/i.test(media)) idToHref.set(id, href);
      }
      let is; const spineRe = /<itemref\b[^>]*\bidref="([^"]+)"[^>]*>/gi;
      while ((is = spineRe.exec(opf))) {
        const href = idToHref.get(is[1]);
        if (href) contentPaths.push(resolveZipPath(opfDir, href));
      }
    }
  }

  // 3. Fallback: no spine resolved → every (x)html file in name order.
  if (contentPaths.length === 0) {
    for (const name of Object.keys(zip.files).sort()) {
      if (/\.x?html?$/i.test(name)) contentPaths.push(name);
    }
  }

  // 4. Extract and concatenate.
  const parts = [];
  for (const p of contentPaths) {
    const html = await readText(p);
    if (!html) continue;
    const text = _extractReadableText(html);
    if (text && text.trim()) parts.push(text.trim());
  }
  return parts.join('\n\n');
};

module.exports = { extractEpubText };
