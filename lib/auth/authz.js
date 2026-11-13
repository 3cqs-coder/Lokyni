'use strict';
// Authorization policy — the single source of truth for "who may do what".
//
// Pure and dependency-free on purpose: no I/O, no store access, no config. It decides access given an
// already-resolved principal, so it is trivially unit-testable and can never be the thing that stalls a
// request or crashes the process. Everything that authenticates — a human session, an API key, or the
// implicit single operator — is normalized into ONE principal shape (see lib/principal.js) and checked here.
//
// Design rules:
//   • Capabilities are the source of truth; roles are just named bundles. Call sites always ask for a
//     capability string (can(p, 'doc.write')), never a role name, so adding roles later never re-plumbs code.
//   • Deny by default.
//   • Write implies read (holding 'doc.write' satisfies a 'doc.read' check), and a resource wildcard
//     ('doc.*') or the super-wildcard ('*') satisfies any capability under it.
//   • A global admin (and the implicit owner) bypasses everything. Nobody else gets management capabilities.

// ── Capability vocabulary ────────────────────────────────────────────────────
// Append-only. The `label` drives the permission UI, so there is no second enum to keep in sync.
const CAPABILITIES = [
  { key: 'query.run',        label: 'Ask questions' },
  { key: 'doc.read',         label: 'Read documents and sources' },
  { key: 'doc.write',        label: 'Add or remove documents' },
  { key: 'workspace.read',   label: 'See a workspace' },
  { key: 'workspace.manage', label: 'Manage workspace settings' },
  { key: 'workspace.delete', label: 'Delete a workspace' },
  { key: 'members.manage',   label: 'Manage who can access a workspace' },
  { key: 'settings.write',   label: 'Change server settings' },
  { key: 'apikey.manage',    label: 'Manage API keys' },
  { key: 'user.manage',      label: 'Manage user accounts' },
  { key: 'audit.read',       label: 'Read the audit log' },
];

// Capabilities that apply WITHIN a workspace (need a workspaceId to evaluate). Everything else is a global
// capability that only a global admin holds.
const WORKSPACE_CAPABILITIES = new Set([
  'query.run', 'doc.read', 'doc.write', 'workspace.read', 'workspace.manage', 'workspace.delete', 'members.manage',
]);
const isWorkspaceCapability = (cap) => WORKSPACE_CAPABILITIES.has(cap);

// ── Ranked per-workspace roles ───────────────────────────────────────────────
const WORKSPACE_ROLE_RANK = { owner: 4, admin: 3, editor: 2, viewer: 1 };
const WORKSPACE_ROLES = Object.keys(WORKSPACE_ROLE_RANK);
const isWorkspaceRole = (r) => Object.prototype.hasOwnProperty.call(WORKSPACE_ROLE_RANK, r);

// Each role's capability bundle, lowest to highest. Written as plain grants; write-implies-read and wildcards
// are applied by grantSatisfies below, so 'doc.write' here also covers 'doc.read'.
const WORKSPACE_ROLE_CAPS = {
  viewer: ['query.run', 'doc.read', 'workspace.read'],
  editor: ['query.run', 'doc.read', 'doc.write', 'workspace.read'],
  admin:  ['query.run', 'doc.read', 'doc.write', 'workspace.read', 'workspace.manage', 'members.manage'],
  owner:  ['*'],   // everything within the workspace, including delete
};

// ── API-key scope → capability mapping ───────────────────────────────────────
// A key authenticates to a capability set derived from its scopes, always bounded to its allowedWorkspaces.
// Keys are machine credentials: they never hold management or global capabilities, only data access.
const SCOPE_CAPS = {
  search:    ['query.run'],
  summarize: ['query.run', 'doc.read'],
  read:      ['doc.read', 'workspace.read'],
  write:     ['doc.write'],
};
// Human-facing scope metadata for the API-key UI, kept HERE next to SCOPE_CAPS so the picker is single-sourced
// from the authoritative scope list and can never drift from it. `order` is the display order; `on` is whether
// the box is checked by default (write is off — it grants document changes). Any scope added to SCOPE_CAPS but
// missing here still renders (with its name and no description), so a new scope is never silently unselectable.
const SCOPE_INFO = {
  search:    { label: 'search',    desc: 'run searches', order: 1, on: true },
  summarize: { label: 'summarize', desc: 'summarize documents', order: 2, on: true },
  read:      { label: 'read',      desc: 'read documents', order: 3, on: true },
  write:     { label: 'write',     desc: 'add documents', order: 4, on: false },
};
// The ordered scope list the UI renders — derived from SCOPE_CAPS (the source of truth) so a scope can never be
// offered that the server would not honor, nor omitted if one is added. Falls back to sane defaults for a scope
// present in SCOPE_CAPS but absent from SCOPE_INFO.
const apiKeyScopeList = () => Object.keys(SCOPE_CAPS)
  .map((s) => ({ scope: s, label: (SCOPE_INFO[s] && SCOPE_INFO[s].label) || s, desc: (SCOPE_INFO[s] && SCOPE_INFO[s].desc) || '', on: SCOPE_INFO[s] ? SCOPE_INFO[s].on === true : true, order: (SCOPE_INFO[s] && SCOPE_INFO[s].order) || 99 }))
  .sort((a, b) => a.order - b.order);

