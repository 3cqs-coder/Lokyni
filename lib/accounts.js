'use strict';
// Accounts service — the domain logic on top of the user/membership/session stores.
//
// It ties password hashing (lib/password.js) to the user store (lib/users.js), applies the rules that are
// policy rather than storage (the first account is the initial admin; minimum password length; the
// initial/last-admin lockout guards), and composes the cascades that keep deletion clean (remove a user's
// memberships and sessions). Pure composition — no HTTP here; routes call these and handle authz.
//
// Every password operation is async (scrypt off the event loop) and fail-closed.

const crypto = require('crypto');
const users = require('./users');
const members = require('./members');
const authsessions = require('./authsessions');
const { hashPassword, verifyPassword, dummyHash } = require('./password');

const MIN_PASSWORD_LEN = 8;
// A sane upper bound. scrypt's cost is independent of input length, and bodies are already capped by the JSON
// parser, so this isn't a DoS lever — it just rejects absurd input early with a clear message.
const MAX_PASSWORD_LEN = 1024;
const passwordLenError = (pw) => {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LEN) return Object.assign(new Error(`Password must be at least ${MIN_PASSWORD_LEN} characters`), { code: 'weak_password' });
  if (pw.length > MAX_PASSWORD_LEN) return Object.assign(new Error(`Password must be at most ${MAX_PASSWORD_LEN} characters`), { code: 'password_too_long' });
  return null;
};

const activeAdmins = (dataDir) => users.list(dataDir).filter(u => u.role === 'admin' && u.status === 'active');

// Create an account. The FIRST account ever created becomes the initial admin regardless of the requested
// role (so a fresh install always has an owner); after that, only an explicit 'admin' request yields an admin
// (the route decides who is allowed to ask). Hashes the password. Throws a coded error on invalid input.
const createAccount = async (dataDir, { username, email, password, role, displayName } = {}) => {
  const lenErr = passwordLenError(password);
  if (lenErr) throw lenErr;
  const first = users.isEmpty(dataDir);
  const effectiveRole = first ? 'admin' : (role === 'admin' ? 'admin' : 'member');
  const passwordHash = await hashPassword(password);
  return users.create(dataDir, { username, email, passwordHash, role: effectiveRole, isInitial: first, displayName });
};

// Verify a login. Always does one scrypt (against a dummy hash when the user is unknown) so timing never
// reveals whether an account exists. Returns { ok, user?, disabled? }. On success, records lastLogin.
const verifyLogin = async (dataDir, username, password) => {
  const rec = users.getRecordByUsername(dataDir, username);
  const stored = rec ? rec.passwordHash : await dummyHash();
  const passwordOk = await verifyPassword(typeof password === 'string' ? password : '', stored);
  if (!rec || !passwordOk) return { ok: false };
  if (rec.status !== 'active') return { ok: false, disabled: true };
  users.touchLastLogin(dataDir, rec.id);
  return { ok: true, user: users.publicView(rec) };
};

// Change a user's password and revoke their other sessions (optionally sparing the current one). Returns the
// number of sessions revoked. Throws on a weak password.
const changePassword = async (dataDir, userId, newPassword, { exceptRawSessionId = null } = {}) => {
  const lenErr = passwordLenError(newPassword);
  if (lenErr) throw lenErr;
  const hash = await hashPassword(newPassword);
  if (!users.setPasswordHash(dataDir, userId, hash)) throw Object.assign(new Error('User not found'), { code: 'not_found' });
  const revoked = await authsessions.destroyForUser(dataDir, userId, exceptRawSessionId);
  // Re-stamp the spared current session so its `created` is now AFTER passwordChangedAt — otherwise the epoch
  // check in principal.fromRequest would drop the very session the user is still using.
  if (exceptRawSessionId) await authsessions.renew(dataDir, exceptRawSessionId);
  return revoked;
};

// ── Lockout guards (pure; a route calls these before mutating) ────────────────
// An install must never be able to lock itself out: the initial admin can't be demoted/disabled/deleted, and
// the last active admin can't lose admin either. Each returns { allowed, reason }.
const guardRoleChange = (dataDir, userId, newRole) => {
  const u = users.getById(dataDir, userId);
  if (!u) return { allowed: false, reason: 'User not found' };
  if (newRole === 'admin') return { allowed: true };
  if (u.isInitial) return { allowed: false, reason: 'The initial admin cannot be demoted' };
  if (u.role === 'admin' && activeAdmins(dataDir).length <= 1) return { allowed: false, reason: 'Cannot demote the last admin' };
  return { allowed: true };
};
const guardStatusChange = (dataDir, userId, newStatus) => {
  if (newStatus !== 'disabled') return { allowed: true };
  const u = users.getById(dataDir, userId);
  if (!u) return { allowed: false, reason: 'User not found' };
  if (u.isInitial) return { allowed: false, reason: 'The initial admin cannot be disabled' };
  if (u.role === 'admin' && activeAdmins(dataDir).length <= 1) return { allowed: false, reason: 'Cannot disable the last admin' };
  return { allowed: true };
};
const guardDelete = (dataDir, userId) => {
  const u = users.getById(dataDir, userId);
  if (!u) return { allowed: false, reason: 'User not found' };
  if (u.isInitial) return { allowed: false, reason: 'The initial admin cannot be deleted' };
  if (u.role === 'admin' && activeAdmins(dataDir).length <= 1) return { allowed: false, reason: 'Cannot delete the last admin' };
  return { allowed: true };
};

