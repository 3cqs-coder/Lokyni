'use strict';
// Connectors control plane — UI-only (not reachable with an API key, like the other
// control routes). Manage MCP ingestion connectors for the active workspace and
// trigger syncs.

const express = require('express');
const router = express.Router();
const cfg = require('../config');
const state = require('../state');
const connectors = require('../mcp/connectors');

// Serialize syncs: each spawns an MCP server and indexes, so running several at
// once would hammer the machine. concurrency 1 runs them one at a time; the HTTP
// call still returns when its own sync finishes.
const syncQueue = require('../queue').create({ concurrency: 1 });

// Never send a stored secret (e.g. a GitHub token) back to the browser — replace it
// with a boolean flag, exactly as the settings panel does for provider API keys. The
// token stays on disk in the workspace settings; the UI only needs to know it's set.
const redactConnector = (c) => {
  if (!c.config || c.config.token === undefined) return c;
  const { token, ...rest } = c.config;
  return { ...c, config: { ...rest, hasToken: !!token } };
};

// List connectors for the active workspace.
router.get('/', (req, res) => {
  try {
    const list = connectors.listConnectors(cfg.DATA_DIR, state.workspaceId).map(redactConnector);
    res.json({ connectors: list, types: connectors.CONNECTOR_TYPES });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add a connector: { type, name, config }.
router.post('/', (req, res) => {
  try {
    const { type, name, config } = req.body || {};
    const record = connectors.addConnector(cfg.DATA_DIR, state.workspaceId, { type, name, config });
    require('../audit').audit(req, 'connector.add', state.workspaceId, `type=${type} name="${name || ''}"`);
    // Redact the token on the way back too (the UI only needs to know it's set), matching the GET list —
    // so the secret is never echoed into a response or any response logging.
    res.json(redactConnector(record));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Remove a connector. ?deleteDocs=true also removes the ingested copies (never the
// source folder).
router.delete('/:id', async (req, res) => {
  try {
    const deleteDocs = req.query.deleteDocs === 'true';
    const ok = await connectors.removeConnector(cfg.DATA_DIR, state.workspaceId, req.params.id, deleteDocs);
    require('../audit').audit(req, 'connector.remove', req.params.id, `deleteDocs=${deleteDocs}`);
    res.json({ ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Sync a connector now (spawns its MCP server, pulls docs, indexes). Can be slow.
router.post('/:id/sync', async (req, res) => {
  try {
    const result = await syncQueue.enqueue(
      () => connectors.syncConnector(cfg.DATA_DIR, state.workspaceId, req.params.id),
      `sync:${state.workspaceId}:${req.params.id}`
    );
    require('../audit').audit(req, 'connector.sync', req.params.id, result && result.ok ? `synced ${result.count ?? '?'} docs` : `failed: ${(result && result.error) || 'unknown'}`);
    res.status(result.ok ? 200 : 502).json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Test a connector (connect + list tools, no sync). Verifies it works.
router.post('/:id/test', async (req, res) => {
  try {
    const result = await connectors.testConnector(cfg.DATA_DIR, state.workspaceId, req.params.id);
    res.status(result.ok ? 200 : 502).json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
