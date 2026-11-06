'use strict';

// ── rerankcore — the cross-encoder model, isolated from everything else ───────
//
// Pure model logic: load the tokenizer + sequence-classification model once, then
// score (query, passage) pairs into one relevance logit each. No config, no worker
// plumbing, no I/O beyond the one-time model load — so it runs identically inside a
// worker_thread (its normal home, off the event loop; see lib/retrieval/reranker.js)
// and would run inline unchanged if ever needed. The caller passes an already-resolved
// model id, keeping this file free of the config module (which pulls in heavy deps and
// must not load in a worker).

const { makeLoader, MAX_INPUT_CHARS, frugalSessionOptions } = require('./modelload');

let _model = null, _tokenizer = null;

// Load the tokenizer + model once and cache them for the module's lifetime, through the shared offline-first
// loader (concurrent-load dedup, post-failure cooldown, cache-probe, and remote-retry live there). Only the
// model build differs: prefer 8-bit quantized weights (smaller/faster), falling back to full precision when
// the repo ships no quantized ONNX — the library no longer quantizes by default, so precision is explicit.
const init = makeLoader({
  isLoaded: () => !!(_model && _tokenizer),
  reset:    () => { _model = null; _tokenizer = null; },
  load: async (transformers, modelId) => {
    const { AutoTokenizer, AutoModelForSequenceClassification } = transformers;
    _tokenizer = await AutoTokenizer.from_pretrained(modelId);
    try { _model = await AutoModelForSequenceClassification.from_pretrained(modelId, { dtype: 'q8', ...frugalSessionOptions() }); }
    catch (_) { _model = await AutoModelForSequenceClassification.from_pretrained(modelId, { dtype: 'fp32', ...frugalSessionOptions() }); }
  },
});

// Return one relevance logit per text (higher = more relevant to the query), aligned to
// the input order. Throws if the model isn't loaded or the output shape is unexpected,
// so the caller can keep the original order rather than trust a bad result.
async function score(query, texts) {
  if (!_model || !_tokenizer) throw new Error('reranker model not initialized');
  if (!texts || texts.length === 0) return [];

  // Tokenize all (query, passage) pairs in one batch. text_pair is the passage;
  // padding/truncation keep the batch rectangular. The sequence-classification model
  // then yields one logit per pair.
  const passages = texts.map(t => String(t == null ? '' : t).slice(0, MAX_INPUT_CHARS));
  const inputs = _tokenizer(passages.map(() => query), { text_pair: passages, padding: true, truncation: true });
  const output = await _model(inputs);

  // output.logits is a Tensor of shape [batch, num_labels]. ms-marco rerankers have
  // num_labels=1, so the score is logits[i][0]; for multi-label heads the relevant
  // logit is the last column. Read the flat data.
  const logits = output && output.logits;
  const data = logits && logits.data;
  const dims = logits && logits.dims;
  if (!data || !dims || dims[0] !== texts.length) throw new Error(`unexpected reranker output shape (${dims})`);

  const labelsPerRow = dims[1] || 1;
  const out = new Array(texts.length);
  for (let i = 0; i < texts.length; i++) {
    const base = i * labelsPerRow;
    out[i] = labelsPerRow === 1 ? Number(data[base]) : Number(data[base + labelsPerRow - 1]);
  }
  return out;
}

module.exports = { init, score };
