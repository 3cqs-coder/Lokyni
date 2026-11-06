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

// The default local model: bge-m3, a strong MULTILINGUAL embedding model (100+ languages) with ONNX weights for
// @huggingface/transformers. It is chosen as the default because a retrieval eval showed it preserves BOTH
// cross-lingual recall AND the out-of-corpus DECLINE behavior that is Lokyni's honesty wedge — a lighter model
// with a narrower score cone (e.g. multilingual-e5-small) passes recall but fails to decline off-corpus questions,
// because the relevance gate can't separate a true cross-lingual match from a distractor. bge-m3 is ~570 MB and
// slower on CPU than a MiniLM-class model; a user who wants lighter/faster can select another model in Settings.
// Model-specific conventions (one place, so index time and query time can't disagree): bge-m3 pools the [CLS]
// token and takes the raw text (symmetric); E5-family models mean-pool and need an asymmetric query/passage
// prefix. `embed()` keys both off the model id. Dimension is 1024 for bge-m3 (384 for e5-small).
const DEFAULT_MODEL_ID = 'Xenova/bge-m3';
const QUERY_PREFIX   = 'query: ';     // E5-family only (see embed())
const PASSAGE_PREFIX = 'passage: ';   // E5-family only
const DIMENSION = 1024;               // bge-m3; e5-small is 384 (FAISS infers it from the vectors, so this is documentation + a guard)
// The default model's input token window (bge-m3: 8192). Comfortably past the default chunk target (~1500 chars),
// so no chunk is ever truncated at embed time in any language. A smaller-window model (e5: 512) truncates a chunk
// longer than its window from the HEAD, but the common Latin-script chunk (~375 tokens) stays within even that.
const MAX_INPUT_TOKENS = 8192;

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
  // The asymmetric query/passage prefix is an E5-family convention; other models (e.g. gte) are symmetric and
  // must get the raw text. Key off the model id so a different local model isn't fed a prefix it never trained on.
  const prefix = /e5/i.test(String(modelId)) ? (isQuery ? QUERY_PREFIX : PASSAGE_PREFIX) : '';
  const inputs = texts.map((t) => prefix + String(t == null ? '' : t).slice(0, MAX_INPUT_CHARS));
  // Pooling is model-specific: BGE models pool the [CLS] token, most others (E5, MiniLM, GTE) mean-pool. Using the
  // wrong one yields vectors on a different scale, which quietly miscalibrates the relevance gate. Key off the id.
  const pooling = /bge/i.test(String(modelId)) ? 'cls' : 'mean';
  const output = await _extractor(inputs, { pooling, normalize: true });
  const dims = output && output.dims;
  const data = output && output.data;
  if (!data || !dims || dims[0] !== texts.length) throw new Error(`unexpected embedding output shape (${dims})`);
  const rows = dims[0], dim = dims[1];
  const out = new Array(rows);
  for (let i = 0; i < rows; i++) out[i] = Array.from(data.subarray(i * dim, (i + 1) * dim));
  return out;
};

module.exports = { init, embed, DEFAULT_MODEL_ID, QUERY_PREFIX, PASSAGE_PREFIX, DIMENSION, MAX_INPUT_TOKENS };
