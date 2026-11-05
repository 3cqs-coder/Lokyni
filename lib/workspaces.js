'use strict';
// Workspaces — separate document collections, each with its own index.
//
// Why this exists: retrieval quality degrades as unrelated documents pile into one
// corpus. BM25 medians drift, the reranker sees more plausible-but-wrong candidates,
// and topic-shift detection has more ways to go wrong. Keeping a legal corpus apart
// from a technical one measurably improves answers in both — it's a retrieval
// feature, not just organization.
//
// Layout, entirely under data/:
//
//   data/
//     workspaces/
//       default/
//         documents/          ← the user's files for this workspace
//         vector_store/       ← FAISS index, manifest, passage/child maps
//       research/
//         documents/
//         vector_store/
//       workspaces.json       ← id, name, created, and the last-active id
//     sessions/               ← conversations, shared across workspaces
//
// There is ONE active workspace at a time, server-side: the process keeps a single
// workspace's index loaded in memory (state.workspaceId), and switching via the
// Settings dropdown calls /api/workspaces/switch to change it for the whole server.
// The status heartbeat broadcasts the active workspace, so every open window converges
// on it. (Two windows therefore share one active workspace rather than each holding
// their own — a per-connection active workspace would require carrying the workspace
// id on every query and resolving a per-workspace bundle instead of the global index.)
const fs   = require('fs');
const { isWindowsReserved } = require('./paths');
const path = require('path');

const DEFAULT_ID = 'default';

// A workspace id that is a Windows device name cannot be created as a directory there. New ids are prefixed so
// a workspace named "CON" works everywhere; the shared reserved-name rule lives in lib/paths.js.
// Slug a display name into a safe directory name. Path separators, traversal, and
// anything non-portable are stripped — this value becomes a directory under data/.
const slugify = (name) => {
  const id = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'workspace';
  return isWindowsReserved(id) ? `ws-${id}`.slice(0, 48) : id;
};

// A workspace id is only ever used to build a path, so validate it strictly rather
// than relying on slugify having been applied. On Windows, also refuse a legacy reserved device name:
// such a directory cannot exist, and letting it through would turn a lookup into a filesystem error.
const isValidId = (id) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,47}$/.test(id)
  && !(process.platform === 'win32' && isWindowsReserved(id));

const workspacesRoot = (dataDir) => path.join(dataDir, 'workspaces');
const registryPath   = (dataDir) => path.join(workspacesRoot(dataDir), 'workspaces.json');

