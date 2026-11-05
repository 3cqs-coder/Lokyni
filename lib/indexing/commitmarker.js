'use strict';
// Write-ahead commit marker for an index delta. A delta persists the FAISS vectors, the file manifest, and the
// index maps as separate files, so there is an unavoidable window where the vectors are already on disk but the
// manifest has not caught up. A crash in that window would otherwise leave the next delta to re-embed an
// already-stored file (duplicate dense vectors) or orphan a changed file's old vectors (bloat) until a rebuild.
//
// To close that window the delta writes this marker BEFORE it touches the vector store and removes it only once
// every index file is durable. On warm start a marker still present means the last delta did not finish, so the
// index is rebuilt from the documents — reusing contentRebuildReason and the existing wipe-and-rebuild path —
// which produces exactly one clean set of vectors. The marker is a single tiny file written through the shared
// atomic writer (fsync + rename), so a crash can't leave it torn; every read and write here is best-effort and
// never throws, so the marker can never itself fail a commit or wedge a start.

const fs = require('fs');
const path = require('path');
const disk = require('../disk');

const FILE = 'index-commit.json';
const markerPath = (cacheDir) => path.join(cacheDir, FILE);

// Declare a commit in progress, durably, before the vector store is touched. Returns true when the marker
// is written, false when it can't be (e.g. a full/unwritable disk). The caller MUST treat false as "do not
// begin a commit you can't mark": if it swapped the new in-memory index in and then failed to persist, there
// would be no marker to heal the resulting memory-ahead-of-disk divergence. Never throws.
const begin = (cacheDir) => {
  try { disk.writeFileAtomic(markerPath(cacheDir), JSON.stringify({ pending: true, at: Date.now() })); return true; }
  catch { return false; }
};

// Clear the marker once every index file (vectors, manifest, maps) is durable.
const end = (cacheDir) => {
  try { fs.rmSync(markerPath(cacheDir), { force: true }); } catch { /* a stray marker self-clears on the next clean delta */ }
};

// True only when a marker clearly records an unfinished commit. A missing or unreadable marker reads as "not
// pending" so a flaky read can never force an endless rebuild loop.
const isPending = (cacheDir) => {
  try { return JSON.parse(fs.readFileSync(markerPath(cacheDir), 'utf-8')).pending === true; }
  catch { return false; }
};

module.exports = { begin, end, isPending, FILE };
