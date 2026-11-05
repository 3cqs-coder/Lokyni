'use strict';
// Benchmark for the resumable bank re-embed (Settings → Consolidate) on a synthetic large corpus.
// It measures the two per-batch costs that scale with the corpus — hashing every file and rebuilding BM25 —
// and shows how the stat-validated hash cache removes the repeated file reads after the first pass. It also
// contrasts a BM25 rebuild with the reuse path the delta takes when a batch's document text is unchanged.
//
// Run:   node lib/test/bench/consolidation.js
//        node lib/test/bench/consolidation.js --docs=10000 --passes=10
//
// No model, network, or user data: everything is created in a temporary folder and removed afterward.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');

const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { hashFile } = require(path.join(PROJECT, 'lib', 'indexing', 'files'));
const hashcache = require(path.join(PROJECT, 'lib', 'indexing', 'hashcache'));
const { buildBM25Index, buildOrReuseBM25Index } = require(path.join(PROJECT, 'lib', 'retrieval', 'bm25'));
const fswalk = require(path.join(PROJECT, 'lib', 'fswalk'));

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const n = hit ? Number(hit.split('=')[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};
const DOCS = Math.min(arg('docs', 2000), 100000);
const PASSES = Math.min(arg('passes', 5), 50);
const HASH_CONCURRENCY = 8;
const now = () => performance.now();

const hashPass = async (files, cache) => {
  for (let i = 0; i < files.length; i += HASH_CONCURRENCY) {
    await Promise.all(files.slice(i, i + HASH_CONCURRENCY).map((f) => hashcache.hashForPass(f, cache)));
  }
};

const ms = (n) => `${n.toFixed(0)} ms`;
const per = (n, passes) => `${(n / passes).toFixed(0)} ms/pass`;

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-bench-'));
  try {
    // A realistic-enough tree: a few folders with small documents.
    for (let i = 0; i < DOCS; i++) {
      const dir = path.join(root, `group-${i % 20}`);
      if (i < 20) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `doc-${i}.txt`),
        `Document ${i}\n\nThe project review covered the budget, the schedule, and the next steps. `.repeat(12));
    }
    const files = fswalk.listFiles(root).map((rel) => path.join(root, rel));
    console.log(`\nConsolidation benchmark — ${files.length} documents, ${PASSES} passes\n`);

    // ── Hashing: plain vs. the migration cache ──
    let t = now();
    for (let p = 0; p < PASSES; p++) await hashPass(files, null);
    const plain = now() - t;

    const cache = hashcache.create();
    t = now();
    for (let p = 0; p < PASSES; p++) await hashPass(files, cache);
    const cached = now() - t;

    // ── BM25: a rebuild vs. the reuse path ──
    // A consolidation batch re-parses its slice, so the shadow map is a clone with value-equal text; that is
    // what the reuse path compares. Measure both so the saving is visible.
    const pMap = new Map(files.map((f, i) => [String(i), { content: fs.readFileSync(f, 'utf-8') }]));
    const shadow = new Map([...pMap.entries()].map(([id, doc]) => [id, { ...doc }]));
    t = now();
    for (let p = 0; p < PASSES; p++) await buildBM25Index(pMap, null, { corpusIdf: new Map() });
    const bm25 = now() - t;

    const firstTarget = { corpusIdf: new Map() };
    const first = await buildBM25Index(pMap, null, firstTarget);
    t = now();
    for (let p = 0; p < PASSES; p++) {
      await buildOrReuseBM25Index(shadow, null, { corpusIdf: new Map() },
        { bm25: first, idf: firstTarget.corpusIdf, map: pMap });
    }
    const reused = now() - t;

    const saved = plain > 0 ? ((1 - cached / plain) * 100) : 0;
    const bm25Saved = bm25 > 0 ? ((1 - reused / bm25) * 100) : 0;
    console.log(`Hash, no cache:       ${ms(plain).padEnd(10)} ${per(plain, PASSES)}`);
    console.log(`Hash, migration cache:${ms(cached).padEnd(10)} ${per(cached, PASSES)}   (${saved.toFixed(0)}% less time)`);
    console.log(`BM25 rebuild:         ${ms(bm25).padEnd(10)} ${per(bm25, PASSES)}`);
    console.log(`BM25 reuse:           ${ms(reused).padEnd(10)} ${per(reused, PASSES)}   (${bm25Saved.toFixed(0)}% less time)`);
    console.log('\nPasses for this corpus by batch size:');
    for (const batch of [100, 250, 500, 1000]) {
      const passes = Math.ceil(files.length / batch);
      const lower = passes * ((cached / PASSES) + (reused / PASSES));
      console.log(`  batch ${String(batch).padStart(4)} → ${String(passes).padStart(3)} passes, ~${(lower / 1000).toFixed(1)} s of hash+BM25 work`);
    }
    console.log('\nNote: reuse applies when a batch leaves the document text unchanged, which is the normal');
    console.log('consolidation case. This measures the per-batch scan/BM25 floor, not embedding or index cloning.\n');
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
})().catch((e) => { console.error('Benchmark failed:', e && e.message); process.exitCode = 1; });
