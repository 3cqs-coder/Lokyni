'use strict';
// API key store — multiple named keys for the public API, stored hashed.
//
// Keys live in data/api-keys.json (a managed list, not user-edited settings, so not
// in config.json). Each key is stored as a SHA-256 hash — the plaintext is shown
// ONCE at creation and never persisted, the same show-once discipline used for
// provider secrets. A `prefix` (first 8 chars) is kept so the UI can identify a key
// without holding the secret.
//
// Every key carries `scopes` (which endpoints it may call) and `allowedWorkspaces`
// (which workspaces it may query; empty = all) from day one. v1 enforcement is
// minimal — valid + not revoked — but the fields exist so per-key permissions drop
// in later without a migration.

const path = require('path');
const crypto = require('crypto');

// Scopes a key can hold. Read-only: search, summarize, read. Write: ingest (adds documents to a workspace, e.g.
// URL ingestion). A key must explicitly hold 'write' to modify a corpus — read scopes never imply it.
// Single-sourced from the authz scope→capability map, so a scope can never validate here yet grant nothing in
// authz (adding one place now fails loudly instead of silently): the two lists can't drift.
const ALL_SCOPES = Object.keys(require('./authz').SCOPE_CAPS);

const keysPath = (dataDir) => path.join(dataDir, 'api-keys.json');

const { sha256Hex: sha256 } = require('./hashid');

// Backed by the shared JSON-list store: an mtime-keyed cache so authenticate() — on the hot path for every API
// and MCP request — doesn't re-read and JSON-parse the file each time; a write bumps the mtime so the next load
// refreshes; atomic owner-only (0600) writes; and fail-closed on a missing/corrupt file. The corrupt case is
// cached by the file's mtime (parsed once per change), fixing the previous divergence where this store alone
// re-parsed a corrupt api-keys.json on EVERY authenticate() call.
const _store = require('./jsonstore').createJsonStore({ file: keysPath, key: 'keys' });
const load = (dataDir) => _store.load(dataDir);

// Keep the store bounded so a long history of create/revoke churn can't grow the file — and the
// per-request authenticate() scan — without limit. ACTIVE keys are never dropped (dropping one would
// lock out a valid client); only revoked keys are compacted. They are an audit aid, but the audit LOG
// is the durable record, so we retain just the most recent ones here, newest first by revocation time.
const MAX_REVOKED_RETAINED = 500;
const compact = (keys) => {
  if (!Array.isArray(keys)) return keys;
  const revokedCount = keys.reduce((n, k) => n + (k && k.revoked ? 1 : 0), 0);
  if (revokedCount <= MAX_REVOKED_RETAINED) return keys;   // common case: nothing to do, order preserved
  const active = keys.filter(k => k && !k.revoked);
  const revoked = keys.filter(k => k && k.revoked)
    .sort((a, b) => (b.revokedAt || b.created || 0) - (a.revokedAt || a.created || 0))
    .slice(0, MAX_REVOKED_RETAINED);
  return active.concat(revoked);
};
const save = (dataDir, keys) => _store.save(dataDir, compact(keys));

// Generate a new key. Returns the record AND the plaintext (caller shows it once).
const createKey = (dataDir, { name, scopes, allowedWorkspaces, rateLimit, ownerUserId } = {}) => {
  const keys = load(dataDir);
  const secret = 'lok_' + crypto.randomBytes(24).toString('base64url');   // ~32 chars after prefix
  const id = 'k_' + crypto.randomBytes(4).toString('hex');
  const validScopes = Array.isArray(scopes)
    ? scopes.filter(s => ALL_SCOPES.includes(s))
    : ALL_SCOPES.slice();
  const record = {
    id,
    name: (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 64) : id,
    hash: sha256(secret),
    prefix: secret.slice(0, 12),   // "lok_" + first 8 of the random part
    scopes: validScopes.length ? validScopes : ALL_SCOPES.slice(),
    allowedWorkspaces: Array.isArray(allowedWorkspaces) ? allowedWorkspaces.filter(w => typeof w === 'string') : [],
    // The user who created the key (multi-user). Null for a key created by the implicit single operator. A
    // key is revoked when its owner is deleted (removeForOwner), so a departed user's keys don't live on.
    ownerUserId: (typeof ownerUserId === 'string' && ownerUserId) ? ownerUserId : null,
    // Optional per-key requests-per-minute. Omitted → the limiter's default.
    // 0 means unlimited (explicit opt-out).
    ...(Number.isInteger(rateLimit) && rateLimit >= 0 ? { rateLimit } : {}),
    created: Date.now(),
    lastUsed: null,
    revoked: false,
  };
  keys.push(record);
  save(dataDir, keys);
  return { record: publicView(record), key: secret };
};

