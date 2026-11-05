'use strict';
// LLM-extracted knowledge graph, per workspace. A language model reads each document and extracts the
// entities and the TYPED relationships between them ("Acme acquired Globex", "Dr. Chen authored the
// report"); this module persists those per-document extractions and merges them into one graph that
// retrieval can traverse for relationship and multi-hop questions.
//
// Design choices that make it fast and safe, deliberately simpler than the community-summary approach
// the heavy graph systems use (which is the slow, expensive part they pay for and we skip):
//   • ONE extraction per document, cached by content hash, so re-indexing an unchanged corpus re-runs
//     nothing and only genuinely changed documents pay the model cost.
//   • INCREMENTAL by construction: the persisted store is keyed by document id, so adding, changing, or
//     deleting a document is a union/replace/remove of that one document's contribution — no global
//     graph rebuild, no community re-clustering.
//   • Built off the already-stored document text, so enabling it on an existing corpus is a background
//     pass that re-embeds NOTHING — the vector index is never touched.
//   • The merged graph uses the exact { nodes, edges, tokenIndex } shape the lightweight co-occurrence
//     graph uses, so it reuses that module's query-entity matching and bridge traversal — one code path.
//
// Non-blocking discipline (this runs alongside live queries):
//   • The query path never re-merges the graph on the hot path. The background build precomputes the merged
//     view and populates the cache, so a query is a pure in-memory map lookup; a cold miss (e.g. right after a
//     restart) reads the file asynchronously and runs buildMerged, which yields to the event loop periodically
//     so even a large merge does not stall other clients.
//   • The persisted store is streamed to disk as NDJSON (one document per line) and read back a line at a
//     time, so neither writing nor loading ever builds or parses a string spanning the whole corpus — the
//     peak transient is a single document's extractions. A very large graph-RAG corpus therefore can't freeze
//     the event loop or exhaust memory on save/load. (See ndjsonmapstore for the streaming writer/reader.)
//   • The merged graph is capped (MAX_NODES), mirroring the co-occurrence graph, so memory stays bounded
//     no matter how large the corpus grows.
//
// Everything is best-effort: a failed extraction contributes no edges for that document, never an error.

const fs = require('fs');
const path = require('path');
const ndjson = require('./indexing/ndjsonmapstore');
const { normKey } = require('./retrieval/entities');

// Bump when the extraction prompt/shape changes so a stored graph from an older prompt is rebuilt.
const GRAPH_VERSION = 1;
// Ceiling on model-backed entity/relation extractions per build, so first-enabling graph-RAG on a very large
// corpus can't launch an unbounded (many-hours) background run. Matches the co-occurrence graph's
// MAX_DOCS_SCANNED so both graph features cover a corpus of the same scale. Remaining documents are covered by
// later incremental builds; none are dropped from search.
const MAX_EXTRACTIONS_PER_BUILD = 25000;
// Checkpoint the store to disk every this-many extractions during a build, so an interrupted build (the app
// quit mid-run) keeps its progress and resumes instead of starting over. Each extraction is a model call, so
// this writes at most once per ~this-many model calls — negligible beside the model time.
const GRAPH_SAVE_EVERY = 25;
const FILE = 'knowledge-graph.json';
const DESC_CAP = 600;            // cap a merged node/edge description so the store can't grow unbounded
const MAX_MERGED_CACHE = 4;      // per-workspace merged graphs held in memory (LRU), like the co-occ graph
const MAX_NODES = 20000;         // cap the merged graph so memory stays bounded on a huge corpus (matches
                                 // the co-occurrence graph's cap); once reached, no NEW entities are added
                                 // but existing ones keep accreting documents and edges.

const filePath = (workspaceId) => path.join(require('./workspaces').cacheDirFor(require('./config').DATA_DIR, workspaceId), FILE);

// Reserved map key carrying GRAPH_VERSION as the first NDJSON record. A real document id never contains a NUL
// byte, so this can't collide with one. Folding the version into the stored file (not only into contentHash)
// lets a load after a GRAPH_VERSION bump return empty at once, so the old-prompt graph is never served while
// the background build re-extracts.
const VERSION_KEY = '\u0000graph-version';

