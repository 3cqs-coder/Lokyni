'use strict';

// ── watchdog — boot-time integrity registry ──────────────────────────────────
//
// One place that runs the platform's own integrity checks at startup and reports anything
// wrong, so a broken invariant is surfaced immediately instead of hunted down later. It
// is the same self-registering shape as the answer-verification registry (lib/verify.js):
// checks REGISTER themselves and `run()` executes every one. Adding a safeguard later is a
// single `register(name, fn)` call — no edit to the runner or the boot caller, and other
// modules can register their own.
//
// Design rules (kept strict so this can never harm the running app):
//   • WARN-ONLY. A check never blocks or delays startup; it reports and the server keeps
//     running. It is fired-and-forgotten after the index settles.
//   • A check is `fn(context) -> finding | finding[] | null`, sync OR async (each is
//     awaited, so a check may read the index/filesystem). A finding is
//     `{ action, detail }`. A check that throws is caught and itself recorded as a finding
//     — never silently swallowed, never fatal.

// Registration/listing come from the shared factory (lib/registry.js); the runner below
// (run) is the watchdog's own — async, logging findings rather than composing them.
const { register, list, items: checks } = require('./registry').makeRegistry();

// Per-check wall-clock bound: a check that probes a slow/hung (often network-mounted, in scale-out) data dir
// must not stall the whole sweep. Effective only for ASYNC checks — the fs-probing checks are async for exactly
// this reason, so a hung mount settles as a "check timed out" finding instead of freezing the sweep.
const CHECK_TIMEOUT_MS = 10000;
const _withTimeout = (p, ms, label) => {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); if (t.unref) t.unref(); });
  return Promise.race([Promise.resolve(p), timeout]).finally(() => clearTimeout(t));
};
// Re-entrancy guard: the caller fires run() on a fixed interval; a sweep that runs long (a slow mount) must not
// overlap the next, which would otherwise double-run checks and corrupt the shared event-loop-lag window.
let _running = false;
// The latest completed sweep, for the read-only Settings health panel. Updated only when a sweep finishes (a
// skipped overlapping run leaves the previous result), and copied so a caller cannot mutate the stored list.
let _lastFindings = null;
let _lastRunAt = 0;

// Run every registered check. Returns the flattened findings (empty when all passed).
// Never throws. Logs a one-line summary; a clean run says so, so you can confirm the
// checks actually ran.
async function run(context) {
  context = context || {};
  if (_running) { try { console.log('🛡️  Watchdog: previous sweep still running — skipping this fire.'); } catch (e) {} return []; }
  _running = true;
  try {
  const findings = [];
  for (let i = 0; i < checks.length; i++) {
    try {
      const res = await _withTimeout(Promise.resolve().then(() => checks[i].fn(context)), CHECK_TIMEOUT_MS, checks[i].name);
      const arr = Array.isArray(res) ? res : (res ? [res] : []);
      arr.filter(Boolean).forEach(f => findings.push({ check: checks[i].name, action: f.action || ('watchdog.' + checks[i].name), detail: f.detail || '' }));
    } catch (e) {
      findings.push({ check: checks[i].name, action: 'watchdog.check_failed', detail: (e && e.message) ? e.message : String(e) });
    }
  }
  try {
    if (findings.length) {
      findings.forEach(f => console.warn(`⚠️  Watchdog — ${f.action}: ${f.detail}`));
    } else {
      console.log(`🛡️  Watchdog: all ${checks.length} integrity checks passed.`);
    }
  } catch (e) { /* logging must never break boot */ }
  // Record the sweep to the security audit log (opt-in, so tests calling run() don't write):
  // a durable, reviewable trail in the Audit tab. A clean run logs one watchdog.ok; each
  // finding is its own entry. Best-effort — auditing must never break the sweep.
  if (context.audit) {
    try {
      const audit = require('./audit');
      if (findings.length) findings.forEach(f => audit.audit('watchdog', f.action, f.check, f.detail));
      else audit.audit('watchdog', 'watchdog.ok', '', `all ${checks.length} integrity checks passed`);
    } catch (e) { /* audit is best-effort */ }
  }
  _lastFindings = findings.map(f => ({ check: String(f.check || ''), action: String(f.action || ''), detail: String(f.detail || '') }));
  _lastRunAt = Date.now();
  return findings;
  } finally { _running = false; }
}

// The latest completed sweep for a read-only UI. `at` is 0 when no sweep has finished yet. A copy, so a caller
// cannot mutate the stored result. Never throws.
function lastFindings() {
  return { at: _lastRunAt, findings: Array.isArray(_lastFindings) ? _lastFindings.map(f => ({ ...f })) : [] };
}

// ── Built-in checks ──────────────────────────────────────────────────────────

// 1. data_dir_writable — the workspace cache directory must be writable, or indexing,
//    caches, and backups fail silently. Writes and removes a tiny probe file.
register('data_dir_writable', async function () {
  const fs = require('fs').promises;
  const path = require('path');
  const cfg = require('./config');
  // A read REPLICA loads the shared volume read-only and must never write to it (only the primary writes), so a
  // failed write there is the correct, healthy state — not an alarm. Skip the write-probe on a replica; the
  // role-aware cluster_storage check covers read access there. Async fs so a hung mount is bounded by the
  // per-check timeout rather than blocking the event loop.
  try { if (require('./cluster').isReplica()) return null; } catch (e) { /* not clustered — proceed */ }
  const dir = cfg.CACHE_DIR || cfg.DATA_DIR || './data';
  try {
    await fs.mkdir(dir, { recursive: true });
    const probe = path.join(dir, '.writable-probe');
    await fs.writeFile(probe, 'ok');
    await fs.rm(probe, { force: true });
    return null;
  } catch (e) {
    return { action: 'watchdog.data_dir_unwritable', detail: `cannot write to ${dir} (${e && e.message}) — indexing, caches, and backups will fail. Check permissions/disk space.` };
  }
});

