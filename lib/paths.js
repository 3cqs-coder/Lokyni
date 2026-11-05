'use strict';
// Shared path helpers.
//
// Containment checking was implemented five separate times across the codebase with
// subtly different logic, and four of the five broke when the root already ended in
// a separator — which happens for a Windows drive root (`C:\`) or a filesystem-root
// source folder, producing `C:\\file` and failing to match. Since these checks guard
// the document viewer, the folder browser, backup restore and the upload route,
// divergence between them is a security concern as much as a correctness one.
const path = require('path');

// Is `target` the same as `root`, or inside it?
//
// Both sides are resolved first: comparing a resolved absolute path against a
// relative root (DATA_DIR is './data') can never match, which previously rejected
// every file during a backup restore. The separator is only appended when the root
// doesn't already end in one.
//
// On Windows the filesystem is always case-insensitive, so a target and root that
// differ only in letter case name the same location and must compare equal — a
// case-sensitive prefix test there wrongly reports "not contained", which for the
// indexing purge logic can drop still-present documents and force a needless
// re-embed. The fold is applied ONLY on Windows: it is unconditionally correct
// there, whereas macOS and Linux volumes can be genuinely case-sensitive, where
// folding could instead treat two distinct directories as contained.
const isWithin = (target, root) => {
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const abs  = fold(path.resolve(target));
  const base = fold(path.resolve(root));
  if (abs === base) return true;
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  return abs.startsWith(prefix);
};

// Of the given source-folder roots, which are NOT reachable right now (unmounted drive, offline
// share). Used to HOLD a document rather than purge/wipe it when its whole root is unavailable.
// The stat runs on the libuv threadpool (never the sync API), and is bounded by a timeout, so a
// hard-hung network mount can slow this probe but can NEVER freeze the event loop — important
// because it runs on the indexing hot path (every delta) as well as at warm start. A root that
// can't be confirmed a directory within the budget is treated as offline (the fail-safe: hold).
// A single fs.stat bounded by a timeout. The stat runs on the libuv threadpool (never the sync
// API), so a hard-hung network mount can slow the probe but can NEVER freeze the event loop.
// Resolves to the Stats object, or rejects on timeout or a missing/unreadable path. The timer is
// unref'd so a pending probe can't keep a short-lived process alive, and is cleared once the race
// settles so a fast path doesn't leave a timer armed for the whole budget. Shared by every bounded
// filesystem probe (the offline-roots check on the indexing hot path, the folder-picker drive scan)
// so the pattern lives in exactly one place.
const statWithTimeout = (target, timeoutMs = 1500) => {
  const fsp = require('fs').promises;
  let timer;
  return Promise.race([
    fsp.stat(target),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('stat timed out')), timeoutMs); if (timer.unref) timer.unref(); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
};

// The roots that hold indexed files — the per-workspace documents folder plus every external
// indexed source. The delta purge hold-back probes reachability over this set (offline roots, plus
// external roots that mounted empty), so a slow or half-mounted volume is held rather than misread as
// "gone" and purged into a needless full re-embed. `sourcePaths` is the config's SOURCE_PATHS array
// ([{ path }, …]); falsy entries are dropped.
const indexedRoots = (docsDir, sourcePaths) =>
  [docsDir, ...((sourcePaths || []).map(s => s && s.path))].filter(Boolean);

const offlineRoots = async (roots, timeoutMs = 1500) => {
  const reachable = async (root) => {
    try { return (await statWithTimeout(root, timeoutMs)).isDirectory(); }
    catch { return false; }               // timed out, missing, or unreadable → treat as offline (hold)
  };
  const out = [];
  await Promise.all((roots || []).map(async (r) => { if (!(await reachable(r))) out.push(r); }));
  return out;
};

// Real-path containment. Resolve BOTH the target and the roots with fs.realpath before the
// isWithin() check, so a symlink that escapes its root is still refused (real vs real) while a
// legitimately symlinked/firmlinked target or root is not wrongly rejected — the case that a
// resolve-target-only check gets wrong when the home directory or a mount is itself a symlink, or
// on macOS where /tmp is a firmlink to /private/tmp. A path or root that cannot be resolved (does
// not exist) falls back to its textual form. Returns the resolved real target when it lies inside
// some resolved root, else null. Single-sourced so the folder browser and the document viewer
// apply identical semantics.
const realWithin = async (target, roots) => {
  const fsp = require('fs').promises;
  let real = target;
  try { real = await fsp.realpath(target); } catch { /* non-existent — use the textual path */ }
  for (const root of (roots || [])) {
    let realRoot = root;
    try { realRoot = await fsp.realpath(root); } catch { /* non-existent — use the textual path */ }
    if (isWithin(real, realRoot)) return real;
  }
  return null;
};

// Turn an untrusted upload filename into one safe to WRITE on this host's filesystem. The name is a
// single path component, never a path: separators and control characters are always removed so it can't
// escape its directory or corrupt a log/CSV line. On Windows the filesystem additionally forbids the
// characters : * ? " < > |, silently drops trailing dots and spaces (which would change the name), and
// reserves the device basenames CON, PRN, AUX, NUL, COM1-9 and LPT1-9 (which can never exist as a file),
// so those are handled there too. POSIX filenames keep their original characters (: and friends are
// legal), matching what the user uploaded. Falls back to "file" if nothing usable remains.
const WIN_RESERVED_BASE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// A device name is reserved with or without an extension, so judge the stem before the first dot.
const isWindowsReserved = (name) => WIN_RESERVED_BASE.test(String(name || '').split('.')[0]);
// Keep the stored component bounded so the full path stays inside the Windows MAX_PATH budget once the
// workspace directory is prepended. Preserve the extension: the upload filter, viewer, and extractor use it.
const MAX_STORED_NAME = 120;
const capStoredName = (name) => {
  if ([...name].length <= MAX_STORED_NAME) return name;
  const ext = path.extname(name).slice(0, 16);
  // Slice by code point, not UTF-16 unit, so a long non-Latin name can never be cut through a surrogate pair.
  const stem = [...name.slice(0, Math.max(0, name.length - ext.length))]
    .slice(0, Math.max(1, MAX_STORED_NAME - ext.length)).join('');
  return stem + ext;
};
const safeStoredFilename = (name) => {
  let base = path.basename(String(name || ''))
    .replace(/[/\\]/g, '_')        // path separators — never part of a component
    .replace(/[\x00-\x1f]/g, '_'); // control chars (NUL breaks POSIX writes; others corrupt display)
  if (process.platform === 'win32') {
    base = base.replace(/[:*?"<>|]/g, '_').replace(/[ .]+$/, '');
  }
  if (base === '.' || base === '..') base = 'file';   // defensive: never a traversal component
  base = capStoredName(base);
  // The cap can land on a dot that was not trailing before truncation. Windows drops trailing dots/spaces,
  // so remove them again after the cap rather than leave a name the OS would silently alter.
  if (process.platform === 'win32') base = base.replace(/[ .]+$/, '');
  if (process.platform === 'win32' && isWindowsReserved(base)) base = '_' + base;
  return base || 'file';
};

module.exports = { isWithin, offlineRoots, realWithin, statWithTimeout, indexedRoots, safeStoredFilename, isWindowsReserved };
