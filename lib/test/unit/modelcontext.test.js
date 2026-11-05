'use strict';
// Functional tests for automatic per-model context-window sizing (lib/modelcontext.js). The module is pure
// (no I/O), so the sizing math is tested directly: parse a model's parameter count from its name, estimate a
// window when the real one is unknown, read the real window out of a model-host "show" response, and resolve
// the effective num_ctx (explicit override wins and is never capped; otherwise the real window or the name
// estimate, bounded to [MIN_CONTEXT, CONTEXT_CEILING]). Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const mc = require(path.join(PROJECT, 'lib', 'modelcontext'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

try {
  // ── paramCountB: parse the billions-of-parameters hint from a model name ──
  eq(mc.paramCountB('qwen2.5:14b-instruct-q4_K_M'), 14, 'parses 14b and drops the quant tag');
  eq(mc.paramCountB('llama3.2:3b'), 3, 'parses 3b');
  eq(mc.paramCountB('mistral-nemo:12b'), 12, 'parses 12b');
  eq(mc.paramCountB('llama3.1:70b'), 70, 'parses 70b');
  eq(mc.paramCountB('phi3:3.8b'), 3.8, 'parses a decimal size');
  eq(mc.paramCountB('nomic-embed-text'), null, 'no size hint -> null');
  eq(mc.paramCountB('llama3.2:latest'), null, 'a version tag is not a size');
  eq(mc.paramCountB(''), null, 'empty name -> null');
  eq(mc.paramCountB(null), null, 'null name -> null (no throw)');

  // ── heuristicContextTokens: name-based fallback, always within the ceiling ──
  eq(mc.heuristicContextTokens('nomic-embed-text'), 8192, 'unknown size -> safe middle');
  eq(mc.heuristicContextTokens('llama3.2:3b'), 8192, 'small model estimate');
  eq(mc.heuristicContextTokens('qwen2.5:14b'), 16384, 'mid model estimate');
  eq(mc.heuristicContextTokens('llama3.1:70b'), mc.CONTEXT_CEILING, 'large model estimate is the ceiling');
  ok(mc.heuristicContextTokens('llama3.1:70b') <= mc.CONTEXT_CEILING, 'estimate never exceeds the ceiling');

  // ── contextLengthFromInfo: read the real window from a show() model_info block ──
  eq(mc.contextLengthFromInfo({ 'llama.context_length': 131072, 'llama.embedding_length': 3072 }), 131072,
    'reads an arch-prefixed context_length');
  eq(mc.contextLengthFromInfo({ 'qwen2.context_length': 32768 }), 32768, 'works for any architecture prefix');
  eq(mc.contextLengthFromInfo({ 'general.architecture': 'llama' }), null, 'no context_length key -> null');
  eq(mc.contextLengthFromInfo({ 'bert.context_length': 0 }), null, 'a non-positive value -> null');
  eq(mc.contextLengthFromInfo(null), null, 'null info -> null (no throw)');
  eq(mc.contextLengthFromInfo('nope'), null, 'non-object info -> null');

  // ── resolveNumCtx: the effective value ──
  // Explicit override: used verbatim, and NOT capped (a hand-tuned value is intentional).
  eq(mc.resolveNumCtx({ explicit: 8192, realWindow: 131072, model: 'x:7b' }), 8192, 'explicit value wins over the real window');
  eq(mc.resolveNumCtx({ explicit: 100000, realWindow: null, model: 'x:7b' }), 100000, 'an explicit value above the ceiling is NOT capped');
  // Automatic (0/absent): real window, capped.
  eq(mc.resolveNumCtx({ explicit: 0, realWindow: 131072, model: 'llama3.2:3b' }), mc.CONTEXT_CEILING,
    'automatic caps a huge real window at the ceiling (memory safety)');
  eq(mc.resolveNumCtx({ explicit: 0, realWindow: 8192, model: 'llama3.2:3b' }), 8192,
    'automatic uses the real window when it is within the ceiling');
  eq(mc.resolveNumCtx({ explicit: 0, realWindow: 500, model: 'llama3.2:3b' }), mc.MIN_CONTEXT,
    'automatic floors a tiny real window at MIN_CONTEXT');
  // Automatic with no real window: fall back to the name estimate.
  eq(mc.resolveNumCtx({ explicit: 0, realWindow: null, model: 'qwen2.5:14b' }), 16384,
    'automatic falls back to the name estimate when the real window is unknown');
  eq(mc.resolveNumCtx({ explicit: undefined, realWindow: null, model: 'nomic-embed-text' }), 8192,
    'absent explicit + unknown size -> safe middle');
  ok(mc.resolveNumCtx({ explicit: 0, realWindow: 131072, model: 'x' }) <= mc.CONTEXT_CEILING, 'automatic never exceeds the ceiling');

  console.log(`\nALL MODELCONTEXT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ MODELCONTEXT UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
