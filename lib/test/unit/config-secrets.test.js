'use strict';
// End-to-end: config.json reversible secrets are sealed at rest and transparently opened for use. Runs the
// REAL config module in a child process whose cwd is a throwaway dir (so config/config.json and data/secret.key
// land there, never the project's). Proves: a plaintext config is read as plaintext (back-compat), migration
// seals every secret path in place while leaving non-secret fields untouched, a sealed config still opens to
// the exact plaintext on a fresh load (survives a "restart"), and the key file is created 0600 under the data
// dir, separate from config.json. No model, no network. Run: `npm run test:unit`.

const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const CONFIG = path.join(PROJECT, 'lib', 'config.js');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-cfgsec-'));
const cleanup = (code) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(code); };

// Run a short script with cwd=tmp so the real config.js resolves config/ and ./data there. Returns parsed JSON.
const runInTmp = (script) => JSON.parse(execFileSync(process.execPath, ['-e', script], {
  cwd: tmp, encoding: 'utf-8', env: { ...process.env, LOKYNI_SECRET_KEY: '' },   // force the key-FILE path, not an env key
}).trim());

try {
  const SECRET = { openaiApiKey: 'sk-PLAINTEXT-openai-123456', smtp: { host: 'mail.example.test', pass: 'smtp-PLAINTEXT-pw' }, oidc: { enabled: true, issuer: 'https://idp.example.test', clientId: 'abc', clientSecret: 'oidc-PLAINTEXT-secret' }, temperature: 0.5,
    // A proxy URL that embeds a credential (sealed at rest), and a credential-free host (left legible).
    webProxyUrl: 'http://puser:PLAINTEXT-proxypw@proxy.example:8080', ollamaHost: 'http://localhost:11434' };
  fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'config', 'config.json'), JSON.stringify(SECRET, null, 2));

  // 1) A legacy PLAINTEXT config is read as plaintext (back-compat — nothing breaks on upgrade).
  const r1 = runInTmp(`const c=require(${JSON.stringify(CONFIG)});console.log(JSON.stringify({openai:c.OPENAI_KEY,smtp:c.smtp&&c.smtp.pass,oidc:c.oidc.clientSecret,temp:c.TEMPERATURE}))`);
  eq(r1.openai, 'sk-PLAINTEXT-openai-123456', 'legacy plaintext openaiApiKey reads through');
  eq(r1.smtp, 'smtp-PLAINTEXT-pw', 'legacy plaintext smtp.pass reads through');
  eq(r1.oidc, 'oidc-PLAINTEXT-secret', 'legacy plaintext oidc.clientSecret reads through');
  eq(r1.temp, 0.5, 'a non-secret field is unaffected');

  // 2) migrateSecrets() seals every secret path in place; non-secret fields stay put; key file appears 0600.
  const r2 = runInTmp(`const c=require(${JSON.stringify(CONFIG)});console.log(JSON.stringify({migrated:c.migrateSecrets()}))`);
  eq(r2.migrated, true, 'migrateSecrets reports it rewrote the file');
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'config', 'config.json'), 'utf-8'));
  ok(onDisk.openaiApiKey.startsWith('sb1:'), 'openaiApiKey is sealed on disk after migration');
  ok(onDisk.smtp.pass.startsWith('sb1:'), 'smtp.pass is sealed on disk');
  ok(onDisk.oidc.clientSecret.startsWith('sb1:'), 'oidc.clientSecret is sealed on disk');
  ok(onDisk.webProxyUrl.startsWith('sb1:'), 'a credential-bearing webProxyUrl is sealed on disk');
  eq(onDisk.ollamaHost, 'http://localhost:11434', 'a credential-FREE URL (ollamaHost) is left legible at rest, not sealed');
  ok(!JSON.stringify(onDisk).includes('PLAINTEXT'), 'no plaintext secret (incl. the proxy password) remains anywhere in the file');
  eq(onDisk.temperature, 0.5, 'the non-secret field is untouched on disk');
  eq(onDisk.oidc.issuer, 'https://idp.example.test', 'a non-secret field inside a secret-bearing block is untouched');
  const keyFile = path.join(tmp, 'data', 'secret.key');
  ok(fs.existsSync(keyFile), 'the master key file is created under the data dir (not config/)');
  if (process.platform !== 'win32') eq(fs.statSync(keyFile).mode & 0o777, 0o600, 'the key file is 0600');

  // 3) A fresh load of the now-SEALED config opens every secret back to the exact plaintext (survives restart).
  const r3 = runInTmp(`const c=require(${JSON.stringify(CONFIG)});console.log(JSON.stringify({openai:c.OPENAI_KEY,smtp:c.smtp&&c.smtp.pass,oidc:c.oidc.clientSecret}))`);
  eq(r3.openai, 'sk-PLAINTEXT-openai-123456', 'sealed openaiApiKey opens to plaintext on a fresh load');
  eq(r3.smtp, 'smtp-PLAINTEXT-pw', 'sealed smtp.pass opens to plaintext');
  eq(r3.oidc, 'oidc-PLAINTEXT-secret', 'sealed oidc.clientSecret opens to plaintext');
  const r3b = runInTmp(`const c=require(${JSON.stringify(CONFIG)});console.log(JSON.stringify({proxy:c.WEB_PROXY_URL}))`);
  eq(r3b.proxy, 'http://puser:PLAINTEXT-proxypw@proxy.example:8080', 'the sealed webProxyUrl opens to the exact plaintext (credential intact) for use');

  // 4) migrate is idempotent — a second run finds nothing to do (all already sealed).
  const r4 = runInTmp(`const c=require(${JSON.stringify(CONFIG)});console.log(JSON.stringify({migrated:c.migrateSecrets()}))`);
  eq(r4.migrated, false, 'a second migration is a no-op (everything already sealed)');

  // ── A changed/missing master key: sealed secrets can't open → they are left verbatim (fail cleanly, no crash)
  //    AND one honest warning is emitted (not a silent auth failure). Replace the key file, then reload. ──
  require('crypto') && fs.writeFileSync(path.join(tmp, 'data', 'secret.key'), require('crypto').randomBytes(32));   // wrong key now
  const bad = spawnSync(process.execPath, ['-e', `const c=require(${JSON.stringify(CONFIG)});console.log(JSON.stringify({openai:c.OPENAI_KEY}))`], {
    cwd: tmp, encoding: 'utf-8', env: { ...process.env, LOKYNI_SECRET_KEY: '' },
  });
  const badOut = JSON.parse(bad.stdout.trim());
  ok(badOut.openai.startsWith('sb1:'), 'an undecryptable secret is left as its sealed blob (fails cleanly downstream, never crashes the app)');
  ok(/could not be decrypted/i.test(bad.stderr), 'a changed/missing key emits one honest warning, not a silent failure');
  eq(bad.status, 0, 'the app still starts (a bad key never blocks boot)');
  // Restore the real key so the next steps see a consistent state (re-seal under the restored key by migrating).
  // (The original key was overwritten; from here on the file holds the new key, which is self-consistent.)

  // ── Single source of truth: every schema secret must be BOTH sealed at rest AND redacted from the browser,
  //    so adding a type:'secret' field can never leave it plaintext on disk or leaked through GET /api/config. ──
  const { SECRET_KEYS } = require(path.join(PROJECT, 'lib', 'settings-schema'));
  const cfgMod = require(CONFIG);
  for (const k of SECRET_KEYS) {
    ok(cfgMod.CONFIG_SECRET_PATHS.includes(k), `schema secret "${k}" is in CONFIG_SECRET_PATHS (sealed at rest)`);
  }
  ok(cfgMod.CONFIG_SECRET_PATHS.includes('smtp.pass') && cfgMod.CONFIG_SECRET_PATHS.includes('oidc.clientSecret'),
    'the nested smtp.pass and oidc.clientSecret are sealed too');
  const serverSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'server.js'), 'utf-8');
  for (const k of SECRET_KEYS) {
    ok(new RegExp(`!!raw\\.${k}\\b`).test(serverSrc) || new RegExp(`${k}Set\\b`).test(serverSrc),
      `schema secret "${k}" is redacted to a boolean flag in GET /api/config (never sent to the browser)`);
  }
  console.log('✓ config-secrets: every schema secret is sealed at rest and redacted from the browser (no drift)');

  // ── Credential-bearing URL fields: every MASKCRED path must be masked in the GET echo (so an embedded
  //    password never reaches the browser) AND kept-when-masked on save (so an un-retyped value isn't wiped). ──
  ok(Array.isArray(cfgMod.MASKCRED_PATHS) && cfgMod.MASKCRED_PATHS.includes('webProxyUrl'),
    'MASKCRED_PATHS lists the credential-bearing URL fields (webProxyUrl, model host, base URLs)');
  // GET masking is driven by the ONE MASKCRED_PATHS list (not a hardcoded per-field copy), so a new such field
  // can't be added without its echo being masked. Same for the non-admin clear.
  ok(/for \(const k of cfg\.MASKCRED_PATHS\) if \(typeof payload\[k\] === 'string'\) payload\[k\] = maskUrl\(payload\[k\]\)/.test(serverSrc),
    'GET /api/config masks every MASKCRED path from the single list (no hardcoded per-field copy)');
  ok(/for \(const k of cfg\.MASKCRED_PATHS\) if \(k in payload\) payload\[k\] = ''/.test(serverSrc),
    'the non-admin redaction clears every MASKCRED path from the same list (anthropicBaseUrl included)');
  // POST restores a still-masked password per entry from the stored value (so editing one proxy in a list does
  // not require re-typing the others), keeping the stored value only when a masked entry cannot be matched.
  ok(/fillMaskedPasswords\(val,/.test(serverSrc) && /isMaskedUrl\(merged\)\) continue/.test(serverSrc.replace(/\n/g, ' ')),
    'POST /api/config restores masked passwords per entry and keeps the stored value only on an unresolved mask');
  console.log('✓ config-secrets: credential-bearing URLs are masked from one list and restored per-entry on save');

  console.log(`\nALL CONFIG-SECRETS TESTS PASSED (${checks} checks)`);
  cleanup(0);
} catch (e) {
  console.error('\n✗ CONFIG-SECRETS TEST FAILED:', e && (e.stack || e.message));
  cleanup(1);
}
