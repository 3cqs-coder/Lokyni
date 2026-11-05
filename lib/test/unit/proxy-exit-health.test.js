'use strict';
// Guards per-exit proxy health (lib/webproxy.js): a dead exit (failed tunnel/connect) is rested after a
// few consecutive failures, while a healthy exit that merely hit a site's rate limit (a "blocked" result)
// is NOT penalized. Selection skips cooled exits but never starves — if all are cooled, the whole pool is
// still usable (a half-open trial). Pure/offline: no real network; outcomes are recorded directly.
// Run: `npm run test:unit` (or `node lib/test/unit/proxy-exit-health.test.js`).

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const cfg = require(path.join(PROJECT, 'lib', 'config'));
const wp = require(path.join(PROJECT, 'lib', 'webproxy'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

// A three-proxy pool with rotation on, so selection has real choices to make.
const A = 'http://a.example:8080', B = 'http://b.example:8080', C = 'http://c.example:8080';
const saved = { url: cfg.WEB_PROXY_URL, rot: cfg.WEB_PROXY_ROTATE };

// Which distinct exits the picker will hand out across the whole active list (probe enough attempts to
// cover every slot regardless of the rotation base).
const reachableExits = () => {
  const pick = wp.makePicker();
  const seen = new Set();
  for (let i = 0; i < 12; i++) { const u = pick(i); if (u) seen.add(u); }
  return seen;
};

try {
  cfg.WEB_PROXY_URL = `${A}\n${B}\n${C}`;
  cfg.WEB_PROXY_ROTATE = true;

  // ── A dead exit is cooled after DEAD_TO_COOLDOWN consecutive failures and drops out of selection ──
  ok(reachableExits().has(A), 'A is selectable before any failures');
  wp.recordExit(A, 'dead'); wp.recordExit(A, 'dead');
  ok(reachableExits().has(A), 'two dead outcomes do not yet cool the exit');
  wp.recordExit(A, 'dead');   // third consecutive dead → cooled
  const afterCool = reachableExits();
  ok(!afterCool.has(A), 'a thrice-dead exit is cooled and skipped');
  ok(afterCool.has(B) && afterCool.has(C), 'the healthy exits remain selectable');

  // ── A "blocked" result (target refused) clears the dead streak — the exit is reachable, not down ──
  wp.recordExit(B, 'dead'); wp.recordExit(B, 'dead'); wp.recordExit(B, 'blocked');
  wp.recordExit(B, 'dead'); wp.recordExit(B, 'dead');   // only two deads since the block → not cooled
  ok(reachableExits().has(B), 'a block between deads resets the streak, so B is not cooled');

  // ── Never starve: if every exit is cooled, the full pool is still offered (half-open trial) ──
  for (const u of [A, B, C]) { wp.recordExit(u, 'dead'); wp.recordExit(u, 'dead'); wp.recordExit(u, 'dead'); wp.recordExit(u, 'dead'); }
  const allCooled = reachableExits();
  ok(allCooled.size >= 1, 'with every exit cooled, selection still offers the pool rather than returning nothing');

  // ── An "ok" clears a cooldown, bringing the exit straight back ──
  wp.recordExit(C, 'ok');
  ok(reachableExits().has(C), 'a successful outcome clears the cooldown immediately');

  // ── Snapshot masks credentials and never throws ──
  cfg.WEB_PROXY_URL = 'http://user:secret@d.example:8080';
  wp.recordExit('http://user:secret@d.example:8080', 'dead');
  const snap = wp.exitHealthSnapshot();
  ok(Array.isArray(snap), 'exitHealthSnapshot returns an array');
  ok(!JSON.stringify(snap).includes('secret'), 'the snapshot never exposes proxy credentials');

  // ── SOURCE GUARD: a cooldown is TIME-BOUNDED (half-open recovery), never permanent ──
  // A real-time test of the 30s cooldown expiry would be slow/flaky, so assert the comparison that makes
  // recovery automatic: _isCooled checks `cooledUntil > now`, so once the timestamp passes the exit is
  // selectable again with no explicit 'ok'. Inverting this would strand a transiently-dead exit forever.
  const fs = require('fs');
  const src = fs.readFileSync(path.join(PROJECT, 'lib', 'webproxy.js'), 'utf-8');
  ok(/cooledUntil > now/.test(src), '_isCooled compares cooledUntil > now, so a cooldown expires on its own (half-open recovery)');
  ok(/e\.dead = 0;\s*\n\s*e\.cooledUntil = 0;/.test(src), 'any response (ok or blocked) clears the dead streak and the cooldown');

  console.log(`\nALL PROXY-EXIT-HEALTH TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ PROXY-EXIT-HEALTH UNIT TEST FAILED:', e && e.message);
  process.exit(1);
} finally {
  cfg.WEB_PROXY_URL = saved.url; cfg.WEB_PROXY_ROTATE = saved.rot;
}
