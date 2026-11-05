'use strict';
// RAG quality-evaluation control plane — UI-only (not reachable with an API key, like the other /api
// control routes). Saved questions belong to the active workspace; a run scores them with the local,
// reference-free metrics and returns the averages, a per-question breakdown, and the change since the
// previous run. Running is on-demand only — never on the answer path.

const express = require('express');
const router = express.Router();
const state = require('../state');
const evalx = require('../eval');
const { METRIC_KEYS, METRIC_LABELS, METRIC_HIGHER_IS_BETTER } = require('../evalmetrics');
const metricCatalog = () => METRIC_KEYS.map((key) => ({
  key,
  label: METRIC_LABELS[key],
  higherIsBetter: METRIC_HIGHER_IS_BETTER[key] !== false,
}));

// The saved questions plus the most recent run (so the UI can show last results without re-running) and the
// bounded run archive the A/B view selects from. One archive read supplies both.
router.get('/', async (req, res) => {
  try {
    const dash = await evalx.getDashboard(state.workspaceId);
    res.json({
      questions: evalx.listQuestions(state.workspaceId),
      lastRun: dash.lastRun,
      runs: dash.runs,
      history: dash.history,
      maxQuestions: evalx.MAX_QUESTIONS,
      // The metric catalog the dashboard renders (key + display label), from the one metric module.
      metrics: metricCatalog(),
      // The pipeline the NEXT run would use, so the dashboard can tell whether the last run is comparable.
      pipeline: {
        answer: require('../constants').ANSWER_PIPELINE_VERSION,
        indexFormat: require('../constants').INDEX_FORMAT_VERSION,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Compare two recorded runs. Ids come from the workspace's own archive and are only looked up, never used as
// paths; an unknown id is a 404 rather than an error. Read-only, so a GET is safe to retry.
router.get('/compare', async (req, res) => {
  const a = String(req.query.a || '').slice(0, 80);
  const b = String(req.query.b || '').slice(0, 80);
  if (!a || !b) return res.status(400).json({ error: 'Two run ids are required.' });
  try {
    const result = await evalx.compareRuns(state.workspaceId, a, b);
    if (!result || result.status !== 'ok') return res.status(404).json({ error: 'That run is no longer available.' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', (req, res) => {
  try {
    const r = evalx.addQuestion(state.workspaceId, (req.body && req.body.text) || '');
    if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/:id', (req, res) => {
  try { res.json(evalx.removeQuestion(state.workspaceId, req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Seed the question set from the workspace's own documents (so the panel isn't an empty box). On-demand
// only; bounded and best-effort. Returns the updated question list (and how many were added).
router.post('/seed', async (req, res) => {
  try { res.json(await evalx.seedQuestions(state.workspaceId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Run the evaluation. Bounded work but potentially slow (one grounded answer plus metric calls per
// question), so it is only ever triggered explicitly here.
router.post('/run', async (req, res) => {
  try {
    const result = await evalx.runEval(state.workspaceId);
    // Include the updated trend log so the dashboard can redraw the history without a second request.
    if (result && result.status === 'ok') {
      result.history = await evalx.getHistory(state.workspaceId);
      result.runs = await evalx.getRuns(state.workspaceId);
      result.metrics = metricCatalog();
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