// ── Persistence (streaming NDJSON) ──────────────────────────────────────────────
// Each document is one record — `{"k":<docId>,"v":{ hash, entities:[{name,type,description}],
// relations:[{source,target,description,keywords:[]}] }}` — preceded by a version record and followed by a
// trailing sentinel proving the file is complete (see ndjsonmapstore). Neither writing nor reading ever builds
// or parses a string spanning the whole corpus, so a very large graph-RAG corpus can't freeze the event loop
// or exhaust memory; the peak transient is a single document's extractions. The reader FAILS CLOSED and the
// store is a rebuildable cache, never user data: a torn file, a count mismatch, a version mismatch, or any file
// that is not this NDJSON format yields an empty store so the background build re-extracts. A non-NDJSON file is
// classified from its first bytes and never parsed, so it can neither OOM nor be served. The merge that follows
// a load yields to the event loop (see buildMerged).
const load = async (workspaceId) => {
  const file = filePath(workspaceId);
  try {
    if (!(await ndjson.isNdjson(file))) return { version: GRAPH_VERSION, docs: {} };   // missing or not our format → rebuild
    const map = new Map();
    const r = await ndjson.loadMap(file, map, { migrate: false });
    if (!r.ok || map.get(VERSION_KEY) !== GRAPH_VERSION) return { version: GRAPH_VERSION, docs: {} };
    map.delete(VERSION_KEY);
    const docs = {};
    for (const [k, v] of map) docs[k] = v;
    return { version: GRAPH_VERSION, docs };
  } catch { return { version: GRAPH_VERSION, docs: {} }; }
};
const save = async (workspaceId, store) => {
  try {
    require('./workspaces').ensureWorkspace(require('./config').DATA_DIR, workspaceId);
    // Stream the version record first, then one record per document. writeMap writes to a unique temp file,
    // fsyncs, and atomically renames, so a crash mid-write can never truncate the live store.
    const map = new Map();
    map.set(VERSION_KEY, GRAPH_VERSION);
    for (const [docId, entry] of Object.entries(store.docs || {})) map.set(docId, entry);
    await ndjson.writeMap(filePath(workspaceId), map);
  } catch { /* a graph that can't be written just means it rebuilds next time */ }
};

