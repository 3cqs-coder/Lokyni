'use strict';
// Auth + account-management routes (control plane).
//
// Public (pre-login): GET /auth/me (what the login UI needs), POST /auth/login, POST /auth/signup
//   (only when it is the very first account, or an operator enabled allowSignups).
// Authenticated (any user): GET /auth/csrf, POST /auth/logout, POST /auth/password, GET /auth/sessions,
//   DELETE /auth/sessions (sign out everywhere else).
// Admin only: GET/POST /auth/users, PATCH/DELETE /auth/users/:id, and workspace membership management.
//
// Everything that authenticates goes through the shared principal model; the router never parses credentials
// itself beyond the login body. State-changing cookie-authenticated routes require a CSRF token. Login is
// throttled per IP. Actions are written to the audit trail with the acting user attributed.

const express = require('express');
const accounts = require('../accounts');
const users = require('../users');
const members = require('../members');
const authsessions = require('../authsessions');
const authmw = require('../authmiddleware');
const authz = require('../authz');
const audit = require('../audit');

const dataDir = () => require('../config').DATA_DIR;
const allowSignups = () => require('../config').allowSignups === true;

// ── Login throttle (in-memory; resets on restart, by design) ──────────────────
// Two independent keys, so neither axis of a brute-force gets a free pass:
//   • per connection PEER (audit.peerIp) — the real TCP source, which a caller CANNOT rotate via
//     X-Forwarded-For (keying on that header would let a direct client spoof a fresh IP per attempt and never
//     trip the lockout). Behind a legitimate reverse proxy all requests share the proxy's peer, so this axis
//     is coarse there — which is exactly why the second axis exists.
//   • per USERNAME — bounds guessing against one account regardless of source IP (defeats an XFF-rotated or
//     distributed flood that the per-peer axis can't see). Slightly higher limit so one person fat-fingering
//     their own password from several devices isn't locked out as fast as a single abusive peer.
const ATTEMPT_LIMIT = 8, USER_ATTEMPT_LIMIT = 10, WINDOW_MS = 15 * 60 * 1000, LOCK_MS = 15 * 60 * 1000;
// Hard bound on the tracking map so a flood of distinct keys (many peers, or attacker-chosen usernames) can never
// grow it without limit (OOM-proof). When over the ceiling, trim back to the target.
const MAX_TRACKED = 10000, TARGET_TRACKED = 5000;
const _attempts = new Map();   // key → { count, first, lockedUntil }
const peerKey = (req) => 'peer:' + (require('../audit').peerIp(req) || 'unknown');
const userKey = (username) => 'user:' + String(username || '').trim().toLowerCase().slice(0, 64);
const throttleCheck = (key) => {
  const now = Date.now();
  const a = _attempts.get(key);
  if (a && a.lockedUntil && a.lockedUntil > now) return Math.ceil((a.lockedUntil - now) / 1000);
  return 0;
};
const throttleFail = (key, limit = ATTEMPT_LIMIT) => {
  const now = Date.now();
  let a = _attempts.get(key);
  if (!a || now - a.first > WINDOW_MS) a = { count: 0, first: now, lockedUntil: 0 };
  a.count += 1;
  if (a.count >= limit) a.lockedUntil = now + LOCK_MS;
  _attempts.set(key, a);
  // Keep the map hard-bounded in two passes. First drop entries no longer locked (cheapest — preserves active
  // lockouts). Then, only if a flood of still-locked entries is STILL over the ceiling, evict the oldest ones
  // (a Map iterates in insertion order) until back to target — so memory is bounded even under an adversarial
  // burst where every entry is locked. Forgetting the oldest lockouts under that extreme is the right trade:
  // reaching the ceiling takes a large distributed flood, and bounded memory matters more than perfect retention.
  if (_attempts.size > MAX_TRACKED) {
    for (const [k, v] of _attempts) { if (_attempts.size <= TARGET_TRACKED) break; if (!v.lockedUntil || v.lockedUntil < now) _attempts.delete(k); }
    if (_attempts.size > MAX_TRACKED) { for (const k of _attempts.keys()) { if (_attempts.size <= TARGET_TRACKED) break; _attempts.delete(k); } }
  }
};
const throttleClear = (key) => _attempts.delete(key);