// ── mtime-keyed read cache for the small JSON stores read on the answer/API hot path ──
// The workspace registry and each workspace's settings (persona, toggles) are read 2–3× per chat turn and per
// API request — workspace resolution, persona lookup, access checks. Re-reading + re-parsing them with sync fs
// on every call blocks the event loop, worst over a network-mounted shared data dir under scale-out. This
// mirrors jsonstore.js: a cheap stat decides whether to re-read, so an unchanged file is served from memory and
// a change by another node is still picked up on the very next request (the stat is never throttled). Keyed by
// absolute path; the writers below invalidate their entry so a same-process write is seen immediately too. The
// map is bounded by the number of workspaces (one registry path + one settings path per workspace).
const _jsonCache = new Map();   // path -> { mtimeMs, value }
const readJsonCached = (p) => {
  let mtimeMs;
  try { mtimeMs = fs.statSync(p).mtimeMs; }
  catch { _jsonCache.delete(p); return undefined; }   // absent → no cached value
  const hit = _jsonCache.get(p);
  if (hit && hit.mtimeMs === mtimeMs) return hit.value;
  let value;
  try { value = JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch { value = undefined; }   // corrupt → undefined, cached by the REAL mtime so it's parsed once per change
  _jsonCache.set(p, { mtimeMs, value });
  return value;
};
const invalidateJsonCache = (p) => { _jsonCache.delete(p); };

const workspaceDir = (dataDir, id) => {
  if (!isValidId(id)) throw new Error(`Invalid workspace id: ${id}`);
  return path.join(workspacesRoot(dataDir), id);
};

const docsDirFor  = (dataDir, id) => path.join(workspaceDir(dataDir, id), 'documents');
const cacheDirFor = (dataDir, id) => path.join(workspaceDir(dataDir, id), 'vector_store');

// Read the registry, creating a default workspace if none exists.
//
// This is the single guarantee that at least one workspace always exists. It holds
// even when the registry file is missing, empty, corrupt, or hand-edited to remove
// every entry — the default is re-added rather than leaving the app with nowhere to
// put documents. Callers can rely on the returned list being non-empty.
const loadRegistry = (dataDir) => {
  // Served from the mtime cache (the raw parse); the normalization below runs each call and builds fresh
  // objects, so callers never share a mutable cached array.
  const raw = readJsonCached(registryPath(dataDir));
  let list = (raw && Array.isArray(raw.workspaces)) ? raw.workspaces : [];

  list = list.filter(w => w && isValidId(w.id)).map(w => ({
    id: w.id,
    name: typeof w.name === 'string' && w.name.trim() ? w.name : w.id,
    created: w.created || Date.now(),
  }));

  // Belt and braces: re-add the default if it's missing, and if filtering removed
  // everything (a registry full of invalid ids) fall back to the default alone.
  if (!list.some(w => w.id === DEFAULT_ID)) {
    list.unshift({ id: DEFAULT_ID, name: 'Default', created: Date.now() });
  }
  if (list.length === 0) {
    list = [{ id: DEFAULT_ID, name: 'Default', created: Date.now() }];
  }
  return list;
};

// Guarantee a usable workspace: the registry lists it AND its directories exist.
// A registry entry alone isn't enough — if the directory is deleted (manually, or by
// a failed operation) every path resolves to something unreadable and indexing fails
// with ENOENT. Returns the id of a workspace that is safe to use.
const ensureUsableWorkspace = (dataDir, preferredId = null) => {
  const list = loadRegistry(dataDir);
  const candidates = [];
  if (preferredId && isValidId(preferredId)) candidates.push(preferredId);
  candidates.push(DEFAULT_ID);
  for (const w of list) candidates.push(w.id);

  for (const id of candidates) {
    if (!list.some(w => w.id === id)) continue;
    try {
      ensureWorkspace(dataDir, id);      // creates the directories if absent
      return id;
    } catch { /* unwritable — try the next candidate */ }
  }
  // Nothing in the registry could be created (permissions, read-only disk). Make a
  // last attempt at the default so the caller gets a definite answer.
  ensureWorkspace(dataDir, DEFAULT_ID);
  return DEFAULT_ID;
};

const saveRegistry = (dataDir, list) => {
  fs.mkdirSync(workspacesRoot(dataDir), { recursive: true });
  // Preserve the persisted lastActive across saves — writing just { workspaces }
  // would drop it every time a workspace is created, renamed, or deleted.
  let lastActive;
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath(dataDir), 'utf-8'));
    if (raw && typeof raw.lastActive === 'string') lastActive = raw.lastActive;
  } catch { /* no existing registry */ }
  const out = { workspaces: list };
  if (lastActive) out.lastActive = lastActive;
  require('./disk').writeFileAtomic(registryPath(dataDir), JSON.stringify(out, null, 2));
  invalidateJsonCache(registryPath(dataDir));   // so a same-process read sees the write immediately, not at the next mtime tick
};

// The workspace to load at startup — the one the user was last in. Falls back to
// the default when nothing valid is stored (first run, corrupt registry, or a
// lastActive pointing at a workspace that's since been deleted).
const getLastActive = (dataDir) => {
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath(dataDir), 'utf-8'));
    const id = raw && raw.lastActive;
    if (isValidId(id) && loadRegistry(dataDir).some(w => w.id === id)) return id;
  } catch { /* missing or corrupt */ }
  return DEFAULT_ID;
};

