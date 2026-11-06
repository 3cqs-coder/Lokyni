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

const { makeLoader, MAX_INPUT_CHARS, frugalSessionOptions } = require('./modelload');

// The default local model: paraphrase-multilingual-MiniLM-L12-v2, a SMALL multilingual embedding model (~118 M
// params, ~120 MB) with ONNX weights for @huggingface/transformers. It is the default because it must run on ANY
// hardware with zero setup — a heavier model (bge-m3, ~570 MB / 568 M params) is more accurate but too slow and
// memory-hungry on a constrained machine, so the index never finishes there. A retrieval eval drove this choice:
// MiniLM preserves the out-of-corpus DECLINE behavior that is Lokyni's honesty wedge (7/7 in the eval) and is
// perfect same-language; a same-size model with a narrower score cone (multilingual-e5-small) fails to decline
// off-corpus questions, and bge-m3 is more accurate cross-lingually but impractical to run everywhere. Users who
// want maximum cross-lingual accuracy select `Xenova/bge-m3` (or Ollama/OpenAI) in Settings.
// Model-specific conventions (one place, so index time and query time can't disagree), keyed off the model id in
// embed(): BGE pools the [CLS] token; E5-family models mean-pool and need an asymmetric query/passage prefix;
// everything else (MiniLM, mpnet, …) mean-pools with no prefix.
const DEFAULT_MODEL_ID = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const QUERY_PREFIX   = 'query: ';     // E5-family only (see embed())
const PASSAGE_PREFIX = 'passage: ';   // E5-family only
const DIMENSION = 384;                // MiniLM & e5-small are 384, bge-m3 is 1024 (FAISS infers it from the vectors; documentation + a guard)
// The default model's input token window (MiniLM: 128). A chunk longer than this is embedded from its HEAD only
// (the full text is still stored and served as the parent passage — this affects the dense VECTOR, not the answer
// text), and the reranker + parent-passage serving recover most of it. A larger-window model (bge-m3: 8192, e5:
// 512) avoids this and is one Settings change away.
const MAX_INPUT_TOKENS = 128;

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
    const build = (dtype) => pipeline('feature-extraction', modelId, { device: 'cpu', dtype, progress_callback: onProgress, ...frugalSessionOptions() });
    try { _extractor = await build('q8'); return; }
    catch (_) { _extractor = await build('fp32'); }   // no quantized ONNX in the repo → full precision
  },
});

// Embed texts → an array of plain-number vectors (pooled + L2-normalized by the pipeline), aligned to the input
// order. `isQuery` picks the asymmetric prefix. Each text is capped before tokenizing so a pathological input
// can't blow memory. Throws if the model isn't loaded or the output shape is unexpected, so the caller defers
// rather than trusting a bad result.
//
// CRITICAL (OOM-proof): the forward pass is run on at most SUB_BATCH texts at a time. A model forward pass over N
// sequences of length L allocates intermediate tensors proportional to N·L (and, for attention, can be far
// larger), so running a whole caller batch (BATCH_SIZE, 64) of long chunks at once needs GIGABYTES on a heavy
// model — which OOMs a modest machine (observed: a 64×621 batch asked onnxruntime for a single 1.58 GB buffer and
// failed on an 8 GB VM). Sub-batching bounds peak memory to SUB_BATCH·L regardless of the model, the machine, or
// the caller's batch size, so indexing never fails for lack of RAM; it is numerically identical to one big batch.
const SUB_BATCH = 8;

const embed = async ({ texts, isQuery = false, modelId = DEFAULT_MODEL_ID, cacheDir, onProgress }) => {
  await init({ modelId, cacheDir, onProgress });
  if (!_extractor) throw new Error('local embedding model not initialized');
  if (!Array.isArray(texts) || texts.length === 0) return [];
  // The asymmetric query/passage prefix is an E5-family convention; other models (e.g. gte) are symmetric and
  // must get the raw text. Key off the model id so a different local model isn't fed a prefix it never trained on.
  const prefix = /e5/i.test(String(modelId)) ? (isQuery ? QUERY_PREFIX : PASSAGE_PREFIX) : '';
  // Pooling is model-specific: BGE models pool the [CLS] token, most others (E5, MiniLM, GTE) mean-pool. Using the
  // wrong one yields vectors on a different scale, which quietly miscalibrates the relevance gate. Key off the id.
  const pooling = /bge/i.test(String(modelId)) ? 'cls' : 'mean';
  const out = new Array(texts.length);
  for (let start = 0; start < texts.length; start += SUB_BATCH) {
    const slice = texts.slice(start, start + SUB_BATCH).map((t) => prefix + String(t == null ? '' : t).slice(0, MAX_INPUT_CHARS));
    const output = await _extractor(slice, { pooling, normalize: true });
    const dims = output && output.dims;
    const data = output && output.data;
    if (!data || !dims || dims[0] !== slice.length) throw new Error(`unexpected embedding output shape (${dims})`);
    const dim = dims[1];
    for (let r = 0; r < slice.length; r++) out[start + r] = Array.from(data.subarray(r * dim, (r + 1) * dim));
  }
  return out;
};

module.exports = { init, embed, DEFAULT_MODEL_ID, QUERY_PREFIX, PASSAGE_PREFIX, DIMENSION, MAX_INPUT_TOKENS };
