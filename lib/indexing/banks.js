'use strict';
// Embedding banks — one vector index per embedding model, instead of a single index
// bound to whatever model was configured when it was first built.
//
// The problem this solves: a vector index is tied to the exact embedding model that
// produced its vectors (dimensions and geometry differ between models), so changing the
// embedding model used to mean wiping the index and re-embedding every document — a slow,
// blocking rebuild during which search returned nothing. With banks, each embedding model
// gets its own index in its own directory, tagged with a fingerprint of the model. When
// the model changes, a new "active" bank is created and the previous one is kept, frozen
// but still searched. Existing documents stay findable through their old bank while new
// and changed documents are embedded into the new one, and a query searches every bank
// and fuses the results — so a model switch is incremental, not a full rebuild.
//
// This module owns the on-disk layout and the small registry that tracks the banks; the
// query-union lives in embeddings.js (denseSearch) and the write path in delta.js. All of
// it is gated by the `useEmbeddingBanks` config flag — when it's off, none of this runs
// and Lokyni uses the single-index code path unchanged.
//
// On-disk layout, under a workspace's vector_store/ (CACHE_DIR):
//   banks/
//     <fingerprint>/          ← one FAISS store per embedding model (faiss.index, …)
//     ...
//   banks.json                ← registry: { active, banks: [{ fp, provider, model, baseUrl, createdAt }] }

const fs     = require('fs');
const fsp    = require('fs').promises;
const path   = require('path');
const { CACHE_FILES } = require('../constants');   // single source for the index artifact filenames
const crypto = require('crypto');

const REGISTRY = 'banks.json';
const BANKS_DIR = 'banks';
// A resumable re-embed's progress marker. It lives beside the registry so a crash, restart, or provider
// outage leaves an honest record: the next Consolidate resumes from the documents still tagged to a frozen
// bank instead of starting over. Not part of the registry itself (nothing queries it).
const MIGRATION = 'bank-migration.json';
// Per-bank metadata written inside each bank dir. It is a redundant copy of the bank's registry row, so the
// registry (banks.json) can be rebuilt by scanning the bank folders if it is ever lost or corrupt — otherwise
// a lost registry would orphan every frozen bank (its vectors silently drop out of dense search with no
// re-embed, because the manifest still points each document at its existing bank).
const BANK_META = 'meta.json';
// The files FaissStore.save writes into a directory — exactly the pair saveStoreAtomic persists in
// the delta path. (An earlier "args.json" entry was never written by this langchain version, so it
// only misled; the existsSync guard in migrateLegacy meant it was always skipped anyway.)
const STORE_FILES = [CACHE_FILES.faissIndex, CACHE_FILES.docstore];

// A stable short id for an (provider, model, endpoint) triple. Two configs that embed
// with the same model at the same endpoint share a bank; anything different gets its own.
// The model name is normalized first so `foo` and `foo:latest` — the same Ollama model — map to
// one bank rather than each spawning its own on a purely cosmetic tag difference.
const { normalizeModelName } = require('../modelname');

// Race a promise against a timeout WITHOUT leaking the timer. The timeout rejects after timeoutMs, but the timer
// is CLEARED the instant the race settles — so a fast-resolving embed never leaves a pending setTimeout keeping the
// process (and, in tests, the whole suite runner) alive for the full timeout after the work is already done. One
// source for both the compatibility probe and the adapter fit, so the two cannot drift.
function raceWithTimeout(p, timeoutMs, message = 'embed timeout') {
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(message)), timeoutMs); });
  return Promise.race([Promise.resolve(p), timeout]).finally(() => clearTimeout(timer));
}
// Normalize the endpoint the same way the model name is normalized, so cosmetically-different-but-equivalent
// endpoints don't fork a redundant bank and force a full re-embed: a trailing slash
// (http://localhost:11434/ vs http://localhost:11434) and letter case must not change the fingerprint.
const normBaseUrl = (u) => String(u || '').trim().toLowerCase().replace(/\/+$/, '');
const fingerprint = (provider, model, baseUrl) =>
  crypto.createHash('sha256').update(`${String(provider || '').trim().toLowerCase()}\n${normalizeModelName(model)}\n${normBaseUrl(baseUrl)}`).digest('hex').slice(0, 16);

// The embedding config Lokyni is currently set to use. Keyed to the EMBEDDING provider (independent of
// the chat provider), so switching the chat provider never changes the fingerprint and never opens a new
// bank — only an embedding provider/model/endpoint change does.
const currentMeta = (cfg = require('../config')) => {
  const provider = cfg.EMBEDDINGS_PROVIDER;
  const model    = cfg.EMBEDDINGS_MODEL;
  // One shared resolver (config.embedBaseUrl) so the fingerprint matches the endpoint the embedder actually hits.
  const baseUrl  = require('../config').embedBaseUrl(cfg, provider);
  return { fp: fingerprint(provider, model, baseUrl), provider, model, baseUrl };
};

const banksRoot = (cacheDir) => path.join(cacheDir, BANKS_DIR);
const bankDir   = (cacheDir, fp) => path.join(cacheDir, BANKS_DIR, fp);
const registryPath = (cacheDir) => path.join(cacheDir, REGISTRY);

