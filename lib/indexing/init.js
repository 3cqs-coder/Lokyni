'use strict';
const fsSync  = require('fs');
const fs      = require('fs').promises;
const path    = require('path');
const chokidar = require('chokidar');
const { FaissStore } = require('@langchain/community/vectorstores/faiss');
const { DEBUG, DEBOUNCE_TIME } = require('../config');
const cfgPaths = require('../config');   // cfgPaths.CACHE_DIR / cfgPaths.DOCS_DIR read live (workspace-relative)
const state   = require('../state');
const { mtimeOf } = require('../statkey');   // shared "mtime or 0" for the index-map freshness/ordering gates
const { makeEmbeddings, l2ToCosine, embedBounded } = require('../embeddings');
const { buildBM25Index } = require('../retrieval/bm25');
const { buildChunkIndex } = require('../retrieval/passages');
const { loadManifest } = require('./manifest');
const { collectAllFiles, loadSingleDocument, docIdFor } = require('./files');
const { semanticSplitDocument } = require('./chunking');
const { runDeltaUpdate, reindexNow, saveStoreAtomic } = require('./delta');
const { CACHE_FILES } = require('../constants');   // single source for the on-disk index artifact names
// `foo` and `foo:latest` are the same Ollama model, so re-selecting the tagged form must not read
// as a model change (which would force a needless full re-embed).
const { sameModel } = require('../modelname');

// Periodic progress for long loops. Reports on a time interval rather than per
// item: a per-item line floods the console on a large corpus, and a silent loop
// looks like a hang. Also prints the current filename, since "which document is it
// stuck on" is the actual question when something goes wrong.
const makeProgress = (total, label) => {
  const started = Date.now();
  let lastReport = 0;
  const INTERVAL_MS = 10000;
  const st = require('../state');
  return {
    tick(done, name) {
      // Publish to state on every tick (cheap — just an object assign) so the
      // browser status heartbeat can show live progress. The console throttle
      // below is separate: it's about not flooding the terminal, not about how
      // often the UI updates.
      st.indexProgress = { done, total, name, label };
      const now = Date.now();
      if (now - lastReport < INTERVAL_MS || done === total) return;
      lastReport = now;
      const pct = Math.round((done / total) * 100);
      console.log(`   ${label}: ${done}/${total} (${pct}%) — ${name}`);
    },
    done() {
      st.indexProgress = null;   // clear so the heartbeat stops reporting progress
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (Date.now() - started > INTERVAL_MS) {
        console.log(`   ${label}: ${total}/${total} in ${secs}s`);
      }
    },
  };
};

// Wipe the vector-store cache for the active workspace so the next index run
// rebuilds everything from the documents. Exposed so a manual "rebuild index"
// action (CLI or API) can realign an index whose internal ids have drifted from
// the current document paths — the auto-detection heuristics below only catch
// *some* drift (e.g. all paths missing), not the case where documents still exist
// but the cached vectors carry stale parent ids.
// True when a bank layout exists on disk but there is no single root index — the state left
// after embedding banks are turned OFF at runtime (the on-disk index sits under banks/, with no
// root faiss.index). The single-index warm path uses this to force a rebuild rather than load
// nothing and serve an empty corpus. Exported for tests.
const orphanedBanksPresent = (cacheDir) => {
  try {
    const banks = require('./banks');
    return fsSync.existsSync(banks.banksRoot(cacheDir)) || fsSync.existsSync(banks.registryPath(cacheDir));
  } catch { return false; }
};

const wipeIndexCache = async () => {
  // A rebuild is an explicit "try everything fresh," so clear this session's parse-failure backoff —
  // a document deferred after a failed parse this session must be re-attempted by the rebuild.
  try { require('./delta').clearParseBackoff(); } catch {}
  try { require('../ocrcache').clear(); } catch {}
  try { require('../visualcache').clear(); } catch {}
  try { require('../summarycache').clear(); } catch {}
  try { require('../transcriptcache').clear(); } catch {}
  try { require('./figurestore').clear(require('../config').CACHE_DIR); } catch {}
  // Drop the LLM knowledge graph too — it is keyed by document id, so a full wipe-and-rebuild would
  // otherwise leave it holding extractions for the pre-rebuild corpus. A later graph build repopulates
  // it from the rebuilt documents. Best-effort and never blocks a wipe.
  try { require('../graphstore').clearGraph(state.workspaceId || 'default'); } catch {}
  try {
    for (const f of [CACHE_FILES.faissIndex, CACHE_FILES.docstore, CACHE_FILES.manifest, CACHE_FILES.passageMap, CACHE_FILES.childMap, require('./commitmarker').FILE]) {
      await fs.rm(path.join(cfgPaths.CACHE_DIR, f), { force: true }).catch(() => {});
    }
    await fs.rm(path.join(cfgPaths.CACHE_DIR, '_shadow'), { recursive: true, force: true }).catch(() => {});
    await fs.rm(path.join(cfgPaths.CACHE_DIR, CACHE_FILES.parentMap), { force: true }).catch(() => {});
    // Always clear the bank layout, whether or not banks are currently on. With banks on, a
    // rebuild that kept the frozen bank(s) would duplicate every document across the old banks
    // and the fresh active one. With banks off, any banks/ on disk is orphaned from a prior
    // banks session (e.g. the toggle was turned off) and must go so it can't be mistaken for a
    // live index or re-trigger the disable-rebuild path on the next start.
    try {
      const banks = require('./banks');
      await fs.rm(banks.banksRoot(cfgPaths.CACHE_DIR), { recursive: true, force: true }).catch(() => {});
      await fs.rm(banks.registryPath(cfgPaths.CACHE_DIR), { force: true }).catch(() => {});
      await fs.rm(banks.migrationPath(cfgPaths.CACHE_DIR), { force: true }).catch(() => {});
      state.vectorBanks = [];
      state.bankMigration = null;   // a rebuild supersedes any resumable re-embed
    } catch { /* banks module unavailable — nothing to clear */ }
  } catch {}
  state.liveVectorStore = null;
  // Also drop the in-memory text maps so a wipe-then-rebuild starts from empty. Otherwise a
  // document deleted from disk during the rebuild window would linger in parentMap (the manifest
  // is now empty, so the delta computes no deletions) and stay BM25-searchable as a stale orphan
  // until a later normal delta. The rebuild repopulates these from disk.
  state.parentMap = new Map();
  state.childMap = new Map();
  state.passageMap = new Map();
  // Drop the BM25 index too: it was built from the now-cleared parentMap, so keeping it would leave
  // it referencing purged docIds until the rebuild replaces it.
  state.liveBM25 = null;
};

// Set while the index is being loaded/built with no in-flight state.indexPromise to dedupe against —
// warm start (initIndex) and a UI rebuild (forceReindex). The file watcher is armed before the index
// finishes loading, and during these windows state.indexing is false, so without a hard gate a
// file-change event could start a delta that snapshots a half-loaded parentMap and persists it. Mirrors
// the `switching` gate below; both are honored in triggerUpdate.
let initializing = false;
// Set by triggerUpdate when it drops a file-change event because `initializing` is held. Unlike warm start
// and rebuild — which hold the gate but then rescan the whole filesystem, so a dropped event is covered — the
// orphan sweep holds the gate WITHOUT a rescan, so it checks this flag and reconciles anything it suppressed.
let _deferredDuringInit = false;

// One chain that serializes EVERY index-lifecycle mutator — workspace switch, rebuild, bank
// consolidation, and a backup restore's quiesce-and-swap. These each stop watchers, wait out an
// in-flight delta, and swap or wipe live state; running two at once lets one clear the other's watcher
// gate mid-operation (a restore's files replaced while a switch re-arms the watcher and starts a delta
// into them) or redirect a rebuild onto a workspace a concurrent switch just changed. Chaining makes each
// wait for the previous to finish. A rejection never breaks the chain. Callers that already hold the lock
// must invoke the INNER (unwrapped) function, never the public wrapper, or they would self-deadlock.
let _lifecycleChain = Promise.resolve();
const runLifecycleExclusive = (fn) => {
  const next = _lifecycleChain.catch(() => {}).then(fn);
  _lifecycleChain = next.catch(() => {});
  return next;
};

// Reflect a document mutation (upload, URL ingest, delete, or a connector add/remove/sync) into the index,
// SERIALIZED through the lifecycle lock so it can never race a workspace switch, rebuild, bank consolidation,
// or backup restore. Running a delta alongside one of those can read or write the cache mid-wipe, drive a
// delta into a directory being replaced, or follow the active workspace as it flips — corrupting or
// misplacing the index. The active-versus-non-active choice is made at RUN time, so a switch while this
// waited still applies the change to the right workspace. `onNonActive(wsId)` handles a non-active workspace
// (reconcile or invalidate its on-disk cache); it is awaited and may be omitted. When nothing holds the lock
// (the normal case) this runs immediately. Every document-mutation path must go through this one helper so a
// new caller cannot reintroduce the race. Never throws — a failure is logged and swallowed.
const reflectWorkspaceMutation = async (wsId, onNonActive) => {
  // Only the PRIMARY writes the shared index. A read replica shares the data dir, so if it reindexed it would
  // race the primary's own indexing and corrupt the shared FAISS store / manifest / parent maps. This is the
  // central belt behind the per-route requirePrimary guards: any document-mutation path that reaches here on a
  // replica (now or in future) is a safe no-op — the primary reflects the change when it next indexes.
  if (require('../cluster').isReplica()) { if (DEBUG) console.log('  (replica) skipping index reflect — the primary owns the shared index'); return; }
  try {
    await runLifecycleExclusive(async () => {
      if (wsId === state.workspaceId) await require('./delta').reindexNow();
      else if (typeof onNonActive === 'function') await onNonActive(wsId);
    });
  } catch (e) { if (DEBUG) console.error('❌ Post-change indexing/invalidate failed:', e.message || e); }
};

// Reflect a DOCUMENT change (an upload, or a desktop drag-drop ingest) into the index: reindex the active
// workspace, or reconcile a non-active one's on-disk cache. ONE definition of the reconcile callback, shared by
// every document-mutation path, so the two callers can't drift on how a doc change is reflected. Never throws.
const reflectDocChange = (wsId) =>
  reflectWorkspaceMutation(wsId, (id) => require('./bundle').reconcileWorkspaceDocsChange(id));

