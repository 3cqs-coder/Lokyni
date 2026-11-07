'use strict';
// Index bundle — the in-memory retrieval index for ONE workspace.
//
// The retrieval pipeline needs seven things to answer a query: the FAISS vector
// store, the parent/child/passage maps, the BM25 engine, the chunk index, and the
// corpus IDF table. Historically these lived as loose fields on the global `state`
// object, and every retrieval function read them directly — which meant there could
// only ever be ONE workspace's index in memory (the UI's active one), and querying
// any other workspace required moving the whole app to it.
//
// A "bundle" groups those seven fields into one object so retrieval can run against
// a bundle that is PASSED IN rather than read from globals. The global `state` IS a
// bundle (it has these fields), so retrieval functions default their `idx` param to
// `state` — the UI path is unchanged — while the API loads other workspaces into
// their own bundles and passes those. Two workspaces, two bundles, truly concurrent.
//
// This module owns: the bundle shape, loading a workspace into a fresh bundle from
// its on-disk cache, and a small warm cache of loaded bundles so repeat API queries
// to a non-active workspace don't reload FAISS every time.

const fs   = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { CACHE_FILES } = require('../constants');   // single source for the index artifact filenames
const { mtimeOf } = require('../statkey');          // shared "mtime or 0" for the freshness/ordering gates below

// The canonical list of fields that make up a retrieval index. Anything that reads
// or builds an index works through these names.
const INDEX_FIELDS = [
  'liveVectorStore',
  'vectorBanks',
  'parentMap',
  'liveBM25',
  'childMap',
  'passageMap',
  'chunkIndex',
  'corpusIdf',
];

// A fresh, empty bundle. Maps are created so build code can populate them in place.
const emptyBundle = () => ({
  liveVectorStore: null,
  vectorBanks: [],
  parentMap:  new Map(),
  liveBM25:   null,
  childMap:   new Map(),
  passageMap: new Map(),
  chunkIndex: new Map(),
  corpusIdf:  new Map(),
  workspaceId: null,
  // When this bundle's content was built. Lets per-workspace caches (e.g. the entity graph)
  // key on the exact index generation of THIS workspace, not the global active one — so a
  // background bundle for another workspace is never confused with the active workspace.
  lastIndexedAt: 0,
});

// Extract just the index fields from any object that has them (e.g. global state).
// Used so callers can treat `state` as a bundle without passing the whole object.
const bundleOf = (obj) => {
  const b = {};
  for (const f of INDEX_FIELDS) b[f] = obj[f];
  b.workspaceId = obj.workspaceId;
  b.lastIndexedAt = obj.lastIndexedAt || 0;
  return b;
};

