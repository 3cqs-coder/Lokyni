'use strict';
// API key management — control plane, UI-only.
//
// These routes create/list/revoke API keys. They are NOT part of /api/v1 and are
// NOT reachable with an API key: keys can't mint or revoke other keys. Same-origin
// browser (the Settings UI) only. Mounted at /api/keys.

const { Router } = require('express');
const authmw = require('../authmiddleware');
const router = Router();

// Create/revoke rewrite the shared api-keys.json, so — exactly like the /auth user and membership mutations —
// they run on the single writer: the primary passes, a read replica 409s, so two nodes can't race a whole-file
// rewrite of api-keys.json (the lost-update the other control-plane writers already guard). GET is a safe read.
// (CSRF: like the rest of the /api control plane, these rely on the global same-origin block + SameSite=Lax
// rather than a per-request token; see the note on requireCsrf in authmiddleware.js.)
const primaryOnly = authmw.requirePrimary;

// POST /api/keys  { name, scopes?, allowedWorkspaces? }
// Returns the plaintext key ONCE — it is never retrievable again.
router.post('/', primaryOnly, (req, res) => {
  try {
    const cfg = require('../config');
    const ak  = require('../apikeys');
    const { name, scopes, allowedWorkspaces, rateLimit } = req.body || {};
    const ownerUserId = (req.principal && req.principal.kind === 'user') ? req.principal.userId : null;
    const { record, key } = ak.createKey(cfg.DATA_DIR, { name, scopes, allowedWorkspaces, rateLimit, ownerUserId });
    require('../audit').audit(req, 'apikey.create', record.id, `name="${record.name}" scopes=[${(record.scopes || []).join(',')}]`);
    res.json({ ...record, key });   // `key` shown once; not stored in plaintext
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/keys — list keys (prefixes only, never the secret).
router.get('/', (_req, res) => {
  try {
    const cfg = require('../config');
    const ak  = require('../apikeys');
    res.json({ keys: ak.listKeys(cfg.DATA_DIR) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/keys/:id — revoke.
router.delete('/:id', primaryOnly, (req, res) => {
  try {
    const cfg = require('../config');
    const ak  = require('../apikeys');
    const ok = ak.revokeKey(cfg.DATA_DIR, req.params.id);
    if (!ok) return res.status(404).json({ error: 'No such key' });
    require('../audit').audit(req, 'apikey.revoke', req.params.id, '');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
