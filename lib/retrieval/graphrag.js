'use strict';
// Query-time retrieval over the LLM-extracted knowledge graph (lib/graphstore.js). For a question that
// names two or more known entities, it finds the entities and relationships that CONNECT them and hands
// back an extra dense query (their names plus the model's short relationship descriptions) and the
// documents that carry those connections — so a document linking the named things through a described
// relationship is pulled into the candidate set even when a literal keyword search would miss it.
//
// It reuses the exact query-entity matching and bridge traversal the lightweight co-occurrence graph
// uses (the graphs share one shape), so there is a single traversal code path. Best-effort and off the
// hot path unless enabled: any failure returns null and retrieval proceeds unchanged.

// Build the extra dense query + connecting documents from the knowledge graph, or null when the graph is
// empty or the question doesn't name at least two known entities. Never throws.
const bridge = async (query, idx) => {
  try {
    if (!require('../config').useGraphRag) return null;
    const store = require('../graphstore');
    const eg = require('./entitygraph');
    const workspaceId = (idx && idx.workspaceId) || require('../state').workspaceId || 'default';
    const graph = await store.getGraph(workspaceId);
    if (!graph || !graph.nodes.size) return null;

    const seeds = eg.matchQueryEntities(query, graph);
    if (seeds.length < 2) return null;
    const hops = require('../config').GRAPH_HOPS;   // config already clamps this to [1,3]
    const { bridgeKeys, docIds } = eg.bridgeFromSeeds(seeds, graph, hops);
    if (!bridgeKeys.length) return null;

    // The extra query names the seed and bridge entities and folds in the model's short descriptions of
    // them — the semantic terms the free co-occurrence graph can't provide, which is the whole point of
    // the LLM graph. Deduped and length-bounded so it stays a focused recall probe.
    const parts = [];
    for (const k of [...seeds, ...bridgeKeys]) {
      const node = graph.nodes.get(k);
      if (!node) continue;
      if (node.name) parts.push(node.name);
      if (node.description) parts.push(node.description);
    }
    const q = [...new Set(parts.join(' ').split(/\s+/).filter(Boolean))].join(' ').slice(0, 400);
    if (!q) return null;
    return { query: q, docIds };
  } catch { return null; }
};

// True when the query names at least ONE of the corpus's own knowledge-graph entities. A single named
// entity is not enough to BRIDGE (that needs two), but it proves the question is about something the
// documents actually contain — so the relevance gate must not decline it as out-of-corpus (the exact
// failure when a user clicks an entity in the mind-map and asks "Tell me about <entity>").
//
// This matches the graph's actual node NAMES against the query, NOT bridge()'s matchQueryEntities: the
// latter runs the capitalized-phrase entity extractor, which ignores a lone word, so a one-word node like
// "Bitcoin" would never match. The LLM knowledge graph routinely has single-word nodes, so we match node
// names directly (word-bounded, up to a 3-word phrase) over the query's tokens. A set of lowercased names is
// built once and cached on the graph object (getGraph caches the graph), so this is O(query tokens) per call
// with no model call. Never throws.
// Build (once, cached on the graph) the name-match index the single-entity matchers share: a normalized
// name→node map, the normalize fn, the longest name's word count, and the unspaced-script names. Returns null
// when the graph is empty. Language-agnostic: casefold, FOLD diacritics (Óscar→oscar), keep letters/digits of
// ANY script (the old [^a-z0-9] wiped CJK/Cyrillic/Arabic/Greek/accented-Latin names), everything else → space.
const nameMatchMeta = (graph) => {
  if (!graph || !graph.nodes || !graph.nodes.size) return null;
  let meta = graph._nameMatch;
  if (!meta) {
    const norm = (s) => String(s || '')
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ').trim();
    const byName = new Map();   // normalized name → node (first wins; a later same-name node merges its docs)
    const noSpace = [];         // single-run names in a script WITHOUT word spacing (CJK, Thai, …) — matched by substring
    let maxWords = 1;
    for (const node of graph.nodes.values()) {
      const n = norm((node && node.name) || '');
      if (n.length < 2) continue;   // skip trivially short names (initials, stray tokens)
      if (!byName.has(n)) byName.set(n, node);
      const wc = n.split(' ').length;
      if (wc > maxWords) maxWords = wc;
      if (wc === 1 && /[^\p{Script=Latin}\p{N}]/u.test(n)) noSpace.push(n);
    }
    meta = { byName, noSpace, norm, maxWords: Math.min(maxWords, 8) };   // cap window length (safety on a weird name)
    try { Object.defineProperty(graph, '_nameMatch', { value: meta, enumerable: false }); } catch { graph._nameMatch = meta; }
  }
  return meta;
};

// Find the graph node the query names, or null. Any-length window match (works for a name of ANY word count —
// "Óscar Bruno de Prado Rodríguez" — and any space-delimited script) plus a substring test for unspaced scripts.
const matchEntityNode = (query, graph) => {
  const meta = nameMatchMeta(graph);
  if (!meta || !meta.byName.size) return null;
  const { byName, noSpace, norm, maxWords } = meta;
  const qn = norm(query);
  if (!qn) return null;
  const toks = qn.split(' ');
  for (let len = 1; len <= maxWords; len++) {
    for (let i = 0; i + len <= toks.length; i++) {
      const hit = byName.get(toks.slice(i, i + len).join(' '));
      if (hit) return hit;
    }
  }
  for (const name of noSpace) { if (qn.includes(name)) return byName.get(name); }
  return null;
};

// True when the query names at least ONE of the corpus's own knowledge-graph entities — the signal the
// relevance gate uses so a "tell me about <entity>" question (an entity clicked in the mind-map) isn't declined
// as out-of-corpus. See the long note above matchEntityNode's callers in search.js.
const namesEntity = async (query, idx) => {
  try {
    if (!require('../config').useGraphRag) return false;
    const store = require('../graphstore');
    const workspaceId = (idx && idx.workspaceId) || require('../state').workspaceId || 'default';
    const graph = await store.getGraph(workspaceId);
    return !!matchEntityNode(query, graph);
  } catch { return false; }
};

// A focused retrieval probe for a SINGLE named entity, the single-entity analogue of bridge(): when the query
// names one known graph entity, return a dense probe query (the entity's name + the model's short description —
// far better recall than the raw "tell me about X" question, whose "tell me about" noise and lone rare token
// can rank the entity's own document low or off the list) and the exact documents that entity was extracted
// from (so they are force-exempted from the keyword gates and pulled into the candidate set — fixing the
// mind-map miss where the entity's own document was never retrieved). Null when no single entity is named.
const entityProbe = async (query, idx) => {
  try {
    if (!require('../config').useGraphRag) return null;
    const store = require('../graphstore');
    const workspaceId = (idx && idx.workspaceId) || require('../state').workspaceId || 'default';
    const graph = await store.getGraph(workspaceId);
    const node = matchEntityNode(query, graph);
    if (!node || !node.name) return null;
    const probe = [node.name, node.description || ''].join(' ').trim().slice(0, 200) || node.name;
    const docIds = node.docs instanceof Set ? [...node.docs] : (Array.isArray(node.docs) ? node.docs : []);
    return { name: node.name, query: probe, docIds };
  } catch { return null; }
};

module.exports = { bridge, namesEntity, entityProbe };