// ── Loading a workspace into a bundle ────────────────────────────────────────
//
// Builds a complete, query-ready bundle for `workspaceId` from that workspace's
// on-disk cache, WITHOUT touching global state. This is the same warm-start
// sequence init.js uses, factored out so there is one implementation. init.js's
// own warm start is expressed in terms of this (loads into a bundle, then assigns
// the fields onto state).
//
// Returns a bundle, or a bundle with an empty parentMap if the workspace has no
// documents (a valid state — the caller answers "no documents").
// `stillCurrent()` lets the caller (getBundle) tell this loader whether the workspace's index generation has
// changed since the warm began — i.e. whether a delete/reindex/reconcile raced this (possibly slow, OCR-heavy)
// re-derive. When it returns false we must NOT persist the freshly-derived parent map to disk: a reconcile
// deletes the derived caches to force a re-derive from source, and writing a pre-delete cache back with a fresh
// mtime would resurrect the deleted document past the freshness gate and survive a restart. Defaults to "still
// current" for the direct (active-path) callers, which are allowed to write.
const loadWorkspaceBundle = async (workspaceId, stillCurrent = () => true) => {
  // Required lazily to avoid import cycles (these modules import config, which
  // imports state, which this module is adjacent to).
  const cfg = require('../config');
  const wsm = require('../workspaces');
  const { FaissStore } = require('@langchain/community/vectorstores/faiss');
  const { makeEmbeddings } = require('../embeddings');
  const { loadManifestFrom } = require('./manifest');
  const { collectAllFiles, loadSingleDocument, docIdFor } = require('./files');
  const { buildBM25Index } = require('../retrieval/bm25');
  const { buildChunkIndexInto } = require('../retrieval/passages');
  const { semanticSplitDocument } = require('./chunking');

  if (!wsm.isValidId(workspaceId)) throw new Error(`Invalid workspace id: ${workspaceId}`);
  wsm.ensureWorkspace(cfg.DATA_DIR, workspaceId);

  const cacheDir = wsm.cacheDirFor(cfg.DATA_DIR, workspaceId);
  const docsDir  = wsm.docsDirFor(cfg.DATA_DIR, workspaceId);
  const embeddings = makeEmbeddings();

  const bundle = emptyBundle();
  bundle.workspaceId = workspaceId;
  // Stamp the index generation from the manifest mtime (stable across reloads of unchanged
  // content, changes on every re-index), so per-workspace caches invalidate correctly.
  bundle.lastIndexedAt = manifestMtimeFor(workspaceId) || Date.now();

  const manifestPath = path.join(cacheDir, CACHE_FILES.manifest);
  const faissPath    = path.join(cacheDir, CACHE_FILES.faissIndex);
  const manifestExists = fsSync.existsSync(manifestPath);
  const faissExists    = fsSync.existsSync(faissPath);
  const manifest = manifestExists ? await loadManifestFrom(manifestPath) : {};
  // Freshness gate shared by every persisted map below (parent/passage/child): a map older than the manifest
  // is stale — a crash can land after saveManifest but before a map is rewritten — so it must be re-derived,
  // not served as valid. Computed once and reused. 0 when there is no manifest, which disables the gate (a
  // workspace with maps but no manifest still loads them).
  const manifestMtime = manifestExists ? await mtimeOf(manifestPath) : 0;

  // Populate parentMap. Prefer the persisted parent-map.json (full document text
  // saved at index time) — a cheap JSON read with no OCR. Only fall back to
  // re-extracting from source files (which re-runs OCR on images/PDFs) if that cache
  // is missing, unreadable, or STALE relative to the manifest.
  let diskFiles = [];
  const parentMapPath = path.join(cacheDir, CACHE_FILES.parentMap);
  let parentLoaded = false;
  // Same mtime gate the passage/child maps use below: a parent-map older than the manifest (left by a crash
  // between the manifest write and the parent-map write) would otherwise serve the PREVIOUS corpus's document
  // text as valid for a non-active workspace — which never runs a delta to heal it. Stale → fall back and
  // re-derive from source. parentMtime === 0 (missing) also falls back.
  const parentMtime = await mtimeOf(parentMapPath);
  if (parentMtime >= manifestMtime && parentMtime > 0) {
    try {
      // Streamed read (NDJSON), so a large corpus never loads as one whole-corpus string. migrate:false: a
      // non-active load must be side-effect-free on disk — rewriting a legacy whole-JSON cache as NDJSON here
      // would bump its mtime and could resurrect a concurrently-deleted doc (the active path does the migration).
      await require('./parentmapstore').loadParentMap(parentMapPath, bundle.parentMap, { migrate: false });
      parentLoaded = bundle.parentMap.size > 0;
    } catch { parentLoaded = false; }
  }

  if (!parentLoaded) {
    // Fallback: re-derive from source files (may OCR). Kept for pre-cache workspaces.
    try { diskFiles = await collectAllFilesForDir(docsDir, workspaceId); } catch { diskFiles = []; }
    for (const f of diskFiles) {
      // Pass the target workspace so an isolated-child OCR of a non-active workspace caches into
      // THAT workspace's directory, not the active one's.
      try { await loadSingleDocument(f, bundle.parentMap, { workspaceId }); } catch { /* skip unreadable */ }
    }
    // Flush the derived caches (OCR / summaries / visual descriptions) for THIS workspace ONCE, now that the
    // re-derive loop is done. The scoped set() calls above batch in memory rather than rewriting the whole
    // cache per document (that per-set flush was O(K²) across a K-document warm); this single end-of-warm
    // flush writes them through, matching how the active indexing path flushes at run-end.
    try { require('../ocrcache').flush(cacheDir); } catch { /* best-effort */ }
    try { require('../summarycache').flush(cacheDir); } catch { /* best-effort */ }
    try { require('../visualcache').flush(cacheDir); } catch { /* best-effort */ }
    try { require('../transcriptcache').flush(cacheDir); } catch { /* best-effort */ }
    // Self-heal: persist what we just extracted so the NEXT load is a cheap JSON
    // read instead of re-OCR. A workspace indexed before parent-map.json existed
    // pays the OCR cost once here, then never again.
    // Only persist when this warm is still the current generation — a delete/reindex/reconcile that raced the
    // (slow) re-derive above must not have its cache-clearing undone by writing a pre-change map back. Re-check
    // AFTER the write too: if a reconcile landed during the write, remove the now-stale file we just created so
    // it can't resurrect a deleted document on the next load (which would otherwise see a fresh mtime).
    if (bundle.parentMap.size > 0 && stillCurrent()) {
      try {
        await require('./parentmapstore').writeParentMap(parentMapPath, bundle.parentMap);
        if (!stillCurrent()) { try { await fs.unlink(parentMapPath); } catch { /* already gone */ } }
      } catch { /* best-effort */ }
    }
  }

  if (bundle.parentMap.size === 0) {
    // Empty workspace — a valid, query-ready-but-empty bundle. BM25 over nothing.
    bundle.liveBM25 = await buildBM25Index(bundle.parentMap, manifest._bm25Median ?? null, bundle);
    buildChunkIndexInto(bundle);
    return bundle;
  }

  if (cfg.useEmbeddingBanks) {
    // Load every embedding bank for this workspace (migrating a pre-banks single index
    // into a bank first). The active bank doubles as liveVectorStore for the code paths
    // that still reference a single store (vector counts, existence checks).
    const banks = require('./banks');
    try { banks.migrateLegacy(cacheDir, manifest._embeddingModel); } catch { /* best-effort */ }
    try {
      bundle.vectorBanks = await banks.loadBanks(cacheDir, { FaissStore, makeEmbeddings });
      // Prefer a bank that actually has a loaded store. Right after an embedding-model
      // change the new active bank has no store yet (nothing embedded into it), but the
      // frozen bank(s) still hold the corpus — so `liveVectorStore` (the readiness proxy
      // the retrieval guards check) must point at a real store, or search would wrongly
      // treat a fully-searchable corpus as empty.
      const active = bundle.vectorBanks.find(b => b.active && b.store)
        || bundle.vectorBanks.find(b => b.store) || null;
      bundle.liveVectorStore = active ? active.store : null;
    } catch { bundle.vectorBanks = []; bundle.liveVectorStore = null; }
  } else if (faissExists) {
    try {
      bundle.liveVectorStore = await FaissStore.load(cacheDir, embeddings);
    } catch {
      bundle.liveVectorStore = null;   // corrupt/mismatched — BM25-only still works
    }
  }

  // passageMap + childMap: load from cache when present and fresh, else rebuild.
  const passageMapPath = path.join(cacheDir, CACHE_FILES.passageMap);
  const childMapPath   = path.join(cacheDir, CACHE_FILES.childMap);
  // manifestMtime computed once above (shared with the parent-map gate).
  const passageMtime   = await mtimeOf(passageMapPath);
  const passageCacheValid = passageMtime >= manifestMtime && passageMtime > 0;

  // Stream the cache from NDJSON (fail-closed) so loading a non-active workspace on demand never blocks
  // the event loop on a whole-file JSON.parse of a large corpus's chunk maps.
  const { loadMap } = require('./ndjsonmapstore');
  let passageLoaded = false;
  if (passageCacheValid) {
    // migrate:false — same side-effect-free-on-disk reasoning as the parent map above.
    const r = await loadMap(passageMapPath, bundle.passageMap, { migrate: false });
    passageLoaded = r.ok && r.present;
  }
  if (passageLoaded) {
    const rc = await loadMap(childMapPath, bundle.childMap, { migrate: false });
    const childLoaded = rc.ok && rc.present;
    if (!childLoaded) {
      // childMap failed to load (loadMap cleared it, fail-closed) but passageMap loaded from cache. Rebuilding
      // the child map re-derives passage entries too, so clear the stale passageMap first and co-derive both —
      // otherwise a passage entry whose key the current chunker no longer produces would linger as an orphan
      // with no matching child entry (the two maps could disagree).
      bundle.passageMap.clear();
      for (const [, entry] of bundle.parentMap) {
        try { await semanticSplitDocument({ content: entry.content, metadata: entry.metadata }, bundle.childMap, bundle.passageMap); } catch {}
      }
    }
  } else {
    // Rebuild from parentMap (always populated by now), not diskFiles — which is
    // empty when parentMap was loaded from its cache rather than from source files.
    for (const [, entry] of bundle.parentMap) {
      try { await semanticSplitDocument({ content: entry.content, metadata: entry.metadata }, bundle.childMap, bundle.passageMap); } catch {}
    }
  }

  // Guard the final build: a throw here (unlike the per-document splits above, which are already isolated)
  // would reject the whole warm, so every getBundle for this workspace returns {status:'warming'} forever and
  // each retry re-runs the full, possibly OCR-heavy load. Degrade to a returnable (BM25-less) bundle instead —
  // dense/keyword retrieval still works off the parent/child maps and the vector store — rather than wedging.
  try {
    bundle.liveBM25 = await buildBM25Index(bundle.parentMap, manifest._bm25Median ?? null, bundle);
    buildChunkIndexInto(bundle);
  } catch (e) {
    try { console.warn(`⚠️  BM25/chunk-index build failed for "${workspaceId}" — serving a degraded (keyword-less) bundle: ${e && e.message || e}`); } catch {}
    if (!bundle.liveBM25) bundle.liveBM25 = null;
  }
  return bundle;
};

