'use strict';
// Single sign-on (OIDC) settings control plane — UI-only (admin, primary). Lets an administrator configure
// SSO from the Settings panel instead of hand-editing config.json. The client secret is never sent back to
// the browser (a `secretSet` flag stands in), and a blank secret on save keeps the stored one. A "test"
// checks that the provider's discovery document is reachable, using the posted (possibly-unsaved) values.
//
// Writes go through the same atomic config write + hot reload as the other settings, so a change takes effect
// without a restart and an interrupted save can't truncate config.json.

const express = require('express');
const router = express.Router();
const config = require('../config');
const oidc = require('../oidc');
const readConfig = config.readRawConfig;

const ROLES = ['member', 'admin'];
const clamp = (v, max) => String(v == null ? '' : v).slice(0, max);

// Current OIDC settings, secret masked to a boolean.
router.get('/', (_req, res) => {
  const o = readConfig().oidc || {};
  res.json({
    oidc: {
      enabled: o.enabled === true,
      issuer: o.issuer || '',
      clientId: o.clientId || '',
      scopes: o.scopes || 'openid profile email',
      buttonLabel: o.buttonLabel || 'Sign in with SSO',
      redirectUri: o.redirectUri || '',
      autoCreateUsers: o.autoCreateUsers !== false,
      linkByEmail: o.linkByEmail !== false,
      defaultRole: ROLES.includes(o.defaultRole) ? o.defaultRole : 'member',
      usernameClaim: o.usernameClaim || 'preferred_username',
      emailClaim: o.emailClaim || 'email',
      secretSet: !!o.clientSecret,
    },
  });
});

// Save OIDC settings. A blank client secret keeps the stored one (so saving other fields can't wipe it).
// When SSO is enabled, the issuer + client id are required and the issuer must be a safe (https, or loopback
// http for dev) URL.
router.post('/', (req, res) => {
  try {
    const b = req.body || {};
    const enabled = b.enabled === true || b.enabled === 'true';
    const issuer = clamp(b.issuer, 500).trim().replace(/\/+$/, '');
    const clientId = clamp(b.clientId, 300).trim();
    if (enabled) {
      if (!issuer || !clientId) return res.status(400).json({ error: 'An issuer URL and client ID are required to enable SSO.' });
      if (!oidc.isSafeIssuer(issuer)) return res.status(400).json({ error: 'The issuer must be an https URL (or an http://localhost URL for development).' });
    }
    const cfg = readConfig();
    const prev = (cfg.oidc && typeof cfg.oidc === 'object') ? cfg.oidc : {};
    const secretIn = typeof b.clientSecret === 'string' ? b.clientSecret : '';
    cfg.oidc = {
      enabled,
      issuer,
      clientId,
      clientSecret: secretIn ? secretIn : (prev.clientSecret || ''),
      scopes: clamp(b.scopes, 200).trim() || 'openid profile email',
      buttonLabel: clamp(b.buttonLabel, 40).trim() || 'Sign in with SSO',
      redirectUri: clamp(b.redirectUri, 500).trim(),
      autoCreateUsers: !(b.autoCreateUsers === false || b.autoCreateUsers === 'false'),
      linkByEmail: !(b.linkByEmail === false || b.linkByEmail === 'false'),
      defaultRole: ROLES.includes(b.defaultRole) ? b.defaultRole : 'member',
      usernameClaim: clamp(b.usernameClaim, 64).trim() || 'preferred_username',
      emailClaim: clamp(b.emailClaim, 64).trim() || 'email',
    };
    config.writeConfigAtomic(cfg);
    require('../llm').reloadConfig();   // so the next sign-in sees the change (no restart)
    require('../audit').audit(req, 'sso.config', enabled ? 'enabled' : 'disabled', issuer ? `issuer=${issuer}` : '');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Test reachability: fetch the provider's discovery document for the posted (or saved) issuer. Confirms the
// URL is right and the provider is reachable before the operator relies on it. Never saves.
router.post('/test', async (req, res) => {
  try {
    const saved = readConfig().oidc || {};
    const issuer = (clamp(req.body && req.body.issuer, 500).trim() || saved.issuer || '').replace(/\/+$/, '');
    if (!issuer) return res.status(400).json({ ok: false, error: 'Enter an issuer URL first.' });
    if (!oidc.isSafeIssuer(issuer)) return res.status(400).json({ ok: false, error: 'The issuer must be an https URL (or an http://localhost URL for development).' });
    const doc = await oidc.discover(issuer);
    res.json({ ok: true, authorizationEndpoint: doc.authorization_endpoint, tokenEndpoint: doc.token_endpoint });
  } catch (e) {
    // Turn a low-level network error into a clear, actionable message for the admin.
    const msg = /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timeout|aborted|getaddrinfo/i.test(e && e.message || '')
      ? 'Could not reach the identity provider — check the issuer URL and that it is reachable from the server.'
      : (e && e.message) || 'Could not reach the identity provider.';
    res.status(502).json({ ok: false, error: msg });
  }
});

module.exports = router;