// Does this cache dir already hold embedded vectors? A legacy root index or any bank index counts; a bank
// folder with only meta.json has no vectors yet. The server uses this to decide whether a config save must
// preserve the current embedding identity: a fresh install has nothing to strand and may embed with a newly
// chosen provider, while an existing corpus should keep its bank. One definition of the on-disk layout.
const hasEmbeddedCorpus = (cacheDir) => {
  if (!cacheDir) return false;
  try {
    if (fs.existsSync(path.join(cacheDir, CACHE_FILES.faissIndex))) return true;
    const root = banksRoot(cacheDir);
    return fs.readdirSync(root).some((name) => fs.existsSync(path.join(root, name, CACHE_FILES.faissIndex)));
  } catch { return false; }
};

const loadRegistry = (cacheDir) => {
  try {
    const p = registryPath(cacheDir);
    // The registry is small and app-written. A pathological file (a user could drop one in the cache dir)
    // is treated as corrupt and rebuilt from the bank folders, not parsed into memory.
    if (fs.statSync(p).size > 4 * 1024 * 1024) return rescanRegistry(cacheDir);
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (raw && Array.isArray(raw.banks)) return raw;
  } catch { /* missing or corrupt — reconstruct from the bank folders below */ }
  return rescanRegistry(cacheDir);
};

// Reconstruct the registry by scanning banks/<fp>/meta.json when banks.json is missing or corrupt. Without
// this, loadRegistry returned an empty registry and ensureActive only re-added the CURRENT bank — every frozen
// bank, though still on disk, dropped out of the registry (and so out of dense search) with no path back short
// of a manual Rebuild, because the manifest still mapped its documents to that bank. `active` can't be known
// from a rescan; ensureActive re-establishes it from the current config. Best-effort and never throws.
const rescanRegistry = (cacheDir) => {
  const root = banksRoot(cacheDir);
  const banks = [];
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return { active: null, banks: [] }; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(root, e.name, BANK_META), 'utf-8'));
      if (m && typeof m.fp === 'string') banks.push({ fp: m.fp, provider: m.provider, model: m.model, baseUrl: m.baseUrl, createdAt: m.createdAt || Date.now() });
    } catch { /* a bank dir with no readable meta can't be reconstructed (its model is unknown) — skip it */ }
  }
  if (banks.length) { try { console.warn(`⚠️  banks.json was missing or corrupt — rebuilt the bank registry from ${banks.length} bank folder(s)`); } catch {} }
  return { active: null, banks };
};

// Write (or refresh) a bank's redundant meta.json so the registry can be rebuilt from disk. Creates the bank
// dir if needed. Best-effort — the registry is still the primary record.
const writeBankMeta = (cacheDir, meta) => {
  try {
    const dir = bankDir(cacheDir, meta.fp);
    fs.mkdirSync(dir, { recursive: true });
    require('../disk').writeFileAtomic(path.join(dir, BANK_META),
      JSON.stringify({ fp: meta.fp, provider: meta.provider, model: meta.model, baseUrl: meta.baseUrl, createdAt: meta.createdAt || Date.now() }, null, 2));
  } catch { /* best-effort */ }
};

const saveRegistry = (cacheDir, reg) => {
  fs.mkdirSync(cacheDir, { recursive: true });
  require('../disk').writeFileAtomic(registryPath(cacheDir), JSON.stringify(reg, null, 2));
};

// A legacy single-index (faiss.index at the cache root, from before banks existed) is
// moved into a bank on first use so nothing is re-embedded. The legacy vectors belong to
// whatever model built them — recorded in the manifest as _embeddingModel — so the bank is
// fingerprinted with THAT model, not necessarily the current one (they differ exactly when
// the user changed the model). Endpoint/provider default to the current config, which is
// the best available guess for an index that predates banks. Returns the migrated fp, or
// null if there was nothing to migrate.
const migrateLegacy = (cacheDir, legacyModel, cfg = require('../config')) => {
  const legacyIndex = path.join(cacheDir, CACHE_FILES.faissIndex);
  if (!fs.existsSync(legacyIndex)) return null;          // no legacy store
  if (fs.existsSync(banksRoot(cacheDir))) return null;   // already using banks
  // The legacy index was produced by the EMBEDDING provider (never the chat provider — only an embedding
  // provider can embed), so fingerprint it with that, exactly as currentMeta does, or the migrated bank
  // would not line up with the active bank.
  const provider = cfg.EMBEDDINGS_PROVIDER;
  // Resolve the endpoint through the SAME shared resolver currentMeta uses (config.embedBaseUrl), not a local
  // OPENAI_BASE/OLLAMA_HOST shortcut — otherwise a user who sets EMBEDDINGS_BASE_URL gets a migrated bank whose
  // fingerprint disagrees with the active meta, forking a redundant empty bank and a needless full re-embed.
  const baseUrl  = require('../config').embedBaseUrl(cfg, provider);
  const model    = legacyModel || cfg.EMBEDDINGS_MODEL;
  const fp = fingerprint(provider, model, baseUrl);
  const dir = bankDir(cacheDir, fp);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of STORE_FILES) {
    const from = path.join(cacheDir, f);
    if (fs.existsSync(from)) require('../disk').renameSyncWithRetry(from, path.join(dir, f));   // move, not copy
  }
  saveRegistry(cacheDir, { active: fp, banks: [{ fp, provider, model, baseUrl, createdAt: Date.now() }], migratedFp: fp });
  writeBankMeta(cacheDir, { fp, provider, model, baseUrl });   // so a lost registry can be rebuilt from disk
  return fp;
};

