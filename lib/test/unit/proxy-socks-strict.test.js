'use strict';
// Guards SOCKS egress support on the plain-fetch path and strict no-leak mode (lib/socksdispatcher.js,
// lib/webproxy.js). SOCKS: a socks:// proxy builds a real undici Agent (undici's own ProxyAgent is
// HTTP-CONNECT only), and garbage yields null rather than throwing. Strict: when a proxy is configured but
// no usable dispatcher can be built, the request FAILS rather than silently connecting directly — unless
// strict is off, in which case it degrades to direct as before. Offline: no real SOCKS/network I/O.
// Run: `npm run test:unit` (or `node lib/test/unit/proxy-socks-strict.test.js`).

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { makeSocksAgent } = require(path.join(PROJECT, 'lib', 'socksdispatcher'));
const { Agent } = require('undici');
const cfg = require(path.join(PROJECT, 'lib', 'config'));
const wp = require(path.join(PROJECT, 'lib', 'webproxy'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

const run = async () => {
  // ── SOCKS agent construction ──
  for (const u of ['socks5://1.2.3.4:1080', 'socks4://1.2.3.4:1080', 'socks5h://host:1080', 'socks://user:pass@h:1080']) {
    const a = makeSocksAgent(u);
    ok(a instanceof Agent, `builds an undici Agent for ${u}`);
    try { await a.close(); } catch { /* best-effort cleanup */ }
  }
  ok(makeSocksAgent('not a url') === null, 'garbage input yields null, not a throw');
  ok(makeSocksAgent('') === null, 'empty input yields null');

  // ── Strict no-leak: a configured-but-unusable proxy fails closed instead of going direct ──
  const saved = { url: cfg.WEB_PROXY_URL, strict: cfg.WEB_PROXY_STRICT, retries: cfg.WEB_PROXY_RETRIES, rotate: cfg.WEB_PROXY_ROTATE };
  try {
    cfg.WEB_PROXY_URL = 'http://';     // a configured proxy whose dispatcher cannot be built (no host)
    cfg.WEB_PROXY_RETRIES = 0;

    // Strict ON: the attempt must never run (no direct connection), and the call fails closed.
    cfg.WEB_PROXY_STRICT = true;
    let ran = false;
    let threw = null;
    try { await wp.runWithProxy(async () => { ran = true; return { ok: true }; }); }
    catch (e) { threw = e; }
    ok(!ran, 'strict mode never runs a direct attempt when the proxy is unusable');
    ok(threw && threw.proxyRequired === true, 'strict mode fails closed with a proxyRequired error');

    // Strict OFF: the same unusable proxy degrades to a direct attempt (prior behavior preserved).
    cfg.WEB_PROXY_STRICT = false;
    let ranDirect = false;
    const res = await wp.runWithProxy(async (dispatcher) => { ranDirect = true; return { ok: true, dispatcher }; });
    ok(ranDirect && res && res.ok, 'non-strict mode falls back to a direct attempt');
    ok(res.dispatcher == null, 'the fallback attempt gets a null (direct) dispatcher');

    // Strict ON, MIXED pool: exit A is unusable (no dispatcher) but exit B is usable. The request must
    // SKIP A and succeed on B — not fail closed when a healthy exit exists. (Rotation off so A is first.)
    cfg.WEB_PROXY_STRICT = true;
    cfg.WEB_PROXY_ROTATE = false;
    cfg.WEB_PROXY_URL = 'http://\nhttp://good.example:8080';   // A = unbuildable, B = a real ProxyAgent
    cfg.WEB_PROXY_RETRIES = 2;
    const seen = [];
    const mixed = await wp.runWithProxy(async (dispatcher) => { seen.push(!!dispatcher); return { ok: true, viaProxy: !!dispatcher }; });
    ok(mixed && mixed.ok && mixed.viaProxy === true, 'strict mode skips the unusable exit and succeeds on a healthy one (never direct)');
    ok(seen.length === 1 && seen[0] === true, 'the attempt ran exactly once, on the usable exit, with a real dispatcher');
  } finally {
    cfg.WEB_PROXY_URL = saved.url; cfg.WEB_PROXY_STRICT = saved.strict; cfg.WEB_PROXY_RETRIES = saved.retries; cfg.WEB_PROXY_ROTATE = saved.rotate;
  }

  console.log(`\nALL PROXY-SOCKS-STRICT TESTS PASSED (${checks} checks)`);
  process.exit(0);
};

run().catch((e) => { console.error('\n✗ PROXY-SOCKS-STRICT UNIT TEST FAILED:', e && e.message); process.exit(1); });
