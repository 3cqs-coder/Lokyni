'use strict';
// Drift guards for the shared retrieval constants (lib/retrieval/constants.js):
//   - INDEX_HEAD_CHARS: BM25 indexing, corpus IDF, and the entity graph must all scan the same
//     document-head length, or IDF weighting desynchronizes from what BM25 indexed and the
//     ranking math skews silently.
//   - AUX_LLM_TIMEOUT_MS: the auxiliary query-helper calls (rewrite, intent, HyDE, corrective,
//     RAG-Fusion) share one deadline, so it can be tuned in one place, not five.
// Each guard asserts the constant is sane and that its consumers reference it instead of a
// re-introduced bare literal. Pure file read, no index. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { INDEX_HEAD_CHARS, AUX_LLM_TIMEOUT_MS } = require(path.join(PROJECT, 'lib', 'retrieval', 'constants'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  ok(Number.isFinite(INDEX_HEAD_CHARS) && INDEX_HEAD_CHARS > 0, 'INDEX_HEAD_CHARS is a positive number');
  console.log('✓ headcap-drift: the shared head-cap constant is sane');

  // Each consumer must import the constant and must NOT carry its own 50000 literal.
  const consumers = [
    ['lib', 'retrieval', 'bm25.js'],
    ['lib', 'retrieval', 'keywords.js'],
    ['lib', 'retrieval', 'entitygraph.js'],
  ];
  for (const parts of consumers) {
    const rel = parts.join('/');
    const src = fs.readFileSync(path.join(PROJECT, ...parts), 'utf8');
    ok(/require\(['"]\.\/constants['"]\)/.test(src), `${rel} imports the shared constants module`);
    ok(src.includes('INDEX_HEAD_CHARS'), `${rel} references INDEX_HEAD_CHARS`);
    ok(!/\b50000\b/.test(src), `${rel} carries no bare 50000 literal (must use INDEX_HEAD_CHARS)`);
  }
  console.log('✓ headcap-drift: BM25, IDF, and the entity graph all use the shared constant');

  // AUX_LLM_TIMEOUT_MS — the five auxiliary query-helper modules must reference the shared
  // constant, not a re-introduced bare 12000, so the aux-call budget is one edit not five.
  ok(Number.isFinite(AUX_LLM_TIMEOUT_MS) && AUX_LLM_TIMEOUT_MS > 0, 'AUX_LLM_TIMEOUT_MS is a positive number');
  const auxConsumers = ['rewrite.js', 'intent.js', 'hyde.js', 'corrective.js', 'multiquery.js'];
  for (const name of auxConsumers) {
    const src = fs.readFileSync(path.join(PROJECT, 'lib', 'retrieval', name), 'utf8');
    ok(src.includes('AUX_LLM_TIMEOUT_MS'), `retrieval/${name} references AUX_LLM_TIMEOUT_MS`);
    ok(!/\b12000\b/.test(src), `retrieval/${name} carries no bare 12000 literal (must use AUX_LLM_TIMEOUT_MS)`);
  }
  console.log('✓ headcap-drift: the auxiliary LLM helpers all use the shared timeout constant');

  // The live in-memory history cap (history.js MAX_LIVE_HISTORY) and the persisted-turn cap (sessions.js
  // MAX_PERSISTED_TURNS) MUST stay equal — a mismatch silently shortens a conversation on reconnect or trims live
  // more than persistence needs. Both derive from ONE source (conversation.js MAX_HISTORY_TURNS), so assert they
  // are equal AND that neither re-hardcodes the number.
  const { MAX_HISTORY_TURNS } = require(path.join(PROJECT, 'lib', 'conversation'));
  const { MAX_LIVE_HISTORY } = require(path.join(PROJECT, 'lib', 'history'));
  ok(Number.isInteger(MAX_HISTORY_TURNS) && MAX_HISTORY_TURNS > 0, 'conversation.js single-sources a positive MAX_HISTORY_TURNS');
  ok(MAX_LIVE_HISTORY === MAX_HISTORY_TURNS, 'history.js live cap equals the shared MAX_HISTORY_TURNS');
  const sessSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'sessions.js'), 'utf-8');
  const histSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'history.js'), 'utf-8');
  ok(/MAX_PERSISTED_TURNS = MAX_HISTORY_TURNS/.test(sessSrc), 'sessions.js derives MAX_PERSISTED_TURNS from the shared constant (no re-typed 400)');
  ok(/MAX_HISTORY_TURNS/.test(histSrc) && !/MAX_LIVE_HISTORY = \d+/.test(histSrc), 'history.js derives MAX_LIVE_HISTORY from the shared constant (no bare literal)');
  console.log('✓ headcap-drift: live and persisted history caps are single-sourced and equal');

  console.log(`\nALL HEADCAP-DRIFT UNIT TESTS PASSED (${checks} checks)`);
  process.exitCode = 0;
} catch (e) {
  console.error('\n✗ HEADCAP-DRIFT UNIT TEST FAILED:', e && e.message);
  process.exitCode = 1;
}