// Ensure the registry has an active bank for `meta`, creating one (and demoting the
// previous active bank to frozen) when the embedding model has changed. Never deletes or
// rewrites an existing bank. Returns { registry, activeFp, changed } where `changed` is
// true when the active bank flipped to a different fingerprint this call.
const ensureActive = (cacheDir, meta = currentMeta()) => {
  const reg = loadRegistry(cacheDir);
  const changed = reg.active !== meta.fp;
  if (!reg.banks.some(b => b.fp === meta.fp)) {
    reg.banks.push({ fp: meta.fp, provider: meta.provider, model: meta.model, baseUrl: meta.baseUrl, createdAt: Date.now() });
    writeBankMeta(cacheDir, meta);   // redundant per-bank copy so the registry can be rebuilt if it is lost
  }
  reg.active = meta.fp;
  saveRegistry(cacheDir, reg);
  return { registry: reg, activeFp: meta.fp, changed };
};

// ── Compatibility aliases ───────────────────────────────────────────────────────────────────────────────────
// An alias records that one embedding config produces the SAME vector space as an existing ("canonical") bank —
// MEASURED, never assumed from a matching model name. When the live config is an alias of the active bank, a
// switch reuses that bank as-is: no new bank, no re-embed, and new/changed documents are embedded with the live
// (reachable) config into the same bank. This is how switching a provider or endpoint for the same model costs
// nothing. The alias map lives in the registry ({ aliases: { <fp>: { canonical, level, median, p5, dim, at } } })
// and round-trips through load/saveRegistry; the "equivalent enough" thresholds live in embedcompat (one source).

// The canonical bank fp that `fp` aliases to, but ONLY when that bank still exists — a dangling alias (its
// canonical bank was dropped) is inert and treated as "no alias", so the caller falls back to a normal switch.
const aliasCanonical = (reg, fp) => {
  const map = (reg && reg.aliases) || {};
  const canon = map[fp] && map[fp].canonical;
  return (canon && Array.isArray(reg.banks) && reg.banks.some(b => b.fp === canon)) ? canon : null;
};

// Persist a measured alias. Best-effort and fail-safe (a failed write just means the next switch re-measures).
const recordAlias = (cacheDir, liveFp, canonicalFp, info = {}) => {
  try {
    const reg = loadRegistry(cacheDir);
    reg.aliases = reg.aliases || {};
    reg.aliases[liveFp] = { canonical: canonicalFp, level: info.level || '', median: info.median ?? null, p5: info.p5 ?? null, dim: info.dim ?? null, at: Date.now() };
    saveRegistry(cacheDir, reg);
    return true;
  } catch { return false; }
};

// Measure whether the live config and an existing bank entry produce the same vector space, by embedding a small
// shared sample through BOTH and comparing. Returns the compatibility verdict (plus the median/p5 it measured),
// or null when it can't measure (an embedder is missing, a side is unreachable, or it times out) — in which case
// the caller performs a normal switch. Bounded, non-blocking (a fixed small multilingual sample, gated to an
// actual switch), crash-proof (any failure → null, never throws). `makeEmbeddings` is injected so this stays free
// of a require cycle and is unit-testable without a live model. The probe is language-agnostic: a serving
// difference is a property of the model, not the corpus, and the sample spans several scripts to catch it.
const measureCompat = async (liveMeta, bankEntry, deps = {}) => {
  try {
    const makeEmbeddings = deps.makeEmbeddings;
    if (typeof makeEmbeddings !== 'function') return null;
    const { cosineStats, compatibilityVerdict, PROBE_TEXTS } = require('./embedcompat');
    const texts = (Array.isArray(deps.sampleTexts) && deps.sampleTexts.length >= 8) ? deps.sampleTexts : PROBE_TEXTS;
    const timeoutMs = Number(deps.timeoutMs) > 0 ? Number(deps.timeoutMs) : 20000;
    const liveEmb = makeEmbeddings({ provider: liveMeta.provider, model: liveMeta.model, baseUrl: liveMeta.baseUrl });
    const oldEmb  = makeEmbeddings({ provider: bankEntry.provider, model: bankEntry.model, baseUrl: bankEntry.baseUrl });
    if (!liveEmb || !oldEmb || typeof liveEmb.embedDocuments !== 'function' || typeof oldEmb.embedDocuments !== 'function') return null;
    const withTimeout = (p) => raceWithTimeout(p, timeoutMs);
    const [va, vb] = await Promise.all([withTimeout(liveEmb.embedDocuments(texts)), withTimeout(oldEmb.embedDocuments(texts))]);
    const stats = cosineStats(va, vb);
    const verdict = compatibilityVerdict(stats);
    return { ...verdict, median: stats.cos ? stats.cos.median : null, p5: stats.cos ? stats.cos.p5 : null, dim: stats.dimA };
  } catch { return null; }
};

