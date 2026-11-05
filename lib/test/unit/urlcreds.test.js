'use strict';
// lib/urlcreds.js — detect, mask, and merge credentials embedded in URL settings (a proxy list, a model host,
// a base URL). The password is a reversible credential, so it must be sealable at rest and never shown in the
// clear. Parsing uses the platform URL parser, so a ':' in a password is handled, a port/path/query ':' is
// never mistaken for a credential, and IPv6 works. Guards: mask the password only (scheme/user/host/port/path
// visible), credential-free values pass through untouched, multi-entry strings preserve every separator,
// detection, the masked-value marker, and per-entry restore of a still-masked password from the stored value.
// Run: `npm run test:unit`.

const assert = require('assert'), path = require('path');
const u = require(path.resolve(__dirname, '..', '..', 'urlcreds'));

let checks = 0;
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // ── mask: password → ***, everything else intact ──
  eq(u.maskUrlCredentials('http://alice:s3cret@proxy.example:8080'), 'http://alice:***@proxy.example:8080', 'masks the password, keeps scheme/user/host/port');
  eq(u.maskUrlCredentials('socks5://bob:p%40ss@10.0.0.1:1080'), 'socks5://bob:***@10.0.0.1:1080', 'masks a socks5 proxy password');
  eq(u.maskUrlCredentials('user:pw@host:3128'), 'user:***@host:3128', 'masks a bare (schemeless) user:pass@host');
  eq(u.maskUrlCredentials('http://:justpass@host:8080'), 'http://:***@host:8080', 'masks a password-only userinfo (empty username)');
  eq(u.maskUrlCredentials('http://u:p@[::1]:8080'), 'http://u:***@[::1]:8080', 'masks the password of an IPv6-host URL, leaving the host intact');
  // A ':' inside the password is part of the password — the WHOLE password must be masked, not just a half.
  eq(u.maskUrlCredentials('http://user:pa:ss:word@host'), 'http://user:***@host', 'a password containing colons is fully masked (no leaked half)');
  // A password containing a literal "@" must be FULLY masked — the userinfo ends at the LAST "@" in the authority,
  // not the first (the first "@" falls inside the password, and masking to it would leak the tail to the UI/logs).
  eq(u.maskUrlCredentials('http://user:p@ss@host:1080'), 'http://user:***@host:1080', 'a password with "@" is fully masked (no leaked tail)');
  eq(u.maskUrlCredentials('socks5://bob:pa@ss@10.0.0.1:1080'), 'socks5://bob:***@10.0.0.1:1080', 'a socks password with "@" is fully masked');
  eq(u.maskUrlCredentials('http://user:p@s@s@host:1080/path?q=1'), 'http://user:***@host:1080/path?q=1', 'a password with multiple "@" is fully masked even with a path/query');

  // ── credential-free values pass through untouched (common case: no behavior change) ──
  eq(u.maskUrlCredentials('http://localhost:11434'), 'http://localhost:11434', 'a host:port with no credentials is unchanged');
  eq(u.maskUrlCredentials('https://api.example.com:443/v1'), 'https://api.example.com:443/v1', 'a clean base URL with a port is unchanged');
  eq(u.maskUrlCredentials('https://api.host/v1?u=a:b@c'), 'https://api.host/v1?u=a:b@c', 'a ":" and "@" inside a query are NOT mistaken for a credential (no over-mask)');
  eq(u.maskUrlCredentials(''), '', 'empty is unchanged');
  eq(u.maskUrlCredentials(undefined), undefined, 'a non-string passes through');

  // ── multi-entry strings: mask each, preserve separators (newline / comma / space) ──
  eq(u.maskUrlCredentials('http://a:1@h1:8080\nhttp://clean:3128\nhttp://b:2@h2:9090'),
    'http://a:***@h1:8080\nhttp://clean:3128\nhttp://b:***@h2:9090', 'masks each line, keeps newlines and the credential-free entry');
  eq(u.maskUrlCredentials('http://a:1@h1, http://b:2@h2'), 'http://a:***@h1, http://b:***@h2', 'masks each comma-separated entry');

  // ── detection ──
  eq(u.hasUrlCredentials('http://localhost:11434'), false, 'no credentials → false (stays legible at rest)');
  eq(u.hasUrlCredentials('http://u:p@h'), true, 'an embedded password → true (seal it at rest)');
  eq(u.hasUrlCredentials('http://:p@h'), true, 'a password-only userinfo → true');
  eq(u.hasUrlCredentials('https://api.host/v1?u=a:b@c'), false, 'a query ":@" is not a credential → false (not needlessly sealed)');
  eq(u.hasUrlCredentials('http://clean:3128\nhttp://u:p@h'), true, 'true when ANY entry in a list carries a credential');
  eq(u.hasUrlCredentials(''), false, 'empty → false');

  // ── masked-value marker ──
  eq(u.isMaskedUrl('http://alice:***@proxy'), true, 'detects the mask marker');
  eq(u.isMaskedUrl('http://alice:realpw@proxy'), false, 'a real password is not seen as masked');
  eq(u.isMaskedUrl('http://localhost:11434'), false, 'a credential-free URL is not masked');

  // ── fillMaskedPasswords: restore a still-masked password from the stored value, per entry ──
  const stored = 'http://u1:secret1@h1:8080\nhttp://u2:secret2@h2:9090';
  // The admin edited only the 2nd proxy's password and left the 1st masked: the 1st is restored, the 2nd kept.
  eq(u.fillMaskedPasswords('http://u1:***@h1:8080\nhttp://u2:newpass@h2:9090', stored),
    'http://u1:secret1@h1:8080\nhttp://u2:newpass@h2:9090', 'a masked entry is restored from the stored value; a re-typed one is kept');
  // Reordered, both masked → both restored by identity (not position).
  eq(u.fillMaskedPasswords('http://u2:***@h2:9090, http://u1:***@h1:8080', stored),
    'http://u2:secret2@h2:9090, http://u1:secret1@h1:8080', 'masked entries are matched to stored by scheme+user+host, so reordering is fine');
  // A masked entry with no stored match stays masked (caller then keeps the stored value whole).
  ok(u.isMaskedUrl(u.fillMaskedPasswords('http://unknown:***@newhost', stored)), 'a masked entry with no stored match stays masked (safe fallback)');
  // A fully re-typed value (no mask) is returned unchanged.
  eq(u.fillMaskedPasswords('http://u1:brandnew@h1', stored), 'http://u1:brandnew@h1', 'a fully re-typed value is unchanged');
  // Round-trip a stored password that itself contains "@": it masks fully (above) AND restores to the SAME secret
  // (the fill uses the same authority-aware span, so the "@" is not mistaken for the userinfo terminator). The URL
  // parser percent-encodes "@" in the password component, so the restored string may carry %40 — functionally
  // identical: it decodes back to the original, with nothing leaked or truncated.
  const filledAt = u.fillMaskedPasswords('http://u1:***@h1:8080', 'http://u1:p@ss@h1:8080');
  eq(decodeURIComponent(new URL(filledAt).password), 'p@ss', 'a stored password containing "@" round-trips to the same secret (not truncated/leaked)');

  // ── ReDoS / OOM safety: a pathological long input returns fast ──
  const big = 'http://' + 'a'.repeat(100000) + ':' + 'b'.repeat(100000) + '@h';
  const t0 = Date.now(); u.maskUrlCredentials(big); ok(Date.now() - t0 < 1000, 'masks a 200k-char input in well under a second');

  console.log(`\nALL URLCREDS TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ URLCREDS TEST FAILED:', e && (e.stack || e.message));
  process.exit(1);
}
