'use strict';
// Guards the "allow access from other devices" (network exposure) feature and its mandatory auth-before-exposure
// rule, so Lokyni can never be bound to the open network without a way to sign in:
//   • config.js folds the friendly `allowNetworkAccess` toggle into BIND_ADDRESS (0.0.0.0 vs loopback), but a
//     hard safety gate forces loopback + a loud warning when a non-loopback bind has no account and no SSO;
//   • the server exposes `allowNetworkAccess` + `authConfigured` over /api/config, accepts the boolean through
//     the write allowlist, and REFUSES to save it ON while no sign-in exists (mirrors the config gate);
//   • the web app shows the toggle, blocks turning it on without an account, and prompts to restart on a change.
// Source guards (no network/process). Run: `npm run test:unit`.

const path = require('path'), fs = require('fs'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { WRITABLE_KEYS, BOOLEAN_KEYS } = require(path.join(PROJECT, 'lib', 'settings-schema'));
const read = (...p) => fs.readFileSync(path.join(PROJECT, ...p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  const config = read('lib', 'config.js');
  // The toggle maps to the bind address: ON → 0.0.0.0, OFF → loopback. An explicit --bind / bindAddress still wins.
  ok(/const ALLOW_NETWORK_ACCESS = flag\('allowNetworkAccess', providerConfig\.allowNetworkAccess\);/.test(config),
    'config reads the allowNetworkAccess toggle through the shared schema');
  ok(/ALLOW_NETWORK_ACCESS \? '0\.0\.0\.0' : '127\.0\.0\.1'/.test(config),
    'the toggle chooses 0.0.0.0 (network) vs 127.0.0.1 (loopback)');
  // The hard safety gate: a non-loopback bind without an account or SSO is forced back to loopback with a warning.
  ok(/if \(!isLoopbackBind\(BIND_ADDRESS\)\)/.test(config), 'the gate only fires for a non-loopback bind');
  ok(/require\('\.\/users'\)\.count\(DATA_DIR\) > 0/.test(config), 'the gate counts accounts');
  ok(/o\.enabled && o\.issuer && o\.clientId/.test(config), 'the gate also accepts SSO as auth');
  ok(/BIND_ADDRESS = '127\.0\.0\.1';/.test(config) && /console\.warn/.test(config),
    'no auth → forced back to loopback with a loud warning (never left exposed)');
  // The forced-loopback only overrides the TOGGLE; an explicit --bind / bindAddress is respected (containers,
  // a reverse proxy in front) — we warn but do not override it, so the advanced escape hatch keeps working.
  ok(/if \(_explicitBind\) \{[\s\S]*?console\.warn/.test(config),
    'an explicit --bind/bindAddress is respected (warned, not overridden)');
  ok(/const _explicitBind = \(cliArg\('bind'\)/.test(config),
    'the explicit-bind source is tracked separately from the toggle');
  ok(/ALLOW_NETWORK_ACCESS,/.test(config), 'ALLOW_NETWORK_ACCESS is exported');

  const server = read('lib', 'server.js');
  ok(WRITABLE_KEYS.includes('allowNetworkAccess'), 'the shared write allowlist includes allowNetworkAccess');
  // It is coerced as a boolean (listed among the boolean keys) so a string can never slip through.
  ok(BOOLEAN_KEYS.includes('allowNetworkAccess') && /const BOOLEAN = new Set\(BOOLEAN_KEYS\)/.test(server),
    'allowNetworkAccess is coerced as a boolean from the shared schema');
  ok(/allowNetworkAccess:\s*cfg\.ALLOW_NETWORK_ACCESS/.test(server), '/api/config returns the current value');
  ok(/authConfigured:/.test(server) && /require\('\.\/users'\)\.count\(cfg\.DATA_DIR\) > 0/.test(server),
    '/api/config reports whether a sign-in exists, so the UI can gate the toggle');
  // The write path refuses to turn it ON without auth (mirrors the config gate, with a clear message).
  ok(/if \(existing\.allowNetworkAccess === true\)/.test(server) &&
     /res\.status\(400\)[\s\S]*?Create an account first/.test(server),
    'saving allowNetworkAccess ON without an account is rejected with 400 + a clear message');

  const chat = read('lib', 'public', 'js', 'chat.js');
  ok(/getElementById\('cfg-allow-network'\)/.test(chat), 'the client wires up the network toggle');
  ok(/if \(cfgAllowNetwork\.checked && !authConfigured\)/.test(chat),
    'the client blocks turning the toggle on without a configured sign-in');
  ok(/allowNetworkAccess: cfgAllowNetwork\.checked/.test(chat), 'the toggle is sent on save');
  ok(/cfgAllowNetwork\.checked !== networkWasOn/.test(chat) && /Restart Lokyni/.test(chat),
    'a change to network access prompts the user to restart (bind address is chosen at startup)');

  const ejs = read('lib', 'views', 'chat.ejs');
  ok(/id="cfg-allow-network"/.test(ejs), 'the Settings UI renders the network toggle');

  console.log(`\nALL NETWORK-ACCESS TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ NETWORK-ACCESS TEST FAILED:', e && e.message);
  process.exit(1);
}
