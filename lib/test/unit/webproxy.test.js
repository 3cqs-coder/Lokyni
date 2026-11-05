'use strict';
// Tests the optional outbound (egress) proxy with a rotating pool and retry-on-block (lib/webproxy.js) plus
// its wiring. The selection and retry logic are pure given config + env, so they are tested directly:
// parse a pool (one per line / comma / space, deduped, normalized), opt-in rotation (off by default -> first
// proxy; on -> round-robin), attempt-based selection that advances to the next proxy on a retry regardless
// of rotation, and runWithProxy() which retries a thrown/blocked attempt through the next proxy up to the
// tunable count (and runs exactly once, direct, when no proxy is configured). Integration into the fetch and
// headless paths is source-guarded. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(PROJECT, ...p), 'utf-8');
const wp = require(path.join(PROJECT, 'lib', 'webproxy'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };
const deq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };

// Stub config so the live reads resolve to our values; restore after.
const cfgPath = require.resolve(path.join(PROJECT, 'lib', 'config'));
const realCfg = require(cfgPath);
const stub = Object.assign(Object.create(Object.getPrototypeOf(realCfg)), realCfg);
const envKeys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
const savedEnv = {};
for (const k of envKeys) { savedEnv[k] = process.env[k]; delete process.env[k]; }
require.cache[cfgPath].exports = stub;
const set = (o) => Object.assign(stub, o);

