'use strict';
// Drift guard for the multi-user wiring in server.js. The auth layer is only as safe as its wiring: the
// principal must be attached, the login gate must be present (and non-breaking when no accounts exist), the
// admin-only management routers must stay admin-gated, the auth router and login page must be mounted, and
// allowSignups must be both writable and returned. A source-inspection guard (the gate needs a live boot to
// exercise, which this suite avoids), matching the codebase's self-auditing style. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { WRITABLE_KEYS } = require(path.join(PROJECT, 'lib', 'settings-schema'));
const src = fs.readFileSync(path.join(PROJECT, 'lib', 'server.js'), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // Principal is attached on every request, and the auth router + login page are mounted.
  ok(/attachPrincipal\(DATA_DIR_AUTH\)/.test(src), 'attachPrincipal is registered as middleware');
  ok(/app\.use\('\/auth', require\('\.\/routes\/auth'\)\)/.test(src), 'the /auth router is mounted');
  ok(/app\.get\('\/login'/.test(src), 'the /login page route is mounted');

  // The login gate: non-breaking when empty, exempts login/auth/data-planes, else requires auth.
  ok(/if \(usersStore\.isEmpty\(DATA_DIR_AUTH\)\) return next\(\);/.test(src), 'the gate is a no-op when no accounts exist (non-breaking seam)');
  ok(/AUTH_GATE_EXEMPT/.test(src) && src.includes('api\\/v1|mcp|ws'), 'the gate exempts the login/auth endpoints and the key-authenticated data planes');
  ok(/if \(authmw\.isAuthenticated\(gp\) && gp\.kind !== 'apikey'\) return next\(\);\s*\n\s*return authmw\.deny\(req, res, 401\);/.test(src),
    'the control plane admits only a human session (user/owner); an unauthenticated request is denied');
  // An API key authenticates the data plane (exempted above) but must NOT satisfy the control-plane gate —
  // otherwise a scoped key could read /api/config and enumerate every workspace past its own allow-list.
  ok(/gp\.kind !== 'apikey'\) return next\(\);/.test(src),
    'an API key does not satisfy the control-plane login gate');
  // Reading a workspace persona is scoped to that workspace, not merely a login (it can hold sensitive text).
  ok(/app\.get\('\/api\/workspace\/persona', authmw\.requireCapability\('doc\.read', \{ workspace: personaWsId \}\)/.test(src),
    'GET /api/workspace/persona requires doc.read on the target workspace');
  // /api/config only reveals another workspace's indexed folder paths to a caller who may read that workspace.
  ok(/can\(req\.principal, 'doc\.read', \{ workspaceId: reqWs \}\)/.test(src),
    'GET /api/config scopes per-workspace sourcePaths to a workspace the caller may read');

  // Management routers stay admin-gated.
  for (const mount of ['/api/keys', '/api/connectors', '/api/automations', '/api/eval', '/api/smtp']) {
    ok(new RegExp(`app\\.use\\('${mount.replace('/', '\\/')}', authmw\\.requireGlobalAdmin,`).test(src), `${mount} is admin-gated`);
  }
  // Admin-only inline mutations stay gated.
  for (const route of ['/api/config', '/api/reindex', '/api/consolidate-banks', '/api/workspaces', '/api/backup/restore']) {
    ok(new RegExp(`app\\.(post|delete)\\('${route.replace(/\//g, '\\/')}', authmw\\.requireGlobalAdmin`).test(src), `${route} mutation is admin-gated`);
  }
  // Heavy re-embed routes are also primary-gated so a read replica can't write the shared index.
  ok(/app\.post\('\/api\/consolidate-banks', authmw\.requireGlobalAdmin, authmw\.requirePrimary,/.test(src),
    'consolidate-banks is admin + primary gated (it re-embeds the corpus, like reindex)');

  // Admin-only READ routes that expose host/system/audit data are admin-gated (a plain member must not reach
  // the audit trail, the filesystem browser, the server logs, or host directory stats).
  for (const route of ['/api/audit', '/api/browse', '/api/logs', '/api/source-preview']) {
    ok(new RegExp(`app\\.get\\('${route.replace(/\//g, '\\/')}', authmw\\.requireGlobalAdmin`).test(src), `${route} read is admin-gated`);
  }
  // Switching the single shared active workspace is not reachable by an API-key principal.
  ok(/req\.status\(403\)|res\.status\(403\)[^\n]*API keys/.test(src) || /p\.kind === 'apikey'\) return res\.status\(403\)/.test(src),
    'the active-workspace switch rejects API-key principals');

  // The document data plane is role-gated per workspace: reads need viewer (doc.read), writes need editor
  // (doc.write). Without this, any signed-in member could add/delete documents regardless of their role.
  const docsSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'routes', 'documents.js'), 'utf-8');
  ok(/requireCapability\('doc\.read'/.test(docsSrc) && /requireCapability\('doc\.write'/.test(docsSrc),
    'documents routes build doc.read / doc.write workspace gates');
  ok(/router\.get\('\/', docRead,/.test(docsSrc), 'listing documents requires doc.read');
  ok(/router\.post\('\/', (?:authmw\.requirePrimary, )?docWrite,/.test(docsSrc) && /router\.delete\('\/', (?:authmw\.requirePrimary, )?docWrite,/.test(docsSrc),
    'adding and deleting documents require doc.write (editor)');
  ok(/router\.post\('\/url', (?:authmw\.requirePrimary, )?docWrite,/.test(docsSrc), 'ingesting a URL requires doc.write');
  const viewerSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'routes', 'viewer.js'), 'utf-8');
  ok(/router\.get\('\/raw', docRead,/.test(viewerSrc) && /router\.get\('\/view', docRead,/.test(viewerSrc),
    'reading raw/rendered document content requires doc.read for that workspace');
  console.log('✓ multiuser-wiring: the document data plane is gated by per-workspace role (read vs write)');

  // The chat socket gates EVERY workspace-targeting path by membership — not just the message handler. The
  // whole-workspace synthesis and the rating write both reach another workspace's data, so both must check.
  const socketSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'socket.js'), 'utf-8');
  ok((socketSrc.match(/mayUseWorkspace\(/g) || []).length >= 4, 'socket paths call mayUseWorkspace (message, resolveTurn, synthesize, rating)');
  ok(/if \(!mayUseWorkspace\(turnWs, 'doc\.read'\)\)/.test(socketSrc), 'synthesize_workspace enforces workspace access (doc.read) before synthesizing');
  // rate_answer now resolves the target workspace and ALWAYS checks access — including the active workspace,
  // which a signed-in non-member (or out-of-scope key) must not be able to write a rating into.
  ok(/const targetWs = resolveTurnWs\(\{ workspaceId \}\);\s*\n\s*if \(!mayUseWorkspace\(targetWs\)\) return;/.test(socketSrc),
    'rate_answer resolves the target workspace and always enforces access before writing a rating');
  // mayUseWorkspace re-validates a user live (so disabling/deleting a user revokes an open socket next turn).
  ok(/getById\(dir, principal\.userId\)[\s\S]{0,200}?status !== 'active'/.test(socketSrc),
    'mayUseWorkspace re-reads the user so a disabled/deleted account loses an open socket');
  // An API-key principal on the socket is gated through authz.can — the SAME scope + allow-list enforcement
  // the HTTP API and MCP apply (the socket previously checked only allowedWorkspaces, never scopes).
  ok(/if \(principal\.kind === 'apikey'\) return require\('\.\/authz'\)\.can\(principal, capability, \{ workspaceId: wsId \}\);/.test(socketSrc),
    'the socket enforces API-key scopes via authz.can (scope parity with HTTP/MCP)');
  // Summarize passes doc.read, so a search-only key can chat but not summarize/synthesize over the socket.
  ok(/resolveTurn\(payload, 'doc\.read'\)/.test(socketSrc), 'summarize_document requires doc.read on the socket (scope parity)');
  console.log('✓ multiuser-wiring: the chat socket gates synthesis + ratings + API-key scopes by workspace, and re-validates the user live');

  // Admin user/membership mutations rewrite the shared stores, so they are primary-gated (a replica returns
  // 409) — the single-writer rule for the auth stores, matching the document + management routes.
  const authSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'routes', 'auth.js'), 'utf-8');
  for (const r of [
    "router\\.post\\('\\/users', adminOnly, primaryOnly,",
    "router\\.patch\\('\\/users\\/:id', adminOnly, primaryOnly,",
    "router\\.delete\\('\\/users\\/:id', adminOnly, primaryOnly,",
    "router\\.put\\('\\/workspaces\\/:ws\\/members\\/:userId', adminOnly, primaryOnly,",
    "router\\.delete\\('\\/workspaces\\/:ws\\/members\\/:userId', adminOnly, primaryOnly,",
  ]) ok(new RegExp(r).test(authSrc), `auth mutation is primary-gated: ${r.slice(0, 40)}`);
  // API-key create/revoke rewrite the shared api-keys.json too, so they are primary-gated like the other
  // control-plane writers (a replica rewriting it from a stale copy could clobber the primary's changes).
  const keysSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'routes', 'apikeys.js'), 'utf-8');
  ok(/router\.post\('\/', primaryOnly,/.test(keysSrc), 'API-key create is primary-gated');
  ok(/router\.delete\('\/:id', primaryOnly,/.test(keysSrc), 'API-key revoke is primary-gated');
  console.log('✓ multiuser-wiring: admin user + membership + API-key mutations are primary-gated (shared-store single writer)');

  // The login throttle keys on the UNSPOOFABLE TCP peer (audit.peerIp), not the X-Forwarded-For header a
  // direct client could rotate per attempt, AND adds a per-username axis so an XFF-rotated/distributed guess
  // against one account is still capped. Open signups are peer-rate-limited too (mass-account-creation guard).
  ok(/const peerKey = \(req\) => 'peer:' \+ \(require\('\.\.\/audit'\)\.peerIp\(req\)/.test(authSrc),
    'the login throttle keys on the unspoofable TCP peer (audit.peerIp), not X-Forwarded-For');
  ok(/const userKey = \(username\) => 'user:'/.test(authSrc) && /if \(uk\) throttleFail\(uk, USER_ATTEMPT_LIMIT\)/.test(authSrc),
    'the login throttle also counts failures per username (axis independent of IP)');
  ok(/const wait = Math\.max\(throttleCheck\(pk\), uk \? throttleCheck\(uk\) : 0\)/.test(authSrc),
    'login is locked out if EITHER the peer or the target account is over its limit');
  ok(/Rate-limit open signups per connection peer/.test(authSrc) && /if \(!first\) \{[\s\S]*?throttleFail\(pk\)/.test(authSrc),
    'open signups are per-peer rate-limited (the first account is exempt)');
  // The tracking map is HARD-bounded so a flood of distinct keys (many peers, or attacker-chosen usernames) can
  // never grow it without limit: a second eviction pass drops the oldest entries even when every entry is locked.
  ok(/const MAX_TRACKED = \d+, TARGET_TRACKED = \d+/.test(authSrc)
    && /if \(_attempts\.size > MAX_TRACKED\) \{[\s\S]*?for \(const k of _attempts\.keys\(\)\)/.test(authSrc),
    'the login-throttle map is hard-bounded even under an all-locked flood (OOM-proof)');
  console.log('✓ multiuser-wiring: login throttle is spoof-resistant (peer + per-username), hard-bounded; open signups are rate-limited');

  // GET /api/config is readable by members (the composer's active-tools indicator needs the toggles), but host
  // filesystem paths and infrastructure endpoints are redacted for non-admins (only the POST that writes config
  // is fully admin-gated).
  const serverSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'server.js'), 'utf-8');
  ok(/const isAdmin = !!\(req\.principal && \(req\.principal\.kind === 'owner'/.test(serverSrc),
    'GET /api/config computes whether the caller is an admin');
  ok(/if \(!isAdmin\) \{[\s\S]*?payload\.sourcePaths = \[\];[\s\S]*?for \(const k of cfg\.MASKCRED_PATHS\) if \(k in payload\) payload\[k\] = '';[\s\S]*?\}/.test(serverSrc),
    'GET /api/config redacts source paths + every host/URL endpoint (from MASKCRED_PATHS) for non-admins');
  console.log('✓ multiuser-wiring: GET /api/config redacts host paths/endpoints from non-admin members');

  // The admin UI renders its role/status pickers and password hints from server-provided lists/policy, not
  // hardcoded copies, so adding/renaming one server-side can't leave the dropdowns stale.
  ok(/roles: users\.ROLES, statuses: users\.STATUSES, workspaceRoles: authz\.WORKSPACE_ROLES/.test(authSrc),
    '/auth/users returns the authoritative role/status/workspace-role enums');
  ok(/minPasswordLen: accounts\.MIN_PASSWORD_LEN/.test(authSrc), '/auth/me returns the password-length policy');
  const adminEjs = fs.readFileSync(path.join(PROJECT, 'lib', 'views', 'admin-users.ejs'), 'utf-8');
  ok(/optList\(userRoles, u\.role\)/.test(adminEjs) && /optList\(statuses, u\.status\)/.test(adminEjs) && /optList\(wsRoles, m\.role\)/.test(adminEjs),
    'the admin UI builds its role/status/member-role selects from the server lists');
  ok(!/\['admin','member'\]\.map/.test(adminEjs) && !/\['active','disabled'\]\.map/.test(adminEjs),
    'the admin UI no longer hardcodes the role/status option lists in its row renderer');
  ok(/var gate = warn \? AuthPage\.confirm\(\{ title: warn, okLabel: 'Yes', danger: true \}\)/.test(adminEjs),
    'demoting an admin or disabling an account is confirmed first (via the themed AuthPage.confirm, not native confirm)');
  // The SSO linkByEmail flag round-trips through the admin API (GET returns it, POST persists it) so saving
  // settings in the UI can't silently reset it.
  const ssoAdminSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'routes', 'ssoadmin.js'), 'utf-8');
  ok(/linkByEmail: o\.linkByEmail !== false/.test(ssoAdminSrc) && /linkByEmail: !\(b\.linkByEmail === false/.test(ssoAdminSrc),
    'the SSO admin API reads and writes linkByEmail (no silent reset on save)');
  console.log('✓ multiuser-wiring: admin UI sources role/status/password policy from the server; SSO linkByEmail round-trips');

  // The prompt-template library is shared install-wide: listing is open, but mutating it (add/update/delete/
  // restore-builtins) is admin + primary, so a member can't rewrite everyone's templates and a replica can't
  // race the shared file.
  const promptsSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'routes', 'prompts.js'), 'utf-8');
  ok(/adminWrite\s*=\s*\[authmw\.requireGlobalAdmin, authmw\.requirePrimary\]/.test(promptsSrc),
    'prompts router defines an admin+primary write gate');
  for (const r of [
    "router\\.post\\('\\/', adminWrite,",
    "router\\.post\\('\\/restore-builtins', adminWrite,",
    "router\\.put\\('\\/:id', adminWrite,",
    "router\\.delete\\('\\/:id', adminWrite,",
  ]) ok(new RegExp(r).test(promptsSrc), `prompts mutation gated: ${r.slice(0, 36)}`);
  ok(/router\.get\('\/', \(req, res\)/.test(promptsSrc), 'listing templates stays open to any signed-in user');
  console.log('✓ multiuser-wiring: prompt-template mutations are admin+primary gated; listing stays open');

  // The expired-session sweep is wired at boot (it is unref\'d and registered for shutdown).
  const bootSrc = fs.readFileSync(path.join(PROJECT, 'lokyni.js'), 'utf-8');
  ok(/authsessions'\)\.startPrune\(/.test(bootSrc) && /shutdown\.register\('session prune'/.test(bootSrc),
    'the auth-session prune timer is started at boot and cleared on shutdown');

  // allowSignups is writable AND surfaced by GET /api/config (so the toggle round-trips).
  ok(WRITABLE_KEYS.includes('allowSignups'), 'allowSignups is in the shared writable-config schema');
  ok(/allowSignups:\s*cfg\.allowSignups/.test(src), 'allowSignups is returned by GET /api/config');

  // SSO settings API is admin-only AND primary-only (shared config write), and the replica banner is wired.
  ok(/app\.use\('\/api\/sso', authmw\.requireGlobalAdmin, authmw\.requirePrimary,/.test(src), 'the SSO settings API is admin + primary gated');
  const chatEjs = fs.readFileSync(path.join(PROJECT, 'lib', 'views', 'chat.ejs'), 'utf-8');
  ok(/id="replica-banner"/.test(chatEjs) && /st\.cluster === 'replica'/.test(chatEjs), 'the chat page reveals a read-replica banner from /status');

  console.log('✓ multiuser-wiring: principal attached, login gate present+non-breaking, management routes admin-gated, signup toggle round-trips, SSO settings + replica banner wired');
  console.log(`\nALL MULTIUSER-WIRING UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ MULTIUSER-WIRING UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
