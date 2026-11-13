'use strict';
// Decide whether this process should exit when its LAUNCHER goes away, so a supervised or background
// start can never be left orphaned — holding the port and data directory and, with several stacked up,
// corrupting the tamper-evident audit log through concurrent writes.
//
// The universal, cross-platform signal that "the launcher is gone" is our end of stdin reaching EOF: a
// parent that spawns us keeps the write end of a pipe or socket open for its lifetime, so the OS closes
// it on ANY exit of that parent (normal, crash, kill) on every platform. lokyni.js watches for that EOF
// and shuts down gracefully. This module decides, from a few observable facts, WHEN that watch should be
// armed — the logic is separated here as a pure predicate so it can be unit-tested without a live process.
//
// It must arm for a supervised start (the desktop sidecar, a test harness, a background boot whose parent
// holds a pipe/socket) and must NEVER arm for a real background SERVICE, which is meant to outlive any
// launcher. The three exclusions below cover every supported service launch:
//   • an interactive terminal (stdin is a TTY): the user drives it and Ctrl-C already stops it;
//   • a Node IPC channel is present (process.send is defined): pm2's fork and cluster modes and node's own
//     fork() attach an IPC channel and keep the pipe stdin only for logging, so its EOF is not a
//     "parent gone" signal — arming here would stop a pm2-managed server the moment pm2 closed that pipe;
//   • stdin is a character device (/dev/null, the default for systemd, launchd, and a non-interactive
//     Docker container) or a redirected regular file: both give an immediate EOF that must not stop a
//     service, and neither means a parent is actively holding the other end.
// Only a pipe (FIFO) or a socket — an open channel a living parent holds — arms the watch.

const fs = require('fs');

// Pure predicate over the observable facts, so the full truth table is unit-testable:
//   isTTY  — process.stdin.isTTY
//   hasIpc — Boolean(process.send)   (a Node IPC channel: pm2 fork/cluster, node fork)
//   kind   — the classified type of stdin fd 0 (see stdinKind)
function exitsWithParent({ isTTY, hasIpc, kind }) {
  if (isTTY) return false;                        // interactive terminal — the user drives it
  if (hasIpc) return false;                       // pm2/fork manage lifecycle over IPC, not stdin EOF
  return kind === 'fifo' || kind === 'socket';    // a living parent holds the other end of a pipe/socket
}

// Classify stdin (fd 0). Returns 'none' when it can't be read (closed or unusable), which is treated as
// "not supervised" — the safe default that never stops a running server.
function stdinKind() {
  try {
    const st = fs.fstatSync(0);
    if (st.isFIFO()) return 'fifo';
    if (st.isSocket()) return 'socket';
    if (st.isCharacterDevice()) return 'char';    // a TTY or /dev/null
    if (st.isFile()) return 'file';               // a redirected regular file
    return 'other';
  } catch { return 'none'; }                       // fd 0 closed/unusable — do not arm
}

module.exports = { exitsWithParent, stdinKind };
