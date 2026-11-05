'use strict';
// Cross-encoder reranker using Transformers.js (@huggingface/transformers, pure JS, no Python). Re-scores the
// top hybrid-retrieval candidates with a small local cross-encoder for a sharper final ordering — the standard
// "retrieve then rerank" second stage. Enabled by default; turn it off with "useReranker": false in
// config.json.
//
// All CPU work (tokenization + model inference) runs in a WORKER THREAD, never on the main event loop. This
// module is the thin manager: it supplies the reranker-specific configuration to the shared worker factory
// (rerankworker.js) and keeps the legacy model-name mapping and the startup self-test. lib/retrieval/
// rerankcore.js holds the model and runs inside the worker (~23MB quantized, downloaded once to the data
// directory). Best-effort: on any failure the candidates are returned in their original order.

const { RERANKER_MODEL } = require('../config');
const { makeRerankWorker } = require('./rerankworker');

// Transformers.js needs ONNX weights. The bare `cross-encoder/…` repos ship PyTorch only, so map them to the
// equivalent `Xenova/…` mirror that carries ONNX. This lets an older config.json (which pinned the bare name)
// keep working without edits.
const LEGACY_MODEL_MAP = {
  'cross-encoder/ms-marco-MiniLM-L-6-v2':  'Xenova/ms-marco-MiniLM-L-6-v2',
  'cross-encoder/ms-marco-MiniLM-L-4-v2':  'Xenova/ms-marco-MiniLM-L-4-v2',
  'cross-encoder/ms-marco-MiniLM-L-12-v2': 'Xenova/ms-marco-MiniLM-L-12-v2',
  'cross-encoder/ms-marco-MiniLM-L6-v2':   'Xenova/ms-marco-MiniLM-L-6-v2',
  'cross-encoder/ms-marco-MiniLM-L4-v2':   'Xenova/ms-marco-MiniLM-L-4-v2',
  'cross-encoder/ms-marco-MiniLM-L12-v2':  'Xenova/ms-marco-MiniLM-L-12-v2',
};
const MODEL_ID = LEGACY_MODEL_MAP[RERANKER_MODEL] || RERANKER_MODEL;   // RERANKER_MODEL carries the default from config

const { rerank, preload, shutdown } = makeRerankWorker({
  name:           'reranker',
  coreModule:     'rerankcore.js',
  modelId:        MODEL_ID,
  availableKey:   'USE_RERANKER',
  scoreField:     'rerankerScore',
  scoreTimeoutMs: 5000,            // bound the caller's wait; on timeout keep the hybrid order
  readyLog:       '✅ Cross-encoder reranker ready',
  activeLabel:    'Cross-encoder reranker active',
  // Self-test: a clearly-relevant passage must outscore an irrelevant one, so a broken model is surfaced up
  // front rather than silently degrading every answer.
  selfTest: async (rerank) => {
    const probe = await rerank('how many people live in Berlin', [
      { id: 'rel',   text: 'Berlin has a population of about 3.5 million residents.' },
      { id: 'irrel', text: 'The recipe calls for two cups of flour and one egg.' },
    ]);
    return !!(probe[0] && probe[0].id === 'rel');
  },
});

module.exports = { rerank, preloadReranker: preload, shutdownReranker: shutdown };
