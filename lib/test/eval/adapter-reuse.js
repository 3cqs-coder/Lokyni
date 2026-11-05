'use strict';
// Adapter-reuse benchmark — the end-to-end proof that a frozen bank stays searchable AFTER its provider is gone,
// through a learned query adapter, with no re-embed. This is the Tier-2 counterpart to switch-reuse.js (Tier-1
// alias) and recall.js (no regression), exercised against REAL embedding models.
//
// It builds a bank with an OLD model, switches to a NEW model (a new active bank), fits the adapter NEW→OLD while
// both are reachable, then makes the OLD provider UNREACHABLE and asserts that a query still returns the old
// bank's documents — served by translating the new-model query into the old bank's space. Needs two Ollama
// embedding models whose spaces are bridgeable in the NEW→OLD direction; it probes for them and SKIPS (exit 0)
// when they are absent, so it is safe to run anywhere. Run: `npm run eval:adapter`.
// Exit: 0 pass/skip, 1 a check failed, 2 a harness/setup error.

const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const banks = require(path.join(PROJECT, 'lib/indexing/banks'));
const embeddings = require(path.join(PROJECT, 'lib/embeddings'));
const A = require(path.join(PROJECT, 'lib/indexing/embedadapter'));
const cfg = require(path.join(PROJECT, 'lib/config'));
const { FaissStore } = require(path.join(PROJECT, 'node_modules/@langchain/community/vectorstores/faiss'));
const { Document } = require(path.join(PROJECT, 'node_modules/@langchain/core/documents'));

const HOST = (cfg.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '');
const DEAD = 'http://127.0.0.1:1';                 // nothing listens here → the old provider "is gone"
const OLD_MODEL = 'bge-m3';                          // richer space (1024d); switching AWAY from it
const NEW_MODEL = 'all-minilm';                      // smaller space (384d); NEW→OLD (384→1024) bridges well
const mk = (model, baseUrl) => embeddings.makeEmbeddings({ provider: 'ollama', model, baseUrl: baseUrl || HOST });

function tags() {
  return new Promise((res) => {
    try { const req = http.get(new URL('/api/tags', HOST), { timeout: 3000 }, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d).models.map(m => m.name)); } catch { res(null); } }); });
      req.on('error', () => res(null)); req.on('timeout', () => { req.destroy(); res(null); });
    } catch { res(null); }
  });
}
const has = (list, name) => Array.isArray(list) && list.some(n => n === name || n.startsWith(name + ':'));

// The OLD bank's documents — synthetic, multilingual. Retrievable ONLY from the old (bge-m3) bank. A few
// "known" documents we query for, plus synthetic multilingual filler so the adapter has enough paired samples to
// fit (a real corpus is large; a fit over a handful of texts is not representative). Filler uses synthetic names.
const { PROBE_TEXTS } = require(path.join(PROJECT, 'lib/indexing/embedcompat'));
const KNOWN = [
  { id: 'wifi', text: 'The guest wifi password is Zorvex-Falls-2231 and resets every Monday.' },
  { id: 'sensor', text: 'The Model X sensor communicates over I2C at address 0x4A.' },
  { id: 'motor', text: 'The Titan mixer motor delivers up to 850 watts of continuous power.' },
  { id: 'river', text: 'Вереслав Томичев mapped the Vexhollow river basin over three dry seasons.' },
  { id: 'plants', text: 'Office plants in the Mibbly wing are watered every Tuesday morning.' },
];
// DISTINCT synthetic documents (not near-duplicate variants, which would be artificial hard negatives). A grid
// of synthetic subjects × facts gives unique sentences, plus the multilingual probe set for script coverage.
const SUBJ = ['Zorvex Dynamics', 'The Mibbly Collective', 'Keltan Brightwater', 'The Vexhollow lab', 'Thaloria Industries', 'The Plindos survey', 'Grimhollow Finch', 'The Mogdin archive', 'Veridia Works', 'The Quendor team'];
const FACT = ['measured ion drift across twelve coastal sites', 'published a cross-lingual retrieval method', 'mapped the delta over three dry seasons', 'compared two indexing strategies for large archives', 'reconciled the quarterly materials ledger', 'catalogued sensor readings from the north ridge', 'summarized field notes on migratory patterns', 'tuned the ranking thresholds for sparse corpora'];
const FILLER = [];
for (let s = 0; s < SUBJ.length; s++) for (let f = 0; f < FACT.length; f++) FILLER.push({ id: `g${s}-${f}`, text: `${SUBJ[s]} ${FACT[f]} in the spring report.` });
PROBE_TEXTS.forEach((t, i) => FILLER.push({ id: `p${i}`, text: t }));
const OLD_DOCS = KNOWN.concat(FILLER);   // ~97 distinct docs — a representative fit, no near-duplicate artifacts
// A document added AFTER the switch — lives only in the NEW (all-minilm) bank.
const NEW_DOCS = [{ id: 'ledger', text: 'The Thaloria ledger was reconciled during the Q3 planning review.' }];

