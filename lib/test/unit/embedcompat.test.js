'use strict';

// The pure core of embedding-space compatibility: given vectors two endpoints produced for the SAME texts,
// decide whether they are the same vector space (safe to share a bank / no re-embed) or different (re-embed).
// One set of thresholds so the alias resolver and any future caller can't drift. No model calls — just float math.

const assert = require('assert');
const { cosine, cosineStats, compatibilityVerdict, THRESHOLDS, PROBE_TEXTS } = require('../../indexing/embedcompat');

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg); checks++; };

function rand(dim, seed) { const v = []; let x = seed; for (let i = 0; i < dim; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; v.push((x / 0x7fffffff) * 2 - 1); } return v; }
function jitter(v, eps, seed) { let x = seed; return v.map((c) => { x = (x * 1103515245 + 12345) & 0x7fffffff; return c + ((x / 0x7fffffff) * 2 - 1) * eps; }); }

// cosine: identical=1, orthogonal≈0, dim mismatch=0, poisoned=0
(() => {
  const a = rand(16, 7);
  ok(Math.abs(cosine(a, a) - 1) < 1e-9, 'cosine of a vector with itself is 1');
  eq(cosine([1, 0, 0], [0, 1, 0]), 0, 'orthogonal → 0');
  eq(cosine([1, 2, 3], [1, 2]), 0, 'different dim → 0');
  eq(cosine([1, NaN, 3], [1, 2, 3]), 0, 'NaN component → 0, never throws');
  eq(cosine(null, [1]), 0, 'null input → 0');
})();

// IDENTICAL vectors → same space, safe to share
(() => {
  const A = [rand(32, 1), rand(32, 2), rand(32, 3)];
  const B = A.map((v) => v.slice());
  const s = cosineStats(A, B);
  eq(s.comparable, true, 'identical vectors are comparable');
  eq(s.dimA, 32, 'dimA'); eq(s.dimB, 32, 'dimB');
  ok(s.cos.median >= THRESHOLDS.identicalMedian, 'median clears the identical threshold');
  const v = compatibilityVerdict(s);
  eq(v.level, 'identical', 'verdict identical');
  eq(v.safeToShareBank, true, 'identical is safe to share');
})();

// QUANTIZATION-level jitter → equivalent, still safe
(() => {
  const A = [rand(64, 10), rand(64, 11), rand(64, 12), rand(64, 13)];
  const B = A.map((v, i) => jitter(v, 0.0008, 100 + i)); // tiny perturbation ≈ half-precision-vs-ref noise
  const v = compatibilityVerdict(cosineStats(A, B));
  ok(['identical', 'equivalent'].includes(v.level), 'tiny jitter stays identical/equivalent: ' + v.level);
  eq(v.safeToShareBank, true, 'quantization-level noise is safe to share');
})();

// a ~0.95 divergence → different, NOT safe to share
(() => {
  const A = [rand(64, 20), rand(64, 21), rand(64, 22)];
  const B = A.map((v, i) => jitter(v, 0.35, 200 + i)); // large perturbation → materially different space
  const v = compatibilityVerdict(cosineStats(A, B));
  ok(['close', 'different'].includes(v.level), 'large divergence is close/different: ' + v.level);
  eq(v.safeToShareBank, false, 'a materially different space is not safe to share');
})();

// DIFFERENT DIMENSIONS → incomparable (different space)
(() => {
  const A = [rand(768, 30), rand(768, 31)];
  const B = [rand(1024, 30), rand(1024, 31)];
  const s = cosineStats(A, B);
  eq(s.comparable, false, 'different dims are not comparable');
  eq(s.cos, null, 'no cosine distribution when dims differ');
  eq(s.dimA, 768, 'dimA'); eq(s.dimB, 1024, 'dimB');
  const v = compatibilityVerdict(s);
  eq(v.level, 'incomparable', 'verdict incomparable');
  eq(v.safeToShareBank, false, 'incomparable is not safe to share');
  ok(/dimensionality/.test(v.message), 'message explains the dimensionality mismatch');
})();

// cosineStats reports mean L2 norm per side (normalization sanity)
(() => {
  const s = cosineStats([[1, 0, 0, 0]], [[3, 4, 0, 0]]);
  ok(Math.abs(s.normA - 1) < 1e-9, 'normA ≈ 1');
  ok(Math.abs(s.normB - 5) < 1e-9, 'normB ≈ 5');
})();

// fail-safe on junk (never throws, safe defaults)
(() => {
  for (const [a, b] of [[null, null], [undefined, []], ['x', 'y'], [[[]], [[]]], [[[1, 2]], [[1, 2, 3]]]]) {
    const s = cosineStats(a, b);
    eq(typeof s, 'object', 'junk → an object, never a throw');
    eq(compatibilityVerdict(s).safeToShareBank, false, 'junk never claims safe to share');
  }
  eq(compatibilityVerdict(null).level, 'incomparable', 'null stats → incomparable');
  eq(compatibilityVerdict(undefined).safeToShareBank, false, 'undefined stats → not safe');
})();

// the probe set is multilingual and synthetic (several scripts)
(() => {
  ok(PROBE_TEXTS.length >= 10, 'probe set has a usable number of texts');
  const joined = PROBE_TEXTS.join('\n');
  ok(/[A-Za-z]/.test(joined), 'includes Latin script');
  ok(/[؀-ۿ]/.test(joined), 'includes Arabic script');
  ok(/[一-鿿]/.test(joined), 'includes CJK script');
  ok(/[Ѐ-ӿ]/.test(joined), 'includes Cyrillic script');
  ok(/[ऀ-ॿ]/.test(joined), 'includes Devanagari script');
  ok(Object.isFrozen(PROBE_TEXTS), 'the probe set is a single frozen source');
})();

console.log(`ALL EMBEDCOMPAT UNIT TESTS PASSED (${checks} checks)`);
