'use strict';
// A bounded, stat-validated content-hash cache for a MULTI-BATCH operation such as a resumable bank re-embed.
// The consolidation driver runs the normal delta once per batch, and a plain delta hashes every file on every
// pass — reading the entire corpus again and again. A cache entry is reused only while the file's size, mtime,
// and ctime are unchanged; a changed file is re-read and re-hashed, so an edit during the migration is still
// detected. The cache is in-memory and scoped to one run, so it can never serve a stale digest after a restart.
//
// Bounded: at most MAX_ENTRIES paths are retained. Beyond that new paths are hashed but not cached, so even a
// pathological corpus cannot grow this without limit. Never used on a normal delta; only a caller that knows it
// is doing repeated passes passes a cache in.

const fsp = require('fs').promises;
const { hashFile } = require('./files');

const MAX_ENTRIES = 100000;
const keyOf = (st) => `${st.size}:${st.mtimeMs}:${st.ctimeMs}`;

const create = () => new Map();

// Hash one file, using `cache` when its stat is unchanged. Throws if the file cannot be statted or read; the
// delta's per-file isolation turns that into a hold, exactly as an uncached hash failure does.
const hashForPass = async (file, cache) => {
  if (!(cache instanceof Map)) return hashFile(file);
  const st = await fsp.stat(file);
  const key = keyOf(st);
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit.hash;
  const hash = await hashFile(file);
  if (cache.size < MAX_ENTRIES) cache.set(file, { key, hash });
  return hash;
};

module.exports = { create, hashForPass, MAX_ENTRIES };
