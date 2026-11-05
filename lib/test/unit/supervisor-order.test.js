'use strict';
// Drift guard for the desktop-sidecar orphan protection (lokyni.js + src-tauri/src/main.rs).
//
// The desktop app launches the server with `--desktop` and a piped stdin it holds open. The
// server watches that stdin: an EOF means the app's pipe end closed — which the OS delivers when
// the app exits by ANY means, on every platform — so the server shuts down instead of orphaning
// itself (a stray sidecar holds the port/data dir and, stacked, corrupts the audit-log chain).
// A "quit" line is the cooperative stop, important on Windows. This must be armed BEFORE the
// startup index build: a stalled rebuild (e.g. a chat model chosen for embeddings, which can't
// embed) must not leave the watch un-armed. This test locks that contract in source so it can't
// silently regress. No process spawned. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const server = fs.readFileSync(path.join(PROJECT, 'lokyni.js'), 'utf-8');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

try {
  // ── Server (lokyni.js) ──
  const watchAt = server.indexOf("args.includes('--desktop')");
  // The boot build now runs through the lifecycle lock, but the ordering invariant (stdin watch armed
  // BEFORE the build) is unchanged — match the build by the initIndex({ forceRebuild }) call either way.
  const initIndexAt = server.indexOf('initIndex({ forceRebuild }');
  ok(watchAt !== -1, 'lokyni.js arms the desktop stdin watch (gated on --desktop)');
  ok(initIndexAt !== -1, 'lokyni.js still runs the startup index build (initIndex({ forceRebuild }))');
  ok(/runLifecycleExclusive\(\(\) => initIndex\(\{ forceRebuild \}\)\)/.test(server),
    'the startup index build runs through the lifecycle lock (serializes with switch/rebuild/upload)');
  ok(watchAt < initIndexAt,
    'the stdin watch is armed BEFORE the startup index build (a stalled rebuild cannot leave the sidecar unsupervised)');
  ok(/process\.stdin\.on\('end'/.test(server),
    'the server treats stdin EOF (parent pipe closed) as a shutdown');
  ok(/line === 'quit'/.test(server),
    'the server honors a cooperative "quit" line');
  ok(/process\.stdin\.isTTY/.test(server),
    'the watch is skipped for an interactive terminal');

  // ── Desktop shell (main.rs) ──
  const mainRs = path.join(PROJECT, 'src-tauri', 'src', 'main.rs');
  if (fs.existsSync(mainRs)) {
    const rs = fs.readFileSync(mainRs, 'utf-8');
    ok(/Stdio::piped\(\)/.test(rs), 'the shell pipes the sidecar stdin (kept open to carry EOF on exit)');
    ok(/write_all\(b"quit/.test(rs), 'the shell sends a cooperative "quit" line on stop');
    ok(/"--desktop"/.test(rs), 'the shell marks the launch with --desktop');
    ok(/tauri_plugin_single_instance::init/.test(rs), 'the shell enforces a single instance (no second app + sidecar)');

    // Closing the window must quit the whole app on every platform. Without app.exit(0), macOS keeps the
    // process alive after the last window closes (its platform default), leaving the app running with no
    // window and a sidecar that was just stopped — the Dock icon does nothing and the quit-and-reopen step
    // needed to apply a setting can never complete. And the "Keep working" choice on the busy prompt must
    // prevent the close and return BEFORE any exit, or a user who declines to quit is quit anyway.
    ok(/if let WindowEvent::CloseRequested[\s\S]*?app\.exit\(0\)/.test(rs),
      'closing the window quits the whole app (no macOS orphan-window-with-dead-sidecar)');
    ok(/if confirm_keep_working\(app\) \{\s*api\.prevent_close\(\);\s*return;/.test(rs),
      'the "Keep working" choice prevents the close and returns before the app exits');
    // The busy confirmation is shared and also applied to macOS Cmd+Q / app-menu Quit (RunEvent::ExitRequested),
    // not just window close — otherwise Cmd+Q aborts an in-flight index/answer with no prompt.
    ok(/fn confirm_keep_working\(app: &tauri::AppHandle\) -> bool/.test(rs),
      'the busy confirmation is a shared helper');
    ok(/RunEvent::ExitRequested \{ api, \.\. \} =>[\s\S]*?confirm_keep_working\(app\)[\s\S]*?api\.prevent_exit\(\)/.test(rs),
      'Cmd+Q / app-menu Quit honors the same busy confirmation');

    // The shell's patience before SIGKILL must be STRICTLY LONGER than the sidecar's own graceful
    // hard timeout (lib/shutdown.js HARD_TIMEOUT_MS). If they were equal, a slow-but-valid teardown
    // could be force-killed at the same instant the server runs its `exit` handler, skipping the
    // synchronous orphan sweep that kills any child browser or parse helper — the exact orphaning the
    // whole stdin-EOF/quit design exists to prevent. Parse both and assert the ordering.
    const loopM = rs.match(/for _ in 0\.\.(\d+)\s*\{[\s\S]*?from_millis\((\d+)\)[\s\S]*?child\.kill\(\)/);
    ok(loopM, 'the shell has a bounded wait loop before force-killing the sidecar');
    const rustWindowMs = parseInt(loopM[1], 10) * parseInt(loopM[2], 10);
    const shutdown = fs.readFileSync(path.join(PROJECT, 'lib', 'shutdown.js'), 'utf-8');
    const hardM = shutdown.match(/HARD_TIMEOUT_MS\s*=\s*(\d+)/);
    ok(hardM, 'lib/shutdown.js defines HARD_TIMEOUT_MS');
    const nodeHardMs = parseInt(hardM[1], 10);
    ok(rustWindowMs > nodeHardMs,
      `the shell force-kill window (${rustWindowMs}ms) is strictly longer than the sidecar graceful cap (${nodeHardMs}ms), so the orphan sweep always runs before SIGKILL`);

    // A FAILED spawn (missing/quarantined runtime, dropped exec bit, corrupt bundle) must show the startup
    // dialog, not .expect()-abort under panic="abort" (which vanishes the app with no window and no message).
    // The sidecar spawn is single-sourced in a helper so the first launch and the bind-race respawn build
    // the child identically (same stdin pipe, same per-platform teardown wiring).
    ok(/fn spawn_server\(/.test(rs), 'the sidecar spawn is single-sourced in spawn_server()');
    ok(!/\.spawn\(\)\.expect\(/.test(rs), 'the shell does not .expect() on spawn (which would abort silently)');
    ok(/match spawn_server\([\s\S]*?Err\(e\)[\s\S]*?show_startup_error\(/.test(rs),
      'a spawn failure logs and shows the startup-error dialog instead of aborting');
    // Closing the window DURING startup (the up-to-60s wait) must exit quietly, not pop a spurious
    // "could not start" dialog — the startup loop treats an absent child (a shutdown took it) as a quiet
    // return, and a genuine startup failure flows through Step::Fail to the dialog.
    ok(/if guard\.is_none\(\) \{ return; \}/.test(rs) && /Step::Fail[\s\S]*?show_startup_error/.test(rs),
      'the startup wait treats a window-close-during-startup as a quiet shutdown, not a startup failure');

    // ── Port bind-race recovery (respawn) ──
    // If the sidecar exits before it listens (commonly a port grabbed between the free-check and listen), the
    // readiness thread picks a fresh port, rewrites the marker, and respawns — bounded. The respawn happens in
    // place while holding the state lock (reap-before-respawn), so a concurrent stop can never leave two
    // sidecars alive. This recovers an EADDRINUSE race instead of dying with a startup dialog.
    ok(/const MAX_RESPAWNS: u8 = \d+/.test(rs), 'the bind-race respawn is bounded by a MAX_RESPAWNS cap');
    ok(/respawns < MAX_RESPAWNS[\s\S]*?free_port\(\)[\s\S]*?desktop-port[\s\S]*?spawn_server\(/.test(rs),
      'an early sidecar exit respawns on a fresh free port (rewriting the marker) up to the cap');
    ok(/let dead = matches!\(guard[\s\S]*?respawns < MAX_RESPAWNS[\s\S]*?\*guard = Some\(\(c, new_port\)\)/.test(rs),
      'the respawn replaces the dead child in shared state under the lock (never two sidecars alive)');

    // ── Windows force-kill tears down the whole process tree (no orphaned OCR/Chromium helpers) ──
    // A plain kill on Windows is TerminateProcess on the single process; taskkill /T kills the tree so a wedged
    // sidecar's helpers cannot survive the force-kill. Unix relies on the sidecar's own sweep + PDEATHSIG.
    ok(/#\[cfg\(windows\)\][\s\S]*?taskkill[\s\S]*?"\/PID"[\s\S]*?"\/T", "\/F"/.test(rs),
      'the Windows force-kill uses taskkill /T /F to terminate the whole sidecar process tree');
  } else {
    console.log('  (src-tauri/main.rs not present — skipping shell-side checks)');
  }

  console.log('✓ supervisor-order: the desktop stdin-EOF watch is armed early and the shell pipes stdin + sends quit');
  console.log(`\nALL SUPERVISOR-ORDER UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ SUPERVISOR-ORDER UNIT TEST FAILED:', e.message);
  process.exit(1);
}