// Rebuild the active workspace's index from scratch against a LIVE server: wait for
// any in-flight index to finish, wipe the vector-store cache, then reindex. Used by
// the Settings "Rebuild index" action so users don't need a terminal. Returns
// { ok, documents } or throws.
const _forceReindexInner = async () => {
  // Wait out any in-flight index so we don't wipe cache mid-write.
  if (state.indexPromise) { try { await state.indexPromise; } catch {} }
  console.log('🗑️  Rebuild index requested from UI — wiping cache and reindexing…');
  // Mark not-ready for the rebuild window. wipeIndexCache empties the vector store AND the text
  // maps, so with indexReady left true a query mid-rebuild would see parentMap.size === 0 and be
  // told "this workspace has no documents — add some" while the whole corpus is on disk being
  // rebuilt. Clearing readiness makes it correctly report "building the index" instead, and
  // runDeltaUpdate does not restore readiness on its own.
  state.indexReady = false;
  // Hold the watcher off for the whole wipe+reindex. wipeIndexCache runs with indexing false and
  // indexPromise null, so without this gate a file-change event firing inside the wipe window would
  // start a concurrent delta against a half-deleted cache. runDeltaUpdate below is called directly, not
  // through triggerUpdate, so the gate never blocks the rebuild's own work.
  initializing = true;
  // Cancel any watcher delta already scheduled before this rebuild, and clear the schedule flag — the
  // timer's callback (which normally resets it) will never run now, so leaving it set would permanently
  // block every future debounced index after this rebuild.
  clearTimeout(debounceTimer); debounceScheduled = false;
  // Let any in-flight query finish reading the current index before we wipe it. A streaming turn
  // that already passed the "index ready" gate holds a reference to state and reads parentMap/
  // liveVectorStore live on each await; wiping underneath it would make it suddenly see an empty
  // corpus and return a spurious "no relevant information" / "outside what I can help with". Bounded
  // so a stuck query never blocks the rebuild — after the grace window we proceed anyway. Mirrors the
  // drain in switchWorkspace.
  const drainStart = Date.now();
  while ((state.activeQueries || 0) > 0 && Date.now() - drainStart < 5000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    await wipeIndexCache();
    await runDeltaUpdate();
  } finally {
    initializing = false;
    state.indexReady = true;
  }
  console.log('✅ Rebuild complete');
  return { ok: true, documents: state.parentMap ? state.parentMap.size : 0 };
};
// Public entry: run the rebuild alone, serialized against every other lifecycle operation.
const forceReindex = () => runLifecycleExclusive(_forceReindexInner);

// ── Orphaned-vector sweep ──────────────────────────────────────────────────────
// Reclaim vectors left in the active index whose owning document is gone — a document deleted from the
// corpus whose dense vectors were never removed. The normal delete path removes a deleted file's vectors by
// the STABLE store ids addVectors returned, but a corpus first indexed by a very old build recorded FAISS
// *positions* as a file's vector ids; those positions drift on every later delete, so that path can't trust
// them and skips the removal — leaving the vectors behind as dead weight until a full Rebuild. This sweep
// clears them WITHOUT re-embedding by deleting through the store's OWN current ids (authoritative, never the
// stale manifest positions), which FaissStore.delete re-sequences safely. It is self-healing: a legacy
// positional delete during a session is reclaimed on the next start.
//
// Scope: the active store — the single root index, or the active bank when embedding banks are on (which is
// the default). With banks on the active store persists under banks/<fingerprint>/, so the pruned store is
// written back with the same saveActiveStore the delta uses, and only the documents assigned to the active
// (or migrated-legacy) bank count toward its expected total — a document embedded in a FROZEN bank lives in
// a different store and is left to Settings → Consolidate embedding banks, which is what reclaims that space.
//
// A vector is deleted ONLY when its parentId is present and definitively not a live document — a vector we
// cannot positively classify (missing parentId) is left in place, so a live document is never dropped. The
// live set is built from the MANIFEST (the single source of truth for what is indexed), never from a
// possibly-partial warm-started parentMap. Two guards refuse to act on ambiguous input: an unreadable or
// empty manifest, and a run that would flag every vector. Fail-open throughout.

// Pure, test-friendly predicate: a vector is orphaned only when its parent id is known and not live.
const _isOrphanParent = (parentId, liveParents) => !!parentId && !liveParents.has(parentId);
// Pure, test-friendly: collect orphan vector ids from [vectorId, parentId] entries. Exported for tests.
const classifyOrphanVectorIds = (entries, liveParents) => {
  const out = [];
  for (const [vecId, parentId] of entries) if (_isOrphanParent(parentId, liveParents)) out.push(vecId);
  return out;
};

// Dependencies are injectable so the behavior can be tested without a real index, embedder, or disk,
// mirroring the project's other dependency-injected modules. Defaults bind to the live active store.
const _sweepOrphanVectorsInner = async (deps = {}) => {
  const cfg = require('../config');
  const {
    banksOn = cfg.useEmbeddingBanks,
    manifestLoader = loadManifest,
    idFor = docIdFor,
    save,                                 // default resolved below, once the active bank is known
    yieldEvery = 2000,
  } = deps;

  // Resolve the banks context first: the active fingerprint is needed BOTH to pick the active bank's store and
  // to count only its vectors. (migratedBankFp names the migrated-legacy bank and needs the manifest, so it is
  // resolved after the manifest loads.)
  let banksMod = null, activeMeta = null, activeFp = null, migratedBankFp = null;
  if (banksOn) {
    try {
      banksMod = require('./banks'); activeMeta = banksMod.currentMeta(cfg);
      // When the live config is a measured alias of an existing bank, the ACTIVE bank is the canonical one (its
      // fp), not the live fingerprint — resolve it so the sweep prunes and saves the right bank. Sync + fail-safe.
      const _canon = banksMod.aliasCanonical(banksMod.loadRegistry(cfgPaths.CACHE_DIR), activeMeta.fp);
      if (_canon) activeMeta = { ...activeMeta, fp: _canon };
      activeFp = activeMeta.fp;
    }
    catch { return { ok: true, skipped: 'banks-dir', swept: 0 }; }
  }

  // The store to prune. CRITICAL in banks mode: it must be the ACTIVE bank's OWN store, not
  // state.liveVectorStore — bundle.js points liveVectorStore at a FROZEN bank when the active bank has no store
  // yet (the normal state right after an embedding-model switch), and pruning that then saving it into the
  // active bank's directory would write old-model vectors into the new bank. Resolve the active bank
  // explicitly, exactly as the delta does; when it has no store yet there is simply nothing to sweep. A test
  // may inject `store` directly, which bypasses this resolution.
  const store = ('store' in deps) ? deps.store
    : (banksOn
        ? ((state.vectorBanks || []).find(b => b.fp === activeFp && b.store)?.store || null)
        : state.liveVectorStore);
  if (!store || !store.index) return { ok: true, skipped: 'no-store', swept: 0 };   // BM25-only, or an empty active bank

  let ntotal;
  try { ntotal = typeof store.index.ntotal === 'function' ? store.index.ntotal() : store.index.ntotal; }
  catch { return { ok: true, skipped: 'no-ntotal', swept: 0 }; }
  if (!Number.isFinite(ntotal) || ntotal <= 0) return { ok: true, swept: 0 };

  const manifest = await manifestLoader();
  // Never sweep against an unreadable manifest: loadManifest's fail-closed sentinel (or an absent manifest)
  // read as "no live documents" would classify the ENTIRE corpus as orphaned. Require a real one.
  if (!manifest || manifest._corrupt) return { ok: true, skipped: 'manifest', swept: 0 };

  // Now that the manifest is loaded, resolve the migrated-legacy bank so the active-vector count below reuses
  // the shared entryIsFrozen classifier with no drift from the delta's own active-versus-frozen decision.
  if (banksOn) {
    try { migratedBankFp = banksMod.migratedBankOf(banksMod.loadRegistry(cfgPaths.CACHE_DIR), activeMeta, manifest._embeddingModel); }
    catch { return { ok: true, skipped: 'banks-dir', swept: 0 }; }
  }

  const liveParents = new Set();
  let activeLiveVectorIds = 0, liveDocs = 0;
  for (const key of Object.keys(manifest)) {
    if (key.startsWith('_')) continue;   // metadata keys (_indexFormat, _embeddingModel, …), not documents
    liveDocs++;
    liveParents.add(idFor(key));
    const e = manifest[key];
    const len = Array.isArray(e && e.vectorIds) ? e.vectorIds.length : 0;
    // Only vectors the ACTIVE store should hold count toward its total — all of them without banks, only the
    // active/migrated bank's with banks on (reusing the shared entryIsFrozen classifier, so no drift with the
    // delta's own active-versus-frozen decision).
    if (!banksOn || !banksMod.entryIsFrozen(e, activeFp, migratedBankFp)) activeLiveVectorIds += len;
  }
  // A readable-but-empty manifest beside a non-empty store is ambiguous (a truncated manifest versus a
  // genuine full delete), so refuse to zero the store on that basis — a Rebuild is the right tool there.
  if (liveDocs === 0) return { ok: true, skipped: 'empty-manifest', swept: 0 };
  // Cheap gate: when the store holds no more vectors than its live documents account for, nothing is
  // orphaned — skip the enumeration entirely (the common, clean case, so most starts do no extra work).
  if (ntotal <= activeLiveVectorIds) return { ok: true, swept: 0 };

  // Enumerate the store's own id → document map (the authoritative structure its own save/delete use). Fail
  // open on any unexpected shape rather than guess. One pass yields id + parentId with no extra allocation.
  const ds = (typeof store.getDocstore === 'function') ? store.getDocstore() : store.docstore;
  const docs = ds && ds._docs;
  if (!(docs instanceof Map)) return { ok: true, skipped: 'shape', swept: 0 };

  const orphanIds = [];
  let scanned = 0;
  for (const [vecId, doc] of docs) {
    const parentId = doc && doc.metadata ? doc.metadata.parentId : null;
    if (_isOrphanParent(parentId, liveParents)) orphanIds.push(vecId);
    // Yield to the event loop periodically so a very large index never blocks it (non-blocking); only short
    // id strings are retained, so memory stays bounded regardless of corpus size (OOM-proof).
    if ((++scanned % yieldEvery) === 0) await new Promise((r) => setImmediate(r));
  }
  if (orphanIds.length === 0) return { ok: true, swept: 0 };
  // Last-resort guard: never delete every vector. Flagging all of them means the inputs are wrong (e.g. a
  // parent-id scheme mismatch) — skip and leave a Rebuild rather than empty the store.
  if (orphanIds.length >= docs.size) return { ok: true, skipped: 'all-flagged', swept: 0 };

  // Persist the pruned store the SAME way the delta does — to the active bank's directory with banks on, or
  // to the cache root without. One source of truth for "where the active store lives."
  const doSave = save || (banksOn
    ? (s) => banksMod.saveActiveStore(cfgPaths.CACHE_DIR, s, activeFp)
    : (s) => saveStoreAtomic(s, cfgPaths.CACHE_DIR));

  await store.delete({ ids: orphanIds });   // removes by id and re-sequences the mapping; no re-embed
  await doSave(store);
  try {
    const nt = store.index.ntotal;
    state.vectorCount = typeof nt === 'function' ? nt.call(store.index) : (nt ?? state.vectorCount);
  } catch { /* best-effort — the count display self-corrects on the next index */ }
  console.log(`🧹 Reclaimed ${orphanIds.length} orphaned vector${orphanIds.length === 1 ? '' : 's'} left by deleted documents — no re-embedding needed`);
  return { ok: true, swept: orphanIds.length };
};

