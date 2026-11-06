'use strict';
const http   = require('http');
const path   = require('path');
const fsSync = require('fs');
const os     = require('os');
const express = require('express');
const compression = require('compression');
// Only immutable, argv-derived, or boot-time values are destructured here. Everything the request
// handlers read that a user can change at runtime (provider, model, limits, toggles) is read live
// via require('./config') at call time, so a Settings change applies without a restart.
const { APP_NAME, DEBUG, USE_RERANKER, PORT, BIND_ADDRESS } = require('./config');
// True when the desktop shell launched this server (it passes --desktop). Surfaced to the page so
// the client can route external links to the system browser instead of the single desktop webview.
// Immutable for the process lifetime, so it is read once here rather than live.
const DESKTOP = process.argv.includes('--desktop');
const { initSocket } = require('./socket');
const { TURN_PROTOCOL } = require('./turncontrol');
const { WRITABLE_KEYS, CLEARABLE_KEYS, SECRET_KEYS, BOOLEAN_KEYS, CLIENT_SETTINGS, PROVIDERS } = require('./settings-schema');
const { OCR_LANGUAGES, normalizeOcrLanguages } = require('./ocr-languages');
const { preloadReranker } = require('./retrieval/reranker');
const documentsRouter = require('./routes/documents');
const apiV1Router     = require('./routes/apiv1');
const apiKeysRouter   = require('./routes/apikeys');
const connectorsRouter = require('./routes/connectors');
const promptsRouter   = require('./routes/prompts');
const ttsRouter       = require('./routes/tts');
const sttRouter       = require('./routes/stt');
const podcastRouter   = require('./routes/podcast');
const automationsRouter = require('./routes/automations');
const evalRouter      = require('./routes/eval');
const smtpRouter      = require('./routes/smtp');
const viewerRouter    = require('./routes/viewer');
const state = require('./state');
const { isWithin } = require('./paths');

// Backup uploads stream to a temp file rather than memory. An archive can be
// gigabytes — memoryStorage would hold the whole thing in RAM, and the restore path
// then needs a second decompressed copy. Writing to disk keeps memory bounded and
// lets the reader seek, which the container format needs to read its header cheaply.
// Stage under the data directory (the persistent volume), NOT os.tmpdir(): in the Docker
// image /tmp is a RAM-backed tmpfs, so a multi-GB restore/inspect there would fill RAM and
// OOM-kill the container — the exact trap backup.js's own staging avoids. The data volume
// has the room and is where the restore reads from anyway.
const _multer = require('multer');
const _uploadTmpDir = path.join(require('./config').DATA_DIR, 'tmp', 'uploads');
try { fsSync.mkdirSync(_uploadTmpDir, { recursive: true }); } catch { /* created lazily on first save otherwise */ }
const backupUpload = _multer({
  dest: _uploadTmpDir,
  limits: { fileSize: 8 * 1024 * 1024 * 1024 },   // 8 GB
});
// Temp uploads are removed once handled, whatever the outcome — a leftover copy of
// someone's documents in /tmp is worse than a failed restore.
const cleanupUpload = (req) => {
  if (req.file?.path) { try { fsSync.unlinkSync(req.file.path); } catch {} }
};
// Run the multer upload and turn its errors (e.g. an over-8GB file → LIMIT_FILE_SIZE) into a clean JSON
// response instead of a generic 500 HTML page, cleaning up any partial temp. Without this, an oversized upload
// rejects in middleware before the route's finally{cleanupUpload} ever runs.
const uploadBackupFile = (req, res, next) => {
  backupUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    cleanupUpload(req);
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    return res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'The uploaded file is too large.' : 'Upload failed.' });
  });
};

const app = express();
// Identical behavior on every deployment: responses are compressed when the client accepts it, so the
// first load of the UI (a ~400 KB chat bundle plus CSS and fonts) is a fraction of its raw size over a
// LAN, a reverse proxy, or a mobile connection. Skip server-sent events explicitly: they are an
// unbounded stream, and buffering a token until the compression window fills would make a streamed
// answer look stalled. `compression` sets Vary: Accept-Encoding and leaves already-encoded responses
// alone, so cached static assets and proxied bodies are unaffected.
app.use(compression({
  threshold: 1024,   // below this, the encoding overhead costs more than it saves
  filter: (req, res) => {
    const type = String(res.getHeader('Content-Type') || '').toLowerCase();
    // Streamed answers and file transfers are not good compression candidates: SSE would be held back
    // by the encoding window, and an attachment/octet-stream is usually an already-compressed archive
    // (the backup download is a .gz stream) that would only cost CPU and make the transfer slower.
    if (type.includes('text/event-stream')) return false;
    if (type.includes('application/octet-stream')) return false;
    if (res.statusCode === 206) return false;   // partial content: preserve byte-range semantics for seeking
    if (/\bno-transform\b/i.test(String(res.getHeader('Cache-Control') || ''))) return false;
    if (/^\s*attachment\b/i.test(String(res.getHeader('Content-Disposition') || ''))) return false;
    return compression.filter(req, res);
  },
}));
// The framework banner is free reconnaissance for an attacker and has no diagnostic value here.
app.disable('x-powered-by');

// The config keys a POST /api/config request may write, derived from the ONE settings schema
// (lib/settings-schema.js). The schema also supplies the clearable, secret, and boolean sets below,
// and the compact defaults/ranges projection the page receives. A key that is writable but not returned
// by GET /api/config would be write-only; the config-drift test asserts that cannot happen.
const CONFIG_WRITABLE_KEYS = WRITABLE_KEYS;

// Control-plane request-origin guard (defense-in-depth beyond the loopback bind).
//
// The UI's control plane (settings, file viewer, browse, backups, connectors, reindex…)
// is same-origin and not API-key-gated. This blocks CROSS-ORIGIN requests to it, so a
// website the user has open can't drive Lokyni or read its files/documents from the
// browser (CSRF / drive-by). It relies on Sec-Fetch-Site (browser-set, not forgeable by
// page JS), falling back to an Origin/Host comparison; requests with neither header
// (direct address-bar navigation, a bookmark, a same-host reverse proxy, or a local CLI)
// are allowed — matching the threat model (a local process running as the user can read
// the data directly, so gating it here would add friction without a real boundary).
//
// The API-key data plane (/api/v1) and the MCP endpoint (/mcp) are meant to be called by
// external/programmatic clients with a key, so they are exempt; socket.io (/ws) enforces
// its own same-origin policy.
// DNS-rebinding defense. When bound to loopback (the default), the ONLY legitimate way to reach
// the server is via a loopback Host — you cannot connect to 127.0.0.1 from another machine. A
// rebinding attack (a page on evil.com whose DNS flips to 127.0.0.1) sends Host: evil.com yet
// reaches this loopback server, and the origin guard below would pass it because Origin and Host
// then match. Rejecting a non-loopback Host here closes that hole for the whole control plane
// (reindex, delete, config, models…). Skipped when bound to a network address: the user opted
// into broader access and their intended hostname is unknown to us (the network-exposure watchdog
// covers that case). The desktop app and PWA both load via 127.0.0.1 / localhost, so this never
// affects legitimate use.
// The Host check itself lives in lib/hostguard.js so the socket.io data channel can share the
// exact same logic — socket.io attaches to the raw HTTP server and handles /ws before Express
// middleware, so it needs its own copy of this defense (see lib/socket.js allowRequest).
const { isLoopbackHostHeader, isAllowedHost, isSameOriginRequest, isBindLoopback } = require('./hostguard');
app.use((req, res, next) => {
  if (!isAllowedHost(req.get('host'))) {
    return res.status(403).json({ error: 'Unrecognized Host' });
  }
  next();
});

// Cross-site request block. The decision (Sec-Fetch-Site, else Origin vs Host, else allow a
// non-browser client) is shared with the socket.io handshake via lib/hostguard.js so the two can
// never drift. The /api/v1 and /mcp endpoints are exempt because they are authenticated by API
// key, not origin, so legitimate cross-origin callers (a CLI, another tool) must reach them; /ws
// is exempt here only because socket.io runs the same check itself before Express.
const ORIGIN_EXEMPT = /^\/(api\/v1|mcp|ws)(\/|$)/;
app.use((req, res, next) => {
  if (ORIGIN_EXEMPT.test(req.path)) return next();
  if (!isSameOriginRequest(req.headers)) {
    return res.status(403).json({ error: 'Cross-origin request blocked' });
  }
  return next();
});

// Content-Security-Policy (defense-in-depth). The chat renders model output and the viewer
// server-renders document markdown; both sinks are already hardened (marked escapes raw HTML
// and drops non-allowlisted URL schemes; MarkdownIt runs with html:false), so this is a second
// line of defense should a future sink slip through. A per-request nonce authorizes the app's
// own inline bootstrap scripts, so `script-src` needs no 'unsafe-inline' — an injected inline
// script has no valid nonce and cannot run. Styles keep 'unsafe-inline' (the UI uses inline
// style attributes); everything else is same-origin only. `data:` is allowed for images
// (figure thumbnails). connect-src 'self' covers the same-origin socket.io channel.
app.use((req, res, next) => {
  const nonce = require('crypto').randomBytes(16).toString('base64');
  res.locals.nonce = nonce;
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    // 'self', not 'none': the document viewer embeds a same-origin PDF via an <iframe
    // src="/document/raw">, and this header applies to that framed response too. 'none' would
    // block it and leave inline PDF viewing blank. 'self' still prevents cross-origin
    // clickjacking (and the origin guard already blocks cross-origin requests to /document/*).
    "frame-ancestors 'self'",
    "form-action 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self' 'nonce-${nonce}'`,
    "connect-src 'self'",
    "frame-src 'self'",
  ].join('; '));
  // Baseline hardening for every response. `nosniff` stops a browser from re-interpreting an
  // uploaded file as script or HTML; the referrer policy keeps document paths and query strings
  // out of outbound links; the frame header repeats the CSP rule for older engines.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// 5mb so the browser clipper can POST a full page's extracted HTML (the default
// 100kb limit would reject anything but small pages).
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
// Serve the frontend. Caching is disabled for the app's own JS/CSS/EJS output:
// Lokyni is a local single-user app where the bandwidth saving is irrelevant, and a
// stale cached chat.js after an upgrade is genuinely hard to diagnose — the UI
// silently runs old code while the server runs new code. Vendor files are immutable
// and keep normal caching.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (/[\\/](vendor|fonts|icons)[\\/]/.test(filePath)) {
      // Vendored libraries, fonts, and app icons are immutable content — cache them hard so
      // the installed app loads instantly and works offline for its own static assets.
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.setHeader('Cache-Control', 'no-cache');                  // revalidate every load
    }
  },
}));
app.set('view engine', 'ejs');
// Views live OUTSIDE the static web root (lib/views, not lib/public/views). express.static above serves
// everything under lib/public before any route, so keeping the EJS templates there would let a client
// fetch their raw source (GET /views/chat.ejs). They hold no secrets, but the source is not meant to be
// served — placing them outside the served directory removes the exposure entirely.
app.set('views', path.join(__dirname, 'views'));

// ── Multi-user auth (Phase 1) ────────────────────────────────────────────────
// Resolve the caller's identity on every request (this never rejects — it only attaches req.principal).
// NON-BREAKING: with no accounts yet, the resolver returns the implicit owner and the login gate below is a
// no-op, so a fresh single-operator install behaves exactly as it always has. The moment a first account is
// created, the control plane requires a signed-in user. Static assets are already served above; the login
// page and the auth API stay reachable without a session; the data planes (/api/v1, /mcp, /ws) carry their
// own authentication.
const authmw = require('./authmiddleware');
const usersStore = require('./users');
const DATA_DIR_AUTH = require('./config').DATA_DIR;
// Warm the auth secret at boot: establish (and in a cluster, converge on) it once up front — with an
// EXCLUSIVE create so racing nodes can't diverge — rather than on the first request that needs it. This
// moves the one-time file I/O off the first auth/CSRF request, and surfaces a present-but-unreadable
// secret as a clear boot warning instead of a first-request failure. Best-effort and NON-fatal: the
// fail-closed signer still rejects requests if the secret truly can't be established, so a transient
// hiccup here never blocks startup.
try { require('./authsecret').getSecret(); }
catch (e) { console.warn(`⚠️  Auth secret could not be established at boot (${e && e.message || e}); will retry on first use.`); }
app.use(authmw.attachPrincipal(DATA_DIR_AUTH));
app.use('/auth/sso', require('./routes/sso'));
app.use('/auth', require('./routes/auth'));
app.get('/login', (_req, res) => {
  res.render('login', { appName: APP_NAME, assetVersion, nonce: res.locals.nonce });
});
// Each exempt token must be followed by a subpath, the end, or a dot (an extension) — NOT a bare word boundary.
// A trailing \b would also match a prefix-adjacent path (/auth-x, /status-internal), silently exempting a future
// route from the login gate; anchoring to (\/|$|\.) keeps exactly the intended paths exempt.
const AUTH_GATE_EXEMPT = /^\/(auth|login|readme\.md|manifest\.webmanifest|status|favicon)(\/|$|\.)/;
app.use((req, res, next) => {
  if (usersStore.isEmpty(DATA_DIR_AUTH)) return next();                 // no accounts → open (implicit owner)
  if (AUTH_GATE_EXEMPT.test(req.path)) return next();                   // login page + auth API + a few public endpoints
  if (/^\/(api\/v1|mcp|ws)(\/|$)/.test(req.path)) return next();        // key/own-auth data planes
  // Control plane: a human session only. An API key authenticates the data planes exempted above, never the
  // control plane (config, workspace listing, management). Counting a key as authenticated here would let a
  // scoped key read server config and enumerate every workspace past its own allow-list, so require user/owner.
  const gp = req.principal;
  if (authmw.isAuthenticated(gp) && gp.kind !== 'apikey') return next();
  return authmw.deny(req, res, 401);                                    // browser GET → redirect to /login; else 401 JSON
});

