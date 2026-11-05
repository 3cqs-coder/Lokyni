'use strict';
// Unit tests for the LLM knowledge graph: the pure extraction normalizer (lib/indexing/graphextract.js),
// the pure per-document → merged-graph builder plus mtime-keyed cache and clear (lib/graphstore.js), and
// the query-time bridge (lib/retrieval/graphrag.js). No model and no index — hand-built extractions and an
// on-disk store drive everything, so the test is fast and deterministic. Covers: the normalizer caps and
// drops malformed items; the merge unions entities by normalized key, concatenates and caps descriptions,
// makes relationships bidirectional, and tracks source documents; getGraph caches by file mtime and
// clearGraph removes the store; and the bridge is off unless enabled, needs two known entities, and
// surfaces the connecting entity plus its documents while failing open on a missing graph.
// Run: `npm run test:unit`.

const path = require('path'), assert = require('assert'), fs = require('fs'), os = require('os');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const graphextract = require(path.join(PROJECT, 'lib', 'indexing', 'graphextract'));
const store = require(path.join(PROJECT, 'lib', 'graphstore'));
const graphrag = require(path.join(PROJECT, 'lib', 'retrieval', 'graphrag'));
const cfg = require(path.join(PROJECT, 'lib', 'config'));
const workspaces = require(path.join(PROJECT, 'lib', 'workspaces'));
const ndjson = require(path.join(PROJECT, 'lib', 'indexing', 'ndjsonmapstore'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

// The reserved NDJSON version record graphstore writes as the first line. Mirrors graphstore's private
// VERSION_KEY; a source-drift guard below fails loudly if that literal ever changes out from under this test.
const VERSION_KEY = '\u0000graph-version';
// Write a knowledge-graph store to disk for a workspace as streaming NDJSON, exactly as graphstore persists it
// (a version record first, then one record per document, with the completeness sentinel).
const writeStore = async (dataDir, wsId, docs) => {
  workspaces.ensureWorkspace(dataDir, wsId);
  const fp = path.join(workspaces.cacheDirFor(dataDir, wsId), 'knowledge-graph.json');
  const map = new Map([[VERSION_KEY, store.GRAPH_VERSION]]);
  for (const [k, v] of Object.entries(docs)) map.set(k, v);
  await ndjson.writeMap(fp, map);
  return fp;
};

(async () => {
try {
  // ── normalizeExtraction: coerce, cap, drop malformed ──
  {
    const n = graphextract.normalizeExtraction({
      entities: [
        { name: 'Acme', type: 'organization', description: 'a company' },
        { name: '', type: 'x', description: 'no name -> dropped' },
        { name: 'X'.repeat(200), type: 'Y'.repeat(80), description: 'Z'.repeat(400) },
      ],
      relations: [
        { source: 'Acme', target: 'Globex', description: 'acquired', keywords: ['deal', 'merger'] },
        { source: 'Solo', target: 'Solo', description: 'self -> dropped' },
        { source: 'A', target: '', description: 'missing target -> dropped' },
      ],
    });
    eq(n.entities.length, 2, 'the nameless entity is dropped, the two valid ones kept');
    eq(n.entities[1].name.length, 120, 'an over-long entity name is capped to 120');
    eq(n.entities[1].type.length, 40, 'an over-long type is capped to 40');
    eq(n.entities[1].description.length, 300, 'an over-long description is capped to 300');
    eq(n.relations.length, 1, 'the self-relation and the target-less relation are dropped');
    ok(n.relations[0].keywords.length === 2, 'keywords are preserved');
    // Caps at 25 each.
    const big = graphextract.normalizeExtraction({
      entities: Array.from({ length: 40 }, (_, i) => ({ name: `E${i}` })),
      relations: Array.from({ length: 40 }, (_, i) => ({ source: `E${i}`, target: `E${i + 1}` })),
    });
    eq(big.entities.length, 25, 'entities are capped at 25');
    eq(big.relations.length, 25, 'relations are capped at 25');
    // Garbage in -> empty out, never throws.
    const empty = graphextract.normalizeExtraction(null);
    ok(empty.entities.length === 0 && empty.relations.length === 0, 'null input yields an empty extraction');
    console.log('✓ graphextract: normalizeExtraction caps, coerces, and drops malformed items');
  }

  // ── buildMerged: union by key, bidirectional edges, doc tracking, description cap ──
  {
    const merged = await store.buildMerged({
      d1: {
        entities: [{ name: 'Acme Corporation', type: 'organization', description: 'a large firm' }],
        relations: [{ source: 'Acme Corporation', target: 'Project Titan', description: 'ran' }],
      },
      d2: {
        // Same entity under a different surface form -> must merge to one node by normalized key.
        entities: [{ name: 'ACME  corporation', type: 'organization', description: 'headquartered downtown' }],
        relations: [{ source: 'Project Titan', target: 'Globex Industries', description: 'acquired by' }],
      },
    });
    const { normKey } = require(path.join(PROJECT, 'lib', 'retrieval', 'entities'));
    const acme = merged.nodes.get(normKey('Acme Corporation'));
    ok(acme, 'the merged node exists under the normalized key');
    ok(acme.docs.has('d1') && acme.docs.has('d2'), 'both source documents are tracked on the merged node');
    ok(/large firm/.test(acme.description) && /downtown/.test(acme.description), 'descriptions from both documents are concatenated');
    // Edges are bidirectional.
    const titan = normKey('Project Titan'), globex = normKey('Globex Industries');
    ok(merged.edges.get(normKey('Acme Corporation')).has(titan), 'Acme -> Titan edge exists');
    ok(merged.edges.get(titan).has(normKey('Acme Corporation')), 'Titan -> Acme reverse edge exists');
    ok(merged.edges.get(titan).has(globex) && merged.edges.get(globex).has(titan), 'Titan <-> Globex edge is bidirectional');
    // Token index lets a single-token query find a multi-word node.
    ok(merged.tokenIndex.get('acme') && merged.tokenIndex.get('acme').has(normKey('Acme Corporation')), 'the token index maps "acme" to the node');
    console.log('✓ graphstore: buildMerged unions entities, tracks docs, and builds a bidirectional graph');
  }

  // ── buildMerged fails soft on a corrupt store (non-string fields) instead of throwing ──
  {
    const merged = await store.buildMerged({
      bad: {
        entities: [{ name: 12345, type: 7, description: null }, { name: 'Valid Co', type: 'org', description: 'ok' }],
        relations: [{ source: 'Valid Co', target: { nope: 1 }, description: 'x' }],
      },
    });
    const { normKey } = require(path.join(PROJECT, 'lib', 'retrieval', 'entities'));
    ok(merged.nodes.get(normKey('Valid Co')), 'a valid node is still built when a sibling field is non-string');
    ok(merged.nodes.get(normKey('12345')), 'a numeric name is coerced to a string, not a crash');
    console.log('✓ graphstore: buildMerged coerces non-string fields and never throws on a corrupt store');
  }

  // ── getGraph caches by mtime, clearGraph removes the store ──
  {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-kg-'));
    const origDataDir = cfg.DATA_DIR;
    cfg.DATA_DIR = dataDir;
    store._resetCache();
    try {
      const fpk = await writeStore(dataDir, 'wsk', {
        d1: { entities: [{ name: 'Alpha', description: 'first' }], relations: [{ source: 'Alpha', target: 'Beta', description: 'links' }] },
      });
      ok(await ndjson.isNdjson(fpk), 'the store is persisted as streaming NDJSON, not whole-object JSON');
      const g1 = await store.getGraph('wsk');
      ok(g1.nodes.size === 2, 'the NDJSON store loads two nodes (Alpha, Beta)');
      const g2 = await store.getGraph('wsk');
      ok(g1 === g2, 'a second read with an unchanged file returns the very same cached graph object');
      // Force a cold reload so the NDJSON read path (not the cache) is exercised end to end.
      store._resetCache();
      const g1b = await store.getGraph('wsk');
      ok(g1b.nodes.size === 2 && g1b.nodes.has(require(path.join(PROJECT, 'lib', 'retrieval', 'entities')).normKey('Alpha')),
        'a cold reload streams the same graph back from the NDJSON file');
      store.clearGraph('wsk');
      const fp = path.join(workspaces.cacheDirFor(dataDir, 'wsk'), 'knowledge-graph.json');
      ok(!fs.existsSync(fp), 'clearGraph removes the on-disk store');
      const g3 = await store.getGraph('wsk');
      ok(g3.nodes.size === 0, 'after clearGraph the workspace has an empty graph');
    } finally {
      cfg.DATA_DIR = origDataDir;
      store._resetCache();
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
    }
    console.log('✓ graphstore: getGraph caches by mtime and clearGraph empties the store');
  }

  // ── graphrag.bridge: gated, needs two seeds, surfaces the connector, fails open ──
  {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-kg-'));
    const origDataDir = cfg.DATA_DIR, origToggle = cfg.useGraphRag, origHops = cfg.GRAPH_HOPS;
    cfg.DATA_DIR = dataDir;
    cfg.GRAPH_HOPS = 1;
    store._resetCache();
    try {
      // Acme — Project Titan — Globex: the two named entities connect only through Project Titan.
      await writeStore(dataDir, 'wsb', {
        d1: { entities: [{ name: 'Acme Corporation', description: 'a firm' }, { name: 'Project Titan', description: 'a program' }],
              relations: [{ source: 'Acme Corporation', target: 'Project Titan', description: 'ran' }] },
        d2: { entities: [{ name: 'Project Titan' }, { name: 'Globex Industries', description: 'a rival' }],
              relations: [{ source: 'Project Titan', target: 'Globex Industries', description: 'acquired by' }] },
        d3: { entities: [{ name: 'Picnic Committee' }], relations: [] },
      });
      const idx = { workspaceId: 'wsb' };
      const q = 'How are Acme Corporation and Globex Industries related?';

      // Off by default -> null, no matter the query.
      cfg.useGraphRag = false;
      eq(await graphrag.bridge(q, idx), null, 'bridge returns null while the feature is disabled');

      // On -> surfaces the connecting entity and the connecting documents.
      cfg.useGraphRag = true;
      const b = await graphrag.bridge(q, idx);
      ok(b && typeof b.query === 'string' && /Titan/i.test(b.query), 'the connecting entity (Project Titan) is in the bridge query');
      ok(/Acme/i.test(b.query) && /Globex/i.test(b.query), 'the named query entities are included too');
      ok(Array.isArray(b.docIds) && b.docIds.includes('d1') && b.docIds.includes('d2'), 'the connecting documents are returned');
      ok(!b.docIds.includes('d3'), 'the unrelated document is not returned');
      ok(b.query.length <= 400, 'the bridge query stays length-bounded');

      // One named entity -> null; no named entity -> null.
      eq(await graphrag.bridge('Tell me about Acme Corporation', idx), null, 'one known entity yields no bridge');
      eq(await graphrag.bridge('what is the weather', idx), null, 'no known entities yields no bridge');

      // Fail-open: a workspace with no stored graph returns null, never throws.
      eq(await graphrag.bridge(q, { workspaceId: 'ws-missing' }), null, 'a missing graph fails open to null');
    } finally {
      cfg.DATA_DIR = origDataDir; cfg.useGraphRag = origToggle; cfg.GRAPH_HOPS = origHops;
      store._resetCache();
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
    }
    console.log('✓ graphrag: bridge is gated, needs two entities, surfaces the connector, and fails open');
  }

  // ── buildGraph: precomputes the merged cache, and clearGraph mid-build cannot resurrect the graph ──
  {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-kg-'));
    const origDataDir = cfg.DATA_DIR;
    cfg.DATA_DIR = dataDir;
    store._resetCache();
    // Stub the bundle and the extractor so buildGraph runs without a real index or model.
    const bundle = require(path.join(PROJECT, 'lib', 'indexing', 'bundle'));
    const graphextract = require(path.join(PROJECT, 'lib', 'indexing', 'graphextract'));
    const origGetBundle = bundle.getBundleNonBlocking;
    const origExtract = graphextract.extractForText;
    const parentMap = new Map([
      ['d1', { content: 'Acme Corporation and Project Titan.', metadata: { source: 'd1.txt' } }],
      ['d2', { content: 'Project Titan and Globex Industries.', metadata: { source: 'd2.txt' } }],
    ]);
    bundle.getBundleNonBlocking = async () => ({ status: 'ready', bundle: { workspaceId: 'wsx', parentMap } });
    let extractCalls = 0;
    const fp = path.join(workspaces.cacheDirFor(dataDir, 'wsx'), 'knowledge-graph.json');
    try {
      // Happy path: a slowish extractor, no interference — build completes, writes, and precomputes cache.
      graphextract.extractForText = async () => {
        extractCalls += 1;
        await new Promise((r) => setTimeout(r, 5));
        return { entities: [{ name: 'Project Titan', type: 'product', description: 'a program' }], relations: [] };
      };
      const r = await store.buildGraph('wsx');
      eq(r.status, 'ok', 'a clean build reports ok');
      ok(r.nodes >= 1, 'the build reports the merged node count');
      ok(fs.existsSync(fp), 'the build wrote the store to disk');
      ok(await ndjson.isNdjson(fp), 'save() writes the store as streaming NDJSON (one record per document)');
      // The merged view is precomputed, so getGraph is a pure cache hit (no re-merge) returning the same object.
      const g1 = await store.getGraph('wsx');
      const g2 = await store.getGraph('wsx');
      ok(g1 === g2 && g1.nodes.has('project titan'), 'getGraph returns the precomputed cached graph after a build');
      // Cold reload: the save→load NDJSON round-trip returns the same graph (not just the warm cache).
      store._resetCache();
      const g2b = await store.getGraph('wsx');
      ok(g2b.nodes.has('project titan'), 'a cold reload streams the just-saved NDJSON store back');

      // Checkpoint-save: a long build persists progress periodically (every GRAPH_SAVE_EVERY=25 extractions), so
      // quitting the app mid-build keeps its work and the next launch resumes instead of starting over. Build 30
      // fresh documents and confirm the store was ALREADY written to disk before the build finished.
      store._resetCache();
      try { fs.rmSync(fp, { force: true }); } catch {}
      const bigMap = new Map();
      for (let i = 0; i < 30; i++) bigMap.set('b' + i, { content: 'Doc ' + i + ' about Node' + i + '.', metadata: { source: 'b' + i + '.txt' } });
      bundle.getBundleNonBlocking = async () => ({ status: 'ready', bundle: { workspaceId: 'wsx', parentMap: bigMap } });
      let cp = 0, savedMidBuild = false;
      graphextract.extractForText = async () => {
        cp += 1;
        if (cp === 26 && fs.existsSync(fp)) savedMidBuild = true;   // a checkpoint after #25 must have written the file
        return { entities: [{ name: 'Node' + cp, description: 'n' }], relations: [] };
      };
      const rc = await store.buildGraph('wsx');
      eq(rc.status, 'ok', 'the 30-document build completes');
      ok(savedMidBuild, 'progress is checkpointed to disk mid-build (an interrupted build is not lost, and resumes)');
      bundle.getBundleNonBlocking = async () => ({ status: 'ready', bundle: { workspaceId: 'wsx', parentMap } });   // restore for the race test

      // Race: clearGraph while a build is in flight must abort the build's save (no resurrection).
      store._resetCache();
      try { fs.rmSync(fp, { force: true }); } catch {}
      extractCalls = 0;
      graphextract.extractForText = async () => {
        extractCalls += 1;
        await new Promise((r) => setTimeout(r, 40));   // long enough to still be running when we clear
        return { entities: [{ name: 'Ghost Entity', description: 'should never be saved' }], relations: [] };
      };
      const p = store.buildGraph('wsx');       // start, do not await
      store.clearGraph('wsx');                 // wipe mid-flight — bumps the generation
      const raced = await p;
      eq(raced.status, 'aborted', 'a build cleared mid-flight aborts instead of writing');
      ok(!fs.existsSync(fp), 'the aborted build did not resurrect the on-disk store');
      const g3 = await store.getGraph('wsx');
      ok(g3.nodes.size === 0, 'after the cleared race the graph is empty (no ghost entity)');
      console.log('✓ graphstore: build precomputes the cache; a clear mid-build cannot resurrect the graph');

      // A clear can also land DURING the async `await save` (after the pre-save generation check). The build
      // must re-check the generation AFTER the save — deleting the file it just resurrected and skipping the
      // cache — and do the final mtime-read + cache-set synchronously so a sync clearGraph cannot interleave.
      // (That window is not deterministically forceable without stubbing save, so guard it at the source.)
      const gsSrc = fs.readFileSync(require('path').join(PROJECT, 'lib', 'graphstore.js'), 'utf-8');
      // Drift guard: this test reconstructs the on-disk NDJSON (version record) with its own VERSION_KEY literal,
      // so fail loudly if graphstore's reserved key ever changes out from under it.
      ok(gsSrc.includes("const VERSION_KEY = '\\u0000graph-version'"), 'graphstore uses the same reserved version key this test writes');
      const afterSave = gsSrc.slice(gsSrc.indexOf('await save(workspaceId, store)'));
      ok((afterSave.match(/_generation\.get\(workspaceId\) \|\| 0\) !== myGen/g) || []).length >= 2,
        'buildGraph re-checks the generation after save (not only before), to catch a clear during the write');
      ok(/fs\.statSync\(filePath\(workspaceId\)\)\.mtimeMs/.test(afterSave) && /cachePut\(workspaceId, mt, graph\)/.test(afterSave),
        'the final mtime read + cache set is synchronous (no await between the last generation check and cachePut)');
      // getGraph coalesces concurrent cold misses (keyed by workspace:mtime) into one load+merge, so N queries
      // during a long build don't each re-merge the growing store in parallel. Guarded at the source.
      ok(/const _buildingMerged = new Map\(\)/.test(gsSrc), 'getGraph keeps an in-flight-merge map');
      const getGraphBody = gsSrc.slice(gsSrc.indexOf('const getGraph ='), gsSrc.indexOf('// ── Incremental'));
      ok(/const key = `\$\{workspaceId\}:\$\{mt\}`/.test(getGraphBody) && /const inflight = _buildingMerged\.get\(key\)/.test(getGraphBody) && /if \(inflight\) return inflight/.test(getGraphBody),
        'getGraph returns the shared in-flight merge for a concurrent cold miss at the same mtime');
    } finally {
      bundle.getBundleNonBlocking = origGetBundle;
      graphextract.extractForText = origExtract;
      cfg.DATA_DIR = origDataDir;
      store._resetCache();
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
    }
  }

  console.log(`\nALL GRAPHSTORE UNIT TESTS PASSED (${checks} checks)`);
  process.exitCode = 0;
} catch (e) {
  console.error('\n✗ GRAPHSTORE UNIT TEST FAILED:', e && e.message, e && e.stack);
  process.exitCode = 1;
}
})();
