'use strict';
// Security test for per-key workspace authorization — workspaces.resolveAccess + apikeys.mayUseWorkspace.
// This single gate authorizes BOTH the HTTP API and the MCP endpoint, and its isValidId check is the
// path-traversal guard for workspaceDir(dataDir, id). A regression that broke the 403 branch would let a
// workspace-scoped key read every workspace (cross-tenant exposure); a broken id check could resolve a
// path outside the workspaces root. Hermetic: a temp data dir with a small registry, no model/network.
// Run: `npm run test:unit`.

const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const wsm = require(path.join(PROJECT, 'lib', 'workspaces'));
const { mayUseWorkspace } = require(path.join(PROJECT, 'lib', 'apikeys'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-wsaccess-'));
const cleanup = (code) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(code); };

try {
  wsm.saveRegistry(tmp, [
    { id: 'default',  name: 'Default',  created: Date.now() },
    { id: 'research', name: 'Research', created: Date.now() },
    { id: 'private',  name: 'Private',  created: Date.now() },
  ]);

  // ── No API key (control plane): any existing workspace resolves; a missing one is 404 ──
  eq(wsm.resolveAccess(tmp, 'research', null).ok, true, 'control-plane access resolves an existing workspace');
  eq(wsm.resolveAccess(tmp, 'nope', null).status, 404, 'a non-existent workspace is 404');

  // ── A workspace-scoped key: allowed one → ok; a forbidden one → 404, INDISTINGUISHABLE from a nonexistent one
  //    (so the key can't enumerate workspace ids outside its allow-list by telling 403-exists from 404-missing) ──
  {
    const key = { id: 'k1', allowedWorkspaces: ['research'] };
    const okRes = wsm.resolveAccess(tmp, 'research', key);
    eq(okRes.ok, true, 'a scoped key reaches its allowed workspace');
    eq(okRes.id, 'research', 'the resolved id is returned');
    const deniedExisting = wsm.resolveAccess(tmp, 'private', key);     // exists, but not allowed
    const deniedMissing  = wsm.resolveAccess(tmp, 'ghostws', key);     // does not exist, also not allowed
    eq(deniedExisting.ok, false, 'a scoped key is refused another workspace');
    eq(deniedExisting.status, 404, 'a forbidden EXISTING workspace is 404 (existence is not leaked to the key)');
    eq(deniedMissing.status, 404, 'a forbidden NONEXISTENT workspace is also 404 — same status, no enumeration oracle');
    ok(mayUseWorkspace(key, 'research') && !mayUseWorkspace(key, 'private'), 'mayUseWorkspace agrees with the gate');
    console.log('✓ workspace-access: a scoped key cannot reach — or enumerate — a workspace outside its list');
  }

  // ── Empty allowedWorkspaces means all ──
  {
    const key = { id: 'k2', allowedWorkspaces: [] };
    ok(wsm.resolveAccess(tmp, 'private', key).ok, 'an empty allow-list grants every workspace');
    ok(mayUseWorkspace(key, 'anything'), 'mayUseWorkspace treats an empty list as all-allowed');
    console.log('✓ workspace-access: an empty allow-list means all workspaces');
  }

  // ── Malformed ids are rejected as 400 and never resolve to a path outside the root ──
  {
    // Note: an empty string is NOT malformed — it means "use the default workspace" (tested below).
    for (const bad of ['../etc', '..', 'a/../b', 'UPPER', 'has space', '-leadinghyphen', 'x'.repeat(48) + 'y', '.']) {
      const r = wsm.resolveAccess(tmp, bad, null);
      ok(r.ok === false && (r.status === 400 || r.status === 404), `malformed id ${JSON.stringify(bad)} is refused (status ${r.status})`);
      ok(!wsm.isValidId(bad), `isValidId rejects ${JSON.stringify(bad)}`);
    }
    // A traversal id, even if it somehow passed, must not map to a path outside the workspaces root.
    ok(!wsm.isValidId('../../evil'), 'a traversal id fails the validity/path-containment guard');
    console.log('✓ workspace-access: malformed / traversal ids are rejected (path-containment guard holds)');
  }

  // ── A present-but-non-string workspace (e.g. a repeated query param → array) is a 400, not a silent default ──
  eq(wsm.resolveAccess(tmp, ['research', 'private'], null).status, 400, 'an array workspace param is rejected (400)');
  eq(wsm.resolveAccess(tmp, { id: 'x' }, null).status, 400, 'an object workspace param is rejected (400)');

  // ── An empty/absent request falls back to the default workspace ──
  {
    eq(wsm.resolveAccess(tmp, '', null).id, 'default', 'an empty request resolves to the default workspace');
    eq(wsm.resolveAccess(tmp, undefined, null).id, 'default', 'an absent request resolves to the default workspace');
    console.log('✓ workspace-access: an empty request defaults to the default workspace');
  }

  // ── A valid id boundary: exactly 48 chars is allowed, 49 is not ──
  ok(wsm.isValidId('a' + 'b'.repeat(47)), 'a 48-char id is valid');
  ok(!wsm.isValidId('a' + 'b'.repeat(48)), 'a 49-char id is invalid');

  // ── Route gating (source guard): every document-CONTENT route must require doc.read on the workspace it
  //    serves, not merely a login — otherwise a signed-in non-member could read another workspace's content.
  //    The figure-crop route was the one content route missing this; pin it so it can't regress. ──
  {
    const serverSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'server.js'), 'utf-8');
    ok(/app\.get\('\/api\/figure\/:id',\s*authmw\.requireCapability\('doc\.read',\s*\{\s*workspace:\s*figureWsId\s*\}\)/.test(serverSrc),
      'the figure-crop route requires doc.read on the resolved workspace (no unauthenticated-member crop reads)');
    ok(/readCrop\(wsm\.cacheDirFor\(cfg\.DATA_DIR,\s*figureWsId\(req\)\)/.test(serverSrc),
      'the figure route reads from the RESOLVED workspace cache, so a non-active-workspace window can load its figures');
  }

  console.log(`\nALL WORKSPACE-ACCESS UNIT TESTS PASSED (${checks} checks)`);
  cleanup(0);
} catch (e) {
  console.error('\n✗ WORKSPACE-ACCESS UNIT TEST FAILED:', e && e.message, e && e.stack);
  cleanup(1);
}
