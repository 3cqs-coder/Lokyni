'use strict';

// The query-time adapter fallback in denseSearch: when a FROZEN bank's own provider is gone, the live query is
// translated into that bank's space with its stored viable adapter and its EXISTING vectors are searched — so the
// old embeddings are reused with the new provider, no re-embed, no old provider needed. Fake stores + a real
// stored adapter + injected query embed, so no live model is involved. This is the behavior that must not break.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const banks = require('../../indexing/banks');
const embeddings = require('../../embeddings');
const embedAdapter = require('../../indexing/embedadapter');

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg); checks++; };

const DIM_A = 32, DIM_B = 24;
function rng(seed) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 0xffffffff; }; }
function randVec(dim, r) { const v = new Float32Array(dim); for (let i = 0; i < dim; i++) v[i] = r() * 2 - 1; return v; }
function randMatrix(dIn, dOut, r) { const m = []; for (let i = 0; i < dIn; i++) m.push(randVec(dOut, r)); return m; }
function applyLinear(x, M, dOut) { const out = new Float32Array(dOut); for (let i = 0; i < x.length; i++) { const xi = x[i], row = M[i]; for (let j = 0; j < dOut; j++) out[j] += xi * row[j]; } return out; }

// Build + store a viable adapter (live DIM_A → frozen DIM_B) under the frozen bank, keyed by the active fp.
async function storeViableAdapter(cacheDir, frozenFp, activeFp) {
  const r = rng(5);
  const R = randMatrix(DIM_A, DIM_B, r);
  const a = [], b = [];
  for (let i = 0; i < 80; i++) { const x = randVec(DIM_A, r); a.push(x); b.push(applyLinear(x, R, DIM_B)); }
  const cut = 64;
  const adapter = embedAdapter.fitLinearAdapter(a.slice(0, cut), b.slice(0, cut));
  const ret = embedAdapter.retentionScore(adapter, a.slice(cut), b.slice(cut), a.slice(0, cut));
  const blob = embedAdapter.serializeAdapter(adapter);
  await banks.saveAdapter(cacheDir, frozenFp, activeFp, blob, { viable: embedAdapter.alignmentVerdict(ret).viable, top1: ret.top1 });
}

// A fake FAISS store. `onVector` handles similaritySearchVectorWithScore; `ownEmbedThrows` makes its own-embed
// path (similaritySearchWithScore) fail, simulating a dropped provider.
function fakeStore({ ownEmbedThrows = false, vectorHit = null, queryHit = null } = {}) {
  return {
    similaritySearchWithScore: async () => { if (ownEmbedThrows) throw new Error('provider gone'); return queryHit ? [[queryHit, 0.2]] : []; },
    similaritySearchVectorWithScore: async (vec) => { ok(Array.isArray(vec), 'vector search receives a plain array vector'); return vectorHit ? [[vectorHit, 0.1]] : []; },
  };
}

