'use strict';

// Eager query-adapter fitting + storage in banks.js: at switch time, fit a learned adapter from the new active
// model into each frozen bank (while the old provider is still reachable) and store only a MEASURED-VIABLE one,
// so the frozen bank keeps dense recall if its provider later disappears. Dependency-injected stores + embedders,
// so no live model is needed. Verifies the fit decision, persistence, idempotency, and fail-safety.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const banks = require('../../indexing/banks');
const { applyAdapter, cosine } = require('../../indexing/embedadapter');

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg); checks++; };

const DIM_A = 32, DIM_B = 24;
function hashStr(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function seededVec(seed, dim) { const v = new Float32Array(dim); let x = seed >>> 0; for (let j = 0; j < dim; j++) { x = (x * 1664525 + 1013904223) >>> 0; v[j] = (x / 0xffffffff) * 2 - 1; } return v; }
function randMatrix(dIn, dOut, seed) { const m = []; let x = seed >>> 0; for (let i = 0; i < dIn; i++) { const row = new Float32Array(dOut); for (let j = 0; j < dOut; j++) { x = (x * 1664525 + 1013904223) >>> 0; row[j] = (x / 0xffffffff) * 2 - 1; } m.push(row); } return m; }
function applyLinear(x, M, dOut) { const out = new Float32Array(dOut); for (let i = 0; i < x.length; i++) { const xi = x[i], row = M[i]; for (let j = 0; j < dOut; j++) out[j] += xi * row[j]; } return out; }

const TEXTS = Array.from({ length: 60 }, (_, i) => `document chunk number ${i} with some words`);
const fakeStore = (texts) => ({ getDocstore: () => ({ _docs: new Map(texts.map((t, i) => [String(i), { pageContent: t }])) }) });

const N = { fp: 'nnnnnnnnnnnnnnnn', provider: 'openai', model: 'bge-m3', baseUrl: 'https://host/v1' };
const F = { fp: 'ffffffffffffffff', provider: 'ollama', model: 'bge-m3', baseUrl: 'http://localhost:11434' };

function tmpRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-adapter-'));
  fs.writeFileSync(path.join(dir, 'banks.json'), JSON.stringify({ active: N.fp, banks: [N, F] }));
  return dir;
}

// live embedder (no args) → the per-text live vector; frozen embedder (with meta) → `map(live)`.
const embeddersWhere = (map) => (ov = {}) => ({
  embedDocuments: async (texts) => texts.map((t) => {
    const lv = seededVec(hashStr(t), DIM_A);
    return ov.provider ? Array.from(map(lv, t)) : Array.from(lv);
  }),
});

