'use strict';

// ── localembedcore — the bundled local text-embedding model, isolated from everything else ──────────
//
// Pure model logic: load a small multilingual sentence-embedding model once, then embed a batch of texts into
// vectors. No config, no worker plumbing, no I/O beyond the one-time model load — so it runs identically inside
// a worker_thread (its normal home, off the event loop; see lib/retrieval/localembed.js) and would run inline
// unchanged. The caller passes an already-resolved model id, keeping this file free of the config module (which
// pulls in heavy deps and must not load in a worker). Mirrors rerankcore.js so the two can't drift.
//
// Zero setup and fully local: the model (~110 MB quantized) downloads once from the model host and then embeds
// entirely offline, so documents are always searchable with NO external embedding service (no Ollama, no API
// key). The default model is multilingual by construction (100+ languages), and the retrieval path is
// language-agnostic, so this does not narrow Lokyni to one language.

const { makeLoader, MAX_INPUT_CHARS } = require('./modelload');

// The default local model: a small multilingual embedding model with ONNX weights for @huggingface/transformers.
// It is ASYMMETRIC — trained with a one-word instruction prefix on each side — so a document and a query get
// DIFFERENT prefixes. Both prefixes live here, the one place, so index time (embedDocuments → passage) and query
// time (embedQuery → query) can never disagree; a mismatch would quietly wreck recall. Dimension is 384.
const DEFAULT_MODEL_ID = 'Xenova/multilingual-e5-small';
const QUERY_PREFIX   = 'query: ';
const PASSAGE_PREFIX = 'passage: ';
const DIMENSION = 384;
// The model's input token window. The tokenizer truncates past it, so a chunk longer than this is embedded from
// its HEAD only (the full text is still stored and served as the parent passage — this affects the dense VECTOR,
// not the answer text). At the default chunk target (~1500 chars) a Latin-script chunk is ~375 tokens — well
// within this — so the common case is unaffected; only very dense scripts (≈1 token/char) or oversized chunks can
// reach it. Exposed as the single source so chunking / a future large-window model can reason about it.
const MAX_INPUT_TOKENS = 512;

let _extractor = null;

// Load the feature-extraction pipeline once, through the shared offline-first loader (concurrent-load dedup,
// post-failure cooldown, cache probe, remote-retry — all single-sourced). Prefer 8-bit quantized weights
// (smaller/faster); fall back to full precision when the repo ships no quantized ONNX. onProgress is the
// download progress callback, threaded through by the loader.
const init = makeLoader({
  isLoaded: () => !!_extractor,
  reset:    () => { _extractor = null; },
  load: async (transformers, modelId, onProgress) => {
    const { pipeline } = transformers;
    const build = (dtype) => pipeline('feature-extraction', modelId, { device: 'cpu', dtype, progress_callback: onProgress });
    try { _extractor = await build('q8'); return; }
    catch (_) { _extractor = await build('fp32'); }   // no quantized ONNX in the repo → full precision
  },
});

// Embed texts → an array of plain-number vectors (mean-pooled + L2-normalized by the pipeline), aligned to the
// input order. `isQuery` picks the asymmetric prefix. Each text is capped before tokenizing so a pathological
// input can't blow memory (the tokenizer would truncate to the model's window anyway). Throws if the model
// isn't loaded or the output shape is unexpected, so the caller defers rather than trusting a bad result.
const embed = async ({ texts, isQuery = false, modelId = DEFAULT_MODEL_ID, cacheDir, onProgress }) => {
  await init({ modelId, cacheDir, onProgress });
  if (!_extractor) throw new Error('local embedding model not initialized');
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const prefix = isQuery ? QUERY_PREFIX : PASSAGE_PREFIX;
  const inputs = texts.map((t) => prefix + String(t == null ? '' : t).slice(0, MAX_INPUT_CHARS));
  const output = await _extractor(inputs, { pooling: 'mean', normalize: true });
  const dims = output && output.dims;
  const data = output && output.data;
  if (!data || !dims || dims[0] !== texts.length) throw new Error(`unexpected embedding output shape (${dims})`);
  const rows = dims[0], dim = dims[1];
  const out = new Array(rows);
  for (let i = 0; i < rows; i++) out[i] = Array.from(data.subarray(i * dim, (i + 1) * dim));
  return out;
};

module.exports = { init, embed, DEFAULT_MODEL_ID, QUERY_PREFIX, PASSAGE_PREFIX, DIMENSION, MAX_INPUT_TOKENS };
