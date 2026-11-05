'use strict';
// Unit tests for the per-workspace persona.
//   1. Persistence: a persona round-trips through the workspace settings store (temp dir),
//      independently of any other stored field, and clearing it removes only that field.
//   2. Prompt wiring: when a persona is set, buildMessages injects it AFTER the assistant
//      role but BEFORE the grounding rules — so it shapes tone while the rules still govern
//      grounding — and when it is empty the prompt is unchanged.
// No network and no model call. Run: `npm run test:unit`.

const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const wsm = require(path.join(PROJECT, 'lib', 'workspaces'));
const cfg = require(path.join(PROJECT, 'lib', 'config'));
const { buildMessages, GROUNDING_RULES } = require(path.join(PROJECT, 'lib', 'llm'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };
const eq = (a, b, msg) => { checks++; assert.strictEqual(a, b, msg); };

const tmps = [];
const mkTmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-persona-')); tmps.push(d); return d; };
const cleanup = (code) => {
  for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  process.exitCode = code;
};

// Restore the real persona getter after we stub it, so we don't leak a fixed value into
// any later test sharing this process.
const realDesc = Object.getOwnPropertyDescriptor(cfg, 'WORKSPACE_PERSONA');
const stubPersona = (value) => Object.defineProperty(cfg, 'WORKSPACE_PERSONA', { configurable: true, enumerable: true, get: () => value });

try {
  // ── 1. Persistence round-trip ──
  {
    const d = mkTmp();
    wsm.ensureWorkspace(d, wsm.DEFAULT_ID);
    // A pre-existing unrelated field must survive persona writes.
    wsm.saveSettings(d, wsm.DEFAULT_ID, { sourcePaths: ['/keep/me'] });
    wsm.updateSettings(d, wsm.DEFAULT_ID, (s) => { s.persona = 'Answer as a patient tutor.'; return s; });
    let saved = wsm.loadSettings(d, wsm.DEFAULT_ID);
    eq(saved.persona, 'Answer as a patient tutor.', 'persona persists');
    assert.deepStrictEqual(saved.sourcePaths, ['/keep/me']); checks++;   // untouched
    // Clearing removes ONLY the persona.
    wsm.updateSettings(d, wsm.DEFAULT_ID, (s) => { delete s.persona; return s; });
    saved = wsm.loadSettings(d, wsm.DEFAULT_ID);
    ok(!('persona' in saved), 'clearing removes the persona field');
    assert.deepStrictEqual(saved.sourcePaths, ['/keep/me']); checks++;   // still untouched
    console.log('✓ persona: persists and clears independently of other settings');
  }

  // ── 2. buildMessages injects the persona before the grounding rules ──
  {
    stubPersona('Be concise and use plain language.');
    const msgs = buildMessages('some document text', [], 'What is X?');
    const sys = msgs[0].content;
    ok(sys.includes('Be concise and use plain language.'), 'the persona text is in the system prompt');
    ok(sys.includes(GROUNDING_RULES.slice(0, 40)), 'the grounding rules are still present');
    ok(sys.indexOf('Be concise and use plain language.') < sys.indexOf(GROUNDING_RULES.slice(0, 40)),
      'the persona appears BEFORE the grounding rules');
    console.log('✓ persona: buildMessages injects it ahead of the grounding rules');
  }

  // ── 3. No persona leaves the prompt unchanged ──
  {
    stubPersona('');
    const sys = buildMessages('doc', [], 'Q?')[0].content;
    ok(!sys.includes('WORKSPACE STYLE'), 'no persona block when the persona is empty');
    console.log('✓ persona: an empty persona leaves the prompt unchanged');
  }

  if (realDesc) Object.defineProperty(cfg, 'WORKSPACE_PERSONA', realDesc);
  console.log(`\nALL PERSONA UNIT TESTS PASSED (${checks} checks)`);
  cleanup(0);
} catch (e) {
  if (realDesc) { try { Object.defineProperty(cfg, 'WORKSPACE_PERSONA', realDesc); } catch {} }
  console.error('\n✗ PERSONA UNIT TEST FAILED:', e && e.message);
  cleanup(1);
}