(async () => {
  const list = await tags();
  if (!list) { console.log(`↷ adapter-reuse SKIPPED — Ollama not reachable at ${HOST}.`); process.exit(0); }
  if (!has(list, OLD_MODEL) || !has(list, NEW_MODEL)) {
    console.log(`↷ adapter-reuse SKIPPED — needs both ${OLD_MODEL} and ${NEW_MODEL} installed in Ollama.`); process.exit(0);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-adapter-e2e-'));
  let fail = 0; const ok = (c, m) => { if (!c) { console.error('  ✗', m); fail++; } else console.log('  ✓', m); };
  try {
    const oldFp = banks.fingerprint('ollama', OLD_MODEL, HOST);
    const newFp = banks.fingerprint('ollama', NEW_MODEL, HOST);

    // 1. Build the OLD (bge-m3) bank with the real documents.
    const oldStore = await FaissStore.fromDocuments(OLD_DOCS.map(d => new Document({ pageContent: d.text, metadata: { childId: d.id } })), mk(OLD_MODEL));
    fs.mkdirSync(path.join(dir, 'banks', oldFp), { recursive: true }); await oldStore.save(path.join(dir, 'banks', oldFp));
    // 2. Switch: build the NEW (all-minilm) active bank with a post-switch document.
    const newStore = await FaissStore.fromDocuments(NEW_DOCS.map(d => new Document({ pageContent: d.text, metadata: { childId: d.id } })), mk(NEW_MODEL));
    fs.mkdirSync(path.join(dir, 'banks', newFp), { recursive: true }); await newStore.save(path.join(dir, 'banks', newFp));
    banks.saveRegistry(dir, { active: newFp, banks: [
      { fp: newFp, provider: 'ollama', model: NEW_MODEL, baseUrl: HOST, createdAt: Date.now() },
      { fp: oldFp, provider: 'ollama', model: OLD_MODEL, baseUrl: HOST, createdAt: Date.now() },
    ] });
    console.log(`adapter-reuse: old bank ${OLD_MODEL} (${OLD_DOCS.length} docs), new active bank ${NEW_MODEL}`);

    // 3. Fit the adapter NEW→OLD while both providers are reachable (sample the old bank's own documents).
    const texts = banks.sampleStoreTexts(oldStore, 256);
    const vNew = (await mk(NEW_MODEL).embedDocuments(texts)).map(v => Array.from(v));
    const vOld = (await mk(OLD_MODEL).embedDocuments(texts)).map(v => Array.from(v));
    const aF = [], bF = [], aT = [], bT = [];
    for (let i = 0; i < texts.length; i++) (i % 5 === 0 ? (aT.push(vNew[i]), bT.push(vOld[i])) : (aF.push(vNew[i]), bF.push(vOld[i])));
    const adapter = A.fitLinearAdapter(aF, bF);
    const ret = A.retentionScore(adapter, aT, bT, aF);
    const verdict = A.alignmentVerdict(ret);
    console.log(`  · fitted ${NEW_MODEL}→${OLD_MODEL} adapter: held-out top-1 ${(ret.top1 * 100).toFixed(1)}%, MRR ${ret.mrr.toFixed(3)} → ${verdict.level}`);
    // A real, substantially-working linear map (production's 'viable' gate is a stricter 95%; this benchmark
    // proves the query-time APPLY path retrieves the right documents, which the gate decision is separate from).
    ok(ret.top1 >= 0.85, `the ${NEW_MODEL}→${OLD_MODEL} adapter recovers the structure well (top-1 ${(ret.top1 * 100).toFixed(1)}% ≥ 85%)`);
    // Store it so retrieval exercises the real translation path (the stored gate is unit-tested elsewhere).
    await banks.saveAdapter(dir, oldFp, newFp, A.serializeAdapter(adapter), { viable: true, top1: ret.top1 });

    // 4. The OLD provider is now GONE: bind the old bank to a dead endpoint, the active bank to the live NEW model.
    const idx = { vectorBanks: [
      { fp: newFp, active: true, store: await FaissStore.load(path.join(dir, 'banks', newFp), mk(NEW_MODEL)) },
      { fp: oldFp, active: false, store: await FaissStore.load(path.join(dir, 'banks', oldFp), mk(OLD_MODEL, DEAD)) },
    ] };
    const oldIds = new Set(OLD_DOCS.map(d => d.id));
    const q = async (text) => { const h = await embeddings.denseSearch(idx, text, 5, { cacheDir: dir, embedQuery: (t) => mk(NEW_MODEL).embedQuery(t) }); return h.map(([d]) => d.metadata.childId); };

    // 5. With the old provider GONE, queries for old-bank content must still be SERVED from the old bank — proof
    //    its existing vectors are reused through the translated query (not silently dropped to keyword-only).
    const queries = [
      { id: 'wifi', text: 'What is the guest wifi password?' },
      { id: 'sensor', text: 'What I2C address does the Model X sensor use?' },
      { id: 'motor', text: 'How powerful is the Titan mixer motor?' },
      { id: 'river', text: 'Who mapped the Vexhollow river basin?' },
      { id: 'plants', text: 'When are the office plants watered?' },
    ];
    let served = 0, exact = 0;
    for (const { id, text } of queries) {
      const got = await q(text);
      if (got.some(g => oldIds.has(g))) served++;   // the dead old bank contributed a real hit via the adapter
      if (got.includes(id)) exact++;                // the exact expected document was recovered
    }
    ok(served === queries.length, `every old-bank query is served through the adapter with the provider gone (${served}/${queries.length})`);
    ok(exact >= Math.ceil(queries.length * 0.6), `most exact documents are recovered through the adapter (${exact}/${queries.length})`);
    console.log(`  · ${served}/${queries.length} queries served from the dead bank, ${exact}/${queries.length} exact matches`);

    // 6. The new active bank still serves its own post-switch document normally.
    const ledger = await q('When was the Thaloria ledger reconciled?');
    ok(ledger.includes('ledger'), 'the new active bank still serves its own documents');
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }

  if (fail === 0) { console.log('\n✓ PASS — a frozen bank stayed searchable after its provider was gone, via the learned adapter, with no re-embed.'); process.exit(0); }
  console.error(`\n✗ FAIL — ${fail} check(s) failed.`); process.exit(1);
})().catch((e) => { console.error('adapter-reuse harness error:', e && e.stack || e); process.exit(2); });