// Resolve the meta to activate for a WRITE (warm start or a delta), reusing an equivalent existing bank instead
// of forking a new one when the live config is measured compatible with the active bank. Returns the meta to pass
// to ensureActive: the live meta in every normal case, or a canonical-bank meta (keeping the live provider/model
// so the bank is embedded and queried with the reachable config) when an alias applies. Only MEASURES on an
// actual switch to a brand-new config — every other path is a cheap, synchronous early return. Fully fail-safe:
// any trouble falls back to a normal switch (today's behavior), never throws.
const resolveActiveForWrite = async (cacheDir, deps = {}) => {
  const liveMeta = deps.liveMeta || currentMeta();
  try {
    const reg = loadRegistry(cacheDir);
    if (reg.active === liveMeta.fp) return liveMeta;                                              // unchanged — no switch
    const canon = aliasCanonical(reg, liveMeta.fp);
    if (canon) return { ...liveMeta, fp: canon };                                                // already-measured alias — no re-measure
    if (Array.isArray(reg.banks) && reg.banks.some(b => b.fp === liveMeta.fp)) return liveMeta;  // reactivating a real frozen bank
    const activeEntry = (reg.banks || []).find(b => b.fp === reg.active);
    if (!activeEntry) return liveMeta;                                                            // no prior active to compare (first bank)
    const verdict = await measureCompat(liveMeta, activeEntry, deps);
    if (verdict && verdict.safeToShareBank) {
      recordAlias(cacheDir, liveMeta.fp, reg.active, verdict);
      try { console.log(`🏦 New embedding config (${liveMeta.provider} · ${liveMeta.model}) is ${verdict.level} to the current bank — reusing it, no re-embed.`); } catch { /* logging is cosmetic */ }
      return { ...liveMeta, fp: reg.active };
    }
    return liveMeta;                                                                              // different space, or couldn't measure → normal switch
  } catch { return liveMeta; }
};

// ── Query-time adapters ─────────────────────────────────────────────────────────────────────────────────────
// When two spaces are close but NOT equivalent (so aliasing is unsafe), a learned linear adapter can still keep a
// frozen bank dense-searchable after its provider is dropped: it translates the live query vector into the frozen
// bank's space, so the old vectors are reused with no re-embed. Adapters are fitted eagerly at switch time (while
// the old provider is still reachable) and stored under the FROZEN bank, keyed by the FROM (live) fingerprint:
//   banks/<frozenFp>/adapters/<fromFp>.bin   — the compact binary adapter (embedadapter.serializeAdapter)
//   banks/<frozenFp>/adapters/<fromFp>.json  — the sidecar gate { viable, level, top1, mrr, … }
// Retrieval applies an adapter ONLY when its sidecar says `viable`, so a wrong map can never silently degrade
// recall. The blob layout lives in embedadapter (one source); this module owns the on-disk path and the gate.
const ADAPTERS_DIR = 'adapters';
// Paired texts per fit. Bounded small on purpose: each fit is a synchronous O(N^3) solve, and the λ sweep does a
// handful of them. The sweep YIELDS the event loop between fits (see fitBestAdapter), so no single stall exceeds
// one fit — tens of milliseconds at this size — even though the whole sweep is a few hundred. 160 leaves well
// over 100 anchors, plenty to determine a linear map. It runs only on a free local embedder, fire-and-forget,
// once per frozen bank, on a rare switch.
const ADAPTER_FIT_SAMPLE = 160;
const adapterDirOf   = (cacheDir, bankFp) => path.join(bankDir(cacheDir, bankFp), ADAPTERS_DIR);
const adapterBlobPath = (cacheDir, bankFp, fromFp) => path.join(adapterDirOf(cacheDir, bankFp), `${fromFp}.bin`);
const adapterMetaPath = (cacheDir, bankFp, fromFp) => path.join(adapterDirOf(cacheDir, bankFp), `${fromFp}.json`);

// True only when BOTH the blob and its sidecar exist — used to skip a fit that is already done (idempotent).
const adapterExists = (cacheDir, bankFp, fromFp) => {
  try { return fs.existsSync(adapterBlobPath(cacheDir, bankFp, fromFp)) && fs.existsSync(adapterMetaPath(cacheDir, bankFp, fromFp)); } catch { return false; }
};

// Persist a fitted adapter (blob + sidecar), atomically. The blob is written and renamed BEFORE the sidecar, so a
// crash between the two leaves a blob with no (viable) sidecar and retrieval simply ignores it — never half-applied.
const saveAdapter = async (cacheDir, bankFp, fromFp, blob, info = {}) => {
  try {
    if (!Buffer.isBuffer(blob) || !blob.length) return false;
    const dir = adapterDirOf(cacheDir, bankFp);
    await fsp.mkdir(dir, { recursive: true });
    const { writeFileAtomicAsync } = require('../disk');
    // Write the blob BEFORE the sidecar, each through the shared atomic writer (temp → rename, with its temp
    // removed on any failure), so a crash between the two can never leave a viable-looking sidecar pointing at a
    // missing or torn blob — the loader then just finds no adapter. Reusing the shared helper (rather than a
    // hand-rolled temp+rename) also removes the stray `.tmp` a mid-write crash used to leave for the pruner to
    // reclaim. Adapters are regenerable, so this uses the no-fsync atomic writer — the same policy as the other
    // hot, rebuildable stores — instead of blocking each fit on a per-write fsync.
    await writeFileAtomicAsync(adapterBlobPath(cacheDir, bankFp, fromFp), blob);
    await writeFileAtomicAsync(adapterMetaPath(cacheDir, bankFp, fromFp),
      JSON.stringify({ from: fromFp, to: bankFp, viable: !!info.viable, level: info.level || '', top1: info.top1 ?? null, mrr: info.mrr ?? null, dimFrom: info.dimFrom ?? null, dimTo: info.dimTo ?? null, n: info.n ?? null, at: Date.now() }));
    return true;
  } catch { return false; }
};