// Concurrency wrapper around the pruning core. The lifecycle lock serializes this against a switch,
// rebuild, or consolidation, but a file-watcher delta does NOT take that lock — it is held off by the
// `initializing` gate and drained through `state.indexPromise`, exactly as forceReindex does. This matters
// for correctness, not just tidiness: a delta mutates the in-memory store (addVectors) BEFORE it writes the
// manifest, so reading the store mid-delta would see freshly-added live vectors as orphans (their file is
// not in the manifest yet) and delete them. So drain any in-flight delta, hold the gate for the whole
// read-and-prune, then reconcile anything the hold suppressed.
const _sweepOrphanVectorsGuarded = async () => {
  // Defense in depth: a read replica never writes the shared index (the primary owns it). The boot caller
  // already skips replicas, but guarding here too means a future caller can't reintroduce a shared-index write.
  if (require('../cluster').isReplica()) return { ok: true, skipped: 'replica', swept: 0 };
  if (state.indexPromise) { try { await state.indexPromise; } catch {} }   // let an in-flight delta finish first
  const hadPending = debounceScheduled;        // a delta was already scheduled — reschedule it afterward
  clearTimeout(debounceTimer); debounceScheduled = false;   // suppress it for our window (we re-arm below)
  const prev = initializing;
  _deferredDuringInit = false;                 // only events dropped during OUR hold should count below
  initializing = true;                         // block a new watcher delta while we scan and prune
  let result;
  try {
    result = await _sweepOrphanVectorsInner();
  } finally {
    initializing = prev;
    // Re-pick-up work the hold suppressed: a delta that was already scheduled, any file-change event the gate
    // dropped during our hold (unlike warm start/rebuild, the sweep does no rescan to cover it), or a prune we
    // actually made. A clean no-op sweep with no events re-arms nothing, so the common start pays no extra delta.
    if (hadPending || _deferredDuringInit || (result && result.swept > 0)) { try { triggerUpdate(); } catch {} }
  }
  return result;
};

// Public entry: run the sweep serialized against every other lifecycle operation (so it never races a
// delta, switch, rebuild, or consolidation). Fire-and-forget at boot on the primary only; never throws.
const sweepOrphanVectors = () => runLifecycleExclusive(_sweepOrphanVectorsGuarded).catch((e) => {
  if (DEBUG) console.log('  orphan-vector sweep skipped:', e && e.message);
  return { ok: false, swept: 0 };
});

// Consolidate embedding banks: after switching embedding models you may have several
// banks (the frozen old one plus the active new one). This re-embeds every document with
// the CURRENT model into a single fresh bank and removes the rest — reclaiming the space
// the frozen banks used.
//
// It is ADDITIVE and RESUMABLE, not a wipe-and-rebuild: documents are moved into the active bank in bounded
// batches through the normal delta path (each batch commits durably), every older bank stays loaded and
// searchable the whole time, and an interrupted run resumes from the documents still tagged to an old bank.
// Only when the manifest confirms no document points at a frozen bank are those banks deleted. A progress
// marker in the cache dir records the target and the remaining count, so the Settings health panel can
// explain an unfinished run and the next Consolidate continues it.
const BANK_REEMBED_BATCH = 250;

// How many indexed documents still live in a bank other than `targetFp`. Skipped/vectorless entries have
// nothing to move, so they are not counted (they would otherwise keep a migration "unfinished" forever).
// Uses the shared banks classifier, so an untagged (pre-banks) entry is counted exactly when the purge path
// would treat it as frozen.
const frozenDocCount = (manifest, targetFp, migratedFp) => {
  let n = 0;
  for (const key of Object.keys(manifest || {})) {
    if (key.startsWith('_')) continue;
    if (require('./banks').entryIsFrozen(manifest[key], targetFp, migratedFp)) n++;
  }
  return n;
};

// How many documents truly have vectors in the target bank. Used to tell a genuine re-embed from a batch that
// only marked documents retry-pending during an embedding outage: the frozen count falls either way, but only a
// real move raises this. A batch that lowers the frozen count without raising this must pause, not consume the
// migration list.
const activeVectorCount = (manifest, targetFp) => {
  let n = 0;
  for (const key of Object.keys(manifest || {})) {
    if (key.startsWith('_')) continue;
    const e = manifest[key];
    if (e && e.bank === targetFp && Array.isArray(e.vectorIds) && e.vectorIds.length) n++;
  }
  return n;
};

let _consolidating = false;   // a live Consolidate run, so the watchdog can tell it from a stale marker
const banksMigrationRunning = () => _consolidating;

// A one-query health check before a migration batch. It must not turn a healthy provider into a false pause:
// any non-empty vector result counts, including a typed array from providers that do not return a plain array.
const probeEmbeddingProvider = async () => {
  try {
    const v = await embedBounded(makeEmbeddings().embedQuery('ping'));
    return !!v && (Array.isArray(v) || ArrayBuffer.isView(v)) && v.length > 0;
  } catch { return false; }
};

const _consolidateBanksInner = async () => {
  _consolidating = true;
  try {
    const cfg = require('../config');
    if (!cfg.useEmbeddingBanks) throw new Error('Embedding banks are not enabled');
    if (state.indexPromise) { try { await state.indexPromise; } catch {} }
    const banks = require('./banks');
    const cacheDir = cfg.CACHE_DIR;
    // Resolve the alias so a consolidation run targets the CANONICAL bank when the live config is a measured
    // alias — never forking a spurious bank or re-embedding what an equivalent bank already holds.
    const meta = await banks.resolveActiveForWrite(cacheDir, { makeEmbeddings });
    banks.ensureActive(cacheDir, meta);   // idempotent; guarantees the target bank exists even after a restart

    const prev = banks.readMigration(cacheDir);
    const resume = prev && prev.target === meta.fp && prev.status !== 'done';
    const marker = {
      target: meta.fp,
      startedAt: resume ? (prev.startedAt || Date.now()) : Date.now(),
      updatedAt: Date.now(),
      status: 'running',
      total: 0,
      remaining: 0,
    };
    const reg0 = banks.loadRegistry(cacheDir);
    const manifest0 = await loadManifest();
    const migratedFp0 = banks.migratedBankOf(reg0, meta, manifest0._embeddingModel);
    marker.remaining = frozenDocCount(manifest0, meta.fp, migratedFp0);
    marker.total = resume && prev.total ? Math.max(prev.total, marker.remaining + (prev.done || 0)) : marker.remaining;
    marker.done = Math.max(0, marker.total - marker.remaining);
    banks.writeMigration(cacheDir, marker);
    state.bankMigration = { ...marker };
    console.log(`🏦 Consolidating embedding banks — ${marker.remaining} document(s) to move into the active bank${resume ? ' (resuming)' : ''}…`);

    try {
      // Each pass commits one bounded batch. A pass that moves nothing means the provider is unavailable (or
      // the same documents fail repeatedly): pause rather than spin, keep the marker, and let the next
      // Consolidate resume. `remaining` strictly decreasing is the progress guarantee.
      let attempts = 0;
      const MAX_ATTEMPTS = Math.ceil(Math.max(1, marker.total) / BANK_REEMBED_BATCH) + 25;
      let currentManifest = manifest0;
      // One stat-validated hash cache for the whole run: the corpus is unchanged between batches except for
      // external edits, and those change the stat and are re-hashed. The Map is scoped to this run.
      const hashCache = require('./hashcache').create();
      while (marker.remaining > 0) {
        const before = marker.remaining;
        const activeBefore = activeVectorCount(currentManifest, meta.fp);
        // Probe the embedding endpoint BEFORE a batch purges/rebuilds documents. If it is down, pause with every
        // document still in its old bank and still searchable, instead of consuming a batch's mappings only to
        // mark them retry-pending. One tiny query per 250 documents is negligible.
        if (!(await probeEmbeddingProvider())) {
          marker.status = 'paused';
          marker.updatedAt = Date.now();
          state.bankMigration = { ...marker };
          banks.writeMigration(cacheDir, marker);
          console.warn(`⚠️  Bank re-embed paused before changing documents — the embedding provider is not responding. Run Settings → Consolidate embedding banks to resume; everything remains searchable.`);
          return { ok: false, paused: true, moved: marker.done, remaining: marker.remaining };
        }
        await runDeltaUpdate({ reembedFp: meta.fp, reembedLimit: BANK_REEMBED_BATCH, hashCache });
        const nextManifest = await loadManifest();
        const nextMigrated = banks.migratedBankOf(banks.loadRegistry(cacheDir), meta, nextManifest._embeddingModel);
        const next = frozenDocCount(nextManifest, meta.fp, nextMigrated);
        const activeAfter = activeVectorCount(nextManifest, meta.fp);
        marker.remaining = next;
        marker.done = Math.max(0, marker.total - marker.remaining);
        marker.updatedAt = Date.now();
        state.bankMigration = { ...marker };
        banks.writeMigration(cacheDir, marker);
        require('../logbuffer').progress(`   Re-embedding: ${marker.done}/${marker.total} moved into the current bank`);
        // A genuine move requires vectors to appear in the target bank. The frozen count can fall because a
        // failed batch marked documents retry-pending, so pause unless the active vector count actually rose;
        // otherwise an embedding outage would strip dense vectors instead of waiting.
        const genuinelyMoved = activeAfter > activeBefore;
        if (next >= before || (next < before && !genuinelyMoved)) {
          marker.status = 'paused';
          marker.updatedAt = Date.now();
          state.bankMigration = { ...marker };
          banks.writeMigration(cacheDir, marker);
          console.warn(`⚠️  Bank re-embed paused with ${marker.remaining} document(s) left — the embedding provider may be unavailable, or some documents are temporarily unreadable. Run Settings → Consolidate embedding banks to resume; nothing already moved is lost.`);
          return { ok: false, paused: true, moved: marker.done, remaining: marker.remaining };
        }
        currentManifest = nextManifest;
        if (++attempts > MAX_ATTEMPTS) {
          // A safety ceiling, not an expected path: the remaining count must strictly fall each pass.
          marker.status = 'paused';
          state.bankMigration = { ...marker };
          banks.writeMigration(cacheDir, marker);
          return { ok: false, paused: true, moved: marker.done, remaining: marker.remaining };
        }
      }

      // Every document now lives in the target bank, so the older stores are unreferenced. Remove them one at
      // a time, then drop their registry rows. Only then is the marker cleared: a crash during cleanup leaves
      // the marker and the next run finishes the cleanup (no documents remain to move).
      const removed = await banks.removeBanksExcept(cacheDir, meta.fp);
      banks.clearMigration(cacheDir);
      state.bankMigration = { target: meta.fp, status: 'done', total: marker.total, done: marker.total, remaining: 0, updatedAt: Date.now() };
      console.log(`✅ Consolidation complete — one bank for the current embedding model${removed.length ? ` (removed ${removed.length} old bank${removed.length === 1 ? '' : 's'})` : ''}`);
      return { ok: true, moved: marker.total, removed: removed.length };
    } catch (e) {
      // A thrown batch (disk error, provider crash) also leaves a resumable marker rather than starting over.
      marker.status = 'paused';
      marker.updatedAt = Date.now();
      state.bankMigration = { ...marker };
      banks.writeMigration(cacheDir, marker);
      throw e;
    }
  } finally { _consolidating = false; }
};
const consolidateBanks = () => {
  // Set the flag BEFORE queueing on the lifecycle lock, so a second click while the first is still waiting
  // is rejected (by the route) and skipped (here) instead of queueing a duplicate full migration.
  if (_consolidating) return Promise.resolve({ ok: false, skipped: true, note: 'already running' });
  _consolidating = true;
  return runLifecycleExclusive(_consolidateBanksInner).finally(() => { _consolidating = false; });
};

