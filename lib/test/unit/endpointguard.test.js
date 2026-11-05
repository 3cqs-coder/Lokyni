'use strict';
// Guards the /api/models no-leak rule (lib/endpointguard.js + the route in lib/server.js). The Settings
// form can list a provider's models before saving by passing a `?host=`/`?base_url=` override, but that
// must never (1) let the route probe an attacker-supplied PUBLIC server, or (2) leak the stored API key to
// a non-saved endpoint. The rule: honor an override only when it is local/LAN or equals the saved endpoint;
// send the stored key only when the chosen endpoint IS the saved one. Pure/offline. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { isLocalEndpoint, pickEndpoint } = require(path.join(PROJECT, 'lib', 'endpointguard'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

try {
  // ── isLocalEndpoint: loopback / LAN / local-ish names are local; public addresses and junk are not ──
  for (const u of ['http://localhost:11434', 'http://127.0.0.1:11434', 'http://[::1]:11434',
                    'http://192.168.1.50:11434', 'http://10.0.0.5:11434', 'http://box.local', 'http://svc.internal']) {
    ok(isLocalEndpoint(u) === true, `local/LAN endpoint is allowed: ${u}`);
  }
  for (const u of ['https://api.openai.com/v1', 'https://api.anthropic.com/v1/', 'https://evil.example/v1',
                   'http://8.8.8.8', 'not a url', '', null, undefined]) {
    ok(isLocalEndpoint(u) === false, `public / invalid endpoint is NOT local: ${JSON.stringify(u)}`);
  }

  // ── pickEndpoint: override honored only when equal-to-saved or local; otherwise the saved endpoint wins ──
  const SAVED = 'https://api.openai.com/v1';
  eq(pickEndpoint('https://evil.example/v1', SAVED), SAVED, 'a foreign public override is ignored → saved endpoint used');
  eq(pickEndpoint('http://localhost:1234/v1', SAVED), 'http://localhost:1234/v1', 'a local override is honored (self-hosted)');
  eq(pickEndpoint(SAVED, SAVED), SAVED, 'an override equal to the saved endpoint is used');
  eq(pickEndpoint('', SAVED), SAVED, 'no override → saved endpoint');

  // ── Key-gating simulation: the stored key is sent ONLY to the saved endpoint. A foreign override is
  //    dropped (so the attacker's server is never contacted at all); a local override IS contacted but
  //    WITHOUT the key. So the invariant is: whenever the chosen endpoint is not the saved one, the key
  //    is empty — and a foreign override never becomes the chosen endpoint. ──
  const keyFor = (override, saved, storedKey) => { const picked = pickEndpoint(override, saved); return picked === saved ? storedKey : ''; };
  ok(pickEndpoint('https://evil.example/v1', SAVED) !== 'https://evil.example/v1', 'a foreign override is never the contacted endpoint (attacker server never probed)');
  eq(keyFor('http://localhost:1234/v1', SAVED, 'sk-secret'), '', 'a local override is probed WITHOUT the stored key (chosen endpoint != saved)');
  eq(keyFor('', SAVED, 'sk-secret'), 'sk-secret', 'the stored key is sent to the saved endpoint');
  // The key is empty for ANY chosen endpoint that is not the saved one (the core no-leak property).
  for (const override of ['http://localhost:9/v1', 'http://10.1.2.3/v1', 'http://box.local/v1']) {
    const picked = pickEndpoint(override, SAVED);
    if (picked !== SAVED) eq(keyFor(override, SAVED, 'sk-secret'), '', `key withheld from a non-saved endpoint (${override})`);
  }

  // ── SOURCE GUARD: the route actually applies the key gate for all three providers ──
  const srv = fs.readFileSync(path.join(PROJECT, 'lib', 'server.js'), 'utf-8');
  ok(/host === cfg\.OLLAMA_HOST \? cfg\.OLLAMA_KEY : ''/.test(srv), 'ollama branch sends the key only to the saved host');
  ok(/base === cfg\.OPENAI_BASE \? cfg\.OPENAI_KEY : ''/.test(srv), 'openai branch sends the key only to the saved base');
  ok(/base === cfg\.ANTHROPIC_BASE \? cfg\.ANTHROPIC_KEY : ''/.test(srv), 'anthropic branch sends the key only to the saved base');
  ok(/require\('\.\/endpointguard'\)/.test(srv), 'the route uses the single-sourced endpoint guard');

  console.log(`\nALL ENDPOINTGUARD TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ ENDPOINTGUARD UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
