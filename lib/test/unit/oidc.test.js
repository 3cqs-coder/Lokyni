'use strict';
// Guards the OIDC single-sign-on core (lib/oidc.js) and SSO provisioning (lib/accounts.provisionSsoUser).
// SSO is security-critical: a flaw would let a forged token in. This runs the WHOLE flow offline by minting
// an RS256 ID token with a locally generated key and stubbing fetch to serve a fake discovery doc, JWKS, and
// token response. It asserts a valid token is accepted and that every tampering (bad signature, wrong issuer,
// wrong audience, expired, wrong nonce, unsupported alg) is rejected — fail-closed — plus the PKCE auth
// request and the link/provision rules. Run: `npm run test:unit`.

const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), crypto = require('crypto');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const oidc = require(path.join(PROJECT, 'lib', 'oidc'));
const accounts = require(path.join(PROJECT, 'lib', 'accounts'));
const users = require(path.join(PROJECT, 'lib', 'users'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const no = (c, m) => { checks++; assert.ok(!c, m); };
const rejects = async (p, m) => { checks++; try { await p; assert.fail(m); } catch { /* expected */ } };

const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'lok-client';
const JWKS_URI = ISSUER + '/jwks';
const TOKEN_ENDPOINT = ISSUER + '/token';
const AUTH_ENDPOINT = ISSUER + '/authorize';
const KID = 'test-key-1';

const b64url = (x) => Buffer.from(x).toString('base64url');
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };

const signJwt = (payload, { kid = KID, alg = 'RS256', key = privateKey } = {}) => {
  const header = b64url(JSON.stringify({ alg, typ: 'JWT', kid }));
  const body = b64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const sig = crypto.sign('sha256', Buffer.from(data), key);
  return `${data}.${sig.toString('base64url')}`;
};
const baseClaims = (over = {}) => ({
  iss: ISSUER, sub: 'idp-user-123', aud: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 300,
  iat: Math.floor(Date.now() / 1000), nonce: 'NONCE', email: 'alice@example.com', email_verified: true,
  preferred_username: 'alice', ...over,
});

// ── Stub fetch to act as the IdP (discovery + JWKS + token) ──────────────────
const realFetch = global.fetch;
let currentIdToken = null;
const resp = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(obj) });
global.fetch = async (url) => {
  const u = String(url);
  if (u.endsWith('/.well-known/openid-configuration')) return resp({ issuer: ISSUER, authorization_endpoint: AUTH_ENDPOINT, token_endpoint: TOKEN_ENDPOINT, jwks_uri: JWKS_URI });
  if (u === JWKS_URI) return resp({ keys: [publicJwk] });
  if (u === TOKEN_ENDPOINT) return resp({ id_token: currentIdToken, token_type: 'Bearer' });
  return resp({ error: 'not found' }, 404);
};

const cfg = { issuer: ISSUER, clientId: CLIENT_ID, clientSecret: 'secret', scopes: 'openid profile email', usernameClaim: 'preferred_username', emailClaim: 'email' };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-oidc-'));
const cleanup = (code) => { global.fetch = realFetch; try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(code); };

