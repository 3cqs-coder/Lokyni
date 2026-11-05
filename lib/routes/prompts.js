'use strict';
// Prompt-template control plane — UI-only (not reachable with an API key, like the
// other /api control routes). Manages the global prompt/template library.

const express = require('express');
const router = express.Router();
const prompts = require('../prompts');
const authmw = require('../authmiddleware');

// The template library is shared install-wide, so listing is open to any signed-in user (they insert
// templates into the composer), but mutating it is an admin action and, on a cluster, a write that must go to
// the primary — matching the other shared-config control planes.
const adminWrite = [authmw.requireGlobalAdmin, authmw.requirePrimary];

router.get('/', (req, res) => {
  try { res.json({ templates: prompts.list() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', adminWrite, (req, res) => {
  try { res.json(prompts.add(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Re-add any deleted built-in starters (does not duplicate existing ones). Lets an operator recover the
// defaults without re-typing them.
router.post('/restore-builtins', adminWrite, (req, res) => {
  try { res.json(prompts.restoreBuiltins()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', adminWrite, (req, res) => {
  try { res.json(prompts.update(req.params.id, req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/:id', adminWrite, (req, res) => {
  try { res.json({ ok: prompts.remove(req.params.id) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
