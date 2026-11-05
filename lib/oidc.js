'use strict';
// OpenID Connect (OIDC) client — optional single sign-on, dependency-free.
//
// Implements the Authorization Code flow with PKCE against any standards-compliant OIDC provider (the
// operator configures the issuer + client in config.json). It uses only node:crypto and global fetch — no
// OIDC library — so it compiles on every platform and adds nothing to install, matching the local-first,
// minimal-dependency design. SSO is OFF by default; local accounts are unchanged.
//
// Robustness is deliberate and throughout:
//   • NON-BLOCKING: every network call is fetch on the libuv pool with an AbortController timeout.
//   • OOM-PROOF: response bodies are size-capped before parsing; the discovery and JWKS caches are tiny and
//     bounded.
//   • CRASH-PROOF / FAIL-CLOSED: any discovery, token, or ID-token validation failure throws a plain Error
//     that the route turns into a declined login — a malformed response never crashes the process, and a
//     token that fails any check (signature, issuer, audience, expiry, nonce) is never accepted.

const crypto = require('crypto');

const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 1024 * 1024;         // discovery/JWKS/token responses are small; cap hard anyway
const DISCOVERY_TTL_MS = 60 * 60 * 1000;    // re-discover hourly
const JWKS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_S = 120;                    // tolerate small clock differences on exp/iat/nbf

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

// A timed, size-capped JSON fetch. The timeout stays armed across the BODY read (not just the headers) and the
// body is streamed with a running byte cap, so a hostile/compromised IdP that omits or lies about
// content-length and trickles an arbitrarily large body can neither hang the SSO callback nor exhaust memory.
// Throws on a non-2xx status, a too-large body, a timeout, or invalid JSON.
const fetchJson = async (url, opts = {}) => {
  const { res, text } = await require('./fetchtimeout').fetchTextCapped(
    url, { ...opts, redirect: 'follow' }, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_BODY_BYTES });
  if (!res.ok) throw new Error(`OIDC request failed (HTTP ${res.status})`);
  try { return JSON.parse(text); } catch { throw new Error('OIDC response was not valid JSON'); }
};

// An issuer must be HTTPS, except a loopback host for local development (e.g. a dev Keycloak on
// http://localhost). This is the one transport check we enforce; the operator chooses the (possibly on-prem,
// possibly private-network) IdP, so we deliberately do NOT run it through the public-only SSRF guard.
const isSafeIssuer = (issuer) => {
  try {
    const u = new URL(issuer);
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) return true;
    return false;
  } catch { return false; }
};

// ── Discovery + JWKS caches (bounded, TTL'd) ──────────────────────────────────
const _discovery = new Map();   // issuer → { doc, exp }
const _jwks = new Map();        // jwksUri → { keys: Map<kid,jwk>, exp, lastRefresh }

const discover = async (issuer) => {
  if (!isSafeIssuer(issuer)) throw new Error('OIDC issuer must be an https URL (or a loopback http URL for dev)');
  const cached = _discovery.get(issuer);
  if (cached && cached.exp > Date.now()) return cached.doc;
  const doc = await fetchJson(issuer.replace(/\/$/, '') + '/.well-known/openid-configuration');
  // The discovered issuer MUST equal the configured one (prevents a mix-up / spoofed metadata).
  if (doc.issuer !== issuer) throw new Error('OIDC issuer mismatch in discovery document');
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) throw new Error('OIDC discovery document is missing required endpoints');
  if (_discovery.size > 50) _discovery.clear();   // tiny, bounded
  _discovery.set(issuer, { doc, exp: Date.now() + DISCOVERY_TTL_MS });
  return doc;
};

const loadJwks = async (jwksUri) => {
  const data = await fetchJson(jwksUri);
  const keys = new Map();
  for (const k of (Array.isArray(data.keys) ? data.keys : [])) if (k && k.kid) keys.set(k.kid, k);
  if (_jwks.size > 50) _jwks.clear();
  _jwks.set(jwksUri, { keys, exp: Date.now() + JWKS_TTL_MS, lastRefresh: Date.now() });
  return keys;
};

// Resolve a signing key by kid, refreshing the JWKS once (at most every minute) if the kid is unknown — so a
// key rotation is picked up without re-fetching on every request.
const getSigningKey = async (jwksUri, kid) => {
  let entry = _jwks.get(jwksUri);
  if (!entry || entry.exp <= Date.now()) { await loadJwks(jwksUri); entry = _jwks.get(jwksUri); }
  if (entry && entry.keys.has(kid)) return entry.keys.get(kid);
  if (entry && Date.now() - entry.lastRefresh > 60000) { await loadJwks(jwksUri); entry = _jwks.get(jwksUri); }
  if (entry && entry.keys.has(kid)) return entry.keys.get(kid);
  throw new Error('OIDC signing key not found for token');
};

// ── Authorization request (PKCE) ──────────────────────────────────────────────
// Returns the URL to send the browser to, plus the one-time secrets the caller must stash (signed, httpOnly,
// short-lived) and check on the callback: state (CSRF for the flow), nonce (replay), and the PKCE verifier.
const createAuthRequest = async ({ issuer, clientId, redirectUri, scopes }) => {
  const doc = await discover(issuer);
  const state = b64url(crypto.randomBytes(24));
  const nonce = b64url(crypto.randomBytes(24));
  const codeVerifier = b64url(crypto.randomBytes(32));
  const codeChallenge = b64url(sha256(codeVerifier));
  const params = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
    scope: scopes || 'openid profile email', state, nonce,
    code_challenge: codeChallenge, code_challenge_method: 'S256',
  });
  return { url: `${doc.authorization_endpoint}?${params.toString()}`, state, nonce, codeVerifier };
};