(async () => {
  const R = randMatrix(DIM_A, DIM_B, 99);

  // 1. A linear relation between the spaces → a VIABLE adapter is fitted and stored under the frozen bank.
  {
    const dir = tmpRegistry();
    const makeEmbeddings = embeddersWhere((lv) => applyLinear(lv, R, DIM_B));
    const loaded = [{ fp: N.fp, meta: N, store: null }, { fp: F.fp, meta: F, store: fakeStore(TEXTS) }];
    const res = await banks.fitAdaptersForFrozenBanks(dir, { FaissStore: {}, makeEmbeddings, banks: loaded });
    eq(res.fitted, 1, 'exactly one adapter fitted (the frozen bank)');
    ok(banks.adapterExists(dir, F.fp, N.fp), 'the adapter is stored under the frozen bank, keyed by the active fp');
    ok(!banks.adapterExists(dir, N.fp, N.fp), 'no adapter is fitted for the active bank itself');
    const adapter = banks.loadViableAdapter(dir, F.fp, N.fp);
    ok(adapter, 'the stored adapter loads back and is viable');
    eq(adapter.dimA, DIM_A, 'adapter maps FROM the live dimension');
    eq(adapter.dimB, DIM_B, 'adapter maps TO the frozen dimension');
    // Applying it to a fresh live vector ≈ the true linear image.
    const lv = seededVec(hashStr('a brand new query'), DIM_A);
    ok(cosine(applyAdapter(adapter, lv), applyLinear(lv, R, DIM_B)) > 0.85, 'the adapter reproduces the mapping on unseen input');

    // 2. Idempotent — a second run fits nothing (the adapter already exists).
    const res2 = await banks.fitAdaptersForFrozenBanks(dir, { FaissStore: {}, makeEmbeddings, banks: loaded });
    eq(res2.fitted, 0, 'a second run is a no-op (adapter already present)');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 3. Unrelated spaces → no viable adapter is stored.
  {
    const dir = tmpRegistry();
    const makeEmbeddings = embeddersWhere((lv, t) => seededVec(hashStr(t) ^ 0x5bd1e995, DIM_B)); // independent of live
    const loaded = [{ fp: N.fp, meta: N, store: null }, { fp: F.fp, meta: F, store: fakeStore(TEXTS) }];
    const res = await banks.fitAdaptersForFrozenBanks(dir, { FaissStore: {}, makeEmbeddings, banks: loaded });
    eq(res.fitted, 0, 'an unrelated space yields no viable adapter');
    ok(!banks.adapterExists(dir, F.fp, N.fp), 'nothing is stored for an unrelated space');
    ok(!banks.loadViableAdapter(dir, F.fp, N.fp), 'loadViableAdapter returns null when none was stored');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 4. Fail-safe — a frozen provider that throws on embed is skipped, never fatal.
  {
    const dir = tmpRegistry();
    const makeEmbeddings = (ov = {}) => ({ embedDocuments: async (texts) => { if (ov.provider) throw new Error('frozen provider unreachable'); return texts.map((t) => Array.from(seededVec(hashStr(t), DIM_A))); } });
    const loaded = [{ fp: N.fp, meta: N, store: null }, { fp: F.fp, meta: F, store: fakeStore(TEXTS) }];
    const res = await banks.fitAdaptersForFrozenBanks(dir, { FaissStore: {}, makeEmbeddings, banks: loaded });
    eq(res.fitted, 0, 'an unreachable frozen provider is skipped, not fatal');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 5. No frozen banks (only the active) → nothing to fit, no error.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-adapter-'));
    fs.writeFileSync(path.join(dir, 'banks.json'), JSON.stringify({ active: N.fp, banks: [N] }));
    const res = await banks.fitAdaptersForFrozenBanks(dir, { FaissStore: {}, makeEmbeddings: embeddersWhere((lv) => lv), banks: [{ fp: N.fp, meta: N, store: null }] });
    eq(res.fitted, 0, 'a single-bank corpus fits nothing');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 6. A non-viable stored sidecar is never applied (the gate travels with the adapter).
  {
    const dir = tmpRegistry();
    await banks.saveAdapter(dir, F.fp, N.fp, Buffer.from([1, 2, 3, 4]), { viable: false, level: 'weak' });
    eq(banks.loadViableAdapter(dir, F.fp, N.fp), null, 'a sidecar marked not-viable is never loaded for retrieval');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 7. anyFrozenWithoutViableAdapter — the Tier 3 gap detector that decides a background re-embed is warranted.
  {
    const dir = tmpRegistry();   // active N + frozen F, no adapter yet
    ok(banks.anyFrozenWithoutViableAdapter(dir), 'a frozen bank with no viable adapter is reported as a gap');
    // Fit a real viable adapter (a loadable blob, not junk) → the gap closes.
    const makeEmbeddings = embeddersWhere((lv) => applyLinear(lv, R, DIM_B));
    const loaded = [{ fp: N.fp, meta: N, store: null }, { fp: F.fp, meta: F, store: fakeStore(TEXTS) }];
    await banks.fitAdaptersForFrozenBanks(dir, { FaissStore: {}, makeEmbeddings, banks: loaded });
    eq(banks.anyFrozenWithoutViableAdapter(dir), false, 'once a viable adapter exists, there is no gap');
    fs.rmSync(dir, { recursive: true, force: true });

    const solo = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-adapter-'));
    fs.writeFileSync(path.join(solo, 'banks.json'), JSON.stringify({ active: N.fp, banks: [N] }));
    eq(banks.anyFrozenWithoutViableAdapter(solo), false, 'a single-bank corpus has no frozen gap');
    fs.rmSync(solo, { recursive: true, force: true });
  }

  // 8. Cost safety — the auto-fit never embeds through a metered provider.
  {
    // Metered LIVE provider → no fit at all.
    const dir = tmpRegistry();
    const makeEmbeddings = embeddersWhere((lv) => applyLinear(lv, R, DIM_B));
    const loaded = [{ fp: N.fp, meta: N, store: null }, { fp: F.fp, meta: F, store: fakeStore(TEXTS) }];
    const res = await banks.fitAdaptersForFrozenBanks(dir, { FaissStore: {}, makeEmbeddings, banks: loaded, liveProvider: 'openai' });
    eq(res.fitted, 0, 'a metered live provider never auto-fits');
    eq(res.skipped, 'metered', 'and reports it skipped for cost');
    fs.rmSync(dir, { recursive: true, force: true });

    // Local live provider, but a METERED frozen bank → that bank is skipped (never embed its sample for money).
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-adapter-'));
    fs.writeFileSync(path.join(dir2, 'banks.json'), JSON.stringify({ active: F.fp, banks: [F, N] }));   // active ollama F, frozen openai N
    const loaded2 = [{ fp: F.fp, meta: F, store: null }, { fp: N.fp, meta: N, store: fakeStore(TEXTS) }];
    const res2 = await banks.fitAdaptersForFrozenBanks(dir2, { FaissStore: {}, makeEmbeddings, banks: loaded2, liveProvider: 'ollama' });
    eq(res2.fitted, 0, 'a metered frozen bank is skipped (no paid embedding of its sample)');
    ok(!banks.adapterExists(dir2, N.fp, F.fp), 'nothing stored for the metered frozen bank');
    fs.rmSync(dir2, { recursive: true, force: true });
  }

  console.log(`ALL BANK-ADAPTER UNIT TESTS PASSED (${checks} checks)`);
})().catch((e) => { console.error('✗ BANK-ADAPTER UNIT TEST FAILED:', e && e.message); process.exit(1); });