// Post-switch maintenance, fire-and-forget. FIRST fit query adapters from the new active model into each frozen
// bank, while the old providers are typically still reachable, so those banks keep dense recall without their
// provider. THEN, if a frozen bank still has no viable translation, its documents are dense-searchable only by
// their lexical signal and a re-embed would restore them. For a LOCAL, no-cost embedder (Ollama) start that
// consolidation automatically in the background — it is resumable and non-blocking, and every existing result
// keeps serving while it runs — so a genuinely different model never leaves a lasting gap and never blocks the
// user. For a METERED provider Lokyni never auto-spends; the manual Consolidate action remains. Idempotent
// (consolidateBanks self-guards a running migration), bounded, crash-proof — it never blocks a switch.
const afterEmbeddingSwitch = async () => {
  try {
    const cfg = require('../config');
    if (!cfg.useEmbeddingBanks) return;
    const cacheDir = cfg.CACHE_DIR;
    const banks = require('./banks');
    try { await banks.fitAdaptersForFrozenBanks(cacheDir, { FaissStore, makeEmbeddings }); } catch { /* best-effort */ }
    if (!_consolidating && cfg.isFreeEmbeddingProvider(cfg.EMBEDDINGS_PROVIDER) && banks.anyFrozenWithoutViableAdapter(cacheDir)) {
      console.log('🏦 A switched-away embedding model left documents without a dense translation — consolidating in the background (local embedder, no cost; existing results keep serving).');
      consolidateBanks().catch(() => {});
    }
  } catch { /* best-effort — never blocks a switch */ }
};

// Fail-safe SCOPED crash recovery for a consolidation interrupted mid-batch. A consolidation re-embeds documents
// from frozen banks into the ACTIVE bank one batch at a time, each batch wrapped in a write-ahead commit marker.
// A crash inside a batch leaves the marker PENDING while the resumable migration marker is still in progress. The
// default recovery (contentRebuildReason below) would then wipe EVERY bank and re-embed the whole corpus — which
// is safe but throws away the intact frozen banks and the migration's progress. The torn write is always in the
// ACTIVE bank (a batch only ever embeds there), so repair just that bank: remove its store and drop its own
// documents' manifest entries, so the next delta re-embeds exactly those documents into a clean active bank. The
// frozen banks (the un-moved majority) and the migration marker are preserved, so the move resumes.
//
// SAFETY: this only ever runs when banks are on AND a commit is pending AND a migration is genuinely in progress,
// and it returns false on ANY uncertainty (unreadable manifest, classification trouble, an I/O error) — in which
// case the caller falls back to the full wipe+rebuild. So it can only IMPROVE on, never regress, the safe default.
// It clears the commit marker on success, so contentRebuildReason no longer reports a pending commit and the
// normal delta path re-embeds the stripped documents. Returns true when it repaired, false otherwise.
// `deps` lets the crash-simulation test inject a temp cacheDir, a config, and a capturing saveManifest; boot
// passes none and everything resolves to the live workspace paths.
const repairInterruptedConsolidation = async (manifest, deps = {}) => {
  try {
    const cfg = deps.cfg || require('../config');
    const cacheDir = deps.cacheDir || cfgPaths.CACHE_DIR;
    const saveManifestFn = deps.saveManifest || require('./manifest').saveManifest;
    if (!cfg.useEmbeddingBanks) return false;
    if (!require('./commitmarker').isPending(cacheDir)) return false;
    if (!manifest || manifest._corrupt || typeof manifest !== 'object') return false;
    const banks = require('./banks');
    const migration = banks.readMigration(cacheDir);
    // Only the genuinely-in-progress case: a real target with work still remaining. A done/absent marker is not it.
    if (!migration || migration.status === 'done' || !(Number(migration.remaining) > 0)) return false;
    const reg = banks.loadRegistry(cacheDir);
    // Resolve the ACTIVE bank fp exactly as the sweep and delta do (alias-canonical), so this classifies against
    // the same active bank — no drift in which documents count as "active".
    let activeMeta = banks.currentMeta(cfg);
    const canon = banks.aliasCanonical(reg, activeMeta.fp);
    if (canon) activeMeta = { ...activeMeta, fp: canon };
    const activeFp = activeMeta.fp;
    const migratedFp = banks.migratedBankOf(reg, activeMeta, manifest._embeddingModel);
    // The ACTIVE-bank vector documents: they have vectors AND are not frozen. Only these can hold the torn write,
    // so only these are stripped for re-embedding; name-only documents (no vectors) and frozen documents are left
    // exactly as they are.
    const activeKeys = [];
    for (const key of Object.keys(manifest)) {
      if (key.startsWith('_')) continue;
      const e = manifest[key];
      if (e && Array.isArray(e.vectorIds) && e.vectorIds.length > 0 && !banks.entryIsFrozen(e, activeFp, migratedFp)) {
        activeKeys.push(key);
      }
    }
    // Clear the torn active-bank vectors, keeping every other bank and the bank's own identity/adapters.
    await banks.wipeBankStore(cacheDir, activeFp);
    for (const key of activeKeys) delete manifest[key];
    await saveManifestFn(manifest);
    // The torn write is undone and the manifest is consistent again, so retire the commit marker. The normal delta
    // re-embeds the stripped documents into the clean active bank, and the consolidation resumes from its marker.
    require('./commitmarker').end(cacheDir);
    console.log(`🏦 Recovered an interrupted consolidation — rebuilding only the current bank (${activeKeys.length} document(s) to re-embed) and keeping the others; the move will resume.`);
    return true;
  } catch (e) { if (DEBUG) console.log('  scoped consolidation repair skipped:', e && e.message); return false; }
};

// Reasons an existing index must be fully rebuilt because the stored TEXT or map SHAPE of its
// documents is now stale — independent of the embedding MODEL (which the banks path handles
// without a wipe). Returns a human reason string, or null when the cached index is still valid.
// Single-sourced so BOTH the single-index and the embedding-banks warm paths enforce it and
// can't drift (the banks path previously skipped these, so a pipeline-version bump silently did
// nothing there). A missing stored version is grandfathered (=== undefined → not a trigger).
const contentRebuildReason = async (manifest, manifestExists) => {
  if (!manifestExists) return null;
  // A present-but-unparseable manifest (loadManifest's fail-closed sentinel) must force a clean rebuild, not
  // be read as empty — otherwise the delta treats every document as new and re-embeds over the existing
  // vectors (duplicate-vector bloat). This is the FIRST check so corruption always wins.
  if (manifest && manifest._corrupt) return 'Manifest is unreadable (corrupt) — rebuilding from documents';
  // A write-ahead commit marker still present means the last index delta crashed between writing the vectors
  // and finishing the manifest/maps, so the on-disk vectors may hold duplicates or orphans. Rebuild from the
  // documents to drop them (the same duplicate-vector class the corrupt-manifest case guards against).
  if (require('./commitmarker').isPending(cfgPaths.CACHE_DIR)) {
    return 'The previous index update did not finish — rebuilding from documents to drop any duplicate vectors';
  }
  const cfg = require('../config');
  const INDEX_FORMAT_VERSION = require('../constants').INDEX_FORMAT_VERSION;
  if (manifest._indexFormat !== undefined && manifest._indexFormat !== INDEX_FORMAT_VERSION) {
    return `Index format changed (${manifest._indexFormat} → ${INDEX_FORMAT_VERSION})`;
  }
  if (cfg.USE_OCR || cfg.VISION_DESCRIBE) {
    const cur = require('../ocrcache').OCR_PIPELINE_VERSION;
    if (manifest._ocrPipeline !== undefined && manifest._ocrPipeline !== cur) {
      return `OCR pipeline changed (${manifest._ocrPipeline} → ${cur})`;
    }
  }
  // OCR (or vision-describe) was OFF when the index was built and is now ON: scanned documents that were
  // indexed by name only can now be read, so rebuild to re-OCR them rather than leaving them name-only.
  // `=== false` (not `!`) so a pre-existing manifest without the flag is grandfathered, not force-rebuilt.
  if (cfg.USE_OCR && manifest._ocrEnabled === false) return 'OCR was turned on';
  if (cfg.VISION_DESCRIBE && manifest._visionEnabled === false) return 'Vision describe was turned on';
  // The other content-affecting features, same rule: turning one ON re-indexes the whole corpus so the feature
  // covers every existing document, not only those edited afterward. `=== false` grandfathers an older manifest
  // without the stamp (no spurious rebuild); the visual-ingest PIPELINE-version check below still handles bumps.
  if (cfg.useDocumentSummaries && manifest._summariesEnabled === false) return 'Document summaries were turned on';
  if (cfg.useContextualRetrieval && manifest._contextualEnabled === false) return 'Contextual retrieval was turned on';
  if (cfg.useVisualIngest && manifest._visualEnabled === false) return 'Visual ingest was turned on';
  // A change to an OCR setting that alters the extracted text must re-OCR the scanned documents, or a
  // document scanned at a lower page cap stays truncated and "raise Max pages and re-index" does nothing.
  // Guarded by `!== undefined` so an older manifest without the stamp is grandfathered, not force-rebuilt.
  if (cfg.USE_OCR && manifest._ocrMaxPages !== undefined && manifest._ocrMaxPages !== cfg.OCR_MAX_PAGES) {
    return `OCR page cap changed (${manifest._ocrMaxPages} → ${cfg.OCR_MAX_PAGES})`;
  }
  if (cfg.USE_OCR && manifest._ocrEngine !== undefined && manifest._ocrEngine !== (cfg.OCR_ENGINE || 'tesseract')) {
    return `OCR engine changed (${manifest._ocrEngine} → ${cfg.OCR_ENGINE || 'tesseract'})`;
  }
  if (cfg.USE_OCR && cfg.OCR_ENGINE === 'tesseract' && manifest._ocrLanguages !== undefined) {
    const cur = (cfg.OCR_LANGUAGES || []).slice().sort().join('+');
    if (manifest._ocrLanguages !== cur) return `OCR languages changed (${manifest._ocrLanguages || 'eng'} → ${cur ? 'eng+' + cur : 'eng'})`;
  }
  // The embedding context window changes every document's chunking → its embedding vectors, so a change must
  // re-embed the corpus. `!== undefined` grandfathers an older manifest without the stamp (no spurious rebuild).
  if (manifest._embeddingContextTokens !== undefined && manifest._embeddingContextTokens !== cfg.EMBEDDING_CONTEXT_TOKENS) {
    return `Embedding context window changed (${manifest._embeddingContextTokens} → ${cfg.EMBEDDING_CONTEXT_TOKENS})`;
  }
  if (cfg.USE_OCR && cfg.OCR_ENGINE === 'vision' && manifest._ocrVisionModel !== undefined && manifest._ocrVisionModel !== (cfg.OCR_VISION_MODEL || '')) {
    return `OCR vision model changed (${manifest._ocrVisionModel} → ${cfg.OCR_VISION_MODEL || ''})`;
  }
  // Image-describe (VISION_DESCRIBE) output is cached in the OCR cache keyed only on the image bytes + pipeline
  // version, so a change to the describe model or its params would otherwise serve a stale description for an
  // unchanged image. Compare the single-sourced describe signature (same helper delta.js stamps) and rebuild on a
  // change — the rebuild wipes the OCR cache, forcing a re-describe. `!== undefined` grandfathers older manifests.
  if (cfg.VISION_DESCRIBE && manifest._visionDescribeSig !== undefined
      && manifest._visionDescribeSig !== require('../vision').describeSignature(cfg)) {
    return 'Vision describe settings changed';
  }
  if (cfg.useVisualIngest) {
    const cur = require('../visualcache').VISUAL_PIPELINE_VERSION;
    if (manifest._visualPipeline !== undefined && manifest._visualPipeline !== cur) {
      return `Visual-ingest pipeline changed (${manifest._visualPipeline} → ${cur})`;
    }
  }
  // A "documents were moved" case — every manifest id stale because the documents directory relocated
  // (doc ids are full-path hashes) — is intentionally NOT handled with a boot-time wipe. A wipe here
  // is GLOBAL and destructive: it clears the manifest and index for every root at once, so an
  // empty-mounted or vanished source among several would wrongly drop the WHOLE corpus. offlineRoots
  // cannot tell a cleanly-empty-but-statable mount (an automount placeholder, a bind mount whose
  // source vanished, a volume mounted empty) from a real move, and any positive "files exist"
  // heuristic is defeated by OS junk (a .DS_Store) or one stray file on any root. So warm-load the
  // existing index and let the delta pass reconcile PER ROOT instead: a genuine move re-indexes files
  // at their new path-hash ids and purges the old ones, while a vanished/empty-mounted root is HELD
  // (see the per-root hold in runDeltaUpdate). Deferring to delta never destroys data at boot.
  return null;
};