(async () => {
  try {
    // ── parsePool / normalize ──
    eq(wp.normalizeProxyUrl('1.2.3.4:8080'), 'http://1.2.3.4:8080', 'a bare host:port defaults to http://');
    deq(wp.parsePool('http://a:1\nhttp://b:2 , http://a:1'), ['http://a:1', 'http://b:2'],
      'pool splits on newline/comma/space, normalizes, and de-duplicates (order kept)');
    deq(wp.parsePool(''), [], 'empty -> empty pool');

    // ── getWebProxyUrls: config pool wins; env single-value fallback ──
    set({ WEB_PROXY_URL: '', WEB_PROXY_ROTATE: false, WEB_PROXY_RETRIES: 2 });
    deq(wp.getWebProxyUrls(), [], 'no config + no env -> direct');
    process.env.HTTP_PROXY = 'proxy.corp:3128';
    deq(wp.getWebProxyUrls(), ['http://proxy.corp:3128'], 'env var is the fallback (normalized)');
    delete process.env.HTTP_PROXY;
    set({ WEB_PROXY_URL: 'http://p1:1\nhttp://p2:2' });
    deq(wp.getWebProxyUrls(), ['http://p1:1', 'http://p2:2'], 'the configured pool wins over the environment');

    // ── rotation is OPT-IN: off -> always first; a retry still advances ──
    set({ WEB_PROXY_ROTATE: false });
    eq(wp.nextProxyUrl(), 'http://p1:1', 'rotation off: base pick is the first proxy');
    eq(wp.nextProxyUrl(), 'http://p1:1', 'rotation off: still the first on the next call');
    const offPick = wp.makePicker();
    eq(offPick(0), 'http://p1:1', 'rotation off: a picker starts at the first proxy');
    eq(offPick(1), 'http://p2:2', 'a retry advances to the next proxy even when rotation is off');

    // ── rotation ON: round-robin across the pool ──
    set({ WEB_PROXY_ROTATE: true });
    const seq = [wp.nextProxyUrl(), wp.nextProxyUrl(), wp.nextProxyUrl(), wp.nextProxyUrl()];
    deq(seq, ['http://p1:1', 'http://p2:2', 'http://p1:1', 'http://p2:2'], 'rotation on: round-robins the pool');

    // ── per-request picker captures its OWN base (concurrency-safe): a later picker advancing the cursor
    //    does not make an earlier picker's retry reuse the just-failed proxy ──
    set({ WEB_PROXY_ROTATE: true });
    const pA = wp.makePicker();   // base = current cursor (say i)
    const pB = wp.makePicker();   // base = i+1 (cursor advanced) — must NOT disturb pA
    ok(pA(0) !== pA(1), 'picker A: a retry moves to a different proxy than its own base');
    ok(pB(0) !== pB(1), 'picker B: likewise, independent of A');
    eq(pA(1), (wp.getWebProxyUrls().indexOf(pA(0)) === 0 ? wp.getWebProxyUrls()[1] : wp.getWebProxyUrls()[0]),
      "picker A's retry advances from A's OWN base, unaffected by B");

    // ── getProxyRetries: tunable + clamped ──
    set({ WEB_PROXY_RETRIES: 3 }); eq(wp.getProxyRetries(), 3, 'retries read from config');
    set({ WEB_PROXY_RETRIES: 99 }); eq(wp.getProxyRetries(), 10, 'retries clamped to the max');
    set({ WEB_PROXY_RETRIES: -5 }); eq(wp.getProxyRetries(), 0, 'a negative retry count floors at 0');

    // ── runWithProxy: retry-on-block through the next proxy ──
    set({ WEB_PROXY_URL: 'http://p1:1\nhttp://p2:2', WEB_PROXY_ROTATE: false, WEB_PROXY_RETRIES: 2 });
    let calls;
    // Always throws -> exhausts tries (retries+1 = 3), then re-throws.
    calls = 0;
    await assert.rejects(() => wp.runWithProxy(async () => { calls++; throw new Error('blocked'); }),
      /blocked/, 'exhausting all proxies re-throws the last error');
    eq(calls, 3, 'a throwing attempt is retried retries+1 times (3)');
    // Blocked status then OK -> stops at the first good result.
    calls = 0;
    const r = await wp.runWithProxy(async () => { calls++; return { status: calls === 1 ? 429 : 200 }; },
      { isBlocked: (res) => res && res.status === 429 });
    eq(r.status, 200, 'a blocked status is retried and the good result returned');
    eq(calls, 2, 'the attempt advanced to the next proxy after the block');

    // ── no proxy configured: exactly one direct attempt, dispatcher null, retries ignored ──
    set({ WEB_PROXY_URL: '', WEB_PROXY_RETRIES: 5 });
    calls = 0;
    let sawDispatcher = 'unset';
    const r2 = await wp.runWithProxy(async (d) => { calls++; sawDispatcher = d; return { status: 403 }; },
      { isBlocked: (res) => res && res.status === 403 });
    eq(calls, 1, 'with no proxy, the attempt runs exactly once even on a "blocked" result');
    eq(sawDispatcher, null, 'with no proxy, the dispatcher is null (direct)');
    eq(r2.status, 403, 'the single direct result is returned as-is');

    // ── a blocked result's body is cancelled before the retry (no keep-alive socket leak) ──
    set({ WEB_PROXY_URL: 'http://p1:1\nhttp://p2:2', WEB_PROXY_RETRIES: 1 });
    let cancelled = 0;
    await wp.runWithProxy(async () => ({ status: 200, body: { cancel: () => { cancelled++; } } }),
      { isBlocked: (() => { let n = 0; return () => (++n === 1); })() });   // block the first result only
    eq(cancelled, 1, 'the blocked response body is cancelled before retrying');

    // ── Integration source-guards ──
    const nethost = read('lib', 'nethost.js');
    ok(/fetchNoPrivateRedirect = async \(startUrl, fetchImpl, maxHops = 5, proxyDispatcher = null\)/.test(nethost),
      'fetchNoPrivateRedirect takes a per-attempt proxy dispatcher');
    // SSRF: the proxied branch STILL vets the target host (refuses a private/loopback target even via a proxy).
    ok(/if \(proxyDispatcher\) \{[\s\S]{0,600}?await resolvePublicHost\(new URL\(current\)\.hostname\);/.test(nethost),
      'the proxied path still refuses a private/loopback target (SSRF guard not dropped when a proxy is set)');
    const websearch = read('lib', 'websearch.js');
    ok((websearch.match(/runWithProxy\(/g) || []).length >= 2, 'both the search and page-fetch paths run through runWithProxy');
    ok(/status === 403 \|\| r\.status === 429 \|\| r\.status === 503/.test(websearch), 'a blocked HTTP status triggers a proxy retry');
    const urlfetch = read('lib', 'urlfetch.js');
    ok(/const pickProxy = webproxy\.makePicker\(\);/.test(urlfetch), 'the headless capture uses a per-capture proxy picker');
    ok(/const proxyUrl = pickProxy\(attempt\);/.test(urlfetch) && /captureHtml\(urlObj\.href, signal, proxyUrl\)/.test(urlfetch), 'each capture attempt uses the next proxy');
    ok(/webproxy\.recordExit\(proxyUrl, html \? \(blocked \? 'blocked' : 'ok'\) : 'dead'\)/.test(urlfetch), 'the capture path records each exit\'s health (closing the one-path-only gap)');
    ok(/for \(let attempt = 0; attempt <= captureRetries; attempt\+\+\)/.test(urlfetch), 'URL ingestion retries the capture through the next proxy');

    console.log(`\nALL WEBPROXY TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ WEBPROXY UNIT TEST FAILED:', e && e.message);
    process.exit(1);
  } finally {
    require.cache[cfgPath].exports = realCfg;
    for (const k of envKeys) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  }
})();