(async () => {
  const ACTIVE_FP = 'aaaaaaaaaaaaaaaa', FROZEN_FP = 'ffffffffffffffff';
  const activeQv = Array.from(randVec(DIM_A, rng(1))); // the live query vector (adapter FROM space)

  // 1. Frozen provider gone → the frozen bank is served via its adapter; its existing vectors still contribute.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-dense-'));
    await storeViableAdapter(dir, FROZEN_FP, ACTIVE_FP);
    const frozenDoc = { pageContent: 'reused-from-frozen', metadata: { childId: 'frozen-1' } };
    const activeDoc = { pageContent: 'from-active', metadata: { childId: 'active-1' } };
    const idx = { vectorBanks: [
      { fp: ACTIVE_FP, active: true, store: fakeStore({ vectorHit: activeDoc }) },
      { fp: FROZEN_FP, active: false, store: fakeStore({ ownEmbedThrows: true, vectorHit: frozenDoc }) },
    ] };
    const res = await embeddings.denseSearch(idx, 'a question', 5, { cacheDir: dir, embedQuery: async () => activeQv });
    const ids = res.map(([d]) => d.metadata.childId);
    ok(ids.includes('frozen-1'), 'the frozen bank contributed a hit through the adapter (old vectors reused)');
    ok(ids.includes('active-1'), 'the active bank also contributed');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 2. Frozen provider healthy → its OWN embedder is used (true vectors), not the adapter.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-dense-'));
    await storeViableAdapter(dir, FROZEN_FP, ACTIVE_FP);
    const ownDoc = { pageContent: 'own-embed', metadata: { childId: 'own-1' } };
    const adapterDoc = { pageContent: 'adapter', metadata: { childId: 'adapter-1' } };
    const idx = { vectorBanks: [
      { fp: ACTIVE_FP, active: true, store: fakeStore({ vectorHit: { pageContent: 'a', metadata: { childId: 'active-1' } } }) },
      { fp: FROZEN_FP, active: false, store: fakeStore({ ownEmbedThrows: false, queryHit: ownDoc, vectorHit: adapterDoc }) },
    ] };
    const res = await embeddings.denseSearch(idx, 'a question', 5, { cacheDir: dir, embedQuery: async () => activeQv });
    const ids = res.map(([d]) => d.metadata.childId);
    ok(ids.includes('own-1'), 'a healthy frozen bank uses its own embedder');
    ok(!ids.includes('adapter-1'), 'the adapter is NOT used when the own embedder works');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 3. No viable adapter + frozen provider gone → the frozen bank simply contributes nothing (no throw).
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-dense-'));
    const idx = { vectorBanks: [
      { fp: ACTIVE_FP, active: true, store: fakeStore({ vectorHit: { pageContent: 'a', metadata: { childId: 'active-1' } } }) },
      { fp: FROZEN_FP, active: false, store: fakeStore({ ownEmbedThrows: true, vectorHit: { pageContent: 'x', metadata: { childId: 'frozen-1' } } }) },
    ] };
    const res = await embeddings.denseSearch(idx, 'a question', 5, { cacheDir: dir, embedQuery: async () => activeQv });
    const ids = res.map(([d]) => d.metadata.childId);
    ok(ids.includes('active-1'), 'the active bank still contributes');
    ok(!ids.includes('frozen-1'), 'with no adapter, the dead frozen bank contributes nothing (no crash)');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 4. The active bank is never adapted (even if a self-adapter somehow existed) and reuses the single embed.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-dense-'));
    let embedCalls = 0;
    const idx = { vectorBanks: [
      { fp: ACTIVE_FP, active: true, store: fakeStore({ vectorHit: { pageContent: 'a', metadata: { childId: 'active-1' } } }) },
      { fp: FROZEN_FP, active: false, store: fakeStore({ ownEmbedThrows: false, queryHit: { pageContent: 'f', metadata: { childId: 'frozen-1' } } }) },
    ] };
    const res = await embeddings.denseSearch(idx, 'q', 5, { cacheDir: dir, embedQuery: async () => { embedCalls++; return activeQv; } });
    eq(embedCalls, 1, 'the live query is embedded exactly once and reused');
    ok(res.map(([d]) => d.metadata.childId).includes('active-1'), 'active bank served from the shared embed');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 5. A LONE frozen bank (the just-created active bank has no store/vectors yet) must STILL use the adapter —
  //    not fall into a single-store path that skips it. Right after a switch, this is the common state.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-dense-'));
    await storeViableAdapter(dir, FROZEN_FP, ACTIVE_FP);
    const frozenDoc = { pageContent: 'reused', metadata: { childId: 'frozen-1' } };
    const idx = { vectorBanks: [
      { fp: ACTIVE_FP, active: true, store: null },                                    // active bank not populated yet
      { fp: FROZEN_FP, active: false, store: fakeStore({ ownEmbedThrows: true, vectorHit: frozenDoc }) },
    ] };
    const res = await embeddings.denseSearch(idx, 'a question', 5, { cacheDir: dir, embedQuery: async () => activeQv });
    ok(res.map(([d]) => d.metadata.childId).includes('frozen-1'), 'a lone frozen bank is served via the adapter even with an empty active bank');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`ALL DENSE-ADAPTER-FALLBACK UNIT TESTS PASSED (${checks} checks)`);
})().catch((e) => { console.error('✗ DENSE-ADAPTER-FALLBACK UNIT TEST FAILED:', e && e.stack || e); process.exit(1); });
