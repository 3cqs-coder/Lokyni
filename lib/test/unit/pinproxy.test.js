'use strict';
// Guards the loopback vetting proxy (lib/pinproxy.js) that pins every browser connection during URL
// ingestion. The security-critical property is that it REFUSES a private/internal target — loopback, the
// localhost name, and the cloud-metadata address — on the CONNECT (HTTPS) path, so a rebound or embedded
// subresource can never reach an internal endpoint through it. It must also start/stop cleanly and not keep
// the process alive. The refusal paths need no network (private literals and the localhost name are judged
// without DNS); the public-tunnel success path is covered by the live browser end-to-end, not here.
// Run: `npm run test:unit`.

const net = require('net'), assert = require('assert'), path = require('path');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { ensureProxy, stopProxy } = require(path.join(PROJECT, 'lib', 'pinproxy'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

// Send one request line to the proxy and resolve with its first response line.
const sendLine = (port, line, timeoutMs = 4000) => new Promise((resolve) => {
  const c = net.connect(port, '127.0.0.1');
  let data = '';
  const done = (r) => { try { c.destroy(); } catch {} resolve(r); };
  c.on('connect', () => c.write(line));
  c.on('data', (d) => { data += d.toString(); if (data.includes('\r\n')) done(data.split('\r\n')[0]); });
  c.on('error', (e) => done('ERR ' + e.code));
  setTimeout(() => done('TIMEOUT'), timeoutMs);
});

(async () => {
  try {
    const port = await ensureProxy();
    ok(Number.isInteger(port) && port > 0, 'ensureProxy starts and returns a loopback port');
    ok(await ensureProxy() === port, 'ensureProxy is idempotent (one shared proxy, same port)');

    // ── refuses every internal target on CONNECT ──
    for (const authority of ['127.0.0.1:80', 'localhost:80', '169.254.169.254:80', '10.0.0.1:443', '[::1]:443']) {
      const status = await sendLine(port, `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
      ok(/^HTTP\/1\.1 403/.test(status), `CONNECT ${authority} is refused (got "${status}")`);
    }
    // ── refuses an internal plain-HTTP target too ──
    const httpStatus = await sendLine(port, 'GET http://127.0.0.1/secret HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    ok(/^HTTP\/1\.1 403/.test(httpStatus), `plain-HTTP to loopback is refused (got "${httpStatus}")`);
    // ── a malformed request line is rejected, not tunneled ──
    const bad = await sendLine(port, 'GARBAGE not-a-real-request\r\n\r\n');
    ok(/^HTTP\/1\.1 400/.test(bad), `a malformed request is rejected with 400 (got "${bad}")`);
    console.log('✓ pinproxy: refuses loopback/localhost/metadata/private targets on CONNECT and plain HTTP');

    // ── clean teardown ──
    stopProxy();
    const afterStop = await sendLine(port, 'CONNECT 8.8.8.8:443 HTTP/1.1\r\n\r\n', 1500);
    ok(afterStop.startsWith('ERR') || afterStop === 'TIMEOUT', 'after stopProxy the listener is gone (connection refused)');
    stopProxy();   // idempotent, no throw
    console.log('✓ pinproxy: starts once, tears down cleanly, and is idempotent');

    console.log(`\nALL PINPROXY UNIT TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    try { stopProxy(); } catch {}
    console.error('\n✗ PINPROXY UNIT TEST FAILED:', e && e.message);
    process.exit(1);
  }
})();