// collectAllFiles is workspace-aware via config getters; for an off-active workspace
// we must scan that workspace's own docs dir plus its source folders. The source
// folders are per-workspace settings, so read them for this workspace explicitly.
const collectAllFilesForDir = async (docsDir, workspaceId) => {
  const { walkDirectory, walkSource } = require('./files');
  const cfg = require('../config');
  const wsm = require('../workspaces');
  const seen = new Set();
  const all = [];
  const add = (list) => { for (const f of list) { const k = path.resolve(f); if (!seen.has(k)) { seen.add(k); all.push(k); } } };
  try { add(await walkDirectory(docsDir)); } catch { /* may not exist */ }
  // Per-workspace source folders.
  try {
    const ws = wsm.loadSettings(cfg.DATA_DIR, workspaceId);
    const raw = Array.isArray(ws.sourcePaths) ? ws.sourcePaths : [];
    for (const entry of raw) {
      const o = typeof entry === 'string' ? { path: entry } : (entry || {});
      if (!o.path || o.enabled === false) continue;
      const src = {
        path: path.resolve(require('../config').expandHome(o.path)),
        recursive: o.recursive === true,
        maxDepth: Number.isInteger(o.maxDepth) ? o.maxDepth : 3,
      };
      try { add(await walkSource(src.path, src)); } catch { /* skip */ }
    }
  } catch { /* no settings */ }
  return all;
};

