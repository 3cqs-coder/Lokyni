'use strict';
// Guards cluster (scale-out) mode (lib/cluster.js) and its wiring. Roles are static (no election), so the
// decision is a pure function — tested directly for every combination of config + CLI. Also checks the
// requirePrimary guard refuses writes on a replica, and source-inspects the wiring so a future edit can't
// silently let a replica write the shared index or start the indexer. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const cluster = require(path.join(PROJECT, 'lib', 'cluster'));
const authmw = require(path.join(PROJECT, 'lib', 'authmiddleware'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

try {
  // ── resolveMode: config + CLI, CLI wins ──
  eq(cluster.resolveMode({}), 'off', 'default is a single node (off)');
  eq(cluster.resolveMode({ enabled: false }), 'off', 'disabled config is off');
  eq(cluster.resolveMode({ enabled: true }), 'primary', 'enabled config defaults to primary');
  eq(cluster.resolveMode({ enabled: true, role: 'replica' }), 'replica', 'enabled + role replica is a replica');
  eq(cluster.resolveMode({ enabled: true, role: 'primary' }), 'primary', 'enabled + role primary is primary');
  eq(cluster.resolveMode({ argv: ['--cluster'] }), 'primary', '--cluster turns it on (primary by default)');
  eq(cluster.resolveMode({ argv: ['--replica'] }), 'replica', '--replica turns it on as a replica');
  eq(cluster.resolveMode({ argv: ['--primary'] }), 'primary', '--primary turns it on as primary');
  eq(cluster.resolveMode({ enabled: true, role: 'primary', argv: ['--replica'] }), 'replica', 'CLI --replica overrides config primary');
  eq(cluster.resolveMode({ enabled: true, role: 'replica', argv: ['--primary'] }), 'primary', 'CLI --primary overrides config replica');
  // Convenience predicates.
  ok(cluster.resolveMode({}) === 'off', 'single node is off');
  console.log('✓ cluster: resolveMode maps config + CLI to off/primary/replica (CLI wins), no election');

  // ── isPrimary/isReplica/enabled via live argv (cluster.mode reads process.argv) ──
  const savedArgv = process.argv.slice();
  process.argv = ['node', 'lokyni.js', '--replica'];
  ok(cluster.enabled() && cluster.isReplica() && !cluster.isPrimary(), 'with --replica: enabled, isReplica, not isPrimary');
  // requirePrimary refuses a write on a replica (409), without calling next().
  let res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
  let nexted = false;
  authmw.requirePrimary({}, res, () => { nexted = true; });
  ok(!nexted && res.code === 409, 'requirePrimary returns 409 on a replica and does not call next()');
  // On the primary / single node it passes through.
  process.argv = ['node', 'lokyni.js', '--primary'];
  nexted = false; res = { code: 0, status(c) { this.code = c; return this; }, json() { return this; } };
  authmw.requirePrimary({}, res, () => { nexted = true; });
  ok(nexted && res.code === 0, 'requirePrimary passes through on the primary');
  process.argv = savedArgv;
  console.log('✓ cluster: requirePrimary refuses writes on a replica and passes on the primary');

  // ── Wiring drift-guard: a replica must never build/watch, and writes must be primary-gated ──
  const boot = fs.readFileSync(path.join(PROJECT, 'lokyni.js'), 'utf-8');
  ok(/if \(cluster\.isReplica\(\)\) \{[\s\S]*initIndexReadOnly\(\)/.test(boot), 'a replica loads the index read-only (never the write-path build)');
  ok(/if \(!cluster\.isReplica\(\)\) startWatcher\(\)/.test(boot), 'a replica does not start the indexing file watcher');
  ok(/!require\('\.\/lib\/cluster'\)\.isReplica\(\)/.test(boot), 'a replica skips the exclusive single-instance lock (coexists with the primary)');

  const server = fs.readFileSync(path.join(PROJECT, 'lib', 'server.js'), 'utf-8');
  for (const r of ['/api/reindex', '/api/workspaces', '/api/config', '/api/backup/restore']) {
    ok(new RegExp(`'${r.replace(/\//g, '\\/')}', authmw\\.requireGlobalAdmin, authmw\\.requirePrimary`).test(server), `${r} write is primary-gated`);
  }
  const docs = fs.readFileSync(path.join(PROJECT, 'lib', 'routes', 'documents.js'), 'utf-8');
  ok(/router\.post\('\/', authmw\.requirePrimary, docWrite,/.test(docs) && /router\.delete\('\/', authmw\.requirePrimary, docWrite,/.test(docs),
    'document add/delete are primary-gated (a replica cannot write the shared corpus)');
  console.log('✓ cluster: wiring guards hold — replica never builds/watches, writes are primary-only');

  console.log(`\nALL CLUSTER UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ CLUSTER UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
