'use strict';
// Office-document helpers for PPTX text and for visual ingest of DOCX/PPTX images.
//
// A DOCX and a PPTX are both ZIP containers. Word already extracts DOCX text via mammoth,
// but PowerPoint isn't a text format at all — its content lives in slide XML — and neither
// format's EMBEDDED IMAGES (a chart, a diagram, a screenshot pasted onto a slide) are seen
// by text extraction. This module fills both gaps, reusing the tools already present:
//   • jszip (a transitive dep, already used for EPUB and the zip-bomb guard) to read entries;
//   • the vision backend (lib/vision.describeImage) to describe embedded images so their
//     content becomes searchable;
//   • sharp (the one libvips build, via lib/ocr.loadSharp) to skip decorative thumbnails.
//
// There is no page renderer for these formats, so visual ingest describes the embedded
// images rather than rendering pages (the PDF path renders pages — see visualdocs.js).
// Everything here is bounded and best-effort so it can never break indexing.

const cfg = () => require('../config');

// ── PPTX text ────────────────────────────────────────────────────────────────
// Slides live at ppt/slides/slideN.xml; their visible text is in <a:t>…</a:t> runs. Read the
// slides in numeric order and pull those runs, one labeled block per slide. Speaker notes
// (ppt/notesSlides/*) are included after the slides, since they often carry the substance.
// XML predefines only lt/gt/quot/apos/amp plus numeric refs; the shared decoder handles those (and hex
// numeric refs, which the old inline version missed) in one astral-safe pass, so office/PPTX text reuses it.
const { decodeEntities: decodeXmlEntities } = require('../htmlstrip');

const runsFromSlideXml = (xml) => {
  const out = [];
  let m; const re = /<a:t>([\s\S]*?)<\/a:t>/g;
  while ((m = re.exec(xml))) { const t = decodeXmlEntities(m[1]).trim(); if (t) out.push(t); }
  return out.join(' ').replace(/\s{2,}/g, ' ').trim();
};

const slideNum = (name) => { const m = name.match(/(\d+)\.xml$/); return m ? parseInt(m[1], 10) : 0; };

const extractPptxText = async (buffer) => {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files);
  const slides = names.filter(n => /^ppt\/slides\/slide\d+\.xml$/i.test(n)).sort((a, b) => slideNum(a) - slideNum(b));
  const notes  = names.filter(n => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(n)).sort((a, b) => slideNum(a) - slideNum(b));
  const parts = [];
  for (const s of slides) {
    const xml = await zip.file(s).async('string');
    const text = runsFromSlideXml(xml);
    if (text) parts.push(`Slide ${slideNum(s)}: ${text}`);
  }
  const noteParts = [];
  for (const n of notes) {
    const xml = await zip.file(n).async('string');
    const text = runsFromSlideXml(xml);
    if (text) noteParts.push(`Notes for slide ${slideNum(n)}: ${text}`);
  }
  if (noteParts.length) parts.push('Speaker notes:', ...noteParts);
  return parts.join('\n');
};

// ── DOCX / PPTX embedded-image description ────────────────────────────────────
// Media entries live under word/media/ (DOCX) and ppt/media/ (PPTX). Describe each raster
// image with the vision model so a pasted chart or diagram is searchable. Skips vector art
// (EMF/WMF sharp can't read) and images too small to carry meaning (icons, bullets, logos).
const MEDIA_RE = /^(word|ppt)\/media\/[^/]+\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

// Downscale an embedded image to a bounded PNG thumbnail for the figure store.
const toThumb = async (sharp, imgBuf) => {
  try {
    return await sharp(imgBuf).rotate().removeAlpha()
      .resize({ width: 900, height: 900, fit: 'inside', withoutEnlargement: true })
      .png().toBuffer();
  } catch { return null; }
};