// ── Warm cache of loaded bundles ─────────────────────────────────────────────
//
// Loading a bundle reads FAISS from disk — worth caching so repeat API queries to
// the same non-active workspace are fast. Small LRU; the active (UI) workspace is
// NOT cached here (it lives in global state). Each entry carries the manifest mtime
// it was loaded at, so a workspace whose index changed on disk is reloaded.

const MAX_CACHED = 3;
// A memory ceiling for the non-active bundle cache, as an estimate of the document text held across it
// (see approxBundleBytes). The active workspace lives in global state and is not counted here; this caps
// only the EXTRA corpora kept warm for other windows, so peak resident stays bounded even with several
// large workspaces. ~256M chars of text is a generous cap that still lets small workspaces fill the count.
const MAX_CACHED_BYTES = 256 * 1024 * 1024;
const _cache = new Map();   // workspaceId → { bundle, loadedMtime, lastUsed, bytes, generation }

// A monotonic per-workspace generation, bumped whenever a workspace is invalidated or reconciled. A load
// captures the generation at its START; if the workspace is invalidated WHILE that load runs, the captured
// generation no longer matches and the finished bundle is not cached. This closes a race the manifest
// mtime alone cannot: reconcileWorkspaceDocsChange deletes the derived caches but does not rewrite the
// manifest (no pipeline runs for a non-active workspace), so an in-flight load that already read the old
// caches would otherwise re-cache stale content under an unchanged mtime and keep serving it.
const _generation = new Map();   // workspaceId → int
const curGen = (workspaceId) => _generation.get(workspaceId) || 0;
const bumpGen = (workspaceId) => _generation.set(workspaceId, curGen(workspaceId) + 1);

