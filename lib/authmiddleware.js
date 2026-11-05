'use strict';
// Auth middleware and guards — the single enforcement seam for the control plane.
//
// attachPrincipal() resolves req.principal on every request (never rejecting). The guards (requireAuth,
// requireCapability, requireGlobalAdmin) consume it and are content-negotiated: a browser navigation that is
// not authenticated is redirected to the login page, while an API/XHR/JSON caller gets a clean 401/403. CSRF
// protection binds a token to the session for state-changing control-plane requests (defense in depth beyond
// the existing cross-origin block). Cookie helpers build the session cookie with safe, cross-browser flags.

const { can } = require('./authz');
const principal = require('./principal');
const authsecret = require('./authsecret');

const COOKIE = principal.COOKIE_NAME;

// Is this request better answered with JSON than an HTML redirect? True for XHR/fetch, an Accept or
// Content-Type of JSON, and the programmatic surfaces (/api, /auth, /mcp).
const wantsJson = (req) => {
  try {
    const accept = (req.get && req.get('accept')) || '';
    const ctype = (req.get && req.get('content-type')) || '';
    return !!req.xhr || /application\/json/i.test(accept) || /application\/json/i.test(ctype)
      || /^\/(api|auth|mcp|ws)(\/|$)/.test(req.path || '');
  } catch { return true; }
};

const deny = (req, res, code) => {
  // Only a plain browser GET that needs auth is redirected to login; everything else gets a JSON status.
  if (code === 401 && !wantsJson(req) && req.method === 'GET') {
    const next = encodeURIComponent(req.originalUrl || req.url || '/');
    return res.redirect(`/login?next=${next}`);
  }
  return res.status(code).json({ error: code === 401 ? 'Authentication required' : 'Forbidden' });
};

// Attach req.principal for every request. Never throws — a resolver error degrades to anonymous.
const attachPrincipal = (dataDir) => async (req, res, next) => {
  try { req.principal = await principal.fromRequest(dataDir, req); }
  catch { req.principal = principal.anonymousPrincipal(); }
  next();
};

const isAuthenticated = (p) => p && p.kind && p.kind !== 'anonymous';

const requireAuth = (req, res, next) => {
  if (!isAuthenticated(req.principal)) return deny(req, res, 401);
  next();
};

// Gate a route on a capability. `opts.workspace` may be a string or a function(req)->workspaceId for a
// workspace-scoped capability.
const requireCapability = (capability, opts = {}) => (req, res, next) => {
  const p = req.principal;
  if (!isAuthenticated(p)) return deny(req, res, 401);
  const workspaceId = typeof opts.workspace === 'function' ? opts.workspace(req) : (opts.workspace ?? null);
  if (!can(p, capability, { workspaceId })) return deny(req, res, 403);
  next();
};

// Refuse an index-mutating operation on a read replica — the primary owns all writes over the shared data
// directory. A single node or the primary passes through. Returns 409 so a client can tell it apart from an
// auth failure and retry against the primary.
const requirePrimary = (req, res, next) => {
  if (require('./cluster').isReplica()) {
    return res.status(409).json({ error: 'This instance is a read replica. Perform this action on the primary.' });
  }
  next();
};

const requireGlobalAdmin = (req, res, next) => {
  const p = req.principal;
  if (!isAuthenticated(p)) return deny(req, res, 401);
  if (p.kind === 'owner' || (p.kind === 'user' && p.globalRole === 'admin')) return next();
  return deny(req, res, 403);
};

// ── Session cookie helpers ────────────────────────────────────────────────────
// Secure is derived live from whether the request arrived over HTTPS (behind a TLS proxy via
// x-forwarded-proto), so loopback-HTTP and a TLS deployment both work with no env flag to set. SameSite=Lax
// keeps the cookie on top-level navigations while blocking cross-site POSTs; HttpOnly keeps it out of JS.
const isHttps = (req) => {
  try {
    if (req.secure) return true;
    const xfp = (req.headers && req.headers['x-forwarded-proto']) || '';
    return String(xfp).split(',')[0].trim().toLowerCase() === 'https';
  } catch { return false; }
};
// Build one Set-Cookie line with the app's standard safe flags: HttpOnly, SameSite=Lax, and Secure when the
// request is HTTPS. `maxAgeMs` of 0 (the default) clears the cookie. The value is sent as-is, so a caller that
// needs URL-encoding does it. Single-sourced so every cookie the app sets (the session cookie here and the SSO
// flow cookie in routes/sso.js) shares identical flags and can never drift.
const buildCookie = ({ name, value = '', path = '/', maxAgeMs = 0, req }) => {
  const parts = [`${name}=${value}`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
};
// Append a Set-Cookie line, preserving any already queued on the response (so setting one cookie never drops
// another — for example the new session cookie and the cleared SSO flow cookie on the same login redirect).
const appendSetCookie = (res, cookie) => {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', cookie);
  else res.setHeader('Set-Cookie', Array.isArray(prev) ? prev.concat(cookie) : [prev, cookie]);
};
const setSessionCookie = (req, res, rawId, maxAgeMs) =>
  appendSetCookie(res, buildCookie({ name: COOKIE, value: encodeURIComponent(rawId), path: '/', maxAgeMs, req }));
const clearSessionCookie = (req, res) =>
  appendSetCookie(res, buildCookie({ name: COOKIE, path: '/', maxAgeMs: 0, req }));

// ── CSRF (double-submit, bound to the session via the server secret) ──────────
// Token = HMAC(secret, "csrf:" + sessionId). The page fetches it and sends it back as the x-csrf-token header
// on state-changing requests; a cross-site page cannot read it (it is not a cookie) nor forge it (no secret).
// Only cookie-session principals are checked — API-key callers aren't cookie-authenticated, so they aren't
// CSRF-reachable, and the implicit owner has no session to bind.
const csrfToken = (req, configDir) => {
  const p = req.principal;
  if (!p || p.kind !== 'user' || !p.sessionId) return '';
  // sign() throws (fail-closed) if the auth secret is present-but-unreadable — degrade to an empty token so
  // the login/account page still renders (a missing token just fails the next state-changing request closed)
  // rather than 500-ing the page.
  try { return authsecret.sign('csrf:' + p.sessionId, configDir); } catch { return ''; }
};
// Safe methods never mutate state, so they carry no token. Skipping them lets this be mounted
// across a whole router (e.g. the /api control plane) without blocking every GET — and the
// API-key data planes, which must stay reachable with GET, are untouched.
const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const requireCsrf = (configDir) => (req, res, next) => {
  if (CSRF_SAFE_METHODS.has(req.method)) return next();
  const p = req.principal;
  // Nothing to protect for non-cookie principals (API keys, implicit owner): no session to forge.
  if (!p || p.kind !== 'user' || !p.sessionId) return next();
  const token = (req.get && req.get('x-csrf-token')) || (req.body && req.body._csrf) || '';
  if (authsecret.verify('csrf:' + p.sessionId, token, configDir)) return next();
  return res.status(403).json({ error: 'Invalid or missing CSRF token' });
};

module.exports = {
  wantsJson, deny, attachPrincipal, isAuthenticated, requireAuth, requireCapability, requireGlobalAdmin, requirePrimary,
  setSessionCookie, clearSessionCookie, csrfToken, requireCsrf, COOKIE,
  // Shared so other cookie setters (routes/sso.js) build identical flags and always append, never overwrite.
  isHttps, buildCookie, appendSetCookie,
};
