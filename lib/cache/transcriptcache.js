'use strict';
// Cache of media-file transcripts, keyed by file content hash AND the transcription language, built on the same
// versioned JSON-cache machinery as the OCR and summary caches (so load/flush/clear/eviction are shared rather
// than re-derived).
//
// Transcribing a recording is the expensive part of ingesting it (minutes of model inference for a long file),
// so the content-hash key means an unchanged media file is transcribed once and reused across restarts and
// warm-start rebuilds. Folding the language into the key re-transcribes automatically when the user changes the
// spoken language (which would otherwise leave a stale transcript on an unchanged file). Stored per workspace
// alongside the index: derived data, wiped on a rebuild and carried in a backup.
//
// Bump when the transcription pipeline changes output for the same input (the model, the segmenting, the
// post-processing). History:
//   1 — Whisper transcript, segments joined with a single space
const TRANSCRIPT_PIPELINE_VERSION = 1;

const MAX_BYTES = 32 * 1024 * 1024;   // transcripts are text; a generous cap holds many hours of speech

const _fam = require('./jsoncache').createVersionedJsonCacheFamily({
  file: 'transcript-cache.json', prefix: 'txv', version: TRANSCRIPT_PIPELINE_VERSION, maxBytes: MAX_BYTES,
});

// `lang` is folded into the key so a file transcribed in one language is re-transcribed (not reused) after the
// user switches the spoken language.
const keyFor = (fileHash, lang = '') => _fam.keyFor(String(fileHash || ''), String(lang || ''));

const get = (hash, dir) => {
  const c = _fam.inst(dir).load();
  const hit = c[hash];
  // Empty string is a MISS (a transient failure or a genuinely silent file), so it re-transcribes next run
  // rather than freezing a file as transcript-less.
  return hit && typeof hit.text === 'string' && hit.text.length > 0 ? hit.text : null;
};

const set = (hash, text, dir) => {
  if (!hash || typeof text !== 'string' || text.length === 0) return;
  const inst = _fam.inst(dir);
  const c = inst.load();
  c[hash] = { text, at: Date.now() };
  inst.markDirty();
  // Batch and flush once at run-end (active) or warm-end (scoped) rather than rewriting the whole cache per file.
};

const flush = (dir) => _fam.inst(dir).flush();
const clear = () => _fam.inst().clear();

module.exports = { get, set, flush, clear, keyFor, TRANSCRIPT_PIPELINE_VERSION };
