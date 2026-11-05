'use strict';
// Password hashing for human accounts — scrypt via node:crypto.
//
// scrypt is memory-hard and built into Node, so there is no native addon to compile and it behaves
// identically on every platform. Hashes are self-describing (`scrypt:N:r:p:keylen:salt:hash`) so the cost
// parameters can be raised later without breaking existing hashes — an old hash verifies with the parameters
// it was stored with. Verification is constant-time.
//
// Three robustness properties, all deliberate:
//   • NON-BLOCKING: hashing runs on the libuv thread pool (crypto.scrypt, not scryptSync), so a login never
//     stalls indexing or the chat stream.
//   • OOM-PROOF: each hash allocates ~16 MB, so an unbounded burst of logins could exhaust memory. All hashing
//     goes through a small concurrency gate (the shared semaphore) that caps parallel hashes and fails fast
//     with backpressure beyond a bounded queue.
//   • CRASH-PROOF / FAIL-CLOSED: a malformed or unparseable stored hash returns false, never throws.

const crypto = require('crypto');
const { createSemaphore } = require('./semaphore');
const scrypt = require('./scrypt');

// Cost parameters for a NEW hash. N=2^14 keeps each hash near 16 MB and a few hundred ms — strong for a local
// app's occasional interactive login, and light enough to run on a modest machine. keylen/r/p are standard.
const N = 16384, R = 8, P = 1, KEYLEN = 64;
// The widest cost parameters this verifier will accept in a STORED hash. Hashing always uses the fixed values
// above; these bound what an older-or-future hash may carry, so N can be raised later WITHOUT touching the memory
// ceiling (future-proof), while a corrupt/tampered stored hash encoding absurd parameters is rejected before
// scrypt runs rather than driving a huge allocation (OOM/crash-proof). A login hash stays interactive, so the
// envelope is modest — unlike the backup archive KDF (lib/backup.js), which is deliberately heavy.
const MAX_PARAMS = { N: 1 << 16, r: 16, p: 4 };
// scrypt refuses to run if it would exceed maxmem. Sized from MAX_PARAMS via the shared helper (so it can never
// drift from the backup KDF's ceiling) with comfortable headroom over the current N's ~16 MB working set.
const MAXMEM = scrypt.maxmemForBounds(MAX_PARAMS);

// Bound concurrent hashes so a flood of logins can't drive the process into swap/OOM. Beyond the queue,
// acquire() rejects with a tagged backpressure error (the login route maps that to a "busy, retry" response).
const gate = createSemaphore({ max: 3, queueMax: 32, message: 'Too many sign-in attempts in progress — retry shortly' });

const scryptAsync = (password, salt, keylen) => new Promise((resolve, reject) => {
  crypto.scrypt(password, salt, keylen, { N, r: R, p: P, maxmem: MAXMEM }, (err, dk) => {
    if (err) reject(err); else resolve(dk);
  });
});

// Hash a plaintext password → a self-describing string. Runs off the event loop, under the concurrency gate.
const hashPassword = async (plaintext) => {
  if (typeof plaintext !== 'string' || plaintext.length === 0) throw new Error('password must be a non-empty string');
  return gate.run(async () => {
    const salt = crypto.randomBytes(16);
    const dk = await scryptAsync(plaintext, salt, KEYLEN);
    return `scrypt:${N}:${R}:${P}:${KEYLEN}:${salt.toString('hex')}:${dk.toString('hex')}`;
  });
};

// Verify a plaintext against a stored hash. Re-derives with the PARAMETERS EMBEDDED IN THE STORED HASH (so a
// later parameter bump doesn't break old hashes), compares in constant time, and fails closed on anything
// malformed. Never throws.
const verifyPassword = async (plaintext, stored) => {
  try {
    if (typeof plaintext !== 'string' || typeof stored !== 'string') return false;
    const parts = stored.split(':');
    if (parts.length !== 7 || parts[0] !== 'scrypt') return false;
    const n = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]), keylen = Number(parts[4]);
    if (![n, r, p, keylen].every(Number.isInteger)) return false;
    // Reject parameters outside the accepted envelope — fail closed on a corrupt or tampered stored hash rather
    // than handing scrypt an absurd (possibly OOM-inducing) work factor. N must be a power of two (scrypt requires
    // it); r/p/keylen are bounded. MAXMEM is sized from MAX_PARAMS, so anything within the envelope always fits.
    if (!scrypt.isPowerOfTwo(n) || n < 1024 || n > MAX_PARAMS.N || r < 1 || r > MAX_PARAMS.r || p < 1 || p > MAX_PARAMS.p || keylen < 16 || keylen > 1024) return false;
    const salt = Buffer.from(parts[5], 'hex');
    const expected = Buffer.from(parts[6], 'hex');
    if (salt.length === 0 || expected.length !== keylen) return false;
    const dk = await gate.run(() => new Promise((resolve, reject) => {
      crypto.scrypt(plaintext, salt, keylen, { N: n, r, p, maxmem: MAXMEM }, (err, out) => (err ? reject(err) : resolve(out)));
    }));
    return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
  } catch { return false; }   // fail closed: a bad hash or a scrypt error is a non-match, never a throw
};

// A fixed, valid-format hash to verify against when the username is unknown, so login timing is the same
// whether or not the account exists (no user-enumeration signal). Computed once and cached. The plaintext it
// wraps is random and never used — only the scrypt work matters.
let _dummy = null;
const dummyHash = async () => {
  if (_dummy) return _dummy;
  _dummy = await hashPassword(crypto.randomBytes(32).toString('hex'));
  return _dummy;
};

module.exports = { hashPassword, verifyPassword, dummyHash, _params: { N, R, P, KEYLEN } };
