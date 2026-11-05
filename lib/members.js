'use strict';
// Workspace membership store — who may use which workspace, and at what role.
//
// This is the sharing primitive: a flat list of { workspaceId, userId, role } rows in one JSON file in the
// data dir, written atomically and owner-only (0600), with an mtime-keyed cache like the other auth stores.
// Roles are the ranked per-workspace roles from lib/authz.js (owner > admin > editor > viewer).
//
// Cascade helpers (removeWorkspace / removeUser) exist so deleting a workspace or a user can never leave an
// orphaned membership row pointing at something gone — the whole-class guarantee the project relies on.
// Fail-closed: a missing or corrupt file reads as "no memberships" and never throws into a request.

const path = require('path');
const { isWorkspaceRole } = require('./authz');

const membersPath = (dataDir) => path.join(dataDir, 'workspace-members.json');

// Backed by the shared JSON-list store (mtime cache, atomic owner-only writes, fail-closed on missing/corrupt
// — a corrupt file is parsed once per change, not per request). rolesForUser runs on the authenticated hot path.
const _store = require('./jsonstore').createJsonStore({
  file: membersPath,
  key: 'members',
  sanitize: (rows) => (Array.isArray(rows)
    ? rows.filter(m => m && typeof m.workspaceId === 'string' && typeof m.userId === 'string' && isWorkspaceRole(m.role))
    : []),
});
const load = (dataDir) => _store.load(dataDir);
const save = (dataDir, members) => _store.save(dataDir, members);

// All of a user's { workspaceId: role } as a Map (the shape lib/principal.js attaches to a principal).
const rolesForUser = (dataDir, userId) => {
  const m = new Map();
  for (const row of load(dataDir)) if (row.userId === userId) m.set(row.workspaceId, row.role);
  return m;
};

const roleFor = (dataDir, userId, workspaceId) => {
  const row = load(dataDir).find(r => r.userId === userId && r.workspaceId === workspaceId);
  return row ? row.role : null;
};

const membersOf = (dataDir, workspaceId) =>
  load(dataDir).filter(r => r.workspaceId === workspaceId).map(r => ({ userId: r.userId, role: r.role }));

const workspacesForUser = (dataDir, userId) =>
  load(dataDir).filter(r => r.userId === userId).map(r => r.workspaceId);

const list = (dataDir) => load(dataDir).map(r => ({ ...r }));

// Upsert a membership (grant or change a role). Returns the row.
const set = (dataDir, workspaceId, userId, role) => {
  if (typeof workspaceId !== 'string' || !workspaceId) throw Object.assign(new Error('Invalid workspace'), { code: 'invalid_workspace' });
  if (typeof userId !== 'string' || !userId) throw Object.assign(new Error('Invalid user'), { code: 'invalid_user' });
  if (!isWorkspaceRole(role)) throw Object.assign(new Error('Invalid role'), { code: 'invalid_role' });
  const members = load(dataDir).slice();
  const existing = members.find(r => r.workspaceId === workspaceId && r.userId === userId);
  if (existing) existing.role = role;
  else members.push({ workspaceId, userId, role });
  save(dataDir, members);
  return { workspaceId, userId, role };
};

// Remove one membership. Returns true if a row was removed.
const remove = (dataDir, workspaceId, userId) => {
  const members = load(dataDir);
  const next = members.filter(r => !(r.workspaceId === workspaceId && r.userId === userId));
  if (next.length === members.length) return false;
  save(dataDir, next);
  return true;
};

// Cascade: drop every membership for a deleted workspace. Returns how many were removed.
const removeWorkspace = (dataDir, workspaceId) => {
  const members = load(dataDir);
  const next = members.filter(r => r.workspaceId !== workspaceId);
  const removed = members.length - next.length;
  if (removed) save(dataDir, next);
  return removed;
};

// Cascade: drop every membership for a deleted user. Returns how many were removed.
const removeUser = (dataDir, userId) => {
  const members = load(dataDir);
  const next = members.filter(r => r.userId !== userId);
  const removed = members.length - next.length;
  if (removed) save(dataDir, next);
  return removed;
};

module.exports = {
  rolesForUser, roleFor, membersOf, workspacesForUser, list,
  set, remove, removeWorkspace, removeUser,
};