// 2. config_sane — a hand-edited config.json with an out-of-range value degrades retrieval
//    or answering in confusing ways. Warn (never block) on the values that matter. Each is
//    read from the live config so this reflects what the app is actually running with.
register('config_sane', function () {
  const cfg = require('./config');
  const out = [];
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  // numCtx 0 is AUTOMATIC (resolved per model, see lib/modelcontext.js), not "too small" — only a positive
  // but tiny explicit override is a misconfiguration worth flagging.
  if (num(cfg.numCtx) && cfg.numCtx > 0 && cfg.numCtx < 2048) out.push(`numCtx=${cfg.numCtx} is too small — the grounding rules may be truncated out of context (2048+ recommended, or 0 for automatic)`);
  if (!num(cfg.PASSAGE_SIZE) || cfg.PASSAGE_SIZE <= 0) out.push(`passageSize=${cfg.PASSAGE_SIZE} is invalid`);
  // maxTokens 0 is AUTOMATIC (sized to the model at request time, see resolveMaxTokens), not "too small" — only
  // a negative or non-numeric value is a real misconfiguration, mirroring the numCtx=0 handling above.
  if (!num(cfg.MAX_TOKENS) || cfg.MAX_TOKENS < 0) out.push(`maxTokens=${cfg.MAX_TOKENS} is invalid`);
  if (!num(cfg.TEMPERATURE) || cfg.TEMPERATURE < 0 || cfg.TEMPERATURE > 2) out.push(`temperature=${cfg.TEMPERATURE} is outside the sane 0–2 range`);
  if (!num(cfg.MIN_COSINE_SCORE) || cfg.MIN_COSINE_SCORE < 0 || cfg.MIN_COSINE_SCORE > 1) out.push(`minCosineScore=${cfg.MIN_COSINE_SCORE} is outside 0–1`);
  if (![cfg.rrfFaissWeight, cfg.rrfBm25Weight, cfg.rrfK].every(num)) out.push('an RRF weight (rrfFaissWeight / rrfBm25Weight / rrfK) is not a number');
  return out.length ? { action: 'watchdog.config_out_of_range', detail: out.join('; ') } : null;
});

// 3. api_scope_coverage — every state-changing /api/v1 route must require a capability
//    scope, so a read-only key can never mutate. The routes gate themselves inline; this
//    is the self-policing net that catches a newly-added mutating route whose author
//    forgot to declare its scope in the ROUTE_SCOPES contract (see lib/routes/apiv1.js),
//    and flags a declared scope that isn't a real one. Read routes need no gate.
register('api_scope_coverage', function () {
  let apiv1, apikeys;
  try { apiv1 = require('./routes/apiv1'); apikeys = require('./apikeys'); } catch (e) { return null; }
  const map = apiv1 && apiv1.ROUTE_SCOPES;
  const stack = apiv1 && apiv1.stack;
  if (!map || !Array.isArray(stack)) return null;
  // The scope vocabulary has ONE source — authz.SCOPE_CAPS, surfaced as apikeys.ALL_SCOPES. Do not re-type the
  // scope names here: a hardcoded fallback would silently go stale the moment a scope is added to SCOPE_CAPS,
  // and this very check would then flag the new scope as "unknown".
  const validScopes = new Set(apikeys.ALL_SCOPES || []);
  const out = [];
  // Invalid scope names in the contract.
  for (const key of Object.keys(map)) {
    if (!validScopes.has(map[key])) out.push(`route "${key}" declares unknown scope "${map[key]}"`);
  }
  // Mutating routes registered on the router but absent from the contract.
  const MUTATING = new Set(['post', 'put', 'patch', 'delete']);
  for (const layer of stack) {
    const route = layer && layer.route;
    if (!route || !route.path || !route.methods) continue;
    for (const method of Object.keys(route.methods)) {
      if (!MUTATING.has(method)) continue;
      const key = method.toUpperCase() + ' ' + route.path;
      if (!(key in map)) out.push(`state-changing route ${key} has no declared scope gate`);
    }
  }
  // The MCP tool→scope contract (lib/mcp/server.js TOOL_SCOPES) gets the same name validation. Coverage — that
  // every tool HAS a scope — is enforced at registration time (registerScopedTool throws on a missing entry),
  // so here we just flag a declared scope that isn't a real one, keeping the MCP surface in the same audit.
  try {
    const mcpScopes = require('./mcp/server').TOOL_SCOPES || {};
    for (const tool of Object.keys(mcpScopes)) {
      if (!validScopes.has(mcpScopes[tool])) out.push(`MCP tool "${tool}" declares unknown scope "${mcpScopes[tool]}"`);
    }
    // Cross-surface agreement: an operation the HTTP API and the MCP server BOTH expose must require the SAME
    // scope on each, so tightening the scope on one surface can't silently leave the other on the old one (an
    // MCP key keeping access the equivalent HTTP route just revoked). The loops above validate each map's names
    // independently; this is the only check that the two contracts for the same operation stay in step.
    const EQUIVALENT = [
      ['POST /search',    'search_documents'],
      ['POST /summarize', 'summarize_document'],
      ['GET /documents',  'list_documents'],
      ['GET /workspaces', 'list_workspaces'],
    ];
    for (const [route, tool] of EQUIVALENT) {
      if (map[route] && mcpScopes[tool] && map[route] !== mcpScopes[tool]) {
        out.push(`scope drift: HTTP "${route}" requires "${map[route]}" but equivalent MCP tool "${tool}" requires "${mcpScopes[tool]}"`);
      }
    }
  } catch { /* MCP SDK not installed — nothing to audit */ }
  return out.length ? { action: 'watchdog.api_scope_gaps', detail: out.join('; ') } : null;
});

