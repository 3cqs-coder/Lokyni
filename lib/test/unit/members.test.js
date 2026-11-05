'use strict';
// Guards the workspace-membership store (lib/members.js) — the sharing primitive. It must grant/change/remove
// a user's role in a workspace, report a user's roles as a Map (what a principal carries), validate the role,
// and — critically — CASCADE on workspace or user deletion so no orphaned membership is ever left behind.
// Functional, in a temp dir. Run: `npm run test:unit`.

const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const members = require(path.join(PROJECT, 'lib', 'members'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-members-'));
const cleanup = (code) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(code); };

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const no = (c, m) => { checks++; assert.ok(!c, m); };
const throws = (fn, code, m) => { checks++; try { fn(); assert.fail(m); } catch (e) { assert.ok(!code || e.code === code, `${m} (code ${e.code})`); } };

try {
  // Fresh dir: no memberships, no throw.
  ok(members.list(tmp).length === 0, 'a fresh dir has no memberships');
  ok(members.rolesForUser(tmp, 'u1').size === 0, 'rolesForUser is an empty Map for an unknown user');
  ok(members.roleFor(tmp, 'u1', 'w1') === null, 'roleFor is null when there is no membership');

  // Grant roles.
  members.set(tmp, 'w1', 'u1', 'owner');
  members.set(tmp, 'w1', 'u2', 'viewer');
  members.set(tmp, 'w2', 'u1', 'editor');
  ok(members.roleFor(tmp, 'u1', 'w1') === 'owner', 'u1 is owner of w1');
  ok(members.roleFor(tmp, 'u2', 'w1') === 'viewer', 'u2 is viewer of w1');

  // rolesForUser returns a Map keyed by workspace (the principal shape).
  const u1roles = members.rolesForUser(tmp, 'u1');
  ok(u1roles instanceof Map && u1roles.get('w1') === 'owner' && u1roles.get('w2') === 'editor', 'rolesForUser returns a per-workspace role Map');

  // membersOf and workspacesForUser.
  ok(members.membersOf(tmp, 'w1').length === 2, 'w1 has two members');
  ok(members.workspacesForUser(tmp, 'u1').sort().join(',') === 'w1,w2', 'u1 belongs to w1 and w2');

  // Upsert changes an existing role rather than duplicating.
  members.set(tmp, 'w1', 'u2', 'editor');
  ok(members.roleFor(tmp, 'u2', 'w1') === 'editor', 'upsert changes an existing membership role');
  ok(members.membersOf(tmp, 'w1').length === 2, 'upsert does not create a duplicate row');

  // Validation.
  throws(() => members.set(tmp, 'w1', 'u3', 'superowner'), 'invalid_role', 'an invalid role is rejected');
  throws(() => members.set(tmp, '', 'u3', 'viewer'), 'invalid_workspace', 'a blank workspace is rejected');
  throws(() => members.set(tmp, 'w1', '', 'viewer'), 'invalid_user', 'a blank user is rejected');

  // Remove one membership.
  ok(members.remove(tmp, 'w1', 'u2'), 'remove deletes a membership');
  ok(members.roleFor(tmp, 'u2', 'w1') === null, 'the removed membership is gone');
  no(members.remove(tmp, 'w1', 'u2'), 'removing an absent membership returns false');

  // Cascade on workspace delete — no orphaned rows for a deleted workspace.
  members.set(tmp, 'w1', 'u2', 'viewer');   // re-add so w1 has u1 + u2
  const removedWs = members.removeWorkspace(tmp, 'w1');
  ok(removedWs === 2, 'removeWorkspace drops every membership of the workspace');
  ok(members.membersOf(tmp, 'w1').length === 0, 'no membership references the deleted workspace');
  ok(members.roleFor(tmp, 'u1', 'w2') === 'editor', 'memberships of OTHER workspaces are untouched');

  // Cascade on user delete — no orphaned rows for a deleted user.
  members.set(tmp, 'w2', 'u2', 'viewer');
  const removedUser = members.removeUser(tmp, 'u1');
  ok(removedUser === 1, 'removeUser drops every membership of the user');
  ok(members.workspacesForUser(tmp, 'u1').length === 0, 'no membership references the deleted user');
  ok(members.roleFor(tmp, 'u2', 'w2') === 'viewer', 'other users\' memberships are untouched');

  console.log('✓ members: grant/change/remove roles, Map per user, and cascade cleanly on workspace/user delete');
  console.log(`\nALL MEMBERS UNIT TESTS PASSED (${checks} checks)`);
  cleanup(0);
} catch (e) {
  console.error('\n✗ MEMBERS UNIT TEST FAILED:', e && e.message);
  cleanup(1);
}
