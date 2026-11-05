'use strict';
// SMTP settings control plane — UI-only (not reachable with an API key). Lets the user
// configure email delivery for scheduled automations from the Settings panel, and send
// a test email, without hand-editing config.json: the password is never sent back to the browser
// (a `passSet` flag stands in), a blank password on save keeps the existing one, and the
// test uses the posted (possibly-unsaved) form values.

const express = require('express');
const router = express.Router();
const mailer = require('../mailer');

// Shared raw-read + atomic-write from lib/config.js, so this route and /api/config use one
// canonical path and one write path (no cwd drift, no divergent atomic-write logic).
const config = require('../config');
const readConfig = config.readRawConfig;

// Current SMTP settings, password masked to a boolean.
router.get('/', (req, res) => {
  const s = readConfig().smtp || {};
  res.json({ smtp: { host: s.host || '', port: s.port || 587, secure: !!s.secure, user: s.user || '', from: s.from || '', passSet: !!s.pass } });
});

// Save SMTP settings. A blank password keeps the stored one (so saving other fields
// can't wipe it); clearing every field removes the SMTP block entirely.
router.post('/', (req, res) => {
  try {
    const { host, port, secure, user, pass, from } = req.body || {};
    const cfg = readConfig();
    const existingPass = cfg.smtp && cfg.smtp.pass || '';
    const anyField = [host, user, pass, from].some(v => (v || '').trim());
    if (!anyField && !existingPass) {
      delete cfg.smtp;
    } else {
      cfg.smtp = {
        host: (host || '').trim(),
        port: parseInt(port, 10) || 587,
        secure: secure === true || secure === 'true',
        user: (user || '').trim(),
        pass: pass ? pass : existingPass,
        from: (from || '').trim() || (user || '').trim(),
      };
    }
    // Atomic write (shared with /api/config) so an interrupted save can't truncate
    // config.json — which would block the next launch now that a broken config refuses to start.
    config.writeConfigAtomic(cfg);
    require('../llm').reloadConfig();   // so mailer's fresh config read sees the change
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Test SMTP with the posted form values (no save required). A blank password falls back
// to the saved one so the user can test without re-typing it. If `to` is supplied, a
// real test email is sent; otherwise the connection + auth are just verified.
router.post('/test', async (req, res) => {
  try {
    const { host, port, secure, user, pass, from, to } = req.body || {};
    const saved = readConfig().smtp || {};
    const effPort = parseInt(port, 10) || saved.port || 587;
    const smtp = {
      host: (host || '').trim() || saved.host,
      port: effPort,
      // When the form omits secure, resolve it exactly as the real send path does
      // (mailer buildTransport: `secure ?? (port === 465)`) rather than coercing to false — otherwise
      // testing a hand-edited port-465 config with no `secure` key connects with secure:false against
      // a TLS-only port and reports a false failure that disagrees with what real sendMail does.
      secure: (secure === undefined ? (saved.secure ?? (effPort === 465)) : (secure === true || secure === 'true')),
      user: (user || '').trim() || saved.user,
      // `saved` is the on-disk config, where smtp.pass is sealed at rest — open it before handing it to the
      // SMTP client, or a test without a re-typed password would authenticate with the sb1: ciphertext and
      // fail. readSecret passes a legacy plaintext password through unchanged.
      pass: pass || require('../secretbox').readSecret(saved.pass, 'smtp.pass', config.SECRET_KEY_SRC) || '',
      from: (from || '').trim() || saved.from || (user || '').trim() || saved.user,
    };
    const result = await mailer.testConnection(smtp, (to || '').trim() || null);
    res.status(result.ok ? 200 : 502).json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