// Read-only: would a content-affecting settings change force a full rebuild right now? Reuses the SAME
// contentRebuildReason the rebuild path uses (one source of truth — no drift between "does it rebuild" and
// "do we tell the user it's rebuilding"), without triggering anything. Returns the reason string or null.
// Used by the settings-save response so the UI can tell the user their change is being applied (the actual
// rebuild runs in the background via refreshSources). Never throws.
const contentRebuildPending = async () => {
  try {
    const manifestExists = await fs.access(path.join(cfgPaths.CACHE_DIR, CACHE_FILES.manifest)).then(() => true).catch(() => false);
    if (!manifestExists) return null;
    return await contentRebuildReason(await loadManifest(), true);
  } catch { return null; }
};

// Load the resumable bank re-embed marker into memory for the active workspace. The marker is read ONCE per
// workspace load/switch rather than on every /status poll, so the status endpoint never touches the disk.
const hydrateBankMigration = () => {
  try {
    const cfg = require('../config');
    state.bankMigration = cfg.useEmbeddingBanks ? require('./banks').readMigration(cfg.CACHE_DIR) : null;
  } catch { state.bankMigration = null; }
};

// Thin wrapper that holds the watcher-gate for the whole load. The watcher is armed before the index
// finishes loading (lokyni.js starts it before awaiting initIndex), and the load has no in-flight
// state.indexPromise for triggerUpdate to dedupe against, so without this gate a file-change event could
// start a delta that snapshots a half-loaded parentMap and persists it as a partial cache. Covers every
// return path (including the early rebuild-and-return branches) via finally.
const initIndex = async (opts) => {
  initializing = true;
  try {
    const r = await _initIndexInner(opts);
    // Seed the index-generation timestamp on warm start. The warm-start paths mark the index ready but
    // never set lastIndexedAt, so it stayed null until the first delta — needlessly cold-starting the
    // semantic cache and entity graph after every restart, and disagreeing with the value a non-active
    // bundle uses (the manifest mtime). Seed it to the same manifest mtime so the two time bases agree
    // and those caches survive a restart. A delta later overwrites it with Date.now() as before.
    if (state.indexReady && !state.lastIndexedAt) {
      try { state.lastIndexedAt = require('./bundle').manifestMtimeFor(state.workspaceId) || null; } catch { /* best-effort */ }
    }
    return r;
  } finally { initializing = false; }
};

// ── Read-only index load for a cluster read replica ───────────────────────────
// A replica never writes the shared index — the primary owns all indexing. It loads the active workspace's
// on-disk index into `state` read-only (the SAME bundle→state assignment warm start uses, but with NO delta,
// NO embedding, NO watcher), then refreshes when the primary updates the shared files (detected by the
// manifest mtime). This keeps the entire query path unchanged: `state` looks like a normally-built index, it
// is simply never mutated here. Never throws into boot — a load failure leaves an empty-but-ready index and
// the next refresh retries.
let _roMtime = null;
let _roChain = Promise.resolve();   // serialize loads so two refreshes can't interleave a half-applied swap
const loadReadOnlyInto = async (wsId) => {
  const bundleMod = require('./bundle');
  const b = await bundleMod.loadWorkspaceBundle(wsId);   // read-only: builds a complete bundle from disk
  // Assign the fields in one synchronous block so a concurrent query never sees a half-swapped index.
  for (const f of bundleMod.INDEX_FIELDS) state[f] = b[f];
  state.workspaceId = wsId;
  hydrateBankMigration();
  state.lastIndexedAt = b.lastIndexedAt || bundleMod.manifestMtimeFor(wsId) || Date.now();
  state.vectorCount = (b.liveVectorStore && b.liveVectorStore.index && typeof b.liveVectorStore.index.ntotal === 'function')
    ? (() => { try { return b.liveVectorStore.index.ntotal(); } catch { return state.vectorCount; } })() : state.vectorCount;
  state.indexReady = true;
  _roMtime = bundleMod.manifestMtimeFor(wsId);
};
const initIndexReadOnly = async () => {
  const { DATA_DIR } = require('../config');
  const { getLastActive, ensureUsableWorkspace } = require('../workspaces');
  let wsId;
  try { wsId = ensureUsableWorkspace(DATA_DIR, getLastActive(DATA_DIR)); } catch { wsId = state.workspaceId || 'default'; }
  state.workspaceId = wsId;
  _roChain = _roChain.catch(() => {}).then(() => loadReadOnlyInto(wsId).catch((e) => {
    console.warn(`⚠️  Read replica: could not load the index (will retry): ${e && e.message ? e.message : e}`);
    state.indexReady = true;   // ready but possibly empty; the next refresh retries
  }));
  return _roChain;
};
// Reload the active workspace from disk when the primary has updated it (manifest mtime changed). Cheap when
// nothing changed (one stat). Serialized with the initial load. Best-effort; never throws.
const refreshReadOnly = async () => {
  try {
    const bundleMod = require('./bundle');
    const wsId = state.workspaceId;
    const m = bundleMod.manifestMtimeFor(wsId);
    if (m === _roMtime) return false;   // unchanged — nothing to do
    _roChain = _roChain.catch(() => {}).then(() => loadReadOnlyInto(wsId).catch(() => {}));
    await _roChain;
    return true;
  } catch { return false; }
};
// Change which workspace a read replica serves as "active" — a read-only load of the target (no write-path
// switch). Returns true if the workspace exists and was loaded.
const switchReadOnly = async (wsId) => {
  const wsm = require('../workspaces');
  const { DATA_DIR } = require('../config');
  if (!wsm.exists(DATA_DIR, wsId)) return false;
  state.workspaceId = wsId;
  _roChain = _roChain.catch(() => {}).then(() => loadReadOnlyInto(wsId).catch(() => {}));
  await _roChain;
  return true;
};
// Start the replica refresh poller (unref'd so it never holds the process open). Returns the timer.
const startReadOnlyRefresh = (intervalMs = 10000) => {
  const t = setInterval(() => { refreshReadOnly().catch(() => {}); }, intervalMs);
  if (t.unref) t.unref();
  return t;
};