// CSRF (defense-in-depth) for the whole /api control plane. The loopback bind, the cross-origin
// request guard, and the SameSite=Lax session cookie already block cross-site requests; this
// double-submit token is a second, independent barrier on every state-changing /api call. It only
// applies to cookie-session principals and unsafe methods: requireCsrf passes API-key and
// implicit-owner callers straight through (so the key data planes under /api/v1 are unaffected) and
// skips GET/HEAD/OPTIONS. The browser attaches the token as an x-csrf-token header (fetch/XHR) or a
// _csrf form field (the streamed backup-download form); requireCsrf reads either. The secret dir is
// left to authsecret to resolve (the local config/ folder on a single node, the shared data dir in a
// cluster) — exactly as the /auth router and the token minted by csrfToken() do, so they stay in sync.
app.use('/api', authmw.requireCsrf());

// Cache-busting token derived from the frontend files' modification times. Appended
// to asset URLs so an upgrade can never leave a browser running an old chat.js
// against a new server — a failure mode that looks like the UI silently not working.
const assetVersion = (() => {
  try {
    const pubDir = path.join(__dirname, 'public');
    const files = [
      path.join(pubDir, 'js', 'chat.js'),
      path.join(pubDir, 'css', 'app.css'),
      path.join(pubDir, 'fonts', 'fonts.css'),   // the editable @font-face manifest is served immutable too
    ];
    // Fold in every vendored script's mtime too. Vendored libraries are served with a one-year
    // immutable cache (below), so bumping one in place — same filename, new bytes — would otherwise
    // pin the old copy in the browser cache and silently run an old library against new app code. The
    // `?v=` token in the markup must therefore change when any vendored script changes. A bounded scan
    // of the vendor folder keeps this correct as libraries are added or updated, with no per-file list
    // to drift. Runs once at boot.
    require('./fswalk').walkFiles(path.join(pubDir, 'vendor'), (full) => { if (full.endsWith('.js')) files.push(full); });
    const newest = Math.max(...files.map(f => {
      try { return fsSync.statSync(f).mtimeMs; } catch { return 0; }
    }));
    return String(Math.floor(newest)).slice(-10);
  } catch { return String(Date.now()); }
})();

// Routes
app.locals.assetVersion = assetVersion;
app.get('/', (_req, res) => {
  const liveCfg = require('./config');
  const { SUPPORTED_ACCEPT_ATTR, SUPPORTED_EXT_LABEL, uploadFormatsLabel } = require('./constants');
  // Single-source the synthesis format list from the server catalog so the <select> options can never drift
  // from the formats the synthesis actually supports (labels + keys come from one place: api-core).
  const { SYNTHESIS_FORMATS } = require('./api-core');
  // The upload-size hint is single-sourced from the live MAX_FILE_SIZE so it can't drift from the real limit
  // when maxFileBytes is configured (the old hint hardcoded "500 MB"). GB once the limit reaches a gigabyte.
  const maxMb = Math.round(liveCfg.MAX_FILE_SIZE / (1024 * 1024));
  const maxUploadLabel = maxMb >= 1024 ? (maxMb / 1024).toFixed(maxMb % 1024 ? 1 : 0) + ' GB' : maxMb + ' MB';
  const uploadFormats = uploadFormatsLabel({ ocr: liveCfg.USE_OCR, vision: liveCfg.VISION_DESCRIBE, audio: liveCfg.useAudioIngest });
  res.render('chat', { appName: APP_NAME, provider: liveCfg.AI_PROVIDER, model: liveCfg.LLM_MODEL, assetVersion, nonce: res.locals.nonce, desktop: DESKTOP, acceptAttr: SUPPORTED_ACCEPT_ATTR, extLabel: SUPPORTED_EXT_LABEL, uploadFormats, maxUploadLabel, synthesisFormats: SYNTHESIS_FORMATS, citationFormats: require('./citations').FORMATS, urlCaptureValues: require('./settings-schema').SETTINGS.urlCapture.values, ocrEngineValues: require('./settings-schema').SETTINGS.ocrEngine.values, turnProtocol: TURN_PROTOCOL, settingsSchema: CLIENT_SETTINGS });
});
// Account self-service and admin user management pages. Both sit after the login gate, so they require a
// signed-in user; the admin page additionally requires a global admin. Self-contained pages that drive the
// /auth API (same pattern as the login page), so they need no change to the main chat bundle.
app.get('/account', (_req, res) => res.render('account', { appName: APP_NAME, assetVersion, nonce: res.locals.nonce }));
app.get('/admin/users', authmw.requireGlobalAdmin, (_req, res) => res.render('admin-users', { appName: APP_NAME, assetVersion, nonce: res.locals.nonce }));

app.get('/status', (_req, res) => {
  res.json({
    indexing: state.indexing,
    ready: !!state.liveVectorStore && state.indexReady,
    documents: state.parentMap.size,
    // Resumable bank re-embed (Settings → Consolidate). Hydrated from the on-disk marker once per workspace
    // load/switch (lib/indexing/init.js), so this hot, frequently-polled endpoint never touches the disk.
    bankMigration: require('./config').useEmbeddingBanks ? (state.bankMigration || null) : null,
    // True while indexing, answering a question, or building the knowledge graph. The desktop shell reads this
    // to warn before quitting so long work is not aborted by closing the window, and the web app guards tab-close
    // on it too. (A graph build is interruptible/resumable, but still worth a heads-up before cutting it off.)
    busy: state.indexing || (state.activeQueries || 0) > 0 || !!(state.graphBuild && state.graphBuild.running)
      || !!(state.bankMigration && state.bankMigration.status === 'running'),
    // A short reason for the busy state, so the close/quit warning can say WHAT is running.
    busyReason: state.indexing ? 'indexing your documents'
      : (state.graphBuild && state.graphBuild.running) ? 'building the knowledge graph'
      : ((state.activeQueries || 0) > 0 ? 'answering a question'
      : ((state.bankMigration && state.bankMigration.status === 'running') ? 're-embedding with the current model' : null)),
    // Scale-out role: 'off' (single node), 'primary', or 'replica'. Lets the UI/ops tell a read replica apart.
    cluster: require('./cluster').mode(),
  });
});

// Serve the README so the in-app Guide can render and search it. It ships with the app (it is in the
// publish allowlist and copied into the Docker image), so it resolves relative to the app root in
// every deployment — a source checkout, an installed copy, the desktop bundle, and the container.
// Served as text; the client renders it with the same Markdown renderer used for answers. Cached and
// refreshed by modification time so an edit shows without a restart.
let _readmeCache = null;
app.get('/readme.md', async (_req, res) => {
  const fp = path.join(__dirname, '..', 'docs', 'README.md');
  try {
    // Async stat/read: the guide is opened on demand, and the app can live on a slow or network mount.
    // The mtime cache means an edit still shows without a restart, and a hit costs one stat.
    const mtime = (await fsSync.promises.stat(fp)).mtimeMs;
    if (!_readmeCache || _readmeCache.mtime !== mtime) {
      _readmeCache = { mtime, text: await fsSync.promises.readFile(fp, 'utf-8') };
    }
    res.type('text/markdown; charset=utf-8').send(_readmeCache.text);
  } catch {
    res.status(404).type('text/plain').send('The guide is not available in this build.');
  }
});

