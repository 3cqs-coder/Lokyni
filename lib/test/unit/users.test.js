'use strict';
// Guards the user account store (lib/users.js). Accounts rest on this: unique case-insensitive usernames,
// optional unique email, no password hash ever exposed, validation that rejects bad input, and a missing file
// that reads as "no users" (so a fresh single-operator install still works) without throwing. Functional, in
// a temp dir. Run: `npm run test:unit`.

const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const users = require(path.join(PROJECT, 'lib', 'users'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-users-'));
const cleanup = (code) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(code); };

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const no = (c, m) => { checks++; assert.ok(!c, m); };
const throws = (fn, code, m) => { checks++; try { fn(); assert.fail(m); } catch (e) { assert.ok(!code || e.code === code, `${m} (code ${e.code})`); } };

try {
  // Fresh dir: no users, no throw (the implicit-owner seam depends on this).
  ok(users.isEmpty(tmp), 'a fresh data dir has no users');
  ok(users.count(tmp) === 0 && users.list(tmp).length === 0, 'count/list are empty and do not throw');

  // Create the first (admin) user.
  const admin = users.create(tmp, { username: 'Alice', email: 'alice@example.com', passwordHash: 'scrypt:x', role: 'admin', isInitial: true });
  ok(admin && admin.username === 'Alice' && admin.role === 'admin' && admin.isInitial, 'first user is created as initial admin');
  ok(!('passwordHash' in admin), 'the public view never includes the password hash');
  ok(users.count(tmp) === 1 && !users.isEmpty(tmp), 'the store now reports one user');

  // Case-insensitive username uniqueness; email uniqueness.
  throws(() => users.create(tmp, { username: 'alice', passwordHash: 'scrypt:y' }), 'username_taken', 'a case-insensitive duplicate username is rejected');
  throws(() => users.create(tmp, { username: 'bob', email: 'ALICE@example.com', passwordHash: 'scrypt:y' }), 'email_taken', 'a case-insensitive duplicate email is rejected');

  // Validation.
  throws(() => users.create(tmp, { username: 'has space', passwordHash: 'scrypt:y' }), 'invalid_username', 'an invalid username is rejected');
  throws(() => users.create(tmp, { username: 'carol', passwordHash: '' }), 'invalid_password', 'a missing password hash is rejected');
  throws(() => users.create(tmp, { username: 'dave', passwordHash: 'scrypt:y', role: 'superuser' }), 'invalid_role', 'an invalid role is rejected');
  throws(() => users.create(tmp, { username: 'erin', email: 'not-an-email', passwordHash: 'scrypt:y' }), 'invalid_email', 'an invalid email is rejected');

  // Second user as a member; lookups are case-insensitive.
  const bob = users.create(tmp, { username: 'Bob', passwordHash: 'scrypt:z' });
  ok(bob.role === 'member', 'a subsequent user defaults to member');
  ok(users.getByUsername(tmp, 'BOB').id === bob.id, 'getByUsername is case-insensitive');
  ok(users.getByEmail(tmp, 'alice@example.com').id === admin.id, 'getByEmail finds the user');
  ok(users.getByEmail(tmp, 'nobody@example.com') === null, 'getByEmail returns null for an unknown email');
  // The auth-path record includes the hash; the public view does not.
  ok(users.getRecordByUsername(tmp, 'bob').passwordHash === 'scrypt:z', 'the record lookup includes the hash for the auth path');

  // Update role/status, with uniqueness still enforced.
  ok(users.update(tmp, bob.id, { role: 'admin', status: 'disabled' }).role === 'admin', 'update changes role');
  ok(users.getById(tmp, bob.id).status === 'disabled', 'update changes status');
  throws(() => users.update(tmp, bob.id, { username: 'alice' }), 'username_taken', 'rename to an existing username is rejected');
  ok(users.update(tmp, bob.id, { username: 'Bobby' }).username === 'Bobby', 'rename to a free username works');

  // Password change bumps passwordChangedAt (used to invalidate old sessions).
  const before = users.getRecordById(tmp, admin.id).passwordChangedAt;
  ok(users.setPasswordHash(tmp, admin.id, 'scrypt:new'), 'setPasswordHash succeeds');
  ok(users.getRecordById(tmp, admin.id).passwordChangedAt >= before, 'passwordChangedAt advances on a password change');
  ok(users.getRecordById(tmp, admin.id).passwordHash === 'scrypt:new', 'the new hash is stored');

  // Remove.
  ok(users.remove(tmp, bob.id), 'remove deletes a user');
  ok(users.getById(tmp, bob.id) === null, 'the removed user is gone');
  no(users.remove(tmp, 'u_missing'), 'removing an unknown user returns false');

  console.log('✓ users: create/lookup/update/password/remove with case-insensitive uniqueness and validation');

  // ── Security: a present-but-CORRUPT users file must NOT read as "empty" (which would re-open the instance
  //    to the implicit owner). It is treated as "accounts exist" and flagged corrupt. ──
  {
    const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-users-corrupt-'));
    fs.writeFileSync(path.join(cdir, 'users.json'), '{ this is not valid json');
    ok(users.isCorrupt(cdir) === true, 'a present-but-corrupt users file is flagged corrupt');
    ok(users.isEmpty(cdir) === false, 'a corrupt users file is NOT treated as empty (fails closed, no implicit-owner reopen)');
    // A file that parses to an empty list IS empty (an install that deleted all users).
    fs.writeFileSync(path.join(cdir, 'users.json'), JSON.stringify({ users: [] }));
    ok(users.isCorrupt(cdir) === false && users.isEmpty(cdir) === true, 'a valid empty users file reads as empty (and not corrupt)');
    fs.rmSync(cdir, { recursive: true, force: true });
    console.log('✓ users: a corrupt users file fails closed (not empty); a valid empty file reads as empty');
  }

  // ── Multilingual display name: any script, NFC-normalized, control/format stripped, ASCII username unchanged ──
  {
    const u = users.create(tmp, { username: 'yamada', passwordHash: 'scrypt:x', displayName: '山田太郎' });
    ok(u.displayName === '山田太郎', 'a non-Latin display name is stored intact');
    ok(u.name === '山田太郎', 'the resolved name prefers the display name');
    ok(u.username === 'yamada', 'the username (identifier) stays ASCII, separate from the display name');

    const u2 = users.create(tmp, { username: 'noname', passwordHash: 'scrypt:x' });
    ok(u2.displayName === null && u2.name === 'noname', 'with no display name, the resolved name falls back to the username');

    // normalizeDisplayName: accents kept, whitespace collapsed, zero-width / bidi-override stripped, bounded, and
    // non-strings/blank → null (the view then falls back to the username).
    ok(users.normalizeDisplayName('  José   Díaz ') === 'José Díaz', 'accents kept and whitespace collapsed');
    ok(users.normalizeDisplayName('Zoë​Widmark') === 'Zoë Widmark', 'a zero-width character is stripped');
    ok(users.normalizeDisplayName('‮evil') === 'evil', 'a bidi-override control is stripped (anti-spoof)');
    ok(users.normalizeDisplayName('') === null && users.normalizeDisplayName(null) === null, 'blank or non-string normalizes to null');
    ok([...users.normalizeDisplayName('x'.repeat(200))].length === users.MAX_DISPLAY_NAME, 'an over-long name is bounded to the cap');

    // update clears or changes it; the username is never touched by a display-name edit.
    const cleared = users.update(tmp, u.id, { displayName: '   ' });
    ok(cleared.displayName === null && cleared.name === 'yamada', 'a blank display-name update clears it (falls back to username)');
    const changed = users.update(tmp, u.id, { displayName: 'Müller' });
    ok(changed.displayName === 'Müller' && changed.username === 'yamada', 'a display-name change leaves the username identifier intact');
  }

  console.log(`\nALL USERS UNIT TESTS PASSED (${checks} checks)`);
  cleanup(0);
} catch (e) {
  console.error('\n✗ USERS UNIT TEST FAILED:', e && e.message);
  cleanup(1);
}
