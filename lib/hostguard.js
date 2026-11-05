'use strict';
// Shared DNS-rebinding Host-header check, used by BOTH the Express control plane and the socket.io
// data channel. When the server is bound to loopback (the default), the only legitimate way to
// reach it is via a loopback Host — you cannot connect to 127.0.0.1 from another machine. A
// rebinding attack (a page on evil.com whose DNS flips to 127.0.0.1) reaches the loopback server
// yet sends Host: evil.com, and the origin guard would pass it because Origin and Host then match.
// Rejecting a non-loopback Host closes that hole.
//
// This lives in its own module because the check must cover two transports that dispatch
// differently: Express middleware (the HTTP control plane) AND socket.io, which attaches to the
// raw HTTP server and handles /ws before any Express middleware runs. The socket channel carries
// the documents themselves, so leaving it uncovered would be the highest-value rebinding gap.
// A configured trustedHosts entry (config.json-only) is also accepted, for a reverse proxy that
// forwards the original public Host unchanged. All values are read live from config; the bind
// address and trustedHosts are fixed at startup, so this is effectively constant per process.
const net = require('net');

// True when the Host header names a loopback address, in any spelling, with or without a port.
const isLoopbackHostHeader = (h) => {
  if (!h) return false;
  let host = String(h).trim().toLowerCase();
  // Strip the port carefully by form: bracketed IPv6 ([::1] or [::1]:3000) keeps the address inside
  // the brackets; a single-colon host (IPv4 or hostname with :port) drops the port; a bare IPv6
  // (multiple colons, no brackets) is left intact so its own colons aren't mistaken for a port.
  const bracketed = host.match(/^\[(.+?)\](?::\d+)?$/);
  if (bracketed) host = bracketed[1];
  else if ((host.match(/:/g) || []).length === 1) host = host.replace(/:\d+$/, '');
  if (host === 'localhost') return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(host)) return true;
  // Any spelling of the IPv6 loopback — ::1, 0:0:0:0:0:0:0:1, the zero-padded 0000:…:0001, 0::1 —
  // is a valid IPv6 address whose only non-zero digit is a trailing 1.
  if (net.isIP(host) === 6 && host.replace(/[0:]/g, '') === '1') return true;
  return false;
};

// True when the Host (port-stripped, lower-cased) is in the config.json trustedHosts allowlist.
const isTrustedHost = (h) => {
  const trusted = require('./config').TRUSTED_HOSTS || [];
  if (!trusted.length || !h) return false;
  const bracketed = String(h).trim().toLowerCase().match(/^\[(.+?)\](?::\d+)?$/);
  const host = bracketed ? bracketed[1] : String(h).trim().toLowerCase().replace(/:\d+$/, '');
  return trusted.includes(host);
};

const isBindLoopback = () => {
  const a = require('./config').BIND_ADDRESS;
  return a === '127.0.0.1' || a === '::1' || a === 'localhost';
};

// The guard is active when bound to loopback OR when it is explicitly enforced. Enforcement exists
// for a container: it must bind 0.0.0.0 so a published port can reach it, but that is mechanical, not
// a decision to serve the open network — without enforcement the guard would switch off and a
// rebinding attack could reach the unauthenticated control plane through the loopback-published port.
const isGuardActive = () => isBindLoopback() || require('./config').ENFORCE_HOST_GUARD === true;

// The single decision both transports use: when the guard is inactive (the user deliberately bound to
// the open network), accept anything; otherwise accept only a loopback Host or a configured trusted host.
const isAllowedHost = (h) => !isGuardActive() || isLoopbackHostHeader(h) || isTrustedHost(h);

// Cross-site request defense, shared by the HTTP control plane and the socket.io handshake so the
// two can never drift. This is a SEPARATE concern from the Host check above: the Host guard stops
// DNS rebinding, but browsers do not apply the same-origin policy to WebSocket connections, so a
// page on another site can open a plain ws:// socket to the loopback server with a legitimate
// loopback Host and — without an Origin check — read the user's documents (cross-site WebSocket
// hijacking). Disabling CORS does not prevent this, because the WebSocket transport ignores CORS.
//
// Returns false only for a genuine cross-origin browser request. It accepts a same-origin request,
// a top-level navigation, and a non-browser client (a CLI or the key-authenticated MCP endpoint,
// which send no Origin) — matching what the control plane accepted before this was factored out.
// A browser cannot forge Sec-Fetch-Site or Origin, so the check holds against a hostile page; a
// non-browser client that forges them is not the hijacking threat and is gated elsewhere by key.
const isSameOriginRequest = (headers) => {
  const h = headers || {};
  const site = h['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  const origin = h.origin;
  if (!origin) return true;                 // no Origin header → not a browser cross-origin request
  let originHost;
  try { originHost = new URL(origin).host; } catch { return false; }
  return originHost === (h.host || '');
};

module.exports = { isLoopbackHostHeader, isTrustedHost, isBindLoopback, isAllowedHost, isSameOriginRequest };