const _initIndexInner = async ({ forceRebuild = false, keepWorkspace = false } = {}) => {
  // Move a pre-workspaces install (data/documents, data/vector_store) into the
  // default workspace. No-op once done, so an existing index survives the upgrade
  // without re-embedding.
  const { migrateLegacyLayout, ensureUsableWorkspace, migrateLegacySources, getLastActive } = require('../workspaces');
  const { DATA_DIR } = require('../config');
  const st = require('../state');
  try {
    migrateLegacyLayout(DATA_DIR);
    // Reopen the workspace the user was last in, rather than always starting on the default.
    // Falls back to the default when nothing valid is stored. Skipped on a workspace SWITCH
    // (keepWorkspace): the caller has already set state.workspaceId, and re-deriving it from the
    // persisted "last active" would load the WRONG workspace if that best-effort write had failed.
    if (!keepWorkspace) st.workspaceId = getLastActive(DATA_DIR);
    // Copy any legacy global sourcePaths into the default workspace so it stops
    // depending on a config.json entry that saving folders elsewhere would remove.
    try {
      // Use the canonical config path + shared reader rather than a raw './config.json'
      // (which only resolves when cwd is the install dir).
      migrateLegacySources(DATA_DIR, require('../config').readRawConfig().sourcePaths);
    } catch { /* no config.json, or no legacy folders — nothing to move */ }
    // Guarantees a usable workspace exists and that state points at it. If the
    // active workspace's directory was removed, this recreates it (or falls back to
    // the default) rather than letting every path resolve to something unreadable.
    const usable = ensureUsableWorkspace(DATA_DIR, st.workspaceId);
    if (usable !== st.workspaceId) {
      console.warn(`⚠️  Workspace "${st.workspaceId}" was unavailable — using "${usable}"`);
      st.workspaceId = usable;
    }
  } catch (e) {
    console.warn(`⚠️  Workspace setup: ${e.message}`);
  }
  // Hydrate AFTER the active workspace id is final (last-active restore or a keepWorkspace switch), so the
  // marker comes from the workspace actually loaded. This is per load/switch, never per /status poll.
  hydrateBankMigration();

  await fs.mkdir(cfgPaths.CACHE_DIR, { recursive: true });
  const embeddings = makeEmbeddings();

  const manifestExists = await fs.access(path.join(cfgPaths.CACHE_DIR, CACHE_FILES.manifest)).then(() => true).catch(() => false);
  const faissExists    = await fs.access(path.join(cfgPaths.CACHE_DIR, CACHE_FILES.faissIndex)).then(() => true).catch(() => false);
  const manifest       = manifestExists ? await loadManifest() : {};

  // Embedding banks path. Migrate any pre-banks single index into a bank, activate the
  // current model's bank (a model change just adds a NEW active bank — no wipe), then warm
  // the workspace via the shared bundle loader and run a delta. This deliberately bypasses
  // the single-index warm-start and the model-change rebuild below: with banks, changing
  // the embedding model must NOT wipe and re-embed the corpus.
  if (require('../config').useEmbeddingBanks) {
    const banks = require('./banks');
    // Before deciding on a full rebuild: if a consolidation was interrupted mid-batch (a pending commit marker
    // while a migration is still in progress), repair ONLY the active bank and keep the others, instead of wiping
    // everything. Fail-safe — on any uncertainty it leaves the pending marker in place, so contentRebuildReason
    // below still triggers the safe full rebuild. It mutates `manifest` in place (dropping the active docs it will
    // re-embed) and clears the commit marker when it succeeds.
    await repairInterruptedConsolidation(manifest);
    // Even with banks, a change that makes the stored TEXT or map SHAPE of existing documents
    // stale (index-format bump, OCR/visual pipeline bump, or the documents folder moving) needs
    // a full rebuild regardless of embedding model — otherwise a delta, which only re-embeds
    // files whose BYTES changed, would keep serving the old text forever. (A model change is the
    // one thing banks handle without a wipe, so it is not a trigger here.)
    const reason = await contentRebuildReason(manifest, manifestExists);
    // An index artifact present with NO manifest means the manifest — the commit marker — is gone while
    // index data remains: a pre-banks root faiss.index whose manifest was dropped, OR (the crash case) a
    // consolidate/rebuild that removed the manifest but died before it cleared banks/ (wipeIndexCache removes
    // the manifest before the bank layout). Without catching the banks case here, the leftover frozen banks
    // would load AND a fresh active bank would re-embed the whole corpus on top — duplicate vectors across
    // banks, with no auto-heal. Treat either a root index or a bank layout with no manifest as stale and
    // rebuild cleanly (the rebuild wipes banks/ first). A genuine first run has neither artifact, so it
    // builds normally rather than rebuilding.
    const staleNoManifest = (faissExists || orphanedBanksPresent(cfgPaths.CACHE_DIR)) && !manifestExists;
    if (forceRebuild || reason || staleNoManifest) {
      const why = forceRebuild ? 'Forced rebuild requested' : (reason || 'No manifest found alongside the existing index');
      console.log(`🗑️  ${why} — wiping and reindexing (banks)`);
      await wipeIndexCache();
      await runDeltaUpdate();
      state.indexReady = true;
      return;
    }
    try { banks.migrateLegacy(cfgPaths.CACHE_DIR, manifest._embeddingModel); }
    catch (e) { if (DEBUG) console.log('  bank migrate skipped:', e.message); }
    // Reuse an equivalent existing bank when the live config is measured-compatible with the active bank (the
    // same model served by a different provider/endpoint) instead of forking a new one — no re-embed. Fail-safe:
    // any measurement trouble falls back to a normal switch.
    const resolvedMeta = await banks.resolveActiveForWrite(cfgPaths.CACHE_DIR, { makeEmbeddings });
    const { changed } = banks.ensureActive(cfgPaths.CACHE_DIR, resolvedMeta);
    if (changed) {
      const liveCfg = require('../config');
      const liveMeta = banks.currentMeta(liveCfg);
      const identityChanged = manifest._embeddingIdentity
        ? manifest._embeddingIdentity !== liveMeta.fp
        : (manifest._embeddingModel && !sameModel(manifest._embeddingModel, liveCfg.EMBEDDINGS_MODEL));
      if (identityChanged) {
        console.log(`🏦 Embedding identity changed (now ${liveMeta.provider} · ${liveMeta.model}) — added a new active bank; existing documents stay searchable, no rebuild.`);
      }
      // Fit query adapters from the new active model into each frozen bank (while the old providers are typically
      // still reachable), then auto-consolidate in the background on a no-cost local embedder if a gap remains.
      // Fire-and-forget, bounded, idempotent, fail-safe — it never blocks warm start.
      try { afterEmbeddingSwitch().catch(() => {}); } catch { /* best-effort */ }
    }
    const bundleMod = require('./bundle');
    const b = await bundleMod.loadWorkspaceBundle(state.workspaceId);
    for (const f of bundleMod.INDEX_FIELDS) state[f] = b[f];
    try {
      const nt = state.liveVectorStore?.index?.ntotal;
      state.vectorCount = typeof nt === 'function' ? nt.call(state.liveVectorStore.index) : (nt ?? 0);
    } catch { state.vectorCount = 0; }
    await runDeltaUpdate();
    state.indexReady = true;
    return;
  }

  let needsRebuild = forceRebuild;
  if (forceRebuild) console.log('🗑️  Forced rebuild requested — wiping index and reindexing from documents');

  if (faissExists && !manifestExists) {
    DEBUG && console.log('⚠️  No manifest found alongside FAISS cache — forcing clean rebuild');
    needsRebuild = true;
  }
  // Embedding banks were turned OFF at runtime after being used: the on-disk index now lives
  // under banks/, and there is no single root faiss.index for this path to load. Without this
  // the warm start would find nothing, serve an empty corpus, and (on the next document change)
  // write a root index holding only that one document — silently losing everything else. Rebuild
  // the single index from the documents, symmetrically with how ENABLING banks migrates in place.
  if (!needsRebuild && !faissExists && orphanedBanksPresent(cfgPaths.CACHE_DIR)) {
    console.log('⚠️  Embedding banks were disabled — rebuilding the single index from documents');
    needsRebuild = true;
  }
  // Compare the full embedding identity (provider + model + endpoint), not just the model name. A provider
  // or endpoint change with the same model name produces a different vector space, so a model-only check
  // would keep serving vectors that scores against the new provider are meaningless for. New manifests carry
  // the identity fingerprint; an older one falls back to the model comparison (grandfathered so it does not
  // force a needless rebuild on upgrade). Read the config LIVE: reloadConfig() replaces the module object, so
  // a value destructured at import would be stale after a runtime change and re-embed on every workspace switch.
  if (manifestExists) {
    const liveCfg = require('../config');
    const liveMeta = require('./banks').currentMeta(liveCfg);
    const identityChanged = manifest._embeddingIdentity
      ? manifest._embeddingIdentity !== liveMeta.fp
      : (manifest._embeddingModel && !sameModel(manifest._embeddingModel, liveCfg.EMBEDDINGS_MODEL));
    if (identityChanged) {
      console.log(`⚠️  Embedding identity changed (now ${liveMeta.provider} · ${liveMeta.model}) — forcing clean rebuild`);
      needsRebuild = true;
    }
  }
  // Index-map format bump, OCR/visual pipeline bump, or moved documents — the shared reason
  // helper (also used by the banks path above, so the two can't drift). A missing stored
  // version is grandfathered inside the helper.
  if (manifestExists && !needsRebuild) {
    const reason = await contentRebuildReason(manifest, manifestExists);
    if (reason) {
      console.log(`⚠️  ${reason} — forcing clean rebuild`);
      needsRebuild = true;
    }
  }

  if (needsRebuild) {
    DEBUG && console.log('🗑️  Wiping vector_store cache...');
    await wipeIndexCache();
    await runDeltaUpdate();
    // Mark the index ready after the rebuild, mirroring the banks path above. runDeltaUpdate never
    // sets this, so without it a forced clean rebuild at boot (e.g. an embedding-model change with
    // banks off) would leave indexReady false for the whole session — every query answered with
    // "still building the index" until a SECOND restart took the warm path.
    state.indexReady = true;
    return;
  }

  if (faissExists && manifestExists) {
    try {
      state.liveVectorStore = await FaissStore.load(cfgPaths.CACHE_DIR, embeddings);
      if (DEBUG) console.log('✅ Loaded cached FAISS index');

      // Sanity-check score consistency. Bound the embed so an unreachable/stalled provider at boot
      // can't hang initIndex before indexReady is set — on a timeout the catch below skips the probe
      // and keeps the loaded store, rather than parking the whole session on "building the index".
      try {
        const probe = await embedBounded(state.liveVectorStore.similaritySearchWithScore('test probe query', 20));
        if (probe.length >= 4) {
          const cosineScores = probe.map(([, l2]) => l2ToCosine(l2)).sort((a, b) => b - a);
          const high = cosineScores[0], low = cosineScores[cosineScores.length - 1];
          if (high > 0.80 && (high - low) < 0.10) {
            console.warn(`⚠️  Index appears to use raw L2 scores — rebuilding`);
            state.liveVectorStore = null;
            for (const f of [CACHE_FILES.faissIndex, CACHE_FILES.docstore, CACHE_FILES.manifest]) {
              await fs.rm(path.join(cfgPaths.CACHE_DIR, f), { force: true }).catch(() => {});
            }
            await runDeltaUpdate();
            // runDeltaUpdate never sets indexReady (see the design note above), and this branch
            // returns early — so, exactly like the other rebuild-and-return branches, mark the
            // index ready here. Without this the self-healed index stays unavailable for the whole
            // session and every query is told "the index is still building" until a manual restart.
            state.indexReady = true;
            return;
          }
          if (DEBUG) console.log(`✅ Score consistency OK — cosine range ${low.toFixed(3)}–${high.toFixed(3)}`);
        }
      } catch (probeErr) {
        if (DEBUG) console.log('  Score probe failed:', probeErr.message);
      }

      const { files: diskFiles } = await collectAllFiles(cfgPaths.DOCS_DIR);
      // Prefer the persisted parent-map.json — full document text saved at index
      // time. This skips re-reading (and re-OCRing) every document on each start:
      // the whole point of caching. Only fall back to reading from source when the
      // cache is missing/stale (a workspace indexed before this cache existed, or
      // one whose files changed while the app was off — the delta pass reconciles
      // those afterward).
      let parentFromCache = false;
      const parentCachePath = path.join(cfgPaths.CACHE_DIR, CACHE_FILES.parentMap);
      try {
        const pmStat = await mtimeOf(parentCachePath);
        const mfStat = await mtimeOf(cfgPaths.MANIFEST_PATH);
        if (pmStat > 0 && pmStat >= mfStat) {
          // Streamed read (NDJSON), so warm start never loads the whole corpus as one string; a legacy
          // whole-JSON cache is read once and migrated to NDJSON transparently.
          await require('./parentmapstore').loadParentMap(parentCachePath, state.parentMap);
          parentFromCache = state.parentMap.size > 0;
          if (parentFromCache && DEBUG) console.log(`✅ parentMap loaded from cache — ${state.parentMap.size} documents (no re-read)`);
        }
      } catch { parentFromCache = false; }

      if (!parentFromCache) {
        // Report progress across the whole set. Only scanned PDFs logged anything, so
        // a corpus of ordinary documents produced a long silence that looked like the
        // app had hung — the work was happening, it just never said so.
        const progress = makeProgress(diskFiles.length, 'Reading documents');
        for (let i = 0; i < diskFiles.length; i++) {
          // Skip a file that can't be read rather than aborting the whole warm start. loadSingleDocument
          // swallows parse errors, but fs.stat/readFile can still throw — a file deleted or made
          // unreadable between enumeration and load (a synced cloud file, a permission change, a broken
          // symlink). One such file must never leave the workspace stuck "building the index" forever;
          // the rest of the corpus still indexes. Matches the per-file guards on the delta and bundle paths.
          try { await loadSingleDocument(diskFiles[i], state.parentMap); }
          catch (e) { if (DEBUG) console.log(`  ⚠️  Skipped unreadable file: ${path.basename(diskFiles[i])} (${e.message})`); }
          progress.tick(i + 1, path.basename(diskFiles[i]));
        }
        progress.done();
        // Warm-start re-reads every document to rebuild parentMap; anything newly
        // OCR'd here should be cached so the next start doesn't repeat it.
        try { require('../ocrcache').flush(); } catch {}
        try { require('../visualcache').flush(); } catch {}
        try { require('../summarycache').flush(); } catch {}
        try { await require('../ocr').releaseTesseract(); } catch {}
      }
      if (DEBUG) console.log(`✅ parentMap populated with ${state.parentMap.size} documents`);

      // Load passageMap from cache — but only if it's newer than the manifest.
      // If the manifest was written more recently, documents changed since the
      // cache was built and positions may be stale (e.g. after chunking.js update).
      const passageMapPath = path.join(cfgPaths.CACHE_DIR, CACHE_FILES.passageMap);
      const manifestMtime  = await mtimeOf(path.join(cfgPaths.CACHE_DIR, CACHE_FILES.manifest));
      const passageMtime   = await mtimeOf(passageMapPath);
      const passageCacheValid = passageMtime >= manifestMtime;

      if (!passageCacheValid && passageMtime > 0) {
        if (DEBUG) console.log('📍 passageMap cache older than manifest — rebuilding...');
      }

      // Stream the cache from NDJSON (fail-closed: a torn/corrupt file clears the map and we rebuild),
      // so a large corpus never blocks the event loop on a whole-file JSON.parse at warm start.
      const { loadMap } = require('./ndjsonmapstore');
      let passageMapLoaded = false;
      if (passageCacheValid) {
        const r = await loadMap(passageMapPath, state.passageMap);
        passageMapLoaded = r.ok && r.present;
      }

      if (passageMapLoaded) {
        if (DEBUG) console.log(`✅ passageMap loaded from cache — ${state.passageMap.size} positions`);

        // Load childMap from cache — but only when it is at least as new as the manifest, exactly like
        // parentMap and passageMap above. persistIndexMaps writes the maps in order (passage → child →
        // parent), each its own atomic rename, so a crash between the passage-map and child-map renames can
        // leave a fresh manifest and passage-map but a STALE child-map. Loading it unguarded would silently
        // drop the chunk→parent links for documents added in that delta, so their dense hits never resolve
        // until the file's bytes change or a Rebuild. When stale, fall through to rebuild it from parentMap.
        const childMapPath = path.join(cfgPaths.CACHE_DIR, CACHE_FILES.childMap);
        const childMtime = await mtimeOf(childMapPath);
        let childMapLoaded = false;
        if (childMtime >= manifestMtime) {
          const rc = await loadMap(childMapPath, state.childMap);
          childMapLoaded = rc.ok && rc.present;
        } else if (DEBUG) {
          console.log('📍 childMap cache older than manifest — rebuilding...');
        }

        if (childMapLoaded) {
          if (DEBUG) console.log(`✅ childMap loaded from cache — ${state.childMap.size} entries`);
        } else {
          if (DEBUG) console.log('📍 childMap cache missing — rebuilding...');
          for (const [, entry] of state.parentMap) {
            try { await semanticSplitDocument({ content: entry.content, metadata: entry.metadata }, state.childMap); } catch {}
          }
          if (DEBUG) console.log(`✅ childMap rebuilt — ${state.childMap.size} entries`);
        }
      } else {
        if (DEBUG) console.log('📍 passageMap cache missing — rebuilding from document chunks...');
        for (const f of diskFiles) {
          const entry = state.parentMap.get(docIdFor(f));
          if (!entry) continue;
          try { await semanticSplitDocument({ content: entry.content, metadata: entry.metadata }, state.childMap); } catch {}
        }
        if (DEBUG) console.log(`✅ passageMap rebuilt — ${state.passageMap.size} chunk positions`);
      }

      state.liveBM25 = await buildBM25Index(state.parentMap, manifest._bm25Median ?? null);
      buildChunkIndex();
      // Persist parentMap so a non-active-workspace API load reads text from cache rather than
      // re-OCRing. Skip it when the map was JUST loaded from that same file (parentFromCache) —
      // re-serializing hundreds of MB of document text on every startup for an unchanged corpus
      // is pure I/O and SSD wear, and briefly doubles the map in memory. Best-effort otherwise.
      if (!parentFromCache) {
        try {
          // NDJSON stream write — never builds a whole-corpus string, so this scales to any corpus size.
          await require('./parentmapstore').writeParentMap(path.join(cfgPaths.CACHE_DIR, CACHE_FILES.parentMap), state.parentMap);
          require('../logbuffer').debug(`💾 parentMap cache written — ${state.parentMap.size} documents (API loads skip OCR)`);
        } catch (e) { console.warn(`⚠️  parentMap cache write failed: ${e.message}`); }
      }
      try {
        const nt = state.liveVectorStore?.index?.ntotal;
        state.vectorCount = typeof nt === 'function' ? nt.call(state.liveVectorStore.index) : (nt ?? 0);
      } catch { /* best-effort */ }
      if (DEBUG) console.log(`✅ BM25 index built — ${state.parentMap.size} documents`);
      state.indexReady = true;   // FAISS + parentMap + BM25 + chunkIndex all ready
    } catch (warmErr) {
      console.warn('⚠️  Cached index could not be loaded — clearing it and rebuilding from scratch.');
      if (DEBUG) console.log('  Warm-start error:', warmErr && warmErr.message);
      // The cache is unusable (a truncated/corrupt faiss.index, an unreadable map). Clear
      // the on-disk cache AND the in-memory maps so the delta below sees every document as
      // new and does a FULL rebuild. Without the wipe, the manifest still matches disk, the
      // delta finds nothing to do, and the entire corpus is served as an EMPTY index until
      // a manual rebuild — the same recovery the L2-score probe above already performs.
      state.liveVectorStore = null;
      state.parentMap.clear();
      state.childMap.clear();
      state.passageMap.clear();
      try { await wipeIndexCache(); } catch (e) { if (DEBUG) console.log('  cache wipe failed:', e && e.message); }
    }
  } else {
    // Only promise a long build if there's actually something to index — a new
    // workspace is empty, and "this may take a few minutes" is both wrong and
    // alarming when the answer is "there's nothing here".
    let pending = 0;
    try { pending = (await collectAllFiles(cfgPaths.DOCS_DIR)).files.length; } catch { /* best effort */ }
    if (pending > 0) {
      console.log(`Building the document index for the first time — ${pending} file(s), this may take a few minutes…`);
    }
  }

  await runDeltaUpdate();
  state.indexReady = true;   // covers cold-start (no cache) and any final delta
};

