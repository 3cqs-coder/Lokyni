'use strict';
// Replica write-safety: a read replica shares the data dir with the primary, so it must NEVER write shared
// primary state (the hard rule). This guards the whole class of fixes — index reflect, the automations
// scheduler, the learning/semantic-cache stores, URL ingest, and session pruning all refuse or no-op on a
// replica. Functional where cheap (mocking cluster.isReplica), source-guarded for the route/boot sites.
// Run: `npm run test:unit`.

const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(PROJECT, ...p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

(async () => {
  const cluster = require(path.join(PROJECT, 'lib', 'cluster'));
  const origIsReplica = cluster.isReplica;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-replica-'));
  try {
    cluster.isReplica = () => true;   // pretend this node is a read replica for every guarded call below

    // ── index reflect: no-op on a replica (does not touch the shared index) ──
    const init = require(path.join(PROJECT, 'lib', 'indexing', 'init'));
    let onNonActiveCalled = false;
    await init.reflectWorkspaceMutation('some-nonactive-ws', () => { onNonActiveCalled = true; });
    ok(onNonActiveCalled === false, 'reflectWorkspaceMutation does no index work on a replica');

    // ── outcomes.record: writes nothing and returns null on a replica ──
    const outcomes = require(path.join(PROJECT, 'lib', 'outcomes'));
    const r = outcomes.record(tmp, { workspace: 'default', query: 'q', docIds: ['d1'], topReranker: 0.5 });
    ok(r === null, 'outcomes.record returns null on a replica');
    ok(!fs.existsSync(path.join(tmp, 'outcomes.json')), 'outcomes.record writes no file on a replica');

    // ── semanticcache.store: writes nothing on a replica ──
    const sc = require(path.join(PROJECT, 'lib', 'semanticcache'));
    await sc.store(tmp, { fingerprint: 'fp', signature: 'sig', query: 'q', answer: 'a', sources: [] });
    ok(!fs.existsSync(sc.filePathFor(tmp)), 'semanticcache.store writes no file on a replica');

    // ── outcomes.rate: no-op on a replica (sibling of record; the missed guard) ──
    ok(outcomes.rate(tmp, 'any-id', 1) === false, 'outcomes.rate is a no-op on a replica');

    // ── SSO provisioning: a NEW identity is refused on a replica (writes users.json + first-admin election) ──
    const accounts = require(path.join(PROJECT, 'lib', 'accounts'));
    const prov = accounts.provisionSsoUser(tmp, { subject: 'new-subject-xyz', email: 'x@example.com', emailVerified: true }, { autoCreate: true });
    ok(prov && prov.ok === false && prov.retryOnPrimary === true, 'SSO provisioning of a new identity is refused on a replica (retry on primary)');

    // ── but an ALREADY-LINKED SSO user still signs in on a replica (pure read, before the write guard) ──
    // This pins the guard's placement: if a refactor moved isReplica() above the getBySsoSubject read, every
    // SSO user would be locked out of all replicas — and only this assertion would catch it.
    const users = require(path.join(PROJECT, 'lib', 'users'));
    users.create(tmp, { username: 'ssouser', passwordHash: 'sso:seed', ssoSubject: 's1', role: 'member' });
    const existing = accounts.provisionSsoUser(tmp, { subject: 's1' }, { autoCreate: true });
    ok(existing && existing.ok === true, 'an already-linked SSO user signs in on a replica (read path precedes the provisioning guard)');

    // ── and the inverse: on the PRIMARY these DO write (so the guard is not a blanket disable) ──
    cluster.isReplica = () => false;
    const r2 = outcomes.record(tmp, { workspace: 'default', query: 'q', docIds: ['d1'], topReranker: 0.5 });
    ok(typeof r2 === 'string', 'outcomes.record records normally on the primary');
    ok(outcomes.rate(tmp, r2, 1) === true, 'outcomes.rate applies on the primary');
    await sc.store(tmp, { fingerprint: 'fp', signature: 'sig', query: 'q', answer: 'a', sources: [] });
    ok(fs.existsSync(sc.filePathFor(tmp)), 'semanticcache.store writes on the primary');
  } finally {
    cluster.isReplica = origIsReplica;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  // ── source-guards for the route / scheduler / boot sites ──
  ok(/if \(require\('\.\.\/cluster'\)\.isReplica\(\)\) return res\.status\(409\)/.test(read('lib', 'routes', 'apiv1.js')),
    'POST /api/v1/ingest-url refuses on a replica (no shared-index write)');
  ok(/if \(require\('\.\/cluster'\)\.isReplica\(\)\) \{ require\('\.\/logbuffer'\)\.debug[\s\S]{0,120}?return; \}/.test(read('lib', 'automations.js')),
    'the automations scheduler does not start on a replica (no duplicate emails / racing writes)');
  ok(/if \(!require\('\.\/cluster'\)\.isReplica\(\)\) \{\s*\n\s*const \{ pruneOldSessions \}/.test(read('lib', 'server.js')),
    'session pruning (which deletes shared files) runs only on the primary');
  ok(/if \(require\('\.\.\/cluster'\)\.isReplica\(\)\) \{ if \(DEBUG\) console\.log[\s\S]{0,120}?return; \}/.test(read('lib', 'indexing', 'init.js')),
    'reflectWorkspaceMutation has the replica guard at the top');
  // Account creation is primary-only (closes the first-admin election race on the shared user store); sign-in
  // and self-service password change deliberately stay on any node.
  const auth = read('lib', 'routes', 'auth.js');
  ok(/router\.post\('\/signup', authmw\.requirePrimary,/.test(auth), 'POST /auth/signup is primary-only (first-admin election cannot race across nodes)');
  ok(!/router\.post\('\/password', authmw\.requirePrimary/.test(auth), 'POST /auth/password deliberately stays on any node (self-service, per-user, no cross-node election)');
  // The SSO callback writes the shared user store only via provisionSsoUser, which carries the replica guard
  // (verified functionally above); the config-writing /api/smtp route is primary-only like /api/config.
  ok(/app\.use\('\/api\/smtp', authmw\.requireGlobalAdmin, authmw\.requirePrimary,/.test(read('lib', 'server.js')),
    'POST /api/smtp (writes config.json) is primary-only, matching /api/config');
  // The deleted workspace's settings cache entry is dropped so the cache can't leak across create/delete churn.
  ok(/invalidateJsonCache\(settingsPath\(dataDir, id\)\);\s*\/\/ drop the deleted/.test(read('lib', 'workspaces.js')),
    'deleteWorkspace invalidates the deleted workspace settings cache entry');

  // ── never-orphan: parse children are tracked and SIGKILLed on every exit path ──
  const ep = read('lib', 'indexing', 'extractprocess.js');
  ok(/const _liveChildren = new Set\(\)/.test(ep) && /_liveChildren\.add\(child\)/.test(ep) && /const killAllChildrenSync/.test(ep),
    'extractprocess tracks live parse children and exposes a sync kill-all');
  ok(/shutdown\.onExitKill\(\(\) => \{ try \{ require\('\.\/lib\/indexing\/extractprocess'\)\.killAllChildrenSync\(\)/.test(read('lokyni.js')),
    'the parse-child kill-all is registered as an onExitKill backstop (every exit path)');

  console.log(`\nALL REPLICA-WRITE-SAFETY TESTS PASSED (${checks} checks)`);
  process.exit(0);
})().catch((e) => { console.error('\n✗ REPLICA-WRITE-SAFETY TEST FAILED:', e && e.message); process.exit(1); });
