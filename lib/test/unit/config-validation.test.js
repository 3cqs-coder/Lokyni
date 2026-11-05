'use strict';
// Guards config-reader robustness: a hand-edited config.json is the documented surface for advanced knobs,
// so the reader must coerce and clamp bad values (not trust them into the answer path) and must fail
// gracefully on a non-object file. config.js reads config.json at import (cached), so these run in child
// processes with a crafted config dir rather than mutating this process. Run: `npm run test:unit`.

const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const { execFileSync } = require('child_process');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const CONFIG = path.join(PROJECT, 'lib', 'config.js');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

// Load config.js in a child with the given config.json contents; return { values } or { exit, msg }.
const load = (json) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-cfg-'));
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'config', 'config.json'), json);
  try {
    const out = execFileSync(process.execPath, ['-e',
      `const c=require(${JSON.stringify(CONFIG)}); console.log(JSON.stringify({numCtx:c.numCtx,maxTokens:c.MAX_TOKENS,temp:c.TEMPERATURE,maxHistory:c.maxHistory,passageSize:c.PASSAGE_SIZE,rrfK:c.rrfK,minCos:c.MIN_COSINE_SCORE}))`],
      { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { values: JSON.parse(out.trim().split('\n').pop()) };
  } catch (e) {
    return { exit: e.status, msg: String(e.stderr || '') };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

try {
  // ── wrong-type / out-of-range values are coerced and clamped, not trusted ──
  const bad = load('{"numCtx":"big","maxTokens":0,"temperature":"hot","maxHistory":-3,"passageSize":-100,"rrfK":"x","minCosineScore":5}');
  ok(bad.values, 'a config with bad-typed values still boots');
  ok(bad.values.numCtx === 0, 'a string numCtx falls back to the default 0 = automatic (not NaN, which would disable doc truncation)');
  ok(bad.values.maxTokens === 0, 'maxTokens 0 is kept as the Auto sentinel (sized to the model at request time via resolveMaxTokens; never a literal 0 to the provider)');
  ok(bad.values.temp === 0.35, 'a non-numeric temperature falls back to the default');
  ok(bad.values.maxHistory === 0, 'a negative maxHistory clamps to 0');
  ok(bad.values.passageSize === 100, 'a negative passageSize clamps to the floor');
  ok(bad.values.rrfK === 60, 'a non-numeric rrfK falls back to the default');
  ok(bad.values.minCos === 1, 'an out-of-range minCosineScore clamps into [0,1]');
  console.log('✓ config-validation: wrong-type/out-of-range tunables are coerced and clamped at read time');

  // ── valid values pass through unchanged ──
  const good = load('{"numCtx":8192,"maxTokens":512,"temperature":0.5,"maxHistory":2,"passageSize":6000,"rrfK":40,"minCosineScore":0.4}');
  ok(good.values && good.values.numCtx === 8192 && good.values.maxTokens === 512 && good.values.temp === 0.5 && good.values.maxHistory === 2,
    'valid values are preserved as written');
  console.log('✓ config-validation: valid values pass through unchanged');

  // ── a non-object config (null / array) exits gracefully, not with a TypeError crash ──
  const asNull = load('null');
  ok(asNull.exit === 1 && /must contain a JSON object|not valid JSON/.test(asNull.msg) && !/TypeError/.test(asNull.msg),
    'a null config exits with an actionable message, not a TypeError stack');
  const asArray = load('[]');
  ok(asArray.exit === 1 && !/TypeError/.test(asArray.msg), 'an array config exits gracefully too');
  console.log('✓ config-validation: a non-object config file fails with a clear message, not a crash');

  // ── the recent-history window handles maxHistory <= 0 (source guard: slice(-0) returns the whole array) ──
  const llmSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'llm.js'), 'utf-8');
  ok(/n > 0 \? aligned\.slice\(-\(n \* 2\)\) : \[\]/.test(llmSrc), 'the recent-history window returns [] for maxHistory <= 0 instead of the whole history');
  console.log('✓ config-validation: recent-history window is guarded against the slice(-0) inversion');

  console.log(`\nALL CONFIG-VALIDATION UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ CONFIG-VALIDATION UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
