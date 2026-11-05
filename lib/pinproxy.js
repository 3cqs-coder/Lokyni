'use strict';
// A tiny loopback proxy that VETS and PINS every connection the headless browser makes during URL
// ingestion, so a page can never be steered at loopback, the LAN, or the cloud-metadata endpoint — not via
// the main navigation, not via a redirect, and not via a subresource — and cannot be DNS-rebound after the
// check. The proxy is the single place that resolves the host, vets it against the shared SSRF guard, and
// connects to THAT address, so there is no window for a second, unchecked resolution (the rebinding TOCTOU
// that --host-resolver-rules could only close for the one main host known at launch).
//
// For HTTPS the browser sends CONNECT host:port and the proxy, once the host is vetted, blindly tunnels
// bytes to the vetted IP — the TLS handshake stays end-to-end between the browser and the origin, so
// certificate validation is unaffected. For plain HTTP the proxy vets the request's host and forwards.
// Chromium points at it with --proxy-server=127.0.0.1:<port> plus --proxy-bypass-list=<-loopback> so even
// a loopback subresource is routed through the proxy (and thus refused) rather than bypassing it; every
// Chromium-based browser (Chrome, Edge, Brave, Chromium) honors both flags.
//
// Crash-proof and non-blocking: every socket has an error handler and an idle timeout, so a broken peer
// can never throw into the process or wedge a capture. One shared server serves all captures (each
// connection is vetted independently), it is unref'd so it never keeps the process alive, and it is torn
// down with the browsers on shutdown so nothing is left listening.

const net = require('net');
const { resolvePublicHost } = require('./nethost');

const SOCKET_TIMEOUT_MS = 30000;   // idle cap per socket so a stuck peer can't wedge a capture
const MAX_HEADER_BYTES = 8192;     // bound the first-line buffer so a hostile client can't grow it

let server = null;
let port = 0;
let starting = null;

// Parse a "host:port" / "1.2.3.4:port" / "[::1]:port" authority into { host, port }.
const parseAuthority = (authority) => {
  const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(String(authority || '').trim());
  if (!m) return null;
  let host = m[1];
  if (host.startsWith('[')) host = host.slice(1, -1);
  const p = Number(m[2]);
  return host && p > 0 && p < 65536 ? { host, port: p } : null;
};

// Resolve + vet `host`, then connect to the vetted address (preferring IPv4 for a single pinned target).
// Rejects if the host is private/unresolvable, so the caller refuses the connection.
const connectVetted = async (host, portNum) => {
  const addrs = await resolvePublicHost(host);   // throws on private/unresolvable
  const pick = addrs.find(a => a.family === 4) || addrs[0];
  return net.connect({ host: pick.address, port: portNum });
};

// Wire a client↔upstream pair together with error/close handling so neither can throw or leak.
const bridge = (client, up) => {
  const closeBoth = () => { try { client.destroy(); } catch {} try { up.destroy(); } catch {} };
  up.on('error', closeBoth); up.on('close', closeBoth);
  client.on('error', closeBoth); client.on('close', closeBoth);
  up.setTimeout(SOCKET_TIMEOUT_MS, () => up.destroy());
};

// Guard the window BEFORE `up` connects. Until the upstream fires 'connect', bridge() has not run, so nothing
// tears `up` down if the client goes away first or the connect to a slow/blackholed origin stalls — the
// half-open socket would otherwise linger until the OS SYN timeout. Bound the connect phase with a timeout and
// destroy `up` if the client closes early; once connected, bridge() owns teardown, so drop the early guard.
const armConnectGuard = (client, up) => {
  up.setTimeout(SOCKET_TIMEOUT_MS, () => up.destroy());
  const abortUp = () => { try { up.destroy(); } catch {} };
  client.once('close', abortUp);
  up.once('connect', () => client.removeListener('close', abortUp));
};

const handleConnection = (client) => {
  client.on('error', () => {});   // a client reset must never throw into the process
  client.setTimeout(SOCKET_TIMEOUT_MS, () => client.destroy());
  let buf = Buffer.alloc(0);
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const idx = buf.indexOf('\r\n');
    if (idx === -1) { if (buf.length > MAX_HEADER_BYTES) client.destroy(); return; }   // bounded header
    client.removeListener('data', onData);
    const line = buf.slice(0, idx).toString('utf-8');

    const connectM = /^CONNECT\s+(\S+)\s+HTTP\/\d/i.exec(line);
    if (connectM) {
      const hp = parseAuthority(connectM[1]);
      if (!hp) { try { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {} return; }
      connectVetted(hp.host, hp.port).then((up) => {
        armConnectGuard(client, up);
        up.on('connect', () => {
          try { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); } catch { return up.destroy(); }
          bridge(client, up);
          up.pipe(client); client.pipe(up);   // blind tunnel — TLS stays end-to-end, so certs still verify
        });
        up.on('error', () => { try { client.destroy(); } catch {} });
      }).catch(() => { try { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); } catch {} });
      return;
    }

    // Plain HTTP: the request line carries the absolute URL (GET http://host/path HTTP/1.1).
    const httpM = /^[A-Z]+\s+(http:\/\/\S+)\s+HTTP\/\d/i.exec(line);
    if (httpM) {
      let host, portNum;
      try { const u = new URL(httpM[1]); host = u.hostname; portNum = Number(u.port) || 80; }
      catch { try { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {} return; }
      connectVetted(host, portNum).then((up) => {
        armConnectGuard(client, up);
        up.on('connect', () => {
          bridge(client, up);
          try { up.write(buf); } catch { return up.destroy(); }   // forward the buffered first request
          up.pipe(client); client.pipe(up);
        });
        up.on('error', () => { try { client.destroy(); } catch {} });
      }).catch(() => { try { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); } catch {} });
      return;
    }

    try { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
  };
  client.on('data', onData);
};

// Start the shared proxy (once) and return its loopback port. Concurrency-safe.
const ensureProxy = async () => {
  if (server) return port;
  if (starting) return starting;
  starting = new Promise((resolve, reject) => {
    const s = net.createServer(handleConnection);
    s.on('error', (e) => {
      try { s.close(); } catch {}
      // If this error lands AFTER listen (server/port were already set to this instance), clear them so the
      // next ensureProxy() rebinds a fresh listener rather than handing out the port of a now-dead one. The
      // reject() is a no-op once the promise has resolved.
      if (server === s) { server = null; port = 0; }
      reject(e);
    });
    s.listen(0, '127.0.0.1', () => { server = s; port = s.address().port; try { s.unref(); } catch {} resolve(port); });
  });
  try { return await starting; } finally { starting = null; }
};

// Tear the proxy down (on shutdown / with the browsers). Idempotent and synchronous-safe.
const stopProxy = () => {
  if (server) { try { server.close(); } catch {} server = null; port = 0; }
};

module.exports = { ensureProxy, stopProxy };
