'use strict';

// ── nethost — shared SSRF guard ──────────────────────────────────────────────
//
// Both URL ingestion and web search make the server fetch a URL that ultimately comes
// from outside, so without a guard either could be steered into reading loopback, the
// LAN, or a cloud metadata endpoint to probe internal resources. This is the ONE place
// that decides whether a host is safe to fetch, so the two paths can't drift. It blocks
// private/loopback/link-local/CGNAT ranges and obvious internal names, and resolves the
// host first so a public name that maps to an internal address is refused.
//
// To close the DNS-rebinding gap (a name that answers public when vetted here, then private when the
// fetcher re-resolves it), this module also PINS the connection to the vetted address: resolvePublicHost
// returns the checked addresses, pinnedDispatcher connects only to one of them, and the browser path maps
// the host to the vetted IP at launch. So the socket lands on the same address that was vetted, not a
// re-resolved one. SNI and certificate validation still use the original hostname, so HTTPS stays correct.

const net = require('net');

const isPrivateIPv4 = (ip) => {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => Number.isNaN(n))) return false;
  return p[0] === 127 || p[0] === 10 || p[0] === 0
    || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
    || (p[0] === 192 && p[1] === 168)
    || (p[0] === 169 && p[1] === 254)   // link-local (incl. cloud metadata 169.254.169.254)
    || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);   // CGNAT
};
// Parse ANY textual IPv6 form — compressed (`::1`), fully expanded (`0:0:0:0:0:0:0:1`), mixed, with an
// embedded IPv4 tail (`::ffff:127.0.0.1`), or with a zone id (`fe80::1%eth0`) — into its 16 bytes, or null if
// it is not a well-formed address. Classifying on the bytes (below) rather than string prefixes means every
// equivalent spelling of the same address is judged the same way, so a non-canonical spelling can't slip a
// private address past the guard. (A string-prefix check missed expanded forms that don't begin with `::`.)
const ipv6ToBytes = (ip) => {
  let s = String(ip).toLowerCase().trim();
  const zone = s.indexOf('%'); if (zone !== -1) s = s.slice(0, zone);   // drop a scope/zone id
  // Convert an embedded dotted IPv4 tail to two hex groups so the whole address is uniform hex groups.
  if (s.includes('.')) {
    const lastColon = s.lastIndexOf(':');
    if (lastColon === -1) return null;
    const v4 = s.slice(lastColon + 1).split('.').map(Number);
    if (v4.length !== 4 || v4.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    s = s.slice(0, lastColon + 1) + (((v4[0] << 8) | v4[1]).toString(16)) + ':' + (((v4[2] << 8) | v4[3]).toString(16));
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;                                   // at most one '::'
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  let groups;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;                                          // '::' must stand for at least one group
    groups = [...head, ...Array(fill).fill('0'), ...tail];
  } else {
    groups = head;                                                      // no '::' → must be exactly 8 groups
  }
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
    const v = parseInt(groups[i], 16);
    bytes[2 * i] = (v >> 8) & 0xff;
    bytes[2 * i + 1] = v & 0xff;
  }
  return bytes;
};
const isPrivateIPv6 = (ip) => {
  const b = ipv6ToBytes(ip);
  if (!b) return true;                                                  // unparseable → fail closed (treat private)
  const embeddedV4 = () => isPrivateIPv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  let highZero = true; for (let i = 0; i < 10; i++) if (b[i] !== 0) { highZero = false; break; }
  if (highZero && b[10] === 0xff && b[11] === 0xff) return embeddedV4();   // IPv4-mapped ::ffff:a.b.c.d
  let first12Zero = highZero; if (first12Zero) for (let i = 10; i < 12; i++) if (b[i] !== 0) { first12Zero = false; break; }
  if (first12Zero) {
    const low = (b[12] << 24 >>> 0) | (b[13] << 16) | (b[14] << 8) | b[15];
    if (low === 0 || low === 1) return true;                            // :: (unspecified) and ::1 (loopback)
    return embeddedV4();                                                // IPv4-compatible ::a.b.c.d (deprecated)
  }
  if ((b[0] & 0xfe) === 0xfc) return true;                             // unique local fc00::/7 (fc + fd)
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;            // link-local fe80::/10
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true;            // deprecated site-local fec0::/10
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return true;   // NAT64 64:ff9b::/96
  // The remaining "IPv6 that reaches IPv4 space" forms, judged by their embedded IPv4 (same principle as the
  // IPv4-mapped / IPv4-compat / NAT64 cases above) so a private v4 can't be tunnelled past the guard:
  //   • 6to4 2002::/16 — the embedded IPv4 is bytes 2–5.
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivateIPv4(`${b[2]}.${b[3]}.${b[4]}.${b[5]}`);
  //   • Teredo 2001:0000::/32 — the client IPv4 is the last 32 bits, bit-complemented (obfuscated).
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) {
    return isPrivateIPv4(`${b[12] ^ 0xff}.${b[13] ^ 0xff}.${b[14] ^ 0xff}.${b[15] ^ 0xff}`);
  }
  return false;
};
const isPrivateAddr = (ip) => net.isIPv4(ip) ? isPrivateIPv4(ip) : (net.isIPv6(ip) ? isPrivateIPv6(ip) : false);

