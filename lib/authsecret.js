'use strict';
// Server auth secret — a single random value used to sign CSRF tokens (and available for any other
// server-side HMAC need). It is generated ONCE on first use and persisted to the config folder, then read
// back on every boot, so it is stable across restarts. It is kept out of config.json (which the Settings UI
// edits and which syncs/backs up) and must stay out of version control.
//
// Session cookies do NOT depend on this secret — sessions are opaque random ids looked up in a server-side
// store (see lib/authsessions.js), so they survive restarts on their own. This secret is only for signing
// tokens we hand to the browser and later verify.
//
// FAIL-CLOSED: signing/verifying throws or returns false if the secret cannot be established, rather than
// falling back to a guessable constant.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SECRET_FILE = 'session-secret';

// The directory that holds the auth secret. On a single node it lives in the local `config/` folder, kept out
// of config.json and out of version control. In CLUSTER mode it must instead live on the SHARED data dir, so
// every node signs and verifies with the same key — CSRF tokens and the SSO flow cookie are minted on one node
// and verified on another, and a per-node secret would make those round trips fail across the cluster. The
// cluster/config modules are loaded lazily (and defensively) so this works even before config is ready.
const secretDir = () => {
  try { if (require('./cluster').enabled()) return require('./config').DATA_DIR; }
  catch { /* config/cluster not ready yet — fall back to the local config folder */ }
  return path.resolve('config');
};

let _cache = null;   // { dir, secret }

// Read the persisted secret, creating it ONLY when the file genuinely does not exist. Returns a hex string.
//
// FAIL-CLOSED, never fail-open-to-a-new-key: a present-but-unreadable or malformed secret THROWS rather than
// silently regenerating. Regenerating over an existing secret would rotate the key on a transient read error —
// invalidating every outstanding CSRF token and SSO flow cookie, and in cluster mode (shared data dir)
// clobbering the key for ALL nodes at once. A broken secret is a loud condition for the operator/watchdog, not
// something to paper over. The accepted format is the 256-bit (64 hex) value we write — a shorter legacy value
// is treated as invalid rather than trusted.
const SECRET_RE = /^[0-9a-f]{64,}$/i;
const getSecret = (configDir = secretDir()) => {
  if (_cache && _cache.dir === configDir) return _cache.secret;
  const file = path.join(configDir, SECRET_FILE);
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf-8'); }
  catch (e) {
    if (!e || e.code !== 'ENOENT') throw new Error(`auth secret unreadable (${e && e.code || 'error'}) — refusing to regenerate over it`);
    // ENOENT → genuinely absent; create below.
  }
  if (raw !== null) {
    const existing = raw.trim();
    if (SECRET_RE.test(existing)) { _cache = { dir: configDir, secret: existing }; return existing; }
    throw new Error('auth secret file is present but malformed — refusing to overwrite it; remove or fix it to regenerate');
  }
  // Absent: create once, owner-only, with EXCLUSIVE create (flag 'wx') so two cluster nodes racing first boot
  // can't clobber each other — the loser gets EEXIST and re-reads the winner's secret, so all nodes converge.
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file, secret, { flag: 'wx', mode: 0o600 });
    _cache = { dir: configDir, secret };
    return secret;
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      // Another node (or a racing call) created it between our read and this write — adopt theirs.
      const existing = fs.readFileSync(file, 'utf-8').trim();
      if (SECRET_RE.test(existing)) { _cache = { dir: configDir, secret: existing }; return existing; }
      throw new Error('auth secret file appeared but is malformed');
    }
    throw e;
  }
};

// HMAC-SHA256 of `data` under the secret, hex. Throws (fail-closed) if the secret can't be established.
const sign = (data, configDir) => {
  const secret = getSecret(configDir);
  return crypto.createHmac('sha256', secret).update(String(data)).digest('hex');
};

// Constant-time verify that `signature` is a valid HMAC of `data`. Never throws — a bad/missing signature or
// an unavailable secret is simply false.
const verify = (data, signature, configDir) => {
  try {
    if (typeof signature !== 'string' || signature.length === 0) return false;
    const expected = sign(data, configDir);
    if (expected.length !== signature.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch { return false; }
};

// Test/maintenance hook: drop the in-memory cache so the next getSecret re-reads from disk.
const _resetCache = () => { _cache = null; };

module.exports = { getSecret, sign, verify, secretDir, SECRET_FILE, _resetCache };
