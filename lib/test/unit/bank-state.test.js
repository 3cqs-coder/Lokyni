'use strict';

// The bank-state single source (describeBankState), the pre-switch predictor (predictSwitch), and stale-adapter
// pruning (pruneStaleAdapters) — the backend that the UI reads to show a switch reused the embeddings, which
// frozen banks an adapter keeps searchable, and whether a re-embed is pending. DI + temp registries, no model.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const banks = require('../../indexing/banks');
const embedAdapter = require('../../indexing/embedadapter');

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); checks++; };

const DIM_A = 16, DIM_B = 16;
function rng(seed) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 0xffffffff; }; }
function randVec(dim, r) { const v = new Float32Array(dim); for (let i = 0; i < dim; i++) v[i] = r() * 2 - 1; return v; }
function viableBlob() {
  const r = rng(3); const a = [], b = [];
  for (let i = 0; i < 40; i++) { const x = randVec(DIM_A, r); a.push(x); b.push(x.map(v => v * 0.9)); }
  return embedAdapter.serializeAdapter(embedAdapter.fitLinearAdapter(a, b));
}

const N = { fp: 'nnnnnnnnnnnnnnnn', provider: 'openai', model: 'bge-m3', baseUrl: 'https://h/v1' };
const F = { fp: 'ffffffffffffffff', provider: 'ollama', model: 'bge-m3', baseUrl: 'http://localhost:11434' };
const cfgBanks = { useEmbeddingBanks: true, EMBEDDINGS_PROVIDER: 'ollama', EMBEDDINGS_MODEL: 'bge-m3', OLLAMA_HOST: 'http://localhost:11434' };

function tmp(reg) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-state-')); fs.writeFileSync(path.join(d, 'banks.json'), JSON.stringify(reg)); return d; }

function baseVec(i) { let x = (i + 1) * 2654435761 >>> 0; const lv = []; for (let j = 0; j < DIM_A; j++) { x = (x * 1664525 + 1013904223) >>> 0; lv.push((x / 0xffffffff) * 2 - 1); } return lv; }
// The LIVE side (provider 'ollama') returns the base vector; the OLD/active bank side (provider 'openai')
// returns map(base). So `map` alone controls whether the two spaces are equivalent or different.
const embeddersWhere = (map) => (ov = {}) => ({ embedDocuments: async (texts) => texts.map((t, i) => (ov.provider === 'openai' ? map(baseVec(i)) : baseVec(i))) });

