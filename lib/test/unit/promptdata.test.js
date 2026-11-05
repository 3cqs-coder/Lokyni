'use strict';
// Guards the prompt-data loader (lib/promptdata.js). The grounding rules and per-mode notes are SHIPPED text
// files under lib/ai/data/; a missing/unreadable one used to resolve to '' SILENTLY, which would make every
// answer lose its grounding rules AND disable the system-prompt-leak canary (both read grounding-rules.txt)
// with no operator signal — the exact failure a packaging error (omitting lib/ai/data/ from the sidecar or
// Docker image) would cause. The loader must now WARN loudly on a read failure (but still never throw), and
// still return the real text for a present file. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const promptData = require(path.join(PROJECT, 'lib', 'promptdata'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // ── A present, shipped file loads with real content (and the critical one is non-empty) ──
  const rules = promptData.read('grounding-rules.txt');
  ok(typeof rules === 'string' && rules.trim().length > 50, 'grounding-rules.txt loads with real content');
  ok(promptData.read('grounding-rules.txt') === rules, 'a second read is cached (same value, no re-read)');

  // ── A missing file returns '' but WARNS (never silent), and never throws ──
  const _warn = console.warn;
  let warned = '';
  console.warn = (...a) => { warned += a.join(' ') + '\n'; };
  let result, threw = false;
  try { result = promptData.read('zzxq-does-not-exist.txt'); } catch { threw = true; }
  console.warn = _warn;
  ok(!threw, 'reading a missing prompt file does not throw (degrade, not die)');
  ok(result === '', 'a missing prompt file resolves to an empty string');
  ok(/zzxq-does-not-exist\.txt/.test(warned) && /could not be read/i.test(warned),
    'a missing/unreadable prompt file logs a loud warning naming the file (never a silent degradation)');

  console.log('✓ promptdata: shipped files load cached; a missing file warns loudly and degrades without throwing');
  console.log(`\nALL PROMPTDATA UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ PROMPTDATA UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
