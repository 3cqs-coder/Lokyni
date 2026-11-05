'use strict';
// Startup orphaned-vector sweep (lib/indexing/init.js: sweepOrphanVectors / _sweepOrphanVectorsInner).
//
// The invariants, tested in BOTH directions so a future change can't quietly break either half:
//   • it REMOVES a vector whose owning document is gone from the manifest (reclaim after a delete),
//   • it NEVER removes a vector whose document is still live (no data loss),
//   • it NEVER removes a vector it can't positively classify (missing parentId is left in place),
//   • it does nothing on a clean index (the cheap count gate skips the scan entirely),
//   • it refuses to act on ambiguous input — banks on, an unreadable manifest, an empty manifest beside a
//     non-empty store, or a run that would flag every vector (never zero the store),
//   • it deletes by the store's OWN ids and re-embeds nothing.
// Dependency-injected store / manifest / save, so no real index, embedder, or disk is touched. The real
// FaissStore shape (getDocstore()._docs is a Map of id → Document, delete({ids}) by id) was confirmed
// against the installed @langchain/community build when writing this. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const init = require(path.join(PROJECT, 'lib', 'indexing', 'init'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };

// A fake FaissStore with just the surface the sweep touches: index.ntotal(), getDocstore()._docs (id →
// Document), and delete({ids}) that removes by id. `idToParent` maps each vector id to its chunk's parentId
// (null → a chunk with no parentId in metadata).
function makeFakeStore(idToParent) {
  const _docs = new Map();
  for (const [id, parentId] of Object.entries(idToParent)) {
    _docs.set(id, { pageContent: 'x', metadata: (parentId == null ? {} : { parentId }) });
  }
  let n = _docs.size;
  const deleted = [];
  let saved = 0;
  const store = {
    index: { ntotal: () => n },
    getDocstore: () => ({ _docs }),
    delete: async ({ ids }) => { for (const id of ids) { if (!_docs.has(id)) throw new Error(`missing ${id}`); _docs.delete(id); n--; deleted.push(id); } },
  };
  return { store, _docs, deleted, markSave: () => { saved++; }, saves: () => saved };
}
// idFor maps a manifest key (a file path) to its parent doc id. The sweep must use THIS (the manifest),
// not a parentMap — so the test uses the path itself as the parent id and matches the store's parentIds to it.
const idFor = (p) => p;
// A manifest from { 'path': ['v1','v2'], … } live entries, plus the metadata key every real manifest carries.
const manifestOf = (live) => {
  const m = { _indexFormat: 5 };
  for (const [p, ids] of Object.entries(live)) m[p] = { vectorIds: ids };
  return m;
};
const run = (store, manifest, extra = {}) =>
  init._sweepOrphanVectorsInner({ store, manifestLoader: async () => manifest, idFor, banksOn: false, save: async () => {}, ...extra });

