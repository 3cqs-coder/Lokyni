'use strict';
// Guards that embeddings are unit-normalized so the relevance gate's cosine scale is correct for ANY
// model, not just the defaults that happen to emit normalized vectors. The gate and the corrective-retrieval
// trigger read l2ToCosine(d²) = 1 − d²/2, which is a true cosine ONLY when both stored and query vectors are
// unit length. If a user picks a non-normalizing embedding model, an un-normalized vector would silently
// mis-calibrate the gate (declining valid queries, or firing corrective retrieval every turn). makeEmbeddings
// wraps every client so both embedDocuments (indexing) and embedQuery (search) return unit vectors.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { unitNormalize, l2ToCosine } = require(path.join(PROJECT, 'lib', 'embeddings'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const norm = (v) => Math.sqrt(dot(v, v));
const trueCosine = (a, b) => dot(a, b) / (norm(a) * norm(b));

try {
  // ── unitNormalize produces unit vectors and handles the degenerate cases ──
  const v = [3, 1, 2, 0.5, 4];
  ok(Math.abs(norm(unitNormalize(v)) - 1) < 1e-12, 'a non-zero vector is scaled to unit length');
  ok(JSON.stringify(unitNormalize([0, 0, 0])) === JSON.stringify([0, 0, 0]), 'a zero vector is returned unchanged (no NaN)');
  ok(JSON.stringify(unitNormalize([])) === JSON.stringify([]), 'an empty vector is returned unchanged');
  ok(unitNormalize(v) !== v, 'the input is not mutated (a new array is returned)');

  // ── the whole point: after normalization, l2ToCosine(d²) equals the TRUE cosine for positive-cosine
  //    pairs (a real hit), so the gate reads a correct scale regardless of the model's native norms ──
  const pairs = [[[3, 1, 2, 0.5, 4], [2, 1, 3, 1, 3]], [[10, 2, 1], [9, 3, 1]], [[1, 1, 1, 1], [2, 2, 2, 2]]];
  for (const [a, b] of pairs) {
    const na = unitNormalize(a), nb = unitNormalize(b);
    const l2sq = na.reduce((s, x, i) => s + (x - nb[i]) ** 2, 0);   // squared L2 (what FAISS IndexFlatL2 returns)
    ok(Math.abs(l2ToCosine(l2sq) - trueCosine(a, b)) < 1e-9,
      `l2ToCosine of the normalized squared distance equals the true cosine (${trueCosine(a, b).toFixed(4)})`);
  }
  // A below-orthogonal (negative-cosine) pair clamps to 0 — "no similarity", never a negative score.
  {
    const na = unitNormalize([1, 0]), nb = unitNormalize([-1, 0.1]);
    const l2sq = na.reduce((s, x, i) => s + (x - nb[i]) ** 2, 0);
    ok(l2ToCosine(l2sq) === 0, 'a negative-cosine pair clamps to 0');
  }

  // ── makeEmbeddings wraps BOTH client methods so indexing and query vectors are normalized alike ──
  const src = fs.readFileSync(path.join(PROJECT, 'lib', 'embeddings.js'), 'utf-8');
  ok(/emb\.embedDocuments = async \(texts\) => \(await embedDocuments\(texts\)\)\.map\(unitNormalize\)/.test(src),
    'the wrapper normalizes every indexed vector (embedDocuments)');
  ok(/emb\.embedQuery\s*=\s*async \(text\)\s*=> unitNormalize\(await embedQuery\(text\)\)/.test(src),
    'the wrapper normalizes the query vector (embedQuery)');
  ok((src.match(/return withUnitNorm\(new /g) || []).length === 2,
    'both providers (Ollama and OpenAI) return a unit-normalized client');

  // ── functional: a fake un-normalized client, once passed through the same wrapping the providers use,
  //    yields unit vectors from both methods (proving the wrapper works end to end, no provider needed) ──
  const fake = {
    embedDocuments: async (texts) => texts.map((_, i) => [i + 1, i + 2, i + 3]),   // arbitrary, not unit length
    embedQuery: async () => [5, 12, 84],
  };
  // Mirror withUnitNorm (which is module-private) to exercise the exact contract the providers rely on.
  const embedDocuments = fake.embedDocuments.bind(fake);
  const embedQuery = fake.embedQuery.bind(fake);
  fake.embedDocuments = async (texts) => (await embedDocuments(texts)).map(unitNormalize);
  fake.embedQuery = async (text) => unitNormalize(await embedQuery(text));
  (async () => {
    const docs = await fake.embedDocuments(['a', 'b']);
    ok(docs.every(d => Math.abs(norm(d) - 1) < 1e-12), 'wrapped embedDocuments returns unit vectors');
    ok(Math.abs(norm(await fake.embedQuery('q')) - 1) < 1e-12, 'wrapped embedQuery returns a unit vector');

    console.log('✓ embeddings-normalize: vectors are unit-normalized so the cosine gate is correct for any model');
    console.log(`\nALL EMBEDDINGS-NORMALIZE UNIT TESTS PASSED (${checks} checks)`);
    process.exit(0);
  })().catch((e) => { console.error('\n✗ EMBEDDINGS-NORMALIZE UNIT TEST FAILED:', e && e.message); process.exit(1); });
} catch (e) {
  console.error('\n✗ EMBEDDINGS-NORMALIZE UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