const router = express.Router();
const csrf = authmw.requireCsrf();   // secret dir resolved by authsecret (shared data dir in cluster mode)

// ── Public ────────────────────────────────────────────────────────────────────
// What the UI needs to decide whether to show a login screen and who is signed in.
router.get('/me', (req, res) => {
  const p = req.principal || { kind: 'anonymous' };
  const hasAccounts = !users.isEmpty(dataDir());
  let user = null;
  if (p.kind === 'user') user = users.publicView(users.getById(dataDir(), p.userId));
  const cfg = require('../config');
  res.json({
    authRequired: hasAccounts,
    needsFirstAccount: !hasAccounts,
    allowSignups: allowSignups(),
    ssoEnabled: cfg.ssoEnabled(),
    ssoButtonLabel: cfg.ssoEnabled() ? cfg.oidc.buttonLabel : null,
    authenticated: p.kind === 'user' || p.kind === 'owner',
    isAdmin: p.kind === 'owner' || (p.kind === 'user' && p.globalRole === 'admin'),
    user,
    csrfToken: authmw.csrfToken(req) || null,
    // Single-source the password policy so the client hints/minlength can't drift from the server's enforcement.
    minPasswordLen: accounts.MIN_PASSWORD_LEN,
    maxPasswordLen: accounts.MAX_PASSWORD_LEN,
  });
});

router.post('/login', express.json(), async (req, res) => {
  const { username, password } = req.body || {};
  const pk = peerKey(req);
  const uk = typeof username === 'string' && username.trim() ? userKey(username) : null;
  // Locked out if EITHER the peer or the target account is over its limit.
  const wait = Math.max(throttleCheck(pk), uk ? throttleCheck(uk) : 0);
  if (wait > 0) { res.setHeader('Retry-After', String(wait)); return res.status(429).json({ error: 'Too many attempts. Try again shortly.' }); }
  const result = await accounts.verifyLogin(dataDir(), username, password);
  if (!result.ok) {
    throttleFail(pk);
    if (uk) throttleFail(uk, USER_ATTEMPT_LIMIT);
    audit.auditAuthFail(req, 'auth.login_failed', String(username || '').slice(0, 64), result.disabled ? 'account disabled' : 'bad credentials');
    return res.status(401).json({ error: result.disabled ? 'This account is disabled.' : 'Invalid username or password.' });
  }
  throttleClear(pk);
  if (uk) throttleClear(uk);
  const principalMod = require('../principal');
  const sid = await authsessions.create(dataDir(), result.user.id, { ip: require('../principal').clientIp(req), ua: req.get('user-agent') });
  authmw.setSessionCookie(req, res, sid, authsessions.DEFAULT_TTL_MS);
  audit.audit({ ...req, principal: principalMod.userPrincipal(result.user, new Map(), sid) }, 'auth.login', result.user.username, '');
  res.json({ ok: true, user: result.user });
});

