'use strict';

// The compatibility-alias logic in banks.js: on a switch to a brand-new embedding config, measure whether it
// produces the SAME vector space as the active bank and, if so, REUSE that bank (no new bank, no re-embed)
// instead of forking. Dependency-injected embedders + a temp registry, so no live model is needed. Verifies the
// decision, the persistence, the no-re-measure fast path, and that every failure falls back to a normal switch.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const banks = require('../../indexing/banks');

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg); checks++; };

// A deterministic per-index base vector so a "text" maps to a stable vector without a model.
function baseVec(i, dim) { const v = new Array(dim); let x = (i + 1) * 2654435761 >>> 0; for (let j = 0; j < dim; j++) { x = (x * 1664525 + 1013904223) >>> 0; v[j] = (x / 0xffffffff) * 2 - 1; } return v; }
function jitter(v, eps, seed) { let x = seed >>> 0; return v.map((c) => { x = (x * 1664525 + 1013904223) >>> 0; return c + ((x / 0xffffffff) * 2 - 1) * eps; }); }

const DIM = 24;
const SAMPLE = Array.from({ length: 12 }, (_, i) => `probe text ${i}`);

// An injected makeEmbeddings whose output per text index is controlled by `fn(index, overrides)`.
const fakeEmbeddings = (fn) => (overrides = {}) => ({ embedDocuments: async (texts) => texts.map((_, i) => fn(i, overrides)) });

function tmpRegistry(active, bankList) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-alias-'));
  fs.writeFileSync(path.join(dir, 'banks.json'), JSON.stringify({ active, banks: bankList }));
  return dir;
}

const ACTIVE = { fp: 'aaaaaaaaaaaaaaaa', provider: 'ollama', model: 'nomic-embed-text', baseUrl: 'http://localhost:11434' };
const LIVE_NEW = { fp: 'bbbbbbbbbbbbbbbb', provider: 'openai', model: 'nomic-embed-text', baseUrl: 'https://host/v1' };

