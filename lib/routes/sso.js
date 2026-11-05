'use strict';
// Single sign-on routes (OpenID Connect Authorization Code + PKCE). Mounted under /auth/sso, so the login
// gate already exempts them (they must be reachable without a session). SSO is optional and off unless the
// operator configures and enables an `oidc` block in config.json.
//
//   GET /auth/sso/login     → build the authorization request, stash the one-time flow secrets in a signed,
//                             httpOnly, short-lived cookie, and redirect to the identity provider.
//   GET /auth/sso/callback  → verify the returned code against those secrets, validate the ID token, map it
//                             to a Lokyni user (link or provision), start a session, and return to the app.
//
// Fail-closed throughout: any error ends at the login page with a message, never a crash and never a session.

const express = require('express');
const crypto = require('crypto');
const oidc = require('../oidc');
const accounts = require('../accounts');
const authsessions = require('../authsessions');
const authmw = require('../authmiddleware');
const authsecret = require('../authsecret');
const audit = require('../audit');
const principalMod = require('../principal');

const router = express.Router();
const cfg = () => require('../config');
const dataDir = () => require('../config').DATA_DIR;
const SSO_COOKIE = 'lok_sso';
const FLOW_TTL_MS = 10 * 60 * 1000;   // the user has 10 minutes to complete the IdP round trip

const redirectUriFor = (req) => {
  const c = cfg().oidc;
  if (c.redirectUri) return c.redirectUri;   // explicit config wins — recommended behind a reverse proxy
  // Derive the callback URL only from a host we actually trust. X-Forwarded-Host is NOT covered by the Host
  // guard (an attacker could send Host: localhost to pass the guard while X-Forwarded-Host: evil.com steers the
  // outbound redirect_uri), so accept it only when it is an allowed host (loopback / configured trustedHosts);
  // otherwise fall back to the Host header, which the guard already validated.
  const hg = require('../hostguard');
  const xfh = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = (xfh && hg.isAllowedHost(xfh)) ? xfh : req.headers.host;
  return `${authmw.isHttps(req) ? 'https' : 'http'}://${host}/auth/sso/callback`;
};
// Constant-time string compare for the flow anti-CSRF `state` (both values are the app's own, single-use and
// short-lived, so a timing attack is near-theoretical — but match the rest of the codebase's discipline).
const timingEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
};
// Only follow a same-origin path from ?next (open-redirect/XSS guard), mirroring the login page.
const safeNext = (req) => {
  const n = (req.query && req.query.next) || '/';
  if (typeof n !== 'string' || n[0] !== '/' || n[1] === '/' || n[1] === '\\' || /[<>"'\s]/.test(n)) return '/';
  return n;
};

// Signed, httpOnly flow cookie carrying the one-time state/nonce/PKCE verifier (never readable by JS, never
// forgeable without the server secret). SameSite=Lax so it survives the top-level GET redirect back from the
// IdP; Path is scoped to /auth/sso.
const setFlowCookie = (req, res, obj) => {
  const payload = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const sig = authsecret.sign(payload);   // secret dir resolved by authsecret (shared data dir in cluster mode)
  // Append (never overwrite) via the shared cookie builder, so a Set-Cookie already queued is preserved and
  // the flags stay identical to the session cookie.
  authmw.appendSetCookie(res, authmw.buildCookie({ name: SSO_COOKIE, value: `${payload}.${sig}`, path: '/auth/sso', maxAgeMs: FLOW_TTL_MS, req }));
};
const readFlowCookie = (req) => {
  try {
    const raw = principalMod.parseCookies(req.headers.cookie)[SSO_COOKIE];
    if (!raw) return null;
    const i = raw.lastIndexOf('.');
    if (i < 0) return null;
    const payload = raw.slice(0, i), sig = raw.slice(i + 1);
    if (!authsecret.verify(payload, sig)) return null;
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    if (!obj || typeof obj.exp !== 'number' || obj.exp < Date.now()) return null;
    return obj;
  } catch { return null; }
};
const clearFlowCookie = (req, res) =>
  // Append (never overwrite) via the shared builder, preserving any Set-Cookie already queued (for example the
  // new session cookie set on the same login redirect).
  authmw.appendSetCookie(res, authmw.buildCookie({ name: SSO_COOKIE, path: '/auth/sso', maxAgeMs: 0, req }));

const backToLogin = (res, reason) => res.redirect('/login?sso_error=' + encodeURIComponent(reason || 'Sign-in failed'));

// ── Start the flow ──────────────────────────────────────────────────────────
router.get('/login', async (req, res) => {
  const c = cfg();
  if (!c.ssoEnabled()) return backToLogin(res, 'SSO is not enabled');
  try {
    const redirectUri = redirectUriFor(req);
    const areq = await oidc.createAuthRequest({ issuer: c.oidc.issuer, clientId: c.oidc.clientId, redirectUri, scopes: c.oidc.scopes });
    setFlowCookie(req, res, { state: areq.state, nonce: areq.nonce, v: areq.codeVerifier, r: redirectUri, next: safeNext(req), exp: Date.now() + FLOW_TTL_MS });
    res.redirect(areq.url);
  } catch (e) {
    audit.auditAuthFail(req, 'auth.sso_error', 'login', e.message || 'start failed');
    backToLogin(res, 'Could not reach the identity provider');
  }
});

// ── Finish the flow ───────────────────────────────────────────────────────────
router.get('/callback', async (req, res) => {
  const c = cfg();
  if (!c.ssoEnabled()) return backToLogin(res, 'SSO is not enabled');
  const flow = readFlowCookie(req);
  clearFlowCookie(req, res);
  // The IdP may redirect back with an error (e.g. access_denied).
  if (req.query.error) { audit.auditAuthFail(req, 'auth.sso_error', 'callback', String(req.query.error).slice(0, 80)); return backToLogin(res, 'The identity provider declined the sign-in'); }
  if (!flow) return backToLogin(res, 'Your sign-in request expired — please try again');
  if (!req.query.code || !timingEqual(req.query.state, flow.state)) {
    audit.auditAuthFail(req, 'auth.sso_error', 'callback', 'state mismatch'); return backToLogin(res, 'Sign-in could not be verified — please try again');
  }
  try {
    const claims = await oidc.completeLogin(c.oidc, { code: String(req.query.code), codeVerifier: flow.v, nonce: flow.nonce, redirectUri: flow.r });
    const identity = oidc.identityFromClaims(claims, c.oidc);
    const result = accounts.provisionSsoUser(dataDir(), identity, { autoCreate: c.oidc.autoCreateUsers, defaultRole: c.oidc.defaultRole, linkByEmail: c.oidc.linkByEmail });
    if (!result.ok) { audit.auditAuthFail(req, 'auth.sso_denied', identity.subject || '', result.reason || 'denied'); return backToLogin(res, result.reason || 'Your identity could not be matched to an account'); }
    const ip = principalMod.clientIp(req);
    const sid = await authsessions.create(dataDir(), result.user.id, { ip, ua: req.get('user-agent') });
    authmw.setSessionCookie(req, res, sid, authsessions.DEFAULT_TTL_MS);
    audit.audit({ ...req, principal: principalMod.userPrincipal(result.user, new Map(), sid) }, result.created ? 'auth.sso_provisioned' : 'auth.sso_login', result.user.username, '');
    res.redirect(flow.next || '/');
  } catch (e) {
    audit.auditAuthFail(req, 'auth.sso_error', 'callback', e.message || 'verification failed');
    backToLogin(res, 'Sign-in failed — please try again');
  }
});

module.exports = router;
