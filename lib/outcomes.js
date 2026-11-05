'use strict';
// Outcome records — the capture half of outcome-aware retrieval.
//
// Each record is one answered query: what was asked, which documents were used to
// answer it, the top reranker score, and (later, if the user rates it) a 👍/👎.
// Two things read this corpus:
//   - similarity.js — "you asked something similar before" surfacing, and the set
//     of documents that led to 👎 answers on similar queries (for down-weighting).
//
// Storage: one JSON file per workspace at <cacheDir>/outcomes.json. JSON rather than
// SQLite keeps this dependency-free and consistent with Lokyni's other caches
// (parent-map.json, passage-map.json). At single-user scale (thousands of outcomes)
// a full read/rewrite is cheap; if it ever isn't, this is the one module to swap.
//
// The design pairs per-answer outcome capture with TF-IDF retrieval and a rating
// quality-filter, keyed on the retrieval queries.

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = 'outcomes.json';
const MAX_RECORDS = 5000;   // cap; oldest trimmed beyond this

// Resolve a workspace's outcomes file. Defaults to the active workspace's cache dir,
// but accepts an explicit cacheDir so a non-active-workspace API path can target the
// right file.
const filePathFor = (cacheDir) => path.join(cacheDir || require('./config').CACHE_DIR, FILE);

// ── Load / save ──────────────────────────────────────────────────────────────
// Tiny per-path in-memory cache keyed by file path + mtime, so repeated reads in a
// request don't re-parse. Not load-bearing — correctness never depends on it.
const _mem = new Map();   // filePath → { records, mtimeMs }

const load = (cacheDir) => {
  const fp = filePathFor(cacheDir);
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(fp).mtimeMs; } catch { /* no file yet */ }
  const cached = _mem.get(fp);
  // Trust the cache whenever its mtime matches the file's — INCLUDING mtime 0, which is both "no file yet" and
  // the window after a save() has updated the cache but its async flush has not landed. (An external create or
  // delete changes the mtime, so this still re-reads when the file really changed under us.)
  if (cached && cached.mtimeMs === mtimeMs) return cached.records;
  let records = [];
  try { records = JSON.parse(fs.readFileSync(fp, 'utf-8')); if (!Array.isArray(records)) records = []; }
  catch { records = []; }
  _mem.set(fp, { records, mtimeMs });
  return records;
};

const save = (cacheDir, records) => {
  const fp = filePathFor(cacheDir);
  // Trim to cap, keeping the most recent.
  const trimmed = records.length > MAX_RECORDS ? records.slice(records.length - MAX_RECORDS) : records;
  // Update the in-process cache SYNCHRONOUSLY so the next read in this process sees the new records with no disk
  // round-trip, then flush to disk ASYNCHRONOUSLY so neither the write nor an fsync ever blocks the answer/query
  // hot path (this ran on every completed answer before). Keep the old mtime on the cache entry until the write
  // lands: statSync still returns the old mtime meanwhile, so load()'s mtime check stays a cache hit (no
  // re-parse). The outcomes store is an advisory quality signal and is regenerable, so writeFileAtomicAsync
  // (atomic temp+rename, no fsync) is the right durability tier; a dropped flush never breaks answering.
  const prev = _mem.get(fp);
  _mem.set(fp, { records: trimmed, mtimeMs: prev ? prev.mtimeMs : 0 });
  (async () => {
    try {
      await fs.promises.mkdir(path.dirname(fp), { recursive: true });
      await require('./disk').writeFileAtomicAsync(fp, JSON.stringify(trimmed));
      // Refresh the cached mtime to the just-written file, but only if ours is still the latest write — a newer
      // record() may have replaced the cache entry while we were flushing; don't clobber its records or mtime.
      const cur = _mem.get(fp);
      if (cur && cur.records === trimmed) {
        let mtimeMs = 0; try { mtimeMs = (await fs.promises.stat(fp)).mtimeMs; } catch {}
        if (_mem.get(fp) === cur) _mem.set(fp, { records: trimmed, mtimeMs });
      }
    } catch { /* best-effort; outcome capture must never break answering */ }
  })();
};

// ── Record / update ──────────────────────────────────────────────────────────
// Record a completed answer. Returns the new record's id (for the client to hold so
// it can rate later). `docIds` is the list of parent docIds used to answer.
const record = (cacheDir, { workspace, query, docIds, topReranker }) => {
  if (!query || !Array.isArray(docIds)) return null;
  // A read replica shares the data dir; the primary owns and consumes this learning store. A replica write
  // would race the primary's read-modify-write and lose updates, so a replica records nothing (it still reads
  // the store the primary built). The primary records its own answers.
  if (require('./cluster').isReplica()) return null;
  const records = load(cacheDir).slice();
  const id = crypto.randomBytes(9).toString('base64url');
  records.push({
    id,
    workspace: workspace || null,
    query: String(query).slice(0, 500),
    docIds: docIds.slice(0, 20),
    topReranker: typeof topReranker === 'number' ? topReranker : null,
    rating: null,          // 1 | -1 | null
    ts: Date.now(),
  });
  save(cacheDir, records);
  return id;
};

// Apply a 👍/👎 (1 / -1) to a prior record. Returns true if a record was updated.
const rate = (cacheDir, id, rating) => {
  if (![1, -1].includes(rating)) return false;
  // Like record(): a replica must not write this shared, primary-owned learning store — its whole-file
  // read-modify-write would race the primary and lose updates. The primary owns rating persistence.
  if (require('./cluster').isReplica()) return false;
  const records = load(cacheDir).slice();
  const idx = records.findIndex(r => r.id === id);
  if (idx === -1) return false;
  records[idx] = { ...records[idx], rating, ratedAt: Date.now() };
  save(cacheDir, records);
  return true;
};

// All records for similarity/analysis. Returns a shallow copy.
const all = (cacheDir) => load(cacheDir).slice();

// Record count only — for a cache-validity check that must not pay for a full array copy on every query.
const count = (cacheDir) => load(cacheDir).length;

// Summary counts — used to decide whether there's enough signal for down-weighting.
const stats = (cacheDir) => {
  const records = load(cacheDir);
  let up = 0, down = 0, rated = 0;
  for (const r of records) {
    if (r.rating === 1)  { up++; rated++; }
    else if (r.rating === -1) { down++; rated++; }
  }
  return { total: records.length, up, down, rated };
};

module.exports = { record, rate, all, count, stats };