// Record the active workspace so the next startup reopens it. Called on every
// switch. Best-effort: a failure here just means the next launch opens the
// default, which is harmless.
const setLastActive = (dataDir, id) => {
  if (!isValidId(id)) return;
  try {
    fs.mkdirSync(workspacesRoot(dataDir), { recursive: true });
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(registryPath(dataDir), 'utf-8')) || {}; } catch { /* new file */ }
    if (!Array.isArray(raw.workspaces)) raw.workspaces = loadRegistry(dataDir);
    raw.lastActive = id;
    require('./disk').writeFileAtomic(registryPath(dataDir), JSON.stringify(raw, null, 2));
    invalidateJsonCache(registryPath(dataDir));
  } catch { /* best-effort */ }
};

// Ensure a workspace's directories exist.
const ensureWorkspace = (dataDir, id) => {
  fs.mkdirSync(docsDirFor(dataDir, id),  { recursive: true });
  fs.mkdirSync(cacheDirFor(dataDir, id), { recursive: true });
};

// Count files under a directory, including subfolders, skipping dotfiles/dot-dirs (a rough document count
// for display, not an exact inventory). Uses the shared depth-first walker (lib/fswalk) so the traversal
// skeleton isn't re-implemented; only this skip policy is local.
const countFiles = (dir) => require('./fswalk').countFiles(dir, (name) => name.startsWith('.'));
const countFilesAsync = (dir) => require('./fswalk').countFilesAsync(dir, (name) => name.startsWith('.'));

// Does a workspace with this id actually exist in the registry? A valid-format id is not enough —
// a browser request can carry any well-formed slug, and acting on one that was never created would
// spawn orphan directories and background loads. Callers use this to fall back to the active
// workspace for an unknown id, matching resolveAccess's registry check.
const exists = (dataDir, id) => isValidId(id) && loadRegistry(dataDir).some(w => w.id === id);

const listWorkspaces = (dataDir, { withCounts = true } = {}) => {
  const list = loadRegistry(dataDir);
  if (!withCounts) return list.map(w => ({ ...w }));   // callers that only need ids skip the disk walk
  const state = require('./state');
  return list.map(w => {
    // For the ACTIVE workspace report what's actually indexed — that's the number
    // the status badge shows, and two different counts for the same workspace is
    // just confusing. For the others, count files on disk recursively; a shallow
    // count ignored subfolders and made a nested corpus look nearly empty.
    const documents = (w.id === state.workspaceId && state.indexReady)
      ? state.parentMap.size
      : countFiles(docsDirFor(dataDir, w.id));
    return { ...w, documents };
  });
};

// Async variant for HTTP/MCP requests: counting a large non-active workspace must not block the event loop.
// The active workspace still reads its live index synchronously (a Map size), and metadata-only callers use
// listWorkspaces(..., { withCounts: false }).
const listWorkspacesAsync = async (dataDir, { withCounts = true } = {}) => {
  const list = loadRegistry(dataDir);
  if (!withCounts) return list.map(w => ({ ...w }));
  const state = require('./state');
  // Sequential awaits, not Promise.all: each count walks a directory tree, and enumerating many large
  // workspaces in parallel would open a burst of directory handles and hammer a network mount. Awaiting one
  // at a time still yields the event loop between them.
  const out = [];
  for (const w of list) {
    const documents = (w.id === state.workspaceId && state.indexReady)
      ? state.parentMap.size
      : await countFilesAsync(docsDirFor(dataDir, w.id));
    out.push({ ...w, documents });
  }
  return out;
};

const createWorkspace = (dataDir, name) => {
  const list = loadRegistry(dataDir);
  let id = slugify(name);
  // Avoid collisions rather than silently merging into an existing workspace.
  if (list.some(w => w.id === id)) {
    let n = 2;
    while (list.some(w => w.id === `${id}-${n}`)) n++;
    id = `${id}-${n}`;
  }
  const ws = { id, name: String(name || id).slice(0, 64), created: Date.now() };
  list.push(ws);
  saveRegistry(dataDir, list);
  ensureWorkspace(dataDir, id);
  return ws;
};

