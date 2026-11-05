'use strict';
// Shared JSON-list store for the small auth stores (users, members, API keys). Each is one file holding
// { <key>: [ ...rows ] } in the data dir, written atomically and owner-only (0600), with an mtime-keyed
// in-memory cache so the auth hot path doesn't re-read and re-parse the file on every request.
//
// This was hand-rolled three times with the same shape but subtly DIVERGENT behavior — most importantly, one
// copy re-parsed a corrupt file on every call (on the hot path) while another cached the empty result by mtime
// so a broken file is parsed only once per change. Centralizing it removes that drift and gives every store the
// safer behavior:
//   • mtime cache: a stat decides whether to re-read; an unchanged file is served from memory. The stat stays
//     per-load (not throttled) so a change by another process — e.g. the primary disabling a user — is picked
//     up on the very next request, which the revocation guarantees depend on. A stat on a cached inode is cheap.
//   • fail-closed: a missing file reads as empty; a present-but-corrupt file reads as empty too, but cached by
//     its REAL mtime so it is parsed once per change, never once per request.
//   • presence tracking (opt-in): a store that must tell "absent" from "present-but-corrupt" (the user store's
//     implicit-owner gate) gets present/parsed flags, so a broken file never looks like "no accounts".
//   • atomic owner-only writes via the shared disk helper; the cache is invalidated on a failed write so the
//     next load re-reads the authoritative on-disk state instead of serving a phantom.

const fs = require('fs');

// createJsonStore({ file, key, sanitize?, trackPresence? }) → { load, save, isPresent, isParsed, invalidate }.
//   file(dataDir)   → absolute path to the JSON file.
//   key             → the array property inside the envelope, e.g. 'users' for { users: [...] }.
//   sanitize(rows)  → normalize/validate the parsed array (default: pass an array through, else []).
//   trackPresence   → maintain present/parsed flags for an absent-vs-corrupt distinction.
const createJsonStore = ({ file, key, sanitize, trackPresence = false }) => {
  const sane = typeof sanitize === 'function' ? sanitize : (rows) => (Array.isArray(rows) ? rows : []);
  let cache = { path: null, mtimeMs: -1, rows: [], present: false, parsed: true };

  const load = (dataDir) => {
    const p = file(dataDir);
    let mtimeMs;
    try { mtimeMs = fs.statSync(p).mtimeMs; }
    catch { cache = { path: p, mtimeMs: -1, rows: [], present: false, parsed: true }; return cache.rows; }   // absent → genuinely empty
    if (cache.path === p && cache.mtimeMs === mtimeMs) return cache.rows;                                   // unchanged → cached
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      cache = { path: p, mtimeMs, rows: sane(raw && raw[key]), present: true, parsed: true };
      return cache.rows;
    } catch {
      // Present but corrupt: cache the empty result keyed on the REAL mtime, so the broken file is parsed once
      // per change (not once per request). Fail-closed: no rows; present:true/parsed:false drives isEmpty.
      cache = { path: p, mtimeMs, rows: [], present: true, parsed: false };
      return cache.rows;
    }
  };

  const save = (dataDir, rows) => {
    fs.mkdirSync(dataDir, { recursive: true });
    const p = file(dataDir);
    try {
      require('./disk').writeFileAtomic(p, JSON.stringify({ [key]: rows }, null, 2), 0o600);
    } catch (e) {
      // Disk now disagrees with the cache — force a re-read next time. Keep present:true/parsed:false so a raw
      // read before that reload can't report a false "empty" (which would, for the user store, open the
      // implicit-owner gate). trackPresence stores legitimately start absent, so an absent store that has never
      // been written keeps present:false only via the normal absent path, not here.
      cache = { path: null, mtimeMs: -1, rows: [], present: true, parsed: false };
      throw e;
    }
    // The write succeeded, so the rows we wrote are the truth; only re-stat to refresh the mtime. If the stat
    // fails, force a re-read next time but keep the known-good rows + flags so no raw read sees a false empty.
    try { cache = { path: p, mtimeMs: fs.statSync(p).mtimeMs, rows, present: true, parsed: true }; }
    catch { cache = { path: null, mtimeMs: -1, rows, present: true, parsed: true }; }
  };

  // Presence accessors (load first so the flags reflect the current file). Only meaningful with trackPresence.
  const isPresent = (dataDir) => { load(dataDir); return cache.present; };
  const isParsed  = (dataDir) => { load(dataDir); return cache.parsed; };
  // Drop the cache (tests / maintenance): the next load re-reads from disk.
  const invalidate = () => { cache = { path: null, mtimeMs: -1, rows: [], present: false, parsed: true }; };

  return { load, save, isPresent, isParsed, invalidate };
};

module.exports = { createJsonStore };