// 4. index_mapping_consistent — the vector store's position→id map must have exactly as
//    many entries as the index has vectors. An older version removed vectors with the
//    low-level index.removeIds, which compacted FAISS positions without updating the map,
//    leaving stale entries so dense search could resolve to the wrong document. The current
//    code deletes via store.delete (which keeps them in step), but an index built by the old
//    version and since edited stays desynced until rebuilt. Detect and tell the user to
//    rebuild; fires only on an actually-affected index, so a clean install stays quiet.
register('index_mapping_consistent', function () {
  let state;
  try { state = require('./state'); } catch (e) { return null; }
  const stores = [];
  if (state.liveVectorStore) stores.push(state.liveVectorStore);
  for (const b of (state.vectorBanks || [])) { if (b && b.store && stores.indexOf(b.store) === -1) stores.push(b.store); }
  for (const s of stores) {
    try {
      const idx = s.index;
      if (!idx) continue;
      const ntotal = typeof idx.ntotal === 'function' ? idx.ntotal() : idx.ntotal;
      const mapped = s._mapping ? Object.keys(s._mapping).length : ntotal;
      if (Number.isFinite(ntotal) && mapped !== ntotal) {
        return { action: 'watchdog.index_mapping_desynced', detail: `vector index map has ${mapped} entries for ${ntotal} vectors — from an older delete bug. Run Settings → Rebuild index to restore full search accuracy.` };
      }
    } catch (e) { /* best-effort */ }
  }
  return null;
});

// 5. bm25_index_consistent — hybrid retrieval fuses dense (FAISS) and keyword (BM25)
//    ranking. If documents are indexed but the BM25 engine never built (a tokenization
//    failure, or an interrupted build), search silently degrades to dense-only, which
//    weakens exact-term and rare-word matches with no visible error. Gated on a ready
//    index with documents, so a fresh/empty install or a mid-build state stays quiet.
register('bm25_index_consistent', function () {
  let state;
  try { state = require('./state'); } catch (e) { return null; }
  if (!state.indexReady) return null;                       // still loading — not an anomaly
  const docs = state.parentMap ? state.parentMap.size : 0;
  if (!docs) return null;                                   // empty corpus — nothing to check
  const bm = state.liveBM25;
  // A tiny corpus legitimately has no BM25 engine: the library refuses to consolidate a collection
  // below its minimum, and buildBM25Index returns `{ engine: null, empty: true }` for that case (an
  // empty or one-document workspace). That is expected, not a silent degradation, and rebuilding would
  // reproduce it — so only a truly missing/misbuilt index is an anomaly.
  if (!bm || (!bm.engine && !bm.empty)) {
    return { action: 'watchdog.bm25_not_built', detail: `${docs} document(s) are indexed but the BM25 keyword index is empty — hybrid search has silently degraded to dense-only, weakening exact-term and rare-word matches. Rebuild the index (Settings → Rebuild) to restore it.` };
  }
  return null;
});

// 6. passage_offsets_valid — each chunk stores its character span in the parent document (passageMap).
//    Those offsets drive precise passage windowing and citation highlights. If a chunker or extractor
//    change makes chunk text stop matching the source, the offsets resolve to -1 and citations silently
//    degrade to a coarse keyword fallback with no error — the failure mode a past markdown-chunking bug
//    caused corpus-wide. Warn when an outsized fraction of chunks have an unresolved offset. Gated on a
//    ready index with chunks; a few -1s (a genuinely unlocatable chunk) are normal, so the threshold is
//    generous to avoid false alarms.
register('passage_offsets_valid', function () {
  let state;
  try { state = require('./state'); } catch (e) { return null; }
  if (!state.indexReady) return null;
  const childMap = state.childMap, passageMap = state.passageMap;
  if (!childMap || !passageMap || childMap.size === 0) return null;
  let total = 0, unresolved = 0;
  for (const childId of childMap.keys()) {
    const off = passageMap.get(childId);
    if (!off) continue;                 // no passage entry (e.g. full-context injected) — not a citation chunk
    total += 1;
    if (!(off.startChar >= 0)) unresolved += 1;
  }
  if (total === 0) return null;
  const frac = unresolved / total;
  if (frac > 0.25) {
    return { action: 'watchdog.passage_offsets_degraded', detail: `${unresolved} of ${total} indexed chunks (${Math.round(frac * 100)}%) have no resolved source position, so citation precision has degraded to a coarse fallback. This usually means chunk text no longer matches the stored document; rebuild the index (Settings → Rebuild) to restore precise citations.` };
  }
  return null;
});

