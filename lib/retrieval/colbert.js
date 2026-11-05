'use strict';
// Late-interaction (ColBERT-style) reranking manager. An OPT-IN second-stage refinement that re-sorts the
// cross-encoder's candidate passages by token-level MaxSim (see lib/retrieval/colbertcore.js), for sharper
// passage-anchor selection than a single pooled score gives. Off by default ("useColbertRerank": true in
// config.json to enable).
//
// Same discipline as the cross-encoder reranker: all model work runs in a WORKER THREAD, it is best-effort
// (any failure returns the candidates in their incoming order), and it reuses the shared worker factory
// (rerankworker.js). This file holds only the colbert-specific configuration; colbertcore.js holds the model.

const { COLBERT_MODEL } = require('../config');
const { makeRerankWorker } = require('./rerankworker');

const { rerank, preload, shutdown } = makeRerankWorker({
  name:           'colbert',
  coreModule:     'colbertcore.js',
  modelId:        COLBERT_MODEL,
  availableKey:   'USE_COLBERT_RERANK',
  scoreField:     'colbertScore',
  scoreTimeoutMs: 8000,            // token-level scoring is heavier than a pooled cross-encoder pass
  readyLog:       '✅ Late-interaction reranker ready',
  activeLabel:    'Late-interaction reranker active',
});

module.exports = { colbertRerank: rerank, preloadColbert: preload, shutdownColbert: shutdown };
