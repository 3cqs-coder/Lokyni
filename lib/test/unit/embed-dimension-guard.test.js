'use strict';
// Guards the embedding-dimension safety check in the delta write path (lib/indexing/delta.js).
//
// Different embedding MODELS get different banks, so a bank only ever mixes one model's vectors. The
// pathological case this guards is the SAME model identity (same bank) suddenly emitting a DIFFERENT
// vector dimension — a re-quantized or swapped local model under an unchanged name. Adding a mismatched
// vector to a FAISS store throws (aborting the file) or, if it slipped through, would score as noise.
// The guard detects the mismatch, skips the dense add (the document stays searchable by keyword/name),
// stamps the file hash so it does not grind a doomed re-embed every delta, and warns the operator.
//
// Pure/offline: storeDimension is probed with lightweight fake stores; the wiring is asserted by source.
// Run: `npm run test:unit` (or `node lib/test/unit/embed-dimension-guard.test.js`).

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { storeDimension } = require(path.join(PROJECT, 'lib', 'indexing', 'delta'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

try {
  // ── storeDimension reads an initialized store's dimension, and is null when there is nothing to read ──
  eq(storeDimension({ index: { ntotal: () => 3, getDimension: () => 768 } }), 768, 'reads the dimension of a populated store (ntotal via function)');
  eq(storeDimension({ index: { ntotal: 5, getDimension: () => 1024 } }), 1024, 'reads the dimension when ntotal is a numeric property');
  eq(storeDimension({ index: { ntotal: () => 0, getDimension: () => 768 } }), null, 'an EMPTY store has no dimension yet (the next add sets it)');
  eq(storeDimension({}), null, 'a store with no index yields null (not a throw)');
  eq(storeDimension(null), null, 'a null store yields null');
  eq(storeDimension({ index: { ntotal: () => { throw new Error('boom'); } } }), null, 'a throwing store degrades to null, never propagates');
  eq(storeDimension({ index: { ntotal: () => 2, getDimension: () => 0 } }), null, 'a non-positive dimension is treated as unknown');

  // ── The guard decision is exactly "both known and different" ──
  const mismatch = (existing, next) => !!(existing && next && existing !== next);
  ok(mismatch(768, 1024), 'a genuine dimension change is a mismatch');
  ok(!mismatch(768, 768), 'the same dimension is not a mismatch');
  ok(!mismatch(null, 1024), 'an empty bank (null existing) is never a mismatch — the first add sets the dimension');
  ok(!mismatch(768, undefined), 'a missing new vector length is not treated as a mismatch');

  // ── SOURCE GUARD: the guard is wired BEFORE the add, keeps the file lexical, and does not grind ──
  const src = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'delta.js'), 'utf-8');
  const guardIdx = src.indexOf('const existingDim = storeDimension(shadowStore);');
  const addIdx = src.indexOf('await shadowStore.addVectors(allVecs, allDocs)');
  ok(guardIdx !== -1, 'the dimension guard computes the existing bank dimension');
  ok(addIdx !== -1 && guardIdx < addIdx, 'the guard runs BEFORE addVectors (prevents the FAISS throw)');
  ok(/existingDim && newDim && existingDim !== newDim/.test(src), 'the guard fires only when both dimensions are known and differ');
  // On a mismatch: the file is stamped (fileHash present, so no re-embed grind), skipped from dense, and flagged.
  ok(/dimMismatch: true/.test(src), 'a dimension-mismatched file is flagged in the manifest');
  const block = src.slice(guardIdx, addIdx);
  ok(/fileHash: diskHashes\[filePath\]/.test(block) && /skipped: true/.test(block) && /continue;/.test(block),
    'a mismatched file is stamped (no grind) and skipped from the dense add, staying keyword-searchable');
  ok(/Rebuild index/.test(block), 'the operator is told how to recover (Rebuild re-embeds at the new dimension)');

  console.log(`\nALL EMBED-DIMENSION-GUARD TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ EMBED-DIMENSION-GUARD UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