// 7. embedding_banks_loaded — with embedding banks on, each embedding model keeps its own vector
//    index (a "bank"); a query fuses results from every bank. loadBanks deliberately skips a bank
//    whose index file is PRESENT but unreadable (corrupt) so the rest of the corpus stays
//    searchable — but that means every document embedded into a frozen bank silently vanishes from
//    dense search with no error, exactly the corpus-loss the delta path guards against on the ACTIVE
//    bank. A frozen bank has no such self-heal (it is never rewritten), so surface it here: warn
//    when a loaded bank is flagged failed. Gated on banks being on with a ready, populated bank set,
//    so the single-index path and a fresh/empty install stay quiet.
register('embedding_banks_loaded', function () {
  let state, cfg;
  try { state = require('./state'); cfg = require('./config'); } catch (e) { return null; }
  if (!cfg.useEmbeddingBanks) return null;                  // single-index path — no banks to check
  if (!state.indexReady) return null;                       // still loading — not an anomaly
  const banks = state.vectorBanks || [];
  if (!banks.length) return null;                           // not populated (fresh/empty) — nothing to check
  const failed = banks.filter(b => b && b.failed);
  if (failed.length) {
    const models = failed.map(b => (b.meta && b.meta.model) || b.fp).slice(0, 4).join(', ');
    const are = failed.length === 1 ? 'bank has' : 'banks have';
    return { action: 'watchdog.embedding_bank_unreadable', detail: `${failed.length} of ${banks.length} embedding ${are} an index file that could not be read (corrupt), so every document embedded into ${failed.length === 1 ? 'it is' : 'them is'} silently missing from dense search (${models}). Run Settings → Rebuild index to restore full search coverage.` };
  }
  // A bank whose provider/endpoint is gone is cooled down by the search path so it cannot stall every query.
  // Surface it: its documents are keyword-only until the endpoint returns or the user consolidates them.
  try {
    const emb = require('./embeddings');
    const cooling = banks.filter(b => b && b.store && emb.bankIsCooling(b.store));
    if (cooling.length) {
      const models = cooling.map(b => (b.meta && b.meta.model) || b.fp).slice(0, 4).join(', ');
      return { action: 'watchdog.embedding_bank_cooling', detail: `${cooling.length} of ${banks.length} embedding bank${cooling.length === 1 ? ' could' : 's could'} not be queried recently (${models}), so ${cooling.length === 1 ? 'its documents are' : 'their documents are'} keyword-only until the provider recovers. Check the embedding endpoint, or run Settings → Consolidate embedding banks to re-embed with the current model.` };
    }
  } catch { /* embeddings unavailable — the corrupt-bank check above still runs */ }
  return null;
});

// A Transformers.js model (the cross-encoder reranker, the late-interaction ColBERT model) is cached under the
// data directory and loaded from those files. A download interrupted after the ONNX weights but before the
// small config files leaves a PARTIAL cache that cannot load: the tokenizer read fails and retrieval silently
// falls back to a weaker order. The loader now treats a partial cache as "not cached" and re-fetches it when
// online (see retrieval/modelcache.js), so this check surfaces the remaining case — a partial cache that
// cannot heal (offline, or a blocked model host) — so the operator knows ranking is degraded rather than
// discovering it from vague results. Model-agnostic: it scans the model cache for ANY incomplete model, so a
// future model is covered with no change here. Bounded to the <org>/<model> layout; never throws.
register('model_files_complete', async function () {
  let cfg, mc, fsp, path;
  try { cfg = require('./config'); mc = require('./retrieval/modelcache'); fsp = require('fs').promises; path = require('path'); } catch { return null; }
  const modelsRoot = mc.modelsRoot(cfg.DATA_DIR);   // single source for the cache root — same resolver the loaders use
  if (!modelsRoot) return null;
  // Async throughout: a hung or slow mount under the data dir must not freeze the event loop (that would defeat
  // this check's own timeout). A directory is a model root if it holds the files Transformers.js reads.
  const exists = async (p) => { try { await fsp.access(p); return true; } catch { return false; } };
  const looksLikeModel = async (dir) =>
    (await exists(path.join(dir, 'tokenizer.json'))) || (await exists(path.join(dir, 'config.json')))
      || (await exists(path.join(dir, 'tokenizer_config.json'))) || (await exists(path.join(dir, 'onnx')));
  const partial = [];
  let orgs;
  try { orgs = await fsp.readdir(modelsRoot, { withFileTypes: true }); } catch { return null; }   // no models cached yet — nothing to check
  for (const org of orgs) {
    if (!org.isDirectory()) continue;
    const orgDir = path.join(modelsRoot, org.name);
    let models;
    try { models = await fsp.readdir(orgDir, { withFileTypes: true }); } catch { continue; }
    for (const model of models) {
      if (!model.isDirectory()) continue;
      const dir = path.join(orgDir, model.name);
      if ((await looksLikeModel(dir)) && !(await mc.modelFilesCompleteAsync(dir))) partial.push(`${org.name}/${model.name}`);
    }
  }
  if (!partial.length) return null;
  return {
    action: 'watchdog.model_incomplete',
    detail: `${partial.length} local model${partial.length === 1 ? ' is' : 's are'} cached but incomplete (a partial download): ${partial.slice(0, 4).join(', ')}. ${partial.length === 1 ? 'It re-downloads' : 'They re-download'} automatically on next use when online; while offline or if the model host is blocked, retrieval ranking falls back to a weaker order until the download completes.`,
  };
});

// A hand-edited workspace settings file can exceed the per-workspace automation cap that add() enforces. Every
// enabled job arms a timer and can carry an evidence snapshot, so surface the excess rather than letting it
// silently bloat the settings file and the scheduler.
register('automations_within_cap', function () {
  let auto, wsm, cfg;
  try { auto = require('./automations'); wsm = require('./workspaces'); cfg = require('./config'); } catch (e) { return null; }
  const over = [];
  try {
    for (const ws of wsm.loadRegistry(cfg.DATA_DIR)) {
      const n = auto.list(ws.id).length;
      if (n > auto.MAX_AUTOMATIONS) over.push(`${ws.name || ws.id}: ${n}`);
    }
  } catch { return null; }
  if (!over.length) return null;
  return { action: 'watchdog.automations_over_cap', detail: `${over.join('; ')} automation(s) exceed the ${auto.MAX_AUTOMATIONS}-per-workspace cap. Remove the extra jobs so the settings file and the scheduler stay bounded.` };
});

