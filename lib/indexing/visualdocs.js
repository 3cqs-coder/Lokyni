'use strict';
// Visual ingest — figure / table QA for PDFs.
//
// Lokyni's text and OCR paths capture the WORDS on a page, but a chart's takeaway, a
// diagram's meaning, and a table's structure are lost when they exist only as pixels. This
// pass renders each PDF page and asks the vision model to describe its figures, charts, and
// diagrams and to reproduce its tables as Markdown, then appends those descriptions to the
// document's indexed text — so "what does the revenue chart on page 3 show?" or "summarize
// the results table" become answerable through the normal grounded, cited retrieval flow.
//
// With figure cropping on (config.visualIngestCropFigures), it goes further: the model also
// returns a bounding box per figure/table, each is cropped from the rendered page with sharp
// and saved as a thumbnail (see figurestore.js), and the returned manifest lets the UI show
// the actual figure on the cited source.
//
// Reuses the OCR page renderer (lib/ocr.iterPdfPages, streamed one slice at a time) and the vision backend
// (lib/vision) — no new dependency and no second rasterizer or client. Deliberately safe and
// bounded (off by default, size- and page-capped, sequential vision calls, best-effort and
// cached by content hash) so it can never break indexing or exhaust the server's memory.

const path = require('path');
const cfg = () => require('../config');

// Turn per-page descriptions into one labeled, indexable block. Each page is labeled so a
// citation and a follow-up ("the table on page 4") can reference it.
const BLOCK_HEADER = 'Figures, charts, and tables (described from the page images):';
const buildBlock = (pages) => {
  const parts = (pages || []).filter(p => p && p.text).map(p => `[Page ${p.page}] ${p.text}`);
  return parts.length ? `${BLOCK_HEADER}\n\n${parts.join('\n\n')}` : '';
};

// Crop a normalized bbox [x,y,w,h] (fractions of the page) out of a rendered page image.
// Adds a small padding, clamps to the image bounds, and returns a PNG buffer, or null if the
// region is unusable. Reuses the single libvips build via lib/ocr.loadSharp.
const cropRegion = async (pageBuf, bbox) => {
  let sharp = null; try { sharp = require('../ocr').loadSharp(); } catch { sharp = null; }
  if (!sharp) return null;
  try {
    const img = sharp(pageBuf);
    const meta = await img.metadata();
    const W = meta.width || 0, H = meta.height || 0;
    if (!W || !H) return null;
    const pad = 0.01;
    let [x, y, w, h] = bbox;
    x = Math.max(0, x - pad); y = Math.max(0, y - pad);
    w = Math.min(1 - x, w + pad * 2); h = Math.min(1 - y, h + pad * 2);
    const left = Math.min(W - 1, Math.max(0, Math.round(x * W)));
    const top  = Math.min(H - 1, Math.max(0, Math.round(y * H)));
    // Clamp the extent to the image bounds rather than rejecting — a full-width figure/table
    // whose box touches the page edge would otherwise round to W+1 and be dropped.
    const width  = Math.max(1, Math.min(W - left, Math.round(w * W)));
    const height = Math.max(1, Math.min(H - top, Math.round(h * H)));
    if (width < 24 || height < 24) return null;   // too small to be a useful thumbnail
    // Cap the stored thumbnail's size so a crop of a high-DPI page doesn't bloat disk.
    return await img.extract({ left, top, width, height })
      .resize({ width: 900, height: 900, fit: 'inside', withoutEnlargement: true })
      .png().toBuffer();
  } catch { return null; }
};

