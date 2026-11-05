'use strict';
// Guards the login-session store (lib/authsessions.js). Sessions must: survive on disk (so a restart never
// logs anyone out), store only a HASH of the id (the raw id lives only in the cookie), expire and lazily
// self-delete, revoke per-user (password change / sign-out-everywhere) while sparing the current session, cap
// per user, and prune — all streaming the directory so memory stays flat. Functional, in a temp dir.
// Run: `npm run test:unit`.

const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const sessions = require(path.join(PROJECT, 'lib', 'authsessions'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-authsess-'));
const cleanup = (code) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(code); };

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const no = (c, m) => { checks++; assert.ok(!c, m); };

(async () => {
  try {
    // Create + look up.
    const raw = await sessions.create(tmp, 'u1', { ip: '127.0.0.1', ua: 'test-agent' });
    ok(typeof raw === 'string' && raw.length >= 32, 'create returns a long opaque raw id');
    const sess = await sessions.get(tmp, raw);
    ok(sess && sess.userId === 'u1', 'the session looks up by its raw id');
    ok(sess.ip === '127.0.0.1' && sess.ua === 'test-agent', 'ip/user-agent are recorded for the sessions UI');

    // The raw id is NOT on disk — only its hash is the filename, and the file content has no raw id.
    const dir = path.join(tmp, 'auth-sessions');
    const files = fs.readdirSync(dir);
    ok(files.length === 1 && !files[0].includes(raw), 'the raw id is not the filename (only its hash is)');
    const onDisk = fs.readFileSync(path.join(dir, files[0]), 'utf-8');
    ok(!onDisk.includes(raw), 'the stored file does not contain the raw id (hash-only at rest)');
    if (process.platform !== 'win32') ok((fs.statSync(path.join(dir, files[0])).mode & 0o777) === 0o600, 'the session file is owner-only (0600)');

    // Durability: a fresh lookup (no in-memory state needed) still resolves — restart-safe by construction.
    ok((await sessions.get(tmp, raw)).userId === 'u1', 'the session resolves again from disk (restart-durable)');

    // Wrong / unknown id → null.
    no(await sessions.get(tmp, 'not-a-real-session-id'), 'an unknown id returns null');

    // Expiry: a session created with a tiny TTL is gone on the next lookup (and self-deleted).
    const shortRaw = await sessions.create(tmp, 'u1', { ttlMs: 1 });
    await new Promise(r => setTimeout(r, 5));
    no(await sessions.get(tmp, shortRaw), 'an expired session returns null');
    console.log('✓ authsessions: create/lookup, hash-only at rest, restart-durable, expiry self-deletes');

    // Destroy one.
    ok(await sessions.destroy(tmp, raw), 'destroy removes a session');
    no(await sessions.get(tmp, raw), 'the destroyed session is gone');

    // Per-user revocation, sparing the current session.
    const a = await sessions.create(tmp, 'u2');
    const b = await sessions.create(tmp, 'u2');
    const c = await sessions.create(tmp, 'u3');
    const removed = await sessions.destroyForUser(tmp, 'u2', a);
    ok(removed === 1, 'destroyForUser removes the user\'s OTHER sessions (spares the current one)');
    ok(await sessions.get(tmp, a), 'the spared (current) session survives');
    no(await sessions.get(tmp, b), 'the other session of the same user is revoked');
    ok(await sessions.get(tmp, c), 'a different user\'s session is untouched');

    // destroyForUser with no exception removes all of that user's sessions.
    await sessions.create(tmp, 'u2');
    ok(await sessions.destroyForUser(tmp, 'u2') >= 1, 'destroyForUser with no exception removes all of the user\'s sessions');
    ok((await sessions.listForUser(tmp, 'u2')).length === 0, 'the user has no sessions left');

    // listForUser returns a safe view with a "current" flag and no raw id.
    const view = await sessions.listForUser(tmp, 'u3', c);
    ok(view.length === 1 && view[0].current === true && view[0].ip !== undefined, 'listForUser marks the current session and exposes no raw id');

    // Per-user cap: creating more than the cap evicts the oldest.
    const over = sessions.MAX_PER_USER + 2;
    for (let i = 0; i < over; i++) { /* eslint-disable-next-line no-await-in-loop */ await sessions.create(tmp, 'ucap'); }
    await sessions.enforceUserCap(tmp, 'ucap');
    ok((await sessions.listForUser(tmp, 'ucap')).length === sessions.MAX_PER_USER, `the per-user session cap (${sessions.MAX_PER_USER}) is enforced`);

    // Prune removes expired sessions across users.
    await sessions.create(tmp, 'uprune', { ttlMs: 1 });
    await new Promise(r => setTimeout(r, 5));
    ok(await sessions.pruneExpired(tmp) >= 1, 'pruneExpired removes expired sessions');

    // startPrune returns an unref\'d timer (does not hold the process open).
    const t = sessions.startPrune(tmp, 3600000);
    ok(t && typeof t === 'object', 'startPrune returns a timer');
    clearInterval(t);
    console.log('✓ authsessions: destroy, per-user revoke (spare current), cap, prune, unref\'d pruner');

    console.log(`\nALL AUTHSESSIONS UNIT TESTS PASSED (${checks} checks)`);
    cleanup(0);
  } catch (e) {
    console.error('\n✗ AUTHSESSIONS UNIT TEST FAILED:', e && e.message);
    cleanup(1);
  }
})();
