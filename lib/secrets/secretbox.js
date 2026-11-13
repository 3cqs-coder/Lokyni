'use strict';

// lib/secretbox.js — encrypt small secrets at rest.
//
// config.json (and the SSO config and the per-workspace connector files) hold credentials the server must
// USE, not merely verify: LLM provider API keys, the SMTP password, the OIDC client secret, and connector
// access tokens. Those cannot be hashed — they have to be reversible — so they are sealed with AES-256-GCM
// and the key is kept OUT of the files they protect. This raises the bar above plain file permissions: a
// config that is copied, shared for support, committed by mistake, pasted into a log, or swept into a backup
// no longer leaks its secrets, because the key lives in a separate file (or an env var).
//
// It is NOT claimed to defeat an attacker with full read access to BOTH the config and the key — nothing
// local-first can, without an external key service or an operator passphrase on every boot. The master key
// comes from $LOKYNI_SECRET_KEY (operator-supplied, never written to disk — the strongest option) when set,
// otherwise a 32-byte key generated once and stored at <dataDir>/secret.key with 0o600 permissions. The
// caller owns the precedence between a CLI flag, the env var, and that default file.
//
// Envelope: 'sb1:' || base64( iv(12) || authTag(16) || ciphertext ). The 'sb1:' tag lets a reader tell a
// value WE sealed from a legacy plaintext value, so an existing install keeps working and migrates lazily
// (the next save seals the plaintext). A per-LABEL key — HMAC-SHA256(master, 'sb:'+label) — binds each
// ciphertext to the field it was sealed for, so a value sealed for one setting can never be opened as
// another (the standard "bind to the name" protection). node:crypto only, so fully cross-platform; sealing
// a short string is microseconds of synchronous CPU and never blocks the event loop.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { restrictToOwner } = require('./securefile');

const PREFIX = 'sb1:';
const ENV_VAR = 'LOKYNI_SECRET_KEY';
const ENV_SENTINEL = '@env';   // a key SOURCE of '@env' means "use $LOKYNI_SECRET_KEY" (never a real path)

// Cache the resolved 32-byte master per source (a key-file path, or '@env'), so we touch the disk / env at
// most once. A null entry means "no persistent key available" — callers then keep plaintext rather than
// create a secret that can never be re-opened.
const _masters = new Map();

// The master secret for a SOURCE, or null when none is available (so we must not seal). The source is
// either the special '@env' (derive from $LOKYNI_SECRET_KEY, hashed to 32 bytes, never on disk) or a
// key-file path (read it, creating a fresh 32-byte key on first use).
function master(src) {
  if (src === ENV_SENTINEL) {
    const env = process.env[ENV_VAR];
    if (!env || String(env).length < 16) return null;
    if (!_masters.has(ENV_SENTINEL)) _masters.set(ENV_SENTINEL, crypto.createHash('sha256').update(String(env)).digest());
    return _masters.get(ENV_SENTINEL);
  }
  const keyFile = src;
  if (!keyFile) return null;
  if (_masters.has(keyFile)) return _masters.get(keyFile);
  let key = null;
  try {
    if (fs.existsSync(keyFile)) {
      const raw = fs.readFileSync(keyFile);
      if (raw && raw.length >= 32) key = raw.length === 32 ? raw : crypto.createHash('sha256').update(raw).digest();
    }
  } catch { /* unreadable → try to (re)create below */ }
  if (!key) {
    const fresh = crypto.randomBytes(32);
    try {
      fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
      // wx: never clobber an existing key (a race or a concurrent process) — if it appeared, read it.
      fs.writeFileSync(keyFile, fresh, { mode: 0o600, flag: 'wx' });
      restrictToOwner(keyFile);
      key = fresh;
    } catch {
      try { const raw = fs.readFileSync(keyFile); if (raw && raw.length >= 32) key = raw.length === 32 ? raw : crypto.createHash('sha256').update(raw).digest(); }
      catch { key = null; }   // can't write AND can't read → no persistent key; stay plaintext
    }
  }
  _masters.set(keyFile, key);   // may be null — cache the "no key" verdict too
  return key;
}

// Per-label 32-byte key. label binds the ciphertext to its field.
function labelKey(m, label) { return crypto.createHmac('sha256', m).update('sb:' + String(label || '')).digest(); }

// Does this value look like one we sealed? Prefix + base64 long enough to hold at least iv(12)+tag(16) = 28
// bytes, which is ceil(28/3)*4 = 40 base64 chars. The bound is `>=`, not `>`, or a 1–2 char secret seals to
// exactly that length and would be mis-read as plaintext and silently left unencrypted.
function isSealed(v) {
  return typeof v === 'string' && v.startsWith(PREFIX) && v.length >= PREFIX.length + 40;
}

// Seal a plaintext string. Returns the input UNCHANGED when there is no master key, the input is empty / not
// a string, or it is already sealed (idempotent) — never throws, never loses the value.
function seal(plaintext, label, keyFile) {
  if (typeof plaintext !== 'string' || plaintext === '' || isSealed(plaintext)) return plaintext;
  const m = master(keyFile);
  if (!m) return plaintext;   // no key to persist → keep plaintext (still protected by file perms)
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', labelKey(m, label), iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
  } catch { return plaintext; }
}

// Open a sealed value. Returns null on any failure (wrong key, tamper, malformed) so a caller can fall back.
// A value that is NOT sealed (legacy plaintext) also returns null here — use readSecret for the
// "sealed-or-plaintext" case.
function open(ciphertext, label, keyFile) {
  if (!isSealed(ciphertext)) return null;
  const m = master(keyFile);
  if (!m) return null;
  try {
    const buf = Buffer.from(ciphertext.slice(PREFIX.length), 'base64');
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc = buf.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', labelKey(m, label), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch { return null; }
}

// Seal, then PROVE the ciphertext re-opens to the exact input before returning it — a sealed value that does
// not round-trip would be an unrecoverable credential, so on any doubt keep the plaintext (still protected
// by file perms). Use this on every save path: a credential must never be made unreadable.
function sealVerified(plaintext, label, keyFile) {
  if (typeof plaintext !== 'string' || plaintext === '' || isSealed(plaintext)) return plaintext;
  const sealed = seal(plaintext, label, keyFile);
  if (isSealed(sealed) && open(sealed, label, keyFile) === plaintext) return sealed;
  return plaintext;
}

// Read a stored secret that may be sealed OR legacy plaintext. Decrypt when sealed; otherwise pass the raw
// value through unchanged (so an install from before sealing keeps working, and migrates on next save). A
// tampered/unopenable sealed value returns the ciphertext verbatim — the downstream auth call then fails
// cleanly rather than the app crashing, and the operator can re-enter the credential.
function readSecret(value, label, keyFile) {
  if (typeof value !== 'string' || !value) return value;
  if (!isSealed(value)) return value;
  const opened = open(value, label, keyFile);
  return opened === null ? value : opened;
}

// Test-only: forget cached masters so a test can point at a fresh key file.
function _reset() { _masters.clear(); }

module.exports = { seal, open, sealVerified, readSecret, isSealed, master, PREFIX, ENV_VAR, ENV_SENTINEL, _reset };
