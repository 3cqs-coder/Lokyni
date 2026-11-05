'use strict';

// The pure core of the learned embedding adapter. The promise: if the TO space is a LINEAR image of the FROM
// space (B = A·R), a learned linear adapter recovers that map and preserves nearest-neighbour structure on
// HELD-OUT pairs → "viable, no re-embed". If the two spaces are unrelated, the adapter cannot bridge them →
// "re-embed". No model calls — just float math on vectors, so the test is deterministic and language-agnostic.

const assert = require('assert');
const { fitLinearAdapter, fitBestAdapter, applyAdapter, retentionScore, alignmentVerdict, cosine, serializeAdapter, deserializeAdapter, THRESHOLDS, LAMBDAS, MAX_N, MAX_ADAPTER_BYTES } = require('../../indexing/embedadapter');

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg); checks++; };

function rng(seed) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 0xffffffff; }; }
function randVec(dim, r) { const v = new Float32Array(dim); for (let i = 0; i < dim; i++) v[i] = r() * 2 - 1; return v; }
function randMatrix(dIn, dOut, r) { const m = []; for (let i = 0; i < dIn; i++) m.push(randVec(dOut, r)); return m; }
function applyLinear(x, M, dOut) { const out = new Float32Array(dOut); for (let i = 0; i < x.length; i++) { const xi = x[i], row = M[i]; for (let j = 0; j < dOut; j++) out[j] += xi * row[j]; } return out; }

// a LINEAR relation between the spaces is recovered → strong, viable
(() => {
  const r = rng(42);
  const dimA = 48, dimB = 32, N = 120;
  const R = randMatrix(dimA, dimB, r);
  const aAll = [], bAll = [];
  for (let i = 0; i < N; i++) { const a = randVec(dimA, r); aAll.push(a); bAll.push(applyLinear(a, R, dimB)); }
  const cut = Math.floor(N * 0.8);
  const aFit = aAll.slice(0, cut), bFit = bAll.slice(0, cut), aTest = aAll.slice(cut), bTest = bAll.slice(cut);
  const adapter = fitLinearAdapter(aFit, bFit, { lambda: 1e-3 });
  ok(adapter, 'adapter fit');
  eq(adapter.dimA, dimA, 'dimA'); eq(adapter.dimB, dimB, 'dimB');
  const mapped = applyAdapter(adapter, aAll[cut]);
  ok(cosine(mapped, bAll[cut]) > 0.9, 'mapped held-out vector ≈ true target: ' + cosine(mapped, bAll[cut]));
  const ret = retentionScore(adapter, aTest, bTest, aFit);
  ok(ret.pool > aTest.length, 'the candidate pool includes the fit set as hard negatives');
  ok(ret.top1 >= 0.95, 'held-out top-1 high even against the full pool: ' + ret.top1);
  const v = alignmentVerdict(ret);
  eq(v.level, 'strong', 'verdict strong'); eq(v.viable, true, 'viable');
})();

// UNRELATED spaces cannot be bridged → weak, not viable
(() => {
  const r = rng(7);
  const dimA = 48, dimB = 32, N = 120;
  const aAll = [], bAll = [];
  for (let i = 0; i < N; i++) { aAll.push(randVec(dimA, r)); bAll.push(randVec(dimB, r)); }
  const cut = Math.floor(N * 0.8);
  const aFit = aAll.slice(0, cut), bFit = bAll.slice(0, cut), aTest = aAll.slice(cut), bTest = bAll.slice(cut);
  const adapter = fitLinearAdapter(aFit, bFit);
  ok(adapter, 'adapter still fits (it just won\'t generalize)');
  const ret = retentionScore(adapter, aTest, bTest, aFit);
  ok(ret.top1 < 0.85, 'held-out top-1 is low for unrelated spaces against the full pool: ' + ret.top1);
  eq(alignmentVerdict(ret).viable, false, 'unrelated spaces are not viable');
})();

// fail-safe — too few pairs / dim mismatch / junk → null, never throws
(() => {
  eq(fitLinearAdapter([], []), null, 'empty → null');
  eq(fitLinearAdapter([[1, 2]], [[1]]), null, 'n<8 → null');
  eq(fitLinearAdapter(null, null), null, 'null → null');
  const r = rng(1); const a = [], b = [];
  for (let i = 0; i < 10; i++) { a.push(randVec(8, r)); b.push(randVec(8, r)); }
  const adapter = fitLinearAdapter(a, b);
  ok(adapter, 'fits with 10 pairs');
  eq(applyAdapter(adapter, randVec(99, r)), null, 'wrong-dim input → null');
  eq(applyAdapter(null, [1, 2]), null, 'null adapter → null');
})();

// verdict partial band and unknown
(() => {
  eq(alignmentVerdict({ n: 20, top1: 0.90, mrr: 0.93 }).level, 'partial', 'partial band');
  eq(alignmentVerdict({ n: 20, top1: 0.90, mrr: 0.93 }).viable, false, 'partial not viable');
  eq(alignmentVerdict({ n: 0 }).level, 'unknown', 'no pairs → unknown');
  eq(alignmentVerdict(null).viable, false, 'null retention → not viable');
})();

// N is capped (never fits an unbounded system)
ok(MAX_N <= 2000, 'MAX_N capped');

// applyAdapter returns a UNIT-NORM vector (so the bare-dot retrieval cosine is a true cosine)
(() => {
  const r = rng(77);
  const dimA = 32, dimB = 48, N = 40;
  const R = randMatrix(dimA, dimB, r);
  const a = [], b = [];
  for (let i = 0; i < N; i++) { const x = randVec(dimA, r); a.push(x); b.push(applyLinear(x, R, dimB)); }
  const adapter = fitLinearAdapter(a, b);
  for (const x of [a[0], a[11], a[39]]) {
    const m = applyAdapter(adapter, x);
    let n = 0; for (const v of m) n += v * v;
    ok(Math.abs(Math.sqrt(n) - 1) < 1e-5, 'mapped vector is unit-norm: ' + Math.sqrt(n));
  }
})();