// ── Token exchange + ID-token validation ──────────────────────────────────────
const exchangeCode = async ({ tokenEndpoint, code, codeVerifier, redirectUri, clientId, clientSecret }) => {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: codeVerifier });
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  // Confidential clients authenticate with HTTP Basic (client_secret_basic); public clients send none.
  if (clientSecret) headers.authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64');
  return fetchJson(tokenEndpoint, { method: 'POST', headers, body: body.toString() });
};

// Map a JWA alg to the node:crypto verify parameters. Supports RS256 (RSA PKCS1 v1.5) and ES256 (ECDSA
// P-256 with raw r||s signatures). These cover the overwhelming majority of IdPs; an unsupported alg is
// rejected rather than silently trusted.
const verifyParamsFor = (alg) => {
  if (alg === 'RS256') return { hash: 'sha256', opts: {} };
  if (alg === 'ES256') return { hash: 'sha256', opts: { dsaEncoding: 'ieee-p1363' } };
  throw new Error(`Unsupported OIDC token signing algorithm: ${alg}`);
};

// Verify an ID token end to end: signature against the IdP's JWKS, then issuer, audience, expiry/nbf, and
// nonce. Returns the validated claims, or throws. Fail-closed — any failure is a thrown Error.
const verifyIdToken = async (idToken, { issuer, clientId, nonce, jwksUri }) => {
  if (typeof idToken !== 'string' || idToken.split('.').length !== 3) throw new Error('Malformed ID token');
  const [h, p, s] = idToken.split('.');
  let header, claims;
  try { header = JSON.parse(Buffer.from(h, 'base64url').toString('utf-8')); claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf-8')); }
  catch { throw new Error('ID token is not valid JSON'); }
  // A crafted token segment can parse to null, an array, or a number — reading header.alg/.kid off that would
  // throw a raw TypeError instead of a clean rejection. Require both to be plain objects.
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(header) || !isObj(claims)) throw new Error('ID token header or claims are malformed');

  const { hash, opts } = verifyParamsFor(header.alg);
  if (!header.kid) throw new Error('ID token header has no key id');
  const jwk = await getSigningKey(jwksUri, header.kid);
  let keyObj;
  try { keyObj = crypto.createPublicKey({ key: jwk, format: 'jwk' }); } catch { throw new Error('OIDC signing key is invalid'); }
  const data = Buffer.from(`${h}.${p}`);
  const sig = Buffer.from(s, 'base64url');
  const ok = crypto.verify(hash, data, { key: keyObj, ...opts }, sig);
  if (!ok) throw new Error('ID token signature is invalid');

  // Claim checks.
  if (claims.iss !== issuer) throw new Error('ID token issuer mismatch');
  const aud = claims.aud;
  const audOk = Array.isArray(aud) ? aud.includes(clientId) : aud === clientId;
  if (!audOk) throw new Error('ID token audience mismatch');
  if (Array.isArray(aud) && aud.length > 1 && claims.azp && claims.azp !== clientId) throw new Error('ID token azp mismatch');
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < now) throw new Error('ID token has expired');
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_S > now) throw new Error('ID token not yet valid');
  if (nonce && claims.nonce !== nonce) throw new Error('ID token nonce mismatch');
  if (!claims.sub) throw new Error('ID token has no subject');
  return claims;
};

// Full callback handling: exchange the code, validate the ID token, return the validated claims.
const completeLogin = async (cfg, { code, codeVerifier, nonce, redirectUri }) => {
  const doc = await discover(cfg.issuer);
  const tokens = await exchangeCode({
    tokenEndpoint: doc.token_endpoint, code, codeVerifier, redirectUri,
    clientId: cfg.clientId, clientSecret: cfg.clientSecret,
  });
  if (!tokens || !tokens.id_token) throw new Error('OIDC token response had no id_token');
  return verifyIdToken(tokens.id_token, { issuer: cfg.issuer, clientId: cfg.clientId, nonce, jwksUri: doc.jwks_uri });
};

// Pick a stable subject and the display/username/email from claims, using the configured claim names.
const identityFromClaims = (claims, cfg) => ({
  subject: `${claims.iss}|${claims.sub}`,                      // globally unique, stable across logins
  email: typeof claims[cfg.emailClaim] === 'string' ? claims[cfg.emailClaim] : (typeof claims.email === 'string' ? claims.email : ''),
  emailVerified: claims.email_verified === true,
  username: typeof claims[cfg.usernameClaim] === 'string' ? claims[cfg.usernameClaim] : '',
  // The standard OIDC `name` claim — the human DISPLAY name, often non-Latin. Kept as the provisioned account's
  // display name (normalized by the user store) so a non-Latin-named user keeps their real name even though the
  // username is sanitized to ASCII.
  displayName: typeof claims.name === 'string' ? claims.name : '',
});

module.exports = {
  isSafeIssuer, discover, createAuthRequest, exchangeCode, verifyIdToken, completeLogin, identityFromClaims,
  _caches: { _discovery, _jwks },   // test/maintenance hook
};
