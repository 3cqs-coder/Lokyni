'use strict';
// Unit tests for the entity graph (lib/retrieval/entities.js + entitygraph.js). Pure JS, no
// model and no index — a fake parentMap drives the graph. Covers: entity extraction keeps
// real proper-noun phrases and acronyms and does not bleed across sentence boundaries or
// list conjunctions; and bridgeQuery surfaces the entity that CONNECTS two named entities
// (the multi-hop win) while staying null for one-entity or entity-free questions.
// Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { extractEntities } = require(path.join(PROJECT, 'lib', 'retrieval', 'entities'));
const eg = require(path.join(PROJECT, 'lib', 'retrieval', 'entitygraph'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };
const names = (t) => extractEntities(t).map(e => e.name);

(async () => {
try {
  // ── extraction: synthetic entities, no cross-boundary bleed ──
  {
    const ns = names('Acme Corporation partnered with Project Titan. Globex Industries and ZORP joined. Bank of Northwind hosted.');
    ok(ns.includes('Acme Corporation'), 'multi-word company kept');
    ok(ns.includes('Project Titan'), 'sentence boundary splits Project Titan from the next entity');
    ok(ns.includes('Globex Industries'), 'conjunction splits Globex Industries from ZORP');
    ok(ns.includes('ZORP'), 'acronym kept as its own entity');

    // Cased scripts beyond ASCII: accented Latin, Cyrillic, and Greek names are real entities too.
    const intl = names('Óscar Rojas presentó el informe. Проект Вектор объединяет данные. Ορίων Σταθμός συνδέεται.');
    ok(intl.includes('Óscar Rojas'), 'accented Latin name kept');
    ok(intl.includes('Проект Вектор'), 'Cyrillic name kept');
    ok(intl.includes('Ορίων Σταθμός'), 'Greek name kept');
    ok(ns.includes('Bank of Northwind'), 'within-name connector "of" is kept');
    ok(!ns.some(n => /Titan.*Globex|Globex.*ZORP/.test(n)), 'entities never merge across a boundary or conjunction');
    console.log('✓ entitygraph: extraction keeps synthetic entities without cross-boundary bleed');
  }

  // ── a lone sentence-initial capital is not an entity; a repeated one is ──
  {
    const ns = names('The report is ready. The report is thorough. Ridgeway appears once.');
    ok(!ns.includes('The'), 'sentence-initial "The" is not an entity');
    ok(!ns.includes('Ridgeway'), 'a single-occurrence lone capital is not promoted');
    ok(names('Ridgeway spoke. Ridgeway left. Ridgeway returned.').includes('Ridgeway'), 'a repeated lone capital IS an entity');
    console.log('✓ entitygraph: lone capitals gated by repetition');
  }

  // ── bridgeQuery: finds the connecting entity across documents ──
  {
    const parentMap = new Map([
      ['d1', { content: 'Acme Corporation partnered with Project Titan to expand operations across regions.' }],
      ['d2', { content: 'Project Titan was later acquired by Globex Industries after a long review.' }],
      ['d3', { content: 'The quarterly picnic was rained out and rescheduled to a sunny afternoon.' }],
    ]);
    require(path.join(PROJECT, 'lib', 'state')).lastIndexedAt = Date.now();
    const idx = { parentMap };
    eg._resetCache();

    const bridge = await eg.bridgeQuery('How are Acme Corporation and Globex Industries related?', idx);
    ok(bridge && typeof bridge.query === 'string' && /Project Titan/i.test(bridge.query), 'the bridging entity (Project Titan) is surfaced in the bridge query');
    ok(/Acme Corporation/i.test(bridge.query) && /Globex Industries/i.test(bridge.query), 'the query entities are included too');
    ok(Array.isArray(bridge.docIds) && bridge.docIds.includes('d1') && bridge.docIds.includes('d2'), 'the connecting documents are returned for gate exemption');
    ok(!bridge.docIds.includes('d3'), 'the unrelated document is not included');
    eq(await eg.bridgeQuery('Tell me about Acme Corporation', idx), null, 'one named entity -> no bridge');
    eq(await eg.bridgeQuery('what is the weather today', idx), null, 'no named entities -> no bridge');
    console.log('✓ entitygraph: bridgeQuery surfaces the connecting entity, else null');
  }

  // ── multi-hop (GRAPH_HOPS >= 2): a chained relationship with no direct bridge ──
  {
    // Acme — Titan — Orion — Globex: the two named entities connect only through a two-step chain, so
    // a one-hop bridge (a single entity adjacent to BOTH) does not exist.
    const parentMap = new Map([
      ['d1', { content: 'Acme Corporation worked closely with Project Titan on a joint venture.' }],
      ['d2', { content: 'Project Titan and Orion Labs collaborated on the same research effort.' }],
      ['d3', { content: 'Orion Labs was funded by Globex Industries in an early round.' }],
    ]);
    require(path.join(PROJECT, 'lib', 'state')).lastIndexedAt = Date.now();
    const idx = { parentMap };
    const cfg = require(path.join(PROJECT, 'lib', 'config'));
    const q = 'How are Acme Corporation and Globex Industries related?';

    cfg.GRAPH_HOPS = 1; eg._resetCache();
    eq(await eg.bridgeQuery(q, idx), null, 'one hop: a chained relationship with no direct bridge yields nothing');

    cfg.GRAPH_HOPS = 2; eg._resetCache();
    const two = await eg.bridgeQuery(q, idx);
    ok(two && /Project Titan/i.test(two.query) && /Orion Labs/i.test(two.query), 'two hops: the chain intermediates (Project Titan, Orion Labs) are surfaced');
    ok(Array.isArray(two.docIds) && two.docIds.includes('d1') && two.docIds.includes('d2') && two.docIds.includes('d3'),
      'two hops: every document along the chain is returned for gate exemption');
    cfg.GRAPH_HOPS = 1;   // restore the default for any later test in this process
    console.log('✓ entitygraph: multi-hop traversal surfaces a chained relationship (opt-in)');
  }

  // ── cross-workspace isolation: two same-size bundles must not share a cached graph ──
  {
    require(path.join(PROJECT, 'lib', 'state')).lastIndexedAt = 5000;   // same global stamp for both
    const idxA = { workspaceId: 'wsA', lastIndexedAt: 5000, parentMap: new Map([
      ['a1', { content: 'Alpha Systems shipped the Orion platform this quarter.' }],
      ['a2', { content: 'Orion platform adoption grew across Alpha Systems teams.' }],
    ]) };
    const idxB = { workspaceId: 'wsB', lastIndexedAt: 5000, parentMap: new Map([
      ['b1', { content: 'Beta Industries launched the Nova service last month.' }],
      ['b2', { content: 'Nova service uptime improved for Beta Industries clients.' }],
    ]) };
    const gA = await eg.getGraph(idxA);
    const gB = await eg.getGraph(idxB);
    ok(gA.nodes.has('alpha systems') && !gA.nodes.has('beta industries'), 'workspace A graph has only A entities');
    ok(gB.nodes.has('beta industries') && !gB.nodes.has('alpha systems'), 'workspace B graph has only B entities (no cross-workspace bleed despite equal size + global stamp)');
    console.log('✓ entitygraph: same-size workspaces get isolated graphs (fingerprint includes workspace id)');
  }

  console.log(`\nALL ENTITYGRAPH UNIT TESTS PASSED (${checks} checks)`);
  process.exitCode = 0;
} catch (e) {
  console.error('\n✗ ENTITYGRAPH UNIT TEST FAILED:', e && e.message);
  process.exitCode = 1;
}
})();