// Load a VIABLE query-time adapter mapping `fromFp` → `bankFp`, or null when there is none, it isn't viable, or
// anything throws. The viability gate travels with the adapter and is never re-decided here. Pure/fail-safe.
//
// Memoized by the blob's mtime (mirroring the manifest mtime cache): this is called on the SEARCH HOT PATH — once
// per query for every frozen bank whose own provider is cooling or gone, which is exactly when an adapter is in
// use — and deserializing the blob re-reads hundreds of thousands of floats in a JS loop. Re-parsing that on every
// query is a repeated event-loop stall for the whole cooldown window. Caching keyed on mtime parses it once; a
// re-fit rewrites the blob (new mtime) and so invalidates the entry. The resolved value (adapter OR null for a
// non-viable one) is cached, so a non-viable adapter is not re-parsed either. Absent blob → null without a read.
const _adapterCache = new Map();   // `${bankFp}:${fromFp}` → { mtimeMs, adapter }
const loadViableAdapter = (cacheDir, bankFp, fromFp) => {
  try {
    const blobPath = adapterBlobPath(cacheDir, bankFp, fromFp);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(blobPath).mtimeMs; } catch { return null; }   // no blob → no adapter (cheap miss)
    const key = `${bankFp}:${fromFp}`;
    const hit = _adapterCache.get(key);
    if (hit && hit.mtimeMs === mtimeMs) return hit.adapter;
    const meta = JSON.parse(fs.readFileSync(adapterMetaPath(cacheDir, bankFp, fromFp), 'utf-8'));
    const adapter = (meta && meta.viable)
      ? (require('./embedadapter').deserializeAdapter(fs.readFileSync(blobPath)) || null)
      : null;
    _adapterCache.set(key, { mtimeMs, adapter });
    // Bound to a handful of (bank, from) pairs; drop the oldest insertion (Map preserves insertion order).
    if (_adapterCache.size > 16) _adapterCache.delete(_adapterCache.keys().next().value);
    return adapter;
  } catch { return null; }
};

// Sample up to `n` document texts from a loaded store's docstore — the sharpest sample for a bank-specific fit.
const sampleStoreTexts = (store, n) => {
  const out = [];
  try {
    const ds = store && typeof store.getDocstore === 'function' ? store.getDocstore() : null;
    const docs = ds && ds._docs;
    if (!docs || typeof docs.values !== 'function') return out;
    for (const d of docs.values()) {
      const t = d && typeof d.pageContent === 'string' ? d.pageContent.trim() : '';
      if (t) out.push(t.length > 2000 ? t.slice(0, 2000) : t);
      if (out.length >= n) break;
    }
  } catch { /* best-effort */ }
  return out;
};

// Eagerly fit a query-time adapter from the ACTIVE (live) model into each FROZEN bank that doesn't already have
// one, so those banks keep dense recall if their provider later disappears. Runs at switch time (when the old
// providers are typically still reachable), bounded (a capped sample, the N×N solve), non-blocking (meant to be
// fire-and-forget), crash-proof (every bank in its own try — an unreachable provider is skipped, not fatal), and
// idempotent (skips a bank already fitted for the current active config). Only a MEASURED-VIABLE adapter is
// stored. `FaissStore`/`makeEmbeddings` are injected (no require cycle, unit-testable without a live model).
const fitAdaptersForFrozenBanks = async (cacheDir, deps = {}) => {
  try {
    const { FaissStore, makeEmbeddings } = deps;
    if (!FaissStore || typeof makeEmbeddings !== 'function') return { fitted: 0 };
    // Fitting embeds a sample through the LIVE provider and each frozen provider, so it costs money on a metered
    // provider. The auto-fit therefore runs ONLY on a FREE local embedder (the bundled 'local' model or a local
    // Ollama) — the same cost-safety rule the auto-consolidate obeys. A metered switch keeps its old bank
    // searchable through the still-reachable old provider, or the user consolidates on demand; never a silent bill.
    const { isFreeEmbeddingProvider } = require('../config');
    const liveProvider = (deps.liveProvider || require('../config').EMBEDDINGS_PROVIDER || '').toLowerCase();
    if (!isFreeEmbeddingProvider(liveProvider)) return { fitted: 0, skipped: 'metered' };
    const reg = loadRegistry(cacheDir);
    const activeFp = reg.active;
    if (!activeFp || !Array.isArray(reg.banks) || reg.banks.length < 2) return { fitted: 0 };   // need an active + ≥1 frozen
    const loaded = Array.isArray(deps.banks) ? deps.banks : await loadBanks(cacheDir, { FaissStore, makeEmbeddings });
    if (!loaded.some(b => b.fp === activeFp)) return { fitted: 0 };
    const embAdapter = require('./embedadapter');
    const { PROBE_TEXTS } = require('./embedcompat');
    const liveEmb = makeEmbeddings();
    const timeoutMs = Number(deps.timeoutMs) > 0 ? Number(deps.timeoutMs) : 60000;
    const withTimeout = (p) => raceWithTimeout(p, timeoutMs);
    let fitted = 0;
    for (const bank of loaded) {
      if (bank.fp === activeFp || !bank.store) continue;                 // only frozen banks that have a store
      if (!isFreeEmbeddingProvider(bank.meta && bank.meta.provider)) continue;   // never embed a frozen sample through a metered provider
      if (adapterExists(cacheDir, bank.fp, activeFp)) continue;          // already fitted for this active config
      try {
        let texts = sampleStoreTexts(bank.store, ADAPTER_FIT_SAMPLE);
        if (texts.length < 16) texts = PROBE_TEXTS.slice();
        if (texts.length < 16) continue;
        const frozenEmb = makeEmbeddings({ provider: bank.meta.provider, model: bank.meta.model, baseUrl: bank.meta.baseUrl });
        if (!frozenEmb || typeof frozenEmb.embedDocuments !== 'function' || typeof liveEmb.embedDocuments !== 'function') continue;
        const [vLive, vFrozen] = await Promise.all([withTimeout(liveEmb.embedDocuments(texts)), withTimeout(frozenEmb.embedDocuments(texts))]);
        // 80/20 split (every 5th held out); fit live → frozen (the direction a query is translated at search time).
        const aFit = [], bFit = [], aTest = [], bTest = [];
        for (let i = 0; i < Math.min(vLive.length, vFrozen.length); i++) { (i % 5 === 0 ? (aTest.push(vLive[i]), bTest.push(vFrozen[i])) : (aFit.push(vLive[i]), bFit.push(vFrozen[i]))); }
        // Sweep the ridge regularization and keep the best-regularized fit — a model pair the default would mark
        // non-viable can still be bridged by a better-regularized map, so more switches reuse the old vectors
        // instead of re-embedding. The viability GATE below uses the SEPARATE held-out test split (aTest/bTest),
        // never touched by the sweep's own internal split, so it stays an honest estimate.
        const fitRes = await embAdapter.fitBestAdapter(aFit, bFit, { yield: () => new Promise((r) => setImmediate(r)) });
        const adapter = fitRes && fitRes.adapter;
        if (!adapter) continue;
        const ret = embAdapter.retentionScore(adapter, aTest, bTest, aFit);
        const verdict = embAdapter.alignmentVerdict(ret);
        if (!verdict.viable) continue;                                    // store only a measured-viable adapter
        const blob = embAdapter.serializeAdapter(adapter);
        if (!blob) continue;
        if (await saveAdapter(cacheDir, bank.fp, activeFp, blob, { viable: true, level: verdict.level, top1: ret.top1, mrr: ret.mrr, dimFrom: adapter.dimA, dimTo: adapter.dimB, n: adapter.n })) {
          fitted++;
          try { console.log(`🏦 Fitted a query adapter so the ${bank.meta.provider} · ${bank.meta.model} bank stays searchable without its provider (held-out top-1 ${(ret.top1 * 100).toFixed(1)}%).`); } catch { /* cosmetic */ }
        }
      } catch { /* this bank's provider is unreachable or the fit failed — skip; its lexical signal still covers it */ }
    }
    return { fitted };
  } catch { return { fitted: 0 }; }
};

