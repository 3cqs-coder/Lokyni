'use strict';
// Switch-reuse benchmark — the end-to-end proof that switching the embedding provider/endpoint REUSES the
// existing embeddings with no re-embed and retains recall (the zero-re-embed guarantee), exercised against the
// REAL embedding model rather than synthetic vectors.
//
// It builds a real index with the configured model at one endpoint spelling, then "switches" to the SAME model
// at a different spelling (a different bank fingerprint). The compatibility measurement must find the two
// identical, record an alias, reuse the one bank (no second bank, no re-embed), and dense search through the new
// endpoint must still return the right document. This is the mirror of the recall benchmark: recall.js proves
// the healthy path does not regress; this proves the switch path reuses and retains.
//
// Runs in a throwaway temp dir; never touches ./data. Requires the embedding provider (Ollama by default) to be
// reachable — when it is not, the benchmark SKIPS with exit 0 so it is safe to run anywhere.
// Run: `npm run eval:switch`.  Exit: 0 pass/skip, 1 a check failed, 2 a harness/setup error.

const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const banks = require(path.join(PROJECT, 'lib/indexing/banks'));
const embeddings = require(path.join(PROJECT, 'lib/embeddings'));
const cfg = require(path.join(PROJECT, 'lib/config'));
const { FaissStore } = require(path.join(PROJECT, 'node_modules/@langchain/community/vectorstores/faiss'));
const { Document } = require(path.join(PROJECT, 'node_modules/@langchain/core/documents'));

// Only the Ollama (local) path has two interchangeable endpoint spellings to exercise this without a second host.
const HOST = (cfg.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '');
const HOST_B = HOST.includes('localhost') ? HOST.replace('localhost', '127.0.0.1')
  : HOST.includes('127.0.0.1') ? HOST.replace('127.0.0.1', 'localhost') : null;
const MODEL = cfg.EMBEDDINGS_MODEL || 'bge-m3';
const mk = (ov) => embeddings.makeEmbeddings(ov);

function reachable(url) {
  return new Promise((res) => {
    try {
      const u = new URL('/api/tags', url);
      const req = http.get(u, { timeout: 3000 }, (r) => { r.resume(); res(r.statusCode > 0); });
      req.on('error', () => res(false)); req.on('timeout', () => { req.destroy(); res(false); });
    } catch { res(false); }
  });
}

const DOCS = [
  { id: 'd1', text: 'The guest wifi password is Zorvex-Falls-2231 and resets every Monday.' },
  { id: 'd2', text: 'Refund requests must be filed within thirty days of purchase.' },
  { id: 'd3', text: 'The Model X sensor communicates over I2C at address 0x4A.' },
  { id: 'd4', text: 'Office plants in the Mibbly wing are watered every Tuesday morning.' },
  { id: 'd5', text: 'The Titan mixer motor delivers up to 850 watts of continuous power.' },
  { id: 'd6', text: 'Вереслав Томичев mapped the river basin over three dry seasons.' },
];

(async () => {
  if (cfg.EMBEDDINGS_PROVIDER !== 'ollama' || !HOST_B) {
    console.log('↷ switch-reuse SKIPPED — needs the local Ollama provider (two endpoint spellings).'); process.exit(0);
  }
  if (!(await reachable(HOST))) {
    console.log(`↷ switch-reuse SKIPPED — embedding provider not reachable at ${HOST}.`); process.exit(0);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-switch-'));
  let fail = 0; const ok = (c, m) => { if (!c) { console.error('  ✗', m); fail++; } else console.log('  ✓', m); };
  try {
    // 1. Build one bank with the real model at HOST.
    const metaA = { fp: banks.fingerprint('ollama', MODEL, HOST), provider: 'ollama', model: MODEL, baseUrl: HOST };
    const embA = mk({ provider: 'ollama', model: MODEL, baseUrl: HOST });
    const store = await FaissStore.fromDocuments(DOCS.map(d => new Document({ pageContent: d.text, metadata: { childId: d.id } })), embA);
    fs.mkdirSync(path.join(dir, 'banks', metaA.fp), { recursive: true });
    await store.save(path.join(dir, 'banks', metaA.fp));
    banks.saveRegistry(dir, { active: metaA.fp, banks: [{ ...metaA, createdAt: Date.now() }] });
    console.log(`switch-reuse: built one bank with ${DOCS.length} real ${MODEL} vectors @ ${HOST}`);

    // 2. Switch the SAME model to HOST_B (a different fingerprint) → must measure identical and alias onto bank A.
    const liveB = { fp: banks.fingerprint('ollama', MODEL, HOST_B), provider: 'ollama', model: MODEL, baseUrl: HOST_B };
    ok(liveB.fp !== metaA.fp, 'the new endpoint has a different bank fingerprint');
    const resolved = await banks.resolveActiveForWrite(dir, { makeEmbeddings: mk, liveMeta: liveB });
    ok(resolved.fp === metaA.fp, 'the switch reuses the existing bank (no re-embed)');
    const reg = banks.loadRegistry(dir);
    ok(reg.aliases && (reg.aliases[liveB.fp] || {}).canonical === metaA.fp, 'an alias onto the existing bank was recorded');
    ok(reg.banks.length === 1, 'no second bank was created — one bank still holds the whole corpus');

    // 3. Recall retained: query through the NEW endpoint.
    const idx = { vectorBanks: await banks.loadBanks(dir, { FaissStore, makeEmbeddings: mk }) };
    const q = async (text) => { const h = await embeddings.denseSearch(idx, text, 3, { cacheDir: dir }); return h[0] && h[0][0] && h[0][0].metadata.childId; };
    ok(await q('What is the guest wifi password?') === 'd1', 'query 1 resolves correctly through the new endpoint');
    ok(await q('I2C address of the Model X sensor') === 'd3', 'query 2 resolves correctly');
    ok(await q('How powerful is the Titan mixer motor?') === 'd5', 'query 3 resolves correctly');
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }

  if (fail === 0) { console.log('\n✓ PASS — a provider switch reused the embeddings with no re-embed and retained recall.'); process.exit(0); }
  console.error(`\n✗ FAIL — ${fail} check(s) failed.`); process.exit(1);
})().catch((e) => { console.error('switch-reuse harness error:', e && e.stack || e); process.exit(2); });