// Describe (and optionally crop) the figures/charts/tables in a PDF buffer. Returns
// { text, figures }: `text` is the indexable block, `figures` is the crop manifest
// ([{ id, page, label, type, description }]) — empty when cropping is off or nothing was
// found. Never throws.
// `dirOverride` (optional): the workspace cache directory the descriptions and figure crops belong
// in. Omitted for the active workspace (follows the live CACHE_DIR); set when warming a NON-active
// workspace so its crops land beside the manifest that references them, not in the active directory.
const describePdfVisuals = async (buffer, fileName = '', dirOverride = null) => {
  const c = cfg();
  const label = path.basename(fileName || 'document');
  const EMPTY = { text: '', figures: [] };
  if (!c.useVisualIngest) return EMPTY;
  if (!c.VISION_MODEL || !String(c.VISION_MODEL).trim()) return EMPTY;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return EMPTY;
  if (buffer.length > (c.visualIngestMaxBytes || Infinity)) {
    if (c.DEBUG) console.log(`   🖼️  Visual ingest skipped for ${label} — larger than the size cap`);
    return EMPTY;
  }

  const crop = c.visualIngestCropFigures === true;
  const cache = require('../visualcache');
  const store = require('./figurestore');
  const cacheDir = dirOverride || c.CACHE_DIR;
  // `key` (pure hex) names the figure crops; `cacheKey` namespaces the description cache by
  // crop mode, so toggling visualIngestCropFigures uses a distinct entry and a changed doc (or
  // a re-index) re-runs with crops — rather than serving a crop-less manifest cached earlier.
  // Fold the vision model into the key so switching visionModel re-describes an unchanged page's figures
  // rather than reusing the previous model's descriptions.
  const key = cache.keyFor(buffer, c.VISION_MODEL || '');
  const cacheKey = crop ? `${key}:c` : key;

  // Cache hit: reuse the description, and (in crop mode) keep only figures whose crop file is
  // still on disk — a wiped figures dir loses the thumbnail but the description stays in text.
  const cached = cache.getRecord(cacheKey, dirOverride);
  if (cached) {
    if (c.DEBUG) console.log(`   ↩️  Visual-ingest cache hit: ${label}`);
    const figures = crop ? cached.figures.filter(f => f && f.id && store.hasCrop(cacheDir, f.id)) : [];
    return { text: cached.text, figures };
  }

  const vision = require('../vision');
  const started = Date.now();
  const pages = [];       // { page, text } for buildBlock
  const figures = [];     // crop manifest
  let figIndex = 0;
  let consecutiveFailures = 0;
  let rendered = 0;

  // Stream pages one slice at a time: the renderer never holds the whole document's bitmaps at once, so a
  // long or high-resolution scan can't OOM the process. Vision calls are sequential anyway, so a page is
  // described and (in crop mode) cropped before the next is rendered.
  try {
    for await (const { pageNum, image } of require('../ocr').iterPdfPages(buffer, { maxPages: c.visualIngestMaxPages })) {
      rendered++;
      try {
        // The searchable TEXT always comes from the page-visuals pass, which reliably reproduces
        // tables with every value and reads chart trends. (The bbox pass below tends to
        // summarize a table rather than list its numbers, so it is used ONLY for locating crops,
        // never for the indexed text.)
        const text = await vision.describePageVisuals(image, { model: c.VISION_MODEL });
        if (text) pages.push({ page: pageNum, text });
        // The indexed-TEXT pass succeeded — this document is healthy. Reset the streak HERE (before the figures
        // pass) so a flaky figures/crop pass can never be mistaken for "the text pass is dead" and abandon the
        // remaining pages' text; the figures pass is a best-effort UI enhancement, guarded on its own below.
        consecutiveFailures = 0;

        // Crop path: a second pass returns a bounding box per figure/table, which we crop into a
        // thumbnail. Its short caption is kept only as the crop's label/description for the UI.
        if (crop) {
          try {
            const found = await vision.describePageFigures(image, { model: c.VISION_MODEL });
            for (const f of found) {
              if (!f.bbox) continue;
              const png = await cropRegion(image, f.bbox);
              if (!png) continue;
              const id = store.makeId(key, pageNum, figIndex++);
              if (await store.saveCrop(cacheDir, id, png)) {
                figures.push({ id, page: pageNum, label: f.label || '', type: f.type || 'figure', description: f.description });
              }
            }
          } catch (e) {
            // A figures-pass blip must NOT abandon the rest of the document's text (which already succeeded above).
            if (c.DEBUG) console.log(`   🖼️  Figure pass failed on page ${pageNum} of ${label}: ${e.message}`);
          }
        }
      } catch (e) {
        // The indexed-TEXT pass failed. One bad page must not lose the rest, but a hard model failure (no model,
        // OOM, provider down) recurs on every page — so stop after a couple of TEXT failures in a row rather than
        // issuing a failing vision call for every remaining page and logging the same error dozens of times.
        if (c.DEBUG) console.log(`   🖼️  Visual ingest failed on page ${pageNum} of ${label}: ${e.message}`);
        if (++consecutiveFailures >= 2) break;
      }
    }
  } catch (e) {
    if (c.DEBUG) console.log(`   🖼️  Visual ingest could not render ${label}: ${e.message}`);
    if (rendered === 0) return EMPTY;   // nothing rendered at all — treat as a skip
  }
  if (rendered === 0) return EMPTY;

  const text = buildBlock(pages);
  if (text) {
    cache.set(cacheKey, text, figures, dirOverride);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    require('../logbuffer').progress(`🖼️  Visual ingest: ${label} — described ${pages.length} page(s)${figures.length ? `, cropped ${figures.length} figure(s)` : ''} in ${secs}s`);
  }
  return { text, figures };
};

module.exports = { describePdfVisuals, buildBlock, cropRegion };