// ── Single sign-on provisioning ───────────────────────────────────────────────
const sanitizeUsername = (raw) => {
  let u = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^[^a-z0-9]+/, '');
  return u.slice(0, 63);
};
const uniqueUsername = (dataDir, base) => {
  const seed = base && users.USERNAME_RE.test(base) ? base : ('user' + crypto.randomBytes(2).toString('hex'));
  if (!users.getByUsername(dataDir, seed)) return seed;
  // Try a few deterministic suffixes, then fall straight to a random suffix — don't loop thousands of times
  // (each is a synchronous cached lookup) during an SSO callback on a pathological collision storm.
  for (let i = 2; i <= 20; i++) { const c = (seed + i).slice(0, 64); if (!users.getByUsername(dataDir, c)) return c; }
  for (let tries = 0; tries < 5; tries++) { const c = (seed.slice(0, 50) + '-' + crypto.randomBytes(3).toString('hex')); if (!users.getByUsername(dataDir, c)) return c; }
  return (seed.slice(0, 46) + '-' + crypto.randomBytes(6).toString('hex'));
};

// Resolve an SSO identity (from a validated ID token) to a Lokyni user. Order: an account already linked to
// this subject; else an EXISTING account matched by verified email (linked on the spot); else, when
// autoCreate is on, a freshly provisioned account. Returns { ok, user?, created?, reason? }. SSO accounts get
// an unusable password placeholder (they sign in only through the IdP). Never throws into the caller.
const provisionSsoUser = (dataDir, identity, { autoCreate = true, defaultRole = 'member', linkByEmail = true } = {}) => {
  try {
    if (!identity || !identity.subject) return { ok: false, reason: 'the identity provider returned no subject' };

    // 1. Already linked by subject — a pure read, so it works on any node (sign-in stays available on replicas).
    const linked = users.getBySsoSubject(dataDir, identity.subject);
    if (linked) {
      if (linked.status !== 'active') return { ok: false, reason: 'account disabled' };
      return { ok: true, user: users.publicView(linked) };
    }

    // Everything past here PROVISIONS a new identity — it writes the shared users.json (link-by-email or
    // auto-create) and may run the first-admin election. That is primary-only, exactly like /auth/signup: a
    // replica write would race the primary and the election could fire on two nodes at once. An existing user
    // (handled above) already signed in without reaching here. Refuse provisioning on a replica.
    if (require('./cluster').isReplica()) return { ok: false, reason: 'account setup must run on the primary instance', retryOnPrimary: true };

    // 2. Link to an existing account by a VERIFIED email (an unverified email is never trusted to match). This
    // trusts the IdP's email_verified claim to bind an external identity to a pre-existing local account, so it
    // is gated by oidc.linkByEmail: on for the common single trusted-IdP case, off for a multi-tenant/untrusted
    // IdP where an attacker-influenced verified-email claim must not be able to take over a local account.
    if (linkByEmail && identity.email && identity.emailVerified) {
      const byEmail = users.getByEmail(dataDir, identity.email);
      if (byEmail) {
        if (byEmail.status !== 'active') return { ok: false, reason: 'account disabled' };
        if (byEmail.ssoSubject && byEmail.ssoSubject !== identity.subject) return { ok: false, reason: 'that email is already linked to a different identity' };
        if (!byEmail.ssoSubject) users.setSsoSubject(dataDir, byEmail.id, identity.subject);
        return { ok: true, user: users.publicView(users.getById(dataDir, byEmail.id)) };
      }
    }

    // 3. Auto-provision a new account.
    if (!autoCreate) return { ok: false, reason: 'no account for this identity — ask an administrator to create one' };
    const first = users.isEmpty(dataDir);
    const base = sanitizeUsername(identity.username) || sanitizeUsername((identity.email || '').split('@')[0]);
    const username = uniqueUsername(dataDir, base);
    const passwordHash = 'sso:' + crypto.randomBytes(24).toString('hex');   // no usable password; IdP-only sign-in
    const role = first ? 'admin' : (defaultRole === 'admin' ? 'admin' : 'member');
    const emailOk = identity.email && identity.emailVerified && users.EMAIL_RE.test(identity.email) && !users.getByEmail(dataDir, identity.email);
    const user = users.create(dataDir, { username, email: emailOk ? identity.email : undefined, passwordHash, role, isInitial: first, ssoSubject: identity.subject, displayName: identity.displayName });
    return { ok: true, user, created: true };
  } catch (e) {
    return { ok: false, reason: e.message || 'could not provision the account' };
  }
};

// Delete an account and everything attached to it: memberships, sessions, and owned API keys. Leaves nothing
// orphaned. Caller must have passed guardDelete first. Returns true if the user existed.
const deleteAccount = async (dataDir, userId) => {
  members.removeUser(dataDir, userId);
  await authsessions.destroyForUser(dataDir, userId);
  try { require('./apikeys').removeForOwner(dataDir, userId); } catch { /* best-effort: a key-store error never blocks the delete */ }
  return users.remove(dataDir, userId);
};

module.exports = {
  MIN_PASSWORD_LEN, MAX_PASSWORD_LEN, activeAdmins,
  createAccount, verifyLogin, changePassword, provisionSsoUser,
  guardRoleChange, guardStatusChange, guardDelete, deleteAccount,
};
