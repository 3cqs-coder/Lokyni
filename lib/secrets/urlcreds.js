'use strict';

// lib/urlcreds.js — one place to detect, mask, and merge credentials embedded in URL settings.
//
// A few settings are URLs that CAN carry inline credentials — a web proxy list, a remote model host, an
// OpenAI-compatible base URL — in the `scheme://user:pass@host` (or bare `user:pass@host:port`, or password-
// only `scheme://:pass@host`) form. The password in such a URL is a reversible credential, so it must be
// sealed at rest like any other and never shown to the browser in the clear. These helpers are the single
// source for that:
//   • hasUrlCredentials(str) — does any entry embed a password? (the config writer seals only when it does, so
//     a credential-free host list stays legible at rest and the common case is unchanged)
//   • maskUrlCredentials(str) — replace each embedded password with the mask, keeping scheme/user/host/port/path
//     visible, for the Settings echo and log lines
//   • isMaskedUrl(str) — did a value come back carrying the mask? (so a save that didn't re-type a password can
//     keep the stored one instead of persisting "***")
//   • fillMaskedPasswords(incoming, stored) — restore each still-masked password from the matching stored entry
//     (by scheme+user+host, so editing or reordering OTHER entries in a list doesn't require re-typing every
//     password); an entry whose password was really changed is kept as typed
//
// Parsing uses the platform URL parser (global `URL`), not a hand-rolled regex, so a password containing ':'
// is handled, a port or a path/query ':' is never mistaken for a credential, IPv6 hosts work, and there is no
// catastrophic-backtracking risk. Masking is done by POSITION in the original string (the parser re-encodes the
// password, so we can't match it by value), which also preserves the exact text everywhere else. A field may
// hold SEVERAL entries (one per line, or comma/space separated); each entry is handled independently and every
// separator is preserved. Cross-platform, non-blocking (microseconds), language-agnostic (URL structure, not
// words), and never throws.

const MASK = '***';
const SEP = /([\s,]+)/;                              // capture the separators so a split/rejoin is byte-exact
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;       // an explicit scheme:// prefix

// Parse one entry as a URL (prefixing http:// for a bare host/userinfo, as the proxy pool does), or null if it
// is not a valid URL (an unparseable entry can't authenticate anywhere, so it carries no usable credential).
function parse(entry) {
  if (typeof entry !== 'string' || !entry) return null;
  try { return new URL(HAS_SCHEME.test(entry) ? entry : 'http://' + entry); } catch { return null; }
}

// The authority-userinfo password span [start, end) in the ORIGINAL entry: from the char after the first ':'
// that follows the authority start, to the '@' that ends the userinfo. Returns null when there is no password.
function passwordSpan(entry) {
  const u = parse(entry);
  if (!u || !u.password) return null;
  const scheme = HAS_SCHEME.exec(entry);
  const authStart = scheme ? scheme[0].length : 0;
  // The authority ends at the first '/', '?' or '#' after it (or the end of the string). The userinfo is
  // terminated by the LAST '@' WITHIN that authority — a password may itself contain '@' (a common, valid case),
  // so keying on the FIRST '@' stops the mask early and leaks the password's tail to the Settings echo and logs.
  // A host cannot contain '@', so the last '@' before the authority ends is always the userinfo terminator; the
  // first ':' after the authority start is the user:password delimiter (a username cannot hold an unencoded ':').
  let authEnd = entry.length;
  for (const ch of ['/', '?', '#']) { const i = entry.indexOf(ch, authStart); if (i !== -1 && i < authEnd) authEnd = i; }
  const at = entry.lastIndexOf('@', authEnd - 1);
  const colon = entry.indexOf(':', authStart);
  if (at === -1 || colon === -1 || colon > at || at < authStart) return null;   // shape we don't recognize — leave it untouched
  return { start: colon + 1, end: at };
}

// Replace every embedded password with the mask, leaving scheme, username, host, port and path intact.
function maskUrlCredentials(str) {
  if (typeof str !== 'string' || !str) return str;
  const parts = str.split(SEP);
  for (let i = 0; i < parts.length; i += 2) {
    const span = passwordSpan(parts[i]);
    if (span) parts[i] = parts[i].slice(0, span.start) + MASK + parts[i].slice(span.end);
  }
  return parts.join('');
}

// Does any entry embed a password?
function hasUrlCredentials(str) {
  if (typeof str !== 'string' || !str) return false;
  const parts = str.split(SEP);
  for (let i = 0; i < parts.length; i += 2) { const u = parse(parts[i]); if (u && u.password) return true; }
  return false;
}

// Did a value come back carrying the mask (so the caller should keep/restore rather than store "***")?
function isMaskedUrl(str) {
  return typeof str === 'string' && str.includes(`:${MASK}@`);
}

// A stable, non-secret identity for matching an entry to its stored counterpart: scheme + username + host(:port).
function entryId(u) { return `${u.protocol}//${u.username}@${u.host}`; }

// Restore each still-masked password in `incoming` from the matching entry in `stored` (both plaintext), matched
// by scheme+user+host so editing or reordering other entries in a list doesn't require re-typing every password.
// An entry whose password was actually re-typed is kept as-is; a masked entry with no stored match stays masked
// (the caller then keeps the whole stored value rather than persist a "***"). Preserves the incoming layout.
function fillMaskedPasswords(incoming, stored) {
  if (typeof incoming !== 'string' || !incoming || !isMaskedUrl(incoming)) return incoming;
  const byId = new Map();
  if (typeof stored === 'string' && stored) {
    const sp = stored.split(SEP);
    for (let i = 0; i < sp.length; i += 2) { const u = parse(sp[i]); if (u && u.password) byId.set(entryId(u), u.password); }
  }
  const parts = incoming.split(SEP);
  for (let i = 0; i < parts.length; i += 2) {
    const u = parse(parts[i]);
    if (!u || u.password !== MASK) continue;             // not a masked entry — leave it (real new password, or none)
    const pw = byId.get(entryId(u));
    if (pw == null) continue;                            // no stored match — leave masked; caller keeps stored value
    const span = passwordSpan(parts[i]);
    if (span) parts[i] = parts[i].slice(0, span.start) + pw + parts[i].slice(span.end);
  }
  return parts.join('');
}

module.exports = { maskUrlCredentials, hasUrlCredentials, isMaskedUrl, fillMaskedPasswords, MASK };
