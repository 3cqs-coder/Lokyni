'use strict';
// Guards the startup pre-flight model matching (lib/preflight.js). Ollama lists models tagged
// (`llama3.2:latest`) while config usually names them bare (`llama3.2`); hasModel must match on the base name
// so a pulled model is not falsely reported missing over a tag mismatch (which would print a misleading
// "run: ollama pull ..." warning on every start). Pure, branchy, and previously untested. Run: `npm run test:unit`.

const assert = require('assert');
const path = require('path');
const { baseName, hasModel } = require(path.resolve(__dirname, '..', '..', 'preflight'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

try {
  // ── baseName: strip the :tag and lower-case ──
  eq(baseName('llama3.2:latest'), 'llama3.2', 'baseName strips a :tag');
  eq(baseName('Llama3.2'), 'llama3.2', 'baseName lower-cases');
  eq(baseName('nomic-embed-text:v1.5'), 'nomic-embed-text', 'baseName keeps the bare name before the first colon');
  eq(baseName(''), '', 'baseName of empty is empty');
  eq(baseName(null), '', 'baseName of null is empty (no throw)');
  eq(baseName(undefined), '', 'baseName of undefined is empty (no throw)');

  // ── hasModel: tag-insensitive membership ──
  const installed = ['llama3.2:latest', 'nomic-embed-text:latest', 'qwen2.5:7b'];
  ok(hasModel(installed, 'llama3.2'), 'a bare configured name matches a tagged installed model');
  ok(hasModel(installed, 'llama3.2:latest'), 'a tagged configured name matches the same tagged installed model');
  ok(hasModel(installed, 'LLAMA3.2'), 'matching is case-insensitive');
  ok(hasModel(installed, 'qwen2.5'), 'another bare name matches its tagged install');
  ok(hasModel(installed, 'qwen2.5:14b'), 'a different tag of an installed base name still matches (base-name match by design)');
  eq(hasModel(installed, 'mistral'), false, 'a genuinely absent model is reported missing');
  eq(hasModel(installed, 'llama3'), false, 'a different base name (llama3 vs llama3.2) does not false-match');

  // ── nothing configured → nothing to check (true, so no spurious warning) ──
  ok(hasModel(installed, ''), 'an empty wanted name is treated as "nothing to check" (true)');
  ok(hasModel(installed, null), 'a null wanted name is treated as "nothing to check" (true)');
  ok(hasModel([], 'llama3.2') === false, 'with no installed models, a configured model is missing');

  console.log('✓ preflight: tag-vs-bare-name model matching is case-insensitive, base-name based, and null-safe');
  console.log(`\nALL PREFLIGHT UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ PREFLIGHT UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
