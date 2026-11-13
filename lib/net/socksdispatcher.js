'use strict';
// A SOCKS (4 / 4a / 5 / 5h) egress proxy for the plain-fetch paths (web search, result-page fetch), so a
// socks:// proxy is honored there the same way the headless browser already honors it. undici's built-in
// ProxyAgent speaks only HTTP CONNECT, so this builds an undici Agent with a custom connector that opens
// the TCP tunnel through the SOCKS proxy (and completes TLS for https targets on top of it).
//
// Fully guarded: returns null rather than throwing when the URL or the socks module is unusable, so the
// caller decides what to do (strict mode fails closed; otherwise it applies its own fallback). The tunnel
// and TLS are bounded by a timeout so a dead SOCKS proxy can never hang a connection open forever.

const tls = require('tls');

const TUNNEL_TIMEOUT_MS = 30000;

// Build an undici Agent that tunnels every request through `proxyUrl`, or null when it cannot be built.
const makeSocksAgent = (proxyUrl) => {
  let Agent, SocksClient, pu;
  try {
    ({ Agent } = require('undici'));
    ({ SocksClient } = require('socks'));
    pu = new URL(proxyUrl);
  } catch { return null; }

  const scheme = String(pu.protocol || '').replace(':', '').toLowerCase();
  // socks4 / socks4a → type 4; socks, socks5, socks5h → type 5. socks5h/socks4a mean "resolve the
  // destination host at the proxy", which is exactly what passing a hostname destination already does.
  const type = (scheme === 'socks4' || scheme === 'socks4a') ? 4 : 5;
  const proxy = { host: pu.hostname, port: Number(pu.port) || 1080, type };
  if (pu.username) proxy.userId = decodeURIComponent(pu.username);
  if (pu.password) proxy.password = decodeURIComponent(pu.password);

  const connect = (opts, callback) => {
    let settled = false;
    const done = (err, socket) => { if (!settled) { settled = true; callback(err, socket); } };
    const port = Number(opts.port) || (opts.protocol === 'https:' ? 443 : 80);
    SocksClient.createConnection({
      proxy,
      command: 'connect',
      destination: { host: opts.hostname, port },
      timeout: TUNNEL_TIMEOUT_MS,
    }).then(({ socket }) => {
      try { socket.setNoDelay(true); } catch { /* best-effort */ }
      if (opts.protocol === 'https:') {
        // Wrap the tunneled socket in TLS for the real target. Certificate verification stays ON by default
        // (undici never sets rejectUnauthorized on connector opts, so the `!== false` default verifies).
        let tlsSocket;
        try {
          tlsSocket = tls.connect({
            socket,
            servername: opts.servername || opts.hostname,
            rejectUnauthorized: opts.rejectUnauthorized !== false,
          });
        } catch (err) {
          // tls.connect can throw synchronously on bad options — tear the tunnel down so it can't leak.
          try { socket.destroy(); } catch {}
          return done(err);
        }
        // A custom undici connector bypasses undici's own connect timeout, so the TLS handshake over the
        // tunnel is otherwise unbounded: a proxy that completes the tunnel but stalls the handshake would
        // hang the request and leak both sockets forever. Bound it ourselves and destroy both on timeout.
        const tlsTimer = setTimeout(() => {
          try { tlsSocket.destroy(); } catch {}
          try { socket.destroy(); } catch {}
          done(Object.assign(new Error('socks TLS handshake timed out'), { code: 'UND_ERR_CONNECT_TIMEOUT' }));
        }, TUNNEL_TIMEOUT_MS);
        if (tlsTimer.unref) tlsTimer.unref();
        tlsSocket.once('secureConnect', () => { clearTimeout(tlsTimer); done(null, tlsSocket); });
        tlsSocket.once('error', (err) => { clearTimeout(tlsTimer); try { socket.destroy(); } catch {} done(err); });
      } else {
        done(null, socket);
      }
    }).catch((err) => done(err));
  };

  try { return new Agent({ connect }); } catch { return null; }
};

module.exports = { makeSocksAgent };