const manifestMtimeFor = (workspaceId) => {
  try {
    const cfg = require('../config');
    const wsm = require('../workspaces');
    const p = path.join(wsm.cacheDirFor(cfg.DATA_DIR, workspaceId), CACHE_FILES.manifest);
    return fsSync.statSync(p).mtimeMs;
  } catch { return 0; }
};

// Get a query-ready bundle for a workspace. Returns the active workspace's live
// bundle (global state) when asked for the active one, so the API and UI share the
// same in-memory index for the active workspace rather than double-loading it.
const getBundle = async (workspaceId) => {
  const state = require('../state');
  if (workspaceId === state.workspaceId && state.indexReady) {
    return bundleOf(state);
  }

  const currentMtime = manifestMtimeFor(workspaceId);
  const cached = _cache.get(workspaceId);
  if (cached && cached.loadedMtime === currentMtime) {
    cached.lastUsed = Date.now();
    return cached.bundle;
  }

  // Capture the generation before the load; if the workspace is invalidated during the load, skip caching
  // the now-stale result (still return it to this caller, who requested it before the change). Without
  // this, an in-flight load that raced reconcileWorkspaceDocsChange would re-cache stale content.
  const genAtStart = curGen(workspaceId);
  // Pass the generation predicate so the loader won't persist a freshly-derived cache to disk if a
  // delete/reindex/reconcile raced this warm (which would resurrect a deleted doc past the freshness gate).
  const bundle = await loadWorkspaceBundle(workspaceId, () => curGen(workspaceId) === genAtStart);
  if (curGen(workspaceId) === genAtStart) {
    _cache.set(workspaceId, { bundle, loadedMtime: currentMtime, lastUsed: Date.now(), bytes: approxBundleBytes(bundle), generation: genAtStart });
    evictLru();
  }
  return bundle;
};

// A rough resident-size proxy for a cached bundle: the document text it holds (parentMap content). It
// dominates the footprint and is cheap to sum once at load. The FAISS store and the derived maps scale
// with it, so it tracks total memory well enough to bound the cache. Not exact — just a stable relative
// measure for eviction.
const approxBundleBytes = (bundle) => {
  let n = 0;
  try { for (const [, e] of bundle.parentMap) n += (e && e.content ? e.content.length : 0); } catch { /* best-effort */ }
  return n;
};

