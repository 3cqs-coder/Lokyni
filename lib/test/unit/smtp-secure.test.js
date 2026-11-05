'use strict';
// Guards that the SMTP "Send test" route resolves the `secure` flag the SAME way the real send path
// does. The actual send (lib/mailer.js buildTransport) defaults `secure` to `port === 465` when the
// config omits it. The test route (lib/routes/smtp.js) must use that same rule when the form omits
// secure — otherwise testing a hand-edited port-465 config with no `secure` key connects with
// secure:false against a TLS-only port and reports a false failure that disagrees with real digest
// email. This drift guard keeps the two defaults in lockstep. No network. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

try {
  const mailer = fs.readFileSync(path.join(PROJECT, 'lib', 'mailer.js'), 'utf-8');
  const smtp   = fs.readFileSync(path.join(PROJECT, 'lib', 'routes', 'smtp.js'), 'utf-8');

  // The real send path's rule: secure falls back to (port === 465).
  ok(/const secure = smtp\.secure \?\? \(smtp\.port === 465\)/.test(mailer),
    'mailer defaults secure to (port === 465) when the config omits it');
  // A non-secure (STARTTLS) transport must require the TLS upgrade, so credentials/content can't go out in
  // cleartext against a server that doesn't advertise STARTTLS.
  ok(/requireTLS: true/.test(mailer) && /secure \? \{\} : \{ requireTLS: true \}/.test(mailer),
    'a non-secure transport requires STARTTLS (no opportunistic-cleartext fallback)');

  // Bounded SMTP timeouts so a stalled host can't tie up an awaited digest delivery, and the per-call
  // transport is closed so its connection pool is freed.
  ok(/connectionTimeout:/.test(mailer) && /greetingTimeout:/.test(mailer) && /socketTimeout:/.test(mailer),
    'mailer sets connection/greeting/socket timeouts on the transport');
  ok((mailer.match(/\.close\(\)/g) || []).length >= 2,
    'both sendMail and testConnection close the transport in a finally');

  // The test route computes the effective port first, then resolves secure with the same 465 rule
  // when the form omits it (rather than coercing an omitted value to false).
  ok(/const effPort = parseInt\(port, 10\) \|\| saved\.port \|\| 587;/.test(smtp),
    'the test route resolves the effective port before deciding secure');
  ok(/secure: \(secure === undefined \? \(saved\.secure \?\? \(effPort === 465\)\) : \(secure === true \|\| secure === 'true'\)\)/.test(smtp),
    'the test route resolves an omitted secure via the same (port === 465) rule as the real send path');
  // The old coerce-to-false shortcut must be gone (it caused the false failure on a port-465 config).
  ok(!/secure === undefined \? !!saved\.secure/.test(smtp),
    'the test route no longer coerces an omitted secure to !!saved.secure (the port-465 false-failure)');

  // smtp.pass is sealed at rest, and the test route reads the saved password from the on-disk (sealed) config.
  // It must OPEN it before handing it to the SMTP client — otherwise a test without a re-typed password would
  // authenticate with the sb1: ciphertext and fail. Guard that the raw sealed fallback is gone.
  ok(/readSecret\(saved\.pass, 'smtp\.pass', config\.SECRET_KEY_SRC\)/.test(smtp),
    'the test route opens the sealed saved password before using it');
  ok(!/pass: pass \|\| saved\.pass \|\| ''/.test(smtp),
    'the test route no longer hands the raw (sealed) saved password to the SMTP client');

  console.log(`\nALL SMTP-SECURE UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ SMTP-SECURE UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
