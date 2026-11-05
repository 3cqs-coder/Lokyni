'use strict';
// Cache of visual-ingest results (figure/table descriptions), keyed by file content AND the
// visual-ingest pipeline version. Separate from the OCR cache (lib/ocrcache.js) so the two
// can be versioned and invalidated independently, but built on the same versioned-JSON-cache
// machinery (lib/jsoncache.js) so the load/flush/clear/eviction behavior is shared, not
// re-derived.
//
// Visual ingest runs one vision-model call per rendered PDF page — by far the most expensive
// step in indexing — so re-running it on every warm-start rebuild would be prohibitive. The
// content-hash key means an unchanged PDF is described once and reused across restarts, and a
// changed file (or a pipeline-version bump) re-runs automatically. Stored per workspace
// alongside the vector index, like the OCR cache: it is derived data, discarded on a wipe and
// carried in a backup.
//
// Bump this whenever the visual-ingest pipeline changes in a way that alters output for the
// same input bytes (the page prompt, the renderer, the page cap semantics). History:
//   1 — page-level figure/chart/table description via the vision model
//   2 — per-figure/table labeling ("Figure 3:", "Table 2:") for precise references; office
//       (DOCX/PPTX) embedded-image description added on the same cache
const VISUAL_PIPELINE_VERSION = 2;

// Descriptions are smaller than OCR text, but a large illustrated corpus still adds up.
const MAX_BYTES = 32 * 1024 * 1024;

// A family, so a background warm of a NON-active workspace can pass that workspace's cache
// directory (`dir`) and have its descriptions cached there, co-located with the figure crops
// (which are keyed into the same directory). A scoped write (with `dir`) is written through
// immediately; an active write (no `dir`) is batched and flushed once at run-end.
const _fam = require('./jsoncache').createVersionedJsonCacheFamily({
  file: 'visual-cache.json', prefix: 'visv', version: VISUAL_PIPELINE_VERSION, maxBytes: MAX_BYTES,
});

// Fold the pipeline version into the key so a code change invalidates prior entries — use
// this rather than hashing the buffer directly, so the versioning can't be forgotten. `model` is folded in
// too, so a figure described by one vision model is re-described (not reused) after the user switches
// `visionModel` — otherwise an incremental re-index would keep the old model's descriptions on unchanged
// images and leave the corpus described by a mix of models.
const keyFor = (buffer, model = '') => _fam.keyFor(buffer, String(model || ''));

const get = (hash, dir) => {
  const c = _fam.inst(dir).load();
  const hit = c[hash];
  // Empty string is a MISS, not a hit: an empty result means the previous run produced no
  // description (a transient vision failure, or a genuinely figure-free PDF). Returning null
  // forces a retry next run and self-heals any cache already holding empty entries.
  return hit && typeof hit.text === 'string' && hit.text.length > 0 ? hit.text : null;
};

// Full record including the cropped-figure manifest ({ text, figures }). Returns null on a
// miss (same empty-string-as-miss rule as get). `figures` is always an array.
const getRecord = (hash, dir) => {
  const c = _fam.inst(dir).load();
  const hit = c[hash];
  if (!hit || typeof hit.text !== 'string' || hit.text.length === 0) return null;
  return { text: hit.text, figures: Array.isArray(hit.figures) ? hit.figures : [] };
};

const set = (hash, text, figures, dir) => {
  if (!hash || typeof text !== 'string') return;
  if (text.length === 0) return;   // never freeze an empty/failed pass — retry next run
  const inst = _fam.inst(dir);
  const c = inst.load();
  c[hash] = { text, figures: Array.isArray(figures) ? figures : [], at: Date.now() };
  inst.markDirty();
  // Batch and flush once at run-end (active) or warm-end (scoped, via the bundle warm) rather than rewriting
  // the whole cache per document — the per-set scoped flush was O(K²) across a K-document warm.
};

// Written once at the end of an indexing run rather than per document.
const flush = (dir) => _fam.inst(dir).flush();
// Cleared when the vector store is wiped — the cache is derived from the same documents.
const clear = () => _fam.inst().clear();

module.exports = { get, getRecord, set, flush, clear, keyFor, VISUAL_PIPELINE_VERSION };
