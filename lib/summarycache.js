'use strict';
// Cache of per-document summaries (the first level of the collapsed-tree hierarchical index),
// keyed by document content AND the summary pipeline version. Built on the same versioned
// JSON-cache machinery as the OCR and visual caches, so load/flush/clear/eviction are shared
// rather than re-derived.
//
// Generating a summary is a model call per document — the expensive part of enabling the
// feature — so the content-hash key means an unchanged document is summarized once and reused
// across restarts and warm-start rebuilds, and a changed document (or a pipeline-version bump)
// re-summarizes automatically. Stored per workspace alongside the index: derived data, wiped
// on a rebuild and carried in a backup.
//
// Bump this when the summary pipeline changes output for the same input (the prompt, the block
// format, the input cap). History:
//   1 — per-document summary appended as a labeled block
const SUMMARY_PIPELINE_VERSION = 1;

const MAX_BYTES = 16 * 1024 * 1024;   // summaries are short; a modest cap is plenty

// A family, so a background warm of a NON-active workspace can pass that workspace's cache
// directory (`dir`) and summarize into it rather than the active workspace's directory. A scoped
// write (with `dir`) is written through immediately; an active write (no `dir`) batches to run-end.
const _fam = require('./jsoncache').createVersionedJsonCacheFamily({
  file: 'summary-cache.json', prefix: 'sumv', version: SUMMARY_PIPELINE_VERSION, maxBytes: MAX_BYTES,
});

// `model` is folded into the key so a document summarized with one model is re-summarized (not reused) after
// the user switches `documentSummaryModel` — otherwise an incremental re-index would keep the old model's
// summaries on unchanged documents and leave the corpus summarized by a mix of models.
const keyFor = (input, model = '') => _fam.keyFor(input, String(model || ''));

const get = (hash, dir) => {
  const c = _fam.inst(dir).load();
  const hit = c[hash];
  // Empty string is a MISS (a transient failure or a genuinely empty doc), so it re-summarizes
  // next run rather than freezing a document as summary-less.
  return hit && typeof hit.text === 'string' && hit.text.length > 0 ? hit.text : null;
};

const set = (hash, text, dir) => {
  if (!hash || typeof text !== 'string' || text.length === 0) return;
  const inst = _fam.inst(dir);
  const c = inst.load();
  c[hash] = { text, at: Date.now() };
  inst.markDirty();
  // Batch and flush once at run-end (active) or warm-end (scoped, via the bundle warm) rather than rewriting
  // the whole cache per document — the per-set scoped flush was O(K²) across a K-document warm.
};

const flush = (dir) => _fam.inst(dir).flush();
const clear = () => _fam.inst().clear();

module.exports = { get, set, flush, clear, keyFor, SUMMARY_PIPELINE_VERSION };