// Returns { text, figures }: `text` is the indexable description block, `figures` is the crop
// manifest ([{ id, page:null, label, type:'image', description }]) when cropping is on, else
// []. Never throws.
// `dirOverride` (optional): the workspace cache directory the descriptions and thumbnails belong in.
// Omitted for the active workspace; set when warming a NON-active workspace so its thumbnails land
// beside the manifest that references them, not in the active directory.
const describeOfficeImages = async (buffer, fileName = '', dirOverride = null) => {
  const c = cfg();
  const label = require('path').basename(fileName || 'document');
  const EMPTY = { text: '', figures: [] };
  if (!c.useVisualIngest) return EMPTY;
  if (!c.VISION_MODEL || !String(c.VISION_MODEL).trim()) return EMPTY;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return EMPTY;
  if (buffer.length > (c.visualIngestMaxBytes || Infinity)) {
    if (c.DEBUG) console.log(`   🖼️  Office visual ingest skipped for ${label} — larger than the size cap`);
    return EMPTY;
  }

  const crop = c.visualIngestCropFigures === true;
  const cache = require('../visualcache');
  const store = require('./figurestore');
  const cacheDir = dirOverride || c.CACHE_DIR;
  // `key` (pure hex) names the thumbnails; `cacheKey` namespaces the description cache by crop
  // mode so toggling visualIngestCropFigures re-runs with thumbnails instead of a stale
  // crop-less manifest.
  // Fold the vision model into the key so switching visionModel re-describes an unchanged embedded image
  // rather than reusing the previous model's description (and re-crops, since a different model may bound
  // figures differently).
  const key = cache.keyFor(buffer, c.VISION_MODEL || '');
  const cacheKey = crop ? `${key}:c` : key;

  const cachedRec = cache.getRecord(cacheKey, dirOverride);
  if (cachedRec) {
    if (c.DEBUG) console.log(`   ↩️  Office visual-ingest cache hit: ${label}`);
    const figures = crop ? cachedRec.figures.filter(f => f && f.id && store.hasCrop(cacheDir, f.id)) : [];
    return { text: cachedRec.text, figures };
  }

  // Vet the archive for a decompression bomb BEFORE inflating any media entry — this image path
  // runs in the main process (vision needs the provider client) and jszip would otherwise inflate a
  // crafted media entry to gigabytes and OOM the server. Mirrors the text path's assertSafeZip.
  if (!require('./zipguard').zipWithinBudget(buffer)) {
    if (c.DEBUG) console.log(`   🖼️  Skipping ${label} visual ingest — archive exceeds the safe decompression budget`);
    return EMPTY;
  }

  let zip;
  try { zip = await require('jszip').loadAsync(buffer); }
  catch (e) { if (c.DEBUG) console.log(`   🖼️  Could not read ${label} as a zip: ${e.message}`); return EMPTY; }

  const media = Object.keys(zip.files).filter(n => MEDIA_RE.test(n)).sort();
  if (media.length === 0) return EMPTY;

  const vision = require('../vision');
  let sharp = null; try { sharp = require('../ocr').loadSharp(); } catch { sharp = null; }
  const minEdge = c.visualIngestMinImageEdge || 0;
  const maxImages = c.visualIngestMaxImages || 12;

  const started = Date.now();
  const described = [];
  const figures = [];
  let figIndex = 0;
  let consecutiveFailures = 0;
  for (const name of media) {
    if (described.length >= maxImages) break;
    let imgBuf;
    try { imgBuf = await zip.file(name).async('nodebuffer'); } catch { continue; }
    // Skip decorative/tiny images and anything sharp can't decode (e.g. EMF/WMF vector art).
    if (sharp) {
      try {
        const meta = await sharp(imgBuf).metadata();
        if (Math.min(meta.width || 0, meta.height || 0) < minEdge) continue;
      } catch { continue; }
    }
    try {
      const desc = vision.toIndexText(await vision.describeImage(imgBuf, { model: c.VISION_MODEL }));
      // The model call succeeded (no throw), so reset the failure streak here — before the
      // empty-description skip below — otherwise a successful call that happens to return an
      // empty description would leave the counter armed and trip the break too early.
      consecutiveFailures = 0;
      if (!desc) continue;
      const n = described.length + 1;
      described.push(`[Image ${n}] ${desc}`);
      // In crop mode the embedded image IS the figure — store it as the thumbnail.
      if (crop && sharp) {
        const png = await toThumb(sharp, imgBuf);
        if (png) {
          const id = store.makeId(key, 0, figIndex++);
          if (await store.saveCrop(cacheDir, id, png)) {
            figures.push({ id, page: null, label: `Image ${n}`, type: 'image', description: desc });
          }
        }
      }
    } catch (e) {
      // A hard model failure (no model, OOM, provider down) recurs on every image — stop after
      // a couple in a row rather than describing every remaining image against a dead model; a
      // lone decode/describe hiccup just skips that image.
      if (c.DEBUG) console.log(`   🖼️  Office visual ingest failed on an image in ${label}: ${e.message}`);
      if (++consecutiveFailures >= 2) break;
    }
  }

  const text = described.length ? `Images embedded in this document (described):\n\n${described.join('\n\n')}` : '';
  if (text) {
    cache.set(cacheKey, text, figures, dirOverride);
    require('../logbuffer').progress(`🖼️  Visual ingest: ${label} — described ${described.length} image(s)${figures.length ? `, stored ${figures.length} thumbnail(s)` : ''} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
  return { text, figures };
};

module.exports = { extractPptxText, describeOfficeImages, runsFromSlideXml };