// ── Pure merge: per-document extractions → one { nodes, edges, tokenIndex } graph ──
// nodes: key → { name, type, description, docs:Set }; edges: key → Map(nbrKey → weight); tokenIndex:
// token → Set(nodeKey). Entities and relationships are merged by normalized key across documents
// (the union/dedup step), descriptions concatenated and capped. Bounded by MAX_NODES so a very large
// corpus can't grow the merged graph without limit. Pure and exported for tests.
const buildMerged = async (docs) => {
  const nodes = new Map();
  const edges = new Map();
  const tokenIndex = new Map();
  // Coerce every field to a string before use: a hand-corrupted or legacy store with a non-string name would
  // otherwise throw in normKey (name.toLowerCase()) and blank the whole graph. Fail soft on bad fields instead.
  const str = (v) => (typeof v === 'string' ? v : (v == null ? '' : String(v)));
  const addNode = (name, type, description, docId) => {
    const nm = str(name);
    const key = normKey(nm);
    if (!key) return null;
    let node = nodes.get(key);
    if (!node) {
      if (nodes.size >= MAX_NODES) return null;   // graph full — ignore new entities, keep the existing ones
      node = { name: nm.trim(), type: str(type), description: '', docs: new Set() };
      nodes.set(key, node);
      for (const tok of key.split(' ')) { if (!tok) continue; if (!tokenIndex.has(tok)) tokenIndex.set(tok, new Set()); tokenIndex.get(tok).add(key); }
    }
    if (docId) node.docs.add(docId);
    const desc = str(description);
    if (desc && node.description.length < DESC_CAP) {
      node.description = (node.description ? node.description + ' ' : '') + desc;
      if (node.description.length > DESC_CAP) node.description = node.description.slice(0, DESC_CAP);
    }
    return key;
  };
  const addEdge = (a, b) => {
    if (!a || !b || a === b) return;
    if (!edges.has(a)) edges.set(a, new Map());
    edges.get(a).set(b, (edges.get(a).get(b) || 0) + 1);
  };
  let i = 0;
  for (const [docId, entry] of Object.entries(docs || {})) {
    if (!entry) continue;
    for (const e of (entry.entities || [])) addNode(e.name, e.type, e.description, docId);
    for (const r of (entry.relations || [])) {
      const a = addNode(r.source, '', '', docId);
      const b = addNode(r.target, '', '', docId);
      if (a && b) { addEdge(a, b); addEdge(b, a); }
    }
    // Yield periodically so merging a large graph (up to the node cap over many documents) never blocks the
    // event loop on the query path's cold cache miss. Called only from async contexts.
    if ((++i % 500) === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  return { nodes, edges, tokenIndex };
};

// A small summary of a merged graph, for status/UI (undirected edge count).
const summarize = (graph) => {
  let edges = 0;
  for (const m of graph.edges.values()) edges += m.size;
  return { nodes: graph.nodes.size, edges: Math.floor(edges / 2) };
};

// A BOUNDED node/edge view for the corpus mind-map. The full graph can hold tens of thousands of nodes —
// far more than a browser can render or a person can read — so keep only the most connected nodes (ranked by
// degree, then document coverage) and the undirected edges among them. Pure and synchronous: given a merged
// graph it returns { nodes:[{id,label,type,degree,docs}], edges:[{source,target,weight}], total, shown }.
const vizSubgraph = (graph, maxNodes = 150) => {
  const nodeMap = graph.nodes, edgeMap = graph.edges;
  const degree = (k) => (edgeMap.get(k) ? edgeMap.get(k).size : 0);
  const docCount = (k) => { const n = nodeMap.get(k); return n && n.docs ? n.docs.size : 0; };
  const ranked = [...nodeMap.keys()].sort((a, b) => (degree(b) - degree(a)) || (docCount(b) - docCount(a)));
  const keep = ranked.slice(0, Math.max(1, maxNodes));
  const keepSet = new Set(keep);
  const nodes = keep.map((k) => { const n = nodeMap.get(k); return { id: k, label: n.name, type: n.type || '', degree: degree(k), docs: docCount(k) }; });
  const edges = [];
  for (const a of keep) {
    const m = edgeMap.get(a);
    if (!m) continue;
    for (const [b, w] of m) { if (a < b && keepSet.has(b)) edges.push({ source: a, target: b, weight: w }); }   // a<b dedups the undirected pair
  }
  return { nodes, edges, total: summarize(graph), shown: nodes.length };
};

// ── In-memory merged-graph cache (LRU by workspace), invalidated by the file's mtime ──
const _merged = new Map();   // workspaceId -> { mtimeMs, graph }
const mtimeOf = async (workspaceId) => { try { return (await fs.promises.stat(filePath(workspaceId))).mtimeMs; } catch { return 0; } };
const cachePut = (workspaceId, mtimeMs, graph) => {
  _merged.delete(workspaceId);
  _merged.set(workspaceId, { mtimeMs, graph });
  if (_merged.size > MAX_MERGED_CACHE) _merged.delete(_merged.keys().next().value);
};
// Get the merged graph for a workspace. Async and non-blocking: a cache hit (the common case, kept warm
// by the background build) is a pure map return; a cold miss reads the file asynchronously and merges a
// bounded graph. Never throws — returns an empty graph on any error.
// Coalesce concurrent cold misses (keyed by workspace:mtime) into ONE load+merge, mirroring entitygraph.getGraph.
// During a long background build each checkpoint save bumps the mtime and invalidates the cache, so without this
// N simultaneous queries would each run a full (up to MAX_NODES) load+merge in parallel — bounded, but wasted CPU
// and a transient-memory multiplier. Keyed by mtime so a newer build never hands back a stale in-flight graph.
const _buildingMerged = new Map();
const getGraph = async (workspaceId) => {
  let mt;
  try { mt = await mtimeOf(workspaceId); }
  catch { return buildMerged({}); }
  const cached = _merged.get(workspaceId);
  if (cached && cached.mtimeMs === mt) { _merged.delete(workspaceId); _merged.set(workspaceId, cached); return cached.graph; }
  const key = `${workspaceId}:${mt}`;
  const inflight = _buildingMerged.get(key);
  if (inflight) return inflight;
  const promise = load(workspaceId)
    .then((store) => buildMerged(store.docs))
    .then((graph) => { cachePut(workspaceId, mt, graph); return graph; })
    .catch(() => buildMerged({}))                    // a failed load yields an empty graph (uncached), never throws
    .finally(() => { _buildingMerged.delete(key); });
  _buildingMerged.set(key, promise);
  return promise;
};

// ── Incremental maintenance ─────────────────────────────────────────────────────
// Fold the graph-extraction model into the hash so a document extracted with one model is re-extracted (its
// stored hash no longer matches) after the user switches graphRagModel — otherwise an incremental build would
// keep the old model's entities/relations on unchanged documents and leave a mixed-model knowledge graph.
const contentHash = (text) => {
  const c = require('./config');
  // Effective extraction model — graphextract falls back to the default chat model when GRAPH_RAG_MODEL is
  // unset, so changing either must invalidate.
  const model = String(c.GRAPH_RAG_MODEL || c.LLM_MODEL || '');
  return require('crypto').createHash('sha256').update(`gext${GRAPH_VERSION}:${model}:`).update(text || '').digest('hex');
};
const hasDocHash = (store, docId, hash) => !!(store.docs[docId] && store.docs[docId].hash === hash);

// Build (or refresh) the whole graph for a workspace from its already-stored document text. Extracts
// only documents whose content changed since the stored graph, prunes documents no longer present, and
// saves once at the end. Background, bounded, fail-open, yields to the event loop so it never blocks.
// Returns { status, extracted, total, nodes, edges } or a not-ready status. `onProgress(done,total)`
// optional.
//
// A per-workspace in-flight guard coalesces overlapping triggers (a manual build and the automatic
// post-delta refresh, or two quick deltas): the second caller joins the running build instead of racing
// it, so the store is never written by two passes at once. A per-workspace generation counter closes the
// race with clearGraph: if the graph is cleared or rebuilt while a build is running, that build's save is
// skipped so it can't resurrect the pre-clear graph.
const _building = new Map();   // workspaceId -> Promise
const _generation = new Map(); // workspaceId -> int, bumped by clearGraph
const buildGraph = (workspaceId, onProgress) => {
  const running = _building.get(workspaceId);
  if (running) return running;
  const p = _buildGraphInner(workspaceId, onProgress)
    // Compare-and-delete: only clear the slot if it still holds THIS build, so a clear that evicted us
    // (replacing the slot with a newer build) can't have its entry clobbered when we finish.
    .finally(() => { if (_building.get(workspaceId) === p) _building.delete(workspaceId); });
  _building.set(workspaceId, p);
  return p;
};
const _buildGraphInner = async (workspaceId, onProgress) => {
  const myGen = _generation.get(workspaceId) || 0;
  const acq = await require('./indexing/bundle').getBundleNonBlocking(workspaceId);
  if (acq.status === 'warming') return { status: 'warming' };
  const idx = acq.bundle;
  if (!idx || !idx.parentMap || idx.parentMap.size === 0) return { status: 'empty' };

  const { extractForText } = require('./indexing/graphextract');
  const HEAD = require('./retrieval/constants').INDEX_HEAD_CHARS;
  const store = await load(workspaceId);
  const present = new Set();
  let extracted = 0, done = 0, capped = false;
  const total = idx.parentMap.size;
  for (const [docId, entry] of idx.parentMap) {
    present.add(docId);
    const text = (entry && entry.content) ? String(entry.content).slice(0, HEAD * 2) : '';
    const hash = contentHash(text);
    // Each extraction is a model call, so bound how many one build performs. Without a ceiling, first-enabling
    // graph-RAG on a very large corpus would issue one model call per document — potentially a many-hours
    // background run. Keep iterating so `present` stays complete (stale-doc pruning below stays correct) but
    // stop spending model calls past the cap; the remaining documents keep their existing edges (or none) and
    // are picked up by later incremental builds. Mirrors MAX_DOCS_SCANNED in the co-occurrence graph, which
    // bounds how large a corpus the graph features cover. A document is never dropped from search by this —
    // only its optional graph edges are deferred.
    if (!hasDocHash(store, docId, hash)) {
      if (extracted >= MAX_EXTRACTIONS_PER_BUILD) {
        capped = true;
      } else {
        const name = path.basename((entry && entry.metadata && entry.metadata.source) || docId);
        const res = await extractForText(text, name);          // bounded + fail-open
        store.docs[docId] = { hash, entities: res.entities || [], relations: res.relations || [] };
        extracted += 1;
        // Checkpoint progress periodically so quitting the app mid-build doesn't throw away a long run. Each
        // save is atomic (temp + fsync + rename — the live store is never truncated), and the build that the
        // boot/index-delta refresh kicks off on the next launch resumes from here, re-extracting only the
        // documents still missing (keyed by content hash). Bounds the work an interrupted build can lose to at
        // most GRAPH_SAVE_EVERY documents. The save is cheap relative to the model calls that dominate a build.
        if (extracted % GRAPH_SAVE_EVERY === 0 && (_generation.get(workspaceId) || 0) === myGen) {
          await save(workspaceId, store);
        }
      }
    }
    done += 1;
    if (typeof onProgress === 'function') { try { onProgress(done, total); } catch {} }
    if (done % 5 === 0) await new Promise((r) => setImmediate(r));   // yield so indexing/queries stay responsive
  }
  if (capped && typeof onProgress === 'function') { try { onProgress(total, total); } catch {} }
  // Prune documents that are no longer in the corpus (deleted/moved) — the incremental remove.
  for (const docId of Object.keys(store.docs)) if (!present.has(docId)) delete store.docs[docId];

  // If the graph was cleared or rebuilt while we ran, our store is stale — do not write it back, or we
  // would resurrect the pre-clear graph over the wipe.
  if ((_generation.get(workspaceId) || 0) !== myGen) return { status: 'aborted' };

  await save(workspaceId, store);
  // A clear/rebuild can land DURING the async save (clearGraph is synchronous: bump the generation, rm the
  // file, drop the cache). If the generation moved while we were writing, our save just resurrected the
  // file the clear removed — delete it again and skip caching so the wipe stands. (bundle.js keeps its
  // check-and-cache in one synchronous block; save here is unavoidably async, so we re-validate after it.)
  if ((_generation.get(workspaceId) || 0) !== myGen) {
    try { fs.rmSync(filePath(workspaceId), { force: true }); } catch { /* best-effort — the wipe wins */ }
    _merged.delete(workspaceId);
    return { status: 'aborted' };
  }
  // Precompute the merged view now (off the request path) and cache it against the just-written file's mtime,
  // so the next query is a pure cache hit. Read the mtime synchronously and do the final generation check
  // immediately before cachePut, with NO await between them, so a synchronous clearGraph cannot interleave
  // here and leave a stale entry cached against a mtime that matches a since-deleted file.
  const graph = await buildMerged(store.docs);
  let mt = 0; try { mt = fs.statSync(filePath(workspaceId)).mtimeMs; } catch { /* file gone — leave mt 0 */ }
  if ((_generation.get(workspaceId) || 0) !== myGen) {
    try { fs.rmSync(filePath(workspaceId), { force: true }); } catch { /* best-effort */ }
    _merged.delete(workspaceId);
    return { status: 'aborted' };
  }
  cachePut(workspaceId, mt, graph);
  return { status: 'ok', extracted, total, capped, ...summarize(graph) };
};

// Clear a workspace's graph (called when its index is wiped/rebuilt). Bumps the generation so any build
// that is mid-flight cannot write its now-stale store back, and evicts the in-flight slot so the next
// build starts fresh against the rebuilt corpus instead of coalescing onto the stale one.
const clearGraph = (workspaceId) => {
  _generation.set(workspaceId, (_generation.get(workspaceId) || 0) + 1);
  _building.delete(workspaceId);
  try { fs.rmSync(filePath(workspaceId), { force: true }); } catch {}
  _merged.delete(workspaceId);
};

module.exports = {
  GRAPH_VERSION, buildMerged, summarize, vizSubgraph, getGraph, buildGraph, clearGraph, contentHash,
  _resetCache: () => { _merged.clear(); _building.clear(); _generation.clear(); },
};
