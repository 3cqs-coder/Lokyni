'use strict';
// Entity co-occurrence graph for multi-hop "how are X and Y related" retrieval.
//
// The graph is derived lazily from the in-memory parentMap — nodes are entities (from the
// pure-JS extractor), edges are entities that co-occur in the same document — so it needs NO
// indexing-pipeline changes and NO on-disk store: it is built on first use and cached until
// the corpus changes. Its job is recall, not answering: for a question that names two or more
// entities, it finds the entities that BRIDGE them (co-occur with several of them) and hands
// those names back as an extra dense query, so a document that connects X and Y through a
// third entity — which a literal X-and-Y search would miss — is pulled into the candidate set
// and fused like any other recall source. The model still answers only from real passages.

const { extractEntities } = require('./entities');
const { INDEX_HEAD_CHARS } = require('./constants');

// Bounded so a huge corpus can't blow memory or build time.
const MAX_DOC_CHARS = INDEX_HEAD_CHARS;   // scan the same head of each document as BM25/IDF
const ENTITIES_PER_DOC = 20;
const MAX_NODES = 20000;
// Also cap how many documents the build scans, not just the node count. A very large corpus with few
// DISTINCT entities never trips the node cap, so without this the first bridge query after each re-index
// would scan every document. The build is cached per index generation and yields the event loop, so this
// only bounds the one-time build cost; the graph over the first slice is representative enough for bridging.
const MAX_DOCS_SCANNED = 25000;
// Yield to the event loop every this-many documents during a build, so constructing the graph
// over a large corpus (an inherently CPU-bound, whole-corpus scan) never blocks the server:
// the realtime status heartbeat, concurrent queries, and API/MCP calls all stay responsive.
const YIELD_EVERY = 200;
// Also yield on a CHARACTER budget, not only a document count: each document runs a synchronous
// entity-extraction pass over up to MAX_DOC_CHARS, so a corpus of large documents could process several MB of
// text between doc-count yields and stall the loop. Yield whenever this many characters have been scanned.
const YIELD_CHAR_BUDGET = 1_000_000;

// A small keyed cache (workspace fingerprint → graph). Keyed rather than single-slot so the
// API path, which may query different workspaces in turn, doesn't thrash-rebuild — and, more
// importantly, so one workspace's graph is never served for another (the fingerprint includes
// the workspace id). Capped to a few entries, evicted least-recently-used.
const _cache = new Map();
// Builds in flight, keyed by the same fingerprint, so two queries that race after a re-index
// share ONE build instead of each scanning the whole corpus.
const _building = new Map();
const MAX_CACHED = 4;
// Fingerprint MUST identify the workspace AND its index generation. Using the bundle's own
// workspaceId + lastIndexedAt makes it correct for both the active workspace (idx === state)
// and a background bundle for a different workspace (the API path); the global state fields are
// only a last-resort fallback. Without the workspace id, two same-size workspaces collided.
const fingerprintOf = (idx) => {
  const state = require('../state');
  const size = idx && idx.parentMap ? idx.parentMap.size : 0;
  const ws = (idx && idx.workspaceId) || state.workspaceId || 'default';
  const at = (idx && idx.lastIndexedAt) ?? state.lastIndexedAt ?? 0;
  return `${ws}:${size}:${at}`;
};

// Scan the corpus into { nodes, edges, tokenIndex }, yielding to the event loop periodically
// so the build never blocks the server. tokenIndex maps a single lowercase token → the set of
// node keys containing it, so query-entity matching is O(1) per token instead of a full linear
// scan of every node key on each query.
const buildGraph = async (idx) => {
  const nodes = new Map();
  const edges = new Map();
  const tokenIndex = new Map();
  const addEdge = (a, b) => {
    if (a === b) return;
    if (!edges.has(a)) edges.set(a, new Map());
    edges.get(a).set(b, (edges.get(a).get(b) || 0) + 1);
  };
  try {
    let processed = 0, charsSinceYield = 0;
    for (const [docId, entry] of (idx.parentMap || new Map())) {
      if (nodes.size > MAX_NODES || processed >= MAX_DOCS_SCANNED) break;
      const content = entry && entry.content;
      if (!content) continue;
      const slice = content.slice(0, MAX_DOC_CHARS);
      charsSinceYield += slice.length;
      const ents = extractEntities(slice, { max: ENTITIES_PER_DOC });
      for (const e of ents) {
        let node = nodes.get(e.key);
        if (!node) {
          node = { name: e.name, docs: new Set() };
          nodes.set(e.key, node);
          for (const tok of e.key.split(' ')) {
            if (!tok) continue;
            if (!tokenIndex.has(tok)) tokenIndex.set(tok, new Set());
            tokenIndex.get(tok).add(e.key);
          }
        }
        node.docs.add(docId);
      }
      // Co-occurrence edges between every pair of this document's entities.
      for (let i = 0; i < ents.length; i++) {
        for (let j = i + 1; j < ents.length; j++) { addEdge(ents[i].key, ents[j].key); addEdge(ents[j].key, ents[i].key); }
      }
      if (++processed % YIELD_EVERY === 0 || charsSinceYield >= YIELD_CHAR_BUDGET) {
        charsSinceYield = 0;
        await new Promise((r) => setImmediate(r));
      }
    }
  } catch { /* best-effort: an empty graph simply yields no bridge */ }
  return { nodes, edges, tokenIndex };
};