// Evict least-recently-used entries until BOTH caps hold: at most MAX_CACHED bundles, and at most
// MAX_CACHED_BYTES of estimated text across them. The byte cap is what keeps several LARGE non-active
// corpora from co-residing (the count cap alone is size-blind). The most-recently-used entry is never
// evicted, so a workspace bigger than the byte cap on its own still stays usable — its neighbors are
// dropped around it.
const evictLru = () => {
  const overBytes = () => { let t = 0; for (const [, v] of _cache) t += (v.bytes || 0); return t > MAX_CACHED_BYTES; };
  while (_cache.size > MAX_CACHED || (_cache.size > 1 && overBytes())) {
    let oldestKey = null, oldest = Infinity;
    for (const [k, v] of _cache) { if (v.lastUsed < oldest) { oldest = v.lastUsed; oldestKey = k; } }
    if (oldestKey === null) break;
    _cache.delete(oldestKey);
  }
};

// Drop a workspace's cached bundle — called when its index changes on disk so the next getBundle reloads
// it. Bumps the generation so any load already in flight for this workspace will not re-cache its stale
// result, and drops the in-flight warm so a later request starts a fresh load rather than joining the
// stale one. Safe to call for a workspace that isn't cached.
const invalidateBundle = (workspaceId) => { bumpGen(workspaceId); _cache.delete(workspaceId); _warming.delete(workspaceId); };

// Reconcile a NON-active workspace's on-disk index with a documents change (an upload, a delete, a
// URL ingest, or a source-folder edit) without running the full indexing pipeline, which only targets
// the active workspace. Dropping the derived map caches (parent/passage/child) makes the next bundle
// load re-derive them from the actual files on disk — so a deleted document stops being retrieved and a
// new one becomes searchable. The FAISS store is left intact: it re-embeds only when the workspace next
// becomes active (a full delta), and until then a deleted document's orphaned vectors are harmlessly
// dropped at retrieval (a hit with no parentMap entry is skipped) while a new document is found via BM25.
// Re-derivation reuses cached OCR text, so it is cheap; it also runs on the background warm path, never
// blocking a request. Best-effort and synchronous file removal — never throws into the caller.
const reconcileWorkspaceDocsChange = (workspaceId) => {
  invalidateBundle(workspaceId);
  try {
    const cfg = require('../config');
    const wsm = require('../workspaces');
    const dir = wsm.cacheDirFor(cfg.DATA_DIR, workspaceId);
    for (const f of [CACHE_FILES.parentMap, CACHE_FILES.passageMap, CACHE_FILES.childMap]) {
      try { fsSync.rmSync(path.join(dir, f), { force: true }); } catch { /* absent or busy — re-derive still corrects it */ }
    }
  } catch { /* best-effort — the bundle invalidation alone still forces a reload */ }
};

// ── Non-blocking acquisition (for the API) ───────────────────────────────────
//
// loadWorkspaceBundle can be slow the FIRST time for a workspace whose text cache
// (parent-map.json) doesn't exist yet — it has to re-extract every document, which
// runs OCR on images/PDFs. Blocking an HTTP request for that long is bad, and a
// canceled request loses the work. So the API uses getBundleNonBlocking: if the
// workspace can be served immediately (active workspace, warm cache, or an existing
// text cache that loads fast) it returns the bundle; otherwise it kicks off warming
// in the BACKGROUND and returns { status: 'warming' } so the caller can tell the
// client to retry shortly. Concurrent requests for the same workspace share one
// warming job rather than starting several OCR passes.

const _warming = new Map();   // workspaceId → Promise (in-flight warm)
// Cap how many DISTINCT workspaces warm at once. _warming already dedupes repeat requests for the SAME
// workspace, but a burst of requests naming many different workspaces would otherwise start a full load
// (OCR + FAISS + BM25/chunk build, each holding a whole corpus in memory) for every one at the same
// instant, before the LRU cache can evict any. The gate serializes the extra ones through a small pool;
// callers still get an immediate { status: 'warming' } and retry, so nothing blocks.
const { createSemaphore } = require('../semaphore');
const _warmGate = createSemaphore({ max: 2 });
// How long a fast (text-cached) load may be awaited before the caller is told to retry. Long enough that a
// normal cached load always lands on the first request, short enough that a stalled load never wedges a turn.
const SYNC_LOAD_TIMEOUT_MS = 8000;

