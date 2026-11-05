'use strict';
// Offline check for the DNS-rebinding Host guard (server.isLoopbackHostHeader). When the server
// is bound to loopback, only a loopback Host is legitimate; a rebinding attack sends a public
// hostname yet reaches 127.0.0.1. The matcher must accept every real loopback spelling — with or
// without a port, bracketed or bare, and any spelling of the IPv6 loopback — while rejecting
// public hosts, so a legitimate desktop-app/PWA request is never wrongly 403'd and an attacker's
// Host never slips through. No model or network. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
// isLoopbackHostHeader now lives in lib/hostguard.js (shared by the HTTP guard and the socket.io
// data channel); server.js re-exports it. Test the shared module directly.
const { isLoopbackHostHeader, isAllowedHost, isSameOriginRequest } = require(path.join(PROJECT, 'lib', 'hostguard'));
const cfg = require(path.join(PROJECT, 'lib', 'config'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

(async () => {
  try {
    // ── loopback forms that MUST be accepted ──
    const accept = [
      'localhost', 'localhost:3131',
      '127.0.0.1', '127.0.0.1:8080', '127.5.6.7',
      '::1', '[::1]', '[::1]:3131',
      // Expanded / zero-padded / partially-compressed IPv6 loopback, with and without a port.
      '0:0:0:0:0:0:0:1', '[0:0:0:0:0:0:0:1]:3131',
      '0000:0000:0000:0000:0000:0000:0000:0001',
      '[0000:0000:0000:0000:0000:0000:0000:0001]:9999',
      '0::1', '[0::1]:1234',
    ];
    for (const h of accept) ok(isLoopbackHostHeader(h) === true, `accepts loopback Host: ${h}`);

    // ── non-loopback / malformed forms that MUST be rejected ──
    const reject = [
      '', 'evil.com', 'evil.com:3131', 'example.org',
      '10.0.0.5', '192.168.1.2:3131', '169.254.1.1', '128.0.0.1',
      '::2', '[::2]:3131', 'fe80::1', '[fe80::1]:80', '2001:db8::1',
      // A public host that merely CONTAINS "localhost" or "127.0.0.1" must not pass.
      'localhost.evil.com', 'notlocalhost', '127.0.0.1.evil.com',
    ];
    for (const h of reject) ok(isLoopbackHostHeader(h) === false, `rejects non-loopback Host: ${h}`);

    // ── isAllowedHost: the shared decision used by BOTH the Express guard and the socket.io
    // allowRequest, so the /ws data channel gets the same DNS-rebinding protection ──
    const savedBind = cfg.BIND_ADDRESS, savedTrusted = cfg.TRUSTED_HOSTS, savedEnforce = cfg.ENFORCE_HOST_GUARD;
    try {
      cfg.ENFORCE_HOST_GUARD = false;
      cfg.BIND_ADDRESS = '127.0.0.1'; cfg.TRUSTED_HOSTS = [];
      ok(isAllowedHost('127.0.0.1:7887') === true, 'loopback bind: a loopback Host is allowed');
      ok(isAllowedHost('evil.com') === false, 'loopback bind: a rebinding public Host is refused (this is the /ws hole that was closed)');
      cfg.TRUSTED_HOSTS = ['lokyni.example.com'];
      ok(isAllowedHost('lokyni.example.com') === true, 'a configured trustedHosts entry is allowed');
      ok(isAllowedHost('evil.com') === false, 'a non-trusted public Host is still refused');
      cfg.BIND_ADDRESS = '0.0.0.0'; cfg.TRUSTED_HOSTS = [];
      ok(isAllowedHost('anything.example') === true, 'network bind: the guard is off (user opted into exposure)');

      // enforce-host-guard: a container binds 0.0.0.0 for its published port but must still reject a
      // rebinding Host. With the flag on, the guard behaves as if bound to loopback regardless of bind.
      cfg.ENFORCE_HOST_GUARD = true;
      cfg.BIND_ADDRESS = '0.0.0.0'; cfg.TRUSTED_HOSTS = [];
      ok(isAllowedHost('127.0.0.1:7887') === true, 'enforced + 0.0.0.0 bind: a loopback Host is allowed (published-port access + healthcheck)');
      ok(isAllowedHost('evil.com') === false, 'enforced + 0.0.0.0 bind: a rebinding public Host is refused (the Docker exposure that was closed)');
      cfg.TRUSTED_HOSTS = ['lokyni.example.com'];
      ok(isAllowedHost('lokyni.example.com') === true, 'enforced: a configured trustedHosts entry is allowed (reverse proxy)');
      ok(isAllowedHost('evil.com') === false, 'enforced: a non-trusted public Host is still refused');
    } finally {
      cfg.BIND_ADDRESS = savedBind; cfg.TRUSTED_HOSTS = savedTrusted; cfg.ENFORCE_HOST_GUARD = savedEnforce;
    }

    // ── isSameOriginRequest: the cross-site defense shared by the HTTP control plane and the
    // socket.io handshake. It is what closes cross-site WebSocket hijacking — browsers do not apply
    // the same-origin policy to WebSocket connections, so a hostile page could otherwise open the
    // /ws channel with a legitimate loopback Host and read the user's documents. ──

    // A non-browser client sends neither header → allowed (it is authenticated elsewhere by key).
    ok(isSameOriginRequest({}) === true, 'no Origin and no Sec-Fetch-Site is allowed (non-browser client)');
    ok(isSameOriginRequest({ host: '127.0.0.1:7887' }) === true, 'Host alone (no Origin) is allowed');

    // Sec-Fetch-Site is authoritative when present.
    ok(isSameOriginRequest({ 'sec-fetch-site': 'same-origin' }) === true, 'Sec-Fetch-Site same-origin allowed');
    ok(isSameOriginRequest({ 'sec-fetch-site': 'none' }) === true, 'Sec-Fetch-Site none (top-level navigation) allowed');
    ok(isSameOriginRequest({ 'sec-fetch-site': 'cross-site' }) === false, 'Sec-Fetch-Site cross-site refused (the WS hijacking case)');
    ok(isSameOriginRequest({ 'sec-fetch-site': 'same-site' }) === false, 'Sec-Fetch-Site same-site (other origin) refused');
    // Sec-Fetch-Site wins even if a forged Origin happens to match the Host.
    ok(isSameOriginRequest({ 'sec-fetch-site': 'cross-site', origin: 'http://127.0.0.1:7887', host: '127.0.0.1:7887' }) === false,
      'Sec-Fetch-Site cross-site refused even when Origin matches Host');

    // Older browsers without Sec-Fetch-Site fall back to Origin-vs-Host.
    ok(isSameOriginRequest({ origin: 'http://127.0.0.1:7887', host: '127.0.0.1:7887' }) === true, 'Origin host matching Host allowed');
    ok(isSameOriginRequest({ origin: 'https://evil.com', host: '127.0.0.1:7887' }) === false, 'Origin host not matching Host refused');
    ok(isSameOriginRequest({ origin: 'not a url', host: '127.0.0.1:7887' }) === false, 'a malformed Origin is refused');

    console.log(`\nALL HOST-GUARD UNIT TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ HOST-GUARD UNIT TEST FAILED:', e.message);
    process.exit(1);
  }
})();