// File watcher — debounced delta updates on document changes
let debounceTimer;
let debounceScheduled = false;
// Set while a workspace switch is in progress. A watched-folder change during the switch must
// NOT start (or re-schedule) a delta: the workspace id flips partway through, so a delta that
// began on the old workspace would write its data into the new workspace's directory. This flag
// is a hard gate that no timer or re-trigger chain can slip past.
let switching = false;

const triggerUpdate = () => {
  if (switching || initializing) { if (initializing) _deferredDuringInit = true; return; }
  if (state.indexing) {
    if (state.indexPromise && !debounceScheduled) {
      debounceScheduled = true;
      state.indexPromise
        .then(() => { debounceScheduled = false; triggerUpdate(); })
        .catch(() => { debounceScheduled = false; });
    }
    return;
  }
  if (debounceScheduled) return;
  debounceScheduled = true;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    debounceScheduled = false;
    // Re-check the gate at FIRE time, not just when the event arrived. A timer scheduled while the gate
    // was open (e.g. a file change moments before the user clicked "Rebuild index") would otherwise fire
    // during warm start or a rebuild's wipe window — where state.indexPromise is null, so runDeltaUpdate's
    // reentrancy guard can't catch it — and start a delta against a half-built cache.
    if (switching || initializing) { if (initializing) _deferredDuringInit = true; return; }
    if (DEBUG) console.log('📂 File change detected — running delta update...');
    // This runs from a timer with no caller to catch a rejection. Without the try
    // an indexing failure becomes an unhandled rejection — which, under a service
    // manager with automatic restart, turns ordinary file activity into a crash
    // loop. runDeltaUpdate reports its own errors, so swallowing here is correct.
    try {
      await runDeltaUpdate();
    } catch (e) {
      console.error('❌ Delta update failed after file change:', e.message || e);
    }
  }, DEBOUNCE_TIME);
};

// Active watchers, tracked so they can be torn down when the configured source
// folders change (the settings panel can add or remove folders at runtime).
let _watchers = [];

const stopWatchers = async () => {
  // Cancel any pending debounced index run so it can't fire during/after teardown and
  // start a fresh delta while workers are being killed. Clear the schedule flag too: the timer's
  // callback (which normally resets it) won't run now, and a stranded flag would block every future
  // debounced index once watchers are re-armed (e.g. after a workspace switch or a source re-point).
  clearTimeout(debounceTimer); debounceScheduled = false;
  // Detach the tracked set and clear it BEFORE awaiting the closes, not after. If another path arms a
  // watcher (startWatcher) during this await and we cleared afterward, that fresh watcher would be dropped
  // from tracking while still live — an orphaned watcher that keeps firing deltas and is never closed by a
  // later stopWatchers or by shutdown. Snapshotting first makes the swap atomic and closes exactly this set.
  const watchers = _watchers;
  _watchers = [];
  await Promise.all(watchers.map(w => { try { return w.close(); } catch { return null; } }));
};

const startWatcher = () => {
  // Never stack a second watcher set on top of a live one: that would leave the first set tracked-over and
  // orphaned (it keeps firing but a later stopWatchers only closes the latest array). Every legitimate arm
  // happens right after stopWatchers emptied the array, so a non-empty array means watchers are already live
  // and this call is a redundant re-arm (e.g. a failure path that re-armed before its finally also did).
  if (_watchers.length) return;
  // The curated documents directory is watched fully — the user puts files there
  // deliberately and expects them picked up immediately.
  _watchers.push(
    chokidar.watch(cfgPaths.DOCS_DIR, { persistent: true, ignoreInitial: true })
      .on('add',    triggerUpdate)
      .on('change', triggerUpdate)
      .on('unlink', triggerUpdate)
      // chokidar's FSWatcher is an EventEmitter: an unhandled 'error' (inotify limit
      // ENOSPC, EMFILE, the directory being removed/unmounted) would throw and crash the
      // process. Log and keep running, matching the source-folder watchers below.
      .on('error',  (e) => { console.error(`⚠️  Watcher error on ${cfgPaths.DOCS_DIR}: ${e && e.message ? e.message : e}`); })
  );

  // Extra source folders are watched more conservatively. They can be large and
  // noisy (a Downloads folder churns with every browser download), so we bound the
  // watch depth, ignore hidden files, and wait for writes to finish before firing —
  // otherwise a single large download triggers repeated re-index cycles while the
  // file is still being written.
  // Read live so a settings change is picked up on restart of the watchers.
  const { SOURCE_PATHS } = require('../config');
  for (const src of SOURCE_PATHS) {
    try {
      _watchers.push(
        chokidar.watch(src.path, {
          persistent: true,
          ignoreInitial: true,
          depth: src.recursive ? src.maxDepth : 0,
          ignored: /(^|[\/\\])\../,               // hidden files and directories
          awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 },
        })
          .on('add',    triggerUpdate)
          .on('change', triggerUpdate)
          .on('unlink', triggerUpdate)
          .on('error',  (e) => {
            if (DEBUG) console.log(`  ⚠️  Watch error on ${src.path}: ${e.message}`);
          })
      );
      if (DEBUG) console.log(`  👁️  Watching source ${src.path}${src.recursive ? ` (depth ${src.maxDepth})` : ''}`);
    } catch (e) {
      console.warn(`⚠️  Could not watch ${src.path}: ${e.message}`);
    }
  }
};

// Quiesce the active workspace's real-time indexing so a destructive whole-workspace operation (a backup
// restore over the active workspace) can replace its files with no delta writing into them mid-swap. The
// ORDERING is what makes this safe, and it mirrors doSwitchWorkspace: set the `switching` gate FIRST so a
// watched-folder change during the wait bails in triggerUpdate and can never chain a fresh re-trigger,
// THEN stop the watchers (which also cancels a pending debounce), THEN wait out any in-flight delta. The
// reverse order — awaiting the delta while the watchers are still live — leaves a window where a
// re-triggered delta re-arms a debounce timer AFTER the watchers were stopped, and that stray timer then
// fires during the swap and corrupts the restored index.
const beginQuiesce = async () => {
  switching = true;
  try {
    await stopWatchers();
    if (state.indexPromise) { try { await state.indexPromise; } catch { /* a failed in-flight delta is fine to ignore */ } }
  } catch (e) {
    // If quiescing itself fails (e.g. a chokidar close() rejects, so stopWatchers' Promise.all rejects),
    // never leave the gate stuck on — a stranded `switching` silently disables ALL real-time auto-indexing
    // (triggerUpdate and refreshSources both early-return on it) until the process restarts. Self-clear the
    // gate and re-arm watchers, then propagate so the caller handles the failure from a clean, indexing-
    // enabled state. The caller must only call endQuiesce after beginQuiesce RESOLVED (see the backup route's
    // `quiesced` flag), so this reversal never double-arms. startWatcher is idempotent regardless.
    switching = false;
    try { startWatcher(); } catch { /* best-effort re-arm */ }
    throw e;
  }
};