(async () => {
  try {
    // ── Pure classifier: orphan removed, live kept, unknown-parent kept ──
    eq(init.classifyOrphanVectorIds([['a', 'P1'], ['b', 'P2'], ['c', 'GONE']], new Set(['P1', 'P2'])), ['c'],
      'only the vector whose parent is not live is an orphan');
    eq(init.classifyOrphanVectorIds([['a', 'P1'], ['u', null], ['v', undefined], ['w', '']], new Set(['P1'])), [],
      'a vector with no/empty parentId is never flagged (never drop what we cannot classify)');
    eq(init.classifyOrphanVectorIds([['a', 'P1'], ['b', 'P2']], new Set(['P1', 'P2'])), [],
      'a fully-live set yields no orphans');

    // ── 1. Orphan present → removed, live survive, store saved, no re-embed ──
    {
      const f = makeFakeStore({ a1: 'docs/a.txt', a2: 'docs/a.txt', b1: 'docs/b.txt', o1: 'docs/deleted.txt', o2: 'docs/deleted.txt' });
      let saved = 0;
      const r = await run(f.store, manifestOf({ 'docs/a.txt': ['a1', 'a2'], 'docs/b.txt': ['b1'] }), { save: async () => { saved++; } });
      eq(r.swept, 2, 'the two vectors of the deleted document are reclaimed');
      eq(f.deleted.sort(), ['o1', 'o2'], 'exactly the deleted document\'s vectors are removed — by the store\'s own ids');
      ok([...f._docs.keys()].sort().join(',') === 'a1,a2,b1', 'every live vector survives');
      eq(saved, 1, 'the pruned store is persisted once (atomic save)');
    }

    // ── 2. Clean index (mirror direction) → the cheap gate skips the scan, nothing deleted or saved ──
    {
      const f = makeFakeStore({ a1: 'docs/a.txt', b1: 'docs/b.txt', b2: 'docs/b.txt' });
      let saved = 0;
      const r = await run(f.store, manifestOf({ 'docs/a.txt': ['a1'], 'docs/b.txt': ['b1', 'b2'] }), { save: async () => { saved++; } });
      eq(r.swept, 0, 'a clean index sweeps nothing');
      eq(f.deleted.length, 0, 'a clean index deletes nothing');
      eq(saved, 0, 'a clean index is not rewritten');
    }

    // ── 3. A live document is never dropped, even with an unclassifiable vector alongside it ──
    {
      const f = makeFakeStore({ a1: 'docs/a.txt', u1: null });   // u1 has no parentId
      const r = await run(f.store, manifestOf({ 'docs/a.txt': ['a1'] }));
      eq(r.swept, 0, 'an unknown-parent vector is left in place (no false positive)');
      eq(f.deleted.length, 0, 'nothing is deleted when the only extra vector is unclassifiable');
    }

    // ── 4. All-flagged guard → never zero the store ──
    {
      // Live docs exist, but every store vector maps to a non-live parent (e.g. an id scheme mismatch).
      const f = makeFakeStore({ s1: 'other/x', s2: 'other/y' });
      const r = await run(f.store, manifestOf({ 'docs/a.txt': ['a1'] }));
      eq(r.skipped, 'all-flagged', 'a run that would flag every vector is refused');
      eq(f.deleted.length, 0, 'the store is never emptied by the sweep');
    }

    // ── 5. Banks on → reclaims an orphan from the ACTIVE bank (banks are the default, so this must work) ──
    {
      const banks = require(path.join(PROJECT, 'lib', 'indexing', 'banks'));
      const activeFp = banks.currentMeta().fp;   // the real active fingerprint, so entryIsFrozen agrees
      const f = makeFakeStore({ a1: 'docs/a.txt', o1: 'docs/gone.txt' });
      // The live document is tagged to the active bank; the orphan's document is gone from the manifest.
      const manifest = { _indexFormat: 5, _embeddingModel: 'model-x', 'docs/a.txt': { vectorIds: ['a1'], bank: activeFp } };
      let saved = 0;
      const r = await init._sweepOrphanVectorsInner({ store: f.store, manifestLoader: async () => manifest, idFor, banksOn: true, save: async () => { saved++; } });
      eq(r.swept, 1, 'banks mode reclaims an orphan from the active bank');
      eq(f.deleted, ['o1'], 'exactly the deleted document\'s active-bank vector is removed');
      ok([...f._docs.keys()].join(',') === 'a1', 'the live active-bank vector survives');
      eq(saved, 1, 'the pruned active bank is persisted');
    }

    // ── 5b. Banks on, active bank EMPTY → must NOT prune a frozen bank (the Finding-1 corruption guard) ──
    // Right after an embedding-model switch the active bank has no store yet, and bundle.js points
    // state.liveVectorStore at a FROZEN bank so retrieval still works. The sweep must resolve the ACTIVE bank
    // by fingerprint and find it empty — NOT prune the frozen bank and save it into the active bank's dir.
    {
      const st = require(path.join(PROJECT, 'lib', 'state'));
      const banks = require(path.join(PROJECT, 'lib', 'indexing', 'banks'));
      const activeFp = banks.currentMeta().fp;
      const frozen = makeFakeStore({ f1: 'docs/a.txt', o1: 'docs/gone.txt' });   // a frozen bank holding an orphan
      const savedBanks = st.vectorBanks;
      // Active bank present but empty (store null); the frozen bank (different fp) holds the corpus + the orphan.
      st.vectorBanks = [{ fp: activeFp, store: null, active: true }, { fp: 'frozen-fp', store: frozen.store, active: false }];
      let saved = 0;
      try {
        const r = await init._sweepOrphanVectorsInner({
          banksOn: true,   // note: NO `store` injected, so the real active-bank resolution runs
          manifestLoader: async () => ({ _indexFormat: 5, _embeddingModel: 'model-x', 'docs/a.txt': { vectorIds: ['f1'], bank: 'frozen-fp' } }),
          idFor, save: async () => { saved++; },
        });
        eq(r.skipped, 'no-store', 'with the active bank empty, the sweep finds no active store and stands down');
        eq(frozen.deleted.length, 0, 'the FROZEN bank store is never pruned');
        eq(saved, 0, 'nothing is written to the active bank directory');
      } finally { st.vectorBanks = savedBanks; }
    }

    // ── 6. Unreadable manifest → skipped (never treat a fail-closed manifest as "no documents") ──
    {
      const f = makeFakeStore({ a1: 'docs/a.txt', o1: 'docs/gone.txt' });
      const r = await init._sweepOrphanVectorsInner({ store: f.store, manifestLoader: async () => ({ _corrupt: true }), idFor, banksOn: false, save: async () => {} });
      eq(r.skipped, 'manifest', 'a corrupt manifest halts the sweep');
      eq(f.deleted.length, 0, 'a corrupt manifest deletes nothing');
    }

    // ── 7. Empty manifest beside a non-empty store → skipped (ambiguous; never zero the store) ──
    {
      const f = makeFakeStore({ a1: 'docs/a.txt', b1: 'docs/b.txt' });
      const r = await init._sweepOrphanVectorsInner({ store: f.store, manifestLoader: async () => ({ _indexFormat: 5 }), idFor, banksOn: false, save: async () => {} });
      eq(r.skipped, 'empty-manifest', 'an empty manifest with a non-empty store is treated as ambiguous');
      eq(f.deleted.length, 0, 'an empty manifest deletes nothing');
    }

    // ── 8. No store / empty store → nothing to do, never throws ──
    {
      eq((await init._sweepOrphanVectorsInner({ store: null, banksOn: false, manifestLoader: async () => manifestOf({ 'a': ['a1'] }), idFor, save: async () => {} })).skipped, 'no-store', 'a BM25-only workspace (no vector store) is a safe no-op');
      const empty = makeFakeStore({});
      const r = await run(empty.store, manifestOf({ 'docs/a.txt': ['a1'] }));
      eq(r.swept, 0, 'an empty store sweeps nothing');
    }

    // ── 9. Source contract: wiring that a refactor must not silently break ──
    {
      const initSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'init.js'), 'utf-8');
      const boot = fs.readFileSync(path.join(PROJECT, 'lokyni.js'), 'utf-8');
      ok(/module\.exports = \{[^}]*\bsweepOrphanVectors\b/.test(initSrc), 'the sweep is exported');
      ok(/liveParents\.add\(idFor\(key\)\)/.test(initSrc), 'the live set is built from the MANIFEST (idFor over manifest keys), not parentMap');
      // Banks are the default, so the sweep must operate on the ACTIVE bank, count only its own documents
      // (shared entryIsFrozen classifier — no drift), and persist via the same saveActiveStore the delta uses.
      ok(!/skipped: 'banks'(?!-dir)/.test(initSrc), 'banks mode is NOT skipped wholesale (it reclaims the active bank)');
      ok(/banksMod\.entryIsFrozen\(e, activeFp, migratedBankFp\)/.test(initSrc), 'the active-vector count reuses the shared entryIsFrozen classifier');
      ok(/banksMod\.saveActiveStore\(cfgPaths\.CACHE_DIR, s, activeFp\)/.test(initSrc), 'the pruned active bank is saved via saveActiveStore (one source of truth for the bank path)');
      ok(/if \(orphanIds\.length >= docs\.size\) return \{ ok: true, skipped: 'all-flagged'/.test(initSrc), 'the never-zero-the-store guard is present');
      ok(/runLifecycleExclusive\(_sweepOrphanVectorsGuarded\)/.test(initSrc), 'the public sweep is serialized through the lifecycle lock');
      ok(/setImmediate/.test(initSrc.slice(initSrc.indexOf('_sweepOrphanVectorsInner'))), 'the scan yields to the event loop (non-blocking)');
      // The concurrency guard: a watcher delta does not take the lifecycle lock, so the sweep must drain an
      // in-flight delta and hold the `initializing` gate across the read-and-prune (reading the store mid-delta
      // would see just-added live vectors as orphans). These must stay together or false deletion returns.
      {
        const g = initSrc.slice(initSrc.indexOf('_sweepOrphanVectorsGuarded'), initSrc.indexOf('const sweepOrphanVectors'));
        ok(/if \(require\('\.\.\/cluster'\)\.isReplica\(\)\) return \{ ok: true, skipped: 'replica'/.test(g), 'the guard refuses to run on a read replica (never writes the shared index)');
        ok(/if \(state\.indexPromise\) \{ try \{ await state\.indexPromise/.test(g), 'the guard drains an in-flight delta before reading the store');
        ok(/initializing = true;/.test(g) && /initializing = prev;/.test(g), 'the guard holds then restores the initializing gate');
        ok(g.indexOf('await state.indexPromise') < g.indexOf('_sweepOrphanVectorsInner()'), 'the drain happens before the prune reads anything');
        ok(g.indexOf('initializing = true') < g.indexOf('_sweepOrphanVectorsInner()'), 'the gate is held before the prune reads anything');
        ok(/if \(hadPending \|\| _deferredDuringInit \|\| \(result && result\.swept > 0\)\) \{ try \{ triggerUpdate\(\)/.test(g),
          'the guard reconciles a scheduled delta, an event the gate dropped during the hold, or an actual prune');
        ok(/_deferredDuringInit = false;/.test(g), 'the guard resets the dropped-event flag before holding the gate');
      }
      // Finding-2 wiring: triggerUpdate records when it drops an event because the gate is held, so the sweep
      // (which does no rescan) can reconcile it. Warm start/rebuild rescan, so they need no such reconcile.
      ok(/if \(switching \|\| initializing\) \{ if \(initializing\) _deferredDuringInit = true; return; \}/.test(initSrc),
        'triggerUpdate flags an event dropped while the initializing gate is held');
      // Finding-1 wiring: in banks mode the store to prune is the ACTIVE bank resolved by fingerprint, NOT
      // state.liveVectorStore (which bundle.js points at a FROZEN bank when the active bank is empty). Pruning
      // and saving that into the active bank's directory would corrupt it with old-model vectors.
      ok(/\(state\.vectorBanks \|\| \[\]\)\.find\(b => b\.fp === activeFp && b\.store\)\?\.store \|\| null/.test(initSrc),
        'the sweep resolves the ACTIVE bank store by fingerprint (never a frozen bank via liveVectorStore)');
      ok(!/store = state\.liveVectorStore,/.test(initSrc),
        'the sweep no longer defaults the store to state.liveVectorStore in banks mode');
      // Boot wires it: primary only, fire-and-forget (the call sits under a replica guard and is not awaited).
      ok(/if \(!cluster\.isReplica\(\)\) \{ sweepOrphanVectors\(\)\.catch\(\(\) => \{\}\); \}/.test(boot),
        'boot runs the sweep on the primary only, fire-and-forget');
    }

    console.log(`\nALL ORPHAN-VECTOR-SWEEP UNIT TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ ORPHAN-VECTOR-SWEEP UNIT TEST FAILED:', e && e.stack || e);
    process.exit(1);
  }
})();
