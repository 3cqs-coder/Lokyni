'use strict';
// Guards lib/public/js/graph-metrics.js — the ONE pure module the knowledge-graph map uses for the "most
// connected" ranking, the per-type legend counts, and the shortest path behind "explain this connection". The
// browser loads it as a <script> (window.LokyniGraphMetrics) and this test require()s it, so the ranking,
// counting, and pathfinding can't drift between what the map draws and what is verified. Synthetic, multi-lingual
// fixtures prove it is language-agnostic (ids and type strings are opaque). Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(PROJECT, 'lib', 'public', 'js', 'graph-metrics.js'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // Synthetic, multi-lingual graph: names and types in Latin, Cyrillic, Japanese — the module must not care.
  // Shape matches the map's: nodes {id,label,type,degree}, edges {source,target}.
  const nodes = [
    { id: 'a', label: 'Zylar',      type: 'person',   degree: 3 },
    { id: 'b', label: 'Мирославск', type: 'место',    degree: 2 },
    { id: 'c', label: '太郎',        type: 'person',   degree: 2 },
    { id: 'd', label: 'Qenith Co',  type: '組織',      degree: 1 },
    { id: 'e', label: 'Lone',       type: '',         degree: 0 },   // no links, no type
  ];
  const edges = [
    { source: 'a', target: 'b' },
    { source: 'a', target: 'c' },
    { source: 'c', target: 'd' },
    { source: 'a', target: 'a' },          // self-loop — ignored
    { source: 'a', target: 'ghost' },      // dangling (unknown endpoint) — ignored
  ];

  // ── adjacency: both endpoints must be known nodes; self-loops and dangling edges contribute nothing ──
  const adj = M.adjacency(nodes, edges);
  ok(adj.get('a').length === 2 && adj.get('a').indexOf('b') >= 0 && adj.get('a').indexOf('c') >= 0, 'a links to b and c (self-loop and dangling edge ignored)');
  ok(adj.get('e').length === 0, 'an unconnected node has no neighbors');

  // ── topHubs: ranked by the precomputed degree, degree>0 only, deterministic, limit-clamped ──
  const hubs = M.topHubs(nodes, edges, { limit: 3 });
  ok(hubs.length === 3 && hubs[0].id === 'a', 'the most-connected node ranks first');
  ok(!hubs.some(h => h.id === 'e'), 'a node with no links is never a hub (degree 0 excluded)');
  const tie = M.topHubs([{ id: 'y', degree: 2 }, { id: 'x', degree: 2 }], [], { limit: 5 });
  ok(tie[0].id === 'x' && tie[1].id === 'y', 'ties break deterministically by id, so every engine/run agrees');
  // No precomputed degree → falls back to the drawn degree from the edges.
  const drawnHubs = M.topHubs(nodes.map(n => ({ id: n.id, label: n.label })), edges, { limit: 2 });
  ok(drawnHubs[0].id === 'a' && drawnHubs[0].degree === 2, 'without a degree field it ranks by the drawn degree');

  // ── countByType: per-type counts desc, empty-type bucket, language-agnostic ──
  const byType = M.countByType(nodes);
  const asMap = Object.fromEntries(byType.map(r => [r.type, r.count]));
  ok(asMap['person'] === 2 && asMap['место'] === 1 && asMap['組織'] === 1 && asMap[''] === 1, 'counts each type (any script), empty type bucketed under ""');
  ok(byType[0].count >= byType[byType.length - 1].count, 'types are ordered by count, descending');

  // ── shortestPath: fewest hops, null when unreachable/unknown, a===b, deterministic ──
  ok(JSON.stringify(M.shortestPath(nodes, edges, 'b', 'd')) === JSON.stringify(['b', 'a', 'c', 'd']), 'finds the fewest-hops path across the graph');
  ok(M.shortestPath(nodes, edges, 'a', 'e') === null, 'returns null when there is no path (disconnected node)');
  ok(M.shortestPath(nodes, edges, 'a', 'ghost') === null, 'returns null for an unknown endpoint');
  ok(JSON.stringify(M.shortestPath(nodes, edges, 'a', 'a')) === JSON.stringify(['a']), 'a node connects to itself as a single-node path');

  // ── crash-proof / bounded: non-array and null inputs never throw ──
  ok(M.topHubs(null, null).length === 0 && M.countByType(undefined).length === 0 && M.shortestPath([], [], 'x', 'y') === null, 'malformed/empty inputs return empty results, never throw');
  ok(M.adjacency([null, { id: 'ok' }], [null, { source: 'ok', target: 'ok' }]).get('ok').length === 0, 'null nodes/edges and a self-only edge are handled without throwing');

  console.log('✓ graph-metrics: ranking, per-type counts, and shortest-path are pure, language-agnostic, and deterministic');
  console.log(`\nALL GRAPH-METRICS UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ GRAPH-METRICS UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