// an adapter round-trips exactly through serialize/deserialize (so a stored adapter maps identically)
(() => {
  const r = rng(123);
  const dimA = 40, dimB = 24, N = 60;
  const R = randMatrix(dimA, dimB, r);
  const a = [], b = [];
  for (let i = 0; i < N; i++) { const x = randVec(dimA, r); a.push(x); b.push(applyLinear(x, R, dimB)); }
  const adapter = fitLinearAdapter(a, b, { lambda: 1e-3 });
  const blob = serializeAdapter(adapter);
  ok(Buffer.isBuffer(blob), 'serialized to a Buffer');
  eq(blob.length, 28 + 4 * (N * dimA + N * dimB), 'blob size matches the fixed layout');
  const back = deserializeAdapter(blob);
  eq(back.n, adapter.n, 'n survives'); eq(back.dimA, dimA, 'dimA survives'); eq(back.dimB, dimB, 'dimB survives');
  ok(Math.abs(back.lambda - adapter.lambda) < 1e-9, 'lambda survives');
  for (const x of [a[0], a[7], a[59]]) ok(cosine(applyAdapter(adapter, x), applyAdapter(back, x)) > 0.999999, 'mapping survives the round-trip');
})();

// fail-safe — junk, truncation, wrong magic, oversize → null, never throws
(() => {
  eq(deserializeAdapter(null), null, 'null → null');
  eq(deserializeAdapter(Buffer.from([1, 2, 3])), null, 'too short → null');
  eq(deserializeAdapter(Buffer.alloc(40)), null, 'zero magic → null');
  eq(serializeAdapter(null), null, 'null adapter → null');
  eq(serializeAdapter({ n: 1, dimA: 1, dimB: 1, A: [], C: new Float32Array(1) }), null, 'A length ≠ n → null');
  ok(MAX_ADAPTER_BYTES > 0, 'OOM ceiling is positive');
  const r = rng(5); const a = [], b = [];
  for (let i = 0; i < 16; i++) { a.push(randVec(8, r)); b.push(randVec(8, r)); }
  const blob = serializeAdapter(fitLinearAdapter(a, b));
  ok(blob, 'valid blob produced');
  eq(deserializeAdapter(blob.subarray(0, blob.length - 1)), null, 'one byte lopped off → null');
})();

// fitBestAdapter is async (it yields between fits); await it. Also exercise the yield hook — it must be awaited
// between candidates and a throwing hook must not fail the fit.
(async () => {
  // The ridge-λ sweep returns a viable adapter for a linear relation, picks a λ from the set, and is never WORSE
  // than the single default-λ fit on the held-out gate split (the whole point — more reuse).
  {
    const r = rng(314);
    const dimA = 40, dimB = 28, N = 140;
    const R = randMatrix(dimA, dimB, r);
    const aAll = [], bAll = [];
    for (let i = 0; i < N; i++) { const x = randVec(dimA, r); aAll.push(x); bAll.push(applyLinear(x, R, dimB)); }
    const cut = Math.floor(N * 0.8);
    const aFit = aAll.slice(0, cut), bFit = bAll.slice(0, cut), aTest = aAll.slice(cut), bTest = bAll.slice(cut);
    let yields = 0;
    const res = await fitBestAdapter(aFit, bFit, { yield: () => { yields++; return Promise.resolve(); } });
    ok(res && res.adapter, 'fitBestAdapter returns an adapter for a linear relation');
    ok(yields >= LAMBDAS.length, 'the yield hook is awaited between fits (' + yields + ' times)');
    ok(LAMBDAS.includes(res.lambda), 'the chosen lambda is one of the candidates: ' + res.lambda);
    eq(res.adapter.dimA, dimA, 'swept adapter maps the right from-dimension');
    const sweptTop1 = retentionScore(res.adapter, aTest, bTest, aFit).top1;
    const defaultTop1 = retentionScore(fitLinearAdapter(aFit, bFit), aTest, bTest, aFit).top1;
    ok(sweptTop1 >= defaultTop1 - 0.05, `the sweep is not materially worse than the default on the gate split (${(sweptTop1*100).toFixed(1)}% vs ${(defaultTop1*100).toFixed(1)}%)`);
    ok(alignmentVerdict(retentionScore(res.adapter, aTest, bTest, aFit)).viable, 'the swept adapter is viable for a clean linear relation');
    // A throwing yield hook must not fail the fit.
    const res2 = await fitBestAdapter(aFit, bFit, { yield: () => { throw new Error('bad hook'); } });
    ok(res2 && res2.adapter, 'a throwing yield hook does not fail the fit');
  }

  // Too few pairs to split → falls back to a single fit (valTop1 null), still returns an adapter.
  {
    const r = rng(9); const a = [], b = [];
    for (let i = 0; i < 12; i++) { a.push(randVec(8, r)); b.push(randVec(8, r)); }
    const res = await fitBestAdapter(a, b);
    ok(res && res.adapter, 'fitBestAdapter still fits with fewer than 20 pairs');
    eq(res.valTop1, null, 'the fallback single fit reports no validation top-1');
    eq(await fitBestAdapter([], []), null, 'empty → null');
    eq(await fitBestAdapter(null, null), null, 'null → null');
  }

  console.log(`ALL EMBEDADAPTER UNIT TESTS PASSED (${checks} checks)`);
})().catch((e) => { console.error('✗ EMBEDADAPTER UNIT TEST FAILED:', e && e.stack || e); process.exit(1); });
