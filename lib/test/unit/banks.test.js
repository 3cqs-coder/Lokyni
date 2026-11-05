'use strict';
// Unit tests for the embedding-banks core logic (lib/indexing/banks.js): fingerprinting,
// the on-disk registry, ensureActive (model-change → new active bank, old kept), and the
// legacy single-index → bank migration. Pure filesystem + hashing, no LLM or embeddings,
// so it's fast and hermetic — each case uses its own temp cache dir and explicit config.
//
// Run: `npm run test:unit` (or `node lib/test/unit/banks.test.js`).

const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const banks = require(path.join(PROJECT, 'lib', 'indexing', 'banks'));

const tmps = [];
const mkTmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-banks-')); tmps.push(d); return d; };
const cleanup = (code) => { for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } process.exit(code); };

// currentMeta keys the bank to the EMBEDDING provider (independent of the chat AI_PROVIDER), so the
// fixtures set EMBEDDINGS_PROVIDER; AI_PROVIDER is kept too to prove the chat provider does not matter.
const cfgNomic  = { AI_PROVIDER: 'ollama', EMBEDDINGS_PROVIDER: 'ollama', EMBEDDINGS_MODEL: 'nomic-embed-text', OLLAMA_HOST: 'http://localhost:11434', OPENAI_BASE: '' };
const cfgMinilm = { ...cfgNomic, EMBEDDINGS_MODEL: 'all-minilm' };

