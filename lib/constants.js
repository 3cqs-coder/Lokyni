'use strict';
// ----------------------------
// Shared Constants
// ----------------------------
// Values needed by more than one module, defined exactly once. This module has no
// dependencies on purpose: lib/service.js reads some of these for the CLI commands
// (--status, --open) and must stay loadable without pulling in config.js, which
// requires the LLM clients and other heavy native modules.
//
// Anything defined here is a fixed default, not user configuration — config.json
// still overrides these at runtime through lib/config.js.

// Default port for the web UI. Deliberately off the beaten path: 3000/8000/8080
// collide with nearly every dev server, which matters more now that Lokyni can run
// as a background service. 7887 is unassigned by IANA and doesn't clash with
// common local services (note: Docker Swarm uses 7946, not 7887).
const DEFAULT_PORT = 7887;

// Application name, used in logs, the page title, and service descriptions.
const APP_NAME = 'Lokyni';

// Identifiers for OS service registration (lib/service.js).
const APP_ID          = 'lokyni';                 // slug: systemd unit, dirs
const MAC_SERVICE_ID  = 'com.lokyni.server';      // macOS LaunchAgent label
const WIN_TASK_NAME   = 'LokyniServer';           // Windows scheduled task

// File types Lokyni can extract text from. Defined once: this list is used by
// discovery (which files to index), the upload route (what to accept), and the
// user-facing messages. Keeping separate copies meant adding a format required
// remembering every site, and a missed one silently rejected valid files.
const SUPPORTED_EXTENSIONS = ['.txt', '.md', '.log', '.pdf', '.docx', '.pptx', '.epub', '.html', '.htm', '.csv', '.tsv', '.json', '.xlsx', '.xlsm'];
// Image types are only indexable when OCR is enabled — without it each would extract
// to nothing and clutter the corpus with empty documents.
const OCR_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff'];
// Audio and video types are only indexable when audio/video ingestion is enabled — each is transcribed to text
// by the local speech-to-text engine (a spoken lecture, meeting, or podcast becomes a searchable, cited
// document), so without the feature on they would index to nothing. Compressed/container formats need ffmpeg to
// decode; .wav is handled natively, so it works even without ffmpeg (see lib/indexing/audioingest.js).
const MEDIA_EXTENSIONS = [
  '.mp3', '.m4a', '.wav', '.flac', '.ogg', '.oga', '.opus', '.aac', '.wma', '.aiff', '.aif',   // audio
  '.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.wmv', '.flv', '.3gp',                      // video
];
// Document formats whose TEXT this build does not extract yet, but which are real documents a user expects to be
// in the corpus. They are discovered and indexed BY NAME (so they are findable, openable, and summarizable, and
// recorded as name-only in the run summary) instead of being silently ignored — the "never drop a document" rule
// applied at discovery. They are NOT a catch-all for arbitrary files: only genuine document types belong here, so
// binaries and app bundles stay excluded and the index is not flooded with non-documents. When text extraction
// for one of these is added later, move its extension into SUPPORTED_EXTENSIONS.
const NAME_ONLY_EXTENSIONS = ['.rtf', '.odt', '.ods', '.odp', '.pages', '.numbers', '.key'];

// For messages: the human-facing format list. .htm is folded into .html, and the
// spreadsheet variants (.tsv, .xlsm) into their common sibling, so the label reads
// as distinct formats rather than every extension we happen to accept.
const SUPPORTED_EXT_LABEL = SUPPORTED_EXTENSIONS
  .filter(e => !['.htm', '.tsv', '.xlsm'].includes(e))
  .join(' ');

// The human-facing upload hint, including the optional image and media groups only when the current
// settings can actually process them. One function feeds the template so a new format or toggle cannot
// leave the drop-zone hint stale.
const uploadFormatsLabel = ({ ocr = false, vision = false, audio = false } = {}) => {
  const parts = SUPPORTED_EXT_LABEL.split(' ').filter(Boolean);
  if (ocr || vision) parts.push('images');
  if (audio) parts.push('audio/video');
  return parts.join(' · ');
};

// V8 old-space cap (MB) for the isolated parse workers — both the worker_thread that runs XLSX/JSON
// (parseworker.js) and the forked child that runs PDF/office/OCR (extractprocess.js). Single-sourced so the
// two isolation mechanisms stay bounded by the same ceiling.
const PARSE_WORKER_HEAP_MB = 768;

// The value for a file input's `accept` attribute, covering every type the extractor handles
// (documents plus the image formats OCR/vision read). Sourced here so the upload picker, the
// one-off attach picker, and the server's upload filter can never drift apart when a format is
// added — the reason the extension list is defined exactly once.
const SUPPORTED_ACCEPT_ATTR = [...SUPPORTED_EXTENSIONS, ...OCR_EXTENSIONS, ...MEDIA_EXTENSIONS].join(',');

// The extensions accepted for an UPLOAD or a desktop drag-drop, given the live feature settings: the base
// supported set, plus images only when OCR or vision-describe can read them, plus audio/video only when media
// ingestion is on (without the enabling feature those would index as empty). ONE source so the HTTP upload route
// and the desktop drop can't drift on what they accept. Takes the config object so this file stays config-free.
// Returns a Set of lowercase extensions including the leading dot. (Folder indexing uses its own filter in
// lib/indexing/files.js, which also accepts the name-only types; this gate is deliberately upload/drop only.)
const uploadAllowedExtensions = (cfg) => {
  const set = new Set(SUPPORTED_EXTENSIONS);
  if (cfg && (cfg.USE_OCR || cfg.VISION_DESCRIBE)) for (const e of OCR_EXTENSIONS) set.add(e);
  if (cfg && cfg.useAudioIngest) for (const e of MEDIA_EXTENSIONS) set.add(e);
  return set;
};

