'use strict';
// User account store — human accounts for multi-user Lokyni, stored hashed on disk.
//
// Same storage discipline as the API-key store (lib/apikeys.js): a JSON list in the data dir, written
// atomically and owner-only (0600), with an mtime-keyed in-memory cache so the auth hot path doesn't re-read
// and re-parse on every request. Passwords are never stored here in the clear — the caller hashes with
// lib/password.js and passes the hash in; this module only persists it.
//
// Identity is the username (case-insensitive, unique); email is optional and, if given, also unique. The
// FIRST account created becomes the initial admin (see Accounts service); this store just records the fields.
// Fail-closed: a missing or corrupt file reads as "no users" (which, via the implicit-owner seam, keeps a
// fresh single-operator install working) and never throws into a request.

const path = require('path');
const crypto = require('crypto');

const ROLES = ['admin', 'member'];
const STATUSES = ['active', 'disabled'];
const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;   // 1–64 chars, starts alphanumeric
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;             // lenient; email is optional and not contacted

// The human DISPLAY name, in ANY language or script — separate from the ASCII `username`, which stays the unique
// identifier. Keeping the identifier ASCII avoids Unicode case-fold / homoglyph collisions in the uniqueness
// check; the display name carries no such constraint because it is only a label (never compared for uniqueness).
const MAX_DISPLAY_NAME = 64;
// NFC-normalize (so visually identical sequences are stored/compared consistently across platforms and browsers),
// strip control and format characters (anti-spoof: no zero-width or bidi-override tricks), collapse whitespace,
// and bound the length. Letters, marks, numbers, punctuation, and symbols from every script are preserved, so a
// name like "José", "山田太郎", or "Müller" is kept intact. Returns the cleaned label, or null when nothing usable
// remains (the public view then falls back to the username).
const normalizeDisplayName = (raw) => {
  if (typeof raw !== 'string') return null;
  let s = raw.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  if ([...s].length > MAX_DISPLAY_NAME) s = [...s].slice(0, MAX_DISPLAY_NAME).join('').trim();
  return s || null;
};

const usersPath = (dataDir) => path.join(dataDir, 'users.json');

// Backed by the shared JSON-list store with PRESENCE TRACKING. This matters for security: the implicit-owner
// seam (isEmpty) must treat a present-but-corrupt file as "accounts exist" (fail closed), NOT as "no accounts"
// — otherwise a corrupt users.json would silently re-open the whole instance to anyone. The store caches a
// corrupt file by mtime (present:true, parsed:false) exactly for this. Atomic owner-only (0600) writes.
const _store = require('./jsonstore').createJsonStore({ file: usersPath, key: 'users', trackPresence: true });
const load = (dataDir) => _store.load(dataDir);
const save = (dataDir, users) => _store.save(dataDir, users);

// The safe-to-expose view — never includes the password hash. `name` is the RESOLVED human label (display name,
// else username), computed here so the frontend has ONE source for what to show and never re-implements the
// fallback; `displayName` is the raw field (null when unset) for an edit form.
const publicView = (u) => (u ? {
  id: u.id, username: u.username, displayName: u.displayName || null, name: u.displayName || u.username,
  email: u.email || null, role: u.role,
  status: u.status, isInitial: !!u.isInitial, created: u.created, updated: u.updated || u.created,
  lastLogin: u.lastLogin || null,
} : null);

const count = (dataDir) => load(dataDir).length;
// "Empty" (→ the implicit-owner seam opens the instance) ONLY when the file is absent, or present and valid
// with zero users. A present-but-CORRUPT file is NOT empty — the gate stays closed so a broken file can't
// silently grant open access when accounts really exist.
const isEmpty = (dataDir) => !_store.isPresent(dataDir) || (_store.isParsed(dataDir) && load(dataDir).length === 0);
// True when the file exists but could not be parsed — a loud condition for the watchdog.
const isCorrupt = (dataDir) => _store.isPresent(dataDir) && !_store.isParsed(dataDir);
const list = (dataDir) => load(dataDir).map(publicView);

const getById = (dataDir, id) => load(dataDir).find(u => u.id === id) || null;
const getByUsername = (dataDir, username) => {
  const lower = String(username || '').toLowerCase();
  if (!lower) return null;
  return load(dataDir).find(u => u.usernameLower === lower) || null;
};
const getByEmail = (dataDir, email) => {
  const lower = String(email || '').toLowerCase();
  if (!lower) return null;
  return load(dataDir).find(u => u.emailLower && u.emailLower === lower) || null;
};

// Create a user. `passwordHash` is already hashed by the caller (lib/password.js). Role defaults to 'member';
// the Accounts service promotes the very first user to 'admin'/isInitial. Throws on a duplicate or invalid
// field so the caller surfaces a clear error rather than persisting a bad record.
const create = (dataDir, { username, email, passwordHash, role = 'member', isInitial = false, ssoSubject = null, displayName = null } = {}) => {
  const uname = String(username || '').trim();
  if (!USERNAME_RE.test(uname)) throw Object.assign(new Error('Invalid username'), { code: 'invalid_username' });
  if (typeof passwordHash !== 'string' || !passwordHash) throw Object.assign(new Error('Missing password hash'), { code: 'invalid_password' });
  if (!ROLES.includes(role)) throw Object.assign(new Error('Invalid role'), { code: 'invalid_role' });
  const em = email ? String(email).trim() : '';
  if (em && !EMAIL_RE.test(em)) throw Object.assign(new Error('Invalid email'), { code: 'invalid_email' });

  const users = load(dataDir).slice();
  if (users.some(u => u.usernameLower === uname.toLowerCase())) throw Object.assign(new Error('Username already exists'), { code: 'username_taken' });
  if (em && users.some(u => u.emailLower === em.toLowerCase())) throw Object.assign(new Error('Email already in use'), { code: 'email_taken' });

  const now = Date.now();
  const user = {
    id: 'u_' + crypto.randomBytes(8).toString('hex'),
    username: uname, usernameLower: uname.toLowerCase(),
    displayName: normalizeDisplayName(displayName),
    email: em || null, emailLower: em ? em.toLowerCase() : null,
    passwordHash, role, status: 'active', isInitial: !!isInitial,
    ssoSubject: (typeof ssoSubject === 'string' && ssoSubject) ? ssoSubject : null,
    created: now, updated: now, lastLogin: null, passwordChangedAt: now,
  };
  users.push(user);
  save(dataDir, users);
  return publicView(user);
};