// True when a FROZEN bank (not the active one) has no viable query adapter from the current active config — i.e.
// its documents have lost dense recall and are served only by their lexical signal, so only a re-embed
// (Consolidate) would fully restore them. Used to decide whether an automatic background consolidation is
// warranted after a switch. Call it AFTER the eager adapter fit, or it will report a gap the fit would have
// closed. Sync, fail-safe.
const anyFrozenWithoutViableAdapter = (cacheDir) => {
  try {
    const reg = loadRegistry(cacheDir);
    const activeFp = reg.active;
    if (!activeFp || !Array.isArray(reg.banks)) return false;
    return reg.banks.some(b => b && b.fp !== activeFp && !loadViableAdapter(cacheDir, b.fp, activeFp));
  } catch { return false; }
};

// Read an adapter's sidecar gate without deserializing its blob — cheap, for display/decisions. Null on miss.
const readAdapterMeta = (cacheDir, bankFp, fromFp) => {
  try { return JSON.parse(fs.readFileSync(adapterMetaPath(cacheDir, bankFp, fromFp), 'utf-8')); } catch { return null; }
};

// Remove adapter files whose FROM fingerprint is no longer a registered bank — e.g. a source config that was
// consolidated away. They can never be loaded again (retrieval only asks for the CURRENT active fp), so they are
// pure residue. A still-registered frozen source is kept (a switch back to it would reuse its adapter). Fail-safe.
const pruneStaleAdapters = (cacheDir) => {
  try {
    const reg = loadRegistry(cacheDir);
    const live = new Set((reg.banks || []).map(b => b.fp));
    let removed = 0;
    for (const b of (reg.banks || [])) {
      let entries = [];
      try { entries = fs.readdirSync(adapterDirOf(cacheDir, b.fp)); } catch { continue; }
      for (const f of entries) {
        // A `.tmp` file is leftover from a write that crashed before its rename — always residue, remove it.
        if (f.endsWith('.tmp')) { try { fs.unlinkSync(path.join(adapterDirOf(cacheDir, b.fp), f)); removed++; } catch { /* best-effort */ } continue; }
        const m = f.match(/^([0-9a-f]+)\.(bin|json)$/);
        if (m && !live.has(m[1])) { try { fs.unlinkSync(path.join(adapterDirOf(cacheDir, b.fp), f)); removed++; } catch { /* best-effort */ } }
      }
    }
    return removed;
  } catch { return 0; }
};

