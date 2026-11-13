'use strict';
// Guards that an API key authenticates only while its OWNING user is an active account — the same live
// re-validation the cookie-session path already does. Disabling a user revokes their sessions and drops their
// sockets; before this guard, their API keys kept full data-plane access (read AND write via ingest-url) until
// an admin individually revoked each key or hard-deleted the account. principal.fromRequest now loads the key's
// owner and refuses the key when the owner is missing or not active. The fix is reversible: re-enabling the user
// restores the key with no per-key action. A key with NO owner (the implicit single-operator / pre-multi-user
// key) has no account to gate on and stays valid, so single-operator installs are unaffected.
//
// Functional, offline, temp dirs, no model/network. Run: `npm run test:unit`.

const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const users = require(path.join(PROJECT, 'lib', 'auth', 'users'));
const apikeys = require(path.join(PROJECT, 'lib', 'auth', 'apikeys'));
const principal = require(path.join(PROJECT, 'lib', 'auth', 'principal'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-keyowner-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const cleanup = (code) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exitCode = code; };

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const keyReq = (key) => ({ method: 'GET', path: '/api/v1/search', headers: { authorization: `Bearer ${key}` },
  socket: { remoteAddress: '127.0.0.1' }, get(n) { return this.headers[String(n).toLowerCase()]; } });

(async () => {
  try {
    // An owner account (active) and an API key owned by it.
    const owner = users.create(dataDir, { username: 'worker', passwordHash: 'x', role: 'member' });
    ok(owner && owner.id && owner.status === 'active', 'created an active owner account');
    const { key } = apikeys.createKey(dataDir, { name: 'bot', scopes: ['search', 'write'], ownerUserId: owner.id });
    ok(typeof key === 'string' && key.length > 0, 'minted an API key owned by that account');

    // While the owner is active, the key authenticates.
    let p = await principal.fromRequest(dataDir, keyReq(key));
    ok(p && p.kind === 'apikey', 'the key authenticates while its owner is active');

    // Disable the owner — the key must stop authenticating immediately (no per-key revoke).
    users.update(dataDir, owner.id, { status: 'disabled' });
    p = await principal.fromRequest(dataDir, keyReq(key));
    ok(p && p.kind !== 'apikey', `a disabled owner's key no longer authenticates (got '${p && p.kind}')`);
    ok(apikeys.authenticate(dataDir, key), 'the key itself is still un-revoked (the gate is live owner status, not revocation)');

    // Re-enable the owner — the key authenticates again (the fix is reversible).
    users.update(dataDir, owner.id, { status: 'active' });
    p = await principal.fromRequest(dataDir, keyReq(key));
    ok(p && p.kind === 'apikey', 're-enabling the owner restores the key (reversible)');

    // A key with NO owner (the implicit single-operator seam) is never gated on an account.
    const { key: ownerless } = apikeys.createKey(dataDir, { name: 'legacy', scopes: ['search'] });
    const rec = apikeys.authenticate(dataDir, ownerless);
    ok(rec && !rec.ownerUserId, 'an ownerless key has no ownerUserId');
    p = await principal.fromRequest(dataDir, keyReq(ownerless));
    ok(p && p.kind === 'apikey', 'an ownerless key authenticates regardless of any account status (single-operator install)');

    console.log(`\nALL API-KEY-OWNER-STATUS TESTS PASSED (${checks} checks)`);
    cleanup(0);
  } catch (e) {
    console.error('\n✗ API-KEY-OWNER-STATUS TEST FAILED:', e && e.message);
    cleanup(1);
  }
})();
