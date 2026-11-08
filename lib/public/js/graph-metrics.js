/*
 * graph-metrics — shared, pure metrics + pathfinding for the knowledge-graph map.
 *
 * ONE implementation of the "most connected" ranking, the per-type counts (for the legend), and the shortest path
 * between two entities (for "explain this connection"), used BOTH by the browser map (it sets
 * window.LokyniGraphMetrics) and by the Node unit test (module.exports), so what the map draws and what is tested
 * can never drift. Pure, synchronous, dependency-free, bounded (hard ceilings so a pathological payload can't spin
 * or blow memory), and never throws — safe in any runtime.
 *
 * Language-agnostic: every function operates on node ids and opaque type strings, never on word content, so an
 * entity name or a type label in ANY language or script behaves identically. Cross-browser: plain loops, Map and
 * Set only — no regex, no lookbehind/named groups, no syntax an older Safari/WebKit lacks.
 *
 * Edge endpoints are read through srcKey/dstKey (default source/target, as the map serves them); only edges whose
 * BOTH endpoints are known nodes ever count or connect, so a dangling edge never invents a phantom node.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  else { root.LokyniGraphMetrics = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Defensive ceilings so a pathological payload can't spin or exhaust memory. The map caps at ~150 nodes, so
  // these never bite in practice; they only bound a hostile or corrupt graph.
  var MAX_NODES = 100000, MAX_EDGES = 200000;
  var asArray = function (v) { return Array.isArray(v) ? v : []; };

  // Undirected adjacency from the drawn graph: Map(nodeId -> [neighborId, …]). Only edges whose both endpoints are
  // known nodes are included; self-loops are ignored (they add no path and no visible link).
  function adjacency(nodes, edges, opts) {
    opts = opts || {};
    var idKey = opts.idKey || 'id', srcKey = opts.srcKey || 'source', dstKey = opts.dstKey || 'target';
    var adj = new Map();
    var na = asArray(nodes), nn = Math.min(na.length, MAX_NODES), i;
    for (i = 0; i < nn; i++) { var nd = na[i]; if (nd && nd[idKey] != null) adj.set(nd[idKey], []); }
    var ea = asArray(edges), ne = Math.min(ea.length, MAX_EDGES);
    for (i = 0; i < ne; i++) {
      var e = ea[i]; if (!e) continue;
      var a = e[srcKey], b = e[dstKey];
      if (a === b) continue;
      if (adj.has(a) && adj.has(b)) { adj.get(a).push(b); adj.get(b).push(a); }
    }
    return adj;
  }

  // Per-node link count within the drawn graph. Map(nodeId -> count).
  function degrees(nodes, edges, opts) {
    var adj = adjacency(nodes, edges, opts), deg = new Map();
    adj.forEach(function (nb, id) { deg.set(id, nb.length); });
    return deg;
  }

  // The most-connected nodes, descending, capped to opts.limit (clamped to [1,50]), degree>0 only. Prefers a
  // precomputed degree field (degreeKey, default 'degree' — the server computes the FULL-graph degree, which is
  // more meaningful than the drawn subgraph's) and falls back to the drawn degree when a node lacks one. Ties and
  // ordering are fully deterministic (by degree desc, then id) so every run and every engine agrees.
  function topHubs(nodes, edges, opts) {
    opts = opts || {};
    var limit = Math.max(1, Math.min(50, Math.floor(Number(opts.limit) || 8)));
    var idKey = opts.idKey || 'id', degKey = opts.degreeKey || 'degree';
    var drawn = null;
    var na = asArray(nodes), nn = Math.min(na.length, MAX_NODES), rows = [], i;
    for (i = 0; i < nn; i++) {
      var nd = na[i]; if (!nd || nd[idKey] == null) continue;
      var d = (typeof nd[degKey] === 'number') ? nd[degKey]
        : ((drawn || (drawn = degrees(nodes, edges, opts))).get(nd[idKey]) || 0);
      if (d > 0) rows.push({ id: nd[idKey], degree: d, node: nd });
    }
    rows.sort(function (x, y) { return (y.degree - x.degree) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0); });
    return rows.slice(0, limit);
  }

  // Per-type counts, descending by count (ties by type, stable). A null/empty type buckets under '' — the caller
  // decides how to label that. Type strings are opaque (any language), so this is language-agnostic.
  function countByType(nodes, opts) {
    opts = opts || {};
    var typeKey = opts.typeKey || 'type';
    var counts = new Map();
    var na = asArray(nodes), nn = Math.min(na.length, MAX_NODES), i;
    for (i = 0; i < nn; i++) {
      var nd = na[i]; if (!nd) continue;
      var t = nd[typeKey]; t = (t == null) ? '' : String(t);
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    var rows = [];
    counts.forEach(function (count, type) { rows.push({ type: type, count: count }); });
    rows.sort(function (x, y) { return (y.count - x.count) || (x.type < y.type ? -1 : x.type > y.type ? 1 : 0); });
    return rows;
  }

  // Shortest path (fewest hops) between two node ids via breadth-first search over the undirected drawn graph.
  // Returns the array of node ids from aId to bId inclusive, or null if either endpoint is unknown or there is no
  // path. Bounded by the node cap (each node is visited once), so it always terminates. Deterministic: neighbors
  // are explored in insertion order.
  function shortestPath(nodes, edges, aId, bId, opts) {
    if (aId == null || bId == null) return null;
    var adj = adjacency(nodes, edges, opts);
    if (!adj.has(aId) || !adj.has(bId)) return null;
    if (aId === bId) return [aId];
    var prev = new Map(), seen = new Set(), queue = [aId], head = 0;
    seen.add(aId);
    while (head < queue.length) {
      var cur = queue[head++];
      var nb = adj.get(cur), i;
      for (i = 0; i < nb.length; i++) {
        var next = nb[i];
        if (seen.has(next)) continue;
        seen.add(next); prev.set(next, cur);
        if (next === bId) {
          var path = [bId], p = bId;
          while (p !== aId) { p = prev.get(p); path.push(p); }
          path.reverse();
          return path;
        }
        queue.push(next);
      }
    }
    return null;
  }

  return { adjacency: adjacency, degrees: degrees, topHubs: topHubs, countByType: countByType, shortestPath: shortestPath };
});