// THE single source describing the embedding banks' reuse state, for the UI and any caller. For each bank a
// role: 'active' (the live model's bank), 'adapter' (a frozen bank kept dense-searchable by a viable query
// adapter), or 'frozen' (a frozen bank with no translation — searchable only by its lexical signal until a
// re-embed). Plus whether the live config is reusing an existing bank (an alias) and whether any gap remains.
// Sync, fail-safe, language-agnostic (keys off provider/model/fingerprints, never document content).
const describeBankState = (cacheDir, cfg = require('../config')) => {
  try {
    if (!cfg.useEmbeddingBanks) return { enabled: false, banks: [], activeFp: null, reused: false, notResilient: false };
    const reg = loadRegistry(cacheDir);
    const activeFp = reg.active || null;
    const liveMeta = currentMeta(cfg);
    const canon = aliasCanonical(reg, liveMeta.fp);
    const list = (reg.banks || []).map((b) => {
      if (b.fp === activeFp) return { fp: b.fp, provider: b.provider, model: b.model, role: 'active' };
      const ad = readAdapterMeta(cacheDir, b.fp, activeFp);
      return (ad && ad.viable)
        ? { fp: b.fp, provider: b.provider, model: b.model, role: 'adapter', top1: typeof ad.top1 === 'number' ? ad.top1 : null }
        : { fp: b.fp, provider: b.provider, model: b.model, role: 'frozen' };
    });
    return {
      enabled: true,
      activeFp,
      reused: !!canon,
      aliasLevel: canon ? ((reg.aliases[liveMeta.fp] || {}).level || null) : null,
      // A frozen bank with no adapter is still FULLY searchable through its own provider — it is only "not
      // resilient": if that provider later becomes unavailable, its documents fall back to keyword search. This
      // is NOT "needs a re-embed now", so the UI must not cry wolf about documents being keyword-only.
      notResilient: list.some((b) => b.role === 'frozen'),
      banks: list,
    };
  } catch { return { enabled: false, banks: [], activeFp: null, reused: false, notResilient: false }; }
};

// Predict, WITHOUT committing, what switching to `liveMeta` (default: the live config) would do: reuse an
// existing bank (no re-embed) or open a new one. Reuses measureCompat (one source of "equivalent"). Async +
// fail-safe. `makeEmbeddings` is injected. Returns { outcome: 'current'|'reuse'|'new'|'unknown', level?, message }.
const predictSwitch = async (cacheDir, deps = {}) => {
  const liveMeta = deps.liveMeta || currentMeta();
  try {
    const reg = loadRegistry(cacheDir);
    if (reg.active === liveMeta.fp) return { outcome: 'current', message: 'This is the current embedding configuration.' };
    if (aliasCanonical(reg, liveMeta.fp) || (reg.banks || []).some((b) => b.fp === liveMeta.fp)) {
      return { outcome: 'reuse', message: 'Your existing embeddings will be reused — no re-embedding.' };
    }
    const activeEntry = (reg.banks || []).find((b) => b.fp === reg.active);
    if (!activeEntry) return { outcome: 'new', message: 'A new embedding bank will be created.' };
    const v = await measureCompat(liveMeta, activeEntry, deps);
    if (!v) return { outcome: 'unknown', message: 'Could not compare — the current provider must be reachable to measure. If you switch, the old endpoint keeps serving its bank.' };
    if (v.safeToShareBank) return { outcome: 'reuse', level: v.level, message: 'Equivalent space — your existing embeddings will be reused with no re-embedding.' };
    return { outcome: 'new', level: v.level, message: 'A different embedding space. A new bank is created; your existing documents stay searchable through the old provider, and a learned adapter or a background re-embed keeps them available — nothing is lost.' };
  } catch { return { outcome: 'unknown', message: 'Could not determine the effect of this switch.' }; }
};

// Load every registered bank into a query-ready store. Each bank is loaded with an
// embeddings client bound to ITS OWN model (a frozen bank must be queried with the model
// that built it, not the current one). Banks whose store is missing or unreadable are
// skipped with their store left null — the corpus stays searchable through the banks that
// did load, plus BM25. Returns [{ fp, meta, store, embeddings, active, failed }], where
// `failed` is true only when the bank's index file is PRESENT but could not be loaded
// (corruption) — as opposed to simply absent (a freshly-created bank with nothing saved yet).
// The caller uses `failed` on the ACTIVE bank to self-heal (rebuild) rather than overwrite it.
const loadBanks = async (cacheDir, { FaissStore, makeEmbeddings }) => {
  const reg = loadRegistry(cacheDir);
  const out = [];
  for (const meta of reg.banks) {
    const dir = bankDir(cacheDir, meta.fp);
    let store = null, failed = false;
    // The ACTIVE bank is embedded and queried with the LIVE config: normally that equals the bank's stored meta,
    // but when the live config is a measured alias of this bank (an equivalent provider/endpoint for the same
    // model) the live config is the reachable one and must win. A FROZEN bank keeps its own stored embedder — it
    // must be queried with the exact model that built it.
    const embeddings = meta.fp === reg.active
      ? makeEmbeddings()
      : makeEmbeddings({ provider: meta.provider, model: meta.model, baseUrl: meta.baseUrl });
    // Backfill meta.json for a bank created before per-bank metadata existed, so a future registry loss can
    // still rebuild this bank. Only when its dir exists and the file is absent (idempotent, no per-load churn).
    try { if (fs.existsSync(dir) && !fs.existsSync(path.join(dir, BANK_META))) writeBankMeta(cacheDir, meta); } catch { /* best-effort */ }
    if (fs.existsSync(path.join(dir, CACHE_FILES.faissIndex))) {
      try { store = await FaissStore.load(dir, embeddings); }
      catch { store = null; failed = true; }   // present but unreadable → corrupt, not merely empty
    }
    out.push({ fp: meta.fp, meta, store, embeddings, active: meta.fp === reg.active, failed });
  }
  return out;
};

