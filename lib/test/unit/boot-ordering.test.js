'use strict';
// Guards two boot-sequence invariants in lokyni.js that a live boot can't easily exercise:
//
//   1. WATCHER BINDS THE ACTIVE WORKSPACE. The file watcher's watched directories (DOCS_DIR /
//      SOURCE_PATHS) are live getters keyed off the active workspace, and initIndex is what reopens
//      the last-active (possibly non-default) workspace. So startWatcher() MUST run after
//      `await initIndex(...)`; arming it earlier bound chokidar to the DEFAULT workspace's folders and
//      silently missed every change in the one actually loaded — real-time indexing looked dead after
//      a restart into a non-default workspace.
//   2. THE --mcp PATH DEGRADES, IT DOESN'T DIE. Like the web path, an index-build failure on the MCP
//      stdio entry point must be caught so the server still serves (tools return "still building"),
//      rather than the whole process exiting on a cold start with an unreachable provider.
//
// Source-inspection guards (boot needs a live filesystem/provider). Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const src = fs.readFileSync(path.join(PROJECT, 'lokyni.js'), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // ── 1. startWatcher() runs AFTER the boot index build resolves the active workspace ──
  // The boot build runs THROUGH the lifecycle lock (runLifecycleExclusive) so a switch/rebuild/upload that
  // arrives during the cold warm-up queues behind it instead of racing a half-loaded index.
  const initIdx = src.indexOf('runLifecycleExclusive(() => initIndex({ forceRebuild }))');
  ok(initIdx !== -1, 'the boot index build runs through the lifecycle lock (runLifecycleExclusive(() => initIndex({ forceRebuild })))');
  // startWatcher() is armed once on the boot path, now guarded so a cluster read replica never indexes.
  const watcherCalls = [...src.matchAll(/startWatcher\(\);/gm)].map(m => m.index);
  ok(watcherCalls.length === 1, `startWatcher() is called exactly once on the boot path (found ${watcherCalls.length})`);
  ok(/if \(!cluster\.isReplica\(\)\) startWatcher\(\);/.test(src), 'the watcher is skipped on a read replica (guarded call)');
  ok(watcherCalls[0] > initIdx, 'startWatcher() is armed AFTER await initIndex (binds the active workspace, not the default)');
  // It must not sit right after startWebServer() any more (the old, wrong-workspace position).
  const webStart = src.indexOf('server = startWebServer();');
  ok(webStart !== -1 && watcherCalls[0] > webStart + 200,
    'startWatcher() no longer immediately follows startWebServer() (the pre-fix position)');
  console.log('✓ boot-ordering: the file watcher is armed after the active workspace is resolved');

  // ── 2. the --mcp branch wraps initIndex in try/catch so a build failure degrades, not exits ──
  const mcpIdx = src.indexOf("if (has('--mcp'))");
  ok(mcpIdx !== -1, 'the --mcp branch is present');
  const mcpBlock = src.slice(mcpIdx, mcpIdx + 1900);
  ok(/try \{\s*\/\/[^\n]*\n\s*await runLifecycleExclusive\(\(\) => initIndex\(\)\);\s*\} catch/.test(mcpBlock),
    'the --mcp path runs the boot build through the lock and catches a failure, still starting the stdio server');
  ok(/runStdio\(\)/.test(mcpBlock), 'the --mcp path reaches runStdio() after the guarded build');
  console.log('✓ boot-ordering: the --mcp path degrades (does not exit) on an index-build failure');

  console.log(`\nALL BOOT-ORDERING UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ BOOT-ORDERING UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