// Async IIFE: one case awaits banks.loadBanks (CommonJS has no top-level await).
(async () => {
try {
  // ── Fingerprinting ──
  const fpA = banks.fingerprint('ollama', 'nomic-embed-text', 'http://localhost:11434');
  assert.strictEqual(fpA, banks.fingerprint('ollama', 'nomic-embed-text', 'http://localhost:11434'), 'deterministic');
  assert.notStrictEqual(fpA, banks.fingerprint('ollama', 'all-minilm', 'http://localhost:11434'), 'differs by model');
  assert.notStrictEqual(fpA, banks.fingerprint('ollama', 'nomic-embed-text', 'http://host:9999'), 'differs by endpoint');
  assert.match(fpA, /^[0-9a-f]{16}$/, '16-hex fingerprint');
  assert.strictEqual(banks.currentMeta(cfgNomic).fp, fpA, 'currentMeta uses the same fingerprint');
  // baseUrl is NORMALIZED (trailing slash + case) so a cosmetic endpoint edit doesn't fork a redundant bank
  // and force a full re-embed.
  assert.strictEqual(banks.fingerprint('ollama', 'nomic-embed-text', 'http://localhost:11434/'), fpA, 'a trailing slash on the endpoint does not change the fingerprint');
  assert.strictEqual(banks.fingerprint('ollama', 'nomic-embed-text', 'HTTP://LocalHost:11434'), fpA, 'endpoint case does not change the fingerprint');
  console.log('✓ banks: fingerprint deterministic + sensitive to model/endpoint, tolerant of cosmetic endpoint differences');

  // ── Registry recovery: a lost/corrupt banks.json is rebuilt from per-bank meta.json, not left to orphan
  //    every frozen bank (whose vectors would otherwise drop out of dense search with no re-embed) ──
  {
    const dir = mkTmp();
    banks.ensureActive(dir, banks.currentMeta(cfgNomic));    // creates the active bank + its meta.json
    banks.ensureActive(dir, banks.currentMeta(cfgMinilm));   // model change → second bank, first frozen
    const fpNomic = banks.currentMeta(cfgNomic).fp, fpMinilm = banks.currentMeta(cfgMinilm).fp;
    // Each bank dir carries a meta.json copy of its registry row.
    assert.ok(fs.existsSync(path.join(banks.bankDir(dir, fpNomic), banks.BANK_META)), 'a created bank writes its meta.json');
    assert.ok(fs.existsSync(path.join(banks.bankDir(dir, fpMinilm), banks.BANK_META)), 'the second bank writes its meta.json');
    // Corrupt the registry, then load it — it must be rebuilt from the bank folders, keeping BOTH banks.
    fs.writeFileSync(banks.registryPath(dir), '{ not valid json');
    const rebuilt = banks.loadRegistry(dir);
    const fps = rebuilt.banks.map(b => b.fp).sort();
    assert.deepStrictEqual(fps, [fpNomic, fpMinilm].sort(), 'a corrupt banks.json is rebuilt from meta.json with every bank kept (frozen banks not orphaned)');
    assert.ok(rebuilt.banks.find(b => b.fp === fpMinilm).model === 'all-minilm', 'the rebuilt registry recovers each bank\'s model (so it is queried with the right embeddings)');
    console.log('✓ banks: a lost/corrupt registry is rebuilt from per-bank meta.json (no orphaned frozen banks)');
  }

  // ── Registry round-trip + default ──
  {
    const d = mkTmp();
    assert.deepStrictEqual(banks.loadRegistry(d), { active: null, banks: [] }, 'empty default when missing');
    banks.saveRegistry(d, { active: 'x', banks: [{ fp: 'x', model: 'm' }] });
    assert.strictEqual(banks.loadRegistry(d).active, 'x');
    assert.strictEqual(banks.loadRegistry(d).banks.length, 1);
    console.log('✓ banks: registry default + save/load round-trip');
  }

  // ── hasEmbeddedCorpus: only a real index (legacy root or any bank) counts; a metadata-only bank does not.
  //    The server uses this to pin the embedding identity only when there is a corpus to protect. ──
  {
    const d = mkTmp();
    assert.strictEqual(banks.hasEmbeddedCorpus(d), false, 'no index means no embedded corpus');
    fs.mkdirSync(path.join(d, 'banks', 'abc'), { recursive: true });
    fs.writeFileSync(path.join(d, 'banks', 'abc', 'meta.json'), '{}');
    assert.strictEqual(banks.hasEmbeddedCorpus(d), false, 'a bank folder with only metadata has no vectors');
    fs.writeFileSync(path.join(d, 'banks', 'abc', 'faiss.index'), 'X');
    assert.strictEqual(banks.hasEmbeddedCorpus(d), true, 'a bank index counts as an embedded corpus');
    const d2 = mkTmp();
    fs.writeFileSync(path.join(d2, 'faiss.index'), 'X');
    assert.strictEqual(banks.hasEmbeddedCorpus(d2), true, 'a legacy root index counts as an embedded corpus');
    console.log('✓ banks: hasEmbeddedCorpus distinguishes real indexes from empty bank folders');
  }

  // ── ensureActive: model change adds a new active bank, keeps the old one ──
  {
    const d = mkTmp();
    const metaN = banks.currentMeta(cfgNomic);
    let r = banks.ensureActive(d, metaN);
    assert.strictEqual(r.changed, true, 'first activation is a change');
    assert.strictEqual(r.activeFp, metaN.fp);
    assert.strictEqual(r.registry.banks.length, 1);

    r = banks.ensureActive(d, metaN);
    assert.strictEqual(r.changed, false, 're-activating the same model is not a change');
    assert.strictEqual(r.registry.banks.length, 1, 'no duplicate bank added');

    const metaM = banks.currentMeta(cfgMinilm);
    r = banks.ensureActive(d, metaM);
    assert.strictEqual(r.changed, true, 'switching model is a change');
    assert.strictEqual(r.activeFp, metaM.fp, 'active flips to the new model');
    assert.strictEqual(r.registry.banks.length, 2, 'old bank is kept, not removed');
    assert.ok(r.registry.banks.some(b => b.fp === metaN.fp), 'old (frozen) bank retained');

    // Switching back must reuse the original bank, not create a third one and not re-embed anything.
    r = banks.ensureActive(d, metaN);
    assert.strictEqual(r.activeFp, metaN.fp, 'switching back re-activates the original bank');
    assert.strictEqual(r.registry.banks.length, 2, 'switching back adds no duplicate bank');
    console.log('✓ banks: ensureActive flips active on model change, keeps the old bank, and reuses it on switch-back');
  }

  // ── Legacy single-index migration ──
  {
    const d = mkTmp();
    // Fake a pre-banks store at the cache root.
    fs.writeFileSync(path.join(d, 'faiss.index'), 'FAKEINDEX');
    fs.writeFileSync(path.join(d, 'docstore.json'), '{}');
    const fp = banks.migrateLegacy(d, 'nomic-embed-text', cfgNomic);
    assert.strictEqual(fp, banks.fingerprint('ollama', 'nomic-embed-text', 'http://localhost:11434'), 'migrated under the legacy model fingerprint');
    assert.ok(fs.existsSync(path.join(d, 'banks', fp, 'faiss.index')), 'index moved into the bank dir');
    assert.strictEqual(fs.readFileSync(path.join(d, 'banks', fp, 'faiss.index'), 'utf8'), 'FAKEINDEX', 'content preserved');
    assert.ok(!fs.existsSync(path.join(d, 'faiss.index')), 'root index moved (not copied)');
    assert.strictEqual(banks.loadRegistry(d).active, fp, 'registry marks it active');
    assert.strictEqual(banks.loadRegistry(d).migratedFp, fp, 'the migration records the bank fingerprint for later attribution');
    banks.ensureActive(d, banks.currentMeta(cfgMinilm));
    assert.strictEqual(banks.loadRegistry(d).migratedFp, fp, 'the migrated fingerprint survives a later model switch');
    assert.strictEqual(banks.migrateLegacy(d, 'nomic-embed-text', cfgNomic), null, 'second migration is a no-op');
    console.log('✓ banks: legacy single index migrates into a bank, non-destructively and once');
  }

  // ── Legacy migration fingerprints the endpoint through the SHARED resolver (no drift from currentMeta) ──
  // Regression guard: when the embeddings endpoint is set via EMBEDDINGS_BASE_URL (distinct from OPENAI_BASE),
  // the migrated bank's fingerprint must equal currentMeta's. A migrateLegacy that resolved the endpoint its own
  // way (reading OPENAI_BASE directly) would stamp a different fingerprint, so the migrated bank would not line up
  // with the active meta and would fork a redundant bank plus a needless re-embed.
  {
    const d = mkTmp();
    const cfgAltEndpoint = {
      AI_PROVIDER: 'openai', EMBEDDINGS_PROVIDER: 'openai', EMBEDDINGS_MODEL: 'text-embedding-3-small',
      EMBEDDINGS_BASE_URL: 'https://alt.example/v1', OPENAI_BASE: 'https://api.openai.com/v1', OLLAMA_HOST: '',
    };
    fs.writeFileSync(path.join(d, 'faiss.index'), 'FAKEINDEX');
    fs.writeFileSync(path.join(d, 'docstore.json'), '{}');
    const fp = banks.migrateLegacy(d, 'text-embedding-3-small', cfgAltEndpoint);
    assert.strictEqual(fp, banks.currentMeta(cfgAltEndpoint).fp,
      'migrateLegacy fingerprints the endpoint via the shared embedBaseUrl resolver, matching currentMeta (no drift)');
    console.log('✓ banks: legacy migration endpoint fingerprint is single-sourced with currentMeta');
  }

  // ── Runtime-enable reload: after migrating a legacy index into a bank, loadBanks must
  // rediscover that bank's store from disk. This is the mechanism the delta path relies on
  // when embedding banks are enabled at RUNTIME: boot took the single-index path, so the
  // in-memory bank list is empty even though a bank now exists on disk. The delta path reloads
  // via loadBanks so the shadow store is cloned from the REAL active bank — without it the
  // clone source is null and the next save would overwrite the bank with only the delta's
  // vectors, silently dropping the whole prior corpus's dense vectors.
  {
    const d = mkTmp();
    // A pre-banks single index, then enable banks at runtime → migrate it into a bank.
    fs.writeFileSync(path.join(d, 'faiss.index'), 'REALINDEX');
    fs.writeFileSync(path.join(d, 'docstore.json'), '{}');
    const fp = banks.migrateLegacy(d, 'nomic-embed-text', cfgNomic);
    // Inject stubs for the two heavy deps loadBanks takes, so the test stays hermetic (no FAISS,
    // no embeddings). loadBanks loads a bank only when its faiss.index exists on disk.
    const FaissStoreStub = { load: async (dir) => ({ _loadedFrom: dir }) };
    const makeEmbeddingsStub = (meta) => ({ _for: meta });
    const loaded = await banks.loadBanks(d, { FaissStore: FaissStoreStub, makeEmbeddings: makeEmbeddingsStub });
    const active = loaded.find(b => b.fp === fp);
    assert.ok(active, 'migrated bank appears in the reloaded bank list');
    assert.ok(active.store && active.store._loadedFrom.endsWith(path.join('banks', fp)), 'its store is loaded from the bank dir on disk');
    assert.strictEqual(active.active, true, 'the migrated bank is marked active');
    // The exact guard delta.js uses to decide whether to reload: an empty in-memory list plus a
    // bank dir on disk must resolve to a real, cloneable active store (never null).
    const emptyInMemory = [];
    assert.strictEqual(emptyInMemory.some(b => b.fp === fp && b.store), false, 'in-memory list starts empty after a runtime enable');
    assert.ok(fs.existsSync(banks.banksRoot(d)), 'a bank dir exists on disk to trigger the reload');
    const cloneSource = loaded.find(b => b.fp === fp && b.store)?.store || null;
    assert.ok(cloneSource, 'after reload the clone source is the real active bank, not null');
    console.log('✓ banks: enabling banks at runtime reloads the existing corpus’s bank (clone source is never null)');
  }

  // ── Disabling banks at runtime: the single-index warm path must detect the orphaned bank
  // layout and rebuild, rather than load nothing and silently serve an empty corpus. This guards
  // the reverse of the runtime-enable fix — turning the toggle OFF leaves the index under banks/
  // with no root faiss.index, so init must force a rebuild from documents.
  {
    const { orphanedBanksPresent } = require(path.join(PROJECT, 'lib', 'indexing', 'init'));
    const d = mkTmp();
    assert.strictEqual(orphanedBanksPresent(d), false, 'a fresh cache dir has no orphaned banks');
    // Create a bank layout on disk (as a prior banks session would leave it).
    fs.writeFileSync(path.join(d, 'faiss.index'), 'IDX');
    fs.writeFileSync(path.join(d, 'docstore.json'), '{}');
    banks.migrateLegacy(d, 'nomic-embed-text', cfgNomic);
    assert.ok(fs.existsSync(banks.banksRoot(d)), 'a bank layout now exists on disk');
    assert.strictEqual(orphanedBanksPresent(d), true, 'an on-disk bank layout is detected (single-index path will rebuild)');
    console.log('✓ banks: disabling banks at runtime is detected so the single-index warm path rebuilds (no silent empty corpus)');
  }

  // ── The banks-off runtime rebuild guard must stay wired ──
  // When banks are OFF, a runtime embedding-model change or leftover banks/ on disk (banks just
  // turned off) must force a clean rebuild inside runDeltaUpdate — otherwise a plain delta keeps
  // serving vectors from the wrong model (meaningless cosine) or clones a single bank into the root
  // index and drops the frozen banks' vectors. The full path is integration-only (needs a real
  // embedder); this guards the wiring against silent removal (the components — orphanedBanksPresent
  // and sameModel — are unit-tested above and in modelname.test.js).
  {
    const deltaSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'delta.js'), 'utf-8');
    assert.ok(/orphanedBanksPresent/.test(deltaSrc) && /sameModel/.test(deltaSrc) && /wipeIndexCache/.test(deltaSrc),
      'delta.js banks-off path forces a rebuild on a model change or orphaned banks');
    console.log('✓ banks: the banks-off runtime rebuild guard is wired in the delta path');
  }

  // ── A corrupt bank (index file PRESENT but unreadable) is flagged `failed`, distinct from an
  // empty bank (no index file yet). The delta path uses this on the ACTIVE bank to self-heal
  // (rebuild) rather than overwrite it with only the new delta's vectors, which would silently drop
  // the unreadable bank's documents. ──
  {
    const d = mkTmp();
    fs.writeFileSync(path.join(d, 'faiss.index'), 'IDX');
    fs.writeFileSync(path.join(d, 'docstore.json'), '{}');
    const corruptFp = banks.migrateLegacy(d, 'nomic-embed-text', cfgNomic);   // a bank whose index exists on disk
    banks.ensureActive(d, banks.currentMeta(cfgMinilm));                       // add a second bank with NO index file
    const emptyFp = banks.currentMeta(cfgMinilm).fp;
    const ThrowingFaiss = { load: async () => { throw new Error('corrupt index'); } };
    const loaded = await banks.loadBanks(d, { FaissStore: ThrowingFaiss, makeEmbeddings: (m) => ({ _for: m }) });
    const corrupt = loaded.find(b => b.fp === corruptFp);
    const empty   = loaded.find(b => b.fp === emptyFp);
    assert.ok(corrupt && corrupt.failed === true && corrupt.store === null, 'a present-but-unreadable index is flagged failed');
    assert.ok(empty && empty.failed === false && empty.store === null, 'a bank with no index file is empty, not failed');
    console.log('✓ banks: a corrupt (present-but-unreadable) bank is flagged failed; an empty bank is not');
  }

  // ── The delta path self-heals a corrupt ACTIVE bank (wipe + rebuild) rather than overwriting it ──
  {
    const deltaSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'delta.js'), 'utf-8');
    const healAt   = deltaSrc.indexOf('activeBankState');
    const healBlock = deltaSrc.slice(healAt);
    assert.ok(/activeBankState && activeBankState\.failed/.test(deltaSrc) && /wipeIndexCache\(\)/.test(healBlock) && /ensureActive/.test(healBlock),
      'delta.js rebuilds the index (wipe + re-create the active bank) when the active bank is corrupt');
    // Ordering matters: the wipe must run BEFORE the shadow store is cloned from cloneSource — a
    // reorder that wiped AFTER the clone would clone from (or overwrite with) a stale/empty store.
    const wipeAt  = deltaSrc.indexOf('wipeIndexCache()', healAt);
    const cloneAt = deltaSrc.indexOf('const cloneSource', healAt);
    assert.ok(wipeAt !== -1 && cloneAt !== -1 && wipeAt < cloneAt,
      'the corrupt-bank wipe runs before the shadow clone (cloneSource)');
    console.log('✓ banks: the delta path rebuilds on a corrupt active bank (wipe before clone, never overwrites it)');
  }

  // ── One embedding identity, stamped in the manifest and compared by both warm start and the delta path.
  //    A provider or endpoint change with the same model name is a different vector space; a model-name-only
  //    check would silently keep the old vectors (banks off) or miss the change at boot.
  {
    const deltaSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'delta.js'), 'utf-8');
    const initSrc  = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'init.js'), 'utf-8');
    assert.ok(/m\._embeddingIdentity = require\('\.\/banks'\)\.currentMeta\(cfg\)\.fp;/.test(deltaSrc),
      'the manifest is stamped with the full embedding identity (provider + model + endpoint)');
    assert.ok(/m\._embeddingIdentity\s*\?/.test(deltaSrc) && /identityMeta = require\('\.\/banks'\)\.currentMeta\(cfg\)/.test(deltaSrc),
      'the banks-off delta compares that identity instead of the model name alone');
    assert.ok(/const identityChanged = manifest\._embeddingIdentity/.test(initSrc),
      'warm start compares the same identity before forcing a rebuild');
    assert.ok(!/^const \{ DEBUG, EMBEDDINGS_MODEL/m.test(initSrc),
      'init.js reads EMBEDDINGS_MODEL live, never from a frozen import');
    console.log('✓ banks: one embedding identity is stamped and compared by warm start and the delta path');
  }


  {
    const deltaSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'delta.js'), 'utf-8');
    assert.ok(/banks\.migratedBankOf\(banks\.loadRegistry\(cfgPaths\.CACHE_DIR\), activeMeta, manifest\._embeddingModel\)/.test(deltaSrc),
      'the delta resolves the migrated bank through the shared helper (recorded marker first, then the manifest model)');
    const bankSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'banks.js'), 'utf-8');
    assert.ok(/if \(registry && registry\.migratedFp\) return registry\.migratedFp;/.test(bankSrc),
      'the helper prefers the fingerprint recorded at migration');
    assert.ok(/return manifestModel \? fingerprint\(meta\.provider, manifestModel, meta\.baseUrl\) : '';/.test(bankSrc),
      'it falls back to the manifest model, and refuses to guess when both are unknown');
    assert.ok(/entry\.bank === activeFp \|\| \(entry\.bank == null && migratedBankFp === activeFp\)/.test(deltaSrc),
      'a migrated entry (no bank tag) counts as in the active bank when its fingerprint equals the active one, so its old vectors are removed (no orphan/duplicate)');
    // Functional: migrateLegacy fingerprints with the manifest model; when the model is unchanged, that fp
    // equals currentMeta().fp — the exact equality the delta fix relies on to route the delete.
    const cfg = { AI_PROVIDER: 'ollama', EMBEDDINGS_PROVIDER: 'ollama', EMBEDDINGS_MODEL: 'nomic-embed-text', OLLAMA_HOST: 'http://x:1', OPENAI_BASE: '' };
    const migratedFp = banks.fingerprint(cfg.EMBEDDINGS_PROVIDER, 'nomic-embed-text', cfg.OLLAMA_HOST);
    assert.strictEqual(migratedFp, banks.currentMeta(cfg).fp, 'an unchanged model fingerprints the migrated bank as the active bank');
    assert.notStrictEqual(banks.fingerprint(cfg.EMBEDDINGS_PROVIDER, 'other-model', cfg.OLLAMA_HOST), banks.currentMeta(cfg).fp, 'a changed model fingerprints differently (migrated bank is frozen, not active)');
    console.log('✓ banks: a migrated (untagged) entry is deleted from the active bank when the model is unchanged');
  }

  console.log('\nALL BANKS UNIT TESTS PASSED');
  cleanup(0);
} catch (e) {
  console.error('\n✗ BANKS UNIT TEST FAILED:', e.message);
  cleanup(1);
}
})();
