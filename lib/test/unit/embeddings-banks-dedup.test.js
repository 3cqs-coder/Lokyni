'use strict';
// Guards cross-bank dedup in denseSearch (lib/embeddings.js). With embedding banks on, a CHANGED document is
// re-embedded into the active bank while its stale vector can linger in a frozen bank until Consolidate, so the
// SAME passage can surface from two banks. Without dedup, it takes two of the top-k candidate slots and pushes
// distinct documents out of the window before fusion (recall dilution). denseSearch must keep the best cosine
// per chunk (keyed by childId, else pageContent) so the k budget carries k DISTINCT passages. Also guards the
// event-loop yield in contextualizeChunks and the forward-progress floor in the oversized-chunk splitter.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { denseSearch, l2ToCosine } = require(path.join(PROJECT, 'lib', 'embeddings'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

// A fake FAISS store: returns canned [doc, squaredL2] hits (lower L2 = better).
const fakeStore = (hits) => ({ similaritySearchWithScore: async (_q, k) => hits.slice(0, k) });
const doc = (childId, text) => ({ pageContent: text || ('text-' + childId), metadata: { childId } });

(async () => {
  try {
    // Two banks; chunk c1 appears in BOTH (better — lower L2 — in bank 2). Expect c1 once, plus c2 and c3.
    const idx = { vectorBanks: [
      { store: fakeStore([[doc('c1'), 0.40], [doc('c2'), 0.50]]) },
      { store: fakeStore([[doc('c1'), 0.10], [doc('c3'), 0.60]]) },
    ] };
    const res = await denseSearch(idx, 'q', 5);
    const ids = res.map(([d]) => d.metadata.childId);
    ok(new Set(ids).size === ids.length, 'no chunk appears twice across banks');
    assert.deepStrictEqual(ids.slice().sort(), ['c1', 'c2', 'c3'], 'three distinct chunks survive the union'); checks++;
    const c1 = res.find(([d]) => d.metadata.childId === 'c1');
    ok(Math.abs(c1[1] - l2ToCosine(0.10)) < 1e-9, 'the duplicated chunk keeps its BEST cosine (from the lower-L2 bank)');
    // Results are sorted best-first.
    ok(res[0][1] >= res[res.length - 1][1], 'results are sorted best-cosine-first');

    // The k budget carries k DISTINCT chunks, not k slots half-eaten by a duplicate.
    const res2 = await denseSearch(idx, 'q', 2);
    const ids2 = res2.map(([d]) => d.metadata.childId);
    ok(ids2.length === 2 && new Set(ids2).size === 2, 'k=2 returns two DISTINCT chunks (dedup happens before the slice)');

    // A single store needs no dedup and still returns cosine-sorted hits.
    const one = await denseSearch({ liveVectorStore: fakeStore([[doc('a'), 0.3], [doc('b'), 0.1]]) }, 'q', 5);
    ok(one.map(([d]) => d.metadata.childId).join(',') === 'b,a', 'single-store path returns cosine-sorted results');

    // A dead bank must not be retried on every query: one failure puts it in a cooldown while the healthy
    // bank keeps answering. This is what keeps a provider switch whose old embedding endpoint is gone from
    // costing the full embed timeout on every search.
    const calls = { bad: 0, good: 0 };
    const badStore = {
      index: { ntotal: 2 },
      similaritySearchWithScore: async () => { calls.bad++; throw new Error('old embedding endpoint is gone'); },
    };
    const goodStore = {
      index: { ntotal: 2 },
      similaritySearchWithScore: async () => { calls.good++; return [[doc('fresh'), 0.2]]; },
    };
    const coolingIdx = { vectorBanks: [{ store: badStore }, { store: goodStore }] };
    const first = await denseSearch(coolingIdx, 'q', 5);
    ok(first.length === 1 && first[0][0].metadata.childId === 'fresh',
      'one dead bank does not discard the healthy bank\'s hits');
    ok(calls.bad === 1, 'the dead bank is tried once');
    const second = await denseSearch(coolingIdx, 'q', 5);
    ok(second.length === 1 && calls.bad === 1 && calls.good === 2,
      'the dead bank is skipped during its cooldown while the healthy one is still queried');

    // ── source guards for the two event-loop / progress fixes ──
    const ctx = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'context.js'), 'utf-8');
    ok(/\(i & 127\) === 127\) await new Promise\(\(r\) => setImmediate\(r\)\)/.test(ctx),
      'contextualizeChunks yields to the macrotask queue periodically (no event-loop starvation on a warm cache)');
    const chunk = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'chunking.js'), 'utf-8');
    ok(/if \(cut < 1\) cut = 1;/.test(chunk),
      'the oversized-chunk splitter always advances at least one char (no infinite loop regardless of maxChars)');

    console.log(`✓ embeddings-banks-dedup: the multi-bank union carries k distinct passages; loop-yield and split-progress guards in place (${checks} checks)`);
    process.exitCode = 0;
  } catch (e) {
    console.error('✗ embeddings-banks-dedup:', e && e.message);
    process.exitCode = 1;
  }
})();