// Reverse beginQuiesce: clear the gate and re-arm the watchers so real-time indexing resumes. `switching`
// is cleared FIRST so that even if startWatcher throws (e.g. an inotify limit) the gate is never left
// stuck on — which would silently disable auto-indexing. Use this when the caller keeps the SAME workspace
// (e.g. a restore that failed and rolled back). When the caller instead hands off to switchWorkspace —
// which re-arms the watchers and clears the gate in its own finally — it must NOT call this.
const endQuiesce = () => { switching = false; startWatcher(); };

// Called after the settings panel saves. Re-points the watchers at the current set
// of folders and runs a delta update so newly added folders are indexed immediately
// rather than waiting for a file to change. A delta update compares disk against the
// manifest, so this is a cheap no-op when nothing actually changed.
// Serialized through the shared index-lifecycle lock: refreshSources tears down and re-arms the watchers and
// runs a delta, all of which mutate the same global watcher/gate state that switch, rebuild, consolidate, and
// restore mutate. Running it off the lock let two refreshes (two tabs / a double-click Save) — or a refresh
// racing a switch — interleave on `_watchers` and strand a live-but-untracked (orphaned) watcher. The lock
// makes it wait its turn instead. reindexNow (its only heavy step) does not take the lock, so no self-deadlock.
const refreshSources = () => runLifecycleExclusive(_refreshSourcesInner);

const _refreshSourcesInner = async () => {
  // With the lock held a switch/rebuild can no longer be mid-flight here (they hold the same lock), but keep
  // the guard as a cheap defensive backstop: if the gate is somehow set, defer rather than re-arm into it.
  if (switching || initializing) { if (DEBUG) console.log('📂 Settings saved during a workspace switch or rebuild — that operation will re-index with the new settings'); return; }
  await stopWatchers();
  startWatcher();
  const { SOURCE_PATHS } = require('../config');
  const before = state.parentMap.size;

  if (SOURCE_PATHS.length > 0 && DEBUG) {
    console.log(`📂 Settings saved — checking ${SOURCE_PATHS.length} extra folder(s):`);
    // Report what each folder actually contributes. Silent zero-result indexing has
    // been hard to diagnose from the outside, so state plainly what was found and
    // why a folder yielded nothing.
    const { walkSource } = require('./files');
    const { statWithTimeout } = require('../paths');
    for (const s of SOURCE_PATHS) {
      let detail;
      try {
        // Bounded async stat, never a raw statSync: an external source can be an offline or hung
        // network mount, and a sync stat there would freeze the event loop (and every concurrent
        // query) until the OS times out. This diagnostics loop is already async and awaits walkSource.
        const st = await statWithTimeout(s.path);
        if (!st.isDirectory()) {
          detail = 'not a directory';
        } else {
          const files = await walkSource(s.path, s);
          detail = `${files.length} indexable file(s)`;
          if (files.length === 0) {
            detail += s.recursive
              ? ` — nothing with a supported extension (${require('../constants').SUPPORTED_EXT_LABEL})`
              : ' — none at the top level; enable "subfolders" to look deeper';
          }
        }
      } catch (e) {
        detail = e.code === 'ENOENT' ? 'folder not found'
               : (e.code === 'EACCES' || e.code === 'EPERM') ? 'permission denied'
               : e.message;
      }
      console.log(`     ${s.path}${s.recursive ? `  (subfolders, depth ${s.maxDepth})` : '  (top level only)'} — ${detail}`);
    }
  } else if (DEBUG) {
    console.log('📂 Settings saved — no extra folders configured; checking data/documents');
  }

  // A content-affecting toggle (OCR, document summaries, contextual retrieval, visual ingest, or an OCR cap)
  // changed in Settings must re-index the EXISTING corpus, not just documents edited afterward. A plain delta
  // only re-embeds files whose bytes changed, so it would leave a silently mixed index (old docs keep their
  // non-contextual / name-only / no-summary vectors) until the next restart or a manual Rebuild. Reuse the same
  // gate warm start uses: contentRebuildReason compares the manifest's stored stamps against the new config, and
  // when it now wants a rebuild, force one. We already hold the lifecycle lock, so call the inner rebuild
  // directly — the public forceReindex would deadlock on the same lock (as consolidateBanks also does). This is
  // a no-op for an ordinary (non-content) settings save: the stamps still match, so no reason is returned.
  try {
    const manifestExists = await fs.access(path.join(cfgPaths.CACHE_DIR, CACHE_FILES.manifest)).then(() => true).catch(() => false);
    const reason = manifestExists ? await contentRebuildReason(await loadManifest(), true) : null;
    if (reason) {
      console.log(`🗑️  ${reason} — rebuilding the index from your documents`);
      await _forceReindexInner();
      console.log(`📂 Index rebuilt — ${before} → ${state.parentMap.size} documents`);
      return;
    }
  } catch (e) { if (DEBUG) console.log('  content-rebuild check skipped:', e && e.message); }

  // reindexNow, not runDeltaUpdate: a Settings save can ADD a source folder while a delta is already
  // in flight (from a file drop or a watcher event). runDeltaUpdate dedupes onto the in-flight promise,
  // whose file scan was fixed before the new folder existed, so the folder's existing documents would
  // never be indexed until one of them later changed. reindexNow drains the in-flight delta and then
  // runs one guaranteed fresh scan that sees the new folder — the same drain-then-scan every other
  // new-content path uses. It is a no-op when the disk already matches the manifest.
  await reindexNow();
  const after = state.parentMap.size;
  if (after !== before) {
    console.log(`📂 Index updated — ${before} → ${after} documents`);
  } else if (DEBUG) {
    console.log('📂 Index already current — no changes');
  }
};

// Switch the active workspace: tear down watchers, point the paths at the new
// workspace, clear the in-memory index, and rebuild from that workspace's cache.
// Only one workspace is indexed at a time — holding several would multiply memory
// for no benefit, since a query only ever searches one.
// Serialize switches. The API no longer awaits this, so two rapid selections could
// otherwise interleave — one clearing state while the other rebuilds, leaving the
// index pointing at a mix of two workspaces.
// Serialized through the shared index-lifecycle lock (see runLifecycleExclusive), so a switch never runs
// concurrently with another switch, a rebuild, a bank consolidation, or a backup restore — any of which
// could otherwise clear this one's watcher gate or wipe/swap state underneath it.
const switchWorkspace = (id) => runLifecycleExclusive(() => doSwitchWorkspace(id));

const doSwitchWorkspace = async (id) => {
  const wsm = require('../workspaces');
  const { DATA_DIR } = require('../config');
  // Gate the watcher for the whole switch so no watched-folder change can start (or re-schedule) a delta on
  // the old workspace while the id is flipping — that delta would otherwise write the old workspace's data
  // into the new workspace's directory. Set the gate FIRST, before validation, and run validation inside the
  // try: in the restore path beginQuiesce has already set `switching` and stopped the watchers, so a
  // validation throw here must still fall through the finally to CLEAR the gate — otherwise it stays stuck on
  // and silently disables auto-indexing until restart. startWatcher is idempotent, so when validation throws
  // before stopWatchers (watchers still live) the finally's re-arm is a safe no-op rather than a duplicate.
  switching = true;
  try {
    if (!wsm.isValidId(id)) throw new Error('Invalid workspace id');
    if (!wsm.loadRegistry(DATA_DIR).some(w => w.id === id)) throw new Error('No such workspace');
    // Stop the watchers and wait out any in-flight delta BEFORE draining queries and flipping the
    // id. A background index of the OLD workspace (e.g. a just-finished upload, or a watcher event)
    // resolves its cache dir live off state.workspaceId; letting it run past the flip would persist
    // one workspace's data into the other's. Stopping first (which also cancels a pending debounce),
    // then awaiting, closes that window; the `switching` flag covers any re-trigger chain.
    await stopWatchers();
    if (state.indexPromise) { try { await state.indexPromise; } catch {} }

    // Stop admitting NEW turns before draining: the socket handlers gate on state.indexReady, so
    // clearing it now means a query arriving during the drain is told the index is briefly
    // unavailable instead of slipping past the gate and reading the old maps as they are wiped.
    state.indexReady = false;

    // Let any in-flight query finish reading the current index before we wipe it. A streaming turn
    // that already passed the "index ready" guard resumes on its next await; if we nulled the
    // vector store and emptied the maps underneath it, that query would suddenly find nothing and
    // return a spurious "outside what I can help with". Bounded so a stuck query never blocks the
    // switch — after the grace window we proceed anyway.
    const drainStart = Date.now();
    while ((state.activeQueries || 0) > 0 && Date.now() - drainStart < 5000) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // Recreates the directories if they're missing, so switching to a workspace whose
    // folder was deleted outside the app still lands somewhere usable.
    state.workspaceId = wsm.ensureUsableWorkspace(DATA_DIR, id);
    hydrateBankMigration();
    // Remember this as the workspace to reopen on the next startup.
    try { wsm.setLastActive(DATA_DIR, state.workspaceId); } catch { /* best-effort */ }

    // Drop the previous workspace's index so a query can't be served from it while
    // the new one loads.
    state.liveVectorStore = null;
    state.vectorBanks     = [];
    state.liveBM25        = null;
    state.parentMap       = new Map();
    state.childMap        = new Map();
    state.passageMap      = new Map();
    state.chunkIndex      = new Map();
    state.corpusIdf       = new Map();
    state.indexReady      = false;

    console.log(`📁 Switched to workspace "${id}"`);
    try {
      await initIndex({ keepWorkspace: true });
    } catch (e) {
      // initIndex failed to complete (e.g. a read-only/full disk while creating the cache dir, or a banks
      // warm-load error). Do NOT leave the workspace stuck not-ready: runDeltaUpdate never sets indexReady, so
      // a later watcher-triggered delta would rebuild the maps yet every query would still answer "the index is
      // still building" until the next switch or a restart. Mark ready so queries get an honest answer from
      // whatever loaded — an empty or BM25-only corpus — and a later successful index update restores it fully.
      console.warn(`⚠️  Index load for "${id}" did not complete (${e && e.message || e}) — serving a degraded/empty index; it will heal on the next successful index update.`);
      state.indexReady = true;
    }
  } finally {
    switching = false;
    // Re-arm the watchers here, not after the try, so a throw from initIndex (a full or
    // read-only disk while creating the cache dir, an error in the banks warm load) can't
    // leave the process with zero file watchers — which would silently stop auto-indexing
    // until the next successful switch or settings save. ensureUsableWorkspace already
    // pointed state.workspaceId at a usable workspace, so the watcher arms on the right dir.
    startWatcher();
  }
  return id;
};

module.exports = { initIndex, initIndexReadOnly, refreshReadOnly, startReadOnlyRefresh, switchReadOnly, startWatcher, refreshSources, switchWorkspace, wipeIndexCache, forceReindex, consolidateBanks, afterEmbeddingSwitch, sweepOrphanVectors, _sweepOrphanVectorsInner, classifyOrphanVectorIds, stopWatchers, beginQuiesce, endQuiesce, orphanedBanksPresent, runLifecycleExclusive, reflectWorkspaceMutation, reflectDocChange, contentRebuildPending, hydrateBankMigration, banksMigrationRunning, repairInterruptedConsolidation };
