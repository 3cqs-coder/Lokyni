'use strict';
// Socket event-name drift guard. The critical turn-control events are single-sourced in lib/turncontrol.js
// (and turn-control.test.js asserts the browser fallbacks match byte-for-byte). The ~30 OTHER chat events are
// plain string literals on BOTH ends — renaming one side and not the other would silently drop that feature's
// messages, the exact failure turncontrol.js was built to prevent. This test catches that drift without a
// refactor, over the main chat channel (lib/socket.js ↔ lib/public/js/chat.js):
//   1. every event the server emits to the client has a browser listener,
//   2. every event the client emits to the server has a server listener,
//   3. every browser listener is fed by some server emit (no dead listener), allowing socket.io built-ins
//      and events emitted from other server modules (automations, indexing, graph).
// Turn-protocol events use the shared TURN_PROTOCOL constants, not literals, so they don't appear here — they
// are covered by turn-control.test.js. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

// socket.io lifecycle events the client listens for that no application code emits.
const BUILTINS = new Set(['connect', 'connect_error', 'disconnect', 'reconnect', 'reconnect_attempt', 'reconnect_error', 'reconnect_failed', 'connect_timeout', 'ping', 'pong']);

const setOf = (re, src) => new Set([...src.matchAll(re)].map((m) => m[1]));

try {
  const socketSrc = read('lib/socket.js');
  const chatSrc   = read('lib/public/js/chat.js');

  // Events reach the client two ways: a per-connection `client.emit('x')` and the `broadcast('x', …)` helper
  // (one event to every connected client). Count both as server→client emits.
  const EMIT_RE = /(?:\.emit|\bbroadcast)\('([a-z_]+)'/g;
  const serverEmits = setOf(EMIT_RE, socketSrc);                           // server → client (socket.js)
  const clientOns   = setOf(/socket\.on\('([a-z_]+)'/g, chatSrc);          // browser listeners
  const clientEmits = setOf(/socket\.emit\('([a-z_]+)'/g, chatSrc);        // client → server (chat.js)
  const serverOns   = setOf(/\.on\('([a-z_]+)'/g, socketSrc);             // server listeners (socket.js)

  // Every event the server emits must have a browser listener — a server rename can't silently drop a feature.
  for (const e of [...serverEmits].sort()) {
    ok(clientOns.has(e), `the browser listens for the server-emitted event '${e}' (socket.js emits it)`);
  }
  // Every event the client emits must have a server listener — the reverse direction.
  for (const e of [...clientEmits].sort()) {
    ok(serverOns.has(e), `the server listens for the client-emitted event '${e}' (chat.js emits it)`);
  }

  // No dead browser listener: every socket.on must be fed by SOME server emit (socket.js or another module —
  // automations/indexing/graph emit a few), unless it is a socket.io built-in.
  const libDir = path.join(PROJECT, 'lib');
  const walk = (dir, acc) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) { if (name !== 'test' && name !== 'public' && name !== 'node_modules') walk(p, acc); }
      else if (name.endsWith('.js')) acc.push(p);
    }
    return acc;
  };
  const allServerEmits = new Set();
  for (const p of walk(libDir, [])) {
    const s = fs.readFileSync(p, 'utf-8');
    for (const m of s.matchAll(/(?:\.emit|\bbroadcast)\('([a-z_]+)'/g)) allServerEmits.add(m[1]);
  }
  for (const e of [...clientOns].sort()) {
    if (BUILTINS.has(e)) continue;
    ok(allServerEmits.has(e), `the browser listener '${e}' is emitted by some server module (not a dead listener)`);
  }

  // Sanity: the sets are non-trivial, so a regex that silently stopped matching would fail loudly rather than
  // pass vacuously.
  ok(serverEmits.size >= 10 && clientOns.size >= 10 && clientEmits.size >= 5,
    `the scans found events (server→client ${serverEmits.size}, client listeners ${clientOns.size}, client→server ${clientEmits.size})`);

  console.log(`\nALL SOCKET-EVENT-NAME DRIFT CHECKS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ SOCKET-EVENT-NAME DRIFT TEST FAILED:', e && e.message);
  process.exit(1);
}
