'use strict';
// Scheduled-automations control plane — UI-only (not reachable with an API key, like
// the other /api control routes). Automations belong to the active workspace; the inbox
// is global. Inbox routes are declared before the "/:id" routes so DELETE /inbox isn't
// captured by DELETE /:id.

const express = require('express');
const router = express.Router();
const state = require('../state');
const automations = require('../automations');

// List automations for the active workspace (+ whether the scheduler is available).
router.get('/', (req, res) => {
  try {
    // The evidence snapshot is internal bookkeeping (identities + fingerprints); the control panel only needs
    // the record itself. Omitting it keeps the list payload small and avoids sending values it never renders.
    const list = automations.list(state.workspaceId).map(({ evidenceSnapshot, ...rest }) => rest);
    res.json({ automations: list, cronAvailable: automations.cronAvailable() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', (req, res) => {
  try { res.json(automations.add(state.workspaceId, req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Inbox (global) — declared before /:id ────────────────────────────────────────
router.get('/inbox', (req, res) => {
  try { res.json({ items: automations.inboxList(), unread: automations.inboxUnreadCount() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/inbox/:id/read', (req, res) => {
  try { res.json({ ok: automations.inboxMarkRead(req.params.id) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/inbox', (req, res) => {
  try { res.json({ ok: automations.inboxClear() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Per-automation ───────────────────────────────────────────────────────────────
router.post('/:id/run', async (req, res) => {
  try {
    const r = await automations.runNow(state.workspaceId, req.params.id, { manual: true });
    // The evidence snapshot is internal bookkeeping; the run response only needs the delivery outcome.
    if (r && r.snapshot) delete r.snapshot;
    res.status(r.ok ? 200 : 502).json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch('/:id', (req, res) => {
  try { res.json({ ok: automations.setEnabled(state.workspaceId, req.params.id, req.body && req.body.enabled) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/:id', (req, res) => {
  try { res.json({ ok: automations.remove(state.workspaceId, req.params.id) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
