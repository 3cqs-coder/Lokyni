'use strict';
// Regression tests for the semantic answer cache (lib/semanticcache.js). The whole point of
// this module is that a hit is ONLY ever a genuine repeat, so these lock in the guards: an
// exact repeat hits; a different question, a changed corpus fingerprint, or changed
// answer-affecting settings all miss; a changed corpus retires old entries; and an expired
// entry is ignored. Storage is async (non-blocking). Uses a temp cache dir — no network.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const sc = require(path.join(PROJECT, 'lib', 'semanticcache'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-sctest-'));
  try {
    const baseState = { workspaceId: 'w1', parentMap: new Map([['a', 1], ['b', 2]]), lastIndexedAt: 1000 };
    const baseCfg = {
      EMBEDDINGS_MODEL: 'nomic', AI_PROVIDER: 'ollama', LLM_MODEL: 'llama3.2', TEMPERATURE: 0.2,
      MAX_TOKENS: 1024, numCtx: 8192, PASSAGE_SIZE: 8000, USE_RERANKER: true, RERANKER_MODEL: 'ms-marco',
      rrfFaissWeight: 0.3, rrfBm25Weight: 0.7, rrfK: 60, MIN_COSINE_SCORE: 0.35,
      useEmbeddingBanks: false, useContextualRetrieval: false, useCorrectiveRetrieval: false, useCrossLingual: false,
      correctiveCosineMax: 0.6, usePartialMatchTier: true, useQueryRewrite: true,
    };
    const fp = sc.fingerprint(baseState, baseCfg);
    const sig = sc.signature(baseCfg);

    // ── normalize ──
    ok(sc.normalize('  What  IS  This? ') === 'what is this?', 'normalize lowercases and collapses whitespace');
    console.log('✓ semanticcache: query normalization');

    // ── store + exact-repeat hit ──
    await sc.store(dir, { fingerprint: fp, signature: sig, query: 'What is the refund policy?',
      answer: 'Refunds within 30 days.', sources: [{ id: 'd1', source: 'policy.pdf' }] });
    const hit = await sc.lookup(dir, { fingerprint: fp, signature: sig, query: 'what is the   REFUND policy? ' });
    ok(hit && hit.answer === 'Refunds within 30 days.', 'an exact (normalized) repeat hits');
    ok(hit && hit.sources.length === 1 && hit.sources[0].id === 'd1', 'the cached sources come back');
    console.log('✓ semanticcache: an exact repeat returns the stored answer and sources');

    // ── misses ──
    ok(await sc.lookup(dir, { fingerprint: fp, signature: sig, query: 'what is the return window?' }) === null,
       'a different question misses');
    const fp2 = sc.fingerprint({ ...baseState, lastIndexedAt: 2000 }, baseCfg);   // corpus re-indexed
    ok(await sc.lookup(dir, { fingerprint: fp2, signature: sig, query: 'What is the refund policy?' }) === null,
       'a changed corpus fingerprint misses (stale answer never served)');
    const sig2 = sc.signature({ ...baseCfg, LLM_MODEL: 'llama3.1' });             // model changed
    ok(await sc.lookup(dir, { fingerprint: fp, signature: sig2, query: 'What is the refund policy?' }) === null,
       'a changed answer-affecting setting misses');
    // a retrieval knob (fusion weight) also changes the signature
    ok(sc.signature({ ...baseCfg, rrfBm25Weight: 0.5 }) !== sig, 'a retrieval fusion-weight change alters the signature');
    // The ColBERT late-interaction reranker RE-SORTS the served passages, its model picks which model does
    // that, and the off-topic cutoff decides whether the query abstains — all are query-time (no re-index), so
    // each MUST be in the signature. Omitting them replayed a stale pre-ColBERT answer after the toggle flipped
    // (the same class of miss once fixed for RAG-Fusion / HyDE). Regression guard for exactly that drift.
    ok(sc.signature({ ...baseCfg, USE_COLBERT_RERANK: true }) !== sc.signature({ ...baseCfg, USE_COLBERT_RERANK: false }),
      'toggling the ColBERT late-interaction reranker alters the signature');
    ok(sc.signature({ ...baseCfg, COLBERT_MODEL: 'model-x' }) !== sc.signature({ ...baseCfg, COLBERT_MODEL: 'model-y' }),
      'changing the ColBERT model alters the signature');
    ok(sc.signature({ ...baseCfg, RERANKER_DROP_BELOW: -8 }) !== sc.signature({ ...baseCfg, RERANKER_DROP_BELOW: -5 }),
      'changing the off-topic abstention cutoff alters the signature');
    // Clarifying-questions decides whether an ambiguous (cacheable, no-history) query is answered or asked back
    // about — a produced-response change at query time, so it must be in the signature or toggling it would replay
    // the pre-toggle direct answer instead of the clarify prompt.
    ok(sc.signature({ ...baseCfg, useClarifyingQuestions: true }) !== sc.signature({ ...baseCfg, useClarifyingQuestions: false }),
      'toggling clarifying questions alters the signature');
    console.log('✓ semanticcache: different question / corpus / settings (incl. retrieval knobs + ColBERT + clarify) all miss');

    // ── a re-index retires old entries ──
    await sc.store(dir, { fingerprint: fp2, signature: sig, query: 'New question after reindex?', answer: 'Yes.', sources: [] });
    const raw = JSON.parse(fs.readFileSync(sc.filePathFor(dir), 'utf-8'));
    ok(raw.every(e => e.fp === fp2), 'storing under a new fingerprint drops entries from the superseded corpus');
    ok(await sc.lookup(dir, { fingerprint: fp, signature: sig, query: 'What is the refund policy?' }) === null,
       'the old-corpus answer is gone after the re-index');
    console.log('✓ semanticcache: a re-index self-cleans old entries');

    // ── TTL: an expired entry is ignored ──
    const stale = [{ q: 'old q', sig, fp: fp2, answer: 'stale', sources: [], ts: Date.now() - (sc.TTL_MS + 1000) }];
    fs.writeFileSync(sc.filePathFor(dir), JSON.stringify(stale));
    ok(await sc.lookup(dir, { fingerprint: fp2, signature: sig, query: 'old q' }) === null, 'an entry past the TTL is not served');
    console.log('✓ semanticcache: an expired entry is ignored');

    // ── byte cap: entries carry full passage text, so the file is bounded by SIZE, not only entry count ──
    const bdir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sc-bytes-'));
    const big = 'x'.repeat(9 * 1024 * 1024);   // ~9 MB each → two entries exceed the 16 MB cap
    await sc.store(bdir, { fingerprint: fp, signature: sig, query: 'first big', answer: 'a', sources: [{ source: 's1', content: big }] });
    await sc.store(bdir, { fingerprint: fp, signature: sig, query: 'second big', answer: 'b', sources: [{ source: 's2', content: big }] });
    const sz = fs.statSync(sc.filePathFor(bdir)).size;
    ok(sz <= sc.MAX_BYTES, `the cache file is bounded by MAX_BYTES (${Math.round(sz / 1e6)}MB <= ${Math.round(sc.MAX_BYTES / 1e6)}MB)`);
    ok(await sc.lookup(bdir, { fingerprint: fp, signature: sig, query: 'second big' }) !== null, 'the newest entry survives the byte-cap trim');
    ok(await sc.lookup(bdir, { fingerprint: fp, signature: sig, query: 'first big' }) === null, 'the oldest entry is evicted to fit the byte cap');
    try { fs.rmSync(bdir, { recursive: true, force: true }); } catch {}
    console.log('✓ semanticcache: the cache is byte-bounded (oldest evicted), not only entry-count-bounded');

    // ── entry cap: the on-disk cache never grows past MAX_ENTRIES, keeping the newest ──
    // The file is fully re-read into memory on every load, so an unbounded cache would be a slow memory leak.
    // Store well over the cap under ONE fingerprint (so nothing is retired as stale-corpus), then assert the
    // persisted array is exactly MAX_ENTRIES and the most recent entries survived while the oldest were dropped.
    const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-sccap-'));
    try {
      const n = sc.MAX_ENTRIES + 50;
      for (let i = 0; i < n; i++) {
        await sc.store(capDir, { fingerprint: fp, signature: sig, query: `capq ${i}?`, answer: `a${i}`, sources: [] });
      }
      const persisted = JSON.parse(fs.readFileSync(sc.filePathFor(capDir), 'utf-8'));
      ok(persisted.length === sc.MAX_ENTRIES, `the cache is capped at MAX_ENTRIES (${sc.MAX_ENTRIES}), got ${persisted.length}`);
      ok(await sc.lookup(capDir, { fingerprint: fp, signature: sig, query: `capq ${n - 1}?` }) !== null, 'the most recent entry survives the cap');
      ok(await sc.lookup(capDir, { fingerprint: fp, signature: sig, query: 'capq 0?' }) === null, 'the oldest entry is trimmed past the cap');
      console.log('✓ semanticcache: the on-disk cache is capped at MAX_ENTRIES, newest kept');
    } finally { try { fs.rmSync(capDir, { recursive: true, force: true }); } catch {} }

    console.log(`\nALL SEMANTICCACHE UNIT TESTS PASSED (${checks} checks)`);
    process.exitCode = 0;
  } catch (e) {
    console.error('\n✗ SEMANTICCACHE UNIT TEST FAILED:', e && e.message);
    process.exitCode = 1;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
})();
