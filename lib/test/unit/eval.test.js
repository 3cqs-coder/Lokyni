'use strict';
// Guards the reference-free evaluation engine: the pure metric math (faithfulness-from-counts, cosine,
// averaging, and the run-to-run delta) computed directly, plus the saved-question store's validation and
// the wiring that keeps the feature local, on-demand, and off any hot path. The model-backed metric
// functions are best-effort (null on failure) and are exercised only through their pure parts here. Uses
// an isolated temp data dir. No model or network. Run: `npm run test:unit`.

const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const m = require(path.join(PROJECT, 'lib', 'evalmetrics'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-eval-')));
process.chdir(tmp);
const evalx = require(path.join(PROJECT, 'lib', 'eval'));
const cleanup = (code) => { try { process.chdir(os.tmpdir()); fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(code); };

(async () => {
try {
  // ── faithfulnessFromCounts: supported + half partial, over graded claims ──
  ok(approx(m.faithfulnessFromCounts({ supported: 4, partial: 0, unsupported: 0 }), 1), 'all supported → 1.0');
  ok(approx(m.faithfulnessFromCounts({ supported: 3, partial: 2, unsupported: 5 }), (3 + 1) / 10), 'partial counts half');
  ok(m.faithfulnessFromCounts({ supported: 0, partial: 0, unsupported: 0 }) === null, 'no graded claims → n/a');
  ok(m.faithfulnessFromCounts(null) === null, 'missing counts → n/a');

  // ── cosine: identical, orthogonal, floored, guarded ──
  ok(approx(m.cosine([1, 2, 3], [1, 2, 3]), 1), 'identical vectors → 1.0');
  ok(approx(m.cosine([1, 0], [0, 1]), 0), 'orthogonal → 0');
  ok(m.cosine([1, 0], [-1, 0]) === 0, 'opposite vectors floor at 0 (no negative relevancy)');
  ok(m.cosine([1, 2], [1, 2, 3]) === null && m.cosine([], []) === null, 'mismatched/empty → null');

  // ── aggregate: averages non-null values per metric; omits all-n/a metrics ──
  const per = [
    { metrics: { faithfulness: 1.0, answerRelevancy: 0.8, contextPrecision: null } },
    { metrics: { faithfulness: 0.5, answerRelevancy: 0.6, contextPrecision: null } },
    { metrics: { faithfulness: null, answerRelevancy: 1.0, contextPrecision: null } },
  ];
  const avg = m.aggregate(per);
  ok(approx(avg.faithfulness, 0.75), 'faithfulness averages only the graded questions');
  ok(approx(avg.answerRelevancy, 0.8), 'answer relevancy averages all three');
  ok(!('contextPrecision' in avg), 'a metric that was n/a everywhere is omitted');

  // ── deltaVs: current − previous, only for metrics present in both; empty on first run ──
  const d = m.deltaVs({ faithfulness: 0.5, answerRelevancy: 0.9 }, { faithfulness: 0.75, answerRelevancy: 0.8, contextPrecision: 0.6 });
  ok(approx(d.faithfulness, 0.25) && approx(d.answerRelevancy, -0.1), 'delta is current minus previous');
  ok(!('contextPrecision' in d), 'a metric absent from the previous run has no delta');
  ok(Object.keys(m.deltaVs(null, { faithfulness: 0.5 })).length === 0, 'no previous run → empty delta');

  // ── Saved-question store: validation, cap, dedup, add/remove round-trip ──
  const ws = 'default';
  ok(evalx.addQuestion(ws, 'ab').ok === false, 'a too-short question is rejected');
  const a1 = evalx.addQuestion(ws, 'What are the payment terms?');
  ok(a1.ok && a1.question && a1.question.id, 'a valid question is added and gets an id');
  ok(evalx.addQuestion(ws, 'What are the payment terms?').ok === false, 'a duplicate question is rejected');
  ok(evalx.listQuestions(ws).length === 1, 'the saved question round-trips');
  evalx.removeQuestion(ws, a1.question.id);
  ok(evalx.listQuestions(ws).length === 0, 'a removed question is gone');
  ok((await evalx.getLastRun(ws)) === null, 'no run yet → null');

  // ── Wiring guards: UI-only route, on-demand run, not on any hot path ──
  const route = fs.readFileSync(path.join(PROJECT, 'lib', 'routes', 'eval.js'), 'utf-8');
  ok(/router\.post\('\/run'/.test(route) && /runEval\(state\.workspaceId\)/.test(route), 'the route runs an evaluation only on explicit POST /run');
  const server = fs.readFileSync(path.join(PROJECT, 'lib', 'server.js'), 'utf-8');
  ok(/app\.use\('\/api\/eval',[^)]*evalRouter\)/.test(server), 'the eval control-plane route is mounted (admin-gated)');
  const engine = fs.readFileSync(path.join(PROJECT, 'lib', 'eval.js'), 'utf-8');
  ok(/never on the answer hot path|on-demand/i.test(engine), 'the engine documents that it is on-demand, off the hot path');

  // ── Language-agnostic guard: the context-precision judge must use a BOOLEAN via structured output, not an
  //    English "yes"/"no" string parse (which went n/a on a non-English corpus). Multilingual-safe + reuse. ──
  const metricsSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'evalmetrics.js'), 'utf-8');
  ok(/completeJson\(/.test(metricsSrc) && /typeof obj\.relevant === 'boolean'/.test(metricsSrc),
    'contextPrecision judges with a language-agnostic boolean via completeJson (structured output)');
  ok(!/\/\\byes\\b\/i|Answer yes or no/.test(metricsSrc),
    'the brittle English yes/no string judge is gone (no regression to an English-only parse)');

  // ── Empty-state auto-seed: proposes questions FROM the corpus, language-agnostic, bounded, reusing helpers ──
  ok(/module\.exports = \{[^}]*seedQuestions/.test(engine), 'eval exports seedQuestions');
  ok(/collectContentEntries\(acq\.idx/.test(engine) && /require\('\.\/api-core'\)/.test(engine),
    'seed reuses the synthesis content collector (license/noise files excluded), not a bespoke corpus walk');
  ok(/completeJson\(/.test(engine) && /SAME LANGUAGE as the documents/i.test(engine),
    "seed asks for questions in the documents' own language (language-agnostic)");
  ok(/const SEED_CONTEXT_CHARS = \d+;/.test(engine) && /const SEED_MAX_QUESTIONS = \d+;/.test(engine),
    'seed is bounded (context + question caps) so it stays OOM-safe');
  ok(/addQuestion\(workspaceId, q\.trim\(\)\.slice\(0, 2000\)\)/.test(engine),
    'seed adds through addQuestion, reusing its validation + dedup + cap (no drift)');
  // ── Unify: runEval and seed share ONE bundle-acquisition helper, so warming/empty handling can't drift ──
  ok(/const acquireBundle = async/.test(engine) && (engine.match(/acquireBundle\(workspaceId\)/g) || []).length >= 2,
    'runEval and seed share one acquireBundle helper (unified warming/empty handling)');
  ok(/router\.post\('\/seed'/.test(route) && /seedQuestions\(state\.workspaceId\)/.test(route), 'POST /api/eval/seed is wired');

  // ── Headless CLI eval: node lokyni.js --eval [workspace], reusing the SAME runEval, documented in help ──
  const lok = fs.readFileSync(path.join(PROJECT, 'lokyni.js'), 'utf-8');
  ok(/if \(has\('--eval'\)\) \{ await runEvalCli\(\); return; \}/.test(lok), 'lokyni.js dispatches a headless --eval run');
  ok(/const runEvalCli = async/.test(lok) && /evalx\.runEval\(ws\)/.test(lok), 'runEvalCli reuses the same runEval as the dashboard (no second engine)');
  const help = fs.readFileSync(path.join(PROJECT, 'lib', 'cli', 'help.txt'), 'utf-8');
  ok(/--eval \[workspace\]/.test(help), 'the --eval command is documented in the CLI help');

  console.log(`\nALL EVAL UNIT TESTS PASSED (${checks} checks)`);
  cleanup(0);
} catch (e) {
  console.error('\n✗ EVAL UNIT TEST FAILED:', e && e.message);
  cleanup(1);
}
})();
