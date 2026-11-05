'use strict';
// Guards the uniform CSRF defense on the /api control plane. The functional requireCsrf behavior
// (unsafe-method gate, safe-method skip, _csrf body field, non-cookie pass-through) is exercised in
// multiuser-auth.test.js; this locks in the WIRING so a refactor can't silently remove it:
//   • the server mounts requireCsrf across the whole /api control plane;
//   • requireCsrf skips safe methods (so mounting it can't block reads or the key data planes);
//   • the browser attaches the token at one choke point (a fetch wrapper) and warms it at load;
//   • the two paths that can't go through the wrapper — the streamed backup-download form and the
//     XHR upload — carry the token themselves.
// Run: `npm run test:unit`.

const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(PROJECT, ...p), 'utf-8');
// Isolated secret dir so the behavioral checks never read or write the repo's real auth secret.
const SECRET_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-csrf-'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // ── server mounts the gate on the whole /api control plane ──
  const server = read('lib', 'server.js');
  ok(/app\.use\(\s*['"]\/api['"]\s*,\s*authmw\.requireCsrf\(/.test(server), 'server mounts requireCsrf on /api');
  // It must be mounted AFTER the body parsers (so a _csrf field is parsed) and AFTER attachPrincipal
  // (so req.principal is resolved), but BEFORE the first /api route.
  const idxUrlencoded = server.indexOf('express.urlencoded');
  const idxPrincipal  = server.indexOf('attachPrincipal(DATA_DIR_AUTH)');
  const idxCsrfMount  = server.search(/app\.use\(\s*['"]\/api['"]\s*,\s*authmw\.requireCsrf\(/);
  const idxFirstApi   = server.search(/app\.(post|put|patch|delete)\(\s*['"]\/api\//);
  ok(idxUrlencoded > 0 && idxUrlencoded < idxCsrfMount, 'the /api CSRF gate is mounted after the urlencoded body parser');
  ok(idxPrincipal > 0 && idxPrincipal < idxCsrfMount, 'the /api CSRF gate is mounted after attachPrincipal');
  ok(idxFirstApi > 0 && idxCsrfMount < idxFirstApi, 'the /api CSRF gate is mounted before the first /api route');

  // ── requireCsrf skips safe methods ──
  const amw = read('lib', 'authmiddleware.js');
  ok(/CSRF_SAFE_METHODS/.test(amw) && /if \(CSRF_SAFE_METHODS\.has\(req\.method\)\) return next\(\)/.test(amw), 'requireCsrf skips safe methods');
  ok(/req\.body && req\.body\._csrf/.test(amw), 'requireCsrf still reads the _csrf body field');

  // Behavioral: the exported middleware really lets a GET through with no principal/token, and a POST
  // with a cookie-session principal but no token is rejected.
  const authmw = require(path.join(PROJECT, 'lib', 'authmiddleware'));
  const mkRes = () => ({ statusCode: 200, status(c) { this.statusCode = c; return this; }, json() { return this; } });
  const call = (req) => { let nexted = false; const res = mkRes(); authmw.requireCsrf(SECRET_DIR)(req, res, () => { nexted = true; }); return { nexted, res }; };
  ok(call({ method: 'GET', principal: { kind: 'user', sessionId: 's' }, get: () => '' }).nexted === true, 'GET passes requireCsrf with no token');
  ok(call({ method: 'OPTIONS', principal: { kind: 'user', sessionId: 's' }, get: () => '' }).nexted === true, 'OPTIONS passes requireCsrf');
  ok(call({ method: 'POST', principal: { kind: 'apikey', scopes: [] }, get: () => '', body: {} }).nexted === true, 'POST from an API key passes requireCsrf');
  const bad = call({ method: 'POST', principal: { kind: 'user', sessionId: 's' }, get: () => '', body: {} });
  ok(bad.nexted === false && bad.res.statusCode === 403, 'POST from a cookie session with no token is rejected');

  // ── client attaches the token at one choke point, and warms it ──
  const chat = read('lib', 'public', 'js', 'chat.js');
  ok(/window\.fetch = function/.test(chat), 'chat.js installs a fetch wrapper');
  ok(/_nativeFetch = window\.fetch\.bind\(window\)/.test(chat), 'the wrapper keeps a handle to the native fetch');
  ok(/headers\.set\(['"]x-csrf-token['"]/.test(chat), 'the wrapper sets the x-csrf-token header');
  ok(/CSRF_UNSAFE\s*=\s*\/\^\(POST\|PUT\|PATCH\|DELETE\)/.test(chat), 'the wrapper only adds the token on unsafe methods');
  ok(/_isSameOrigin/.test(chat), 'the wrapper only touches same-origin requests');
  ok(/refreshCsrf\(\);/.test(chat), 'the token is warmed at load');
  ok(/res\.status !== 403/.test(chat) && /await refreshCsrf\(\)/.test(chat), 'the wrapper refreshes and retries once on a CSRF 403');

  // ── the two non-fetch paths carry the token themselves ──
  ok(/add\(['"]_csrf['"], csrfToken\)/.test(chat), 'the streamed backup-download form carries a _csrf field');
  ok(/xhr\.setRequestHeader\(['"]x-csrf-token['"], csrfToken\)/.test(chat), 'the XHR upload sets the x-csrf-token header');

  console.log(`✓ csrf-control-plane: /api is CSRF-gated end-to-end; safe methods and API keys pass (${checks} checks)`);
  try { fs.rmSync(SECRET_DIR, { recursive: true, force: true }); } catch (e) { /* best-effort */ }
  process.exit(0);
} catch (e) {
  try { fs.rmSync(SECRET_DIR, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  console.error('✗ csrf-control-plane:', e && e.message);
  process.exit(1);
}
