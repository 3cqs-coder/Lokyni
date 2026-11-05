'use strict';
// Guards the "exit when the launcher goes away" decision (lib/supervise), the rule that keeps a
// supervised or background start from ever being left orphaned — a stray server holds the port and data
// directory and, stacked up, corrupts the tamper-evident audit log through concurrent writes. The whole
// truth table matters because a wrong TRUE would stop a real long-running service, and a wrong FALSE
// re-opens the orphan hole, so every launch style is asserted here rather than trusted by inspection.
// Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { exitsWithParent, stdinKind } = require(path.join(PROJECT, 'lib', 'supervise'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // ── ARMS: a supervised start whose parent holds a pipe or socket, with no IPC channel ──
  ok(exitsWithParent({ isTTY: false, hasIpc: false, kind: 'socket' }) === true,
    'a socket stdin (the desktop sidecar and node/Bash-tool spawns) arms exit-with-parent');
  ok(exitsWithParent({ isTTY: false, hasIpc: false, kind: 'fifo' }) === true,
    'a pipe stdin (a shell pipe launcher) arms exit-with-parent');

  // ── DOES NOT ARM: the interactive terminal — the user drives it, Ctrl-C already stops it ──
  ok(exitsWithParent({ isTTY: true, hasIpc: false, kind: 'char' }) === false,
    'an interactive TTY never arms (would otherwise fight the user)');

  // ── DOES NOT ARM: a Node IPC channel is present (pm2 fork/cluster, node fork) ──
  // pm2 uses stdio ['pipe','pipe','pipe','ipc'], so stdin is a pipe but process.send is defined; its EOF
  // is not a "parent gone" signal, and arming would stop a pm2-managed server when pm2 closed that pipe.
  ok(exitsWithParent({ isTTY: false, hasIpc: true, kind: 'fifo' }) === false,
    'a pm2/fork process (IPC channel present) never arms even though its stdin is a pipe');
  ok(exitsWithParent({ isTTY: false, hasIpc: true, kind: 'socket' }) === false,
    'the IPC exclusion holds for a socket stdin too');

  // ── DOES NOT ARM: a real service — /dev/null (char device) or a redirected file — outlives a launcher ──
  ok(exitsWithParent({ isTTY: false, hasIpc: false, kind: 'char' }) === false,
    'a /dev/null stdin (systemd, launchd, non-interactive Docker) never arms — its immediate EOF must not stop the service');
  ok(exitsWithParent({ isTTY: false, hasIpc: false, kind: 'file' }) === false,
    'a redirected regular file never arms (immediate EOF, not a live parent)');
  ok(exitsWithParent({ isTTY: false, hasIpc: false, kind: 'none' }) === false,
    'an unreadable/closed stdin never arms (the safe default)');
  console.log('✓ supervise: arms only for a pipe/socket-supervised, non-IPC, non-TTY start (pm2 and services excluded)');

  // ── stdinKind classifies THIS test process (spawned by the runner) into a known bucket ──
  const k = stdinKind();
  ok(['fifo', 'socket', 'char', 'file', 'none', 'other'].includes(k), `stdinKind returns a known classification (got "${k}")`);
  console.log(`✓ supervise: stdinKind classifies fd 0 into a known bucket ("${k}")`);

  console.log(`\nALL SUPERVISE UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ SUPERVISE UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