// Does this workspace have a text cache ready, so loadWorkspaceBundle is fast (no
// OCR)? The presence of parent-map.json is the signal — it's what lets the loader
// skip document re-extraction.
const parentCacheReady = (workspaceId) => {
  try {
    const cfg = require('../config');
    const wsm = require('../workspaces');
    const p = path.join(wsm.cacheDirFor(cfg.DATA_DIR, workspaceId), CACHE_FILES.parentMap);
    return fsSync.existsSync(p) && fsSync.statSync(p).size > 0;
  } catch { return false; }
};

// Returns { status: 'ready', bundle } | { status: 'warming' }.
// 'ready' means the bundle is loaded and usable now. 'warming' means loading has
// been started in the background (or was already running) and the caller should
// retry shortly.
const getBundleNonBlocking = async (workspaceId) => {
  const state = require('../state');

  // Active workspace: always live in global state, instant.
  if (workspaceId === state.workspaceId && state.indexReady) {
    return { status: 'ready', bundle: bundleOf(state) };
  }

  // Warm cache hit (and still current): instant.
  const currentMtime = manifestMtimeFor(workspaceId);
  const cached = _cache.get(workspaceId);
  if (cached && cached.loadedMtime === currentMtime) {
    cached.lastUsed = Date.now();
    return { status: 'ready', bundle: cached.bundle };
  }

  // A workspace with a text cache (parent-map.json) loads fast — no OCR. One without would re-extract
  // every document, running OCR on images/PDFs, so its first load is heavy and gated. Either way the load
  // runs as ONE shared background job tracked in _warming, so concurrent requests never start it twice.
  const fast = parentCacheReady(workspaceId);
  if (!_warming.has(workspaceId)) {
    let job;
    job = (async () => {
      // Gate only the heavy (OCR) first-load through the pool so a burst can't hold several whole corpora
      // in memory at once; a fast cached load isn't gated, so it can't queue behind a slow OCR pass.
      try { return fast ? await getBundle(workspaceId) : await _warmGate.run(() => getBundle(workspaceId)); }
      // Clear the entry only if it is still OURS. An invalidate between our set and finish drops our entry
      // and a later request may install a new job under this key; deleting by key unconditionally would
      // then evict that newer job and break the dedup, so a third request would start a redundant load.
      finally { if (_warming.get(workspaceId) === job) _warming.delete(workspaceId); }
    })();
    _warming.set(workspaceId, job);
    // Surface background failures in the log rather than as an unhandled rejection.
    job.catch(e => console.warn(`⚠️  Background warm of workspace "${workspaceId}" failed: ${e.message || e}`));
  }

  // A fast load is briefly waited on so a query is answered on the first try — but the wait is BOUNDED, so
  // a pathological stall (slow disk, a huge FAISS file) falls back to 'warming' and finishes in the
  // background for the retry rather than wedging the serialized turn. An OCR-cold workspace isn't waited on.
  if (fast) {
    const job = _warming.get(workspaceId);
    let timer = null;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), SYNC_LOAD_TIMEOUT_MS); });
    try {
      const bundle = await Promise.race([job.then(b => b, () => null), timeout]);
      if (bundle) return { status: 'ready', bundle };
    } finally { if (timer) clearTimeout(timer); }
  }
  return { status: 'warming' };
};

module.exports = {
  INDEX_FIELDS, emptyBundle, bundleOf, manifestMtimeFor,
  loadWorkspaceBundle, getBundle, getBundleNonBlocking, invalidateBundle, reconcileWorkspaceDocsChange, parentCacheReady,
  // Test-only hook into the non-active-workspace LRU cache. This cache (NOT workspaces.js) is the real
  // memory bound for inactive corpora, so its eviction must be exercised. Not for production use.
  __test: { cache: _cache, evictLru, approxBundleBytes, MAX_CACHED, MAX_CACHED_BYTES },
};