(async () => {
  // 1. Equivalent spaces → alias recorded, canonical bank reused (no new bank).
  {
    const dir = tmpRegistry(ACTIVE.fp, [ACTIVE]);
    // Both sides return the same per-index vector (± quantization-level jitter) → identical/equivalent space.
    const makeEmbeddings = fakeEmbeddings((i, ov) => jitter(baseVec(i, DIM), 0.0003, i * 7 + (ov.provider === 'openai' ? 1 : 0)));
    const meta = await banks.resolveActiveForWrite(dir, { makeEmbeddings, liveMeta: LIVE_NEW, sampleTexts: SAMPLE });
    eq(meta.fp, ACTIVE.fp, 'equivalent config resolves onto the canonical bank');
    eq(meta.provider, 'openai', 'the resolved meta keeps the LIVE provider (reachable embedder)');
    eq(meta.model, 'nomic-embed-text', 'the resolved meta keeps the live model');
    const reg = banks.loadRegistry(dir);
    ok(reg.aliases && reg.aliases[LIVE_NEW.fp], 'an alias was persisted for the live fp');
    eq(reg.aliases[LIVE_NEW.fp].canonical, ACTIVE.fp, 'the alias points at the canonical bank');
    ok(['identical', 'equivalent'].includes(reg.aliases[LIVE_NEW.fp].level), 'the stored verdict is identical/equivalent');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 2. Different spaces → no alias, a normal switch (returns the live meta → ensureActive will fork a new bank).
  {
    const dir = tmpRegistry(ACTIVE.fp, [ACTIVE]);
    // The live side returns an unrelated vector → a materially different space.
    const makeEmbeddings = fakeEmbeddings((i, ov) => ov.provider === 'openai' ? baseVec(i + 1000, DIM) : baseVec(i, DIM));
    const meta = await banks.resolveActiveForWrite(dir, { makeEmbeddings, liveMeta: LIVE_NEW, sampleTexts: SAMPLE });
    eq(meta.fp, LIVE_NEW.fp, 'a different space keeps the live fp (normal switch)');
    const reg = banks.loadRegistry(dir);
    ok(!(reg.aliases && reg.aliases[LIVE_NEW.fp]), 'no alias is recorded for a different space');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 3. Already-aliased config → returns canonical WITHOUT re-measuring (a throwing embedder proves no embed call).
  {
    const dir = tmpRegistry(ACTIVE.fp, [ACTIVE]);
    fs.writeFileSync(path.join(dir, 'banks.json'), JSON.stringify({ active: ACTIVE.fp, banks: [ACTIVE], aliases: { [LIVE_NEW.fp]: { canonical: ACTIVE.fp, level: 'equivalent' } } }));
    const makeEmbeddings = () => { throw new Error('must not be called for an already-aliased config'); };
    const meta = await banks.resolveActiveForWrite(dir, { makeEmbeddings, liveMeta: LIVE_NEW, sampleTexts: SAMPLE });
    eq(meta.fp, ACTIVE.fp, 'an already-measured alias resolves to canonical without re-measuring');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 4. Live config IS the active bank → immediate return, no measurement.
  {
    const dir = tmpRegistry(ACTIVE.fp, [ACTIVE]);
    const makeEmbeddings = () => { throw new Error('must not measure when nothing changed'); };
    const meta = await banks.resolveActiveForWrite(dir, { makeEmbeddings, liveMeta: ACTIVE, sampleTexts: SAMPLE });
    eq(meta.fp, ACTIVE.fp, 'no switch → the live meta is returned unmeasured');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 5. Reactivating an existing frozen bank → returns the live meta (a real bank), no measurement.
  {
    const FROZEN = { fp: 'cccccccccccccccc', provider: 'ollama', model: 'bge-m3', baseUrl: 'http://localhost:11434' };
    const dir = tmpRegistry(ACTIVE.fp, [ACTIVE, FROZEN]);
    const makeEmbeddings = () => { throw new Error('must not measure when reactivating a real bank'); };
    const meta = await banks.resolveActiveForWrite(dir, { makeEmbeddings, liveMeta: FROZEN, sampleTexts: SAMPLE });
    eq(meta.fp, FROZEN.fp, 'reactivating a registered bank returns it directly');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 6. A measurement failure (unreachable old side) → fall back to a normal switch, never throws.
  {
    const dir = tmpRegistry(ACTIVE.fp, [ACTIVE]);
    const makeEmbeddings = fakeEmbeddings(() => { throw new Error('provider unreachable'); });
    const meta = await banks.resolveActiveForWrite(dir, { makeEmbeddings, liveMeta: LIVE_NEW, sampleTexts: SAMPLE });
    eq(meta.fp, LIVE_NEW.fp, 'an unmeasurable switch falls back to the live meta (normal switch)');
    const reg = banks.loadRegistry(dir);
    ok(!(reg.aliases && reg.aliases[LIVE_NEW.fp]), 'no alias recorded when the measurement could not run');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 7. A dangling alias (canonical bank gone) is inert → treated as no alias.
  {
    const dir = tmpRegistry(ACTIVE.fp, [ACTIVE]);
    const reg = { active: ACTIVE.fp, banks: [ACTIVE], aliases: { [LIVE_NEW.fp]: { canonical: 'zzzzzzzzzzzzzzzz' } } };
    eq(banks.aliasCanonical(reg, LIVE_NEW.fp), null, 'an alias whose canonical bank is absent resolves to null');
    eq(banks.aliasCanonical(reg, ACTIVE.fp), null, 'a fp with no alias resolves to null');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 8. Fingerprint accuracy — one resolution for provider and endpoint, so predict == the real switch.
  {
    // Provider casing is normalized, so 'OpenAI' and 'openai' map to the same bank.
    eq(banks.fingerprint('OpenAI', 'bge-m3', 'https://h/v1'), banks.fingerprint('openai', 'bge-m3', 'https://h/v1'), 'provider casing does not fork a bank');
    // currentMeta fingerprints an openai bank by the EMBEDDINGS base URL (what the embedder actually hits), not
    // the chat OpenAI base — so changing the embeddings endpoint is seen as an endpoint change.
    const cfgA = { EMBEDDINGS_PROVIDER: 'openai', EMBEDDINGS_MODEL: 'bge-m3', EMBEDDINGS_BASE_URL: 'https://embed-a/v1', OPENAI_BASE: 'https://chat/v1' };
    const cfgB = { EMBEDDINGS_PROVIDER: 'openai', EMBEDDINGS_MODEL: 'bge-m3', EMBEDDINGS_BASE_URL: 'https://embed-b/v1', OPENAI_BASE: 'https://chat/v1' };
    ok(banks.currentMeta(cfgA).fp !== banks.currentMeta(cfgB).fp, 'two different embeddings endpoints fingerprint to different banks');
    eq(banks.currentMeta(cfgA).baseUrl, 'https://embed-a/v1', 'currentMeta uses the embeddings base URL, not the chat base');
  }

  console.log(`ALL BANK-ALIAS UNIT TESTS PASSED (${checks} checks)`);
})().catch((e) => { console.error('✗ BANK-ALIAS UNIT TEST FAILED:', e && e.message); process.exit(1); });