// A resumable bank re-embed that stopped (crash, restart, provider outage) leaves a marker. Surface it so the
// user knows search is intact but some documents are still in an older bank, and that Consolidate resumes.
// A marker touched within the last few minutes is a run in progress, not a stale one — stay quiet.
register('bank_migration_incomplete', function () {
  let cfg;
  try { cfg = require('./config'); } catch (e) { return null; }
  if (!cfg.useEmbeddingBanks) return null;
  // A live run is not a stale marker, even between two long batches.
  try { if (require('./indexing/init').banksMigrationRunning()) return null; } catch { /* init unavailable */ }
  let m;
  try { m = require('./indexing/banks').readMigration(cfg.CACHE_DIR); } catch (e) { return null; }
  if (!m || m.status === 'done') return null;
  if (Date.now() - (Number(m.updatedAt) || 0) < 5 * 60 * 1000) return null;   // a run is in progress
  const total = Number(m.total) || 0, remaining = Number(m.remaining) || 0;
  const done = Math.max(0, total - remaining);
  return { action: 'watchdog.bank_migration_incomplete', detail: `A bank re-embed stopped with ${remaining} of ${total} document(s) still in an older embedding bank (${done} already moved). Run Settings → Consolidate embedding banks to resume; nothing already moved is lost, and search stays available in the meantime.` };
});

// (registered below: network_exposure, automation_schedules — placed here so the built-in
//  set reads in one block; each follows the same fn(context) -> finding | null shape.)

// network_exposure — when the server is bound to a non-loopback address, its control plane
// (Settings, backups, the document API) is reachable from the network, and that plane has no
// password. Warn so an accidental exposure is caught. A correctly reverse-proxied setup binds
// loopback and never trips this; a deliberate direct bind gets a one-line reminder to firewall it.
register('network_exposure', function () {
  if (require('./hostguard').isBindLoopback()) return null;   // loopback bind — not network-exposed (single source)
  const addr = require('./config').BIND_ADDRESS || '127.0.0.1';
  return { action: 'watchdog.network_exposed', detail: `bound to ${addr}, so the control plane (Settings, backups, document API) is reachable from the network with no password. If that's intentional, put Lokyni behind a reverse proxy or firewall; otherwise set "bindAddress": "127.0.0.1" in config.json.` };
});

// automation_schedules — a scheduled automation whose cron no longer validates is silently
// never armed, so it just stops running with no error. Automations are validated when created,
// but a hand-edited settings file or a node-cron version change can invalidate one after the
// fact. Re-check every enabled automation at boot and name any that won't fire.
register('automation_schedules', function () {
  let auto;
  try { auto = require('./automations'); } catch (e) { return null; }
  const out = [];
  // The scheduler dependency (node-cron) failed to load, yet the user has enabled automations: none of
  // them will EVER fire, and invalidSchedules() can't report it (it returns [] when cron is missing).
  // Surface it so the silent "my scheduled digests stopped" has a visible, audited cause.
  try {
    if (!auto.cronAvailable() && auto.enabledCount() > 0) {
      out.push({ action: 'watchdog.scheduler_unavailable', detail: `the scheduler (node-cron) is not available, so ${auto.enabledCount()} enabled automation(s) will never run. Reinstall dependencies so scheduled digests and saved questions fire again.` });
    }
  } catch (e) { /* best-effort */ }
  // A cron expression that no longer validates — a hand-edited settings file or a node-cron change
  // leaves the automation silently un-armed.
  let bad = [];
  try { bad = auto.invalidSchedules(); } catch (e) { bad = []; }
  if (bad.length) {
    const shown = bad.map(b => `"${b.name}" (${b.workspace}): ${b.schedule}`).slice(0, 5).join('; ');
    out.push({ action: 'watchdog.automation_invalid_cron', detail: `${bad.length} enabled automation(s) have an invalid schedule and will never run — fix the cron expression in Settings: ${shown}` });
  }
  return out.length ? out : null;
});

// disk_space — indexing, OCR/context caches, and backups all write to the data dir; when
//    the volume fills, those writes fail or truncate mid-way and can leave the index
//    inconsistent. Warn early when free space is low so the user acts before a silent
//    disk-full failure. Skipped silently where free space can't be read (older Node without
//    fs.statfs), so it never fires spuriously.
register('disk_space', async function () {
  const cfg = require('./config');
  const dir = cfg.DATA_DIR || './data';
  const free = await require('./disk').freeBytesAsync(dir);   // async so a hung mount can't block the event loop
  if (free == null) return null;   // can't measure — stay quiet rather than guess
  const MB = 1024 * 1024;
  const LOW = require('./disk').LOW_DISK_BYTES;   // one shared floor for the boot warning and this check
  if (free < LOW) {
    return { action: 'watchdog.disk_low', detail: `only ${Math.round(free / MB)} MB free on the volume holding ${dir} — indexing, OCR caches, and backups can fail or leave the index inconsistent when the disk fills. Free up space.` };
  }
  return null;
});

