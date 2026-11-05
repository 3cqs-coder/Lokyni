'use strict';
// Regression tests for the API-key store (lib/apikeys.js): keys are stored hashed and the
// plaintext is shown once, authentication matches only the exact key and rejects revoked
// ones, and the mtime-keyed cache (added so authenticate doesn't read+parse the file on
// every request) stays correct — it refreshes when the file changes and never serves a
// stale list. Uses a temp data dir — no network. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const ak = require(path.join(PROJECT, 'lib', 'apikeys'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-aktest-'));
try {
  // ── create + authenticate ──
  const { record, key } = ak.createKey(dir, { name: 'test', scopes: ['search', 'read'] });
  ok(key && key.startsWith('lok_'), 'createKey returns a plaintext key');
  ok(!('hash' in record), 'the returned record never exposes the hash');
  ok(fs.existsSync(path.join(dir, 'api-keys.json')), 'the key file is written');
  // The key-hash store must be owner-only (0600) so another local user on a shared host can't read it.
  // File-mode bits are not meaningful on Windows, so assert only on POSIX.
  if (process.platform !== 'win32') {
    const mode = fs.statSync(path.join(dir, 'api-keys.json')).mode & 0o777;
    ok(mode === 0o600, `the key file is owner-only (0600), got 0${mode.toString(8)}`);
  }
  const auth = ak.authenticate(dir, key);
  ok(auth && auth.id === record.id, 'the exact key authenticates');
  ok(ak.authenticate(dir, 'lok_wrongwrongwrong') === null, 'a wrong key is rejected');
  ok(ak.hasScope(auth, 'search') && !ak.hasScope(auth, 'write'), 'scopes are enforced as issued');
  console.log('✓ apikeys: create, hash-at-rest, and scoped authentication');

  // ── the mtime cache refreshes when a second key is added ──
  const { key: key2 } = ak.createKey(dir, { name: 'second' });
  ok(ak.authenticate(dir, key2) !== null, 'a newly created key authenticates (cache refreshed on write)');
  ok(ak.authenticate(dir, key) !== null, 'the first key still authenticates after the second is added');
  console.log('✓ apikeys: the cache refreshes when a key is added');

  // ── an external edit to the file is picked up (mtime changed) ──
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'api-keys.json'), 'utf-8'));
  raw.keys = raw.keys.filter(k => k.id !== record.id);   // externally remove the first key
  // Ensure a distinct mtime even on a coarse-resolution clock.
  fs.writeFileSync(path.join(dir, 'api-keys.json'), JSON.stringify(raw));
  const future = new Date(Date.now() + 2000);
  fs.utimesSync(path.join(dir, 'api-keys.json'), future, future);
  ok(ak.authenticate(dir, key) === null, 'an externally removed key stops authenticating (cache is not stale)');
  ok(ak.authenticate(dir, key2) !== null, 'the remaining key still authenticates');
  console.log('✓ apikeys: an external edit invalidates the cache by mtime');

  // ── revoke ──
  ak.revokeKey(dir, ak.authenticate(dir, key2).id);
  ok(ak.authenticate(dir, key2) === null, 'a revoked key no longer authenticates');
  console.log('✓ apikeys: revocation takes effect immediately');

  // ── lastUsed is recorded, and BOTH network auth surfaces record it ──
  // lastUsed drives the "never used" label in Settings; a key used only through one surface must not
  // look dormant. touchLastUsed sets it, and both the HTTP API and the network MCP endpoint call it.
  const { record: r3, key: key3 } = ak.createKey(dir, { name: 'used' });
  ok(r3.lastUsed == null, 'a fresh key starts with no lastUsed');
  ak.touchLastUsed(dir, r3.id);
  const view = ak.listKeys(dir).find(k => k.id === r3.id);
  ok(view && view.lastUsed != null, 'touchLastUsed records the key as used');
  const apiv1 = fs.readFileSync(path.join(PROJECT, 'lib', 'routes', 'apiv1.js'), 'utf-8');
  const mcp   = fs.readFileSync(path.join(PROJECT, 'lib', 'mcp', 'server.js'), 'utf-8');
  ok(/touchLastUsed\(cfg\.DATA_DIR, record\.id\)/.test(apiv1), 'the HTTP API records key usage');
  ok(/touchLastUsed\(cfg\.DATA_DIR, record\.id\)/.test(mcp), 'the network MCP endpoint records key usage (parity with the HTTP API)');
  console.log('✓ apikeys: usage is recorded and both network auth surfaces update lastUsed');
  void key3;

  // ── Key ownership + cascade (multi-user): a key records its creating user and is revoked when that user
  //    is deleted, so a departed user's keys never live on. ──
  const owned = ak.createKey(dir, { name: 'owned', scopes: ['search'], ownerUserId: 'u_owner1' });
  ok(owned.record.ownerUserId === 'u_owner1', 'a created key records its owner');
  const other = ak.createKey(dir, { name: 'other', scopes: ['search'], ownerUserId: 'u_owner2' });
  const revoked = ak.removeForOwner(dir, 'u_owner1');
  ok(revoked === 1, 'removeForOwner revokes exactly the owner\'s keys');
  ok(ak.authenticate(dir, owned.key) === null, 'the deleted owner\'s key no longer authenticates');
  ok(ak.authenticate(dir, other.key) !== null, 'another owner\'s key is untouched');
  ok(ak.removeForOwner(dir, 'u_nobody') === 0, 'removeForOwner is a no-op for an owner with no keys');
  console.log('✓ apikeys: keys carry an owner and are revoked when that user is deleted (no orphaned keys)');

  // The scope list is single-sourced from the authz scope→capability map, so a scope can't validate here yet
  // grant nothing in authz (the two can't drift).
  const authz = require(path.join(PROJECT, 'lib', 'authz'));
  assert.deepStrictEqual(ak.ALL_SCOPES, Object.keys(authz.SCOPE_CAPS)); checks++;
  ok(ak.ALL_SCOPES.every(s => Array.isArray(authz.SCOPE_CAPS[s])), 'every API-key scope maps to an authz capability set');
  console.log('✓ apikeys: the scope list is single-sourced from authz.SCOPE_CAPS (no drift)');

  // The scope PICKER (UI) is driven by the same source: apiKeyScopeList covers exactly the SCOPE_CAPS scopes,
  // in a stable order, each with a human label — so the checkboxes can never offer a scope the server won't
  // honor nor miss one that's added. The EJS no longer hardcodes the scopes; the client renders this list.
  const picker = authz.apiKeyScopeList();
  assert.deepStrictEqual(picker.map(s => s.scope).sort(), Object.keys(authz.SCOPE_CAPS).sort()); checks++;
  ok(picker.every(s => typeof s.label === 'string' && s.label), 'every picker scope has a label');
  ok(picker.every((s, i) => i === 0 || picker[i - 1].order <= s.order), 'the picker list is in display order');
  const ejs = fs.readFileSync(path.join(PROJECT, 'lib', 'views', 'chat.ejs'), 'utf-8');
  ok(/id="apikey-scope-list"/.test(ejs) && !/class="apikey-scope" value="search"/.test(ejs),
    'the API-key scope checkboxes are rendered from the server list, not hardcoded in the page');
  const chatJs = fs.readFileSync(path.join(PROJECT, 'lib', 'public', 'js', 'chat.js'), 'utf-8');
  ok(/function renderApiKeyScopes\(list\)/.test(chatJs) && /cfg\.apiKeyScopes/.test(chatJs),
    'the client renders the scope checkboxes from cfg.apiKeyScopes');
  console.log('✓ apikeys: the scope PICKER is single-sourced from authz too (UI can\'t drift)');

  // ── Bounded retention: the store is compacted so create/revoke churn can't grow it without limit ──
  // revokeKey records when a key was revoked (recency for compaction + a finer audit timestamp).
  const toRevoke = ak.createKey(dir, { name: 'short-lived' });
  ak.revokeKey(dir, toRevoke.record.id);
  const revView = ak.listKeys(dir).find(k => k.id === toRevoke.record.id);
  ok(revView && revView.revoked === true, 'a revoked key is marked revoked');
  // revokedAt is internal (not in the public view) — read the raw store to confirm it is stamped.
  const rawKeys = JSON.parse(fs.readFileSync(path.join(dir, 'api-keys.json'), 'utf-8')).keys;
  const rawRev = rawKeys.find(k => k.id === toRevoke.record.id);
  ok(rawRev && typeof rawRev.revokedAt === 'number', 'revokeKey stamps revokedAt');

  // compact() drops only the oldest REVOKED keys beyond the cap; active keys are never dropped.
  const CAP = ak._MAX_REVOKED_RETAINED;
  const synthetic = [];
  synthetic.push({ id: 'active1', revoked: false, created: 1 });
  synthetic.push({ id: 'active2', revoked: false, created: 2 });
  for (let i = 0; i < CAP + 50; i++) synthetic.push({ id: 'r' + i, revoked: true, created: 1000 + i, revokedAt: 1000 + i });
  const compacted = ak._compact(synthetic);
  const activeOut = compacted.filter(k => !k.revoked);
  const revokedOut = compacted.filter(k => k.revoked);
  ok(activeOut.length === 2 && activeOut.some(k => k.id === 'active1') && activeOut.some(k => k.id === 'active2'), 'compaction keeps every active key');
  ok(revokedOut.length === CAP, `compaction caps revoked keys at ${CAP}`);
  ok(revokedOut.every(k => k.revokedAt >= 1050), 'compaction keeps the most RECENTLY revoked keys, drops the oldest');
  // Under the cap, compact is a no-op that preserves order (the common case).
  const few = [{ id: 'a', revoked: false }, { id: 'b', revoked: true, revokedAt: 5 }, { id: 'c', revoked: false }];
  const sameRef = ak._compact(few);
  ok(sameRef === few, 'compact returns the array unchanged when under the cap (no needless rewrite)');
  console.log('✓ apikeys: the store is bounded — active keys always kept, only oldest revoked keys compacted');

  console.log(`\nALL APIKEYS UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ APIKEYS UNIT TEST FAILED:', e && e.message);
  process.exit(1);
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
