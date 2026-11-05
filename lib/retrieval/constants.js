'use strict';
// Shared retrieval constants — single-sourced to prevent drift.
//
// INDEX_HEAD_CHARS is the number of characters from the head of each document used for
// term statistics. BM25 indexing, corpus IDF, and the entity graph MUST all scan the same
// prefix: if they diverge, IDF weighting desynchronizes from what BM25 actually indexed and
// the ranking/gate math skews silently, with no error. Keeping the value here means changing
// it in one place changes it everywhere it must agree.
module.exports = {
  INDEX_HEAD_CHARS: 50000,
  // Upper bound on how far the keyword/passage-LOCATION scans in search.js walk a single document's
  // full text. Those scans step a sliding window across the whole document synchronously on the socket
  // answer path, so an indexed multi-hundred-MB text file (MAX_FILE_SIZE allows very large files) would
  // freeze the event loop for every connected client for seconds. Capping the scan span bounds that
  // work: 2 MB of text (~600 pages) covers essentially every real document, and locating a passage in
  // only the first 2 MB of a larger one is an acceptable fallback — precise offsets already come from
  // the index's passageMap, and BM25/IDF only ever index the first INDEX_HEAD_CHARS anyway.
  KEYWORD_SCAN_MAX_CHARS: 2_000_000,
  // Shared deadline for the small auxiliary LLM calls that widen or refine a query — query
  // rewrite, intent classification, HyDE, corrective rephrase, and RAG-Fusion expansion. These
  // are best-effort helpers that must never hold up the real answer, so they share one bound.
  // Single-sourced here so the budget is tuned in one place, not five.
  AUX_LLM_TIMEOUT_MS: 12000,
};