// Return the cached graph, or build it once (deduping concurrent builds for the same workspace
// generation). Async so the whole-corpus scan can yield the event loop. On a cache hit the
// entry is moved to the most-recently-used end so a busy workspace isn't evicted ahead of an
// idle one. A build failure yields an empty graph (no bridge), never a rejection.
const getGraph = async (idx) => {
  const fp = fingerprintOf(idx);
  const cached = _cache.get(fp);
  if (cached) { _cache.delete(fp); _cache.set(fp, cached); return cached; }   // LRU touch
  const inflight = _building.get(fp);
  if (inflight) return inflight;
  const promise = buildGraph(idx)
    .then((graph) => {
      _cache.set(fp, graph);
      if (_cache.size > MAX_CACHED) _cache.delete(_cache.keys().next().value);   // evict LRU
      _building.delete(fp);
      return graph;
    })
    .catch(() => {
      _building.delete(fp);
      return { nodes: new Map(), edges: new Map(), tokenIndex: new Map() };
    });
  _building.set(fp, promise);
  return promise;
};

// Which of a query's entities are known to the graph. Matches by exact key, then via the token
// index (so "Acme" matches "Acme Corporation") — O(1) per query token, no full node scan.
const matchQueryEntities = (query, graph) => {
  const out = [];
  for (const e of extractEntities(query, { max: 8 })) {
    if (graph.nodes.has(e.key)) { out.push(e.key); continue; }
    // Single-token query entity: look it up in the token index and take the shortest node key
    // that contains it (the most specific match), preferring an exact single-token node.
    if (!e.key.includes(' ')) {
      const cands = graph.tokenIndex && graph.tokenIndex.get(e.key);
      if (cands && cands.size) {
        const hit = [...cands].sort((a, b) => a.length - b.length)[0];
        if (hit) out.push(hit);
      }
    }
  }
  return [...new Set(out)];
};

// Given the query's seed entities and a graph of the shape { nodes, edges }, find the entities that
// BRIDGE the seeds (link two or more of them) and the documents that carry those connections. Pure and
// graph-agnostic, so it serves BOTH the lightweight co-occurrence graph here and the LLM-extracted
// knowledge graph (lib/graphstore.js), which share this shape — one traversal, no duplication. `hops`
// 1 finds entities directly between the seeds; 2 also follows a two-step path (seed → m1 → m2 → seed),
// each seed's neighborhood capped so the pairwise scan stays bounded on a dense graph. Returns
// { bridgeKeys, docIds } (docIds capped), empty when nothing bridges the seeds.
const bridgeFromSeeds = (seeds, graph, hops = 1) => {
  const seedSet = new Set(seeds);
  const bridgeScore = new Map();
  const credit = (key, links, weight) => {
    if (seedSet.has(key)) return;
    const prev = bridgeScore.get(key) || { links: 0, weight: 0 };
    prev.links += links; prev.weight += weight;
    bridgeScore.set(key, prev);
  };
  for (const s of seeds) {
    const nbrs = graph.edges.get(s);
    if (!nbrs) continue;
    for (const [nb, w] of nbrs) credit(nb, 1, w);
  }
  if (hops >= 2 && seeds.length >= 2) {
    const NBR_CAP = 30;
    const topNbrs = (s) => {
      const mm = graph.edges.get(s);
      if (!mm) return [];
      return [...mm.entries()].filter(([k]) => !seedSet.has(k)).sort((a, b) => b[1] - a[1]).slice(0, NBR_CAP);
    };
    const nbrOf = seeds.map((s) => topNbrs(s));
    for (let i = 0; i < seeds.length; i++) {
      for (let j = i + 1; j < seeds.length; j++) {
        for (const [m1, w1] of nbrOf[i]) {
          const m1edges = graph.edges.get(m1);
          if (!m1edges) continue;
          for (const [m2, w2] of nbrOf[j]) {
            if (m1 === m2) continue;                    // m1 already links both seeds — the 1-hop case
            const link = m1edges.get(m2);
            if (link) { credit(m1, 1, w1 + link); credit(m2, 1, w2 + link); }
          }
        }
      }
    }
  }
  const bridgeKeys = [...bridgeScore.entries()]
    .filter(([, v]) => v.links >= 2)                    // connects at least two seeds
    .sort((a, b) => (b[1].links - a[1].links) || (b[1].weight - a[1].weight))
    .slice(0, 4)
    .map(([k]) => k);
  const docIds = new Set();
  for (const k of [...seeds, ...bridgeKeys]) {
    const node = graph.nodes.get(k);
    if (node && node.docs) for (const d of node.docs) { docIds.add(d); if (docIds.size >= 12) break; }
    if (docIds.size >= 12) break;
  }
  return { bridgeKeys, docIds: [...docIds] };
};

// Build an extra dense query that names the entities BRIDGING the query's entities. Returns a
// short string, or null when the question doesn't name at least two known entities (so the
// graph stays out of the way of ordinary questions). Best-effort and never throws.
const bridgeQuery = async (query, idx) => {
  try {
    const graph = await getGraph(idx);
    if (!graph.nodes.size) return null;
    const seeds = matchQueryEntities(query, graph);
    if (seeds.length < 2) return null;   // need a relationship between 2+ known entities

    const hops = require('../config').GRAPH_HOPS;   // config already clamps this to [1,3]
    const { bridgeKeys, docIds } = bridgeFromSeeds(seeds, graph, hops);
    // Only worth an extra search if the graph adds bridging terms the query didn't already name.
    if (!bridgeKeys.length) return null;

    const names = (keys) => keys.map(k => graph.nodes.get(k)?.name).filter(Boolean);
    // The documents that carry the seed/bridge entities are exempted by the caller from the co-source
    // keyword gates (a bridge document is relevant by ENTITY, not by sharing the query's keywords).
    return { query: [...names(seeds), ...names(bridgeKeys)].join(' '), docIds };
  } catch { return null; }
};

module.exports = { getGraph, bridgeQuery, matchQueryEntities, bridgeFromSeeds, _resetCache: () => { _cache.clear(); _building.clear(); } };
