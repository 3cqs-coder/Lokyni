'use strict';
// Cache of OCR results, keyed by file content AND the OCR pipeline version.
//
// Extracted text isn't part of the FAISS index, so warm-start rebuilds `parentMap`
// by re-reading every document — which re-runs OCR on every scanned PDF at every
// startup. On a corpus of tax returns and legal scans that's minutes of work
// repeated for no reason, since the files haven't changed.
//
// Keyed by SHA-256 of the file bytes rather than by path, so the cache survives a
// rename or a move between workspaces, and is invalidated automatically when the
// file's contents actually change.
//
// The key ALSO folds in OCR_PIPELINE_VERSION: the cached text depends not just on the
// file bytes but on the code that produced it. When the OCR pipeline changes (e.g.
// adding EXIF rotation, deskew, orientation retry, or upscaling), bumping the version
// invalidates every old entry automatically, so a stale pre-change result is never
// served. Without this, an unchanged file keeps its old hash and the new code never
// runs — the exact trap where a sideways scan kept returning its old wrong reading.
//
// Stored per workspace alongside the vector index: it's derived data, it should be
// discarded when the index is wiped, and it should travel with a backup.
// Bump this whenever the OCR pipeline changes in a way that alters output for the
// same input bytes — new preprocessing (rotation, deskew, upscaling), engine/prompt
// changes, etc. Any bump invalidates the whole cache automatically, forcing a re-OCR
// with the current code. History:
//   1 — original tesseract/vision pipeline
//   2 — EXIF auto-rotate, 90/180/270 confidence retry, projection-profile deskew,
//       small-image upscaling (OCR + vision)
const OCR_PIPELINE_VERSION = 2;

// A guard against unbounded growth. OCR text is large — a 40-page scan produced
// 88 KB — so this is a size cap rather than an entry count.
const MAX_BYTES = 64 * 1024 * 1024;

// The shared versioned-JSON-cache machinery (load/keyFor/dirty/flush/clear). This module
// keeps only its own value semantics (empty-string-as-miss; { text, at } entries) on top.
// A family, so a background warm of a NON-active workspace can pass that workspace's cache
// directory (`dir`) and have its OCR cached there rather than in the active workspace's directory.
// An active-workspace write (no `dir`) is batched and flushed once at the end of the run; a scoped
// write (with `dir`) is written through immediately, so the caller needs no separate flush.
const _fam = require('./jsoncache').createVersionedJsonCacheFamily({
  file: 'ocr-cache.json', prefix: 'ocrv', version: OCR_PIPELINE_VERSION, maxBytes: MAX_BYTES,
});

// Compute the cache key for a file buffer, folding in the pipeline version so a code
// change invalidates prior entries. Callers should use this rather than hashing the
// buffer directly, so the versioning can't be forgotten at a call site.
const keyFor = (buffer) => _fam.keyFor(buffer);

const get = (hash, dir) => {
  const c = _fam.inst(dir).load();
  const hit = c[hash];
  // An empty string is treated as a MISS, not a hit. Empty OCR text means the
  // previous run extracted nothing — usually a transient failure (Tesseract not
  // warmed up, worker pool not ready) rather than a genuinely blank document.
  // Caching '' and then returning it as a hit permanently freezes that document as
  // empty content across every restart, so it silently drops out of the index and
  // queries against it fail. Returning null here forces a re-OCR next run, which
  // also self-heals caches already poisoned with empty entries.
  return hit && typeof hit.text === 'string' && hit.text.length > 0 ? hit.text : null;
};

const set = (hash, text, dir) => {
  if (!hash || typeof text !== 'string') return;
  // Never cache an empty result. A failed or empty OCR pass should be retried on
  // the next run, not frozen in place — see the note in get(). Skipping the write
  // keeps the door open for a real extraction later.
  if (text.length === 0) return;
  const inst = _fam.inst(dir);
  const c = inst.load();
  c[hash] = { text, at: Date.now() };
  inst.markDirty();
  // Both the active (dir=null) and scoped (non-active warm) paths batch now and flush ONCE at the end of their
  // run — the active path via delta/init's run-end flush, the scoped path via the bundle warm's end-of-warm
  // flush. Flushing per scoped set rewrote the whole (up to 64 MB) cache synchronously on every document,
  // which is O(K²) blocking of the event loop across a K-document warm.
};

// Write once at the end of an indexing run rather than per document — a 40-page scan
// would otherwise rewrite the whole file on every page. The size cap (MAX_BYTES,
// oldest-first eviction) is applied by the shared cache on flush.
const flush = (dir) => _fam.inst(dir).flush();

// Called when the vector store is wiped, since the cache is derived from the same
// documents and a rebuild implies the extraction may have changed too. Takes `dir`
// like get/set/flush, so a scoped (non-active-workspace) wipe clears the right cache
// rather than always the active one (today's callers pass the active dir — this closes
// the latent mismatch if a scoped wipe is ever added).
const clear = (dir) => _fam.inst(dir).clear();

module.exports = { get, set, flush, clear, keyFor, OCR_PIPELINE_VERSION };