// ── Grant matching ───────────────────────────────────────────────────────────
// Does a single granted token satisfy the requested capability? Honors '*', 'resource.*', an exact match,
// and write-implies-read (same resource).
const grantSatisfies = (granted, capability) => {
  if (granted === '*') return true;
  if (granted === capability) return true;
  const dot = granted.indexOf('.');
  if (dot > 0 && granted.slice(dot) === '.*') {
    const resource = granted.slice(0, dot);
    return capability.startsWith(resource + '.');
  }
  // write implies read on the same resource (doc.write ⇒ doc.read)
  if (granted.endsWith('.write')) {
    const resource = granted.slice(0, -('.write'.length));
    if (capability === resource + '.read') return true;
  }
  return false;
};

const grantsSatisfy = (grants, capability) =>
  Array.isArray(grants) && grants.some(g => grantSatisfies(g, capability));

// Resolve a workspace role to its capability grants (for a specific capability check).
const workspaceRoleGrants = (role, capability) =>
  isWorkspaceRole(role) && grantsSatisfy(WORKSPACE_ROLE_CAPS[role], capability);

// Resolve a key's scopes to capability grants (for a specific capability check).
const scopesGrant = (scopes, capability) => {
  if (!Array.isArray(scopes)) return false;
  for (const s of scopes) if (grantsSatisfy(SCOPE_CAPS[s] || [], capability)) return true;
  return false;
};

// A key may touch a workspace when it has no allow-list (empty = all) or the workspace is listed.
const keyMayUseWorkspace = (allowedWorkspaces, workspaceId) =>
  !Array.isArray(allowedWorkspaces) || allowedWorkspaces.length === 0 || allowedWorkspaces.includes(workspaceId);

// ── The gate ─────────────────────────────────────────────────────────────────
// can(principal, capability, { workspaceId }) — the one function every guard calls.
//   principal: { kind: 'owner'|'user'|'apikey'|'anonymous', globalRole?, workspaceRoles?: Map, scopes?, allowedWorkspaces? }
//   workspaceId: required for a workspace capability; ignored for a global one.
// Never throws: a malformed principal or capability is simply a denial.
const can = (principal, capability, opts = {}) => {
  try {
    if (!principal || typeof capability !== 'string') return false;
    const workspaceId = opts.workspaceId ?? null;

    // The implicit single operator and a global admin can do everything.
    if (principal.kind === 'owner') return true;
    if (principal.kind === 'user' && principal.globalRole === 'admin') return true;

    // API keys: data access only, bounded to their workspaces; never management/global capabilities.
    if (principal.kind === 'apikey') {
      if (!isWorkspaceCapability(capability)) return false;
      if (!keyMayUseWorkspace(principal.allowedWorkspaces, workspaceId)) return false;
      return scopesGrant(principal.scopes, capability);
    }

    // Human members: workspace capabilities come from their role in that workspace.
    if (principal.kind === 'user') {
      if (!isWorkspaceCapability(capability)) return false;   // global caps are admin-only (handled above)
      if (!workspaceId) return false;
      const roles = principal.workspaceRoles;
      const role = roles && typeof roles.get === 'function' ? roles.get(workspaceId) : (roles && roles[workspaceId]);
      if (!role) return false;
      return workspaceRoleGrants(role, capability);
    }

    return false;   // anonymous or unknown kind
  } catch { return false; }   // deny, never throw
};

// Rank comparison for a workspace role, e.g. hasWorkspaceRole(p, ws, 'editor'). A global admin/owner always
// satisfies it. Never throws.
const hasWorkspaceRole = (principal, workspaceId, minRole) => {
  try {
    if (!principal || !isWorkspaceRole(minRole) || !workspaceId) return false;
    if (principal.kind === 'owner') return true;
    if (principal.kind === 'user' && principal.globalRole === 'admin') return true;
    if (principal.kind !== 'user') return false;
    const roles = principal.workspaceRoles;
    const role = roles && typeof roles.get === 'function' ? roles.get(workspaceId) : (roles && roles[workspaceId]);
    if (!isWorkspaceRole(role)) return false;
    return WORKSPACE_ROLE_RANK[role] >= WORKSPACE_ROLE_RANK[minRole];
  } catch { return false; }
};

module.exports = {
  CAPABILITIES, isWorkspaceCapability,
  WORKSPACE_ROLE_RANK, WORKSPACE_ROLES, isWorkspaceRole, WORKSPACE_ROLE_CAPS,
  SCOPE_CAPS, SCOPE_INFO, apiKeyScopeList, grantSatisfies, can, hasWorkspaceRole,
};