// memory_headroom — warn while the process still has room to act, before an out-of-memory
// crash. V8 aborts the whole process when the heap cannot grow past its limit, so a
// point-in-time read of used heap against that limit is a direct, cross-platform predictor
// of that crash. Instant and synchronous — it never blocks. Warn-only.
register('memory_headroom', function () {
  let used, limit;
  try {
    const stats = require('v8').getHeapStatistics();
    used = stats.used_heap_size;
    limit = stats.heap_size_limit;
  } catch (e) { return null; }              // stats unavailable — stay quiet rather than guess
  if (!limit) return null;
  const pct = used / limit;
  if (pct >= 0.90) {
    const MB = 1024 * 1024;
    return { action: 'watchdog.memory_high', detail: `the memory heap is at ${Math.round(pct * 100)}% of its ${Math.round(limit / MB)} MB limit (${Math.round(used / MB)} MB in use) — the process can crash with an out-of-memory error as it grows. Index large folders in smaller passes or lower the context size; if this recurs, raise the ceiling by starting Lokyni with a larger heap (node --max-old-space-size).` };
  }
  return null;
});

// event_loop_lag — surface a stalled event loop, which freezes answering and indexing for
// everyone on this server. A single passive delay histogram (verified not to keep the
// process alive) records the worst stall since the previous sweep; each sweep reports it and
// resets the window. Cross-platform and non-blocking. Warn-only.
let _eldHistogram = null;
function eventLoopHistogram() {
  if (_eldHistogram) return _eldHistogram;
  try {
    const { monitorEventLoopDelay } = require('perf_hooks');
    _eldHistogram = monitorEventLoopDelay({ resolution: 20 });
    _eldHistogram.enable();
  } catch (e) { _eldHistogram = null; }     // older runtime without the API — skip the check
  return _eldHistogram;
}
register('event_loop_lag', function () {
  const h = eventLoopHistogram();
  if (!h) return null;
  const maxMs = h.max / 1e6;                 // nanoseconds → milliseconds
  h.reset();                                 // fresh window for the next sweep
  const STALL_MS = 2000;
  if (maxMs >= STALL_MS) {
    return { action: 'watchdog.event_loop_stall', detail: `the event loop was blocked for up to ${Math.round(maxMs)} ms since the last check, which stalls answering and indexing while it lasts. A large synchronous step — embedding a big batch, parsing a very large file — is the usual cause. If it recurs, index large folders in smaller passes.` };
  }
  return null;
});

// 6. audit_chain_integrity — the security audit trail (data/audit.jsonl) is a SHA-256 hash
//    chain; editing, deleting, or reordering an entry breaks a link. Verify the chain at boot
//    and warn (never block) on any anomaly, so tampering with the record is surfaced rather
//    than silent. Absence of a readable log is not an anomaly (a fresh install, or auditLog
//    turned off), so a clean/new install stays quiet.
register('audit_chain_integrity', function () {
  let audit;
  try { audit = require('./audit'); } catch (e) { return null; }
  const r = audit.verifyChain();
  if (r && Array.isArray(r.anomalies) && r.anomalies.length) {
    const shown = r.anomalies.slice(0, 5).join('; ') + (r.anomalies.length > 5 ? '; …' : '');
    return { action: 'watchdog.audit_tampering', detail: `audit-log integrity check FAILED over ${r.checked} sealed entries: ${shown}. The security trail in data/audit.jsonl was altered outside the app.` };
  }
  return null;
});

// service_paths_valid — a registered background service records absolute paths to the Node
//    binary/launcher and the script. A Node upgrade that relocates the runtime, a moved or
//    deleted install directory, or a removed branded launcher leaves the service unable to
//    relaunch after a reboot — silently, and invisibly from inside the running process. Read
//    the installed definition and warn if any path it references no longer exists. Fires only
//    when a service is actually installed and a recorded path is genuinely missing.
register('service_paths_valid', function () {
  let svc;
  try { svc = require('./service'); } catch (e) { return null; }
  let res;
  try { res = svc.checkServicePaths(); } catch (e) { return null; }
  if (!res || !res.installed || !res.missing || res.missing.length === 0) return null;
  return { action: 'watchdog.service_path_missing', detail: `the installed background service points at ${res.missing.length} path(s) that no longer exist, so it will not start after a reboot: ${res.missing.slice(0, 4).join(', ')}. Re-run "node lokyni.js --install" to repair it (a Node upgrade or a moved install folder is the usual cause).` };
});

// browser_profiles_stale — URL ingestion launches a headless browser in a per-run profile
//    under the data dir; a clean shutdown sweeps them, but a crash mid-fetch orphans one.
//    Over a long-lived service these accumulate and consume disk (feeding the very disk-full
//    failures the disk_space check warns about). Warn only on several dirs definitively
//    abandoned (older than an hour), so an in-progress fetch's fresh profile never trips it.
register('browser_profiles_stale', async function () {
  const fs = require('fs').promises;
  const path = require('path');
  let dir;
  try { dir = path.join(require('./config').DATA_DIR, 'puppeteer_cache'); } catch (e) { return null; }
  let names;
  try { names = await fs.readdir(dir); } catch (e) { return null; }   // no cache dir yet — nothing to check
  const HOUR = 3600 * 1000;
  const now = Date.now();
  let stale = 0;
  for (const name of names) {
    if (!name.startsWith('run_')) continue;
    const ts = parseInt(name.split('_')[1], 10);
    if (Number.isFinite(ts) && now - ts > HOUR) stale++;
  }
  if (stale >= 3) {
    return { action: 'watchdog.browser_profiles_stale', detail: `${stale} abandoned browser profile folder(s) are piling up in ${dir} (left by interrupted URL ingestion). They waste disk; restarting Lokyni clears them, or delete the run_* folders there.` };
  }
  return null;
});

