'use strict';
// Guards the /api/models probe so it cannot be turned into a keyless probe of an attacker-supplied server,
// and so a stored API key never leaks to a foreign endpoint. A not-yet-saved endpoint override (from the
// Settings form, to list a provider before saving) is honored ONLY when it points at a local/LAN address —
// where a self-hosted model legitimately lives. A foreign PUBLIC override is ignored and the saved endpoint
// is used instead. The route sends the stored key ONLY when the chosen endpoint equals the saved one, so a
// permitted local override is probed WITHOUT the key. Pure (net.isIP + nethost.isPrivateAddr); never throws.

// True when urlStr points at loopback / LAN / a local-ish hostname. A parse failure or a public address is false.
const isLocalEndpoint = (urlStr) => {
  try {
    const h = new URL(urlStr).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
    return require('net').isIP(h) ? require('./nethost').isPrivateAddr(h) : false;
  } catch { return false; }
};

// The endpoint to actually contact: the override only when it equals the saved endpoint or is local;
// otherwise the saved endpoint.
const pickEndpoint = (override, saved) => (override && (override === saved || isLocalEndpoint(override))) ? override : saved;

module.exports = { isLocalEndpoint, pickEndpoint };