// Resolve `hostname` and vet every address, returning the vetted [{ address, family }] list so a caller
// can PIN the connection to one of them (see pinnedDispatcher / the browser host-resolver mapping) and
// avoid a second, unchecked resolution by the fetcher. Throws (refuse) if the host names the local
// machine, is a private literal IP, cannot be resolved, or resolves to any private address. Fails closed.
const resolvePublicHost = async (hostname) => {
  const lower = String(hostname).toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.internal') || lower.endsWith('.local')) {
    throw new Error('Refusing to fetch an internal host');
  }
  if (net.isIP(hostname)) {
    if (isPrivateAddr(hostname)) throw new Error('Refusing to fetch a private address');
    return [{ address: hostname, family: net.isIPv6(hostname) ? 6 : 4 }];
  }
  let addrs;
  try { addrs = await require('dns').promises.lookup(hostname, { all: true }); }
  catch { throw new Error('Refusing to fetch a host that could not be resolved'); }   // fail closed
  if (!addrs || addrs.length === 0) throw new Error('Refusing to fetch a host that did not resolve');
  for (const a of addrs) if (isPrivateAddr(a.address)) throw new Error('Refusing to fetch a host that resolves to a private address');
  return addrs;   // every address vetted public
};

// Throw if `hostname` names the local machine or resolves to a private address. Callers wrap this and
// treat a throw as "refuse to fetch". Kept as the throw-only form; delegates to resolvePublicHost.
const assertPublicHost = async (hostname) => { await resolvePublicHost(hostname); };

// An undici dispatcher that connects ONLY to `address`, so the fetch cannot re-resolve the host to a
// different (internal) IP between vetting and connect — the DNS-rebinding TOCTOU. The keep-alive timeouts
// are short so the per-request agent's sockets close promptly and it is cheap to let go of. SNI and cert
// validation still use the request's hostname, so HTTPS verification is unaffected.
let _Agent = null;
const pinnedDispatcher = (address, family) => {
  if (!_Agent) _Agent = require('undici').Agent;
  const fam = family || (net.isIPv6(address) ? 6 : 4);
  return new _Agent({
    connect: { lookup: (_hostname, _opts, cb) => cb(null, [{ address, family: fam }]) },
    keepAliveTimeout: 2000, keepAliveMaxTimeout: 2000,
  });
};

// Fetch that follows redirects MANUALLY, re-checking each hop's host with assertPublicHost BEFORE
// contacting it. The platform fetch defaults to redirect:'follow', which transparently connects to and
// issues the request against a redirect target — so a public URL that 3xx-redirects to loopback, a LAN
// host, or the cloud metadata endpoint would have that internal request sent before any final-host check
// could discard the body (a blind-SSRF gap: side-effecting internal GETs, existence/timing probes).
// Checking every hop at the redirect boundary closes that. Each hop is also PINNED to the address vetted
// for that hop, so the fetch cannot re-resolve to an internal IP after the check. `fetchImpl(url, dispatcher)`
// performs one hop and MUST pass redirect:'manual' (so a 3xx is returned rather than followed), the
// caller's timeout/abort, and the given dispatcher (so the connection lands on the vetted address).
// Returns the final non-redirect Response; throws if any hop resolves to a private host or the chain is
// too long. Callers treat a throw as "refuse to fetch".
const fetchNoPrivateRedirect = async (startUrl, fetchImpl, maxHops = 5, proxyDispatcher = null) => {
  // When the caller supplies a proxy dispatcher (an outbound proxy is configured), route every hop through
  // it: the proxy — not this machine — does the connecting, so the local IP-pinning/private-host guard does
  // not apply (a remote proxy can't reach this machine's localhost anyway) and the operator has chosen to
  // trust the proxy's network. Direct (no dispatcher) keeps the full per-hop SSRF vetting + pinning below.
  let current = startUrl;
  for (let hop = 0; ; hop++) {
    let dispatcher;
    if (proxyDispatcher) {
      // Routing through a proxy: we cannot PIN the connection (the proxy does the connecting), but we must
      // still REFUSE a target that resolves to a private/loopback/link-local address. The vetting is
      // independent of pinning, and keeping it here means a local or LAN proxy — a developer's intercepting
      // proxy, or an ambient HTTP_PROXY/ALL_PROXY env var — cannot be used to reach 127.0.0.1, a LAN host, or
      // the cloud-metadata endpoint via a malicious redirect. The "proxy is remote" assumption is no longer
      // load-bearing for SSRF safety.
      await resolvePublicHost(new URL(current).hostname);   // throws (refuse) a private/unresolvable target before the hop
      dispatcher = proxyDispatcher;
    } else {
      const addrs = await resolvePublicHost(new URL(current).hostname);   // throws (refuse) before the hop is contacted
      dispatcher = pinnedDispatcher(addrs[0].address, addrs[0].family);    // connect only to the vetted address
    }
    const res = await fetchImpl(current, dispatcher);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res;                               // a 3xx with no Location — nothing to follow
      // Release the redirect response's body so its socket is freed now rather than at GC. Redirect
      // bodies are normally empty, but not cancelling can hold the connection open on some runtimes.
      try { res.body?.cancel(); } catch { /* best-effort */ }
      if (hop >= maxHops) throw new Error('Too many redirects');
      current = new URL(loc, current).toString();          // resolve relative Location against the current URL
      continue;
    }
    return res;
  }
};

module.exports = { isPrivateAddr, assertPublicHost, resolvePublicHost, pinnedDispatcher, fetchNoPrivateRedirect };