// api_keys_parseable — the API-key store loader falls back to an empty list on ANY read or
//    parse error, so a corrupt or hand-broken data/api-keys.json silently makes every API and
//    MCP key return 401 with no surfaced cause. Warn when the file exists but isn't the
//    expected { "keys": [...] } shape. Absent file = fresh install, so it stays quiet.
register('api_keys_parseable', async function () {
  const fs = require('fs').promises;
  const path = require('path');
  let dir;
  try { dir = require('./config').DATA_DIR; } catch (e) { return null; }
  const p = path.join(dir, 'api-keys.json');
  let raw;
  try { raw = await fs.readFile(p, 'utf-8'); } catch (e) { return null; }   // no file — nothing to check
  try { const o = JSON.parse(raw); if (o && Array.isArray(o.keys)) return null; } catch (e) {}
  return { action: 'watchdog.api_keys_unparseable', detail: `${p} exists but is not valid JSON of the form { "keys": [...] } — every API and MCP key will be rejected with no visible cause until it is fixed or removed.` };
});

// multiuser_integrity — once accounts exist, verify the auth stores are healthy: the users file parses (a
//    corrupt one must NOT silently re-open the instance — isEmpty treats it as closed, and this surfaces it),
//    the CSRF signing secret can be established (fail-closed), and no workspace membership points at a user or
//    workspace that no longer exists (an orphan grants nothing but signals a missed cascade). Cheap: a few
//    small JSON reads, only when at least one account exists.
register('multiuser_integrity', function () {
  let cfg; try { cfg = require('./config'); } catch (e) { return null; }
  const dir = cfg.DATA_DIR;
  const users = require('./users');
  if (users.isCorrupt(dir)) {
    return { action: 'watchdog.users_file_corrupt', detail: 'data/users.json exists but is not valid JSON of the form { "users": [...] }. Login is blocked and the instance stays closed (it will NOT fall back to open access). Restore the file from a backup or fix the JSON.' };
  }
  if (users.isEmpty(dir)) return null;   // no accounts yet — nothing else to check
  try { require('./authsecret').getSecret(); }
  catch (e) { return { action: 'watchdog.auth_secret_unavailable', detail: 'The server auth secret could not be read or created, so CSRF tokens cannot be signed. Check that the config folder is writable.' }; }
  let wsIds = null;
  try { wsIds = new Set(require('./workspaces').loadRegistry(dir).map(w => w.id)); } catch (e) { /* registry unreadable — skip the workspace half */ }
  const userIds = new Set(users.list(dir).map(u => u.id));
  const members = require('./members');
  const orphans = members.list(dir).filter(m => !userIds.has(m.userId) || (wsIds && !wsIds.has(m.workspaceId)));
  if (orphans.length) {
    return { action: 'watchdog.orphaned_memberships', detail: `${orphans.length} workspace membership row(s) reference a user or workspace that no longer exists. They grant no access but indicate a missed cascade; deleting the user or workspace through the app clears them.` };
  }
  return null;
});

// cluster_storage — in scale-out mode, every instance works over a SHARED data directory. Verify this node
//    can actually use it for its role: a replica needs it readable; the primary also needs it writable (or
//    indexing silently fails). This catches a broken or read-only volume mount, the usual scale-out setup bug.
register('cluster_storage', async function () {
  const cluster = require('./cluster');
  if (!cluster.enabled()) return null;
  let dir; try { dir = require('./config').DATA_DIR; } catch (e) { return null; }
  const fs = require('fs').promises;
  const fsc = require('fs').constants;
  // Async access() so a slow/hung shared (network) mount is bounded by the per-check timeout instead of blocking
  // the event loop for every user on this node — the exact freeze this check must not cause.
  try { await fs.access(dir, fsc.R_OK); }
  catch (e) { return { action: 'watchdog.cluster_storage', detail: `Cluster ${cluster.label()}: the shared data directory is not readable (${dir}). Check the shared volume mount.` }; }
  if (cluster.isPrimary()) {
    try { await fs.access(dir, fsc.W_OK); }
    catch (e) { return { action: 'watchdog.cluster_storage', detail: `Cluster primary: the shared data directory is not writable (${dir}) — indexing will fail until the mount is writable.` }; }
  }
  return null;
});

// stale_temp_writes — every store writes atomically (temp file + rename); a successful write
//    renames the temp away instantly, so a "*.tmp" left behind for over an hour is the
//    fingerprint of an interrupted commit (a crash or full disk mid-write). Warn so the user
//    can clear it. The one-hour age gate means an in-progress write never trips it.
register('stale_temp_writes', async function () {
  const fs = require('fs').promises;
  const path = require('path');
  let cfg;
  try { cfg = require('./config'); } catch (e) { return null; }
  // Also scan DATA_DIR/tmp (backup create-staging + uploads) and DATA_DIR/tmp/uploads, not just the top level,
  // so crashed backup temps are surfaced too (the boot sweep removes them, but a long-running instance that has
  // not restarted since the crash still benefits from the alert).
  const base = [...new Set([cfg.DATA_DIR, cfg.CACHE_DIR].filter(Boolean))];
  // Scan: the data/cache roots (crashed *.tmp atomic writes), DATA_DIR/tmp + tmp/uploads (crashed backup
  // staging + uploads), and DATA_DIR/workspaces (crashed restore leaves a `<workspace>.restoring-*` staging dir
  // as a sibling of the workspace there).
  const wsRoot = cfg.DATA_DIR ? path.join(cfg.DATA_DIR, 'workspaces') : null;
  const dirs = [...new Set([
    ...base,
    ...base.map(d => path.join(d, 'tmp')),
    ...base.map(d => path.join(d, 'tmp', 'uploads')),
    ...(wsRoot ? [wsRoot] : []),
  ])];
  const HOUR = 3600 * 1000;
  const now = Date.now();
  const stale = [];
  for (const d of dirs) {
    let names;
    try { names = await fs.readdir(d); } catch (e) { continue; }
    for (const n of names) {
      // A crashed atomic write leaves a *.tmp; a crashed restore leaves a `<workspace>.restoring-*` staging dir.
      if (!n.endsWith('.tmp') && !n.includes('.restoring-')) continue;
      try { const st = await fs.stat(path.join(d, n)); if (now - st.mtimeMs > HOUR) stale.push(n); } catch (e) {}
    }
  }
  if (stale.length) {
    return { action: 'watchdog.stale_temp_writes', detail: `${stale.length} orphaned .tmp file(s) older than an hour in the data/cache directory (${stale.slice(0, 4).join(', ')}) — the fingerprint of an interrupted atomic write (a crash or full disk mid-commit). They are safe to delete.` };
  }
  return null;
});