// Remove a workspace and everything in it. Two guards, not one: the default can
// never be deleted, and neither can the last remaining workspace — even if the
// registry has somehow been edited so that the only entry isn't the default. There
// must always be somewhere for documents to live.
const deleteWorkspace = (dataDir, id) => {
  if (id === DEFAULT_ID) throw new Error('The default workspace cannot be deleted');
  const list = loadRegistry(dataDir);
  if (!list.some(w => w.id === id)) throw new Error('No such workspace');
  if (list.length <= 1) throw new Error('Cannot delete the only workspace');
  fs.rmSync(workspaceDir(dataDir, id), { recursive: true, force: true });
  invalidateJsonCache(settingsPath(dataDir, id));   // drop the deleted workspace's settings cache entry so the map can't leak across create/delete churn
  saveRegistry(dataDir, list.filter(w => w.id !== id));
  // Re-assert the invariant after the write, in case the filter emptied the list.
  ensureUsableWorkspace(dataDir);
};

const renameWorkspace = (dataDir, id, name) => {
  const list = loadRegistry(dataDir);
  const ws = list.find(w => w.id === id);
  if (!ws) throw new Error('No such workspace');
  ws.name = String(name || ws.name).slice(0, 64);
  saveRegistry(dataDir, list);
  return ws;
};

// One-time migration: move a pre-workspaces layout (data/documents, data/vector_store)
// into data/workspaces/default/. Runs at startup and is a no-op afterwards, so an
// existing install keeps its documents and index without re-embedding.
const migrateLegacyLayout = (dataDir) => {
  const legacyDocs  = path.join(dataDir, 'documents');
  const legacyCache = path.join(dataDir, 'vector_store');
  const hasLegacy = fs.existsSync(legacyDocs) || fs.existsSync(legacyCache);
  if (!hasLegacy) return false;

  const targetDocs  = docsDirFor(dataDir, DEFAULT_ID);
  const targetCache = cacheDirFor(dataDir, DEFAULT_ID);
  // If the default workspace already has content, the migration already ran (or the
  // user set it up manually) — don't overwrite it.
  const alreadyMigrated = fs.existsSync(targetDocs) &&
    fs.readdirSync(targetDocs).length > 0;
  if (alreadyMigrated) return false;

  fs.mkdirSync(workspaceDir(dataDir, DEFAULT_ID), { recursive: true });
  const move = (from, to) => {
    if (!fs.existsSync(from)) return;
    try {
      require('./disk').renameSyncWithRetry(from, to);
    } catch {
      // Rename can fail across devices — fall back to copy, then remove.
      fs.cpSync(from, to, { recursive: true });
      fs.rmSync(from, { recursive: true, force: true });
    }
  };
  move(legacyDocs, targetDocs);
  move(legacyCache, targetCache);
  ensureWorkspace(dataDir, DEFAULT_ID);

  // Document ids are hashes of the full file path, and the migration changed every
  // path — so the moved index refers to ids that no longer exist and every document
  // would list as "pending" forever. Drop the manifest so the next delta run
  // re-indexes under the new paths. The vectors are rebuilt rather than salvaged:
  // remapping ids inside the FAISS store isn't worth the complexity for a one-time
  // migration.
  try {
    fs.rmSync(path.join(targetCache, require('./constants').CACHE_FILES.manifest), { force: true });
    console.log(`📁 Migrated documents into data/workspaces/${DEFAULT_ID}/ — reindexing (paths changed)`);
  } catch {
    console.log(`📁 Migrated existing documents and index into data/workspaces/${DEFAULT_ID}/`);
  }
  return true;
};

// Per-workspace settings, stored as workspace.json inside the workspace directory.
// Currently this holds sourcePaths (the extra folders indexed alongside documents/).
// These are deliberately NOT global: a workspace exists to isolate a corpus, and
// sharing indexed folders across all of them would defeat that — a new workspace
// would immediately inherit every file from every configured folder.
const settingsPath = (dataDir, id) => path.join(workspaceDir(dataDir, id), 'workspace.json');

