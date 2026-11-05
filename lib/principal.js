'use strict';
// Principal resolver — turns any caller into ONE normalized identity for the authorization gate (lib/authz.js).
//
// Resolution order (first match wins); it only ATTACHES, it never rejects:
//   1. A valid session cookie  → the human user (re-validated live every request: a disabled/deleted user is
//      dropped immediately, never served from a still-valid cookie).
//   2. An API key (Bearer / x-api-key) → a machine principal with scope-derived data access.
//   3. No accounts exist yet   → the implicit owner (full access) — this is the non-breaking seam that keeps a
//      fresh single-operator install working exactly as before.
//   4. Otherwise                → anonymous (login required).
//
// Pure of HTTP framework specifics beyond reading headers, so it is easy to unit-test with a plain object.

const users = require('./users');
const members = require('./members');
const authsessions = require('./authsessions');
const apikeys = require('./apikeys');

const COOKIE_NAME = 'lok_session';

// Minimal cookie-header parser (avoids a dependency). Returns a plain object of name→value.
const parseCookies = (header) => {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    let v = part.slice(i + 1).trim();
    try { v = decodeURIComponent(v); } catch { /* leave raw on a malformed value */ }
    out[k] = v;
  }
  return out;
};

const sessionIdFromReq = (req) => parseCookies(req && req.headers && req.headers.cookie)[COOKIE_NAME] || null;

const clientIp = (req) => {
  try {
    const xff = (req.headers && req.headers['x-forwarded-for']) || '';
    return String(xff).split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
  } catch { return ''; }
};

// ── Principal constructors ───────────────────────────────────────────────────
const ownerPrincipal = () => ({ kind: 'owner', globalRole: 'admin', workspaceRoles: new Map() });
const anonymousPrincipal = () => ({ kind: 'anonymous', workspaceRoles: new Map() });
const userPrincipal = (record, rolesMap, sessionId) => ({
  kind: 'user', userId: record.id, username: record.username, globalRole: record.role,
  workspaceRoles: rolesMap || new Map(), sessionId: sessionId || null,
});
const keyPrincipal = (record) => ({
  kind: 'apikey', apiKeyId: record.id, scopes: Array.isArray(record.scopes) ? record.scopes : [],
  allowedWorkspaces: Array.isArray(record.allowedWorkspaces) ? record.allowedWorkspaces : [],
  rateLimit: typeof record.rateLimit === 'number' ? record.rateLimit : null,
  ownerUserId: record.ownerUserId || null,
});

// A stable, filesystem-safe key identifying a principal, for namespacing per-user on-disk artifacts (e.g.
// conversation sessions) so one principal's id can never address another's. Deterministic and bounded: the
// implicit owner is a fixed label; every other identity is a short digest of its kind + id, which is safe
// regardless of the underlying id's characters. Anonymous shares one bucket (it never persists sessions —
// the socket handshake rejects it — so this is just a defined, non-crashing value).
const principalKey = (p) => {
  if (!p || typeof p !== 'object' || p.kind === 'owner') return 'owner';
  const raw = p.kind === 'user'      ? `user:${p.userId}`
            : p.kind === 'apikey'    ? `apikey:${p.apiKeyId}`
            : p.kind === 'anonymous' ? 'anonymous'
            : `other:${p.kind}`;
  return require('./hashid').sha256Hex(raw).slice(0, 16);
};

// Resolve the principal for a request. Async because the session lookup reads the (tiny) session file.
const fromRequest = async (dataDir, req) => {
  // 1. Session cookie → human user.
  const sid = sessionIdFromReq(req);
  if (sid) {
    const sess = await authsessions.get(dataDir, sid);
    if (sess) {
      const rec = users.getRecordById(dataDir, sess.userId);
      // A session is valid only for an active user AND must not predate that user's last password change —
      // the latter is belt-and-suspenders: changePassword already revokes other sessions, but a stale session
      // slipping through (a missed revoke, replica lag) is dropped here too. The spared current session is
      // re-stamped on password change (authsessions.renew), so it is never caught by this.
      const stale = rec && typeof rec.passwordChangedAt === 'number' && typeof sess.created === 'number' && sess.created < rec.passwordChangedAt;
      if (rec && rec.status === 'active' && !stale) {
        authsessions.touch(dataDir, sid, { ip: clientIp(req), ua: req.headers && req.headers['user-agent'] }).catch(() => {});
        return userPrincipal(rec, members.rolesForUser(dataDir, rec.id), sid);
      }
      // The session points at a user who is gone, disabled, or predates their last password change — drop it
      // so the cookie can't linger.
      authsessions.destroy(dataDir, sid).catch(() => {});
    }
  }

  // 2. API key.
  const key = apikeys.extractKey(req);
  if (key) {
    const rec = apikeys.authenticate(dataDir, key);
    if (rec) return keyPrincipal(rec);
  }

  // 3. Implicit owner when no accounts exist yet (the non-breaking seam).
  if (users.isEmpty(dataDir)) return ownerPrincipal();

  // 4. Anonymous.
  return anonymousPrincipal();
};

module.exports = {
  COOKIE_NAME, parseCookies, sessionIdFromReq, clientIp,
  ownerPrincipal, anonymousPrincipal, userPrincipal, keyPrincipal, fromRequest, principalKey,
};