// index_matches_documents — a defense-in-depth net for the "served index is empty though
//    documents exist" failure class (e.g. a cache that failed to load): once the index is
//    ready and idle, an empty in-memory parentMap while the manifest still records real
//    (non-skipped) documents means the corpus is silently unsearchable. Reads the active
//    manifest (one cheap JSON read). A truly empty or all-skipped workspace stays quiet.
register('index_matches_documents', async function () {
  let state;
  try { state = require('./state'); } catch (e) { return null; }
  if (!state.indexReady || state.indexing) return null;             // still building — not an anomaly
  if (state.parentMap && state.parentMap.size > 0) return null;     // has documents in memory — fine
  let tracked = 0;
  try {
    const { loadManifest } = require('./indexing/manifest');
    const mf = await loadManifest();
    tracked = Object.keys(mf || {}).filter(k => !k.startsWith('_') && mf[k] && !mf[k].skipped).length;
  } catch (e) { return null; }
  if (tracked > 0) {
    return { action: 'watchdog.index_empty_but_documents_exist', detail: `the manifest records ${tracked} indexed document(s) but the in-memory index is empty, so the corpus is unsearchable. Run Settings → Rebuild index to recover.` };
  }
  return null;
});

// documents_dim_mismatched — the embedding-dimension guard (lib/indexing/delta.js) keeps a document
//    searchable by keyword when the model's vector dimension no longer matches the active bank, and warns
//    once at index time. After that log scrolls away there is no standing signal, so documents stranded in
//    keyword-only search are invisible. Scan the active manifest (one cheap read) and surface a count so the
//    silent degradation has a visible, actionable cause. A corpus with no mismatches stays quiet.
register('documents_dim_mismatched', async function () {
  let state;
  try { state = require('./state'); } catch (e) { return null; }
  if (!state.indexReady || state.indexing) return null;            // still building — not an anomaly
  let n = 0;
  try {
    const { loadManifest } = require('./indexing/manifest');
    const mf = await loadManifest();
    n = Object.keys(mf || {}).filter(k => !k.startsWith('_') && mf[k] && mf[k].dimMismatch).length;
  } catch (e) { return null; }
  if (n > 0) {
    return { action: 'watchdog.documents_dim_mismatched', detail: `${n} document(s) could not be embedded because the embedding model's vector dimension changed for the current model, so they are searchable by keyword only. Point the model at a distinct name or endpoint, or run Settings → Rebuild index to re-embed everything at the new dimension.` };
  }
  return null;
});

// web_egress_all_cooled — when an outbound proxy pool is configured, every exit failing its connection
//    repeatedly puts all of them into cooldown, so web search and page fetches fail. A foreground search
//    shows the user an error, but background web features (auto-suggest, scheduled ingestion) fail silently.
//    Surface a single aggregate signal when EVERY configured exit is currently resting. Only fires when a
//    pool is set and all of its exits are cooled, so a single transient cooldown (normal rotation) stays
//    quiet. Direct (no-proxy) setups have no exits and never trip this.
register('web_egress_all_cooled', function () {
  let wp;
  try { wp = require('./webproxy'); } catch (e) { return null; }
  let pool, snap;
  try { pool = wp.getWebProxyUrls(); snap = wp.exitHealthSnapshot(); } catch (e) { return null; }
  if (!Array.isArray(pool) || pool.length === 0) return null;        // no proxy pool — nothing to watch
  if (!Array.isArray(snap) || snap.length === 0) return null;        // no outcomes recorded yet
  const cooled = snap.filter(e => e && e.cooledMsRemaining > 0);
  // Require an outcome for every configured exit AND all of them cooled, so a partially-probed pool or one
  // transiently-rested exit never raises a false alarm.
  if (cooled.length === snap.length && cooled.length >= pool.length) {
    return { action: 'watchdog.web_egress_all_cooled', detail: `all ${pool.length} configured web proxy exit(s) are resting after repeated connection failures, so web search and page fetches are failing. Check that the proxies are reachable; background web features stay affected until at least one exit recovers.` };
  }
  return null;
});

// Teardown hook for graceful shutdown: disable the event-loop-delay histogram so no monitor is left enabled
// after the process is asked to stop. The histogram does not ref the loop (so it never kept the process alive),
// but symmetry with the watchdog interval's clearInterval keeps the teardown complete. Best-effort, never throws.
function stop() {
  try { if (_eldHistogram) { _eldHistogram.disable(); _eldHistogram = null; } } catch (e) { /* best-effort */ }
}

module.exports = { register, list, run, stop, lastFindings };
