'use strict';
// The mtime-keyed read cache for the workspace registry + per-workspace settings (read 2–3× per chat turn and
// per API request). It must: serve an unchanged file from memory, reflect a write immediately (invalidation),
// return a CLONE from loadSettings (callers — updateSettings — mutate the result in place), and never hand out
// a shared mutable registry array. Run: `npm run test:unit`.

const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const wsm = require(path.join(PROJECT, 'lib', 'workspaces'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-wscache-'));
const cleanup = (code) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(code); };

try {
  const WS = 'default';

  // ── loadSettings returns a CLONE: mutating the result must not poison the cache ──
  wsm.saveSettings(tmp, WS, { persona: 'careful analyst', evalQuestions: [{ id: 'q1', text: 'hi' }] });
  const a = wsm.loadSettings(tmp, WS);
  ok(a.persona === 'careful analyst', 'settings round-trip through the cache');
  a.persona = 'MUTATED';
  a.evalQuestions.push({ id: 'x', text: 'injected' });
  const b = wsm.loadSettings(tmp, WS);
  ok(b.persona === 'careful analyst', 'a mutation of a returned settings object does not corrupt the cache (clone)');
  ok(b.evalQuestions.length === 1, 'nested arrays are cloned too (deep copy)');

  // ── a write is reflected immediately (invalidation on save), same process ──
  wsm.saveSettings(tmp, WS, { persona: 'new tone' });
  ok(wsm.loadSettings(tmp, WS).persona === 'new tone', 'a save is seen by the very next load (cache invalidated)');

  // ── updateSettings (load → mutate → save) works correctly over the cache ──
  wsm.updateSettings(tmp, WS, (s) => { s.persona = 'updated'; return s; });
  ok(wsm.loadSettings(tmp, WS).persona === 'updated', 'updateSettings persists through the cache');

  // ── loadRegistry returns a fresh (non-shared) list each call ──
  const r1 = wsm.loadRegistry(tmp);
  ok(Array.isArray(r1) && r1.length >= 1, 'registry loads a non-empty list');
  r1.push({ id: 'bogus', name: 'x', created: 1 });
  const r2 = wsm.loadRegistry(tmp);
  ok(!r2.some(w => w.id === 'bogus'), 'mutating a returned registry list does not affect the next load');

  // ── a corrupt settings file reads as {} and never throws ──
  fs.writeFileSync(path.join(tmp, 'workspaces', WS, 'workspace.json'), 'not json');
  const corrupt = wsm.loadSettings(tmp, WS);
  ok(corrupt && typeof corrupt === 'object' && Object.keys(corrupt).length === 0, 'a corrupt settings file reads as empty, never throws');

  console.log(`\nALL WORKSPACES-CACHE TESTS PASSED (${checks} checks)`);
  cleanup(0);
} catch (e) {
  console.error('\n✗ WORKSPACES-CACHE TEST FAILED:', e && e.message);
  cleanup(1);
}
