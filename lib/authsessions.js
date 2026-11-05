'use strict';
// Human login sessions — server-side, opaque, durable.
//
// A session id is 32 random bytes handed to the browser in a cookie. On disk we store only its SHA-256 hash
// (as the filename), so reading the data dir never yields a usable credential, and we look a session up in
// O(1) by hashing the cookie value. One file per session means:
//   • RESTART-DURABLE: sessions live on disk, so a restart/redeploy never logs anyone out (no secret to keep
//     stable — the id itself is the key).
//   • OOM-PROOF: a touch rewrites one tiny file, and revocation/prune stream the directory one entry at a
//     time; we never load all sessions into memory.
//   • REVOCABLE: logout, "sign out everywhere", and revoke-on-password-change are real file deletes.
// Rolling expiry (default 30 days of inactivity) is slid forward by a throttled touch so an active user stays
// signed in indefinitely while writes stay rare. Separate from lib/sessions.js (that stores CONVERSATIONS).
// Fail-closed: a missing/corrupt session file reads as "no session" and never throws into a request.

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days of inactivity
const TOUCH_THROTTLE_MS = 5 * 60 * 1000;           // slide expiry at most once per 5 min per session
const MAX_PER_USER = 25;                           // bound sessions per user (evict oldest beyond this)

const dirFor = (dataDir) => path.join(dataDir, 'auth-sessions');
const { sha256Hex: sha256 } = require('./hashid');
const fileFor = (dataDir, rawId) => path.join(dirFor(dataDir), sha256(rawId) + '.json');
const fileForHash = (dataDir, hash) => path.join(dirFor(dataDir), hash + '.json');

// Read + parse one session file by its hash; returns the record or null (never throws).
const readByHash = async (dataDir, hash) => {
  try {
    const rec = JSON.parse(await fsp.readFile(fileForHash(dataDir, hash), 'utf-8'));
    if (!rec || typeof rec.userId !== 'string' || typeof rec.expires !== 'number') return null;
    return rec;
  } catch { return null; }
};

const _touchWrite = new Map();   // hash → last-write ms (throttle)

// Create a session for a user. Returns the RAW id (only ever returned here and set as the cookie).
const create = async (dataDir, userId, { ip = '', ua = '', ttlMs = DEFAULT_TTL_MS } = {}) => {
  const dir = dirFor(dataDir);
  await fsp.mkdir(dir, { recursive: true });
  const rawId = crypto.randomBytes(32).toString('base64url');
  const hash = sha256(rawId);
  const now = Date.now();
  const rec = { userId, created: now, lastSeen: now, expires: now + ttlMs, ip: String(ip).slice(0, 64), ua: String(ua).slice(0, 256) };
  await require('./disk').writeFileAtomicAsync(fileForHash(dataDir, hash), JSON.stringify(rec));
  try { await fsp.chmod(fileForHash(dataDir, hash), 0o600); } catch {}
  _touchWrite.set(hash, now);
  // Enforce the per-user cap in the background (best-effort; never blocks or fails the login).
  enforceUserCap(dataDir, userId).catch(() => {});
  return rawId;
};

// Look up a live session by its raw cookie id. Returns { hash, userId, created, lastSeen, expires, ip, ua } or
// null. An expired session is deleted lazily and treated as absent.
const get = async (dataDir, rawId) => {
  if (!rawId || typeof rawId !== 'string') return null;
  const hash = sha256(rawId);
  const rec = await readByHash(dataDir, hash);
  if (!rec) return null;
  if (rec.expires <= Date.now()) { _touchWrite.delete(hash); fsp.rm(fileForHash(dataDir, hash), { force: true }).catch(() => {}); return null; }
  return { hash, ...rec };
};

// Slide a live session's expiry forward (rolling window), throttled so an active user doesn't write on every
// request. Best-effort — a failed touch never breaks the request.
const touch = async (dataDir, rawId, { ip, ua } = {}) => {
  try {
    const hash = sha256(rawId);
    const now = Date.now();
    if (now - (_touchWrite.get(hash) || 0) < TOUCH_THROTTLE_MS) return;
    const rec = await readByHash(dataDir, hash);
    if (!rec || rec.expires <= now) return;
    rec.lastSeen = now;
    rec.expires = now + DEFAULT_TTL_MS;
    if (ip) rec.ip = String(ip).slice(0, 64);
    if (ua) rec.ua = String(ua).slice(0, 256);
    _touchWrite.set(hash, now);
    await require('./disk').writeFileAtomicAsync(fileForHash(dataDir, hash), JSON.stringify(rec));
  } catch { /* best-effort */ }
};

