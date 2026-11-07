'use strict';
const fs   = require('fs').promises;
const cfgPaths = require('../config');   // cfgPaths.CACHE_DIR / cfgPaths.MANIFEST_PATH read live
const { writeMap, loadMap } = require('./ndjsonmapstore');
const { statKey, ABSENT } = require('../statkey');

// The manifest is a plain key/value object: `_`-prefixed metadata keys (_embeddingModel, _bm25Median,
// _indexFormat, _ocrPipeline, _ocrEnabled, …) plus one entry per indexed file path ({ fileHash, vectorIds,
// skipped, … }). It drives what the next run treats as new/changed.
//
// It is persisted as streaming NDJSON (one `{"k":<key>,"v":<value>}` record per key) through the shared
// ndjsonmapstore, so neither writing nor reading ever builds or parses one string spanning the whole corpus.
// The vectorIds across a very large library would otherwise make the old whole-file JSON.stringify/JSON.parse
// a tens-to-hundreds-of-MB synchronous operation that stalls the event loop and spikes memory (a 2-3x peak).
// A pre-NDJSON whole-JSON manifest is read once (size-guarded against OOM) and converts to NDJSON on the next
// saveManifest — the normal end-of-delta write — so there is no boot-time rewrite that would bump the
// manifest's mtime and make the warm-start/bundle freshness guards needlessly re-derive the index maps.

// The manifest object ⇄ a Map for the key/value store. Metadata keys and file entries are all just keys; the
// `_` prefix is only a convention the consumers read, not a storage distinction.
const toMap = (manifest) => {
  const m = new Map();
  for (const k of Object.keys(manifest || {})) m.set(k, manifest[k]);
  return m;
};
const toObject = (map) => { const o = {}; for (const [k, v] of map) o[k] = v; return o; };

// ACTIVE-workspace boot loader. Distinguishes a MISSING manifest (first run — return {} so boot's
// staleNoManifest/rebuild logic handles any orphan index) from a PRESENT-but-unreadable one — corrupt or
// truncated NDJSON, or an unparseable or oversized legacy file. The latter must FAIL CLOSED: it returns a
// { _corrupt: true } sentinel that contentRebuildReason turns into a wipe-and-rebuild. Returning {} for a
// corrupt-but-present manifest would make the delta treat every document as new and re-embed the whole corpus
// over the existing vectors (duplicate-vector bloat). migrate:false — the next saveManifest (end of the warm
// delta) converts a legacy file to NDJSON, so boot never rewrites it out from under the map freshness guards.
// Never throws, so a torn manifest can't crash boot.
const loadManifest = async () => {
  const map = new Map();
  const res = await loadMap(cfgPaths.MANIFEST_PATH, map, { migrate: false });
  if (!res.present) return {};                 // missing → first run
  if (!res.ok) return { _corrupt: true };      // present but unreadable → fail closed (force a clean rebuild)
  return toObject(map);
};

// NON-active read (the Documents panel and the viewer parse a non-active workspace's manifest on every request,
// and the bundle loader reads it). Fail-open ({} on any problem) and read-only, with an mtime cache so a
// repeated read doesn't re-stream the file. migrate:false so this read-only path never rewrites a non-active
// manifest (which would bump its mtime and make the bundle's map freshness guards re-derive the maps). The
// parsed object is shared across callers, so every caller MUST treat it as read-only — the route callers and
// the bundle loader only iterate it. Correctness never depends on the cache: a miss falls through to a read.
const _manifestCache = new Map();   // path → { stk, data }
const loadManifestFrom = async (manifestPath) => {
  let stk = ABSENT;
  try { stk = statKey(await fs.stat(manifestPath)); } catch { /* absent — yields {} below */ }
  const hit = _manifestCache.get(manifestPath);
  // Keyed on the shared stat fingerprint (lib/statkey.js — mtime + size + inode), so a rewrite within one mtime
  // tick is still picked up. ABSENT (no file) never serves a cached parse — it falls through to a fresh read.
  if (hit && hit.stk === stk && stk !== ABSENT) return hit.data;
  const map = new Map();
  const res = await loadMap(manifestPath, map, { migrate: false });
  const data = (res.present && res.ok) ? toObject(map) : {};
  _manifestCache.set(manifestPath, { stk, data });
  // Bound the cache to a handful of workspaces; drop the oldest insertion (Map preserves insertion order).
  if (_manifestCache.size > 8) _manifestCache.delete(_manifestCache.keys().next().value);
  return data;
};

// Write the manifest as streaming NDJSON. writeMap streams each record with backpressure to a unique temp
// file, fsyncs the bytes, then atomically renames — so a crash mid-write can never truncate the live manifest
// (which the loader would read as empty, re-embedding the whole corpus) and two writers can't interleave.
const saveManifest = async (manifest) => {
  await fs.mkdir(cfgPaths.CACHE_DIR, { recursive: true });
  await writeMap(cfgPaths.MANIFEST_PATH, toMap(manifest));
};

module.exports = { loadManifest, loadManifestFrom, saveManifest };