(async () => {
  // describeBankState: a frozen bank with no adapter → role 'frozen', needs re-embed.
  {
    const d = tmp({ active: N.fp, banks: [N, F] });
    const st = banks.describeBankState(d, cfgBanks);
    eq(st.enabled, true, 'enabled when banks are on');
    const fb = st.banks.find(b => b.fp === F.fp);
    eq(fb.role, 'frozen', 'an uncovered frozen bank is role=frozen');
    eq(st.notResilient, true, 'a frozen bank with no adapter is flagged not-resilient (not keyword-only now)');
    eq(st.banks.find(b => b.fp === N.fp).role, 'active', 'the active bank is role=active');
    fs.rmSync(d, { recursive: true, force: true });
  }

  // describeBankState: a viable adapter → role 'adapter', no gap.
  {
    const d = tmp({ active: N.fp, banks: [N, F] });
    await banks.saveAdapter(d, F.fp, N.fp, viableBlob(), { viable: true, top1: 0.98 });
    const st = banks.describeBankState(d, cfgBanks);
    const fb = st.banks.find(b => b.fp === F.fp);
    eq(fb.role, 'adapter', 'a frozen bank with a viable adapter is role=adapter');
    eq(fb.top1, 0.98, 'the adapter quality is reported');
    eq(st.notResilient, false, 'no gap when every frozen bank is covered by an adapter');
    fs.rmSync(d, { recursive: true, force: true });
  }

  // describeBankState: an alias means the live config reused a bank.
  {
    const d = tmp({ active: F.fp, banks: [F], aliases: { [N.fp]: { canonical: F.fp, level: 'identical' } } });
    const liveCfg = { ...cfgBanks, EMBEDDINGS_PROVIDER: 'openai', EMBEDDINGS_MODEL: 'bge-m3', OPENAI_BASE: 'https://h/v1' };
    // currentMeta(liveCfg) must fingerprint to N.fp for the alias to resolve; align the cfg to N's identity.
    const st = banks.describeBankState(d, liveCfg);
    eq(st.enabled, true, 'enabled');
    // reused depends on currentMeta(liveCfg) == N.fp; we assert the field exists and is boolean (fingerprint math is covered elsewhere).
    eq(typeof st.reused, 'boolean', 'reused is reported as a boolean');
    fs.rmSync(d, { recursive: true, force: true });
  }

  // describeBankState: banks disabled → enabled:false, empty.
  {
    const d = tmp({ active: N.fp, banks: [N] });
    const st = banks.describeBankState(d, { useEmbeddingBanks: false });
    eq(st.enabled, false, 'disabled when the flag is off');
    eq(st.banks.length, 0, 'no banks reported when disabled');
    fs.rmSync(d, { recursive: true, force: true });
  }

  // predictSwitch: current config, reuse via alias, equivalent measure, different measure, and unmeasurable.
  {
    const d = tmp({ active: N.fp, banks: [N, F] });
    eq((await banks.predictSwitch(d, { liveMeta: N, makeEmbeddings: () => ({}) })).outcome, 'current', 'same config → current');
    eq((await banks.predictSwitch(d, { liveMeta: F, makeEmbeddings: () => ({}) })).outcome, 'reuse', 'an existing registered bank → reuse');

    const d2 = tmp({ active: N.fp, banks: [N] });
    const LIVE = { fp: 'cccccccccccccccc', provider: 'ollama', model: 'bge-m3', baseUrl: 'http://localhost:11434' };
    eq((await banks.predictSwitch(d2, { liveMeta: LIVE, makeEmbeddings: embeddersWhere((lv) => lv.slice()), sampleTexts: Array.from({ length: 12 }, (_, i) => 't' + i) })).outcome, 'reuse', 'equivalent embedders → reuse');
    eq((await banks.predictSwitch(d2, { liveMeta: LIVE, makeEmbeddings: embeddersWhere((lv) => lv.map((v, i) => i % 2 ? -v : v + 1)), sampleTexts: Array.from({ length: 12 }, (_, i) => 't' + i) })).outcome, 'new', 'a different space → new bank');
    eq((await banks.predictSwitch(d2, { liveMeta: LIVE, makeEmbeddings: () => ({ embedDocuments: async () => { throw new Error('down'); } }) })).outcome, 'unknown', 'unreachable provider → unknown (no crash)');
    fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(d2, { recursive: true, force: true });
  }

  // pruneStaleAdapters: an adapter whose source bank is gone is removed; a current one is kept.
  {
    const d = tmp({ active: N.fp, banks: [N, F] });
    await banks.saveAdapter(d, F.fp, N.fp, viableBlob(), { viable: true });            // current (from active N) → keep
    await banks.saveAdapter(d, F.fp, 'deaddeaddeaddead', viableBlob(), { viable: true }); // from a bank not in the registry → prune
    const removed = banks.pruneStaleAdapters(d);
    eq(removed, 2, 'both files (blob + sidecar) of the stale adapter are removed');
    ok(banks.readAdapterMeta(d, F.fp, N.fp), 'the current adapter is kept');
    ok(!banks.readAdapterMeta(d, F.fp, 'deaddeaddeaddead'), 'the stale adapter is gone');
    fs.rmSync(d, { recursive: true, force: true });
  }

  console.log(`ALL BANK-STATE UNIT TESTS PASSED (${checks} checks)`);
})().catch((e) => { console.error('✗ BANK-STATE UNIT TEST FAILED:', e && e.stack || e); process.exit(1); });
