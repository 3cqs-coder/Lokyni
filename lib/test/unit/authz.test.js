'use strict';
// Guards the authorization policy (lib/authz.js) — the single gate every access check goes through. The whole
// multi-user model rests on this being correct: deny-by-default, write-implies-read, wildcards, ranked
// per-workspace roles, API keys limited to data access within their allowed workspaces, and a global admin /
// implicit owner bypass. It is a pure function, so this is fully functional (no I/O, no model). A regression
// here is a privilege-escalation or a lockout, so every branch is exercised. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const authz = require(path.join(PROJECT, 'lib', 'authz'));
const { can, hasWorkspaceRole, grantSatisfies } = authz;

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const no = (c, m) => { checks++; assert.ok(!c, m); };

// Principal builders mirroring what lib/principal.js will produce.
const owner = () => ({ kind: 'owner' });
const admin = () => ({ kind: 'user', globalRole: 'admin', workspaceRoles: new Map() });
const member = (roles = {}) => ({ kind: 'user', globalRole: 'member', workspaceRoles: new Map(Object.entries(roles)) });
const key = (scopes, allowedWorkspaces = []) => ({ kind: 'apikey', scopes, allowedWorkspaces });
const anon = () => ({ kind: 'anonymous' });

try {
  // ── grantSatisfies primitive: exact, super-wildcard, resource-wildcard, write-implies-read ──
  ok(grantSatisfies('*', 'anything.here'), 'super-wildcard satisfies any capability');
  ok(grantSatisfies('doc.*', 'doc.write'), 'resource wildcard satisfies a capability under it');
  no(grantSatisfies('doc.*', 'user.manage'), 'a resource wildcard does not cross resources');
  ok(grantSatisfies('doc.write', 'doc.read'), 'write implies read on the same resource');
  no(grantSatisfies('doc.read', 'doc.write'), 'read does NOT imply write');
  no(grantSatisfies('doc.write', 'workspace.read'), 'write-implies-read does not cross resources');
  console.log('✓ authz: grantSatisfies handles wildcards and write-implies-read without crossing resources');

  // ── Implicit owner and global admin bypass everything ──
  ok(can(owner(), 'settings.write'), 'implicit owner can do global actions');
  ok(can(owner(), 'doc.write', { workspaceId: 'w1' }), 'implicit owner can do workspace actions anywhere');
  ok(can(admin(), 'user.manage'), 'global admin can manage users');
  ok(can(admin(), 'workspace.delete', { workspaceId: 'w1' }), 'global admin can act on any workspace');
  ok(hasWorkspaceRole(admin(), 'w1', 'owner'), 'global admin satisfies any workspace role rank');
  ok(hasWorkspaceRole(owner(), 'w1', 'owner'), 'implicit owner satisfies any workspace role rank');
  console.log('✓ authz: implicit owner and global admin bypass all checks');

  // ── Member with no memberships: denied everything, no crash ──
  no(can(member(), 'query.run', { workspaceId: 'w1' }), 'a member with no role in a workspace cannot query it');
  no(can(member(), 'settings.write'), 'a member cannot change global settings');
  no(can(member(), 'doc.read'), 'a workspace capability with no workspaceId is denied');
  console.log('✓ authz: a member with no memberships is denied by default (global and workspace)');

  // ── Ranked workspace roles grant the right capabilities, scoped to the right workspace ──
  const viewer = member({ w1: 'viewer' });
  ok(can(viewer, 'query.run', { workspaceId: 'w1' }), 'viewer can query its workspace');
  ok(can(viewer, 'doc.read', { workspaceId: 'w1' }), 'viewer can read sources');
  no(can(viewer, 'doc.write', { workspaceId: 'w1' }), 'viewer cannot write documents');
  no(can(viewer, 'query.run', { workspaceId: 'w2' }), 'viewer has no access to a different workspace');

  const editor = member({ w1: 'editor' });
  ok(can(editor, 'doc.write', { workspaceId: 'w1' }), 'editor can add/remove documents');
  ok(can(editor, 'doc.read', { workspaceId: 'w1' }), 'editor can read (write implies read)');
  no(can(editor, 'members.manage', { workspaceId: 'w1' }), 'editor cannot manage members');
  no(can(editor, 'workspace.delete', { workspaceId: 'w1' }), 'editor cannot delete the workspace');

  const wsAdmin = member({ w1: 'admin' });
  ok(can(wsAdmin, 'members.manage', { workspaceId: 'w1' }), 'workspace admin can manage members');
  ok(can(wsAdmin, 'workspace.manage', { workspaceId: 'w1' }), 'workspace admin can manage settings');
  no(can(wsAdmin, 'workspace.delete', { workspaceId: 'w1' }), 'workspace admin cannot delete the workspace (owner only)');
  no(can(wsAdmin, 'settings.write'), 'a workspace admin is NOT a global admin (no server settings)');

  const wsOwner = member({ w1: 'owner' });
  ok(can(wsOwner, 'workspace.delete', { workspaceId: 'w1' }), 'workspace owner can delete the workspace');
  no(can(wsOwner, 'user.manage'), 'a workspace owner still cannot manage global users');
  no(can(wsOwner, 'doc.write', { workspaceId: 'w2' }), 'a workspace owner has no power in another workspace');

  // Multiple memberships at different levels resolve independently.
  const mixed = member({ w1: 'viewer', w2: 'editor' });
  no(can(mixed, 'doc.write', { workspaceId: 'w1' }), 'mixed membership: viewer rights in w1');
  ok(can(mixed, 'doc.write', { workspaceId: 'w2' }), 'mixed membership: editor rights in w2');
  console.log('✓ authz: ranked workspace roles grant the correct capabilities, isolated per workspace');

  // ── hasWorkspaceRole rank comparison ──
  ok(hasWorkspaceRole(editor, 'w1', 'viewer'), 'editor satisfies a viewer-minimum gate');
  ok(hasWorkspaceRole(editor, 'w1', 'editor'), 'editor satisfies an editor-minimum gate');
  no(hasWorkspaceRole(editor, 'w1', 'admin'), 'editor does not satisfy an admin-minimum gate');
  no(hasWorkspaceRole(viewer, 'w2', 'viewer'), 'no membership in a workspace fails the rank check');
  console.log('✓ authz: hasWorkspaceRole compares ranks correctly');

  // ── API keys: data access only, bounded to allowed workspaces, never management/global ──
  const searchKey = key(['search']);
  ok(can(searchKey, 'query.run', { workspaceId: 'w1' }), 'a search-scoped key can query any workspace (no allow-list)');
  no(can(searchKey, 'doc.read', { workspaceId: 'w1' }), 'a search-only key cannot read raw sources');
  const writeKey = key(['write']);
  ok(can(writeKey, 'doc.write', { workspaceId: 'w1' }), 'a write-scoped key can ingest');
  ok(can(writeKey, 'doc.read', { workspaceId: 'w1' }), 'a write scope implies read');
  const scopedKey = key(['search', 'read'], ['w1']);
  ok(can(scopedKey, 'doc.read', { workspaceId: 'w1' }), 'a workspace-scoped key works in its allowed workspace');
  no(can(scopedKey, 'doc.read', { workspaceId: 'w2' }), 'a workspace-scoped key is refused outside its allow-list');
  no(can(key(['write']), 'members.manage', { workspaceId: 'w1' }), 'a key can never manage members');
  no(can(key(['write']), 'settings.write'), 'a key can never touch global settings');
  no(can(key(['write']), 'user.manage'), 'a key can never manage users');
  no(can(key(['write']), 'workspace.delete', { workspaceId: 'w1' }), 'a key can never delete a workspace');
  console.log('✓ authz: API keys get scope-derived data access only, bounded to their workspaces, never management');

  // ── Anonymous and malformed inputs are denied, never throw ──
  no(can(anon(), 'query.run', { workspaceId: 'w1' }), 'anonymous is denied');
  no(can(null, 'query.run'), 'a null principal is denied, not a crash');
  no(can(member(), null), 'a null capability is denied, not a crash');
  no(can({ kind: 'bogus' }, 'query.run', { workspaceId: 'w1' }), 'an unknown principal kind is denied');
  no(hasWorkspaceRole(member(), 'w1', 'not-a-role'), 'an invalid minimum role is denied, not a crash');
  console.log('✓ authz: anonymous/malformed inputs are denied without throwing');

  console.log(`\nALL AUTHZ UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ AUTHZ UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
