'use strict';
// A small versioned JSON cache, stored per workspace alongside the vector index.
//
// Several caches share the same shape: a plain `{ key: value }` object written to one
// JSON file under CACHE_DIR, keyed by a SHA-256 that folds in a version prefix (so a
// pipeline/prompt change invalidates old entries automatically), loaded lazily and
// re-loaded when the active workspace's cache directory changes, and flushed to disk
// once (dirty-guarded) rather than per write. This factory owns that machinery so each
// cache (OCR results, contextual-retrieval blurbs) only supplies its own value
// semantics on top of the returned `load()`d object.
//
// CACHE_DIR is read live on every path lookup, so switching workspaces transparently
// points the cache at the new workspace's directory.

const fs   = require('fs');
const path = require('path');

// Options:
//   file      — filename under CACHE_DIR (e.g. 'ocr-cache.json')
//   prefix    — short key namespace (e.g. 'ocrv') combined with `version`
//   version   — integer; bump to invalidate every prior entry
//   maxBytes  — optional serialized-size cap; when exceeded, oldest entries (by `ageOf`)
//               are evicted on flush until it fits. Omit for no cap.
//   ageOf     — value → sortable age used for eviction (default: v => v.at || 0)
//   dir       — function returning the base directory (default: live CACHE_DIR). Injectable
//               so the cache follows the active workspace, and so tests can use a temp dir.
const createVersionedJsonCache = ({ file, prefix, version, maxBytes = 0, ageOf = (v) => (v && v.at) || 0, dir }) => {
  const crypto = require('crypto');
  const baseDir = typeof dir === 'function' ? dir : () => require('./config').CACHE_DIR;
  let _cache = null;      // { [key]: value }
  let _loadedFor = null;  // the base dir path _cache was loaded from
  let _dirty = false;

  const cachePath = () => path.join(baseDir(), file);

  // SHA-256 of `${prefix}${version}:${discriminator}:` followed by the input (Buffer or string), so a
  // version bump changes every key and stale entries are never served. The optional `discriminator` folds
  // in a value that changes the OUTPUT for the same input — most importantly the model that produced it, so
  // an entry made with one model is not reused after the user switches models (which would otherwise leave a
  // mixed-model corpus after an incremental re-index that doesn't wipe the cache).
  const keyFor = (input, discriminator = '') =>
    crypto.createHash('sha256')
      // Keep the exact prior key when there is no discriminator, so caches that don't vary by model (OCR) are
      // NOT invalidated on upgrade; only fold the extra segment in when a caller supplies one (e.g. the model).
      .update(discriminator ? `${prefix}${version}:${discriminator}:` : `${prefix}${version}:`)
      .update(input).digest('hex');

  // The cache object for the active workspace, loaded (and memoized) on first use and
  // re-read when the workspace's cache directory changes.
  const load = () => {
    const dir = cachePath();
    if (_cache && _loadedFor === dir) return _cache;
    try {
      const parsed = JSON.parse(fs.readFileSync(dir, 'utf-8'));
      _cache = parsed && typeof parsed === 'object' ? parsed : {};
    } catch { _cache = {}; }
    _loadedFor = dir;
    _dirty = false;
    return _cache;
  };

  const markDirty = () => { _dirty = true; };

  // Write once (dirty-guarded). Applies the optional size cap by dropping the oldest
  // entries first — losing a cache entry costs one recompute; unbounded growth costs the
  // disk. Never throws: a cache that can't be written just means slower future runs.
  const flush = () => {
    if (!_dirty || !_cache) return;
    try {
      // Reload the on-disk file and fold in any keys it has that our in-memory copy lacks, so a
      // wholesale write can't clobber entries another process wrote after we loaded. The OCR
      // cache in particular is written by BOTH the parent and the isolated extract child during
      // one index run; without this merge the parent's end-of-run flush would drop the expensive
      // scanned-PDF OCR the child had just cached, forcing a full re-OCR on the next warm start.
      // Safe because every entry is content-hash keyed (an existing key always maps to the same
      // value), so importing disk-only keys never overwrites a fresher value of our own.
      try {
        const onDisk = JSON.parse(fs.readFileSync(cachePath(), 'utf-8'));
        if (onDisk && typeof onDisk === 'object') {
          for (const k of Object.keys(onDisk)) if (!(k in _cache)) _cache[k] = onDisk[k];
        }
      } catch { /* no readable file yet — nothing to merge */ }
      let out = JSON.stringify(_cache);
      if (maxBytes && out.length > maxBytes) {
        // Evict oldest-first until it fits, estimating each entry's byte contribution once
        // and serializing only ONCE more at the end — the old loop re-stringified the whole
        // cache after every single deletion, which is O(n²) on a large trim (the OCR cache
        // can reach tens of MB).
        const entries = Object.entries(_cache)
          .map(([k, v]) => ({ k, size: JSON.stringify(v).length + k.length + 4 }))
          .sort((a, b) => ageOf(_cache[a.k]) - ageOf(_cache[b.k]));
        let size = out.length;
        for (const e of entries) {
          if (size <= maxBytes) break;
          delete _cache[e.k];
          size -= e.size;
        }
        out = JSON.stringify(_cache);
      }
      fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
      // Atomic temp+rename so a crash or full disk mid-write can't truncate the cache
      // (matching every other store's write discipline).
      require('./disk').writeFileAtomic(cachePath(), out);
      _dirty = false;
    } catch { /* a cache that can't be written just means slower future runs */ }
  };

  // Reset in memory and remove the file (called when the derived index is wiped).
  const clear = () => {
    _cache = {};
    _dirty = true;
    try { fs.rmSync(cachePath(), { force: true }); } catch {}
  };

  return { keyFor, load, markDirty, flush, clear, path: cachePath };
};

// A family of instances that share one config but can each target a different directory. The
// default instance (asked for with no dir) follows the live active workspace's CACHE_DIR, exactly
// as before. A specific dir gets its own memoized instance, so a background warm of a NON-active
// workspace can write that workspace's cache into ITS OWN directory instead of the active one's —
// the caches, and any figure crops keyed alongside them, then stay co-located with the workspace
// that references them. Keys are identical across instances (same prefix+version), so the same file
// content maps to the same key everywhere. `inst(dir)` returns the instance for `dir` (or the active
// one when `dir` is falsy); `keyFor` is shared.
const createVersionedJsonCacheFamily = (opts) => {
  const active = createVersionedJsonCache(opts);
  const scoped = new Map();   // dir path -> instance
  const inst = (dir) => {
    if (!dir) return active;
    let i = scoped.get(dir);
    if (!i) { i = createVersionedJsonCache({ ...opts, dir: () => dir }); scoped.set(dir, i); }
    return i;
  };
  return { inst, keyFor: active.keyFor };
};

module.exports = { createVersionedJsonCache, createVersionedJsonCacheFamily };
