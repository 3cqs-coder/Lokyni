'use strict';
// ----------------------------
// Global Mutable State
// ----------------------------
// All shared state lives here so indexing and retrieval modules can import
// and mutate the same objects without circular deps.
// Consumers import the `state` object and mutate its properties directly,
// e.g. state.parentMap = shadowParentMap after a delta swap.

const state = {
  parentMap:       new Map(),   // docId → { content, metadata }
  childMap:        new Map(),   // childId → parentId
  passageMap:      new Map(),   // chunkId → { startChar, endChar }
  chunkIndex:      new Map(),   // parentId → [{childId, startChar}] sorted by startChar
  liveVectorStore: null,        // FAISS store (the ACTIVE embedding bank) — never nulled during updates
  vectorBanks:     [],          // when embedding banks are on: [{ fp, meta, store, embeddings, active }] — every bank, searched together
  liveBM25:        null,        // { engine, idToDocId, medianScore }
  corpusIdf:       new Map(),   // term → IDF score, rebuilt with BM25 index
  indexing:        false,       // informational — does NOT block queries
  activeQueries:   0,           // count of in-flight generation/search turns — used to warn before quitting the desktop app
  indexPromise:    null,        // deduplication guard for runDeltaUpdate
  indexProgress:   null,        // { done, total, name } during a scan, null when idle — surfaced in the status heartbeat
  indexReady:      false,       // true once FAISS + parentMap + BM25 + chunkIndex are all loaded
  // Lifecycle / health tracking (informational; surfaced via /api/health)
  startedAt:       Date.now(),  // process start time (ms)
  lastIndexedAt:   null,        // ms timestamp of last successful delta swap
  lastDelta:       null,        // { added, removed, at } summary of last delta
  vectorCount:     0,           // total vectors in the live FAISS index
  // Active workspace. Each workspace has its own documents/ and vector_store/ under
  // data/workspaces/<id>/, and only one is indexed in memory at a time — switching
  // reloads the index. Kept here rather than in config because it changes at runtime
  // and every path consumer needs to see the change immediately.
  workspaceId:     'default',
};

module.exports = state;
