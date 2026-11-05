'use strict';
// Guards the MCP client's cancelling timeout (lib/mcp/client.js). A hung or slow MCP server must never
// hang Lokyni, and when we give up on a request we must actually CANCEL it (abort the AbortSignal, which
// makes the SDK reject the pending request and send notifications/cancelled) rather than leave it in
// flight until the whole connection is torn down. This verifies:
//   • withTimeout rejects after the deadline and runs its onTimeout hook first;
//   • a fast operation resolves and is NOT cancelled;
//   • withCancelTimeout hands fn an AbortSignal and aborts it exactly when the timeout fires;
//   • the three SDK call sites pass a { signal } through (connect/listTools/callTool).
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const client = require(path.join(PROJECT, 'lib', 'mcp', 'client'));
const { _withTimeout, _withCancelTimeout } = client;

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

(async () => {
  // withTimeout's internal timer is unref'd (so it never keeps the real server alive). In this isolated
  // test there is otherwise no ref'd work, so Node would exit before a 20ms timer fires — hold one ref'd
  // timer for the duration so the unref'd deadlines actually run, mirroring a live process.
  const keepAlive = setInterval(() => {}, 1000);
  const done = (code) => { clearInterval(keepAlive); process.exitCode = code; };
  try {
    // ── withTimeout: a never-settling promise rejects after ms, and onTimeout runs before the reject ──
    let hookRan = false;
    const started = Date.now();
    await assert.rejects(
      _withTimeout(new Promise(() => {}), 20, 'timed out', () => { hookRan = true; }),
      /timed out/, 'a never-settling promise is rejected with the message');
    ok(hookRan, 'onTimeout runs when the deadline fires');
    ok(Date.now() - started >= 15, 'the rejection waits for the deadline (not immediate)');

    // ── withTimeout: a promise that settles in time resolves and does NOT run onTimeout ──
    let hook2 = false;
    const val = await _withTimeout(Promise.resolve('ok'), 1000, 'nope', () => { hook2 = true; });
    ok(val === 'ok', 'an in-time promise resolves to its value');
    ok(hook2 === false, 'onTimeout does not run when the promise settles in time');

    // ── withCancelTimeout: fn receives a signal; on timeout it is aborted ──
    let capturedSignal = null;
    await assert.rejects(
      _withCancelTimeout((signal) => { capturedSignal = signal; return new Promise(() => {}); }, 20, 'call timed out'),
      /call timed out/, 'a hung call is rejected at the deadline');
    ok(capturedSignal && typeof capturedSignal.aborted === 'boolean', 'fn is handed an AbortSignal');
    ok(capturedSignal.aborted === true, 'the signal is aborted when the timeout fires (the SDK request is cancelled)');

    // ── withCancelTimeout: a fast call resolves and its signal is NOT aborted ──
    let fastSignal = null;
    const fastVal = await _withCancelTimeout((signal) => { fastSignal = signal; return Promise.resolve(42); }, 1000, 'nope');
    ok(fastVal === 42, 'a fast call resolves to its value');
    ok(fastSignal && fastSignal.aborted === false, 'a resolved call leaves its signal un-aborted (no needless cancel)');

    // ── source guards: the three SDK calls forward a { signal } so cancellation actually reaches them ──
    const src = fs.readFileSync(path.join(PROJECT, 'lib', 'mcp', 'client.js'), 'utf-8');
    ok(/client\.connect\(transport, \{ signal \}\)/.test(src), 'connect forwards the abort signal');
    ok(/client\.listTools\(undefined, \{ signal \}\)/.test(src), 'listTools forwards the abort signal');
    ok(/client\.callTool\(\{ name, arguments: args \|\| \{\} \}, undefined, \{ signal \}\)/.test(src), 'callTool forwards the abort signal');

    console.log(`✓ mcp-client-timeout: a hung MCP request is cancelled at the deadline, a fast one is left alone (${checks} checks)`);
    // Clear the keep-alive and let the process exit naturally so buffered stdout isn't truncated by a
    // forced process.exit() when stdout is a pipe.
    done(0);
  } catch (e) {
    console.error('✗ mcp-client-timeout:', e && e.message);
    done(1);
  }
})();