// One-time move of the legacy GLOBAL sourcePaths into the default workspace.
//
// Indexed folders used to live in config.json and every workspace inherited them.
// They're now per-workspace, with the default falling back to the global value for
// existing installs — but that fallback is fragile: saving folders in ANY workspace
// removed the global entry, silently stripping the default workspace's folders.
// Copying the value in makes the default self-contained so nothing else can take it.
const migrateLegacySources = (dataDir, globalSourcePaths) => {
  if (!Array.isArray(globalSourcePaths) || globalSourcePaths.length === 0) return false;
  const current = loadSettings(dataDir, DEFAULT_ID);
  if (Array.isArray(current.sourcePaths)) return false;   // already migrated
  current.sourcePaths = globalSourcePaths;
  saveSettings(dataDir, DEFAULT_ID, current);
  console.log(`📂 Moved ${globalSourcePaths.length} indexed folder(s) into the default workspace`);
  return true;
};

const loadSettings = (dataDir, id) => {
  const raw = readJsonCached(settingsPath(dataDir, id));
  if (!raw || typeof raw !== 'object') return {};
  // Return a CLONE, not the cached object: updateSettings (and other callers) mutate the result in place, which
  // would otherwise corrupt the shared cached value. structuredClone is a deep copy (Node 22+); it still saves
  // the blocking disk read + parse, which was the hot-path cost.
  try { return structuredClone(raw); } catch { return JSON.parse(JSON.stringify(raw)); }
};

const saveSettings = (dataDir, id, settings) => {
  ensureWorkspace(dataDir, id);
  require('./disk').writeFileAtomic(settingsPath(dataDir, id), JSON.stringify(settings || {}, null, 2));
  invalidateJsonCache(settingsPath(dataDir, id));   // next loadSettings re-reads the just-written state
};

// Atomic read-modify-write of a workspace's settings. `mutate` receives the freshly-read
// settings, mutates it in place (or returns a replacement), and the result is written
// back — all synchronously, with no await in between. This closes the lost-update race a
// naive load → (long await) → save has: a background job that read settings before an
// awaited task must persist through here afterwards so it merges onto current state
// instead of clobbering a change made while it was running. Returns the written settings.
const updateSettings = (dataDir, id, mutate) => {
  const current = loadSettings(dataDir, id);
  const next = mutate(current) || current;
  saveSettings(dataDir, id, next);
  return next;
};

// Validate a requested workspace id and a principal's access to it. Pure — returns
// { ok:true, id } or { ok:false, status, error }. The HTTP API and the MCP endpoint both
// use this so the id / existence / key-permission checks can't drift between the two.
const resolveAccess = (dataDir, requested, apiKey) => {
  // A present-but-non-string workspace (e.g. a repeated ?workspace=a&workspace=b query param arrives as an
  // array) is a malformed request — 400 it rather than silently falling back to the default and masking intent.
  // Absent/empty means "use the default".
  if (requested != null && requested !== '' && typeof requested !== 'string') {
    return { ok: false, status: 400, error: 'workspace must be a single string id' };
  }
  const id = (typeof requested === 'string' && requested) ? requested : DEFAULT_ID;
  if (!isValidId(id)) return { ok: false, status: 400, error: `Invalid workspace id: ${id}` };
  // A workspace an API key may NOT use is reported EXACTLY like one that does not exist (404), checked before
  // the existence lookup. Otherwise a key with a restricted allow-list could tell "exists but forbidden" (403)
  // from "not found" (404) and enumerate workspace ids outside its allow-list. A human/owner caller (no apiKey)
  // is unaffected — the allow-list check only applies to a key.
  if (apiKey && !require('./apikeys').mayUseWorkspace(apiKey, id)) return { ok: false, status: 404, error: `No such workspace: ${id}` };
  if (!loadRegistry(dataDir).some(w => w.id === id)) return { ok: false, status: 404, error: `No such workspace: ${id}` };
  return { ok: true, id };
};

module.exports = {
  DEFAULT_ID, slugify, isValidId, resolveAccess,
  workspaceDir, docsDirFor, cacheDirFor,
  exists, listWorkspaces, listWorkspacesAsync, createWorkspace, deleteWorkspace, renameWorkspace,
  ensureWorkspace, ensureUsableWorkspace, migrateLegacyLayout, loadRegistry, saveRegistry,
  getLastActive, setLastActive,
  loadSettings, saveSettings, updateSettings, migrateLegacySources,
};