// The safe-to-expose view of a key (never includes the hash).
const publicView = (k) => ({
  id: k.id, name: k.name, prefix: k.prefix, scopes: k.scopes,
  allowedWorkspaces: k.allowedWorkspaces || [], created: k.created,
  lastUsed: k.lastUsed, revoked: !!k.revoked,
  rateLimit: (typeof k.rateLimit === 'number') ? k.rateLimit : null,
  ownerUserId: k.ownerUserId || null,
});

const listKeys = (dataDir) => load(dataDir).map(publicView);

// Soft-delete: mark revoked rather than removing, so the record remains an audit
// trail and a revoked key can be told apart from one that never existed.
const revokeKey = (dataDir, id) => {
  const keys = load(dataDir);
  const k = keys.find(x => x.id === id);
  if (!k) return false;
  k.revoked = true;
  k.revokedAt = Date.now();   // recency for bounded retention (compact) and a finer audit timestamp
  save(dataDir, keys);
  return true;
};

// Throttle lastUsed writes: at most once per minute per key, so a burst of API
// calls doesn't write the file on every request.
const _lastUsedWrite = new Map();   // id → ms
const touchLastUsed = (dataDir, id) => {
  const now = Date.now();
  const prev = _lastUsedWrite.get(id) || 0;
  if (now - prev < 60000) return;
  _lastUsedWrite.set(id, now);
  try {
    const keys = load(dataDir);
    const k = keys.find(x => x.id === id);
    if (k) { k.lastUsed = now; save(dataDir, keys); }
  } catch { /* best-effort */ }
};

// Pull the plaintext key off a request — a Bearer authorization header, else the x-api-key
// header. One place so the HTTP API and the MCP endpoint parse it identically.
const extractKey = (req) => {
  const header = (req && req.get && req.get('authorization')) || '';
  return header.replace(/^Bearer\s+/i, '') || (req && req.get && req.get('x-api-key')) || '';
};

// Compare two hex digests in constant time, so authentication does not leak, through timing, how much of
// a candidate hash matched a stored one. Not strictly necessary here (the compared value is a SHA-256 of
// the attacker's plaintext, which is preimage-resistant, so they can't steer it byte by byte), but it is
// cheap and removes the theoretical signal. Equal-length hex only; anything else is a non-match.
const hashesEqual = (aHex, bHex) => {
  if (typeof aHex !== 'string' || typeof bHex !== 'string' || aHex.length !== bHex.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(aHex, 'hex'), Buffer.from(bHex, 'hex')); }
  catch { return false; }
};

// Authenticate a plaintext key. Returns the FULL record (incl. scopes) or null.
const authenticate = (dataDir, plaintext) => {
  if (!plaintext || typeof plaintext !== 'string') return null;
  const h = sha256(plaintext);
  const k = load(dataDir).find(x => !x.revoked && hashesEqual(x.hash, h));
  return k || null;
};

// Does this key permit a scope? (v1 keys have all scopes; the check is ready for
// when keys are issued with narrower sets.)
const hasScope = (record, scope) =>
  Array.isArray(record.scopes) && record.scopes.includes(scope);

// May this key query this workspace? Empty allowedWorkspaces = all workspaces.
const mayUseWorkspace = (record, workspaceId) => {
  const list = record.allowedWorkspaces;
  if (!Array.isArray(list) || list.length === 0) return true;
  return list.includes(workspaceId);
};

// Revoke every key owned by a user — called when that user is deleted so their keys can't outlive them.
// Soft-revoke (consistent with revokeKey) keeps the audit trail. Returns the count revoked.
const removeForOwner = (dataDir, userId) => {
  if (!userId) return 0;
  const keys = load(dataDir);
  let n = 0;
  for (const k of keys) if (k.ownerUserId === userId && !k.revoked) { k.revoked = true; k.revokedAt = Date.now(); n++; }
  if (n) save(dataDir, keys);
  return n;
};

module.exports = {
  ALL_SCOPES,
  createKey, listKeys, revokeKey, removeForOwner,
  authenticate, extractKey, touchLastUsed, hasScope, mayUseWorkspace,
  // Internals exposed for tests (underscore convention).
  _compact: compact, _MAX_REVOKED_RETAINED: MAX_REVOKED_RETAINED,
};
