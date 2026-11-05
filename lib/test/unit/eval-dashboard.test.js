'use strict';
// Eval dashboard: the standing quality TREND. The existing on-demand eval already computes the three
// reference-free RAGAS-style metrics (faithfulness, answer relevancy, context precision) plus a delta vs the
// previous run; the dashboard adds a bounded run-history log so quality can be charted over time. This tests
// that history is appended, ordered oldest-first, and capped, and guards the route + UI (sparkline) wiring.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(PROJECT, ...p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

(async () => {
try {
  const evalx = require(path.join(PROJECT, 'lib', 'eval'));
  const wsm = require(path.join(PROJECT, 'lib', 'workspaces'));

  // Point the history file at a throwaway dir by stubbing the workspace cache-dir resolver (eval.js captured
  // the wsm module object, so overriding its methods redirects the read/write without touching real data).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-evalhist-'));
  const origCacheDir = wsm.cacheDirFor, origEnsure = wsm.ensureWorkspace;
  wsm.cacheDirFor = () => tmp;
  wsm.ensureWorkspace = () => {};
  try {
    ok((await evalx.getHistory('ws')).length === 0, 'history starts empty');

    // Append 55 runs through the real appendHistory and confirm the cap + ordering + shape (now async).
    const mkRun = (t, f) => ({ at: t, questionCount: 2, averages: { faithfulness: f, answerRelevancy: f, contextPrecision: f } });
    for (let i = 0; i < 55; i++) await evalx.appendHistory('ws', mkRun(1000 + i, i / 100));
    const hist = await evalx.getHistory('ws');
    ok(hist.length === evalx.MAX_HISTORY, `history is capped to MAX_HISTORY (${evalx.MAX_HISTORY}, got ${hist.length})`);
    ok(hist[0].at === 1005 && hist[hist.length - 1].at === 1054, 'the cap keeps the MOST RECENT runs, oldest-first');
    ok(typeof hist[0].averages.faithfulness === 'number', 'each entry carries the three metric averages');

    // A corrupt history file must never throw — the dashboard just shows nothing.
    fs.writeFileSync(path.join(tmp, 'eval-history.json'), 'not json');
    ok((await evalx.getHistory('ws')).length === 0, 'a corrupt history file reads as empty, never throws');
  } finally {
    wsm.cacheDirFor = origCacheDir; wsm.ensureWorkspace = origEnsure;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  // ── source-guard: history is bounded + appended on every run; route + UI expose it ──
  const evalSrc = read('lib', 'eval.js');
  ok(/const MAX_HISTORY = 50;/.test(evalSrc), 'the run history is capped (MAX_HISTORY)');
  ok(/const trimmed = hist\.slice\(-MAX_HISTORY\);/.test(evalSrc), 'history is trimmed to the most recent MAX_HISTORY entries');
  ok(/appendHistory\(workspaceId, run\);/.test(evalSrc), 'every completed run appends to the trend log');
  ok(/module\.exports = \{[^}]*getHistory/.test(evalSrc), 'eval exports getHistory');
  ok(/writeFileAtomicAsync\(historyPath\(workspaceId\)/.test(evalSrc), 'history is written atomically and non-blocking');

  const route = read('lib', 'routes', 'eval.js');
  ok(/history: dash\.history/.test(route), 'GET /api/eval returns the trend history');
  ok(/result\.history = await evalx\.getHistory\(state\.workspaceId\)/.test(route), 'a run response includes the updated history');

  const chat = read('lib', 'public', 'js', 'chat.js');
  ok(/function renderEvalTrend\(history\)/.test(chat), 'the client renders a trend view');
  ok(/if \(runs\.length < 2\) \{ box\.innerHTML = ''; return; \}/.test(chat), 'the trend needs at least two runs to draw');
  ok(/<polyline points="\$\{coords\}"/.test(chat), 'the trend draws a per-metric sparkline (inline SVG, no library)');
  ok(/renderEvalTrend\(data\.history \|\| \[\]\)/.test(chat), 'the trend is refreshed on load and after a run');

  // ── drift guard: one metric catalog drives the run, the endpoint, the dashboard, and the CLI ──
  const m = require(path.join(PROJECT, 'lib', 'evalmetrics'));
  ok(Array.isArray(m.METRIC_KEYS) && m.METRIC_KEYS.length === 4, 'the metric module defines the four metrics once');
  ok(m.METRIC_KEYS.every((k) => typeof m.METRIC_LABELS[k] === 'string' && m.METRIC_LABELS[k].length > 0),
    'every metric has a display label in the same module');
  const evalBody = read('lib', 'eval.js');
  const serverKeys = (evalBody.match(/entry\.metrics = \{([^}]*)\}/) || [])[1] || '';
  const serverMetricKeys = (serverKeys.match(/\b(faithfulness|answerRelevancy|contextPrecision|citationAttribution)\b/g) || []);
  ok(serverMetricKeys.length === 4 && m.METRIC_KEYS.slice().sort().join(',') === serverMetricKeys.slice().sort().join(','),
    'the run writes exactly the metric catalog keys');
  const routeSrc = read('lib', 'routes', 'eval.js');
  ok(/const metricCatalog = \(\) => METRIC_KEYS\.map/.test(routeSrc) && /metrics: metricCatalog\(\)/.test(routeSrc),
    'the eval endpoint returns the catalog (key + label) to the UI from one helper');
  ok(/let EVAL_METRICS = \[\];/.test(chat) && /EVAL_METRICS = data\.metrics\.map/.test(chat),
    'the dashboard populates its metrics from the server catalog');
  ok(!/\['faithfulness', 'Faithfulness'\]/.test(chat), 'the client keeps no second metric list');
  ok(/METRIC_LABELS: LABELS/.test(read('lokyni.js')), 'the CLI uses the same labels');
  // The guide's metric bullets must cover every metric, so adding one cannot leave the docs behind.
  const guide = read('docs', 'README.md');
  for (const key of m.METRIC_KEYS) {
    ok(new RegExp(`- \\*\\*${m.METRIC_LABELS[key].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*\\*`).test(guide),
      `the guide documents the ${key} metric`);
  }

  console.log(`\nALL EVAL-DASHBOARD UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ EVAL-DASHBOARD UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
})();
