'use strict';
// Guards mapInSubBatches — the ONE shared helper every in-process model (embedder, reranker, ColBERT) runs its
// forward pass through so a big caller batch of long inputs can never allocate gigabytes in a single pass and OOM
// a modest machine (observed: a 64-row batch asked onnxruntime for a 1.58 GB buffer and died on an 8 GB VM). The
// helper must be NUMERICALLY IDENTICAL to one big call (same values, same order) while bounding how many items
// reach the model at once. This is a PURE test: no model, no worker, no network. If the helper drifts, every
// local model silently loses its OOM guard, so this is a load-bearing invariant. Run: `npm run test:unit`.

const assert = require('assert');
const path = require('path');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { mapInSubBatches, MODEL_SUB_BATCH } = require(path.join(PROJECT, 'lib', 'retrieval', 'modelload'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

(async () => {
  // The cap is a concrete positive integer (so a sub-batch is always bounded and non-empty).
  ok(Number.isInteger(MODEL_SUB_BATCH) && MODEL_SUB_BATCH > 0, `MODEL_SUB_BATCH is a positive integer (${MODEL_SUB_BATCH})`);

  // ── numerical identity + order: process N items where N spans several sub-batches, doubling each. The result
  //    must equal the straight map, in input order, regardless of the sub-batch boundaries. ──
  const N = MODEL_SUB_BATCH * 3 + 1;   // deliberately not a multiple of the cap, so the last sub-batch is partial
  const items = Array.from({ length: N }, (_, i) => i + 1);
  let maxSliceSeen = 0, batchCount = 0;
  const out = await mapInSubBatches(items, async (slice) => {
    maxSliceSeen = Math.max(maxSliceSeen, slice.length);
    batchCount++;
    return slice.map((v) => v * 2);
  });
  ok(Array.isArray(out) && out.length === N, `returns one result per input (${out.length} === ${N})`);
  ok(out.every((v, i) => v === (i + 1) * 2), 'results are in input order and numerically identical to a straight map');
  ok(maxSliceSeen <= MODEL_SUB_BATCH, `no sub-batch ever exceeds the cap (saw at most ${maxSliceSeen} <= ${MODEL_SUB_BATCH})`);
  ok(batchCount === Math.ceil(N / MODEL_SUB_BATCH), `split into the expected number of bounded sub-batches (${batchCount})`);

  // ── empty input is a no-op: [] out, fn never called (so an empty caller batch touches no model) ──
  let called = false;
  const empty = await mapInSubBatches([], async () => { called = true; return []; });
  ok(Array.isArray(empty) && empty.length === 0 && called === false, 'empty input returns [] without calling fn');

  // ── a non-array input is treated as empty rather than throwing (defensive: a caller passing null can't crash) ──
  ok((await mapInSubBatches(null, async () => [])).length === 0, 'a non-array input returns [] (never throws)');

  // ── an explicit size overrides the default and is still honored exactly ──
  let maxSliceSized = 0;
  await mapInSubBatches([1, 2, 3, 4, 5], async (slice) => { maxSliceSized = Math.max(maxSliceSized, slice.length); return slice; }, 2);
  ok(maxSliceSized === 2, 'an explicit sub-batch size is honored (max slice was 2)');

  // ── a zero/negative size can NEVER produce a 0-length slice (that would be an infinite loop): it clamps to 1 ──
  let maxSliceZero = 0, zeroBatches = 0;
  const zeroOut = await mapInSubBatches([1, 2, 3], async (slice) => { maxSliceZero = Math.max(maxSliceZero, slice.length); zeroBatches++; return slice; }, 0);
  ok(zeroOut.length === 3 && maxSliceZero === 1 && zeroBatches === 3, 'a size of 0 clamps to 1 (never a zero-length slice, never an infinite loop)');

  // ── the length guard: a buggy fn that returns the wrong number of results THROWS rather than silently
  //    misaligning vectors with their inputs (which would corrupt every downstream score). ──
  let threw = false;
  try { await mapInSubBatches([1, 2, 3], async () => [1]); }
  catch { threw = true; }
  ok(threw, 'a fn returning the wrong count throws (never silently misaligns results with inputs)');

  // ── a non-array fn result also throws (same corruption guard) ──
  let threw2 = false;
  try { await mapInSubBatches([1], async () => 'not-an-array'); }
  catch { threw2 = true; }
  ok(threw2, 'a non-array fn result throws');

  console.log('✓ model-subbatch: numerically identical to one big call, order-preserving, bounded, guarded');
  console.log(`\nALL MODEL-SUBBATCH UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
})().catch((e) => { console.error('\n✗ MODEL-SUBBATCH UNIT TEST FAILED:', e && e.message); process.exit(1); });