// Bump when the on-disk index MAP shapes (parent-map / child-map / passage-map .json) or the
// chunking scheme change in a way that makes an older cache incompatible. It is stamped into
// the manifest by the indexer and checked at startup, which forces a clean rebuild on a
// mismatch — the same self-heal the embedding-model change already triggers. A manifest with
// no version (an install predating this) is treated as compatible, so upgrading never forces a
// needless rebuild; only a future bump does.
// v2: the tokenizer became Unicode-aware (accented Latin kept whole, non-Latin words indexed, CJK as
// bigrams), so BM25 postings and IDF built by v1's ASCII-only tokenizer must be rebuilt to match.
const INDEX_FORMAT_VERSION = 2;

// The on-disk names of the per-workspace index artifacts, defined once so a writer and its readers and
// cleanup paths (which live in different modules — delta.js writes, bundle.js loads, init.js wipes) can never
// disagree on a filename. Renaming one literal in one module used to risk breaking index load or stranding an
// orphan file; now every path builds from these. `faissIndex` and `docstore` are the pair FaissStore.save
// writes into a directory (the single root index, or a bank under banks/<fp>/). The write-ahead commit
// marker keeps its own name in commitmarker.FILE. Frozen so no module can mutate the shared record.
const CACHE_FILES = Object.freeze({
  manifest:   'file-manifest.json',
  parentMap:  'parent-map.json',
  childMap:   'child-map.json',
  passageMap: 'passage-map.json',
  faissIndex: 'faiss.index',
  docstore:   'docstore.json',
});

// Bump when a change to the ANSWER pipeline — the grounding rules, the always-on safeguards, a caveat, or a
// retrieval behavior that is NOT already captured by a setting — makes a previously computed answer no longer
// representative. It is folded into the semantic answer cache key (so an upgrade can never replay an answer
// produced by an older pipeline) and recorded on each evaluation run (so a trend that crosses a pipeline
// change is visible). Unlike INDEX_FORMAT_VERSION this never forces a re-index; it only retires cached answers.
const ANSWER_PIPELINE_VERSION = 1;

// Zero-width and bidi control characters used in "Trojan-Source" style attacks (CVE-2021-42574), where
// reordering controls make displayed text differ from the underlying bytes. Covers the embeddings/overrides
// (U+202A–202E), the LRM/RLM marks, the zero-width/word-joiner range (U+2060–2064), the BOM, and the bidi
// ISOLATE controls (U+2066–2069: LRI/RLI/FSI/PDI). Deliberately leaves ZWJ/ZWNJ (U+200C/200D) alone, which
// are required for emoji sequences and Persian/Arabic/Indic text. Single-sourced here (a leaf module with no
// requires) and used by BOTH the answer-egress sanitizer (verify.js) and the citation-snippet builder
// (snippet.js), so the two can never drift out of sync. Exposed as a function, not a shared /g regex, so
// there is no cross-module lastIndex hazard. Never throws.
const stripInvisibleChars = (s) => String(s == null ? '' : s).replace(/[​‎‏‪-‮⁠-⁤⁦-⁩﻿]/g, '');

// User-facing "no answer in the corpus" messages, single-sourced so every answering surface (the chat
// socket, the HTTP API, scheduled automations) reads identically and can't drift word-by-word. Two distinct
// states, deliberately worded differently:
//   • OUT_OF_SCOPE_MESSAGE — the question is off-topic for the corpus (the relevance gate declined before or
//     after retrieval): nothing in scope to answer from.
//   • NO_RELEVANT_INFO_MESSAGE — retrieval ran but produced no usable passage (empty served set).
// The interactive web-offer prompt in the chat UI is intentionally separate (second person, ends in a
// question), so it is not folded in here.
const OUT_OF_SCOPE_MESSAGE = 'That falls outside what I can help with. I can only answer questions based on the documents in my knowledge base.';
const NO_RELEVANT_INFO_MESSAGE = 'No relevant information found in the documents.';

// A sane upper bound on a free-text model input — a chat question, a search query, a synthesis focus. The
// whole request body is already capped, but a single multi-megabyte question is never legitimate and needlessly
// loads prompt assembly and retrieval, so each answering surface rejects a longer one with a clear message
// rather than doing the work. Single-sourced so the chat socket and the HTTP API enforce the same limit (large
// pasted context belongs in an attachment, which has its own, larger cap). ~8000 chars is roughly 1500 words.
const MAX_QUERY_CHARS = 8000;

// The default per-file upload/indexing size cap (500 MB), used when the config provides no maxFileBytes. Single
// source: config.js resolves MAX_FILE_SIZE from this, and the upload route's own safety fallback reads it too,
// so the enforced cap and the "File too large (max N MB)" message can never disagree on the default.
const DEFAULT_MAX_FILE_BYTES = 500 * 1024 * 1024;

module.exports = {
  DEFAULT_PORT,
  DEFAULT_MAX_FILE_BYTES,
  APP_NAME,
  APP_ID,
  MAC_SERVICE_ID,
  WIN_TASK_NAME,
  SUPPORTED_EXTENSIONS,
  uploadAllowedExtensions,
  OCR_EXTENSIONS,
  MEDIA_EXTENSIONS,
  NAME_ONLY_EXTENSIONS,
  PARSE_WORKER_HEAP_MB,
  SUPPORTED_EXT_LABEL,
  uploadFormatsLabel,
  SUPPORTED_ACCEPT_ATTR,
  INDEX_FORMAT_VERSION,
  CACHE_FILES,
  ANSWER_PIPELINE_VERSION,
  stripInvisibleChars,
  OUT_OF_SCOPE_MESSAGE,
  NO_RELEVANT_INFO_MESSAGE,
  MAX_QUERY_CHARS,
};