// Persist a store as the active bank's on-disk index. Uses the SAME atomic temp+rename discipline
// as the single-index path (reused from delta, required lazily to avoid a load cycle): an in-place
// save overwrites faiss.index then docstore.json, so a crash or full disk between the two writes
// would leave this bank mismatched — and loadBanks silently drops a bank whose store fails to
// load, losing its vectors until a manual rebuild. The temp+rename keeps the last good copy intact.
const saveActiveStore = async (cacheDir, store, activeFp) => {
  const dir = bankDir(cacheDir, activeFp);
  await fsp.mkdir(dir, { recursive: true });
  await require('./delta').saveStoreAtomic(store, dir);
};

// Remove ONLY the vector STORE files (index + docstore) of a single bank, keeping the bank directory, its
// meta.json (identity), and its adapters. Used by scoped crash recovery to clear a torn active-bank write so the
// delta re-embeds that bank's documents cleanly, without touching any OTHER bank. Best-effort and idempotent: a
// file that is already gone is not an error.
const wipeBankStore = async (cacheDir, fp) => {
  const dir = bankDir(cacheDir, fp);
  for (const f of STORE_FILES) {
    try { await fsp.rm(path.join(dir, f), { force: true }); } catch { /* already gone */ }
  }
};

// ── Resumable bank migration marker ────────────────────────────────────────────────────────────────────────
// The marker is advisory state for a Consolidate operation: which bank is the target and how many documents
// still live in an older one. Every write is atomic; a missing or unreadable marker simply means "no
// migration in progress" (Consolidate recomputes the remaining set from the manifest either way). Never throws.
const migrationPath = (cacheDir) => path.join(cacheDir, MIGRATION);
const readMigration = (cacheDir) => {
  try {
    const p = migrationPath(cacheDir);
    // This file is app-written and tiny. Refuse a pathological one (a user could drop a huge file in the
    // cache dir) rather than reading it into memory at boot or on a workspace switch.
    if (fs.statSync(p).size > 64 * 1024) return null;
    const m = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return (m && typeof m === 'object' && typeof m.target === 'string') ? m : null;
  } catch { return null; }
};
const writeMigration = (cacheDir, data) => {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    require('../disk').writeFileAtomic(migrationPath(cacheDir), JSON.stringify(data, null, 2));
  } catch { /* advisory — a failed marker write must not abort the re-embed */ }
};
const clearMigration = (cacheDir) => {
  try { fs.unlinkSync(migrationPath(cacheDir)); } catch { /* already gone */ }
};

// Remove every registered bank except `keepFp` and leave a single-bank registry. Called ONLY after the
// manifest confirms no document still points at a removed bank, so no searchable vector is lost. Async and
// one directory at a time so removing several large stores yields to the event loop between them.
const removeBanksExcept = async (cacheDir, keepFp) => {
  const reg = loadRegistry(cacheDir);
  const keep = reg.banks.find(b => b.fp === keepFp);
  const removed = [];
  for (const b of reg.banks) {
    if (b.fp === keepFp) continue;
    try { await fsp.rm(bankDir(cacheDir, b.fp), { recursive: true, force: true }); removed.push(b.fp); }
    catch { /* a locked folder is retried by the next Consolidate; the registry can still drop it below */ }
  }
  const next = { active: keepFp, banks: keep ? [keep] : reg.banks.filter(b => b.fp === keepFp) };
  delete next.migratedFp;   // the marker only describes the pre-consolidation layout
  saveRegistry(cacheDir, next);
  pruneStaleAdapters(cacheDir);   // drop any adapter whose source bank just disappeared (now unreachable residue)
  return removed;
};

// The bank that pre-banks (untagged) manifest entries live in: recorded by migrateLegacy, or derived from the
// model recorded in the manifest. Shared so the delta's purge decision and the resumable migration's
// "is this frozen?" test cannot disagree.
const migratedBankOf = (registry, meta, manifestModel) => {
  if (registry && registry.migratedFp) return registry.migratedFp;
  // With no recorded marker, derive it from the model that built the legacy index. If even that is unknown,
  // return '' (not a guess): an untagged entry then counts as frozen, so a migration re-embeds it rather than
  // deleting a bank that might still hold its vectors. Re-embedding is recoverable; deleting is not.
  return manifestModel ? fingerprint(meta.provider, manifestModel, meta.baseUrl) : '';
};

// Does a manifest entry's vector set live in a bank OTHER than the active one? Untagged entries count as
// active only when the migration marker proves it; otherwise they are treated as frozen (re-embedding one
// extra document is safe, deleting a bank that still holds its vectors is not).
const entryIsFrozen = (entry, activeFp, migratedFp) => {
  if (!entry || !Array.isArray(entry.vectorIds) || entry.vectorIds.length === 0) return false;
  if (entry.bank) return entry.bank !== activeFp;
  return migratedFp !== activeFp;
};

module.exports = {
  fingerprint, currentMeta,
  banksRoot, bankDir, registryPath,
  loadRegistry, saveRegistry, rescanRegistry, writeBankMeta, BANK_META,
  migrateLegacy, ensureActive, loadBanks, saveActiveStore, wipeBankStore,
  removeBanksExcept, readMigration, writeMigration, clearMigration, migrationPath,
  migratedBankOf, entryIsFrozen,
  hasEmbeddedCorpus,
  aliasCanonical, recordAlias, measureCompat, resolveActiveForWrite,
  fitAdaptersForFrozenBanks, loadViableAdapter, adapterExists, saveAdapter, sampleStoreTexts,
  anyFrozenWithoutViableAdapter, readAdapterMeta, pruneStaleAdapters, describeBankState, predictSwitch,
};
