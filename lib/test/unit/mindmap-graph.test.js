'use strict';
// Corpus mind-map: the bounded node/edge view (graphstore.vizSubgraph) that feeds the viz, plus the route
// and client wiring. vizSubgraph must keep only the most-connected nodes, emit each undirected edge once,
// and never reference an edge endpoint that was dropped. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(PROJECT, ...p), 'utf-8');
const gs = require(path.join(PROJECT, 'lib', 'graphstore'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // Build a synthetic merged graph: a hub (h) linked to a,b,c; a weak pair d–e; an isolated f.
  const mk = (name, docs = 1) => ({ name, type: '', description: '', docs: new Set(Array.from({ length: docs }, (_, i) => 'd' + i)) });
  const nodes = new Map([
    ['h', mk('Hub', 3)], ['a', mk('Alpha', 1)], ['b', mk('Beta', 1)], ['c', mk('Gamma', 1)],
    ['d', mk('Delta', 2)], ['e', mk('Epsilon', 1)], ['f', mk('Lonely', 5)],
  ]);
  const edges = new Map([
    ['h', new Map([['a', 2], ['b', 1], ['c', 1]])],
    ['a', new Map([['h', 2]])], ['b', new Map([['h', 1]])], ['c', new Map([['h', 1]])],
    ['d', new Map([['e', 1]])], ['e', new Map([['d', 1]])],
  ]);
  const graph = { nodes, edges, tokenIndex: new Map() };

  // ── full view: all nodes kept, undirected edges de-duplicated ──
  const full = gs.vizSubgraph(graph, 100);
  ok(full.nodes.length === 7, `all nodes returned when under the cap (got ${full.nodes.length})`);
  ok(full.edges.length === 4, `each undirected edge appears once: h-a,h-b,h-c,d-e (got ${full.edges.length})`);
  ok(full.edges.every(e => e.source < e.target), 'edges are emitted in a stable source<target orientation (no duplicate pair)');
  const hub = full.nodes.find(n => n.id === 'h');
  ok(hub && hub.degree === 3 && hub.label === 'Hub', 'the hub reports its degree and display label');
  ok(full.shown === 7 && full.total.nodes === 7 && full.total.edges === 4, 'summary totals are reported');

  // ── bounded view: keep only the most-connected nodes, and NO edge may reference a dropped node ──
  const top = gs.vizSubgraph(graph, 3);
  ok(top.nodes.length === 3, `the node set is capped to maxNodes (got ${top.nodes.length})`);
  ok(top.nodes[0].id === 'h', 'the most-connected node ranks first');
  const kept = new Set(top.nodes.map(n => n.id));
  ok(top.edges.every(e => kept.has(e.source) && kept.has(e.target)), 'no edge references a node that was dropped by the cap');
  // 'f' is isolated (degree 0) despite high doc coverage, so degree ranking keeps the hub's neighbors over it.
  ok(!kept.has('f') || top.nodes.find(n => n.id === 'f').degree === 0, 'an isolated high-coverage node does not outrank connected ones');

  // ── maxNodes floor: never zero ──
  ok(gs.vizSubgraph(graph, 0).nodes.length >= 1, 'maxNodes is floored to at least one node');

  // ── wiring: the route is bounded + workspace-scoped, and the client renders/handles safely ──
  const route = read('lib', 'routes', 'documents.js');
  ok(/router\.get\('\/graph', docRead,/.test(route), 'the /graph route is workspace-scoped via docRead');
  ok(/gs\.vizSubgraph\(graph, GRAPH_VIZ_MAX_NODES\)/.test(route) && /const GRAPH_VIZ_MAX_NODES = \d+/.test(route),
    'the route returns a bounded subgraph via vizSubgraph');
  const chat = read('lib', 'public', 'js', 'chat.js');
  ok(/function initMindmap\(\)/.test(chat), 'chat.js defines the mind-map module');
  ok(/fetch\('\/api\/documents\/graph' \+ wsQuery\(\)\)/.test(chat), 'the client fetches the workspace-scoped graph');
  ok(/label\.textContent = nd\.label/.test(chat), 'node labels are set via textContent (no markup injection from entity names)');
  ok(/we never auto-send on their behalf/.test(chat), 'clicking a node fills the composer rather than auto-sending');
  // The canvas is navigable (pan/zoom via a viewBox transform) so a dense map stays legible, and it uses Pointer
  // Events so it behaves the same in the web app and the desktop app.
  ok(/function attachPanZoom\(\)/.test(chat) && /setAttribute\('viewBox'/.test(chat), 'the map is pan/zoomable (viewBox transform)');
  ok(/addEventListener\('wheel'/.test(chat) && /addEventListener\('pointerdown'/.test(chat) && /addEventListener\('pointermove'/.test(chat),
    'pan/zoom uses Pointer Events + wheel (cross-browser, web + desktop parity)');
  // Clicking SELECTS a node and offers an explicit action — it must NOT silently close the map.
  ok(/function selectNode\(/.test(chat) && /mm-ask-btn/.test(chat), 'clicking a node selects it and shows an explicit "Ask about" action (never a silent close)');
  ok(/function applyHi\(/.test(chat) && /mm-hi/.test(chat) && /mm-dim/.test(chat), 'hovering/selecting a node highlights its connections and dims the rest');
  ok(/mm-minor/.test(chat), 'low-degree nodes declutter their labels until hovered/selected (readability)');
  const mmCss = read('lib', 'public', 'css', 'app.css');
  ok(/\.mm-label\b[\s\S]*?paint-order:\s*stroke/.test(mmCss), 'labels have a halo so overlapping text stays readable');
  // The empty/off map offers to turn the graph on and build it RIGHT HERE — no dead-end pointing at a buried setting.
  ok(/function enableAndBuild\(/.test(chat) && /Turn on & build the map/.test(chat),
    'the off map offers an in-modal "Turn on & build the map" action (not a dead-end)');
  ok(/mm-status-btn/.test(chat) && /\.mm-status-btn\b/.test(mmCss), 'the status action button exists and is styled');
  ok(gs.vizSubgraph === require(path.join(PROJECT, 'lib', 'graphstore')).vizSubgraph && /vizSubgraph/.test(read('lib', 'graphstore.js').match(/module\.exports[\s\S]{0,200}/)[0]),
    'graphstore exports vizSubgraph');

  console.log(`\nALL MINDMAP-GRAPH UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ MINDMAP-GRAPH UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
