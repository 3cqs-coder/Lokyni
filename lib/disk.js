'use strict';

// ── disk — free-space probe ──────────────────────────────────────────────────
//
// Lokyni continuously writes the FAISS index, the vector store, OCR/context caches, and
// backups. When the disk fills, those writes fail or truncate mid-way and the index can be
// left inconsistent — a confusing failure the user can't diagnose from "indexing failed". A
// cheap free-space read lets the boot watchdog warn early and the health endpoint show the
// headroom.
//
// Uses fs.statfsSync (Node ≥ 18.15). On older Node — or any error — it returns null so
// callers degrade to "unknown" rather than failing: this is best-effort observability, never
// a gate.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// The free-space floor shared by the boot warning and the periodic watchdog. Below this, indexing,
// OCR caches, backups, and temporary uploads can fail mid-write; surfacing the same number in both
// places keeps the guidance consistent.
const LOW_DISK_BYTES = 500 * 1024 * 1024;

// A per-writer unique temp name in the SAME directory as the target, so the follow-up rename stays atomic
// on one filesystem. A fixed `file + '.tmp'` is safe only while a single writer touches the file at a time;
// the OCR cache, for one, is flushed by BOTH the parent and each isolated extract child, so if those writes
// ever overlap they would race on one shared temp and interleave into a corrupt file. A pid+random suffix
// keeps each writer's temp private and removes that whole class of hazard (the scheme lib/sessions.js uses).
const uniqueTmp = (file) => `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;

// Bytes available to an unprivileged process on the filesystem holding `dir`. `bavail` (not
// `bfree`) is the honest figure — it excludes the root-reserved blocks the app can't use.
// Before first index the data dir may not exist yet, so climb to the nearest existing ancestor
// (the same volume) rather than reporting "unknown" exactly when free space matters most.
// Returns null on old Node without fs.statfs, or if nothing along the path can be measured, so
// callers degrade to "unknown" rather than failing — this is observability, never a gate.
function freeBytes(dir) {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    let cur = path.resolve(dir || '.');
    for (let i = 0; i < 64; i++) {
      try {
        const s = fs.statfsSync(cur);
        const free = Number(s.bsize) * Number(s.bavail);
        return Number.isFinite(free) ? free : null;
      } catch (e) {
        const parent = path.dirname(cur);
        if (parent === cur) return null;   // reached the root and still couldn't measure
        cur = parent;
      }
    }
    return null;
  } catch (e) { return null; }
}

// Async variant of freeBytes, so a caller that must NOT block the event loop (e.g. the continuous watchdog,
// which may probe a slow/hung network-mounted data dir in scale-out mode) can await it and bound it with a
// timeout. Same contract: null when it can't be measured. fs.promises.statfs exists on the same Node versions
// as statfsSync, so the feature check mirrors the sync path.
async function freeBytesAsync(dir) {
  try {
    if (!fs.promises || typeof fs.promises.statfs !== 'function') return null;
    let cur = path.resolve(dir || '.');
    for (let i = 0; i < 64; i++) {
      try {
        const s = await fs.promises.statfs(cur);
        const free = Number(s.bsize) * Number(s.bavail);
        return Number.isFinite(free) ? free : null;
      } catch (e) {
        const parent = path.dirname(cur);
        if (parent === cur) return null;
        cur = parent;
      }
    }
    return null;
  } catch (e) { return null; }
}

// ── Windows-safe renames ─────────────────────────────────────────────────────
// On Windows, an antivirus scanner, an indexer, or another handle can briefly hold the target or the temp
// file, making rename() fail with EPERM/EBUSY/EACCES. A single failure would abort an otherwise valid atomic
// write (a settings save, a key store, an index map). Retry a few times with a short backoff; POSIX keeps the
// one-shot rename, so its behavior and latency are unchanged. The sync path blocks for at most ~300 ms in the
// rare locked case; the async path never blocks the event loop.
const RENAME_ATTEMPTS = 5;
const RETRYABLE_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);
const sleepSync = (ms) => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const end = Date.now() + ms; while (Date.now() < end) { /* bounded fallback */ } }
};
const renameSyncWithRetry = (from, to) => {
  if (process.platform !== 'win32') { fs.renameSync(from, to); return; }
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; }
    catch (e) {
      if (i >= RENAME_ATTEMPTS || !RETRYABLE_RENAME.has(e && e.code)) throw e;
      sleepSync(20 * (i + 1));
    }
  }
};
const renameWithRetry = async (from, to) => {
  if (process.platform !== 'win32') { await fs.promises.rename(from, to); return; }
  for (let i = 0; ; i++) {
    try { await fs.promises.rename(from, to); return; }
    catch (e) {
      if (i >= RENAME_ATTEMPTS || !RETRYABLE_RENAME.has(e && e.code)) throw e;
      await new Promise((resolve) => setTimeout(resolve, 20 * (i + 1)));
    }
  }
};

// Atomically write `contents` to `file` (temp + rename), so a crash or full disk mid-write
// can't leave a truncated file that a tolerant loader then reads as empty — silently losing
// the whole store (e.g. every API key, or the workspace list). Synchronous, for the small
// managed JSON stores; the large index maps use their own async temp+rename in delta.js.
// Takes the already-stringified content so each caller keeps its own formatting.
// `mode` (optional) restricts the file's permissions — pass 0o600 for a store that holds secrets or
// secret-derived material (e.g. API-key hashes) so another local user on a shared host can't read it.
// The mode is applied to the temp file so the atomic rename lands a file with that mode; chmod after
// write covers a pre-existing temp file that kept a wider mode. On Windows these bits are largely
// ignored, which is harmless.
function writeFileAtomic(file, contents, mode) {
  const tmp = uniqueTmp(file);
  // Write, fsync, THEN rename. These stores are small and critical (API-key hashes, config, the
  // workspace list); fsyncing the bytes before the rename means a crash between the two can't leave a
  // present-but-torn file that a tolerant loader reads as empty — silently losing the whole store.
  try {
    const fd = fs.openSync(tmp, 'w', mode || 0o666);
    try { fs.writeSync(fd, contents); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    if (mode) { try { fs.chmodSync(tmp, mode); } catch {} }
    renameSyncWithRetry(tmp, file);
    fsyncDirSync(path.dirname(file));   // make the rename itself durable (not just the file's bytes)
  } catch (e) {
    // A failed write must not leak its private temp (unique names don't self-overwrite next time).
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

// Async atomic JSON write (temp + rename) for the index chunk maps (child and passage maps). The
// temp+rename gives crash-safety (a crash mid-write can't truncate the live file), and the write and
// rename are async so they don't block the event loop. Note that `JSON.stringify(obj)` itself is still
// synchronous — for a large map that serialize is a real (bounded) main-thread cost during an index
// commit; it is accepted here because these maps hold chunk-sized text and persistence happens during
// indexing rather than on the query path. The parent map holds every document's FULL text and so is far
// larger; it is streamed as NDJSON by lib/indexing/parentmapstore.js instead, never built into one
// whole-corpus string.
async function writeJsonAtomic(file, obj) {
  const tmp = uniqueTmp(file);
  // fsync before rename (see writeFileAtomic) so a crash can't land a torn map the loader reads as empty.
  try {
    const fh = await fs.promises.open(tmp, 'w');
    try { await fh.writeFile(JSON.stringify(obj), 'utf-8'); await fh.sync(); }
    finally { await fh.close(); }
    await renameWithRetry(tmp, file);
    await fsyncDir(path.dirname(file));   // make the rename itself durable (not just the file's bytes)
  } catch (e) {
    try { await fs.promises.rm(tmp, { force: true }); } catch {}
    throw e;
  }
}

// Async atomic write (temp + rename, NO fsync) for best-effort, regenerable stores — saved sessions, the
// semantic-answer cache, the downloaded OCR language data. Takes already-encoded `contents` (a string or a
// Buffer), writes to a unique temp beside the target, then renames (atomic on the same filesystem) so a
// concurrent reader never sees a half-written file and two interleaved writers can't clobber one temp. It
// deliberately skips the fsync that writeFileAtomic/writeJsonAtomic do: these stores are rebuilt from source
// if a power loss ever surfaces a torn one, and the per-write fsync isn't worth its latency on these hot,
// non-critical paths. On any failure it removes its private temp and rethrows, so the caller's own catch
// decides whether to swallow (caches) or surface it. `mode` restricts permissions when the store is sensitive.
async function writeFileAtomicAsync(file, contents, mode) {
  const tmp = uniqueTmp(file);
  try {
    await fs.promises.writeFile(tmp, contents, mode ? { mode } : undefined);
    if (mode) { try { await fs.promises.chmod(tmp, mode); } catch {} }
    await renameWithRetry(tmp, file);
  } catch (e) {
    try { await fs.promises.rm(tmp, { force: true }); } catch {}
    throw e;
  }
}

// fsync a file's data to disk by path (best-effort). Shared so a streamed atomic writer (which closes its
// write stream before renaming) can flush the bytes BEFORE the rename — the same durable-atomic-write
// discipline writeFileAtomic/writeJsonAtomic use — so a power loss just after the rename can't surface a file
// whose contents the OS had not yet flushed. A failure here never throws: durability is best-effort, and the
// callers' fail-closed readers detect a torn file and re-derive.
async function fsyncFile(p) {
  let fh;
  try { fh = await fs.promises.open(p, 'r+'); await fh.sync(); }
  catch { /* best-effort durability */ }
  finally { if (fh) await fh.close().catch(() => {}); }
}

// fsync a DIRECTORY so a rename INTO it is durable (best-effort). fsyncing a renamed file flushes its data,
// but on POSIX the directory entry that makes the new name visible is a separate write — a crash just after a
// returned rename() can lose it, surfacing the old file (or none) and reordering renames relative to each
// other. The durable atomic writers below fsync the containing directory after the rename to close that
// window. Opening a directory for fsync is not supported on Windows (and some filesystems), where this is a
// harmless no-op. Never throws. Sync and async variants mirror the two writers.
function fsyncDirSync(dir) {
  let fd;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); }
  catch { /* unsupported (Windows) or best-effort */ }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}
async function fsyncDir(dir) {
  let fh;
  try { fh = await fs.promises.open(dir, 'r'); await fh.sync(); }
  catch { /* unsupported (Windows) or best-effort */ }
  finally { if (fh) await fh.close().catch(() => {}); }
}

// Create the target directory when missing and prove it is writable with a real temp file. A real
// write catches permission bits, a read-only mount, and a full volume, which a pure access(W_OK) check
// can miss. The probe is removed immediately; a failure returns the actionable error code.
function probeWritable(dir) {
  const target = path.resolve(dir || '.');
  try {
    fs.mkdirSync(target, { recursive: true });
    const probe = uniqueTmp(path.join(target, '.lokyni-write-probe'));
    try { fs.writeFileSync(probe, 'ok', { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
    finally { try { fs.unlinkSync(probe); } catch { /* probe may not have been created */ } }
    return { ok: true, path: target, code: '', message: '' };
  } catch (e) {
    return { ok: false, path: target, code: (e && e.code) || '', message: (e && e.message) || String(e) };
  }
}

module.exports = { freeBytes, freeBytesAsync, LOW_DISK_BYTES, probeWritable, writeFileAtomic, writeJsonAtomic, writeFileAtomicAsync, fsyncFile, fsyncDir, fsyncDirSync, uniqueTmp, renameSyncWithRetry, renameWithRetry };
