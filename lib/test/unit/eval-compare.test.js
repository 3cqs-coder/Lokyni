'use strict';
// Guards the evaluation run archive and the A/B comparison built on it. Runs used to be a single
// `eval-run.json`, so only "now vs. the previous run" was possible. The archive keeps a bounded set of full
// runs, and the comparison must match questions by their stable id, honor the metric direction, format the
// setup snapshot, and never throw on a missing or corrupt file. Uses a temp cache dir; no model or network.
// Run: `npm run test:unit`.

const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };
const near = (a, b, m) => { checks++; assert.ok(Math.abs(a - b) < 1e-9, m); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-evalcmp-'));
const archivePath = path.join(tmp, 'eval-runs.json');
const legacyPath = path.join(tmp, 'eval-run.json');
const writeArchive = (runs) => fs.writeFileSync(archivePath, JSON.stringify(runs));

const metricsFor = (faithfulness, answerRelevancy = 0.6) => ({
  faithfulness, answerRelevancy, contextPrecision: 0.7, citationAttribution: 0.8,
});

const mkRun = (id, at, over = {}) => ({
  id,
  at,
  questionCount: 2,
  averages: metricsFor(0.5),
  delta: {},
  pipeline: { answer: 1, indexFormat: 2 },
  setup: {
    provider: 'Ollama', model: 'model-a',
    embeddingsProvider: 'Ollama', embeddingsModel: 'embed-a',
    reranker: true, queryRewrite: false,
  },
  questions: [
    { id: 'q1', text: 'Alpha question?', metrics: metricsFor(0.5), status: null, outOfScope: false },
    { id: 'q2', text: 'Beta question?', metrics: metricsFor(0.5), status: null, outOfScope: false },
  ],
  ...over,
});

(async () => {
try {
  const evalx = require(path.join(PROJECT, 'lib', 'eval'));
  const wsm = require(path.join(PROJECT, 'lib', 'workspaces'));
  const m = require(path.join(PROJECT, 'lib', 'evalmetrics'));
  const origCacheDir = wsm.cacheDirFor, origEnsure = wsm.ensureWorkspace;
  wsm.cacheDirFor = () => tmp;
  wsm.ensureWorkspace = () => {};
  try {
    // ── Archive reads: newest first, summaries stay small, full runs remain addressable ──
    const a = mkRun('r_a', 1000);
    const b = mkRun('r_b', 2000, {
      questionCount: 2,
      averages: metricsFor(0.7, 0.4),
      pipeline: { answer: 2, indexFormat: 2 },
      setup: {
        provider: 'Ollama', model: 'model-b',
        embeddingsProvider: 'Ollama', embeddingsModel: 'embed-a',
        reranker: false, queryRewrite: true,
      },
      questions: [
        { id: 'q1', text: 'Alpha question?', metrics: metricsFor(0.7, 0.4), status: null, outOfScope: false },
        { id: 'q3', text: 'Gamma question?', metrics: metricsFor(0.7, 0.4), status: null, outOfScope: false },
      ],
    });
    writeArchive([a, b]);   // deliberately oldest-first: the reader must order it

    const summaries = await evalx.getRuns('ws');
    eq(summaries.map((r) => r.id), ['r_b', 'r_a'], 'the run list is newest-first');
    ok(summaries.every((r) => !('questions' in r)), 'summaries omit the per-question payload');
    eq((await evalx.getRun('ws', 'r_a')).at, 1000, 'a full run is addressable by id');
    eq((await evalx.getLastRun('ws')).id, 'r_b', 'the last run is the newest archived run');

    const dash = await evalx.getDashboard('ws');
    eq(dash.lastRun.id, 'r_b', 'the dashboard last run is the newest full run');
    eq(dash.runs.length, 2, 'the dashboard lists both runs for the A/B picker');
    ok(Array.isArray(dash.history), 'the dashboard includes the trend history');

    // ── A/B: per-metric deltas, direction, and a tie floor ──
    const cmp = await evalx.compareRuns('ws', 'r_a', 'r_b');
    eq(cmp.status, 'ok', 'comparing two archived runs succeeds');
    const row = (key) => cmp.metrics.find((r) => r.key === key);
    near(row('faithfulness').delta, 0.2, 'faithfulness reports B − A');
    eq(row('faithfulness').winner, 'b', 'a higher faithfulness marks B as better');
    near(row('answerRelevancy').delta, -0.2, 'answer relevancy reports B − A');
    eq(row('answerRelevancy').winner, 'a', 'a lower answer relevancy marks A as better');
    eq(row('contextPrecision').winner, null, 'an unchanged metric has no winner');
    eq(row('faithfulness').label, m.METRIC_LABELS.faithfulness, 'the row carries the shared display label');
    eq(row('faithfulness').higherIsBetter, true, 'the row carries the direction from the catalog');
    eq(cmp.pipelineChanged, true, 'different answer pipelines are flagged');

    // ── Setup differences are formatted for display from one field list ──
    const setupRow = (label) => cmp.setup.find((s) => s.label === label);
    eq(setupRow('Chat model'), { label: 'Chat model', a: 'model-a', b: 'model-b', different: true },
      'a changed chat model is reported with both values');
    eq(setupRow('Reranker'), { label: 'Reranker', a: 'On', b: 'Off', different: true },
      'booleans read as On/Off, not raw JSON');
    eq(setupRow('Query rewrite'), { label: 'Query rewrite', a: 'Off', b: 'On', different: true },
      'the second boolean field is formatted too');
    eq(setupRow('Provider').different, false, 'unchanged setup rows are kept but marked the same');
    eq(setupRow('Embeddings model').different, false, 'the embeddings model is compared separately');

    // ── Questions match by stable id; additions and removals are visible, not dropped ──
    const byQ = (id) => cmp.questions.find((q) => q.id === id);
    ok(byQ('q1').a && byQ('q1').b, 'a question present in both runs has both sides');
    eq(byQ('q1').metrics.find((r) => r.key === 'faithfulness').winner, 'b', 'per-question direction matches the run');
    ok(byQ('q2').a && byQ('q2').b === null, 'a question only in A is present with an empty B side');
    ok(byQ('q3').a === null && byQ('q3').b, 'a question only in B is present with an empty A side');
    eq(byQ('q3').text, 'Gamma question?', 'a one-sided question keeps its text');

    // ── Unknown ids and a corrupt archive fail safe ──
    eq((await evalx.compareRuns('ws', 'r_a', 'not-a-run')).status, 'missing', 'an unknown B id is reported as missing');

    // A parseable archive with a malformed question list must not throw; it simply has no questions to show.
    writeArchive([{ ...a, questions: {} }, { ...b, questions: 'nope' }]);
    const malformed = await evalx.compareRuns('ws', 'r_a', 'r_b');
    eq(malformed.status, 'ok', 'a malformed question list does not fail the comparison');
    eq(malformed.questions, [], 'a malformed question list contributes no rows');

    fs.writeFileSync(archivePath, 'not json');
    eq(await evalx.getRuns('ws'), [], 'a corrupt archive reads as empty, never throws');

    // An oversized archive is rejected before parsing, so a hand-edited or corrupt file cannot stall the
    // request or allocate an unbounded string.
    fs.writeFileSync(archivePath, '');
    fs.truncateSync(archivePath, 17 * 1024 * 1024);
    eq(await evalx.getRuns('ws'), [], 'an oversized archive is ignored instead of parsed');
    eq((await evalx.compareRuns('ws', 'r_a', 'r_b')).status, 'missing', 'a corrupt archive cannot produce a comparison');

    // ── A legacy single-run file is still readable, with a stable derived id ──
    fs.writeFileSync(legacyPath, JSON.stringify({ ...a, id: undefined }));
    const legacy = await evalx.getRuns('ws');
    eq(legacy.length, 1, 'the pre-archive last run is exposed as a one-entry archive');
    eq(legacy[0].id, 'r_at_1000', 'a legacy run gets a deterministic id derived from its timestamp');
    eq((await evalx.getRun('ws', 'r_at_1000')).at, 1000, 'that derived id resolves in getRun');
    fs.unlinkSync(legacyPath);

    // ── The archive is bounded to the newest MAX_RUNS ──
    const many = [];
    for (let i = 0; i < evalx.MAX_RUNS + 5; i++) many.push(mkRun(`r_${i}`, 1000 + i));
    writeArchive(many);
    const capped = await evalx.getRuns('ws');
    eq(capped.length, evalx.MAX_RUNS, `the archive keeps at most MAX_RUNS (${evalx.MAX_RUNS})`);
    eq(capped[0].id, `r_${evalx.MAX_RUNS + 4}`, 'the cap keeps the newest runs');
    eq(capped[capped.length - 1].id, 'r_5', 'the cap drops the oldest runs');

    // ── Pure comparison math ──
    const tie = m.compareAverages({ faithfulness: 0.5 }, { faithfulness: 0.502 });
    eq(tie[0].winner, null, 'a change under the tie floor is not presented as a win');
    const nulls = m.compareAverages({ faithfulness: 0.5 }, {});
    eq(nulls[0].delta, null, 'a metric missing from one side has no delta');
    eq(nulls[0].winner, null, 'a metric missing from one side has no winner');
    eq(m.METRIC_KEYS.every((k) => typeof m.METRIC_HIGHER_IS_BETTER[k] === 'boolean'), true,
      'every metric states its direction explicitly');
  } finally {
    wsm.cacheDirFor = origCacheDir;
    wsm.ensureWorkspace = origEnsure;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  // ── Source guards: bounded, atomic, one catalog, and wired end to end ──
  const evalSrc = read('lib/eval.js');
  ok(/const MAX_RUNS = 10;/.test(evalSrc), 'the full-run archive is bounded');
  ok(/\.slice\(0, MAX_RUNS\)/.test(evalSrc), 'the archive trims to the newest runs');
  ok(/writeFileAtomicAsync\(runPath\(workspaceId\)/.test(evalSrc), 'the archive is written atomically and non-blocking');
  ok(/appendRun\(workspaceId, run\)/.test(evalSrc), 'every completed run is archived');
  ok(/getDashboard/.test(evalSrc) && /compareRuns/.test(evalSrc), 'the dashboard and compare readers are exported');

  const route = read('lib/routes/eval.js');
  ok(/runs: dash\.runs/.test(route), 'GET /api/eval returns the run list');
  ok(/router\.get\('\/compare'/.test(route), 'the compare endpoint exists');
  ok(/String\(req\.query\.a \|\| ''\)\.slice\(0, 80\)/.test(route), 'run ids are length-bounded before lookup');
  ok(/result\.runs = await evalx\.getRuns/.test(route), 'a run response refreshes the A/B picker');

  const chat = read('lib/public/js/chat.js');
  ok(/function renderEvalCompare\(runs\)/.test(chat), 'the client renders the A/B picker');
  ok(/function renderEvalCompareResult\(out, data\)/.test(chat), 'the client renders the comparison result');
  ok(/m\.label/.test(chat) && !/\['faithfulness', 'Faithfulness'\]/.test(chat),
    'the A/B view takes labels from the server catalog');
  ok(/eval-compare-table/.test(read('lib/public/css/app.css')), 'the comparison table has responsive styles');

  const guide = read('docs/README.md');
  ok(/Compare runs/.test(guide), 'the guide documents the A/B comparison');
  ok(/last 10 full\s+runs/.test(guide), 'the guide states how many full runs are kept');
  ok(/reuses the existing keyword index/.test(guide), 'the guide explains the BM25 reuse during consolidation');

  console.log(`\nALL EVAL-COMPARE UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ EVAL-COMPARE UNIT TEST FAILED:', e && e.message);
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
}
})();