// Reset a session's created + expiry to now. Used after the owner changes their own password: changePassword
// spares the current session from revocation, and this re-stamps its `created` so the passwordChangedAt epoch
// check (principal.fromRequest) doesn't then invalidate the very session the user is still using. Best-effort.
const renew = async (dataDir, rawId) => {
  try {
    const hash = sha256(rawId);
    const rec = await readByHash(dataDir, hash);
    if (!rec) return false;
    const now = Date.now();
    rec.created = now; rec.lastSeen = now; rec.expires = now + DEFAULT_TTL_MS;
    _touchWrite.set(hash, now);
    await require('./disk').writeFileAtomicAsync(fileForHash(dataDir, hash), JSON.stringify(rec));
    return true;
  } catch { return false; }
};

const destroy = async (dataDir, rawId) => {
  try {
    const hash = sha256(rawId);
    _touchWrite.delete(hash);
    await fsp.rm(fileForHash(dataDir, hash), { force: true });
    return true;
  } catch { return false; }
};

// Stream the session directory, calling fn(record, hash, filePath) for each parseable file. Reads ONE file at
// a time so memory stays flat regardless of how many sessions exist.
const forEachSession = async (dataDir, fn) => {
  let names;
  try { names = await fsp.readdir(dirFor(dataDir)); } catch { return; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const hash = name.slice(0, -'.json'.length);
    // eslint-disable-next-line no-await-in-loop
    const rec = await readByHash(dataDir, hash);
    if (rec) { try { await fn(rec, hash); } catch { /* keep going */ } }   // one bad row never aborts the sweep
  }
};

// Revoke all of a user's sessions, optionally sparing the caller's own (exceptRawId). Returns the count
// removed. Used on password change, admin force-logout, and "sign out everywhere".
const destroyForUser = async (dataDir, userId, exceptRawId = null) => {
  const spareHash = exceptRawId ? sha256(exceptRawId) : null;
  let removed = 0;
  await forEachSession(dataDir, async (rec, hash) => {
    if (rec.userId === userId && hash !== spareHash) {
      await fsp.rm(fileForHash(dataDir, hash), { force: true }).catch(() => {});
      _touchWrite.delete(hash);
      removed++;
    }
  });
  return removed;
};

// Keep only the newest MAX_PER_USER sessions for a user (evict oldest by lastSeen).
const enforceUserCap = async (dataDir, userId) => {
  const mine = [];
  await forEachSession(dataDir, async (rec, hash) => { if (rec.userId === userId) mine.push({ hash, lastSeen: rec.lastSeen || rec.created || 0 }); });
  if (mine.length <= MAX_PER_USER) return 0;
  mine.sort((a, b) => a.lastSeen - b.lastSeen);   // oldest first
  const victims = mine.slice(0, mine.length - MAX_PER_USER);
  for (const v of victims) { await fsp.rm(fileForHash(dataDir, v.hash), { force: true }).catch(() => {}); _touchWrite.delete(v.hash); }
  return victims.length;
};

// Delete every expired session. Safe to call periodically; streams the directory.
const pruneExpired = async (dataDir) => {
  const now = Date.now();
  let removed = 0;
  await forEachSession(dataDir, async (rec, hash) => {
    if (rec.expires <= now) { await fsp.rm(fileForHash(dataDir, hash), { force: true }).catch(() => {}); _touchWrite.delete(hash); removed++; }
  });
  return removed;
};

// Start an unref'd periodic prune so expired sessions are cleaned without holding the process open. Returns
// the timer so a caller/test can clear it.
const startPrune = (dataDir, intervalMs = 60 * 60 * 1000) => {
  const t = setInterval(() => { pruneExpired(dataDir).catch(() => {}); }, intervalMs);
  if (t.unref) t.unref();
  return t;
};

// List a user's sessions (safe view, no credential) for an "active sessions" UI. markRawId flags the caller's
// current one.
const listForUser = async (dataDir, userId, markRawId = null) => {
  const markHash = markRawId ? sha256(markRawId) : null;
  const out = [];
  await forEachSession(dataDir, async (rec, hash) => {
    if (rec.userId === userId) out.push({ id: hash.slice(0, 12), created: rec.created, lastSeen: rec.lastSeen, expires: rec.expires, ip: rec.ip || '', ua: rec.ua || '', current: hash === markHash });
  });
  out.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  return out;
};

module.exports = {
  create, get, touch, renew, destroy, destroyForUser, enforceUserCap, pruneExpired, startPrune, listForUser,
  DEFAULT_TTL_MS, TOUCH_THROTTLE_MS, MAX_PER_USER,
};
