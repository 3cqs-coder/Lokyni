'use strict';
// Guards the answer-pipeline version: one constant, folded into the semantic-cache key so a prompt/safeguard
// change retires old cached answers, stamped on each evaluation run so a trend can mark a pipeline step, and
// exposed by /api/health. Single-sourced in lib/constants.js. No model or network. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');
const C = require(path.join(PROJECT, 'lib', 'constants'));
const sc = require(path.join(PROJECT, 'lib', 'semanticcache'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // ── One version, sane ──
  ok(Number.isInteger(C.ANSWER_PIPELINE_VERSION) && C.ANSWER_PIPELINE_VERSION >= 1,
    'the answer pipeline has a positive integer version');
  ok(C.INDEX_FORMAT_VERSION >= 1 && C.ANSWER_PIPELINE_VERSION !== undefined,
    'the index-format and answer-pipeline versions are separate identities');
  ok(/\bANSWER_PIPELINE_VERSION\b/.test(read('lib/constants.js')) && /ANSWER_PIPELINE_VERSION,/.test(read('lib/constants.js')),
    'the constant is exported from the single constants module');

  // ── The semantic cache key includes it ──
  const sig = sc.signature();
  ok(new RegExp(`pipeline:${C.ANSWER_PIPELINE_VERSION}`).test(sig), 'the cache signature is tagged with the pipeline version');
  ok(/`pipeline:\$\{require\('\.\/constants'\)\.ANSWER_PIPELINE_VERSION\}`/.test(read('lib/semanticcache.js')),
    'the cache reads the version lazily from the shared constant (no copy)');

  // ── Evaluation runs record it, and the dashboard can compare ──
  const engine = read('lib/eval.js');
  ok(/pipeline: \{ answer: C\.ANSWER_PIPELINE_VERSION, indexFormat: C\.INDEX_FORMAT_VERSION \}/.test(engine),
    'a run records the pipeline it used');
  ok(/\.\.\.\(run\.pipeline \? \{ pipeline: run\.pipeline \} : \{\}\)/.test(engine),
    'the trend history carries the pipeline stamp');
  ok(/pipeline: \{[\s\S]{0,120}?ANSWER_PIPELINE_VERSION/.test(read('lib/routes/eval.js')),
    'the eval endpoint reports the current pipeline for comparison');
  const chat = read('lib/public/js/chat.js');
  ok(/recorded with answer pipeline v/.test(chat) && /run again to compare/.test(chat),
    'the dashboard says when the last run predates the current pipeline');
  ok(/renderEvalResults\(data\.run, data\.run && data\.run\.pipeline\)/.test(chat), 'a fresh run compares against itself (no false warning)');
  ok(/renderEvalResults\(data\.lastRun \|\| null, data\.pipeline \|\| null\)/.test(chat), 'loading the panel compares the saved run with the current build');

  // ── Health exposes both identities ──
  const server = read('lib/server.js');
  ok(/pipeline: \{ answer: C\.ANSWER_PIPELINE_VERSION, indexFormat: C\.INDEX_FORMAT_VERSION \}/.test(server),
    '/api/health exposes the answer and index versions');

  // ── Documented ──
  const docs = read('docs/README.md');
  ok(/answer-pipeline version/.test(docs), 'the guide explains the cache invalidation');
  ok(/records the answer-pipeline\s+version/.test(docs), 'the guide explains the evaluation stamp');

  console.log(`\nALL PIPELINE-VERSION UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ PIPELINE-VERSION UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