(async () => {
  try {
    // ── PKCE auth request ──
    const areq = await oidc.createAuthRequest({ issuer: ISSUER, clientId: CLIENT_ID, redirectUri: 'https://app/cb', scopes: 'openid email' });
    const url = new URL(areq.url);
    ok(url.origin + url.pathname === AUTH_ENDPOINT, 'auth request targets the discovered authorization endpoint');
    ok(url.searchParams.get('code_challenge_method') === 'S256' && url.searchParams.get('code_challenge'), 'auth request uses PKCE S256');
    ok(url.searchParams.get('state') === areq.state && url.searchParams.get('nonce') === areq.nonce, 'auth request carries the returned state and nonce');
    ok(areq.codeVerifier && b64url(crypto.createHash('sha256').update(areq.codeVerifier).digest()) === url.searchParams.get('code_challenge'), 'the PKCE challenge is the SHA-256 of the returned verifier');
    console.log('✓ oidc: the authorization request is well-formed PKCE (S256, state, nonce)');

    // ── A valid ID token is accepted end to end ──
    currentIdToken = signJwt(baseClaims());
    const claims = await oidc.completeLogin(cfg, { code: 'abc', codeVerifier: areq.codeVerifier, nonce: 'NONCE', redirectUri: 'https://app/cb' });
    ok(claims.sub === 'idp-user-123' && claims.email === 'alice@example.com', 'a valid ID token is accepted and its claims returned');
    const id = oidc.identityFromClaims(claims, cfg);
    ok(id.subject === ISSUER + '|idp-user-123' && id.email === 'alice@example.com' && id.emailVerified === true && id.username === 'alice', 'identityFromClaims maps subject/email/username');
    console.log('✓ oidc: a valid ID token passes and maps to a stable identity');

    // ── Every tampering is rejected (fail-closed) ──
    const V = { issuer: ISSUER, clientId: CLIENT_ID, nonce: 'NONCE', jwksUri: JWKS_URI };
    // tampered signature
    const good = signJwt(baseClaims()); const parts = good.split('.');
    await rejects(oidc.verifyIdToken(parts[0] + '.' + parts[1] + '.' + 'AAAA' + parts[2].slice(4), V), 'a tampered signature is rejected');
    await rejects(oidc.verifyIdToken(signJwt(baseClaims({ iss: 'https://evil.example.com' })), V), 'a wrong issuer is rejected');
    await rejects(oidc.verifyIdToken(signJwt(baseClaims({ aud: 'someone-else' })), V), 'a wrong audience is rejected');
    await rejects(oidc.verifyIdToken(signJwt(baseClaims({ exp: Math.floor(Date.now() / 1000) - 600 })), V), 'an expired token is rejected');
    await rejects(oidc.verifyIdToken(signJwt(baseClaims({ nonce: 'DIFFERENT' })), V), 'a wrong nonce is rejected');
    await rejects(oidc.verifyIdToken(signJwt(baseClaims(), { alg: 'none' }), V), 'an unsupported/none alg is rejected');
    await rejects(oidc.verifyIdToken(signJwt(baseClaims(), { kid: 'unknown-kid' }), V), 'an unknown signing key id is rejected');
    // a token signed by a DIFFERENT key (same kid) must fail signature verification
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    await rejects(oidc.verifyIdToken(signJwt(baseClaims(), { key: other.privateKey }), V), 'a token signed by a different key is rejected');
    // A segment that is valid JSON but not a plain object (null / array) must be rejected cleanly, not throw a
    // raw TypeError when .alg/.kid are read off it.
    await rejects(oidc.verifyIdToken(`${b64url('null')}.${b64url(JSON.stringify(baseClaims()))}.AAAA`, V), 'a null token header is rejected cleanly');
    await rejects(oidc.verifyIdToken(`${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID }))}.${b64url('[1,2,3]')}.AAAA`, V), 'non-object claims are rejected cleanly');
    ok(await oidc.verifyIdToken(signJwt(baseClaims()), V), 'a correctly-signed, valid token still passes after the rejections');
    console.log('✓ oidc: forged/altered tokens (signature, iss, aud, exp, nonce, alg, kid, wrong key) are all rejected');

    // ── issuer transport guard ──
    no(oidc.isSafeIssuer('http://idp.example.com'), 'a non-loopback http issuer is refused');
    ok(oidc.isSafeIssuer('https://idp.example.com'), 'an https issuer is allowed');
    ok(oidc.isSafeIssuer('http://localhost:8080/realms/x'), 'a loopback http issuer is allowed for dev');

    // ── Provisioning rules ──
    // First SSO login provisions the initial admin.
    let r = accounts.provisionSsoUser(tmp, oidc.identityFromClaims(baseClaims(), cfg), { autoCreate: true, defaultRole: 'member' });
    ok(r.ok && r.created && r.user.role === 'admin' && r.user.isInitial, 'the first SSO user is provisioned as the initial admin');
    // Re-login by the same subject returns the same user (no duplicate).
    let r2 = accounts.provisionSsoUser(tmp, oidc.identityFromClaims(baseClaims(), cfg), { autoCreate: true, defaultRole: 'member' });
    ok(r2.ok && !r2.created && r2.user.id === r.user.id, 're-login by the same subject returns the same account');
    // A second identity provisions a member (defaultRole).
    const bob = oidc.identityFromClaims(baseClaims({ sub: 'idp-bob', preferred_username: 'bob', email: 'bob@example.com' }), cfg);
    let r3 = accounts.provisionSsoUser(tmp, bob, { autoCreate: true, defaultRole: 'member' });
    ok(r3.ok && r3.created && r3.user.role === 'member', 'a subsequent SSO user is provisioned with the default role');
    // Link to an existing LOCAL account by verified email (admin pre-created it).
    const carol = await accounts.createAccount(tmp, { username: 'carol', email: 'carol@example.com', password: 'carol password' });
    const carolSso = oidc.identityFromClaims(baseClaims({ sub: 'idp-carol', preferred_username: 'carol-idp', email: 'carol@example.com' }), cfg);
    let r4 = accounts.provisionSsoUser(tmp, carolSso, { autoCreate: true, defaultRole: 'member' });
    ok(r4.ok && !r4.created && r4.user.id === carol.id, 'an SSO identity links to an existing account by verified email');
    ok(users.getBySsoSubject(tmp, ISSUER + '|idp-carol') && users.getBySsoSubject(tmp, ISSUER + '|idp-carol').id === carol.id, 'the link is persisted on the account');
    // An UNVERIFIED email never links.
    const daveUnverified = oidc.identityFromClaims(baseClaims({ sub: 'idp-dave', preferred_username: 'dave', email: 'carol@example.com', email_verified: false }), cfg);
    let r5 = accounts.provisionSsoUser(tmp, daveUnverified, { autoCreate: false, defaultRole: 'member' });
    no(r5.ok, 'an unverified email does not link to an existing account, and autoCreate off denies');
    // autoCreate off denies a brand-new identity.
    let r6 = accounts.provisionSsoUser(tmp, oidc.identityFromClaims(baseClaims({ sub: 'idp-new', email: 'new@example.com' }), cfg), { autoCreate: false });
    no(r6.ok, 'with autoCreate off, an unknown identity is denied (no silent account creation)');
    // A disabled linked account is refused.
    users.update(tmp, bob.subject && r3.user.id, { status: 'disabled' });
    let r7 = accounts.provisionSsoUser(tmp, bob, { autoCreate: true, defaultRole: 'member' });
    no(r7.ok, 'a disabled account cannot sign in via SSO');
    console.log('✓ oidc: provisioning links by subject/verified-email, auto-creates when allowed, and respects disabled/denied');

    // linkByEmail:false — a verified-email claim must NOT bridge into an existing LOCAL account (the posture for
    // a multi-tenant / less-trusted IdP). With autoCreate on it provisions a SEPARATE account instead.
    const erin = await accounts.createAccount(tmp, { username: 'erin', email: 'erin@example.com', password: 'erin password' });
    const erinSso = oidc.identityFromClaims(baseClaims({ sub: 'idp-erin', preferred_username: 'erin-idp', email: 'erin@example.com' }), cfg);
    const r8 = accounts.provisionSsoUser(tmp, erinSso, { autoCreate: true, defaultRole: 'member', linkByEmail: false });
    ok(r8.ok && r8.created && r8.user.id !== erin.id, 'linkByEmail:false does not take over an existing local account by email (provisions a separate one)');
    const erinLink = users.getBySsoSubject(tmp, ISSUER + '|idp-erin');
    ok(erinLink && erinLink.id !== erin.id, 'the existing account was not linked when linkByEmail is off');
    // With linkByEmail off and autoCreate off, a matching verified email is denied (not linked).
    const frank = await accounts.createAccount(tmp, { username: 'frank', email: 'frank@example.com', password: 'frank password' });
    const frankSso = oidc.identityFromClaims(baseClaims({ sub: 'idp-frank', preferred_username: 'frank-idp', email: 'frank@example.com' }), cfg);
    no(accounts.provisionSsoUser(tmp, frankSso, { autoCreate: false, linkByEmail: false }).ok, 'linkByEmail off + autoCreate off denies a matching-email identity (no takeover, no create)');
    ok(!users.getBySsoSubject(tmp, ISSUER + '|idp-frank'), 'frank\'s local account stays unlinked');
    console.log('✓ oidc: linkByEmail=false blocks verified-email account takeover (separate account or deny)');

    // Route hardening (source guards on routes/sso.js): the flow `state` is compared constant-time, and a
    // derived redirect_uri trusts X-Forwarded-Host only when it is an allowed host (not steerable past the guard).
    const ssoSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'routes', 'sso.js'), 'utf-8');
    ok(/const timingEqual =/.test(ssoSrc) && /!timingEqual\(req\.query\.state, flow\.state\)/.test(ssoSrc),
      'the SSO state is compared in constant time');
    ok(/hg\.isAllowedHost\(xfh\)\) \? xfh : req\.headers\.host/.test(ssoSrc),
      'the derived redirect_uri accepts X-Forwarded-Host only when it is an allowed host');
    ok(/linkByEmail: c\.oidc\.linkByEmail/.test(ssoSrc), 'the callback passes the linkByEmail flag through to provisioning');
    console.log('✓ oidc: SSO route compares state constant-time and validates the derived redirect host');

    console.log(`\nALL OIDC UNIT TESTS PASSED (${checks} checks)`);
    cleanup(0);
  } catch (e) {
    console.error('\n✗ OIDC UNIT TEST FAILED:', e && e.message, e && e.stack);
    cleanup(1);
  }
})();
