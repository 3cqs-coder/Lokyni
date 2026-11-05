'use strict';
// Regression tests for the shared SSRF guard (lib/nethost.js): the server must refuse to
// fetch loopback, private/LAN, link-local (incl. cloud metadata), CGNAT, and obvious
// internal names, while allowing public hosts. URL ingestion and web search both rely on
// this, so a weakening here would open both. Pure logic — no network. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { isPrivateAddr, assertPublicHost, resolvePublicHost, pinnedDispatcher, fetchNoPrivateRedirect } = require(path.join(PROJECT, 'lib', 'nethost'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };
const refused = async (host) => { try { await assertPublicHost(host); return false; } catch { return true; } };

(async () => {
  try {
    // ── isPrivateAddr classifies literal addresses ──
    for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.255',
                      '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1',
                      // Link-local is fe80::/10 (fe80–febf), not just fe80; plus deprecated
                      // site-local fec0::/10 and the NAT64 well-known prefix (reaches IPv4 space).
                      'fe90::1', 'fea0::1', 'feb0::1', 'fec0::1', 'fed0::1', 'feff::1', '64:ff9b::7f00:1',
                      // IPv4-mapped in HEX form — the WHATWG URL parser normalizes ::ffff:127.0.0.1 to
                      // this, so the guard must classify it too (7f00:1 = 127.0.0.1, a9fe:a9fe =
                      // 169.254.169.254 metadata, 0a00:1 = 10.0.0.1).
                      '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:0a00:0001',
                      // IPv4-COMPATIBLE IPv6 (deprecated ::a.b.c.d / ::<hex>:<hex>) embeds a v4 that some
                      // stacks route to it, so it must be classified by that embedded address too — otherwise
                      // ::127.0.0.1 / ::169.254.169.254 (metadata) sail through as public (reachable via the
                      // bracket-stripping pin proxy). 7f00:1 = 127.0.0.1, a9fe:a9fe = 169.254.169.254.
                      '::127.0.0.1', '::7f00:1', '::169.254.169.254', '::a9fe:a9fe', '::10.0.0.1', '::0a00:1',
                      // A compat form embedding the reserved 0.0.0.0/8 "this network" block (e.g. ::2 = ::0.0.0.2)
                      // is non-routable — classified private (the safe direction for an SSRF guard).
                      '::2',
                      // FULLY-EXPANDED (non-canonical) forms must classify the same as their compressed spelling
                      // — the pin proxy's raw CONNECT can hand through a non-canonical host that never passed
                      // WHATWG URL normalization, so the guard classifies on the parsed bytes, not a prefix.
                      '0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:0', '0:0:0:0:0:ffff:127.0.0.1', '0:0:0:0:0:ffff:7f00:1',
                      'fe80:0:0:0:0:0:0:1', 'fec0:0:0:0:0:0:0:1', '64:ff9b:0:0:0:0:0:1', 'fe80::1%eth0',
                      // 6to4 (2002::/16) and Teredo (2001:0::/32) tunnel to IPv4 space, so a PRIVATE embedded v4
                      // must classify private — the same principle as IPv4-mapped/compat/NAT64 above. 6to4 embeds
                      // the v4 in bytes 2–5 (7f00:0001 = 127.0.0.1, a9fe:a9fe = 169.254.169.254, 0a00:0001 =
                      // 10.0.0.1); Teredo's client v4 is the last 32 bits bit-complemented (80ff:fffe = ~127.0.0.1).
                      '2002:7f00:0001::1', '2002:a9fe:a9fe::1', '2002:0a00:0001::1', '2001:0:0:0:0:0:80ff:fffe']) {
      ok(isPrivateAddr(ip) === true, `${ip} is private`);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111', 'fe00::1', '2001:db8::1',
                      // Public IPv4-mapped in both forms (808:808 = 8.8.8.8) must NOT be misread as private.
                      '::ffff:8.8.8.8', '::ffff:808:808',
                      // Public IPv4-COMPATIBLE forms must also stay public (the compat handling must not
                      // over-block a public embedded v4).
                      '::8.8.8.8', '::808:808',
                      // Expanded public forms must stay public (the byte classifier must not over-block them).
                      '2606:4700:4700:0:0:0:0:1111', '0:0:0:0:0:ffff:8.8.8.8',
                      // 6to4 / Teredo with a PUBLIC embedded v4 must stay public (0808:0808 = 8.8.8.8; Teredo
                      // client complement f7f7:f7f7 = ~8.8.8.8), and the 2001:db8 doc prefix is NOT Teredo.
                      '2002:0808:0808::1', '2001:0:0:0:0:0:f7f7:f7f7', '2001:db8::1']) {
      ok(isPrivateAddr(ip) === false, `${ip} is public`);
    }
    console.log('✓ nethost: isPrivateAddr classifies private vs public addresses');

    // ── assertPublicHost refuses internal targets ──
    for (const h of ['localhost', 'foo.localhost', 'thing.internal', 'box.local',
                     '127.0.0.1', '10.1.2.3', '192.168.0.5', '169.254.169.254']) {
      ok(await refused(h), `${h} is refused`);
    }
    console.log('✓ nethost: assertPublicHost refuses loopback/LAN/metadata/internal hosts');

    // ── assertPublicHost allows a public literal IP ──
    ok(!(await refused('8.8.8.8')), 'a public IP is allowed');
    // An unresolvable name is refused (fail closed): a name the guard can't resolve is one it
    // can't prove is public, and refusing it also removes a DNS-failure window an attacker could
    // use. A transient hiccup just means that page is skipped, which callers already tolerate.
    ok(await refused('nonexistent-host-that-will-not-resolve.invalid'), 'an unresolvable name is refused (fail closed)');
    console.log('✓ nethost: public IPs allowed; unresolvable names are refused (fail closed)');

    // ── fetchNoPrivateRedirect checks each hop BEFORE contacting it (redirect SSRF) ──
    // A private START host is refused before fetchImpl is ever called (no request is issued at all).
    let called = 0;
    const spyFetch = async () => { called++; return { status: 200, headers: { get: () => null } }; };
    let threw = false;
    try { await fetchNoPrivateRedirect('http://127.0.0.1:9/x', spyFetch); } catch { threw = true; }
    ok(threw && called === 0, 'a private target is refused before any request is issued');

    // A redirect to a private host is refused at the hop boundary, not followed. The first hop is a public
    // literal IP (allowed without DNS) that 302s to a loopback address; the second request must be refused
    // before it is issued, so the fetch impl is contacted exactly once (the public first hop only).
    let hops = 0; threw = false;
    const redirectingFetch = async (u) => {
      hops++;
      if (u.includes('8.8.8.8')) return { status: 302, headers: { get: (h) => h.toLowerCase() === 'location' ? 'http://127.0.0.1:9/internal' : null } };
      return { status: 200, headers: { get: () => null } };
    };
    try { await fetchNoPrivateRedirect('http://8.8.8.8/start', redirectingFetch); } catch { threw = true; }
    ok(threw && hops === 1, 'only the first (public) hop is contacted; the private redirect target is refused before it is requested');
    console.log('✓ nethost: fetchNoPrivateRedirect refuses private hosts at every redirect hop before contact');

    // ── resolvePublicHost returns the vetted addresses (so a caller can PIN), and still fails closed ──
    const pubAddrs = await resolvePublicHost('8.8.8.8');
    ok(Array.isArray(pubAddrs) && pubAddrs.length === 1 && pubAddrs[0].address === '8.8.8.8', 'resolvePublicHost returns a public literal IP as its own vetted address');
    let rpThrew = false; try { await resolvePublicHost('127.0.0.1'); } catch { rpThrew = true; }
    ok(rpThrew, 'resolvePublicHost throws for a private literal IP');
    // pinnedDispatcher returns an undici dispatcher (has a close method) bound to the given address.
    const disp = pinnedDispatcher('8.8.8.8', 4);
    ok(disp && typeof disp.close === 'function', 'pinnedDispatcher returns an undici dispatcher');
    try { await disp.close(); } catch {}
    console.log('✓ nethost: resolvePublicHost returns vetted addresses (fail-closed) and pinnedDispatcher builds a pinned agent');

    // ── DNS-rebinding pin: each redirect hop is fetched with a pinned dispatcher (not a bare fetch) ──
    let sawDispatcher = false;
    const pinSpyFetch = async (_u, dispatcher) => { if (dispatcher && typeof dispatcher.close === 'function') sawDispatcher = true; return { status: 200, headers: { get: () => null } }; };
    await fetchNoPrivateRedirect('http://8.8.8.8/x', pinSpyFetch);
    ok(sawDispatcher, 'fetchNoPrivateRedirect passes a pinned dispatcher to the fetch impl (connection cannot re-resolve)');
    console.log('✓ nethost: redirect-safe fetch pins every hop to its vetted address');

    // ── The two fetch paths route through the redirect-safe guard / navigation check AND pin the address ──
    const websearchSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'websearch.js'), 'utf-8');
    const urlfetchSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'urlfetch.js'), 'utf-8');
    ok(/fetchNoPrivateRedirect\(url,/.test(websearchSrc) && /redirect: 'manual'/.test(websearchSrc),
      'web-search page fetch follows redirects manually through the SSRF guard');
    ok(/dispatcher,/.test(websearchSrc), 'web-search page fetch passes the pinned dispatcher to the fetch');
    ok(/setRequestInterception\(true\)/.test(urlfetchSrc) && /hostAllowed\(host\)/.test(urlfetchSrc) && /assertPublicHost/.test(urlfetchSrc),
      'the browser capture checks EVERY request host (navigation and subresources) before connecting, cached per host');
    ok(/resolvePublicHost\(mainHost\)/.test(urlfetchSrc) && /ensureProxy\(\)/.test(urlfetchSrc) && /--proxy-server/.test(urlfetchSrc),
      'the browser capture routes through the vetting proxy, pinning every host (navigation, redirects, subresources)');
    ok(/--proxy-bypass-list=<-loopback>/.test(urlfetchSrc), 'loopback is not bypassed, so even a loopback subresource is routed to the proxy and refused');
    console.log('✓ nethost: web-search and browser-capture paths both guard redirect hops and pin the vetted address');

    console.log(`\nALL NETHOST UNIT TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ NETHOST UNIT TEST FAILED:', e && e.message);
    process.exit(1);
  }
})();
