'use strict';
// End-to-end (offline) guard for the multi-user auth wiring: the Accounts service, the principal resolver, and
// the middleware guards acting together. It proves the behaviors that make the feature safe: first user is the
// admin, login is constant-time and status-aware, a password change revokes other sessions, lockout guards
// protect the last/initial admin, the resolver maps session/key/implicit-owner/anonymous correctly and drops
// a disabled user's session immediately, and the capability guards + CSRF gate respond correctly (JSON vs
// redirect). Functional, temp dirs, no model/network. Run: `npm run test:unit`.

const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const accounts = require(path.join(PROJECT, 'lib', 'accounts'));
const principal = require(path.join(PROJECT, 'lib', 'principal'));
const authsessions = require(path.join(PROJECT, 'lib', 'authsessions'));
const apikeys = require(path.join(PROJECT, 'lib', 'apikeys'));
const mw = require(path.join(PROJECT, 'lib', 'authmiddleware'));
const authsecret = require(path.join(PROJECT, 'lib', 'authsecret'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-mu-'));
const dataDir = path.join(tmp, 'data');
const configDir = path.join(tmp, 'config');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(configDir, { recursive: true });
// Set exitCode and let the process drain naturally rather than process.exit(), which can truncate the
// buffered stdout of this longer test before the pass line is flushed.
const cleanup = (code) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exitCode = code; };

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const no = (c, m) => { checks++; assert.ok(!c, m); };
const rejectsCode = async (p, code, m) => { checks++; try { await p; assert.fail(m + ' (expected rejection)'); } catch (e) { assert.strictEqual(e && e.code, code, m); } };

// Minimal Express-ish req/res doubles.
const makeReq = ({ cookie = '', headers = {}, method = 'GET', path: p = '/api/x', body = {}, principal: pr } = {}) => ({
  method, path: p, originalUrl: p, url: p, body,
  headers: { cookie, ...headers },
  socket: { remoteAddress: '127.0.0.1' },
  get(name) { return this.headers[String(name).toLowerCase()]; },
  principal: pr,
});
const makeRes = () => ({
  statusCode: 200, body: null, redirected: null, headers: {}, _done: null,
  status(c) { this.statusCode = c; return this; },
  json(o) { this.body = o; if (this._done) this._done('json'); return this; },
  redirect(u) { this.redirected = u; if (this._done) this._done('redirect'); return this; },
  setHeader(k, v) { this.headers[k] = v; },
  getHeader(k) { return this.headers[k]; },
});
// Resolve when the guard calls next() OR sends a response (deny() does the latter without calling next), so a
// denied guard doesn't leave the await hanging.
const run = (fn, req, res) => new Promise((resolve) => {
  res._done = resolve;
  Promise.resolve(fn(req, res, () => resolve('next'))).catch(() => resolve('error'));
});

(async () => {
  try {
    authsecret.getSecret(configDir);   // establish the secret in the temp config dir

    // ── Before any account exists: resolver returns the implicit owner (non-breaking seam) ──
    let p = await principal.fromRequest(dataDir, makeReq());
    ok(p.kind === 'owner', 'with no accounts, the resolver returns the implicit owner');

    // ── First account becomes the initial admin regardless of requested role ──
    const admin = await accounts.createAccount(dataDir, { username: 'alice', password: 'correct horse', role: 'member' });
    ok(admin.role === 'admin' && admin.isInitial, 'the first account is forced to initial admin');
    // Now that an account exists, an unauthenticated request is anonymous, not owner.
    ok((await principal.fromRequest(dataDir, makeReq())).kind === 'anonymous', 'once an account exists, unauthenticated = anonymous (login required)');

    // ── Login: wrong password fails; unknown user fails (constant-time path); right password succeeds ──
    no((await accounts.verifyLogin(dataDir, 'alice', 'nope')).ok, 'a wrong password does not log in');
    no((await accounts.verifyLogin(dataDir, 'ghost', 'whatever')).ok, 'an unknown user does not log in');
    const login = await accounts.verifyLogin(dataDir, 'alice', 'correct horse');
    ok(login.ok && login.user.username === 'alice', 'the correct password logs in');

    // ── A session resolves to a user principal with the right role ──
    const sid = await authsessions.create(dataDir, admin.id, { ip: '127.0.0.1', ua: 'test' });
    const req = makeReq({ cookie: `lok_session=${sid}` });
    p = await principal.fromRequest(dataDir, req);
    ok(p.kind === 'user' && p.globalRole === 'admin' && p.userId === admin.id, 'a valid session resolves to the user principal');

    // ── A member with a workspace role; capability + CSRF gates behave ──
    const bob = await accounts.createAccount(dataDir, { username: 'bob', password: 'bob password' });
    require(path.join(PROJECT, 'lib', 'members')).set(dataDir, 'w1', bob.id, 'editor');
    const bobSid = await authsessions.create(dataDir, bob.id);
    const bobReq = makeReq({ cookie: `lok_session=${bobSid}`, path: '/api/x' });
    bobReq.principal = await principal.fromRequest(dataDir, bobReq);
    ok(bobReq.principal.workspaceRoles.get('w1') === 'editor', 'a member session carries its workspace roles');

    // requireCapability: editor can doc.write in w1, not in w2, and never settings.write.
    let res = makeRes();
    ok(await run(mw.requireCapability('doc.write', { workspace: 'w1' }), bobReq, res) === 'next', 'editor passes doc.write on its workspace');
    res = makeRes();
    await run(mw.requireCapability('doc.write', { workspace: 'w2' }), bobReq, res);
    ok(res.statusCode === 403, 'editor is 403 for a workspace it is not a member of');
    res = makeRes();
    await run(mw.requireGlobalAdmin, bobReq, res);
    ok(res.statusCode === 403, 'a member is 403 for a global-admin route');

    // admin passes global-admin.
    const adminReq = makeReq({ cookie: `lok_session=${sid}` });
    adminReq.principal = await principal.fromRequest(dataDir, adminReq);
    res = makeRes();
    ok(await run(mw.requireGlobalAdmin, adminReq, res) === 'next', 'an admin passes a global-admin route');

    // ── Unauthenticated: JSON 401 for an API path, redirect for a browser GET ──
    const anonApi = makeReq({ path: '/api/config' }); anonApi.principal = await principal.fromRequest(dataDir, anonApi);
    res = makeRes(); await run(mw.requireAuth, anonApi, res);
    ok(res.statusCode === 401 && !res.redirected, 'an unauthenticated API call gets a 401');
    const anonPage = makeReq({ path: '/', headers: { accept: 'text/html' } }); anonPage.principal = await principal.fromRequest(dataDir, anonPage);
    res = makeRes(); await run(mw.requireAuth, anonPage, res);
    ok(res.redirected && res.redirected.startsWith('/login'), 'an unauthenticated browser GET is redirected to /login');

    // ── CSRF: a state-changing (unsafe-method) session request needs a valid token ──
    const bobPost = makeReq({ cookie: `lok_session=${bobSid}`, method: 'POST' });
    bobPost.principal = await principal.fromRequest(dataDir, bobPost);
    res = makeRes();
    await run(mw.requireCsrf(configDir), bobPost, res);
    ok(res.statusCode === 403, 'a state-changing session request without a CSRF token is rejected');
    const token = mw.csrfToken(bobPost, configDir);
    const bobReqWithCsrf = makeReq({ cookie: `lok_session=${bobSid}`, method: 'POST', headers: { 'x-csrf-token': token } });
    bobReqWithCsrf.principal = await principal.fromRequest(dataDir, bobReqWithCsrf);
    res = makeRes();
    ok(await run(mw.requireCsrf(configDir), bobReqWithCsrf, res) === 'next', 'the correct CSRF token passes');
    // A safe method (GET/HEAD) carries no token and is skipped — so the gate can be mounted across
    // the whole /api control plane without blocking reads or the API-key data planes.
    const bobGet = makeReq({ cookie: `lok_session=${bobSid}`, method: 'GET' });
    bobGet.principal = await principal.fromRequest(dataDir, bobGet);
    res = makeRes();
    ok(await run(mw.requireCsrf(configDir), bobGet, res) === 'next', 'a safe-method request skips the CSRF check');
    // The token can also ride in a _csrf body field (the streamed backup-download form can't set a header).
    const bobBody = makeReq({ cookie: `lok_session=${bobSid}`, method: 'POST', body: { _csrf: token } });
    bobBody.principal = await principal.fromRequest(dataDir, bobBody);
    res = makeRes();
    ok(await run(mw.requireCsrf(configDir), bobBody, res) === 'next', 'a valid _csrf body field passes');
    // An API-key (non-cookie) caller is passed through — keys authenticate the data planes, not via CSRF.
    const keyPost = makeReq({ method: 'POST', headers: { authorization: 'Bearer nope' } });
    keyPost.principal = { kind: 'apikey', scopes: ['write'] };
    res = makeRes();
    ok(await run(mw.requireCsrf(configDir), keyPost, res) === 'next', 'a non-cookie (API-key) caller skips the CSRF check');
    console.log('✓ multiuser-auth: resolver maps owner/user/anon; capability, admin, and CSRF gates behave');

    // ── API key still authenticates via the same resolver ──
    const { key } = apikeys.createKey(dataDir, { name: 'bot', scopes: ['search'] });
    const keyReq = makeReq({ headers: { authorization: `Bearer ${key}` } });
    p = await principal.fromRequest(dataDir, keyReq);
    ok(p.kind === 'apikey' && p.scopes.includes('search'), 'an API key resolves to a key principal unchanged');

    // ── Disabled user: the session is dropped immediately (de-provision takes effect at once) ──
    require(path.join(PROJECT, 'lib', 'users')).update(dataDir, bob.id, { status: 'disabled' });
    p = await principal.fromRequest(dataDir, makeReq({ cookie: `lok_session=${bobSid}` }));
    ok(p.kind === 'anonymous', 'a disabled user\'s session no longer authenticates');

    // ── Password change revokes other sessions ──
    const s1 = await authsessions.create(dataDir, admin.id);
    const s2 = await authsessions.create(dataDir, admin.id);
    const revoked = await accounts.changePassword(dataDir, admin.id, 'a new strong password', { exceptRawSessionId: s1 });
    ok(revoked >= 1, 'changePassword revokes the user\'s other sessions');
    ok(await authsessions.get(dataDir, s1), 'the spared session survives the password change');
    no(await authsessions.get(dataDir, s2), 'another session is revoked by the password change');
    // Epoch check (belt-and-suspenders): the SPARED session still RESOLVES to the user after the password
    // change (it was re-stamped, so it isn't caught by the passwordChangedAt check), while a session that
    // somehow predates the change is dropped on resolution even if it escaped revocation.
    const pSpared = await principal.fromRequest(dataDir, makeReq({ cookie: `lok_session=${s1}` }));
    ok(pSpared.kind === 'user' && pSpared.userId === admin.id, 'the spared current session still resolves after a password change (not caught by the epoch check)');
    // Forge a stale session directly, then move passwordChangedAt forward, and confirm it is dropped on resolve.
    const staleSid = await authsessions.create(dataDir, admin.id);
    await new Promise((r) => setTimeout(r, 5));   // ensure the clock advances so passwordChangedAt > the session's created
    require(path.join(PROJECT, 'lib', 'users')).setPasswordHash(dataDir, admin.id, require(path.join(PROJECT, 'lib', 'users')).getRecordById(dataDir, admin.id).passwordHash);
    const pStale = await principal.fromRequest(dataDir, makeReq({ cookie: `lok_session=${staleSid}` }));
    ok(pStale.kind === 'anonymous', 'a session created before the last password change is dropped on resolution (no access granted)');

    // ── Lockout guards: the initial admin can\'t be demoted/disabled/deleted ──
    no(accounts.guardRoleChange(dataDir, admin.id, 'member').allowed, 'the initial admin cannot be demoted');
    no(accounts.guardStatusChange(dataDir, admin.id, 'disabled').allowed, 'the initial admin cannot be disabled');
    no(accounts.guardDelete(dataDir, admin.id).allowed, 'the initial admin cannot be deleted');
    console.log('✓ multiuser-auth: API keys resolve, disabled users drop instantly, password change revokes sessions, admin lockout guarded');

    // ── Delete cascade: a user\'s memberships and sessions go with them ──
    await accounts.changePassword;   // noop touch to keep ordering clear
    const carol = await accounts.createAccount(dataDir, { username: 'carol', password: 'carol password' });
    require(path.join(PROJECT, 'lib', 'members')).set(dataDir, 'w1', carol.id, 'viewer');
    const carolSid = await authsessions.create(dataDir, carol.id);
    ok(accounts.guardDelete(dataDir, carol.id).allowed, 'a normal member can be deleted');
    await accounts.deleteAccount(dataDir, carol.id);
    ok(require(path.join(PROJECT, 'lib', 'users')).getById(dataDir, carol.id) === null, 'the user is gone');
    ok(require(path.join(PROJECT, 'lib', 'members')).roleFor(dataDir, carol.id, 'w1') === null, 'the user\'s membership cascaded away');
    no(await authsessions.get(dataDir, carolSid), 'the user\'s session cascaded away');
    console.log('✓ multiuser-auth: deleting a user cascades its memberships and sessions (no orphans)');

    // ── principalKey: a stable, filesystem-safe namespace per identity (used to isolate on-disk sessions) ──
    const pk = principal.principalKey;
    ok(pk(principal.ownerPrincipal()) === 'owner', 'the owner maps to the fixed owner bucket');
    const kUserA = pk(principal.userPrincipal({ id: 'uA', username: 'a', role: 'user' }));
    const kUserB = pk(principal.userPrincipal({ id: 'uB', username: 'b', role: 'user' }));
    ok(kUserA !== kUserB && kUserA !== 'owner', 'distinct users map to distinct non-owner keys');
    ok(pk(principal.userPrincipal({ id: 'uA', username: 'a', role: 'user' })) === kUserA, 'the same user maps to a stable key');
    ok(pk(principal.keyPrincipal({ id: 'uA' })) !== kUserA, 'an API key and a user with the same raw id do not collide');
    ok(/^[A-Za-z0-9_-]{1,64}$/.test(kUserA) && /^[A-Za-z0-9_-]{1,64}$/.test(pk(principal.keyPrincipal({ id: 'weird/\\..id' }))),
      'the key is filesystem-safe and bounded regardless of the underlying id characters');
    ok(pk(null) === 'owner', 'a missing principal coerces to the safe owner default');
    ok(/^[A-Za-z0-9_-]{1,64}$/.test(pk({})), 'a garbage principal still yields a filesystem-safe key (never a bad path)');
    console.log('✓ multiuser-auth: principalKey is stable, collision-resistant, and filesystem-safe');

  // Password length is bounded on BOTH ends (min 8, max MAX_PASSWORD_LEN) — a coded error, never a throw/crash.
  await rejectsCode(accounts.createAccount(dataDir, { username: 'shortpw', password: 'x' }), 'weak_password', 'a too-short password is rejected');
  await rejectsCode(accounts.createAccount(dataDir, { username: 'longpw', password: 'x'.repeat(accounts.MAX_PASSWORD_LEN + 1) }), 'password_too_long', 'an over-long password is rejected');
  console.log('✓ multiuser-auth: password length is bounded on both ends (min + max)');

    console.log(`\nALL MULTIUSER-AUTH UNIT TESTS PASSED (${checks} checks)`);
    cleanup(0);
  } catch (e) {
    console.error('\n✗ MULTIUSER-AUTH UNIT TEST FAILED:', e && e.message, e && e.stack);
    cleanup(1);
  }
})();