// Patch mutable fields of a user. `patch` may include: role, status, email, username. Enforces uniqueness and
// validity. Returns the updated public view, or null if the user is gone.
const update = (dataDir, id, patch = {}) => {
  const users = load(dataDir).slice();
  const u = users.find(x => x.id === id);
  if (!u) return null;
  if (patch.role !== undefined) {
    if (!ROLES.includes(patch.role)) throw Object.assign(new Error('Invalid role'), { code: 'invalid_role' });
    u.role = patch.role;
  }
  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status)) throw Object.assign(new Error('Invalid status'), { code: 'invalid_status' });
    u.status = patch.status;
  }
  if (patch.username !== undefined) {
    const uname = String(patch.username || '').trim();
    if (!USERNAME_RE.test(uname)) throw Object.assign(new Error('Invalid username'), { code: 'invalid_username' });
    if (users.some(x => x.id !== id && x.usernameLower === uname.toLowerCase())) throw Object.assign(new Error('Username already exists'), { code: 'username_taken' });
    u.username = uname; u.usernameLower = uname.toLowerCase();
  }
  if (patch.email !== undefined) {
    const em = patch.email ? String(patch.email).trim() : '';
    if (em && !EMAIL_RE.test(em)) throw Object.assign(new Error('Invalid email'), { code: 'invalid_email' });
    if (em && users.some(x => x.id !== id && x.emailLower === em.toLowerCase())) throw Object.assign(new Error('Email already in use'), { code: 'email_taken' });
    u.email = em || null; u.emailLower = em ? em.toLowerCase() : null;
  }
  if (patch.displayName !== undefined) {
    // Normalized and bounded; an empty/blank value clears it so the view falls back to the username.
    u.displayName = normalizeDisplayName(patch.displayName);
  }
  u.updated = Date.now();
  save(dataDir, users);
  return publicView(u);
};

// Replace a user's password hash (already hashed by the caller). Bumps passwordChangedAt so sessions issued
// before the change can be invalidated by the session layer.
const setPasswordHash = (dataDir, id, passwordHash) => {
  if (typeof passwordHash !== 'string' || !passwordHash) throw Object.assign(new Error('Missing password hash'), { code: 'invalid_password' });
  const users = load(dataDir).slice();
  const u = users.find(x => x.id === id);
  if (!u) return false;
  u.passwordHash = passwordHash;
  u.passwordChangedAt = Date.now();
  u.updated = u.passwordChangedAt;
  save(dataDir, users);
  return true;
};

const remove = (dataDir, id) => {
  const users = load(dataDir);
  const next = users.filter(u => u.id !== id);
  if (next.length === users.length) return false;
  save(dataDir, next);
  return true;
};

// Throttle lastLogin writes to at most once a minute per user, so a burst of requests doesn't rewrite the
// file each time (mirrors the API-key lastUsed throttle).
const _lastLoginWrite = new Map();
const touchLastLogin = (dataDir, id) => {
  const now = Date.now();
  if (now - (_lastLoginWrite.get(id) || 0) < 60000) return;
  _lastLoginWrite.set(id, now);
  try {
    const users = load(dataDir).slice();
    const u = users.find(x => x.id === id);
    if (u) { u.lastLogin = now; save(dataDir, users); }
  } catch { /* best-effort */ }
};

// Look up a user by their linked SSO subject (iss|sub). Null when none is linked.
const getBySsoSubject = (dataDir, subject) => {
  if (typeof subject !== 'string' || !subject) return null;
  return load(dataDir).find(u => u.ssoSubject === subject) || null;
};

// Link (or re-link) an existing user to an SSO subject — used to connect a pre-created account to its IdP
// identity on first SSO login. Returns the public view, or null if the user is gone.
const setSsoSubject = (dataDir, id, subject) => {
  const users = load(dataDir).slice();
  const u = users.find(x => x.id === id);
  if (!u) return null;
  u.ssoSubject = (typeof subject === 'string' && subject) ? subject : null;
  u.updated = Date.now();
  save(dataDir, users);
  return publicView(u);
};

// Full record (incl. passwordHash) for the auth path only — never send this to a client.
const getRecordByUsername = (dataDir, username) => getByUsername(dataDir, username);
const getRecordById = (dataDir, id) => getById(dataDir, id);

module.exports = {
  ROLES, STATUSES, USERNAME_RE, EMAIL_RE, MAX_DISPLAY_NAME, normalizeDisplayName,
  count, isEmpty, isCorrupt, list, publicView,
  getById, getByUsername, getByEmail, getBySsoSubject, getRecordByUsername, getRecordById,
  create, update, setPasswordHash, setSsoSubject, remove, touchLastLogin,
};