// Account creation is PRIMARY-ONLY. Signup writes the shared users.json, and — critically — the very first
// signup performs the "first account becomes admin" election; two concurrent first-signups on different cluster
// nodes could both believe they are first. Gating here makes the primary the single writer of that election and
// of the shared user store. No effect on a single node or the primary (requirePrimary only 409s a replica);
// self-service sign-in and password change deliberately stay available on any node.
router.post('/signup', authmw.requirePrimary, express.json(), async (req, res) => {
  const first = users.isEmpty(dataDir());
  if (!first && !allowSignups()) return res.status(403).json({ error: 'Signups are disabled. Ask an administrator to create your account.' });
  // Rate-limit open signups per connection peer so an enabled allowSignups can't be used to mass-create
  // accounts (each account creation also runs a scrypt hash). The very first account (fresh install) is exempt.
  const pk = peerKey(req);
  if (!first) {
    const wait = throttleCheck(pk);
    if (wait > 0) { res.setHeader('Retry-After', String(wait)); return res.status(429).json({ error: 'Too many attempts. Try again shortly.' }); }
    throttleFail(pk);   // count every open-signup attempt toward the per-peer limit, regardless of outcome
  }
  const { username, password, email, displayName } = req.body || {};
  try {
    const user = await accounts.createAccount(dataDir(), { username, password, email, displayName });
    const sid = await authsessions.create(dataDir(), user.id, { ip: require('../principal').clientIp(req), ua: req.get('user-agent') });
    authmw.setSessionCookie(req, res, sid, authsessions.DEFAULT_TTL_MS);
    audit.audit(req, first ? 'auth.first_admin_created' : 'auth.signup', user.username, `role=${user.role}`);
    res.json({ ok: true, user });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Could not create the account.', code: e.code });
  }
});

// ── Authenticated (any user) ──────────────────────────────────────────────────
// Self-service profile: a signed-in user sets their OWN human display name (any language/script). The username
// (the ASCII identifier) is NOT editable here. requirePrimary because it writes the shared user store.
router.patch('/me', authmw.requireAuth, authmw.requirePrimary, csrf, express.json(), (req, res) => {
  const p = req.principal;
  if (!p || p.kind !== 'user') return res.status(403).json({ error: 'Not a user account.' });
  try {
    const updated = users.update(dataDir(), p.userId, { displayName: req.body?.displayName });
    if (!updated) return res.status(404).json({ error: 'Account not found.' });
    audit.audit(req, 'account.display_name', updated.username, '');
    res.json({ ok: true, user: updated });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Could not update your profile.', code: e.code });
  }
});

router.post('/logout', authmw.requireAuth, csrf, async (req, res) => {
  const p = req.principal;
  if (p.kind === 'user' && p.sessionId) await authsessions.destroy(dataDir(), p.sessionId);
  authmw.clearSessionCookie(req, res);
  audit.audit(req, 'auth.logout', p.username || '', '');
  res.json({ ok: true });
});

router.post('/password', authmw.requireAuth, csrf, express.json(), async (req, res) => {
  const p = req.principal;
  if (p.kind !== 'user') return res.status(400).json({ error: 'No password to change for this session.' });
  const { currentPassword, newPassword } = req.body || {};
  const check = await accounts.verifyLogin(dataDir(), p.username, currentPassword);
  if (!check.ok) return res.status(401).json({ error: 'Current password is incorrect.' });
  try {
    await accounts.changePassword(dataDir(), p.userId, newPassword, { exceptRawSessionId: p.sessionId });
    audit.audit(req, 'auth.password_change', p.username, 'other sessions revoked');
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Could not change the password.', code: e.code });
  }
});

router.get('/sessions', authmw.requireAuth, async (req, res) => {
  const p = req.principal;
  if (p.kind !== 'user') return res.json({ sessions: [] });
  res.json({ sessions: await authsessions.listForUser(dataDir(), p.userId, p.sessionId) });
});

router.delete('/sessions', authmw.requireAuth, csrf, async (req, res) => {
  const p = req.principal;
  if (p.kind !== 'user') return res.json({ ok: true, revoked: 0 });
  const revoked = await authsessions.destroyForUser(dataDir(), p.userId, p.sessionId);
  audit.audit(req, 'auth.sessions_revoked', p.username, `revoked=${revoked}`);
  res.json({ ok: true, revoked });
});

// ── Admin: user management ────────────────────────────────────────────────────
const adminOnly = authmw.requireGlobalAdmin;
// Admin edits rewrite the shared user/membership stores, so they run on the single writer (the primary). A
// read replica returns 409 — consistent with every other write route, and it keeps two nodes from racing a
// rewrite of users.json / workspace-members.json. Self-service login and password change stay on any node.
const primaryOnly = authmw.requirePrimary;