// Web app manifest — makes Lokyni installable as a desktop/standalone app (its own window
// and launcher icon) instead of only a browser tab. Served from a route rather than a static
// file so the name and theme stay single-sourced from the app's own configuration and can
// never drift from the rest of the UI. The icons and fonts it references are ordinary static
// files under lib/public. `no-cache` lets a rename or rebrand take effect on the next load.
app.get('/manifest.webmanifest', (_req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.setHeader('Cache-Control', 'no-cache');
  res.json({
    name: APP_NAME,
    short_name: APP_NAME,
    description: 'Answers questions from your own documents, with sources — private, local, and able to run offline.',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0f0f0f',
    theme_color: '#0f0f0f',
    icons: [
      { src: '/icons/icon.svg', type: 'image/svg+xml', sizes: 'any', purpose: 'any' },
      { src: '/icons/icon-192.png', type: 'image/png', sizes: '192x192', purpose: 'any' },
      { src: '/icons/icon-512.png', type: 'image/png', sizes: '512x512', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', type: 'image/png', sizes: '512x512', purpose: 'maskable' },
    ],
  });
});

// Rebuild the index from scratch (same-origin UI action). Wipes the vector-store
// cache and reindexes every document, so internal ids realign with current paths.
// Responds immediately and runs in the background; the UI polls /status (indexing:
// true → false) to know when it's done.
app.post('/api/reindex', authmw.requireGlobalAdmin, authmw.requirePrimary, (req, res) => {
  if (state.indexing) return res.status(409).json({ ok: false, error: 'An index operation is already running.' });
  require('./audit').audit(req, 'index.rebuild', state.workspaceId || '', 'full reindex from scratch');
  res.json({ ok: true, started: true });
  // Fire-and-forget; forceReindex logs its own progress and errors.
  require('./indexing/init').forceReindex().catch(e => console.error('❌ Rebuild failed:', e.message || e));
});

// Consolidate embedding banks into one for the current model (same-origin UI action).
// Re-embeds every document, so like /api/reindex it runs in the background and the UI
// polls /status. Only meaningful when embedding banks are enabled.
app.post('/api/consolidate-banks', authmw.requireGlobalAdmin, authmw.requirePrimary, (req, res) => {
  if (!require('./config').useEmbeddingBanks) return res.status(400).json({ ok: false, error: 'Embedding banks are not enabled.' });
  // A resumable migration runs in batches, so `state.indexing` is briefly false between them. Check the run
  // flag too, or a second click would queue a duplicate behind the lifecycle lock and run the whole thing again.
  if (state.indexing || require('./indexing/init').banksMigrationRunning()) {
    return res.status(409).json({ ok: false, error: 'An index operation is already running.' });
  }
  require('./audit').audit(req, 'index.consolidate', state.workspaceId || '', 'consolidate embedding banks (re-embed)');
  res.json({ ok: true, started: true });
  require('./indexing/init').consolidateBanks().catch(e => console.error('❌ Consolidate failed:', e.message || e));
});

// Predict whether switching the embedding configuration would REUSE the existing embeddings or open a new bank,
// WITHOUT committing (same-origin UI action). It embeds a small probe through the prospective and the current
// embedding models to measure equivalence, so it is admin-gated and runs ONLY when the user explicitly asks
// (a button) — never on its own, so a metered provider is never billed for a background check. The effective
// base URL is resolved exactly as a real switch would fingerprint it, so the prediction matches the outcome.
app.post('/api/embeddings/predict-switch', authmw.requireGlobalAdmin, authmw.requirePrimary, async (req, res) => {
  const cfg = require('./config');
  if (!cfg.useEmbeddingBanks) return res.json({ outcome: 'disabled', message: 'Embedding banks are off, so changing the embedding model rebuilds the single index.' });
  const banksMod = require('./indexing/banks');
  const body = req.body || {};
  const provider = String(body.provider || cfg.EMBEDDINGS_PROVIDER || '').trim();
  const model = String(body.model || cfg.EMBEDDINGS_MODEL || '').trim();
  if (!provider || !model) return res.status(400).json({ outcome: 'unknown', message: 'Choose an embeddings provider and model first.' });
  // Resolve the base URL and fingerprint EXACTLY as a real switch does (config.embedBaseUrl + the normalized
  // fingerprint), so the prediction can never diverge from the outcome.
  const baseUrl = cfg.embedBaseUrl(cfg, provider, String(body.baseUrl || '').trim());
  const liveMeta = { fp: banksMod.fingerprint(provider, model, baseUrl), provider, model, baseUrl };
  try {
    res.json(await banksMod.predictSwitch(cfg.CACHE_DIR, { makeEmbeddings: require('./embeddings').makeEmbeddings, liveMeta }));
  } catch { res.json({ outcome: 'unknown', message: 'Could not check right now — the current provider must be reachable to compare.' }); }
});

// Build (or refresh) the LLM knowledge graph for the active workspace on demand (same-origin UI action).
// Reads the already-stored document text and extracts entities/relationships with the model — it never
// re-embeds, so it is safe to run any time the graph feature is on. Incremental: only changed documents
// are re-read. Responds immediately and runs in the background; the UI polls /api/graph/status.
// Start an incremental knowledge-graph build in the background (fire-and-forget), tracking progress in
// state.graphBuild and broadcasting graph_build on completion. Shared by the manual Build button and the
// auto-build that fires when the user turns the graph ON — so there is ONE orchestration, no drift. Returns
// false (does nothing) when a build is already running. Never throws.
function startGraphBuild() {
  if (state.graphBuild && state.graphBuild.running) return false;
  const wsId = state.workspaceId || 'default';
  state.graphBuild = { running: true, done: 0, total: 0, extracted: 0, startedAt: Date.now(), finishedAt: null, status: null };
  // Announce the START too (not only completion), so any connected client knows a build is running — the web
  // app uses this to warn before closing the tab mid-build.
  try { require('./socket').broadcast('graph_build', { ...state.graphBuild, workspaceId: wsId }); } catch {}
  Promise.resolve()
    .then(() => require('./graphstore').buildGraph(wsId, (done, total) => {
      if (state.graphBuild) { state.graphBuild.done = done; state.graphBuild.total = total; }
    }))
    .then((r) => {
      state.graphBuild = { ...state.graphBuild, running: false, finishedAt: Date.now(), status: (r && r.status) || 'ok', extracted: (r && r.extracted) || 0, total: (r && r.total) || (state.graphBuild ? state.graphBuild.total : 0) };
      try { require('./socket').broadcast('graph_build', { ...state.graphBuild, workspaceId: wsId }); } catch {}
    })
    .catch((e) => {
      state.graphBuild = { ...state.graphBuild, running: false, finishedAt: Date.now(), status: 'error', error: e && e.message };
      try { require('./socket').broadcast('graph_build', { ...state.graphBuild, workspaceId: wsId }); } catch {}
    });
  return true;
}

app.post('/api/graph/build', authmw.requireGlobalAdmin, authmw.requirePrimary, (req, res) => {
  if (!require('./config').useGraphRag) return res.status(400).json({ ok: false, error: 'The knowledge graph is not enabled.' });
  if (state.graphBuild && state.graphBuild.running) return res.status(409).json({ ok: false, error: 'A knowledge-graph build is already running.' });
  require('./audit').audit(req, 'graph.build', state.workspaceId || '', 'build knowledge graph');
  startGraphBuild();
  res.json({ ok: true, started: true });
});

// Current knowledge-graph build progress plus a lightweight summary of the stored graph, so the UI can
// show whether one exists and how large it is. Never throws — reports an empty graph on any read error.
app.get('/api/graph/status', async (_req, res) => {
  const build = state.graphBuild || { running: false };
  let graphSummary = { nodes: 0, edges: 0 };
  try {
    const gs = require('./graphstore');
    graphSummary = gs.summarize(await gs.getGraph(state.workspaceId || 'default'));
  } catch {}
  res.json({ ok: true, enabled: !!require('./config').useGraphRag, build, graph: graphSummary });
});

// Rich health endpoint — index stats, lifecycle timing, and provider reachability.
// Preview how many files a candidate source folder would contribute, so the user
// can see the scale before adding it. Indexing a large folder is easy to do by
// accident and expensive to undo, so this is deliberately surfaced up front.
app.get('/api/source-preview', authmw.requireGlobalAdmin, async (req, res) => {
  const raw = req.query.path;
  if (!raw || typeof raw !== 'string') return res.status(400).json({ error: 'Missing path' });
  try {
    // Confine to the same browsable volumes as /api/browse. Without this, a same-origin caller
    // could read file counts and total bytes for any directory on the host (e.g. /etc, /var) —
    // a small but needless disclosure. Resolve (expanding ~) before the containment check.
    let dir = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
    dir = path.resolve(dir);
    const vols = await listVolumes();
    const { real, ok } = await realWithinVolumes(dir, vols);
    if (!ok) return res.status(403).json({ error: 'Outside the browsable area' });
    const { previewSource } = require('./indexing/files');
    const result = await previewSource(real, {
      recursive: req.query.recursive === 'true',
      maxDepth: parseInt(req.query.maxDepth, 10) || 3,
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Discover browsable roots — the home directory plus any mounted volumes, so
// external drives and network mounts are reachable from the folder picker.
//
// Everything here uses the filesystem API only; no child processes are spawned.
// On Unix, mounts appear as directories under well-known parents. On Windows,
// drive letters are probed with existsSync, which is cheap for absent letters and
// avoids wmic/fsutil entirely.
// ASYNC on purpose: a stale or unresponsive network mount makes a synchronous stat block
// the WHOLE process (every socket and query) until the filesystem times out. Using the
// promise API keeps the event loop free while the OS resolves each mount.
const listVolumes = async () => {
  const home = os.homedir();
  const vols = [{ name: 'Home', path: home, kind: 'home' }];
  const seen = new Set([path.resolve(home)]);

  const addDir = async (p, name, kind) => {
    const abs = path.resolve(p);
    if (seen.has(abs)) return;
    try {
      if (!(await fsSync.promises.stat(abs)).isDirectory()) return;
    } catch { return; }              // unreadable or gone (drive ejected)
    seen.add(abs);
    vols.push({ name: name || path.basename(abs) || abs, path: abs, kind });
  };

  if (process.platform === 'win32') {
    // Probe every drive letter in PARALLEL, each with its own short timeout. A single async stat
    // does not freeze the event loop, but a mapped-but-disconnected letter's stat can still hang
    // for the network (SMB) timeout — tens of seconds — and 26 sequential awaits would stack those
    // delays onto every folder-picker open. The bounded, parallel probe skips a dead drive fast;
    // results are folded back in A→Z order so the list stays stable.
    const { statWithTimeout } = require('./paths');
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const probed = await Promise.all(letters.map(async (L) => {
      const abs = path.resolve(`${L}:\\`);
      try { return (await statWithTimeout(abs, 1500)).isDirectory() ? abs : null; }
      catch { return null; }              // timed out, or the letter is unmapped/ejected
    }));
    for (let i = 0; i < letters.length; i++) {
      const abs = probed[i];
      if (abs && !seen.has(abs)) { seen.add(abs); vols.push({ name: `${letters[i]}:`, path: abs, kind: 'drive' }); }
    }
  } else {
    // macOS mounts external and network volumes under /Volumes; Linux uses
    // /media/<user>, /media, /mnt, and /run/media/<user> depending on the distro.
    const user = (() => { try { return os.userInfo().username; } catch { return ''; } })();
    const mountParents = process.platform === 'darwin'
      ? ['/Volumes']
      : ['/media/' + user, '/run/media/' + user, '/media', '/mnt'];
    for (const parent of mountParents) {
      let entries = [];
      try { entries = await fsSync.promises.readdir(parent, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        await addDir(path.join(parent, e.name), e.name, 'drive');
      }
    }
    // The filesystem root is NOT browsable by default. Including it would make the
    // confinement meaningless on Unix — every path is under "/". Users who legitimately
    // need /srv or /opt can enable it with "browseFilesystemRoot": true in config.json.
    try {
      const cfg = require('./config');
      if (cfg.BROWSE_FS_ROOT) await addDir('/', 'Filesystem', 'root');
    } catch {}
  }

  return vols;
};

// Is this path inside one of the browsable roots? Boundary-aware so a sibling directory
// with a shared prefix doesn't slip through. Takes the already-computed volume list so a
// single browse request enumerates volumes once, not three times.
const withinVolumes = (abs, vols) => vols.some(v => isWithin(abs, v.path));

// Resolve symlinks before the containment check. A symlink INSIDE a browsable volume can point
// outside it and still pass the textual isWithin() test, which would let directory names and
// file/byte counts be read for paths outside the browsable area (mirrors the viewer's
// resolveAllowed realpath re-check). A non-existent path keeps its resolved textual form so the
// caller's own read surfaces the ENOENT rather than a misleading 403.
//
// The VOLUME ROOTS are resolved too, and the comparison is real-target vs real-root. If only the
// target were resolved, a symlinked home or mount (common on Linux; on macOS /tmp is a firmlink to
// /private/tmp) would make the real target fall outside the textual root and wrongly 403 the
// user's own folders. Resolving both keeps the escape protection (real vs real) without that false
// rejection.
const realWithinVolumes = async (dir, vols) => {
  const real = await require('./paths').realWithin(dir, (vols || []).map(v => v.path));
  return { real: real || dir, ok: !!real };   // when out of bounds, `real` is unused (the caller 403s)
};

// Browse directories so the settings UI can offer a real folder picker. A browser
// file dialog never exposes absolute paths, so the server enumerates directories
// instead. Read-only, directories only, and it never reveals file contents.
app.get('/api/browse', authmw.requireGlobalAdmin, async (req, res) => {
  const home = os.homedir();
  try {
    let dir = req.query.path ? String(req.query.path) : home;
    if (dir.startsWith('~')) dir = path.join(home, dir.slice(1));
    dir = path.resolve(dir);

    const vols = await listVolumes();   // enumerate once per request, then reuse
    const { real, ok } = await realWithinVolumes(dir, vols);
    if (!ok) return res.status(403).json({ error: 'Outside the browsable area' });

    const entries = await fsSync.promises.readdir(real, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({ name: e.name, path: path.join(real, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    // Offer a parent only when it's still inside a browsable root, so walking up
    // stops cleanly at a volume boundary rather than erroring.
    const parent = path.dirname(real);
    const canGoUp = parent !== real && withinVolumes(parent, vols);

    res.json({
      path: real,
      home,
      parent: canGoUp ? parent : null,
      volumes: vols,
      dirs,
    });
  } catch (e) {
    const msg = e.code === 'EACCES' || e.code === 'EPERM'
      ? 'No permission to read that folder'
      : e.code === 'ENOENT' ? 'Folder not found' : e.message;
    res.status(400).json({ error: msg });
  }
});

// Recent log output. When Lokyni runs as a background service there's no console,
// so errors would otherwise be invisible unless the user knows to open
// ~/.lokyni/lokyni.log by hand. Returns the tail of the log, newest last.
app.get('/api/logs', authmw.requireGlobalAdmin, async (req, res) => {
  const lines = Math.min(parseInt(req.query.lines, 10) || 200, 2000);
  const dir = path.join(os.homedir(), '.lokyni');
  const files = [
    { name: 'stdout', file: path.join(dir, 'lokyni.log') },
    { name: 'stderr', file: path.join(dir, 'lokyni-error.log') },
  ];
  const out = {};
  for (const { name, file } of files) {
    // Prefer the in-memory buffer whenever it has anything: it always describes the
    // process that's actually running. The log files only receive output when a
    // service manager redirects it, so once --install has been run they exist but
    // sit stale while you're running from a terminal — and the viewer would show
    // that stale file instead of what's happening now.
    const buffered = require('./logbuffer').recent(lines, name);
    if (buffered.length > 0) {
      out[name] = {
        path: `${file}  (showing this session's output)`,
        size: 0,
        lines: buffered.map(l => `${new Date(l.t).toLocaleTimeString()}  ${l.line}`),
      };
      continue;
    }
    try {
      // Async fs throughout: the log viewer auto-refreshes, so a synchronous stat/open/read
      // here would briefly block the event loop on every poll. The handle is closed in a
      // finally so a read failure (truncated or locked file) can't leak a descriptor.
      const MAX_BYTES = 256 * 1024;
      const fh = await fsSync.promises.open(file, 'r');
      let stat, buf;
      try {
        stat = await fh.stat();
        // Read only the tail — a long-running service log can be large and we never want to
        // pull the whole thing into memory.
        const start = Math.max(0, stat.size - MAX_BYTES);
        buf = Buffer.alloc(Math.min(stat.size, MAX_BYTES));
        if (buf.length > 0) await fh.read(buf, 0, buf.length, start);
      } finally {
        await fh.close();
      }
      const all = buf.toString('utf-8').split('\n');
      out[name] = { path: file, size: stat.size, lines: all.slice(-lines) };
    } catch (e) {
      out[name] = {
        path: file, size: 0, lines: [],
        note: e.code === 'ENOENT'
          ? 'Nothing logged yet this session.'
          : e.message,
      };
    }
  }
  res.json(out);
});

// Security audit trail — recent entries plus the tamper-evidence verdict for the whole
// chain. Same-origin UI only (mounted alongside the other control-plane routes), never
// reachable with an API key. Read-only; reports { enabled, integrity, entries }.
app.get('/api/audit', authmw.requireGlobalAdmin, async (req, res) => {
  try {
    const audit = require('./audit');
    const cfg = require('./config');
    const limit = Math.min(parseInt(req.query.limit, 10) || 300, 1000);
    // One async read of the log for both the verdict and the entries (see audit.report).
    const { integrity, entries } = await audit.report({ limit, action: req.query.action, actor: req.query.actor });
    res.json({ enabled: cfg.auditLog !== false, integrity, entries });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Workspaces ──
// Separate document collections, each with its own index under
// data/workspaces/<id>/. Keeping unrelated corpora apart measurably improves
// retrieval: a smaller focused corpus gives cleaner BM25 medians and fewer
// plausible-but-wrong reranker candidates.
app.get('/api/workspaces', async (req, res) => {
  try {
    const wsm = require('./workspaces');
    const cfg = require('./config');
    let workspaces = await wsm.listWorkspacesAsync(cfg.DATA_DIR);
    // A member sees only the workspaces they belong to; an admin/owner sees all. So a shared instance never
    // reveals the existence of workspaces a user has no access to.
    const p = req.principal;
    if (p && p.kind === 'user' && p.globalRole !== 'admin') {
      const mine = require('./members').rolesForUser(cfg.DATA_DIR, p.userId);
      workspaces = workspaces.filter(w => mine.has(w.id));
    }
    res.json({ active: state.workspaceId, workspaces });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/workspaces', authmw.requireGlobalAdmin, authmw.requirePrimary, (req, res) => {
  try {
    const wsm = require('./workspaces');
    const cfg = require('./config');
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'A name is required' });
    const ws = wsm.createWorkspace(cfg.DATA_DIR, name);
    require('./audit').audit(req, 'workspace.create', ws && ws.id, `name="${name}"`);
    res.json(ws);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Per-workspace persona — a short instruction added to how Lokyni answers in the active
// workspace (tone, role, audience). Stored in the workspace's own settings, not the global
// config, and read fresh at answer time (see config.WORKSPACE_PERSONA). It never triggers a
// reindex, so it has its own small route rather than riding the heavy /api/config save.
const PERSONA_MAX_CHARS = 2000;
// The persona belongs to the workspace the window is viewing, which may not be the active one — each
// window can view a different workspace. Resolve it from a validated ?workspace= (an EXISTING id only,
// so a spoofed slug can't create an orphan settings file), defaulting to the active workspace. The
// persona is read fresh at answer time per turn (config.personaFor), so editing a non-active workspace's
// persona takes effect immediately without a reindex.
const personaWsId = (req) => {
  const wsm = require('./workspaces');
  const cfg = require('./config');
  const w = req && req.query && req.query.workspace;
  return (w && wsm.exists(cfg.DATA_DIR, w)) ? w : state.workspaceId;
};
// Reading a workspace's persona needs read access to THAT workspace (it can hold sensitive answer-steering
// text), not merely a login — otherwise any signed-in non-member could read any workspace's persona via
// ?workspace=. Scope it with the same doc.read capability the document routes use.
app.get('/api/workspace/persona', authmw.requireCapability('doc.read', { workspace: personaWsId }), (req, res) => {
  try {
    const wsm = require('./workspaces');
    const cfg = require('./config');
    const s = wsm.loadSettings(cfg.DATA_DIR, personaWsId(req));
    res.json({ ok: true, persona: typeof s.persona === 'string' ? s.persona : '' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.post('/api/workspace/persona', authmw.requireGlobalAdmin, authmw.requirePrimary, (req, res) => {
  try {
    const wsm = require('./workspaces');
    const cfg = require('./config');
    const wsId = personaWsId(req);
    // Trim and cap so a runaway paste can't bloat the system prompt or the settings file.
    let persona = typeof req.body?.persona === 'string' ? req.body.persona.trim() : '';
    if (persona.length > PERSONA_MAX_CHARS) persona = persona.slice(0, PERSONA_MAX_CHARS).trimEnd();
    wsm.updateSettings(cfg.DATA_DIR, wsId, (s) => {
      if (persona) s.persona = persona; else delete s.persona;
      return s;
    });
    require('./audit').audit(req, 'workspace.persona', wsId, persona ? `set (${persona.length} chars)` : 'cleared');
    res.json({ ok: true, persona });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/workspaces/rename', authmw.requireGlobalAdmin, authmw.requirePrimary, (req, res) => {
  try {
    const wsm = require('./workspaces');
    const cfg = require('./config');
    const id = String(req.body?.id || '');
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'A name is required' });
    // Only the display name changes — the id stays fixed because it's the directory
    // name, and renaming it would orphan the documents and index inside it.
    const r = wsm.renameWorkspace(cfg.DATA_DIR, id, name);
    require('./audit').audit(req, 'workspace.rename', id, `name="${name}"`);
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/workspaces/switch', async (req, res) => {
  try {
    const id = String(req.body?.id || '');
    const wsm = require('./workspaces');
    const cfg = require('./config');
    // Validate before responding so a bad id still returns an error.
    if (!wsm.isValidId(id)) return res.status(400).json({ error: 'Invalid workspace id' });
    if (!wsm.loadRegistry(cfg.DATA_DIR).some(w => w.id === id)) {
      return res.status(400).json({ error: 'No such workspace' });
    }
    // Switching the single shared active workspace is a session/UI action, not a data-plane call, so an API
    // key (which selects its workspace per request on /api/v1) must not drive it.
    const p = req.principal;
    if (p && p.kind === 'apikey') return res.status(403).json({ error: 'Switching the active workspace is not available to API keys.' });
    // A member can only switch to a workspace they belong to (admins/owner: any).
    if (p && p.kind === 'user' && p.globalRole !== 'admin' && !require('./members').rolesForUser(cfg.DATA_DIR, p.userId).has(id)) {
      return res.status(403).json({ error: 'You do not have access to this workspace' });
    }

    const initMod = require('./indexing/init');
    // On a read replica the write-path switch (which can delta-index) must not run — load the target
    // workspace read-only instead, so a replica user can still change which workspace they view.
    if (require('./cluster').isReplica()) {
      await initMod.switchReadOnly(id);
      return res.json({ ok: true, active: state.workspaceId, switching: false, replica: true });
    }
    // Await the switch before responding. This is the authoritative signal that
    // state.workspaceId now points at the new workspace and its index is loaded.
    // The earlier fire-and-forget version created a race: the client re-enabled
    // uploads/queries as soon as it got the response, but state.workspaceId was
    // still being set in the background — so an upload could land in the wrong
    // workspace's folder, and queries ran against a half-swapped index. The client
    // already shows a "switching…" badge and disables input during this request,
    // so a few seconds here is expected, not a freeze. Loading is bounded by the
    // corpus size of the target workspace, not the whole install.
    await initMod.switchWorkspace(id);
    res.json({ ok: true, active: state.workspaceId, switching: false });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/workspaces', authmw.requireGlobalAdmin, authmw.requirePrimary, async (req, res) => {
  try {
    const wsm = require('./workspaces');
    const cfg = require('./config');
    const id = String(req.query.id || '');

    // Validate BEFORE switching. Otherwise a rejected delete (the default, the last
    // workspace, or an unknown id) would still have moved the user off their
    // workspace for nothing.
    if (id === wsm.DEFAULT_ID) throw new Error('The default workspace cannot be deleted');
    const list = wsm.loadRegistry(cfg.DATA_DIR);
    if (!list.some(w => w.id === id)) throw new Error('No such workspace');
    if (list.length <= 1) throw new Error('Cannot delete the only workspace');

    // Switch away if we're deleting the active workspace, so the in-memory index
    // isn't left pointing at directories that no longer exist.
    if (id === state.workspaceId) {
      const { switchWorkspace } = require('./indexing/init');
      await switchWorkspace(wsm.DEFAULT_ID);
    }
    wsm.deleteWorkspace(cfg.DATA_DIR, id);
    // Release the deleted workspace's in-memory state so nothing keeps running against (or caching) a
    // workspace whose files are gone: stop its scheduled automations (they'd otherwise keep firing), and
    // drop its cached index bundle and merged graph. Each is best-effort — a failed eviction must not turn
    // a completed delete into an error.
    try { require('./automations').evictWorkspace(id); } catch {}
    try { require('./indexing/bundle').invalidateBundle(id); } catch {}
    try { require('./graphstore').clearGraph(id); } catch {}
    require('./audit').audit(req, 'workspace.delete', id, '');
    res.json({ ok: true, active: state.workspaceId });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Cropped figure thumbnails ──
// Serve a figure/table crop produced by visual ingest (see lib/indexing/figurestore.js),
// so the UI can show the actual figure on a cited source. The id is content-addressed and
// validated strictly (hex hash + page + index), so it can never widen into a path and read
// outside the resolved workspace's figures directory.
// Resolve the workspace whose crop is requested: an explicit ?workspace= when it exists, else the active
// workspace (where a cited source normally lives). Mirrors personaWsId and the document routes.
const figureWsId = (req) => {
  const wsm = require('./workspaces');
  const cfg = require('./config');
  const w = req && req.query && req.query.workspace;
  return (w && wsm.exists(cfg.DATA_DIR, w)) ? w : state.workspaceId;
};
// Reading a figure crop needs read access to the workspace it belongs to — not merely a login — so a signed-in
// non-member can't fetch another workspace's crops by id, matching every other document-content route. Serving
// from that workspace's own cache also lets a window viewing a NON-active workspace load its figures (the client
// appends ?workspace, exactly as it does for the viewer link). The active-workspace case is unchanged:
// cacheDirFor(DATA_DIR, activeId) is precisely what cfg.CACHE_DIR resolved to.
app.get('/api/figure/:id', authmw.requireCapability('doc.read', { workspace: figureWsId }), async (req, res) => {
  try {
    const store = require('./indexing/figurestore');
    const wsm = require('./workspaces');
    const cfg = require('./config');
    const id = String(req.params.id || '');
    if (!store.isValidId(id)) return res.status(400).end();
    const buf = await store.readCrop(wsm.cacheDirFor(cfg.DATA_DIR, figureWsId(req)), id);
    if (!buf) return res.status(404).end();
    res.setHeader('Content-Type', 'image/png');
    // Content-addressed (the id folds in the file hash and pipeline version), so immutable.
    res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
    res.end(buf);
  } catch (e) { if (!res.headersSent) res.status(500).end(); }
});

// ── Backup / restore ──
// A backup is one workspace in a single file: documents, index, and settings. That
// makes a workspace portable and gives the user a snapshot before a risky change.
// POST, not GET, so the encryption passphrase travels in the request body — never in the URL,
// where it would land in browser history and profile sync (the archive is designed to be portable,
// so a passphrase leaked into history could later decrypt a copied .lokb). A same-origin form POST
// still streams the attachment to disk without buffering the archive in memory. The cross-origin
// guard already blocks a cross-site POST here.
app.post('/api/backup', authmw.requireGlobalAdmin, authmw.requirePrimary, async (req, res) => {
  const bk  = require('./backup');
  const cfg = require('./config');
  const init = require('./indexing/init');
  const body = req.body || {};
  const id  = String(body.id || state.workspaceId);
  try {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', require('./contentdisposition').contentDisposition(bk.backupFilename(id)));
    // Serialize the snapshot through the lifecycle lock, and quiesce the active workspace while it runs, so a
    // concurrent delta can't rename an index file between the plan's hash pass and the stream pass and leave
    // the archive internally inconsistent (its own checksums would then fail on restore). A non-active
    // workspace needs only the lock — no live delta writes it, and connector syncs to it already take the
    // lock. Mirrors the restore route. Indexing resumes as soon as the snapshot finishes.
    await init.runLifecycleExclusive(async () => {
      let quiesced = false;
      if (id === state.workspaceId) { try { await init.beginQuiesce(); quiesced = true; } catch { /* best-effort */ } }
      try {
        // Streams straight to the response — the archive is never held in memory.
        await bk.writeBackup(cfg.DATA_DIR, id, res, {
          passphrase:   String(body.passphrase || ''),
          includeIndex: String(body.includeIndex) !== 'false',
        });
      } finally {
        if (quiesced) { try { init.endQuiesce(); } catch { /* best-effort */ } }
      }
    });
  } catch (e) {
    // Headers may already be sent once streaming has begun; destroying the socket is
    // the only honest signal left that the download is incomplete.
    if (res.headersSent) { res.destroy(); return; }
    res.status(400).json({ error: e.message });
  }
});

// Inspect an uploaded archive without restoring — lets the UI show what's inside
// before the user commits to overwriting anything.
app.post('/api/backup/inspect', authmw.requireGlobalAdmin, uploadBackupFile, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const bk = require('./backup');
    // Only the header is read, so this is cheap even for a multi-gigabyte archive.
    res.json(await bk.inspectBackup(req.file.path));
  } catch (e) {
    res.status(400).json({ error: e.message });
  } finally {
    cleanupUpload(req);
  }
});

// A restore DRILL: decrypt, decompress, and checksum every entry in a throwaway directory, then discard it.
// Nothing is registered or swapped, so this is safe on live data and proves the archive is restorable. Only
// one drill runs at a time (it can be disk- and CPU-heavy for a large archive), and the lifecycle lock is NOT
// taken because nothing live is mutated.
let _backupVerifying = false;
app.post('/api/backup/verify', authmw.requireGlobalAdmin, authmw.requirePrimary, uploadBackupFile, async (req, res) => {
  if (_backupVerifying) { cleanupUpload(req); return res.status(409).json({ error: 'A backup check is already running — try again when it finishes.' }); }
  _backupVerifying = true;
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const result = await require('./backup').restoreBackup(require('./config').DATA_DIR, req.file.path, {
      passphrase: String(req.body?.passphrase || ''),
      verify: true,
    });
    try { require('./audit').audit(req, 'backup.verify', result.workspaceId || '', `documents=${result.documents}`); } catch { /* audit is best-effort */ }
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  } finally {
    _backupVerifying = false;
    cleanupUpload(req);
  }
});

app.post('/api/backup/restore', authmw.requireGlobalAdmin, authmw.requirePrimary, uploadBackupFile, async (req, res) => {
  // True once we have stopped the ACTIVE workspace's watchers for the swap. Ownership is handed
  // to the post-restore reload (which restarts them); if the restore fails first, the finally
  // re-arms them so real-time indexing is never left permanently off after a failed restore.
  let quiescedActive = false;
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const bk  = require('./backup');
    const cfg = require('./config');
    // Serialize the destructive restore (quiesce + file swap) against workspace switches, rebuilds, and
    // bank consolidation via the shared index-lifecycle lock, so none of them can re-arm the watchers or
    // wipe/swap state while this workspace's files are being replaced — which could corrupt the restore.
    const result = await require('./indexing/init').runLifecycleExclusive(() => bk.restoreBackup(cfg.DATA_DIR, req.file.path, {
      passphrase: String(req.body?.passphrase || ''),
      targetId:   req.body?.targetId ? String(req.body.targetId) : null,
      overwrite:  String(req.body?.overwrite) === 'true',
      dryRun:     String(req.body?.dryRun) === 'true',
      // If the restore targets the ACTIVE workspace, quiesce it before the destructive swap:
      // stop its file watchers and wait out any in-flight re-index, so a concurrent delta can't
      // write into the directory as it is being replaced and corrupt the restored index.
      beforeSwap: async (id) => {
        if (id !== state.workspaceId) return;
        quiescedActive = true;
        // Set the switch gate, stop the watchers, THEN wait out any in-flight delta — in that order, so a
        // watched-folder change during the wait can't re-arm a debounce that fires into the swap. See
        // beginQuiesce for why the ordering matters. A failure here must NOT be swallowed: restoreBackup treats
        // a beforeSwap throw as fatal and aborts before the destructive swap (the finally re-arms the watchers),
        // because swapping the active workspace while its watchers are live could corrupt the restored index.
        await require('./indexing/init').beginQuiesce();
      },
    }));
    // A dry run only inspects the archive; only a real restore mutates a workspace.
    if (!result.dryRun) {
      require('./audit').audit(req, 'backup.restore', result.workspaceId || '', `overwrite=${String(req.body?.overwrite) === 'true'}`);
    }
    // If we just replaced the workspace that's currently loaded, reload it so the in-memory
    // index reflects what was restored. switchWorkspace restarts the watchers; on a reload
    // failure, re-arm the watcher directly so indexing isn't left off.
    if (!result.dryRun && result.workspaceId === state.workspaceId) {
      const init = require('./indexing/init');
      quiescedActive = false;   // hand watcher ownership to the reload below
      init.switchWorkspace(result.workspaceId)
        .catch(e => { console.error('Reload after restore failed:', e.message); try { init.startWatcher(); } catch { /* best-effort */ } });
    } else if (!result.dryRun && result.workspaceId) {
      // A restore into a NON-active workspace just replaced its files. Explicitly invalidate that
      // workspace's warm bundle cache so the next query against it re-reads the restored index, rather
      // than relying on the manifest mtime happening to change — matching every other index-mutation
      // path (delta, connector sync), which all invalidate the bundle explicitly. No-op if uncached.
      try { require('./indexing/bundle').invalidateBundle(result.workspaceId); } catch { /* best-effort */ }
    }
    // A restore replaced the workspace's settings.json, which carries its automations. Re-arm the live cron to
    // match the restored config, so a restored schedule fires without waiting for the next process restart (and a
    // schedule the restore removed stops firing). scheduleWorkspace destroys-then-re-arms this workspace's tasks,
    // is idempotent, and is a no-op on a read replica. Mirrors how workspace delete is wired to evictWorkspace.
    if (!result.dryRun && result.workspaceId) {
      try { require('./automations').scheduleWorkspace(result.workspaceId); } catch { /* best-effort */ }
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  } finally {
    cleanupUpload(req);
    // The restore failed after we stopped the active workspace's watchers (e.g. the swap threw
    // and rolled back). Restart them so real-time indexing resumes on the intact workspace.
    if (quiescedActive) { try { require('./indexing/init').endQuiesce(); } catch { /* best-effort */ } }
  }
});

app.get('/api/health', async (_req, res) => {
  const cfg = require('./config');
  const C = require('./constants');
  const now = Date.now();

  // Probe the active LLM provider with a short timeout. Non-fatal — a failed probe
  // just reports provider: "unreachable" rather than erroring the endpoint.
  let providerOk = null, providerDetail = '';
  let t;
  try {
    const controller = new AbortController();
    t = setTimeout(() => controller.abort(), 2500);
    if (cfg.AI_PROVIDER === 'ollama') {
      const models = await require('./llm').listOllamaModels(cfg);
      providerOk = models !== null;
      if (providerOk) providerDetail = `${models.length} models available`;
    } else {
      // OpenAI and Anthropic are both reached over the OpenAI-compatible transport; only the base and
      // key differ. Strip any trailing slash so a base ending in '/' doesn't produce a '//models' path
      // that spuriously reports the provider unreachable (matches the preflight normalization).
      const isAnthropic = cfg.AI_PROVIDER === 'anthropic';
      const base = (isAnthropic ? (cfg.ANTHROPIC_BASE || 'https://api.anthropic.com/v1/')
                                : (cfg.OPENAI_BASE || 'https://api.openai.com/v1')).replace(/\/+$/, '');
      const key = isAnthropic ? cfg.ANTHROPIC_KEY : cfg.OPENAI_KEY;
      const r = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: controller.signal,
      });
      providerOk = r.ok;
      providerDetail = r.ok ? 'reachable' : `HTTP ${r.status}`;
    }
  } catch (e) {
    providerOk = false;
    providerDetail = e.name === 'AbortError' ? 'timeout' : e.message;
  } finally {
    clearTimeout(t);   // clear on every path, so a non-abort rejection can't leave the timer to abort a later request
  }

  res.json({
    app: APP_NAME,
    status: (!!state.liveVectorStore && state.indexReady) ? 'ready' : (state.indexing ? 'indexing' : 'starting'),
    // The versioned identities that determine compatible stored artifacts. `answer` retires cached answers;
    // `indexFormat` forces an index rebuild. Both are single-sourced in lib/constants.js.
    pipeline: { answer: C.ANSWER_PIPELINE_VERSION, indexFormat: C.INDEX_FORMAT_VERSION },
    index: {
      ready:       !!state.liveVectorStore && state.indexReady,
      indexing:    state.indexing,
      documents:   state.parentMap.size,
      chunks:      state.childMap.size,
      vectors:     state.vectorCount,
      bm25Median:  state.liveBM25?.medianScore ?? null,
      // An interrupted Consolidate is resumable; report the hydrated state (health is admin-only and rare, but
      // sharing the same in-memory source keeps one answer for both endpoints).
      bankMigration: cfg.useEmbeddingBanks ? (state.bankMigration || null) : null,
      // The embedding banks' reuse state (single source), so the UI can show that a provider switch reused the
      // existing embeddings, which frozen banks a learned adapter keeps searchable, and whether a re-embed is
      // still pending. Disk-light: it reads the small registry and per-adapter sidecars, not any vectors.
      banks: cfg.useEmbeddingBanks ? require('./indexing/banks').describeBankState(cfg.CACHE_DIR, cfg) : null,
    },
    lifecycle: {
      startedAt:      state.startedAt,
      uptimeSeconds:  Math.round((now - state.startedAt) / 1000),
      lastIndexedAt:  state.lastIndexedAt,
      secondsSinceIndex: state.lastIndexedAt ? Math.round((now - state.lastIndexedAt) / 1000) : null,
      lastDelta:      state.lastDelta,
    },
    disk: (() => {
      // Free space on the volume holding the data dir, so the UI/operator can see headroom
      // before an index rebuild or backup. null when it can't be measured (older Node).
      const free = require('./disk').freeBytes(cfg.DATA_DIR || './data');
      return { freeBytes: free, freeMB: free == null ? null : Math.round(free / (1024 * 1024)) };
    })(),
    provider: {
      name:      cfg.AI_PROVIDER,
      model:     cfg.LLM_MODEL,
      embeddings: cfg.EMBEDDINGS_MODEL,
      reachable: providerOk,
      detail:    providerDetail,
    },
    features: {
      reranker:            cfg.USE_RERANKER,
      queryRewrite:        cfg.useQueryRewrite,
      conversationSummary: cfg.useConversationSummary,
    },
  });
});
// Read-only latest watchdog sweep for the Settings health panel. Admin-only: findings can name paths and
// configuration, so they are not exposed to ordinary members. Bounded and never runs a new sweep on request.
app.get('/api/watchdog', authmw.requireGlobalAdmin, (_req, res) => {
  try {
    const wd = require('./watchdog').lastFindings();
    res.json({ at: wd.at, findings: (wd.findings || []).slice(0, 100) });
  } catch { res.json({ at: 0, findings: [] }); }
});
app.use('/document', viewerRouter);
app.use('/api/documents', documentsRouter);
// Public API v1 — authenticated, workspace-scoped data plane (search, summarize,
// list). Keys gate these routes; on-demand bundle loading lets a key query any
// permitted workspace independent of the UI. See lib/routes/apiv1.js.
app.use('/api/v1', apiV1Router);
// API key management — control plane, UI-only, NOT reachable with an API key.
app.use('/api/keys', authmw.requireGlobalAdmin, apiKeysRouter);
// MCP ingestion connectors — control plane, UI-only, NOT reachable with an API key.
app.use('/api/connectors', authmw.requireGlobalAdmin, authmw.requirePrimary, connectorsRouter);
// Prompt-template library + scheduled automations — control plane, UI-only.
app.use('/api/prompts', promptsRouter);
// Read-aloud (local TTS) — a normal per-user feature (not an admin control plane), gated inside the router on the
// ttsEnabled setting; synthesis runs off-thread in a worker so it never blocks the event loop.
app.use('/api/tts', ttsRouter);
app.use('/api/stt', sttRouter);
app.use('/api/podcast', podcastRouter);
// Export an answer as a REAL Word document (.docx). The client posts the already-assembled Markdown (answer plus
// its sources) and gets back valid Office Open XML that opens cleanly in Word, Pages, Google Docs and LibreOffice
// — unlike the old "HTML with a .doc extension", which Pages refused and LibreOffice opened unreliably. Built
// locally (jszip + marked, both already bundled); nothing leaves the machine. A normal per-user feature.
app.post('/api/export/docx', async (req, res) => {
  try {
    const md = req.body && typeof req.body.markdown === 'string' ? req.body.markdown : '';
    if (!md.trim()) return res.status(400).json({ error: 'Nothing to export.' });
    const docx = require('./docx');
    const buf = await docx.markdownToDocx(md);
    res.setHeader('Content-Type', docx.DOCX_MIME);   // single-sourced with the client (CLIENT_SETTINGS.export)
    // Name the response server-side so it is self-describing even for a non-JS consumer (the browser client still
    // sets its own Save-As name). Shared helper → correct RFC 6266 encoding for any filename.
    res.setHeader('Content-Disposition', require('./contentdisposition').contentDisposition(docx.exportFileName()));
    res.send(buf);
  } catch (e) {
    console.error('docx export failed:', e && (e.message || e));   // never fail silently — surface the real cause
    res.status(500).json({ error: 'Could not build the document.' });
  }
});
app.use('/api/automations', authmw.requireGlobalAdmin, authmw.requirePrimary, automationsRouter);
// requirePrimary like every other write-capable control router: a run PERSISTS eval-runs.json / eval-history.json
// into the shared workspace cache, and add/remove question writes the workspace settings — a read replica must
// never write that shared primary state (and only the primary's in-process guard then serializes runs).
app.use('/api/eval', authmw.requireGlobalAdmin, authmw.requirePrimary, evalRouter);
app.use('/api/smtp', authmw.requireGlobalAdmin, authmw.requirePrimary, smtpRouter);
// Single sign-on (OIDC) settings — admin only, and writes go to the primary (config is shared).
app.use('/api/sso', authmw.requireGlobalAdmin, authmw.requirePrimary, require('./routes/ssoadmin'));

// MCP over the network (streamable HTTP). Every request requires an API key —
// unlike stdio (trusted local subprocess), network callers are not trusted. Lets
// remote MCP clients search this Lokyni instance. Best-effort: if the MCP SDK isn't
// installed, this mounts nothing and logs a note.
try { require('./mcp/server').mountHttp(app, '/mcp'); }
catch (e) { console.error('[mcp] could not mount HTTP endpoint:', e.message || e); }

// Config API — read and write config.json with hot-reload (no restart needed).
// CONFIG_PATH comes from lib/config so this writer targets the same file the reader
// loads, regardless of the process's cwd.
const { CONFIG_PATH } = require('./config');
const { reloadConfig } = require('./llm');

// List models installed in the local Ollama, for UI dropdowns (e.g. the vision
// model picker). Best-effort: returns { available:false } if Ollama is unreachable
// or the provider isn't Ollama, so the UI degrades gracefully rather than erroring.
// List the models available from a provider, so the Settings model fields can be a dropdown of
// what's actually installed/available rather than a name the user has to type. Defaults to the
// active provider; `?provider=` and (for Ollama) `?host=` / (for OpenAI) `?base_url=` let the
// Settings form list the OTHER provider — or a not-yet-saved endpoint — so switching the provider
// dropdown re-lists without saving first.
//
// SECURITY: the stored API key is attached ONLY when the target endpoint MATCHES the saved one.
// A caller-supplied foreign host/base_url gets NO stored secret, so a same-origin navigation like
// /api/models?provider=openai&base_url=https://evil.example can't exfiltrate the stored key (and
// an Ollama Cloud key can't leak via ?host=). A not-yet-saved override is honored only when it is a
// LOCAL/LAN address (where a self-hosted server lives) and is then probed without the stored key; a
// foreign PUBLIC override is ignored and the saved endpoint is used instead, so this route can never
// be turned into a keyless probe of an arbitrary attacker-supplied server. See pickEndpoint below.
app.get('/api/models', async (req, res) => {
  const cfg = require('./config');
  const llm = require('./llm');
  const KNOWN_PROVIDERS = new Set(PROVIDERS);   // single-sourced from the schema (MODEL_DEFAULTS keys)
  const provider = KNOWN_PROVIDERS.has(req.query.provider) ? req.query.provider : cfg.AI_PROVIDER;
  const q = (k) => (typeof req.query[k] === 'string' && req.query[k].trim()) ? req.query[k].trim() : '';
  // A not-yet-saved endpoint override is honored ONLY when it points at a local/LAN address — a legitimate
  // self-hosted target — never a foreign PUBLIC URL, so this route can't be turned into an outbound request
  // to an attacker's server; and the stored API key is sent only to the saved endpoint (below). The rule
  // lives in lib/endpointguard.js so it is unit-testable and single-sourced.
  const { pickEndpoint } = require('./endpointguard');
  // A host/base the Settings form echoes with its password masked would otherwise be probed with "***" as the
  // credential (and, not matching the saved value, with no key) — a false "no models". Treat a still-masked
  // override as "use the saved endpoint" so the picker works for a credentialed host.
  const unmasked = (v) => (require('./urlcreds').isMaskedUrl(v) ? '' : v);
  let models = null;
  try {
    if (provider === 'ollama') {
      const host = pickEndpoint(unmasked(q('host')), cfg.OLLAMA_HOST);
      const key = host === cfg.OLLAMA_HOST ? cfg.OLLAMA_KEY : '';   // never send the key to a non-saved host
      models = await llm.listOllamaModels({ OLLAMA_HOST: host, OLLAMA_KEY: key });
    } else if (provider === 'openai') {
      const base = pickEndpoint(unmasked(q('base_url')), cfg.OPENAI_BASE);
      const key = base === cfg.OPENAI_BASE ? cfg.OPENAI_KEY : '';   // never send the key to a non-saved base URL
      models = await llm.listOpenAIModels({ OPENAI_KEY: key, OPENAI_BASE: base });
    } else if (provider === 'anthropic') {
      // Anthropic's models endpoint is reached through the same OpenAI-compatible client; only the key
      // and base differ. Its base is a fixed public endpoint, so a query override is ignored (not local,
      // not equal) and the stored key is sent only to the saved base — the same no-leak rule as OpenAI.
      const base = pickEndpoint(q('base_url'), cfg.ANTHROPIC_BASE);
      const key = base === cfg.ANTHROPIC_BASE ? cfg.ANTHROPIC_KEY : '';
      models = await llm.listOpenAIModels({ OPENAI_KEY: key, OPENAI_BASE: base });
    }
  } catch { models = null; }
  if (!models) return res.json({ available: false, provider, models: [] });
  let out = models.slice().sort();
  // `?kind=embeddings` narrows the list to embedding-capable models, so the Settings "Embeddings
  // model" picker can't offer a chat model (which cannot embed and would trigger a destructive,
  // stalling rebuild). The picker keeps a "Custom" entry and the current value, so an embedding
  // model the heuristic doesn't recognize is still reachable.
  if (req.query.kind === 'embeddings') {
    const { isEmbeddingModel } = require('./modelname');
    out = out.filter(isEmbeddingModel);
  }
  res.json({ available: true, provider, models: out });
});

// Hardware-aware model suggestions for the Settings panel. Best-effort: inspects the
// host's memory (and GPU when detectable) and returns curated chat/embedding models that
// fit comfortably, marking which are already installed. Local-model focused, since that's
// what the machine's memory actually constrains.
app.get('/api/model-recommendations', async (_req, res) => {
  try {
    const cfg = require('./config');
    const { recommend, detectSystem } = require('./modelrecommend');
    const rec = recommend(await detectSystem());
    let installed = [];
    if (cfg.AI_PROVIDER === 'ollama') {
      try { installed = (await require('./llm').listOllamaModels(cfg)) || []; } catch { /* offline — omit */ }
    }
    res.json({ ...rec, provider: cfg.AI_PROVIDER, installed });
  } catch (e) {
    res.status(500).json({ error: 'Could not compute recommendations' });
  }
});

app.get('/api/config', (req, res) => {
  try {
    const cfg = require('./config');
    const raw = cfg.readRawConfig();
    // Mask any password embedded in a URL setting before it is sent to the browser (host/user stay visible so
    // the admin can still recognize and edit the endpoint). A save that returns the still-masked value keeps
    // the stored one. maskUrlCredentials is a no-op on a credential-free URL, so the common case is unchanged.
    const maskUrl = require('./urlcreds').maskUrlCredentials;
    // A non-admin member may read this (the composer's active-tools indicator reads the feature toggles), but
    // host/infrastructure details are admin-only: the indexed source folders are host FILESYSTEM paths, and the
    // model host/base URLs reveal the deployment's internal topology. Redact those for non-admins. Secrets are
    // never sent to anyone (only *Set booleans). The POST that writes config is already requireGlobalAdmin.
    const isAdmin = !!(req.principal && (req.principal.kind === 'owner' || (req.principal.kind === 'user' && req.principal.globalRole === 'admin')));
    const payload = {
      provider:          cfg.AI_PROVIDER,
      // RAW (what was saved), not the resolved default — so the form shows blank when the user hasn't picked a
      // chat model, and a plain Save can't pin the current default and freeze it against future default changes.
      model:             cfg.LLM_MODEL_RAW,
      embeddingsProvider: cfg.EMBEDDINGS_PROVIDER,
      // RAW (what was saved), not the resolved default — so the form shows blank when the user hasn't picked a
      // model, and a plain Save can't pin the current default and freeze it against future default changes.
      embeddingsModel:   cfg.EMBEDDINGS_MODEL_RAW,
      urlCapture:        cfg.urlCapture,
      ollamaHost:        cfg.OLLAMA_HOST,
      ollamaKeepAlive:   cfg.OLLAMA_KEEP_ALIVE,
      llmTimeoutMs:      cfg.LLM_TIMEOUT_MS,
      // Secrets are never sent to the browser. The UI shows a placeholder when one
      // is set and only transmits a value when the user actually types a new one —
      // so a key can't leak through the DOM or devtools, and saving unrelated
      // settings can't silently wipe it.
      ollamaApiKeySet:   !!raw.ollamaApiKey,
      openaiApiKeySet:   !!raw.openaiApiKey,
      openaiBaseUrl:     cfg.OPENAI_BASE   || '',
      // Separate embed endpoint credentials (openai-compatible embed); the RAW configured base (blank when it
      // falls back to the chat base), never the resolved fallback. The key is never sent, only whether one is set.
      embeddingsApiKeySet: !!raw.embeddingsApiKey,
      embeddingsBaseUrl:   cfg.EMBEDDINGS_BASE_URL || '',
      anthropicApiKeySet: !!raw.anthropicApiKey,
      anthropicBaseUrl:  cfg.ANTHROPIC_BASE || '',
      temperature:     cfg.TEMPERATURE,
      maxTokens:       cfg.MAX_TOKENS,
      maxHistory:      cfg.maxHistory,
      passageSize:     cfg.PASSAGE_SIZE,
      useQueryRewrite:        cfg.useQueryRewrite,
      useConversationSummary: cfg.useConversationSummary,
      useReranker:            cfg.USE_RERANKER,
      useColbertRerank:       cfg.USE_COLBERT_RERANK,
      useGraphRag:            cfg.useGraphRag,
      useContextualRetrieval: cfg.useContextualRetrieval,
      useEmbeddingBanks:      cfg.useEmbeddingBanks,
      useIntentClassifier:    cfg.useIntentClassifier,
      useMetaConversation:    cfg.useMetaConversation,
      useTopicSwitchAck:      cfg.useTopicSwitchAck,
      useClarifyingQuestions: cfg.useClarifyingQuestions,
      usePartialMatchTier:    cfg.usePartialMatchTier,
      useCorrectiveRetrieval: cfg.useCorrectiveRetrieval,
      useCrossLingual:        cfg.useCrossLingual,
      useDocumentSummaries:   cfg.useDocumentSummaries,
      useAutoSynthesis:       cfg.useAutoSynthesis,
      useRagFusion:           cfg.useRagFusion,
      useHyde:                cfg.useHyde,
      useEntityGraph:         cfg.useEntityGraph,
      useAdaptiveRetrieval:   cfg.useAdaptiveRetrieval,
      useSemanticCache:       cfg.useSemanticCache,
      useSuggestedQuestions:  cfg.useSuggestedQuestions,
      showAnswerConfidence:   cfg.showAnswerConfidence,
      abstainOnWeakEvidence:  cfg.abstainOnWeakEvidence,
      useSemanticEntropy:     cfg.useSemanticEntropy,
      semanticEntropySamples: cfg.semanticEntropySamples,
      auditLog:               cfg.auditLog,
      allowSignups:           cfg.allowSignups,
      allowNetworkAccess:     cfg.ALLOW_NETWORK_ACCESS,
      // Whether a sign-in is configured (an account exists or SSO is on) — the UI needs this to require setting up
      // an account BEFORE the user can turn on network access, so the instance is never exposed without auth.
      authConfigured:         (() => { try { return require('./users').count(cfg.DATA_DIR) > 0; } catch { return false; } })() || cfg.ssoEnabled(),
      // The API-key scopes the picker should render — single-sourced from authz so the UI can never offer a
      // scope the server won't honor, nor miss one that's added. See authz.apiKeyScopeList.
      apiKeyScopes:           require('./authz').apiKeyScopeList(),
      // The PERSISTED setting, not the effective DEBUG (which also reflects a transient `debug` command-line
      // launch). Returning the effective value would show the toggle checked after a CLI-debug run and then
      // silently persist debug:true on the next unrelated Settings save. The checkbox reflects config.json.
      debug:                  !!require('./config').readRawConfig().debug,
      useOcr:                 cfg.USE_OCR,
      ocrEngine:              cfg.OCR_ENGINE,
      ocrVisionModel:         cfg.OCR_VISION_MODEL,
      ocrMaxPages:            cfg.OCR_MAX_PAGES,
      ocrWorkers:             cfg.OCR_WORKERS,
      ocrLanguages:           cfg.OCR_LANGUAGES,
      ocrLanguageOptions:     OCR_LANGUAGES,
      visionDescribe:         cfg.VISION_DESCRIBE,
      visionModel:            cfg.VISION_MODEL,
      useVisualIngest:        cfg.useVisualIngest,
      visualIngestCropFigures: cfg.visualIngestCropFigures,
      // So the UI can say what "Automatic" resolves to on this machine. Single source of truth in ocr.js,
      // which factors both cores and available memory, so the number shown matches what actually runs.
      cpuCount:               os.cpus()?.length || 0,
      ocrWorkersAuto:         require('./ocr').recommendedWorkers(),
      useWebSearch:           cfg.useWebSearch,
      webAutoSuggest:         cfg.webAutoSuggest,
      useWebResultRanking:    cfg.useWebResultRanking,
      webProxyUrl:            cfg.WEB_PROXY_URL,
      webProxyRotate:         cfg.WEB_PROXY_ROTATE,
      webProxyRetries:        cfg.WEB_PROXY_RETRIES,
      webProxyStrict:         cfg.WEB_PROXY_STRICT,
      ttsEnabled:             cfg.ttsEnabled,
      ttsVoice:               cfg.ttsVoice,
      ttsSpeed:               cfg.ttsSpeed,
      ttsLanguage:            cfg.ttsLanguage,
      ttsAllowOnlineVoices:   cfg.ttsAllowOnlineVoices,
      ttsSystemVoices:        cfg.ttsSystemVoices,
      podcastVoiceA:          cfg.podcastVoiceA,
      podcastVoiceB:          cfg.podcastVoiceB,
      sttEnabled:             cfg.sttEnabled,
      sttLanguage:            cfg.sttLanguage,
      micDeviceId:            cfg.micDeviceId,
      micLabel:               cfg.micLabel,
      useAudioIngest:         cfg.useAudioIngest,
      audioMaxMinutes:        cfg.audioMaxMinutes,
      // Return the RAW stored form, not the resolved SOURCE_PATHS: resolved drops
      // disabled folders and expands ~, and the client saves whatever it receives
      // back — so returning resolved would silently delete disabled entries and
      // rewrite the user's paths.
      // Indexed folders are per-workspace, and each window manages the workspace it is viewing — so
      // resolve them for a validated ?workspace= (an existing id only), defaulting to the active one.
      // Falls back to the legacy global setting for the default workspace so existing installs keep
      // their folders. Every other field here is genuinely global and stays as-is.
      sourcePaths:            (() => {
        const wsm = require('./workspaces');
        // Honor ?workspace= only for a workspace the caller may READ — these are host filesystem paths, so a
        // signed-in non-member must not learn another workspace's indexed folders. Fall back to the active one.
        const reqWs = req.query && req.query.workspace;
        const mayRead = reqWs && wsm.exists(cfg.DATA_DIR, reqWs)
          && require('./authz').can(req.principal, 'doc.read', { workspaceId: reqWs });
        const fWs = mayRead ? reqWs : state.workspaceId;
        const wsRaw = wsm.loadSettings(cfg.DATA_DIR, fWs).sourcePaths;
        const src = Array.isArray(wsRaw) ? wsRaw
          : (fWs === wsm.DEFAULT_ID && Array.isArray(raw.sourcePaths) ? raw.sourcePaths : []);
        return src.map(s => typeof s === 'string'
          ? { path: s, recursive: false, maxDepth: 3, enabled: true }
          : { path: s.path, recursive: !!s.recursive, maxDepth: s.maxDepth || 3, enabled: s.enabled !== false });
      })(),
      sourceMaxFiles:         cfg.SOURCE_MAX_FILES,
      sourceMaxFileBytes:     cfg.SOURCE_MAX_FILE_BYTES,
      intentMaxTokens:        cfg.intentMaxTokens,
      intentModel:            cfg.intentModel,
      rewriteMaxTokens:       cfg.rewriteMaxTokens,
      summaryMaxTokens:       cfg.summaryMaxTokens,
      historySummaryThresholdChars: cfg.historySummaryThresholdChars,
      historyProtectLastN:    cfg.historyProtectLastN,
      rewriteModel:           cfg.rewriteModel,
      numCtx:                cfg.numCtx,
      // The resolved effective window (auto-sized per model when numCtx is 0), so the UI can show what
      // "automatic" actually picked rather than a bare 0.
      numCtxEffective:       (() => { try { return require('./llm').getNumCtx(); } catch { return null; } })(),
      embeddingContextTokens: cfg.EMBEDDING_CONTEXT_TOKENS,
    };
    // Mask any password embedded in a credential-bearing URL before it reaches the browser — driven by the ONE
    // config.MASKCRED_PATHS list, so a new such field can't be added without its echo being masked too (host and
    // user stay visible for editing; a credential-free URL is unchanged). A save that returns the still-masked
    // value keeps the stored one (see the POST handler).
    for (const k of cfg.MASKCRED_PATHS) if (typeof payload[k] === 'string') payload[k] = maskUrl(payload[k]);
    if (!isAdmin) {
      // Host filesystem paths and infrastructure endpoints are not for non-admin members: clear the source
      // folders and every host/URL field (the same MASKCRED list, so none is forgotten) — they reveal the
      // deployment's internal topology and may carry credentials.
      payload.sourcePaths = [];
      for (const k of cfg.MASKCRED_PATHS) if (k in payload) payload[k] = '';
    }
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/config', authmw.requireGlobalAdmin, authmw.requirePrimary, async (req, res) => {
  try {
    const allowed = CONFIG_WRITABLE_KEYS;
    // Keys and lists may legitimately be set to empty — that's how a user clears an
    // API key or removes every indexed folder. Everything else keeps the
    // skip-empty behavior so a blank field doesn't wipe an existing value.
    // Values that may legitimately be set to empty (clearing a model override or
    // removing every indexed folder). Secrets are deliberately NOT here: an empty
    // secret means "unchanged", never "delete". Clearing a key is an explicit action
    // (see SECRET_CLEAR below), so saving an unrelated setting can't wipe it — the
    // failure mode where a password vanishes because a form field was blank.
    const CLEARABLE = new Set(CLEARABLE_KEYS);
    // Secrets: only touched when the client sends a real value, or the explicit
    // sentinel meaning "remove this".
    const SECRETS = new Set(SECRET_KEYS);
    const SECRET_CLEAR = '__CLEAR__';
    // URL fields that may embed a credential: the Settings echo masks the password, so a value that comes back
    // still carrying the mask was not re-typed and must keep its stored (sealed) value, not overwrite it with
    // "***". A freshly typed URL (no mask) is stored and sealed on write.
    const MASKCRED = new Set(require('./config').MASKCRED_PATHS);
    // Numeric knobs, each with a sane [min, max]. A same-origin client (a UI bug, or a
    // hand-crafted request) could otherwise persist a string or an out-of-range number that
    // flows into the LLM/retrieval path and degrades every answer, caught only as a boot-time
    // warning. Coerce to a number and clamp into range; ignore a value that isn't a number at
    // all so the prior good value stands. Non-integer floats (temperature) are preserved.
    // The ranges are the single source of truth in config.js (NUMERIC_RANGES) — the SAME table the
    // config reader clamps with — so the write-side and read-side clamps can never drift apart.
    const NUMERIC = {};
    const INTEGER = new Set();
    for (const [k, r] of Object.entries(require('./config').NUMERIC_RANGES)) {
      NUMERIC[k] = [r.min, r.max];
      if (r.int) INTEGER.add(k);
    }
    // Boolean toggles. Coerce to a real boolean so the string "false" (which is truthy, and
    // which readers testing `!== false` / `?? true` would treat as ON) can never silently keep
    // a feature enabled. The real UI already sends booleans; this is defense-in-depth.
    const BOOLEAN = new Set(BOOLEAN_KEYS);
    const existing = require('./config').readRawConfig();
    const before = JSON.parse(JSON.stringify(existing));   // pre-change snapshot, for the audit diff
    for (const key of allowed) {
      const val = req.body[key];
      if (val === undefined) continue;
      if (SECRETS.has(key)) {
        if (val === SECRET_CLEAR) { delete existing[key]; continue; }  // explicit removal
        if (val === '') continue;                                     // untouched — keep
        if (typeof val !== 'string') continue;                        // a secret is always a string; ignore a malformed non-string (it would reach the provider as "Bearer [object Object]")
        existing[key] = val;                                          // a new key was typed
        continue;
      }
      // A credential-bearing URL returned with a masked password: restore each still-masked password from the
      // stored value (matched by scheme+user+host, so editing or reordering OTHER entries in a list does not
      // require re-typing every password). If a masked entry can't be matched (its host/user was changed too),
      // keep the stored value for the whole field rather than persist a "***". A fully re-typed value has no
      // mask and falls through to normal storage (then writeConfigAtomic seals it if it carries a credential).
      if (MASKCRED.has(key) && typeof val === 'string' && require('./urlcreds').isMaskedUrl(val)) {
        const stored = require('./secretbox').readSecret(existing[key], key, require('./config').SECRET_KEY_SRC);
        const merged = require('./urlcreds').fillMaskedPasswords(val, typeof stored === 'string' ? stored : '');
        if (require('./urlcreds').isMaskedUrl(merged)) continue;   // an unresolved masked entry → keep the stored value
        existing[key] = merged;
        continue;
      }
      if (val === '' && !CLEARABLE.has(key)) continue;
      if (val === '' && CLEARABLE.has(key)) { delete existing[key]; continue; }
      // OCR languages are a bounded, validated list of catalog codes (English is always included by the
      // engine and is not stored here). Accept an array or a '+'-joined string from a custom client.
      if (key === 'ocrLanguages') { existing[key] = normalizeOcrLanguages(val); continue; }
      if (NUMERIC[key]) {
        const n = Number(val);
        if (!Number.isFinite(n)) continue;   // not a number — keep the prior value
        const [lo, hi] = NUMERIC[key];
        const clamped = Math.min(hi, Math.max(lo, n));
        existing[key] = INTEGER.has(key) ? Math.round(clamped) : clamped;
        continue;
      }
      if (BOOLEAN.has(key)) { existing[key] = (val === true || val === 'true'); continue; }
      // Enum-guarded keys: reject an unknown value rather than persist it into the provider path.
      if (key === 'provider') { if (PROVIDERS.includes(val)) existing[key] = val; continue; }
      // The embedding provider is independent of the chat provider but must be one that can actually
      // embed (Anthropic cannot), so it is guarded against the single-source list in config.
      if (key === 'embeddingsProvider') { if (require('./config').PROVIDERS_WITH_EMBEDDINGS.includes(val)) existing[key] = val; continue; }
      // Never PIN the chat provider's default model, for the same reason as embeddingsModel below: the form
      // pre-fills the resolved model, so a plain Save would freeze the current default into config and defeat a
      // later default change. Store ONLY a genuinely custom id; the default (or blank) leaves it tracking.
      if (key === 'model') {
        const prov = String(req.body.provider || existing.provider || require('./config').AI_PROVIDER || '').toLowerCase();
        const def = require('./settings-schema').MODEL_DEFAULTS[prov] || '';
        if (!String(val).trim() || String(val).trim() === def) delete existing[key]; else existing[key] = String(val).trim();
        continue;
      }
      // Never PIN the provider's default model. The form pre-fills this field with the resolved model, so a plain
      // Save would freeze the current default into config and defeat a later default change (e.g. a lighter model
      // on constrained hardware). Store ONLY a genuinely custom id; the default (or blank) leaves it tracking.
      if (key === 'embeddingsModel') {
        const prov = String(req.body.embeddingsProvider || existing.embeddingsProvider || require('./config').EMBEDDINGS_PROVIDER || '').toLowerCase();
        const def = require('./settings-schema').EMBEDDINGS_DEFAULTS[prov] || '';
        if (!String(val).trim() || String(val).trim() === def) delete existing[key]; else existing[key] = String(val).trim();
        continue;
      }
      if (key === 'urlCapture') { const v = String(val || '').toLowerCase(); if (require('./settings-schema').SETTINGS.urlCapture.values.includes(v)) existing[key] = v; continue; }
      if (key === 'ocrEngine') { if (require('./settings-schema').SETTINGS.ocrEngine.values.includes(val)) existing[key] = val; continue; }
      // Voice settings must be one of the curated ids (see lib/voice/tts.js VOICES) — reject anything else.
      if (key === 'ttsVoice' || key === 'podcastVoiceA' || key === 'podcastVoiceB') { if (require('./voice/tts').isValidVoice(val)) existing[key] = val; continue; }
      // The voice-input language must be one of the curated codes (see lib/voice/stt.js LANGUAGES).
      if (key === 'sttLanguage') { if (require('./voice/stt').isValidLanguage(val)) existing[key] = val; continue; }
      // Read-aloud language: 'auto' or a code from the shared detector catalog. Reject anything else so a
      // malformed request cannot force an unsupported language into playback.
      if (key === 'ttsLanguage') { if (require('./langdetect').isValidReadAloudLanguage(val)) existing[key] = String(val).toLowerCase(); continue; }
      // Saved system-voice choices: the shared validator owns the shape and bounds. A non-array is ignored so a
      // malformed request cannot silently erase a working preference list.
      if (key === 'ttsSystemVoices') { if (Array.isArray(val)) existing[key] = require('./voice/system-voices').normalize(val); continue; }
      // The remembered microphone id/label are opaque browser-supplied strings — store them bounded (and only
      // as strings), so a malformed request can't persist something huge or non-string.
      if (key === 'micDeviceId' || key === 'micLabel') { existing[key] = (typeof val === 'string' ? val : '').slice(0, 256); continue; }
      // Everything else is a free-text string — coerce so a malformed request can't persist an
      // object/array that would flow into the provider layer as a truthy non-string.
      existing[key] = typeof val === 'string' ? val : String(val);
    }
    // Tidy empty OpenAI fields when running on Ollama, but never discard a stored
    // key — switching providers back and forth shouldn't cost the user their key.
    if (existing.provider === 'ollama') {
      if (existing.openaiApiKey === '')  delete existing.openaiApiKey;
      if (existing.openaiBaseUrl === '') delete existing.openaiBaseUrl;
    }
    // Indexed folders belong to a workspace, so they're written there rather than into the shared
    // config.json. Each window manages the workspace it is viewing, so resolve the target from a
    // validated ?workspace= (an existing id only, so a spoofed slug can't write an orphan settings
    // file), defaulting to the active workspace. A non-active target is reconciled below so the folder
    // change takes effect on that workspace's next open, without reindexing the active one.
    let foldersWsId = null;
    if (req.body.sourcePaths !== undefined) {
      const wsm = require('./workspaces');
      const cfgNow = require('./config');
      foldersWsId = (req.query.workspace && wsm.exists(cfgNow.DATA_DIR, req.query.workspace))
        ? req.query.workspace : state.workspaceId;
      const wsSettings = wsm.loadSettings(cfgNow.DATA_DIR, foldersWsId);
      wsSettings.sourcePaths = Array.isArray(req.body.sourcePaths) ? req.body.sourcePaths : [];
      wsm.saveSettings(cfgNow.DATA_DIR, foldersWsId, wsSettings);
      delete existing.sourcePaths;   // never persist it globally again
    }

    // Write atomically (temp + rename) so an interrupted save can't leave a truncated
    // config.json — which, now that a broken config refuses to start, would block the next
    // launch. Shared with the SMTP route via config.writeConfigAtomic.
    // Never let network access be turned ON without a sign-in configured — otherwise anyone on the network could
    // read the user's documents and reach the same-origin control plane. (The startup gate in config.js enforces
    // the same rule for a hand-edited config.json.) Reject BEFORE writing, so the unsafe setting never persists.
    if (existing.allowNetworkAccess === true) {
      const hasAuth = (() => { try { return require('./users').count(require('./config').DATA_DIR) > 0; } catch { return false; } })() || require('./config').ssoEnabled();
      if (!hasAuth) {
        return res.status(400).json({ error: 'Create an account first (so sign-in is required) before allowing access from other devices — otherwise anyone on your network could read your documents.' });
      }
    }
    // Keep the embedding identity explicit when there is an embedded corpus to protect. A save that omits it
    // (the first-run connect sheet, or a hand-written API client) must not let an unset embeddingsProvider be
    // re-derived from a new chat provider — that would change the bank identity and strand the existing
    // vectors. With no index yet there is nothing to preserve, so a fresh install may follow the newly chosen
    // chat provider and embed with it. A value explicitly present in the payload always wins.
    const prevCfgForEmbeddings = require('./config');
    const banksMod = require('./indexing/banks');
    if (banksMod.hasEmbeddedCorpus(prevCfgForEmbeddings.CACHE_DIR)) {
      // Only fill a key the save did not mention at all. An explicit empty embeddingsModel means "use the
      // provider's default", and the user's choice must win; an explicit provider is always a valid one.
      if (existing.embeddingsProvider == null) existing.embeddingsProvider = prevCfgForEmbeddings.EMBEDDINGS_PROVIDER;
      if (existing.embeddingsModel === undefined) existing.embeddingsModel = prevCfgForEmbeddings.EMBEDDINGS_MODEL;
    }
    require('./config').writeConfigAtomic(existing);
    // Record WHICH settings actually changed (by diffing the pre/post config), never the
    // values — a secret must never reach the log, and the Settings form resubmits every
    // field, so logging submitted keys would be noise.
    const changed = allowed.filter(k => JSON.stringify(before[k]) !== JSON.stringify(existing[k]));
    require('./audit').audit(req, 'config.update', '', changed.length ? changed.join(', ') : 'no changes');
    // Capture the RESOLVED embedding identity (provider + model + endpoint) BEFORE the hot-reload. The audit
    // diff above uses the RAW config, where a model left at its provider default is absent (undefined), so a
    // raw before/after comparison would read a never-set default becoming explicit as a change. The banks
    // fingerprint is built from resolved values and treats a bare name and its `:latest` tag as equal; one
    // comparison therefore covers a model change, an embedding-provider change, and an endpoint change with
    // no second rule to drift.
    const prevEmbeddings = banksMod.currentMeta(require('./config'));
    // Hot-reload — rebuild LLM clients without restarting
    const newCfg = reloadConfig();
    // Enabling or disabling banks takes effect live; refresh the in-memory migration marker once now, so
    // /status and the health view stay disk-free and still explain a migration left over from a previous run.
    try { require('./indexing/init').hydrateBankMigration(); } catch { /* best-effort */ }
    // Turning read-aloud on — or switching a running instance back from a forced non-English language to
    // Automatic/English — starts the one-time local model preparation now, in the background. A forced
    // non-English language never needs the English model. Saving any other setting while already local does not
    // re-trigger it.
    const beforeTtsLocal = before.ttsLanguage === 'auto' || before.ttsLanguage === 'en';
    const nowTtsLocal = newCfg.ttsLanguage === 'auto' || newCfg.ttsLanguage === 'en';
    if (newCfg.ttsEnabled === true && nowTtsLocal && (before.ttsEnabled !== true || !beforeTtsLocal)) {
      warmTtsModel();
    }
    // A changed OCR language set applies to the next pool. If no index run is active, release the cached
    // workers now so the next scan builds with the new languages; during a run, the run's own teardown
    // releases them and the following run uses the new set.
    if (!state.indexing
        && JSON.stringify(normalizeOcrLanguages(before.ocrLanguages)) !== JSON.stringify(newCfg.OCR_LANGUAGES)) {
      try { await require('./ocr').releaseTesseract(); } catch { /* best-effort */ }
    }

    // Knowledge graph turned ON (off/absent → on): start its FIRST build in the background right away, so the
    // user never has to ALSO press "Build". It is incremental and fire-and-forget (only new/changed documents
    // are extracted, bounded per run), self-heals on failure, and from then on every index delta keeps it
    // current — so once enabled the graph stays live without any manual step. No-op if a build is already running.
    try {
      if (before.useGraphRag !== true && existing.useGraphRag === true) startGraphBuild();
    } catch { /* best-effort — enabling the graph must never fail the settings save */ }

    // If the embedding identity TRULY changed with embedding banks OFF, the live vector store still holds
    // vectors from the OLD identity. The reindex below runs in the background and only wipes the store after
    // several awaits, so a query arriving first would embed with the NEW identity and score against the OLD
    // vectors — a hard error if the dimensions differ (caught, returns empty) but SILENTLY WRONG scores if
    // they happen to match. Mark the index not-ready synchronously now so such a query gets the accurate
    // "still building" response during the rebuild window rather than wrong results; the reindex restores
    // readiness when the store is rebuilt against the new identity.
    let clearedReadyHere = false;
    const embeddingIdentityChanged = prevEmbeddings.fp !== banksMod.currentMeta(newCfg).fp;
    if (embeddingIdentityChanged && !newCfg.useEmbeddingBanks) {
      state.indexReady = false;
      clearedReadyHere = true;
    }

    // Will this save force a full reindex of the EXISTING corpus? A content-affecting toggle (OCR, document
    // summaries, contextual retrieval, visual ingest, an OCR cap/engine/model, the embedding window) or an
    // embedding-model change re-reads every document. Ask the SAME check the rebuild path uses (no drift), so the
    // response can tell the user their change is being applied in the background rather than closing silently.
    let willReindex = embeddingIdentityChanged && !newCfg.useEmbeddingBanks;
    try { if (!willReindex && await require('./indexing/init').contentRebuildPending()) willReindex = true; } catch { /* best-effort hint */ }

    // Always re-point the watchers and run a delta update after a settings save.
    // Diffing the stored config against what the client sent doesn't work: the API
    // returns resolved paths (~ expanded, defaults filled in) and the client saves
    // that resolved form back, so a remove-then-re-add produces an identical array
    // and the change is invisible. runDeltaUpdate already compares files on disk
    // against the manifest and is a no-op when nothing actually changed, so running
    // it unconditionally is both correct and cheap.
    require('./indexing/init').refreshSources()
      .then(() => {
        // Defense in depth: the model-change guard above flips indexReady OFF synchronously so a query in
        // the rebuild window gets an honest "still building" rather than wrong scores. The reindex is what
        // turns it back ON — but a delta that finds nothing to do never sets indexReady (by design). So if
        // the guard ever fired on a change that needed no rebuild, readiness would stay stuck OFF until a
        // restart (the index sitting forever at "building…" with nothing actually running). Restore it only
        // when THIS save cleared it AND the live store survived, so we never re-arm readiness that is false
        // for an unrelated reason. A genuinely failed rebuild leaves liveVectorStore null → stays OFF.
        if (clearedReadyHere && state.liveVectorStore && !state.indexReady) state.indexReady = true;
      })
      .catch(e => console.error('Reindex after settings change failed:', e.message));

    // A folder change for a NON-active workspace can't ride the active-only reindex above, so reconcile
    // that workspace's on-disk index instead — its next open re-derives against the new folder set.
    if (foldersWsId && foldersWsId !== state.workspaceId) {
      try { require('./indexing/bundle').reconcileWorkspaceDocsChange(foldersWsId); }
      catch (e) { console.error('Reconcile after non-active folder change failed:', e.message); }
    }

    res.json({ ok: true, provider: newCfg.AI_PROVIDER, model: newCfg.LLM_MODEL, reindexing: willReindex });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Copy vendor JS from node_modules into public/vendor/ on startup.
const syncVendorFiles = () => {
  const vendorDir = path.join(__dirname, 'public', 'vendor');

  // In a packaged desktop app the app tree is read-only and the vendor files are already
  // staged, so skip the sync rather than attempt a write that would warn (EROFS/EACCES) on
  // every launch. Only skip when the directory exists but isn't writable; a missing directory
  // (a fresh checkout) still proceeds so it gets created.
  try {
    if (fsSync.existsSync(vendorDir)) fsSync.accessSync(vendorDir, fsSync.constants.W_OK);
  } catch {
    if (DEBUG) console.log('  📦 Vendor: read-only install — using the bundled assets as-is');
    return;
  }

  const copyIfNeeded = (srcPkg, srcCandidates, destFile) => {
    const dest = path.join(vendorDir, destFile);
    const destExists = fsSync.existsSync(dest);
    // Resolve the source package. It is only needed to REFRESH the vendored copy, which is committed and ships
    // in the package/Docker image. In production (and Docker), the source may be a devDependency that is not
    // installed — that is normal, not an error: skip silently when the vendored file is already present, and
    // only warn when it is genuinely missing (a real broken build).
    let pkgRoot;
    try { pkgRoot = path.dirname(require.resolve(srcPkg)); }
    catch {
      if (!destExists) console.warn(`⚠️  Vendor: ${destFile} is missing and ${srcPkg} is not installed — run: npm install`);
      return;
    }
    try {
      for (let i = 0; i < 8; i++) {
        if (fsSync.existsSync(path.join(pkgRoot, 'package.json'))) break;
        pkgRoot = path.dirname(pkgRoot);
      }
      const src = (Array.isArray(srcCandidates) ? srcCandidates : [srcCandidates])
        .map(c => path.join(pkgRoot, c))
        .find(p => fsSync.existsSync(p));
      if (!src) { if (!destExists) console.warn(`⚠️  Vendor: no file found for ${destFile}`); return; }
      fsSync.mkdirSync(path.dirname(dest), { recursive: true });
      const srcMtime  = fsSync.statSync(src).mtimeMs;
      const destMtime = destExists ? fsSync.statSync(dest).mtimeMs : 0;
      if (srcMtime > destMtime) {
        fsSync.copyFileSync(src, dest);
        if (DEBUG) console.log(`  📦 Vendor: copied ${destFile}`);
      }
    } catch (e) {
      if (!destExists) console.warn(`⚠️  Vendor: could not copy ${destFile} (${e.message})`);
    }
  };

  copyIfNeeded('marked', ['lib/marked.umd.js'], 'marked/marked.umd.js');
};

// Anything under /api that no router claimed is a missing endpoint, not a missing page. Answer it in
// the same JSON shape every other API response uses, so a client (or the browser's fetch wrapper) gets
// a parseable error instead of Express's HTML error page. Only /api is affected; ordinary page URLs keep
// Express's default 404.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Terminal error handler — the last middleware, so it catches errors thrown before any route (most notably
// the body parser rejecting a malformed or oversized JSON body). Without it those fall through to Express's
// default handler, which returns an HTML page and, when NODE_ENV is not production (the default for this
// local app), leaks the error message — breaking the "every endpoint returns JSON" contract and the
// deliberately-generic 500. Returns a compact JSON error with the right status instead.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON in request body' });
  if (err && (err.type === 'entity.too.large' || err.status === 413)) return res.status(413).json({ error: 'Request body too large' });
  if (err && (err.status === 400 || err.statusCode === 400)) return res.status(400).json({ error: 'Bad request' });
  console.error('[server] unhandled request error:', err && err.message ? err.message : err);
  res.status(500).json({ error: 'Request failed' });   // generic — never leak internals to the caller
});

// Prepare the local English voice model in the background. Shared by startup and the Settings save that enables
// read-aloud, so both paths log the same way. Best-effort and non-blocking — the feature still works on demand if
// a warm fails, and a forced non-English language never needs this model.
const warmTtsModel = () => {
  try {
    const tts = require('./voice/tts');
    if (!tts.isModelDownloaded()) console.log('🔊 Read-aloud on — downloading the voice model (~90 MB, one time)…');
    tts.warm()
      .then((ok) => console.log(ok ? '🔊 Read-aloud voice model ready.' : '⚠️  Read-aloud voice model could not be prepared — it will be tried again on first use.'))
      .catch(() => {});
  } catch { /* voice module not loadable — the feature stays on demand */ }
};

const startWebServer = () => {
  syncVendorFiles();
  // Session pruning DELETES files from the shared data dir, so only the primary does it — a replica pruning
  // would mutate shared state (matching the restore-recovery block below, which is also primary-only).
  if (!require('./cluster').isReplica()) {
    const { pruneOldSessions } = require('./sessions');
    pruneOldSessions();
    // And prune daily, not only at startup — a service that runs for weeks would otherwise keep expired
    // session files until its next restart. Unref'd so the timer never keeps the process alive; best-effort.
    try {
      const t = setInterval(() => { pruneOldSessions().catch(() => {}); }, 24 * 60 * 60 * 1000);
      if (t.unref) t.unref();
    } catch (_) { /* best-effort */ }
  }
  const server = http.createServer(app);
  initSocket(server);

  // A port collision is otherwise a silent failure when running as a background
  // service — report it clearly and exit rather than leaving a dead process.
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n✖ Port ${PORT} is already in use.`);
      console.error(`  Another program — or a second copy of ${APP_NAME} — is listening there.`);
      console.error(`  Set a different port in config.json:   { "port": 7888 }`);
      console.error(`  Or find what's using it:               lsof -i :${PORT}     (macOS/Linux)`);
      console.error(`                                         netstat -ano | findstr :${PORT}   (Windows)\n`);
    } else if (err.code === 'EACCES') {
      console.error(`\n✖ Not permitted to listen on port ${PORT}.`);
      console.error(`  Ports below 1024 require elevated privileges — pick a higher port in config.json.\n`);
    } else {
      console.error(`\n✖ Web server error: ${err.message}\n`);
    }
    process.exit(1);
  });

  // Bind to BIND_ADDRESS (loopback by default) so the server isn't exposed to the whole
  // network unless explicitly configured. The startup URL shows localhost when bound to a
  // loopback address, else the configured bind address.
  const shownHost = isBindLoopback() ? 'localhost' : BIND_ADDRESS;
  server.listen(PORT, BIND_ADDRESS, () => console.log(`${APP_NAME} running on http://${shownHost}:${PORT}`));
  if (USE_RERANKER) preloadReranker();
  if (require('./config').USE_COLBERT_RERANK) require('./retrieval/colbert').preloadColbert();
  // Pre-warm the bundled local embedder when it's the active embedding provider, so its one-time ~110 MB model
  // download happens now (with visible progress) instead of stalling the first index build. On completion, run a
  // delta so any documents deferred while the model was still downloading get embedded and become searchable.
  // Best-effort and non-blocking — indexing also warms it on demand, and a different provider skips this entirely.
  try {
    if (require('./config').EMBEDDINGS_PROVIDER === 'local') {
      const localembed = require('./retrieval/localembed');
      localembed.preload()
        .then((ok) => { if (ok) { try { require('./indexing/delta').reindexNow().catch(() => {}); } catch {} } })
        .catch(() => {});
    }
  } catch { /* embedder not loadable — indexing will warm it on demand */ }
  // Pre-warm the voice models in the background when their feature is on, so the one-time ~75–90 MB download
  // happens now (and any failure is logged) rather than surfacing as a slow first read-aloud / transcription.
  // Best-effort and non-blocking — the features still work on demand if a warm fails.
  try {
    const liveCfg = require('./config');
    // The bundled voice model is English-only. If the user has forced a non-English read-aloud language, every
    // answer is voiced by the operating system, so skip the one-time model download entirely.
    if (liveCfg.ttsEnabled === true && (liveCfg.ttsLanguage === 'auto' || liveCfg.ttsLanguage === 'en')) {
      warmTtsModel();
    }
    if (liveCfg.sttEnabled === true) {
      try {
        const stt = require('./voice/stt');
        if (!stt.isModelDownloaded()) console.log('🎙️  Voice input on — downloading the transcription model (~75 MB, one time)…');
        stt.warm().then((ok) => console.log(ok ? '🎙️  Voice-input model ready.' : '⚠️  Voice-input model could not be prepared — it will be tried again on first use.')).catch(() => {});
      } catch {}
    }
  } catch { /* voice modules not loadable — features just stay off */ }

  // URL-ingestion browser lifecycle: sweep any leftover per-run profile dirs from a
  // previous crash, and force-close live browsers + sweep on shutdown so nothing
  // lingers in data/puppeteer_cache.
  // Sweep any leftover per-run profile dirs from a previous crash on startup. The
  // shutdown-time browser teardown is handled centrally by lib/shutdown.js (which
  // registers closeAllBrowsers + sweepStaleProfiles), so no signal handlers here —
  // having them in two places risked one calling process.exit() before the other's
  // async cleanup finished.
  try {
    require('./urlfetch').sweepStaleProfiles().catch(() => {});
  } catch { /* urlfetch not loadable (puppeteer missing) — URL ingestion just won't work */ }

  // Recover from a crash DURING a restore swap BEFORE the index loads: put back any workspace dir orphaned as
  // "<name>.old-<tag>" (else the workspace reads empty and the next delta purges the index — data loss), and
  // clear abandoned ".restoring-*" staging dirs. Primary only: restores only run on the primary, and a replica
  // must not rename shared-data-dir files. Runs here (end of startWebServer, before initIndex) while nothing is
  // serving, so there is no in-flight restore to race.
  try {
    if (!require('./cluster').isReplica()) {
      const n = require('./backup').recoverInterruptedRestores(require('./config').DATA_DIR);
      if (n) console.log(`↩️  Recovered ${n} workspace director${n === 1 ? 'y' : 'ies'} from an interrupted restore.`);
    }
  } catch { /* best-effort — never block boot */ }

  // Sweep orphaned backup temp artifacts (crashed create staging + uploads under DATA_DIR/tmp) left by a
  // previous hard crash — age-gated so an in-flight backup (including on another cluster node) is never touched.
  try { require('./backup').sweepStaleTemp(require('./config').DATA_DIR); } catch { /* best-effort */ }

  // Seal any still-plaintext reversible secrets in config.json (an install that predates at-rest sealing, or a
  // hand-edited config). Primary only — a replica must not write the shared config — and best-effort: a no-op
  // when there is no master key or nothing is plaintext, and it never blocks or fails boot.
  try {
    if (!require('./cluster').isReplica() && require('./config').migrateSecrets()) {
      console.log('🔒 Sealed previously-plaintext secrets in config.json (encrypted at rest).');
    }
  } catch { /* best-effort — never block boot */ }

  return server;
};

module.exports = { app, startWebServer, CONFIG_WRITABLE_KEYS, isLoopbackHostHeader };
