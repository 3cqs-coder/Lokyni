'use strict';
// Guards the "Max answer length = Auto" default: 0 (or blank) means the answer cap is sized to the model at
// request time, so a long answer (e.g. a full-document summary) is never silently truncated out of the box and
// switching models needs no retuning — while a pinned positive value is still honored verbatim, and the value
// that reaches the provider is never 0 (which makes a provider emit an empty answer). Run: `npm run test:unit`.

const path = require('path'), fs = require('fs'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { NUMERIC_RANGES, SETTINGS } = require(path.join(PROJECT, 'lib', 'settings-schema'));
const { resolveMaxTokens } = require(path.join(PROJECT, 'lib', 'llm'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

try {
  // ── resolution: 0/blank = auto (model-sized), a positive value is verbatim, never 0 ──
  eq(resolveMaxTokens(2048), 2048, 'a pinned positive cap is used verbatim');
  eq(resolveMaxTokens(500), 500, 'a small pinned cap is honored');
  eq(resolveMaxTokens(0, 32768), 8192, 'auto sizes to half the context, capped at 8192');
  eq(resolveMaxTokens(0, 8192), 4096, 'auto = half the context window');
  eq(resolveMaxTokens(0, 4096), 2048, 'auto scales down with a smaller context');
  eq(resolveMaxTokens(0, 1000), 1024, 'auto is floored at 1024 so even a tiny context still answers');
  eq(resolveMaxTokens('', 16384), 8192, 'a blank value is auto too');
  ok(resolveMaxTokens(0, 0) >= 1024, 'auto never returns 0 (which would make the model emit an empty answer)');
  ok(resolveMaxTokens(-5, 8192) === 4096, 'a negative/garbage value falls back to auto');

  // ── the default is Auto, and the clamp allows 0 ──
  const cfg = fs.readFileSync(path.join(PROJECT, 'lib', 'config.js'), 'utf-8');
  ok(NUMERIC_RANGES.maxTokens.min === 0, 'the maxTokens clamp allows 0 (the auto sentinel)');
  ok(SETTINGS.maxTokens.default === 0, 'the shared schema defaults maxTokens to 0 (Auto)');
  ok(/num\(providerConfig\.maxTokens,\s*def\('maxTokens'\)/.test(cfg), 'MAX_TOKENS reads its default from the schema');
  const dflt = JSON.parse(fs.readFileSync(path.join(PROJECT, 'config', 'config.json.default'), 'utf-8'));
  eq(dflt.maxTokens, 0, 'the shipped config default is Auto (0)');

  // ── llm.js funnels the answer cap through the resolver (so 0 never reaches the provider) ──
  const llm = fs.readFileSync(path.join(PROJECT, 'lib', 'llm.js'), 'utf-8');
  ok(/resolveMaxTokens\(opts\.maxTokens \?\? cfg\.MAX_TOKENS/.test(llm), 'streamChat resolves the cap through resolveMaxTokens');

  // ── the UI offers Auto (blank), not a fixed 1024 ──
  const ejs = fs.readFileSync(path.join(PROJECT, 'lib', 'views', 'chat.ejs'), 'utf-8');
  ok(/id="cfg-max-tokens"[^>]*placeholder="Auto"/.test(ejs) && /min="0"/.test(ejs), 'the Max answer length field offers Auto (blank, min 0)');
  const chat = fs.readFileSync(path.join(PROJECT, 'lib', 'public', 'js', 'chat.js'), 'utf-8');
  ok(/cfgMaxTokens\.value\s*=\s*cfg\.maxTokens \? cfg\.maxTokens : ''/.test(chat), 'load shows a blank field for auto');
  ok(/numField\(cfgMaxTokens, settingDefault\('maxTokens'\), false\)/.test(chat), 'save sends the schema\'s 0 (Auto) for a blank field');

  console.log(`\nALL MAXTOKENS-AUTO TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ MAXTOKENS-AUTO TEST FAILED:', e && e.message);
  process.exit(1);
}
