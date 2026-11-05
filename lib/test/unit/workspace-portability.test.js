'use strict';
// Guards workspace-id portability. A workspace's id becomes a directory under data/workspaces, and Windows
// reserves device names such as CON, AUX, NUL, and COM1 in every directory. A workspace named "CON" must not
// produce an unusable directory on any platform, and a data directory should survive a move between operating
// systems. Uses a throwaway data dir; no model or network. Run: `npm run test:unit`.

const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const wsm = require(path.join(PROJECT, 'lib', 'workspaces'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-wsid-')));
const realPlatform = process.platform;
const asPlatform = (p, fn) => {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
  try { return fn(); } finally { Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }); }
};

try {
  // ── Reserved device names are prefixed, on every platform ──
  for (const [name, id] of [
    ['CON', 'ws-con'], ['aux', 'ws-aux'], ['NUL', 'ws-nul'], ['PRN', 'ws-prn'],
    ['COM1', 'ws-com1'], ['LPT9', 'ws-lpt9'], ['con', 'ws-con'],
  ]) {
    eq(wsm.slugify(name), id, `"${name}" gets a portable id (${id})`);
  }
  eq(wsm.slugify('COM0'), 'com0', 'COM0 is not reserved on Windows and is kept');
  eq(wsm.slugify('LPT0'), 'lpt0', 'LPT0 is not reserved on Windows and is kept');
  eq(wsm.slugify('console'), 'console', 'a name containing a reserved word is not reserved');
  eq(wsm.slugify('CON.txt'), 'con-txt', 'an extension makes the slug non-reserved');
  ok(wsm.slugify('x'.repeat(80)).length <= 48, 'the id stays within the 48-character cap');
  ok(wsm.slugify('') === 'workspace', 'an empty name still yields a usable id');

  // ── Validation is platform-aware ──
  asPlatform('linux', () => {
    ok(wsm.isValidId('con'), 'Linux still accepts a legacy "con" id');
    ok(wsm.isValidId('ws-con'), 'Linux accepts the portable form');
  });
  asPlatform('win32', () => {
    ok(!wsm.isValidId('con'), 'Windows refuses a reserved legacy id before it reaches the filesystem');
    ok(!wsm.isValidId('com1'), 'Windows refuses every reserved device name');
    ok(wsm.isValidId('ws-con'), 'Windows accepts the portable form');
    ok(wsm.isValidId('console'), 'Windows accepts a normal id');
  });

  // ── Creation uses the portable id and still avoids collisions ──
  const first = wsm.createWorkspace(tmp, 'CON');
  eq(first.id, 'ws-con', 'a workspace named CON is created under ws-con');
  ok(fs.existsSync(path.join(tmp, 'workspaces', 'ws-con')), 'the portable workspace directory exists');
  ok(wsm.loadRegistry(tmp).some((w) => w.id === 'ws-con' && w.name === 'CON'), 'the display name is preserved');

  const second = wsm.createWorkspace(tmp, 'CON');
  eq(second.id, 'ws-con-2', 'a second workspace named CON gets a distinct portable id');
  ok(fs.existsSync(path.join(tmp, 'workspaces', 'ws-con-2')), 'the collision-suffixed directory exists');

  console.log(`\nALL WORKSPACE-PORTABILITY UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ WORKSPACE-PORTABILITY UNIT TEST FAILED:', e && e.message);
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