router.get('/users', adminOnly, (req, res) => {
  // The authoritative role/status/workspace-role enums travel with the list so the admin UI renders its pickers
  // from them instead of hardcoding — add or rename one server-side and the dropdowns follow, never drift.
  res.json({ users: users.list(dataDir()), roles: users.ROLES, statuses: users.STATUSES, workspaceRoles: authz.WORKSPACE_ROLES });
});

router.post('/users', adminOnly, primaryOnly, csrf, express.json(), async (req, res) => {
  const { username, password, email, role, displayName } = req.body || {};
  try {
    const user = await accounts.createAccount(dataDir(), { username, password, email, role, displayName });
    audit.audit(req, 'user.create', user.username, `role=${user.role}`);
    res.json({ ok: true, user });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Could not create the user.', code: e.code });
  }
});

router.patch('/users/:id', adminOnly, primaryOnly, csrf, express.json(), (req, res) => {
  const id = req.params.id;
  const patch = req.body || {};
  if (patch.role !== undefined) {
    const g = accounts.guardRoleChange(dataDir(), id, patch.role);
    if (!g.allowed) return res.status(409).json({ error: g.reason });
  }
  if (patch.status !== undefined) {
    const g = accounts.guardStatusChange(dataDir(), id, patch.status);
    if (!g.allowed) return res.status(409).json({ error: g.reason });
  }
  try {
    const user = users.update(dataDir(), id, { role: patch.role, status: patch.status, email: patch.email, displayName: patch.displayName });
    if (!user) return res.status(404).json({ error: 'User not found.' });
    // A disabled user's sessions are revoked immediately.
    if (patch.status === 'disabled') authsessions.destroyForUser(dataDir(), id).catch(() => {});
    audit.audit(req, 'user.update', user.username, JSON.stringify(patch).slice(0, 120));
    res.json({ ok: true, user });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Could not update the user.', code: e.code });
  }
});

router.delete('/users/:id', adminOnly, primaryOnly, csrf, async (req, res) => {
  const id = req.params.id;
  const g = accounts.guardDelete(dataDir(), id);
  if (!g.allowed) return res.status(409).json({ error: g.reason });
  const u = users.getById(dataDir(), id);
  const removed = await accounts.deleteAccount(dataDir(), id);
  if (!removed) return res.status(404).json({ error: 'User not found.' });
  audit.audit(req, 'user.delete', u ? u.username : id, '');
  res.json({ ok: true });
});

// ── Admin: workspace membership ───────────────────────────────────────────────
router.get('/workspaces/:ws/members', adminOnly, (req, res) => {
  const list = members.membersOf(dataDir(), req.params.ws).map(m => {
    const u = users.getById(dataDir(), m.userId);
    return { userId: m.userId, username: u ? u.username : '(removed)', role: m.role };
  });
  res.json({ members: list, roles: authz.WORKSPACE_ROLES });
});

router.put('/workspaces/:ws/members/:userId', adminOnly, primaryOnly, csrf, express.json(), (req, res) => {
  const { role } = req.body || {};
  if (!users.getById(dataDir(), req.params.userId)) return res.status(404).json({ error: 'User not found.' });
  // Validate the workspace exists too — members.set only checks the id is a non-empty string, so without this a
  // mistyped/stale workspace id would persist an orphan membership row pointing at nothing.
  if (!require('../workspaces').exists(dataDir(), req.params.ws)) return res.status(404).json({ error: 'Workspace not found.' });
  try {
    members.set(dataDir(), req.params.ws, req.params.userId, role);
    audit.audit(req, 'member.set', `${req.params.ws}:${req.params.userId}`, `role=${role}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Could not set membership.', code: e.code });
  }
});

router.delete('/workspaces/:ws/members/:userId', adminOnly, primaryOnly, csrf, (req, res) => {
  const removed = members.remove(dataDir(), req.params.ws, req.params.userId);
  audit.audit(req, 'member.remove', `${req.params.ws}:${req.params.userId}`, '');
  res.json({ ok: !!removed });
});

module.exports = router;
