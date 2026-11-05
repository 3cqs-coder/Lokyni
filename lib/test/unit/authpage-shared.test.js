'use strict';
// Guards the shared auth-page helper (lib/public/js/authpage.js) used by the account and admin-users pages,
// which are cookie-authenticated but don't load the chat bundle. It centralizes the CSRF token, the request
// header builder, and the HTML escaper that both pages previously duplicated. Verifies the API and behavior,
// and that both pages actually load it and route through it (so a page can't quietly re-inline a drifting copy).
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

(async () => {
  try {
    // Load the browser module into a minimal window shim with a stub fetch that returns a fixed session.
    const sandbox = { window: {}, fetch: () => Promise.resolve({ json: () => Promise.resolve({ csrfToken: 'tok123', authenticated: true, isAdmin: true }) }) };
    global.window = sandbox.window; global.fetch = sandbox.fetch;
    require(path.join(PROJECT, 'lib', 'public', 'js', 'authpage.js'));
    const AuthPage = global.window.AuthPage;

    ok(AuthPage && typeof AuthPage.esc === 'function' && typeof AuthPage.hdrs === 'function' && typeof AuthPage.me === 'function', 'AuthPage exposes esc/hdrs/me');

    // esc matches the escaper the pages relied on (ampersand, angle brackets, double quote).
    ok(AuthPage.esc('<b>&"') === '&lt;b&gt;&amp;&quot;', 'esc escapes &, <, >, and "');
    ok(AuthPage.esc(null) === '' && AuthPage.esc(undefined) === '', 'esc coerces null/undefined to empty');

    // Before a session is loaded, the token is empty and hdrs still returns a well-formed object.
    ok(AuthPage.token() === '', 'token starts empty');
    const h0 = AuthPage.hdrs(false);
    ok(h0.accept === 'application/json' && h0['x-csrf-token'] === '' && !h0['content-type'], 'hdrs(false): accept + empty csrf, no content-type');

    // me() stashes the CSRF token from /auth/me and hands the session to the callback.
    let gotSession = null;
    await AuthPage.me((s) => { gotSession = s; });
    ok(gotSession && gotSession.isAdmin === true, 'me() passes the session to the callback');
    ok(AuthPage.token() === 'tok123', 'me() stores the CSRF token for hdrs()');
    const h1 = AuthPage.hdrs(true);
    ok(h1['x-csrf-token'] === 'tok123' && h1['content-type'] === 'application/json', 'hdrs(true) carries the token and JSON content-type');

    delete global.window; delete global.fetch;

    // ── Both pages load the shared helper and route through it (no re-inlined copy) ──
    for (const page of ['account.ejs', 'admin-users.ejs']) {
      const src = fs.readFileSync(path.join(PROJECT, 'lib', 'views', page), 'utf-8');
      ok(/<script src="\/js\/authpage\.js\?v=<%= assetVersion %>"/.test(src), `${page} loads the shared authpage.js (cache-busted)`);
      ok(/var esc = AuthPage\.esc, hdrs = AuthPage\.hdrs;/.test(src), `${page} aliases the shared esc/hdrs`);
      ok(/AuthPage\.me\(function \(s\)/.test(src), `${page} bootstraps the session via AuthPage.me`);
      // The duplicated definitions must be gone, so a future fix to esc/hdrs can't miss a page.
      ok(!/function hdrs\(json\)/.test(src), `${page} no longer defines its own hdrs`);
      ok(!/function esc\(s\) \{ return String/.test(src), `${page} no longer defines its own esc`);
      ok(!/\bvar csrf = ''/.test(src) && !/csrf = s\.csrfToken/.test(src), `${page} no longer keeps its own csrf token`);
    }

    console.log(`✓ authpage-shared: account + admin pages share one CSRF/header/escaper helper (${checks} checks)`);
    process.exitCode = 0;
  } catch (e) {
    console.error('✗ authpage-shared:', e && e.message);
    process.exitCode = 1;
  }
})();
