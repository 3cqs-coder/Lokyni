'use strict';

// ── Safe browser storage ──
// Every localStorage access is wrapped: a bare read or write can THROW (Safari Private Browsing,
// "block all cookies", a hardened privacy browser — squarely this app's audience), and much of
// this module runs at load before any handler is wired, so one unguarded throw would abort the
// rest of chat.js and leave the whole UI dead rather than merely unable to remember a preference.
// These helpers fail soft: a read returns the fallback, a write is a no-op.
const lsGet = (key, fallback = null) => { try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch (e) { return fallback; } };
const lsSet = (key, val) => { try { localStorage.setItem(key, val); } catch (e) { /* storage unavailable */ } };

// Socket payloads arrive as either a pre-parsed object or a JSON string. Parse defensively so a malformed
// emit (or a future server-side change that sends a non-JSON string) can only no-op the one listener that
// reads it, rather than throwing out of the handler and leaving the UI in a half-updated state. Returns the
// parsed object, or `fallback` ({} by default) when the payload is missing or not valid JSON. Shared by every
// handler so the string-or-object parse can't drift — some wrapped it in try/catch, some didn't.
const parsePayload = (payload, fallback = {}) => {
  if (payload == null) return fallback;
  if (typeof payload !== 'string') return payload;
  try { return JSON.parse(payload); } catch (e) { return fallback; }
};

// Turn-control event names, handed off by the server (lib/turncontrol.js) through a meta tag so the
// browser and the server cannot drift apart. The literals below are only a fallback for a page served
// without that hand-off; a unit test asserts they are byte-for-byte what the server module exports.
const TURN_PROTOCOL = (() => {
  let supplied = {};
  try {
    const el = document.querySelector('meta[name="lokyni-turn-protocol"]');
    supplied = (el && JSON.parse(el.getAttribute('content') || '{}')) || {};
  } catch { /* a malformed hand-off falls back to the shared literals */ }
  return {
    stop:     supplied.stop     || 'chat_stop',
    stopped:  supplied.stopped  || 'chat_stopped',
    end:      supplied.end      || 'chat_end',
    progress: supplied.progress || 'synth_progress',
  };
})();

// Settings schema projection handed off by the server (lib/settings-schema.js): defaults, numeric input
// bounds, and the provider model maps. Keeping it here means this file never carries a second copy of a
// default or a range — the server config reader and the page consume the same table.
const SETTINGS_META = (() => {
  try {
    const el = document.querySelector('meta[name="lokyni-settings"]');
    return (el && JSON.parse(el.getAttribute('content') || '{}')) || {};
  } catch { return {}; }
})();
const SETTING_DEFAULTS = (SETTINGS_META && SETTINGS_META.defaults) || {};
const SETTING_RANGES   = (SETTINGS_META && SETTINGS_META.numeric) || {};
const PROVIDER_MODEL_DEFAULTS = (SETTINGS_META && SETTINGS_META.modelDefaults) || {};
const settingDefault = (key) => SETTING_DEFAULTS[key];
// Apply the schema's (deliberately narrower) form bounds to every numeric input that opts in via
// data-setting. The server clamp uses the wider min/max; both live in the same schema entry.
function applySettingRanges() {
  for (const el of document.querySelectorAll('[data-setting]')) {
    const r = SETTING_RANGES[el.dataset.setting];
    if (!r) continue;
    if (r.uiMin !== undefined) el.min = String(r.uiMin); else if (r.min !== undefined) el.min = String(r.min);
    if (r.uiMax !== undefined) el.max = String(r.uiMax); else if (r.max !== undefined) el.max = String(r.max);
    if (r.step !== undefined) el.step = String(r.step);
  }
}
applySettingRanges();

// Display host for a web source (the "www."-stripped hostname), used by the citation preview, the source
// pill, and the web reader. Returns '' on a missing/invalid URL so a bad source never throws mid-render.
const webHost = (src) => { try { return new URL((src && (src.url || src.viewerLink)) || '').hostname.replace(/^www\./, ''); } catch { return ''; } };

// ── CSRF (defense-in-depth for the control plane) ──
// The browser UI is cookie-authenticated, so every state-changing /api request carries a
// double-submit token (an HMAC of the session, fetched from /auth/me). A cross-site page can
// neither read it (it is not a cookie) nor forge it (no server secret), so it is a second barrier
// behind the loopback bind, the origin guard, and the SameSite cookie. We attach it at ONE choke
// point — a thin wrapper over fetch — so every call site (and any future one) is covered without
// each remembering the header. API-key and single-user (implicit-owner) callers have no session and
// the server skips the check, so an empty token is harmless; safe methods (GET/HEAD) carry none.
let csrfToken = '';
const _nativeFetch = window.fetch.bind(window);
// Coalesce concurrent refreshes onto a single /auth/me probe: when several mutations 403 at once
// (right after a sign-in/out or a cluster secret change) they would each fetch the token separately
// — harmless but a stampede. One shared in-flight promise is simpler and hits the server once.
let _csrfRefresh = null;
async function refreshCsrf() {
  if (_csrfRefresh) return _csrfRefresh;
  _csrfRefresh = (async () => {
    try {
      const s = await _nativeFetch('/auth/me', { headers: { accept: 'application/json' } }).then((r) => r.json());
      csrfToken = (s && s.csrfToken) || '';
    } catch (e) { /* leave as-is; a missing token just fails the next mutation closed, which we retry once below */ }
    return csrfToken;
  })();
  try { return await _csrfRefresh; } finally { _csrfRefresh = null; }
}
const CSRF_UNSAFE = /^(POST|PUT|PATCH|DELETE)$/i;
const _isSameOrigin = (url) => {
  if (!url) return true;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return true;   // relative URL → same origin
  try { return new URL(url, location.href).origin === location.origin; } catch { return false; }
};
window.fetch = function (input, init) {
  init = init || {};
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  const method = (init.method || (typeof input !== 'string' && input && input.method) || 'GET').toUpperCase();
  if (!CSRF_UNSAFE.test(method) || !_isSameOrigin(url)) return _nativeFetch(input, init);
  const headers = new Headers(init.headers || (typeof input !== 'string' && input && input.headers) || {});
  if (!headers.has('x-csrf-token')) headers.set('x-csrf-token', csrfToken);
  const opts = Object.assign({}, init, { headers });
  const send = () => _nativeFetch(input, opts);
  return send().then(async (res) => {
    // The token can be stale right after a sign-in/out or a cluster secret change; on a CSRF 403,
    // refresh once and retry so a genuine user action isn't lost to a transient token mismatch.
    if (res.status !== 403) return res;
    let isCsrf = false;
    try { isCsrf = /csrf/i.test(((await res.clone().json()) || {}).error || ''); } catch (e) { /* non-JSON 403 → not ours */ }
    if (!isCsrf) return res;
    await refreshCsrf();
    headers.set('x-csrf-token', csrfToken);
    return _nativeFetch(input, Object.assign({}, init, { headers }));
  });
};
// Warm the token at load so the first mutation carries it (the 403-retry above is the safety net
// for a race or a later token change, not the normal path).
refreshCsrf();

// Fetch helpers so network calls don't re-inline the verb/headers/stringify/parse each time.
// getJSON resolves to the parsed JSON body; sendJSON posts a JSON body and resolves to the Response, so
// callers keep their own res.ok / status handling (which legitimately varies per call site).
const getJSON = (url) => fetch(url).then((r) => r.json());
const sendJSON = (url, body, method = 'POST', opts = {}) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...opts });

// ── Marked config ──
marked.setOptions({ breaks: true, gfm: true });

// ── Theme ──
// Three themes, cycled by the header button. The preference is per-browser
// (localStorage) rather than server config, since it's a personal display choice
// and someone may reasonably want different themes on different machines.
// Each theme's icon shows what you'll switch TO, so the button says what it does.
const THEMES = [
  { name: 'dark',  cls: '',      iconRef: '#ic-theme',          label: 'Switch to light' },
  { name: 'light', cls: 'light', iconRef: '#ic-theme-contrast', label: 'Switch to sepia' },
  { name: 'sepia', cls: 'sepia', iconRef: '#ic-theme-moon',     label: 'Switch to dark'  },
];

const themeToggle = document.getElementById('theme-toggle');

function applyTheme(name) {
  const theme = THEMES.find(t => t.name === name) || THEMES[0];
  // Apply on BOTH <html> and <body>: the pre-paint bootstrap in the page <head> sets the
  // class on <html> to avoid a flash of the default theme, so switching must keep both in
  // sync — otherwise an old class left on <html> would win. Removing every theme class first
  // ensures switching can never leave two applied at once.
  const els = [document.documentElement, document.body];
  THEMES.forEach(t => { if (t.cls) els.forEach(el => el.classList.remove(t.cls)); });
  if (theme.cls) els.forEach(el => el.classList.add(theme.cls));
  lsSet('theme', theme.name);   // best-effort; see the storage helpers at the top of the file
  // Keep the PWA/installed-window chrome (title bar, status bar) matching the CHOSEN theme rather
  // than the OS color scheme. The page ships two media-scoped theme-color metas for the very first
  // paint; once JS runs we replace them with a single meta set to the active theme's background, so
  // a light-OS user running the dark app no longer gets a mismatched window chrome.
  try {
    const bg = getComputedStyle(document.body).getPropertyValue('--bg').trim();
    if (bg) {
      document.querySelectorAll('meta[name="theme-color"][media]').forEach(m => m.remove());
      let m = document.querySelector('meta[name="theme-color"]:not([media])');
      if (!m) { m = document.createElement('meta'); m.setAttribute('name', 'theme-color'); document.head.appendChild(m); }
      m.setAttribute('content', bg);
    }
  } catch (_) { /* cosmetic only */ }
  if (themeToggle) {
    // Swap the SVG icon's symbol reference per theme (sun / contrast / moon), keeping the per-theme indicator
    // consistent with the rest of the chrome's line icons. The <svg class="ico"><use> lives in header.ejs.
    const use = themeToggle.querySelector('use');
    if (use) use.setAttribute('href', theme.iconRef);
    themeToggle.title = theme.label;
    themeToggle.setAttribute('aria-label', theme.label);   // the icon has no text, so name it for screen readers
  }
  return theme.name;
}

// An unrecognized stored value (an older build, or hand-edited) falls back to dark
// rather than leaving the UI unstyled.
let currentTheme = lsGet('theme');
if (!THEMES.some(t => t.name === currentTheme)) currentTheme = 'dark';
applyTheme(currentTheme);

themeToggle?.addEventListener('click', () => {
  const i = THEMES.findIndex(t => t.name === currentTheme);
  currentTheme = THEMES[(i + 1) % THEMES.length].name;
  applyTheme(currentTheme);
});

// ── Reading text size (accessibility) ──
// Scales the surfaces people READ — chat answers/questions, the document viewer, rendered Markdown — via the
// --read-scale CSS variable (see app.css). Persisted in localStorage and restored before first paint by the
// bootstrap in the page <head>, so larger text never flashes at the default size. Clamped to a safe range so a
// bad stored value can never make the UI unusable. Browser zoom (Ctrl/Cmd +/-) still scales everything on top.
const READ_SCALE_MIN = 0.85, READ_SCALE_MAX = 1.75;
const READ_SCALE_OPTIONS = [
  { value: 0.9,  label: 'Small' },
  { value: 1,    label: 'Default' },
  { value: 1.15, label: 'Large' },
  { value: 1.3,  label: 'Larger' },
  { value: 1.5,  label: 'Largest' },
];
const clampReadScale = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.min(READ_SCALE_MAX, Math.max(READ_SCALE_MIN, n)) : 1; };
function applyReadScale(scale) {
  const s = clampReadScale(scale);
  try { document.documentElement.style.setProperty('--read-scale', String(s)); } catch { /* inline style set best-effort */ }
  lsSet('readScale', String(s));   // best-effort; see the storage helpers at the top of the file
  return s;
}
let currentReadScale = clampReadScale(lsGet('readScale') || 1);
applyReadScale(currentReadScale);
// The Settings "Text size" control. It is a per-device preference (localStorage, like the theme), so it applies
// live on change and is NOT part of the server-config Save. Reflect the current value by the nearest preset.
const readScaleSel = document.getElementById('cfg-read-scale');
if (readScaleSel) {
  // The presets live only in READ_SCALE_OPTIONS — the menu is built from it rather than repeating the
  // same five options in the template, so a new size cannot exist in one place and not the other.
  readScaleSel.innerHTML = READ_SCALE_OPTIONS
    .map(o => `<option value="${o.value}">${o.label}</option>`)
    .join('');
  const nearest = READ_SCALE_OPTIONS.reduce((a, b) => Math.abs(b.value - currentReadScale) < Math.abs(a.value - currentReadScale) ? b : a);
  readScaleSel.value = String(nearest.value);
  readScaleSel.addEventListener('change', () => { currentReadScale = applyReadScale(readScaleSel.value); });
}

// Desktop app: route external links to the system browser. The whole UI is a single webview
// pointed at the local server, so following an outbound link in place would navigate away from the
// app with no way back, and a target="_blank" link does nothing in the desktop webview. The shell's
// navigation handler opens any non-local URL in the system browser, but only sees TOP-LEVEL
// navigations — so a click on an external link is turned into one here. In a normal browser or the
// installed PWA the marker is absent and this block is inert, so ordinary new-tab behavior stands.
const IS_DESKTOP_APP = !!document.querySelector('meta[name="lokyni-desktop"]');

// Warn before leaving while the server is doing interruptible work (indexing documents or building the
// knowledge graph), so a reload or tab-close doesn't silently cut it off. Tracked from the live socket events,
// so it reflects a build started anywhere (this tab, another tab, boot). The DESKTOP app has its own native
// quit confirmation (src-tauri), so this web guard is skipped there to avoid a double prompt. Modern browsers
// show their own generic "Leave site?" text — we only control WHETHER it appears, which is the point.
let busyIndexing = false, busyGraphBuild = false;
if (!IS_DESKTOP_APP) {
  window.addEventListener('beforeunload', (e) => {
    if (busyIndexing || busyGraphBuild) { e.preventDefault(); e.returnValue = ''; return ''; }
  });
}
if (IS_DESKTOP_APP) {
  document.addEventListener('click', (e) => {
    // Defer to the app's own link handling. A cited source (a web result or a document) is an
    // <a> whose click handler calls preventDefault to open the in-app viewer, so if this click
    // was already handled, leave it alone — otherwise the source would open in the in-app reader
    // AND the system browser at once. Only a genuinely external link with no in-app handler (a
    // link inside a rendered answer, or the "Open original" escape hatch) is left to reach here.
    // This runs in the bubble phase, after the element's own handlers, so that check is reliable.
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    let u;
    try { u = new URL(a.href, location.href); } catch { return; }
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== location.origin) {
      e.preventDefault();
      location.href = u.href;   // the shell opens it externally and cancels the in-webview navigation
    }
  });
}

// ── Panel toggle ──
const docPanel   = document.getElementById('doc-panel');
const docsToggle = document.getElementById('docs-toggle');
let panelOpen = false;
// At <=640px the panel is a full-width overlay drawer, not the desktop sidebar. In that mode it
// must behave like a dialog: trap Tab, close on Escape, and return focus to the toggle. Gated on
// the media query so the desktop persistent sidebar is untouched. The breakpoint is defined ONCE here
// and reused by every doc-panel media query below; it must match the `@media (max-width: 640px)` phone
// layout rules in app.css (a drift-guard test asserts the two stay equal).
const DOC_PANEL_BREAKPOINT_PX = 640;
const DOC_PANEL_OVERLAY_MQ = `(max-width: ${DOC_PANEL_BREAKPOINT_PX}px)`;
const docPanelIsOverlay = () => { try { return window.matchMedia(DOC_PANEL_OVERLAY_MQ).matches; } catch (e) { return false; } };
let docPanelLastFocus = null;
const docPanelFocusables = () => [...docPanel.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter(n => n.offsetParent !== null);
const onDocPanelKeydown = (e) => {
  if (!panelOpen || !docPanelIsOverlay()) return;
  // Defer to any dialog opened over the drawer — a header modal (Settings/Logs/Inbox, which cover
  // only #main) or a dynamic confirm/prompt overlay (.del-confirm). Escape and Tab there belong to
  // that dialog, so one Escape must not also collapse the drawer behind it.
  if (document.querySelector('.modal-overlay:not(.hidden), .del-confirm')) return;
  // While a filter is typed, Escape clears it instead of closing the whole drawer. A second Escape
  // (with the field already empty) falls through and closes the panel.
  if (e.key === 'Escape' && e.target && e.target.id === 'doc-search-input' && (docFilterQuery || e.target.value)) {
    e.preventDefault(); e.stopPropagation();
    clearDocFilter({ focus: true });
    return;
  }
  if (e.key === 'Escape') { e.preventDefault(); closeDocPanel(); return; }
  if (e.key !== 'Tab') return;
  const items = docPanelFocusables();
  if (items.length === 0) { e.preventDefault(); return; }
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
};
function openDocPanel() {
  panelOpen = true;
  docPanel.classList.remove('collapsed');
  docsToggle.classList.add('active');
  docsToggle.setAttribute('aria-expanded', 'true');
  if (docPanelIsOverlay()) {
    docPanelLastFocus = document.activeElement;
    docPanel.setAttribute('role', 'dialog');
    docPanel.setAttribute('aria-modal', 'true');
    docPanel.setAttribute('aria-labelledby', 'doc-panel-title');   // name the dialog for screen readers
    document.addEventListener('keydown', onDocPanelKeydown, true);
    try { (docPanelFocusables()[0] || docPanel).focus(); } catch (e) { /* focus is best-effort */ }
  }
  loadDocuments();
  // The folders list, persona, and workspace label are per-workspace, so refresh them
  // each time the panel opens rather than once at startup.
  loadSourceFolders();
  loadPersona();
  updateDocPanelWorkspace();
}
function closeDocPanel() {
  const wasOverlay = docPanelIsOverlay();
  panelOpen = false;
  docPanel.classList.add('collapsed');
  docsToggle.classList.remove('active');
  docsToggle.setAttribute('aria-expanded', 'false');
  docPanel.removeAttribute('role');
  docPanel.removeAttribute('aria-modal');
  docPanel.removeAttribute('aria-labelledby');
  document.removeEventListener('keydown', onDocPanelKeydown, true);
  if (wasOverlay) {
    try { ((docPanelLastFocus && docPanelLastFocus.focus) ? docPanelLastFocus : docsToggle).focus(); } catch (e) { /* best-effort */ }
  }
  docPanelLastFocus = null;
}
// Reconcile the drawer's dialog wiring if the viewport crosses the overlay breakpoint WHILE the
// panel is open — so a panel opened at desktop width and then narrowed to mobile becomes a proper
// dialog (focus trap, Escape, accessible name), and one widened back to a sidebar sheds the stale
// dialog ARIA. Without this the wiring is only decided at open time.
function syncDocPanelOverlayState() {
  if (!panelOpen) return;
  const isOverlay = docPanelIsOverlay();
  const hasDialog = docPanel.getAttribute('role') === 'dialog';
  if (isOverlay && !hasDialog) {
    docPanelLastFocus = document.activeElement;
    docPanel.setAttribute('role', 'dialog');
    docPanel.setAttribute('aria-modal', 'true');
    docPanel.setAttribute('aria-labelledby', 'doc-panel-title');
    document.addEventListener('keydown', onDocPanelKeydown, true);
  } else if (!isOverlay && hasDialog) {
    docPanel.removeAttribute('role');
    docPanel.removeAttribute('aria-modal');
    docPanel.removeAttribute('aria-labelledby');
    document.removeEventListener('keydown', onDocPanelKeydown, true);
    docPanelLastFocus = null;
  }
}
try { window.matchMedia(DOC_PANEL_OVERLAY_MQ).addEventListener('change', syncDocPanelOverlayState); }
catch (e) { /* older engines without matchMedia change events: wiring stays as decided at open time */ }

if (docsToggle) {
  docsToggle.addEventListener('click', () => { panelOpen ? closeDocPanel() : openDocPanel(); });
}

// Doc-panel close button (shown on mobile, where the panel is a full-screen overlay).
// Reuses the same close path as the header toggle.
const docPanelClose = document.getElementById('doc-panel-close');
if (docPanelClose && docsToggle) {
  docPanelClose.addEventListener('click', () => closeDocPanel());
}

// ── Socket ──
const socket = io('/', {
  transports: ['websocket', 'polling'],
  path: '/ws',
  reconnection: true,
  reconnectionDelay: 3000
});

// ── Session persistence ──
// A stable per-browser session id lets the server restore the conversation after
// a refresh or reconnect. Stored in localStorage (this is the user's own app, not
// a sandboxed artifact, so localStorage is available).
const _newSessionId = () => 'sess-' + (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const _SESSION_LOCK_STALE_MS = 6000;   // a lock older than this means no tab is actively holding that id
// Resolve this tab's session id. The id lives in sessionStorage, so a REFRESH keeps this tab's own
// conversation, but two tabs never share one id — which previously let a second tab overwrite the first's
// saved history (last-writer-wins) on the shared session file. A brand-new tab continues the most recent
// conversation (from localStorage) for the common reopen case, UNLESS another tab is actively holding that
// id right now (a fresh heartbeat lock), in which case it forks to a new id so the two never collide.
function getSessionId() {
  try {
    const existing = sessionStorage.getItem('lokyni_session');
    if (existing) return existing;   // this tab already has one (e.g. a refresh) — keep it
    const last = localStorage.getItem('lokyni_session');
    let lock = null;
    try { lock = JSON.parse(localStorage.getItem('lokyni_session_lock') || 'null'); } catch { /* ignore */ }
    const held = lock && lock.id === last && typeof lock.ts === 'number' && (Date.now() - lock.ts) < _SESSION_LOCK_STALE_MS;
    const id = (last && !held) ? last : _newSessionId();   // reuse the last id only if no live tab holds it
    sessionStorage.setItem('lokyni_session', id);
    return id;
  } catch {
    // storage blocked (e.g. a private window) — fall back to a volatile in-memory id (no persistence)
    return _newSessionId();
  }
}
const SESSION_ID = getSessionId();
// Heartbeat: mark this session id as actively held so a second tab opened on the same last-used id forks
// instead of clobbering it. Best-effort; if storage is blocked it degrades to the prior single-id behavior.
try {
  const _beat = () => { try { localStorage.setItem('lokyni_session', SESSION_ID); localStorage.setItem('lokyni_session_lock', JSON.stringify({ id: SESSION_ID, ts: Date.now() })); } catch { /* ignore */ } };
  _beat();
  const _hb = setInterval(_beat, 3000);
  if (_hb.unref) _hb.unref();   // never keep a (non-browser) host process alive; harmless in the browser
} catch { /* storage unavailable — accept the prior behavior */ }
let sessionRestoreDone = false;

// A Stop in progress, and whether this turn has already been finalized by a terminal event. Both
// belong to the per-turn lifecycle above so a reset/disconnect clears them with everything else.
let turnStopping = false;
let turnFinalized = false;
let _stopRevertTimer = null;

// Clear all in-flight streaming + buffered-meta state. Every path that abandons or ends a
// turn goes through this — a new conversation, an error, a web-offer interruption, and a
// disconnect. The disconnect case matters: without it, a network blip mid-stream left the
// old bubble marked "streaming" and its state non-null, so the NEXT answer streamed into
// the stale bubble instead of a fresh one.
function resetStreaming() {
  clearTurnWatchdog();
  clearStopRequest();
  turnFinalized = false;
  if (currentBubble) currentBubble.classList.remove('streaming');
  currentBubble = null; messageBuffer = ''; isStreaming = false; turnActive = false;
  pendingSources = null; pendingSourceStats = null; pendingTrace = null; pendingOutcomeId = null; pendingFaith = null; pendingConf = null; pendingFinal = null; pendingPodcast = false; _turnStage = ''; _turnStallNoticed = '';
  refreshSendButton();
}

// ── Per-turn watchdog ──────────────────────────────────────────────────────────
// A turn ends client-side ONLY via the server's terminal event (chat_end / chat_stopped) or a
// disconnect. If the socket stays CONNECTED but the server goes silent mid-turn (a slow provider
// request, a slow first token, or a long research phase between progress lines), the composer used
// to be force-reset after two minutes — which threw away the turn AND any tokens still in flight.
// The watchdog now never ends a turn. It surfaces that the wait is unusually long and keeps the turn
// live, so a late token still lands in the existing bubble and the server's terminal event finalizes
// it. Recovery is explicit: the Send button is a Stop control for the whole turn. The timer is pushed
// forward by every liveness signal (a token, a progress update), and the notice fires once per
// stretch of silence so a screen reader is not re-narrated every window.
const TURN_SILENCE_MS = 120000;   // 2 min of complete mid-turn silence → tell the user it is slow
const TURN_SLOW_NOTICE = 'Still working — this is taking longer than usual.';
let _turnWatchdog = null;
let _turnSilenceNoticed = false;
// The stage the server last announced for this turn (retrieval, reranking, writing, web, research). Used to
// say WHERE a long wait is stuck instead of a generic "still working".
let _turnStage = '';
let _turnStallNoticed = '';
function clearTurnWatchdog() { if (_turnWatchdog) { clearTimeout(_turnWatchdog); _turnWatchdog = null; } _turnSilenceNoticed = false; }
function _restartTurnWatchdog() {
  if (_turnWatchdog) clearTimeout(_turnWatchdog);
  _turnWatchdog = setTimeout(() => {
    _turnWatchdog = null;
    if (!turnActive) return;   // the turn ended in the meantime
    if (!_turnSilenceNoticed) {
      _turnSilenceNoticed = true;
      const notice = _turnStage ? `Still working — ${String(_turnStage).replace(/…$/, '')} is taking longer than usual.` : TURN_SLOW_NOTICE;
      if (!isStreaming) setThinkingStatus(notice);
      announce(notice);
    }
    _restartTurnWatchdog();   // keep watching; later silence stays quiet until a new token arrives
  }, TURN_SILENCE_MS);
}
function armTurnWatchdog() {
  _turnSilenceNoticed = false;   // a liveness signal just arrived — this is a new silence stretch
  if (!turnActive) { clearTurnWatchdog(); return; }
  _restartTurnWatchdog();
}

// On (re)connect, ask the server to restore any persisted conversation.
socket.on('connect', () => {
  socket.emit('restore_session', { sessionId: SESSION_ID });
});

// Rebuild the chat thread from restored history.
socket.on('session_restored', (data) => {
  sessionRestoreDone = true;
  if (!data || !data.found || !Array.isArray(data.history) || data.history.length === 0) return;
  // Only rebuild if the chat is currently empty (avoid duplicating on live reconnect).
  if (chatBox.querySelector('.msg-row')) return;
  hideEmptyState();
  restoredAnswers = [];
  for (const msg of data.history) {
    if (msg.role === 'user') {
      appendUserMessage(msg.content);
    } else if (msg.role === 'assistant') {
      const row = document.createElement('div'); row.className = 'msg-row bot';
      const bubble = document.createElement('div'); bubble.className = 'bubble';
      bubble.innerHTML = marked.parse(msg.content || '');
      row.appendChild(bubble); chatBox.appendChild(row);
      // Replay the citations that belonged to this answer. Without this a restored
      // conversation shows the text but loses every source pill, which makes past
      // answers look unsourced and breaks the click-through to the document.
      const sources = Array.isArray(msg.sources) ? msg.sources : [];
      if (sources.length) appendSources(sources, msg.sourceStats);
      const language = normalizeLanguageCode(msg.language);
      // Mark the row as a finalized answer and carry its language in the DOM, so the same sweep that
      // reattaches Read aloud to live answers also covers a restored conversation. The visible answer text is
      // the read-aloud source, so no duplicate copy of it is kept in memory.
      row.dataset.answer = '1';
      row.dataset.answerLang = language;
      restoredAnswers.push({ botRow: row, text: msg.content || '', sources, language });
    }
  }
  attachRestoredControls();   // give each restored answer the same per-answer actions a live one has
  scrollToBottom();
});

// ── DOM refs ──
const chatBox    = document.getElementById('chat-box');
const inputForm  = document.getElementById('input-form');
const msgInput   = document.getElementById('message-input');
const sendBtn    = document.getElementById('send-button');
const statusBadge = document.getElementById('status-badge');
const statusText  = document.getElementById('status-text');
const emptyState  = document.getElementById('empty-state');

// Document-aware empty state: show the onboarding CTA ("add a document") when the workspace is confirmed
// empty, and the ask prompt + starter pills once at least one document is indexed (the starters can't work
// with no documents yet). Driven by the status heartbeat's `empty` flag; idempotent (just toggles classes).
const emptyOnboard = document.getElementById('empty-onboard');
const emptyAsk     = document.getElementById('empty-ask');
function setEmptyStateMode(mode /* 'onboard' | 'ask' */) {
  if (!emptyOnboard || !emptyAsk) return;
  const onboard = mode === 'onboard';
  // Toggle display directly rather than via a `.hidden` class — `.hidden` here is component-scoped, not a
  // global display:none utility, so it would not hide these plain blocks.
  emptyOnboard.style.display = onboard ? '' : 'none';
  emptyAsk.style.display     = onboard ? 'none' : '';
}
document.getElementById('empty-add-doc')?.addEventListener('click', () => { try { openDocPanel(); } catch {} });

// ── State ──
let currentBubble  = null;
let pendingSources = null;
let pendingSourceStats = null;   // independence summary for pendingSources (serverside, bounded)
// Post-answer meta (the "why" trace, the rating id, the faithfulness result) is buffered
// while the answer streams and attached on chat_end, once its sources row exists.
let pendingTrace     = null;
let pendingOutcomeId = null;
let pendingFaith     = null;
let pendingConf      = null;    // the answer-confidence verdict, buffered like pendingFaith until its row exists
let pendingPodcast   = false;   // set when an Audio Overview (podcast) turn is generated, so its answer gets the two-voice player
// Answers rebuilt from saved history on reload: { botRow, text, sources }. Kept so their content-derived controls
// (Copy, Download, Read aloud) can be re-attached — once on restore, and again once the voice status is known.
let restoredAnswers  = [];
// The server's deterministic verification pass (lib/verify) can clean/correct the answer
// after it streamed; when it does, it sends the finalized text to swap in at chat_end.
let pendingFinal     = null;
let messageBuffer  = '';
let isStreaming    = false;
// True from a turn's start (showThinking) until it ends (chat_end / error / reset / disconnect). Distinct from
// isStreaming, which is only true AFTER the first token: the "thinking" phase before the first token is still an
// active turn. The 2-second status heartbeat consults this so it only re-enables the composer between turns,
// never mid-turn (which would let a second message be submitted over a still-generating answer).
let turnActive     = false;
// The finalized text and sources of the most recent answer, snapshotted at chat_end so the
// per-answer "Copy" control can rebuild it as Markdown without re-reading the DOM.
let lastAnswerText    = '';
let lastAnswerSources = [];
// Follow-up suggestion chips arrive after the turn ends, so we pin the answer's row and the
// query they belong to at chat_end and attach them when (and if) they arrive.
let lastUserQuery      = '';
let suggestTargetRow   = null;
let suggestTargetTurn  = null;
// The Verify (faithfulness) badge arrives on its own event after the turn ends (a post-answer LLM
// pass, fire-and-forget on the server), so — like the suggestions above — pin the row at chat_end and
// attach the badge when it arrives, ignoring a result for a different turn.
let faithTargetRow     = null;
let faithTargetTurn    = null;
// The answer-confidence chip arrives on its own event after the turn ends (same fire-and-forget pattern as
// Verify), so it is pinned and attached the same way.
let confTargetRow      = null;
let confTargetTurn     = null;
// The server tags each answered turn with a monotonic id (the 'answer_turn' event, sent just before
// chat_end). Matching the late faithfulness/suggestion payloads on this id — not the query text —
// keeps two identical consecutive queries from cross-attaching a badge to the wrong answer.
let pendingTurnId      = null;
// The language detected for the answer that is currently streaming (from the server's 'answer_turn' event, or
// chat_end for paths without one). Read aloud uses it to choose the local English model or a system voice.
let pendingAnswerLang  = null;
let selectedDocIds = new Set(); // docIds the user has pinned for focused search
let fullContextMode = false;    // when true, selected docs are injected WHOLE (Full-Context) rather than by passage retrieval
let docsCache = [];             // last-loaded document list, for the # command picker
let docFilterQuery = '';        // live document-list filter (client-side; survives heartbeat reloads)
let pendingAttachments = [];    // one-off attachments { name, text } for the next message only

// ── Status ──
function setStatus(state, label) {
  statusBadge.className = '';
  statusBadge.classList.add(state);
  statusText.textContent = label;
}
socket.on('connect',       () => setStatus('ready', 'connected'));
socket.on('disconnect',    () => { setStatus('error', 'disconnected'); setInputState(true); resetStreaming(); hideThinking(); });
socket.on('connect_error', () => setStatus('error', 'connection error'));
// Last status seen, so the heartbeat can skip redundant refreshes.
let lastStatusSig = '';
socket.on('indexing_status', (p) => {
  const { indexing, ready, empty, documents, progress } = parsePayload(p);
  busyIndexing = !!indexing;   // drives the leave-while-busy guard
  if (indexing) {
    // Show live per-file progress when the server reports it, so a multi-second
    // index reads as work-in-progress rather than a freeze. Falls back to a plain
    // "indexing…" when no per-file detail is available (e.g. the loading phase).
    if (progress && progress.total) {
      const pct = Math.round((progress.done / progress.total) * 100);
      setStatus('indexing', `${progress.label || 'Indexing'} ${progress.done}/${progress.total} (${pct}%)`);
    } else {
      setStatus('indexing', 'indexing…');
    }
  }
  // An empty workspace is ready, it just has nothing in it — reporting "not ready"
  // made a usable workspace look broken.
  else if (empty)   setStatus('ready', 'no documents');
  else if (ready)   setStatus('ready', `${documents} doc${documents !== 1 ? 's' : ''}`);
  else              setStatus('indexing', 'starting…');
  // Point a brand-new, empty workspace at "add a document" instead of a question it can't answer yet. Only
  // switch to onboarding once the workspace is confirmed empty; otherwise keep the ask prompt (so an existing
  // corpus never flashes the onboarding CTA while it is still starting/indexing).
  if (!indexing) setEmptyStateMode(empty === true ? 'onboard' : 'ask');
  // Refresh the document list only when something actually changed. The heartbeat
  // fires every 2s, and reloading unconditionally caused a visible flicker and — if
  // it landed while the workspace dropdown was open — closed the dropdown.
  const sig = `${indexing}|${documents}|${ready}`;
  if (!indexing && sig !== lastStatusSig) {
    if (panelOpen) loadDocuments();
    // Keep the workspace switcher's per-workspace document count in step with the live count in the status
    // badge — otherwise the dropdown keeps a stale number after an index or rebuild (it is only populated on
    // page load) and the two disagree for the same workspace. Skip while the dropdown is focused so a
    // refresh can't collapse it mid-selection.
    if (workspaceSelect && document.activeElement !== workspaceSelect) loadWorkspaces();
  }
  lastStatusSig = sig;
  // Re-enable input once the index is usable. A workspace switch disables it and
  // relies on this heartbeat to release it, since the switch completes in the
  // background after the HTTP response. But NOT mid-turn: without the turnActive guard the 2s heartbeat
  // re-enabled the composer while an answer was still thinking/streaming, letting a second message be submitted
  // over the in-flight turn (a stray thinking bubble + user row above the streaming answer).
  if (ready && !indexing && !turnActive) setInputState(false);
});

// ── Input ──
// The Send button is also the Stop control. One control, one source of truth: `turnActive` says a turn
// is in flight. Idle it submits; mid-turn it asks the server to stop. While a stop is pending it reads
// "Stopping…" and is disabled until the server's terminal event arrives (or a safety timer re-offers
// Stop, so a lost request cannot leave a dead button). This keeps the composer to one compact control
// on phones instead of adding a second button that duplicates the send affordance.
const SEND_LABEL       = 'Send ↵';
const STOP_LABEL       = 'Stop';
const STOPPING_LABEL   = 'Stopping…';
const STOP_ACK_TIMEOUT_MS = 10000;   // revert "Stopping…" if no terminal event arrives
function clearStopRequest() {
  turnStopping = false;
  if (_stopRevertTimer) { clearTimeout(_stopRevertTimer); _stopRevertTimer = null; }
}
function refreshSendButton() {
  if (!sendBtn) return;
  if (turnActive) {
    sendBtn.classList.add('stop-mode');
    sendBtn.disabled = turnStopping;
    sendBtn.textContent = turnStopping ? STOPPING_LABEL : STOP_LABEL;
    sendBtn.setAttribute('aria-label', turnStopping ? 'Stopping the current answer' : 'Stop generating');
    sendBtn.title = turnStopping ? 'Waiting for the server to stop' : 'Stop generating this answer';
  } else {
    sendBtn.classList.remove('stop-mode');
    sendBtn.disabled = msgInput.disabled;
    sendBtn.textContent = SEND_LABEL;
    sendBtn.setAttribute('aria-label', 'Send message');
    sendBtn.title = '';
  }
}
function requestStop() {
  if (!turnActive || turnStopping) return;
  turnStopping = true;
  refreshSendButton();
  socket.emit(TURN_PROTOCOL.stop);
  if (_stopRevertTimer) clearTimeout(_stopRevertTimer);
  _stopRevertTimer = setTimeout(() => {
    _stopRevertTimer = null;
    if (!turnActive) return;   // the terminal event already settled it
    turnStopping = false;
    refreshSendButton();
  }, STOP_ACK_TIMEOUT_MS);
}
// `focus` is opt-in. This runs from the 2-second status heartbeat as well as from
// user actions, and unconditionally focusing the chat box meant focus was yanked
// away every 2 seconds — making it impossible to type in the backup passphrase or
// any other panel field, and closing the workspace dropdown.
function setInputState(disabled, focus = false) {
  msgInput.disabled = disabled;
  refreshSendButton();   // Send is disabled for the same reasons the composer is — except during a turn, when it is Stop
  // Never steal focus from something the user is actively using.
  if (!disabled && focus && !isTypingElsewhere()) msgInput.focus();
  // Turn just ended: let hands-free recover if the turn produced no answer to read back (safety net).
  if (!disabled && typeof handsfreeTurnEndFallback === 'function') handsfreeTurnEndFallback();
}

// True when focus sits in another editable control — a panel input, a textarea, or
// a select the user is interacting with.
function isTypingElsewhere() {
  const el = document.activeElement;
  if (!el || el === msgInput || el === document.body) return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
}
// The workspace this window is viewing — set on the workspace dropdown by loadWorkspaces() at startup and
// after any workspace action this window takes (switch, delete, restore). Sent with each query and
// document request so the server answers and manages that workspace, even when another window has since
// made a different workspace the global active one — each window keeps its own view. Read fresh from the
// DOM so it never depends on element-initialization order; returns null when unknown, which the server
// treats as "the active workspace" (a safe default for a fresh window before the list loads).
function currentWorkspaceId() {
  return document.getElementById('workspace-select')?.dataset?.active || null;
}
// Query-string fragment naming the workspace this window is viewing, for the document routes so the panel
// manages the window's own workspace, not always the active one. Empty when unknown (the server then
// falls back to the active workspace — a safe default). `sep` is '?' to start a query or '&' to append.
function wsQuery(sep = '?') {
  const w = currentWorkspaceId();
  return w ? `${sep}workspace=${encodeURIComponent(w)}` : '';
}
function sendMessage() {
  const message = msgInput.value.trim();
  if (!message || msgInput.disabled) return;
  if (turnActive) return;   // a turn owns the composer; the same button is Stop until it ends
  // Clear any buffered per-turn state at the START of the turn, so a late event from the
  // previous turn (an out-of-order answer_final/sources/trace) can never be applied to this
  // new answer. chat_end also clears these; resetting here doesn't rely on event ordering.
  pendingFinal = null; pendingSources = null; pendingSourceStats = null; pendingTrace = null; pendingFaith = null; pendingConf = null; pendingOutcomeId = null; pendingPodcast = false; _turnStage = ''; _turnStallNoticed = '';
  // Reset the turn id too: it is set only by the server's 'answer_turn' event, which an UNANSWERED
  // turn (a refusal, web offer, clarify, or empty-workspace message) never sends. Without this reset
  // such a turn would keep the PREVIOUS answered turn's id, and that prior turn's late Verify/
  // suggestion payload would then false-match and attach under the wrong (unanswered) row.
  pendingTurnId = null;
  pendingAnswerLang = null;
  appendUserMessage(message);
  lastUserQuery = message;
  const payload = { content: message };
  // Tell the server which workspace this window is viewing, so it declines rather than answers from the
  // wrong corpus if another window switched the (single, server-side) active workspace and this window's
  // status heartbeat has not caught up yet. Sourced from the last server-confirmed active id.
  const viewedWs = currentWorkspaceId();
  if (viewedWs) payload.workspaceId = viewedWs;
  if (selectedDocIds.size > 0) payload.selectedDocIds = [...selectedDocIds];
  // In Full-Context mode, the selected docs are also sent as full-context so the
  // backend injects them whole (subject to its size cap) instead of by passages.
  if (fullContextMode && selectedDocIds.size > 0) payload.fullContextDocIds = [...selectedDocIds];
  // One-off attachments for this message only (extracted text, not indexed).
  if (pendingAttachments.length > 0) payload.attachments = pendingAttachments.map(a => ({ name: a.name, text: a.text }));
  if (webSearchOn) payload.webSearch = true;
  if (explainTraceOn) payload.explainTrace = true;
  if (faithfulnessOn) payload.checkFaithfulness = true;
  if (deepResearchOn) payload.deepResearch = true;
  if (suggestOn) payload.suggestQuestions = true;
  payload.outcomes = outcomesOn;   // explicit on/off so the server can gate recording + learning
  const dateFrom = document.getElementById('date-from')?.value;
  const dateTo   = document.getElementById('date-to')?.value;
  if (dateFrom) payload.startDate = dateFrom;
  if (dateTo)   payload.endDate   = dateTo;
  socket.emit('message', JSON.stringify(payload));
  msgInput.value = '';
  msgInput.style.height = 'auto';
  // One-off attachments apply to a single message; clear them after sending.
  if (pendingAttachments.length > 0) { pendingAttachments = []; renderAttachChips(); }
  // Deep Research is one-shot: it applies to this message only, then disarms, so a costly multi-step run never
  // silently repeats on every follow-up. (Web search, Verify and Explain stay sticky — they're cheap by design.)
  if (deepResearchOn) { deepResearchOn = false; updateResearchToggleUI(); }
  setInputState(true);
  // Web search is a plain sticky toggle (like Explain/Verify): it stays on until the user turns it off.
  // The always-visible active-options chip ("🌐 Web search ✕") shows it is on before every send and turns
  // it off in one click, so nothing is sent to the web silently and there is no per-message reset to explain.
  // Show thinking indicator immediately — disappears when first token arrives
  showThinking();
}

// Summarize a specific document — a direct action, not a search. Closes the panel
// so the answer is visible, shows the request as a user turn, and hands off to the
// server's summarize_document handler, which bypasses retrieval and streams a
// summary of that document. The response renders through the normal message
// stream, so no extra rendering is needed here.
function summarizeDocument(docId, name) {
  if (!docId) return;
  // A generation is already in flight (its tokens would stream into the previous
  // answer's bubble). The input is disabled for the whole turn, so mirror the send gate.
  if (msgInput.disabled) return;
  // Close the panel so the conversation is in view. Route through closeDocPanel so the mobile
  // drawer's dialog ARIA and focus are cleaned up (these triggers live inside the drawer).
  if (panelOpen) closeDocPanel();
  appendUserMessage(`Summarize ${name}`);
  setInputState(true);
  showThinking();
  socket.emit('summarize_document', JSON.stringify({ docId, workspaceId: currentWorkspaceId() || undefined }));
}
// Whole-workspace synthesis: asks the server to summarize every document and then
// synthesize an overview across them ("common themes"). Streams back through the
// normal message flow like summarizeDocument. Can take a while on a large workspace.
async function synthesizeWorkspace() {
  if (msgInput.disabled) return;   // a turn is already in flight — see summarizeDocument
  // Read the format's UI fields off the SELECTED option (the server renders label/confirm/audio as data-attrs
  // from the one SYNTHESIS_FORMATS source), so the client holds no parallel map that could drift from it.
  const sel  = document.getElementById('synthesize-format');
  const opt  = sel && sel.selectedOptions && sel.selectedOptions[0];
  const format = (sel && sel.value) || 'overview';
  const label  = (opt && opt.dataset.label) || 'Overview';
  const what   = (opt && opt.dataset.confirm) || 'write a high-level overview of what they cover';
  const isAudio = !!(opt && opt.dataset.audio);
  // Confirm first, briefly saying what Generate will do: it reads across the WHOLE workspace (not the
  // focused/selected documents), which can take a while on a large library. Reuses the shared promise-based
  // confirm so there is no duplicate modal code, and it is accessible, themed, and non-blocking everywhere.
  const ok = await showConfirm({
    title: 'Generate across this workspace?',
    message: `Lokyni will read across every document in this workspace and ${what}. On a large library this can take a moment, and the result appears in the chat.`,
    okLabel: '✦ Generate',
  });
  if (!ok) return;
  if (msgInput.disabled) return;   // re-check: a turn may have started while the dialog was open
  if (panelOpen) closeDocPanel();   // clean up the mobile drawer's dialog ARIA + focus too
  // Always "Generate …" (not the jargon "Synthesize"); the label is lowercased to read naturally in the sentence.
  appendUserMessage(format === 'overview' ? 'Generate an overview of this workspace' : `Generate a ${label.toLowerCase()} for this workspace`);
  setInputState(true);
  showThinking();
  // Remember an audio-format (podcast) turn so, when its dialogue answer lands, we offer a "Play as podcast"
  // control (two-voice audio) instead of the single-voice Read-aloud button.
  pendingPodcast = isAudio;
  socket.emit('synthesize_workspace', JSON.stringify({ format, workspaceId: currentWorkspaceId() || undefined }));
}
// One-shot by default: click 🌐 to search the web for the NEXT message only, then
// it reverts. Double-click to LOCK it on for a research session (stays on until
// toggled off). Off by default so the local-only privacy posture is never changed
// silently.
let webSearchOn = false;
const webToggle = document.getElementById('web-search-toggle');
// Hide the 🌐 toggle entirely when web search is disabled in settings, so the UI
// matches the active configuration.
function applyWebSearchVisibility(enabled) {
  if (webToggle) webToggle.classList.toggle('hidden', !enabled);
  if (!enabled) webSearchOn = false;
  updateWebToggleUI();
}
// A plain sticky on/off toggle, consistent with the other Tools toggles (Explain/Verify). Off by default
// (the local-only posture is never changed without an explicit click), and it STAYS on until turned off —
// no hidden double-click/long-press "lock" and no silent per-message reset. The active-options chip strip
// shows it is on before every send and clears it in one click, so sticky is never a silent foot-gun.
function updateWebToggleUI() {
  if (!webToggle) return;
  webToggle.classList.toggle('active', webSearchOn);
  webToggle.setAttribute('aria-checked', webSearchOn ? 'true' : 'false');
  webToggle.title = webSearchOn
    ? 'Search the web ON — stays on until you turn it off (shown as a chip above each message)'
    : 'Search the web OFF — answers come from your documents only. Click to also look things up online.';
  refreshToolsIndicator();
}
if (webToggle) {
  webToggle.addEventListener('click', () => { webSearchOn = !webSearchOn; updateWebToggleUI(); });
}

// ── Explain ("Why this answer?") toggle ──
// A display choice, not a retrieval setting, so it lives in localStorage like the
// theme rather than in server config. When off, the client omits the explainTrace
// flag; the server then skips building the trace entirely (no wasted work) and
// emits no retrieval_trace event, so the "Why this answer?" button never appears.
// Defaults ON to preserve the current behavior for anyone who hasn't touched it.
let explainTraceOn = lsGet('lokyni_explain') !== 'off';
const whyToggle = document.getElementById('why-toggle');
function updateWhyToggleUI() {
  if (!whyToggle) return;
  whyToggle.classList.toggle('active', explainTraceOn);
  whyToggle.setAttribute('aria-checked', explainTraceOn ? 'true' : 'false');
  refreshToolsIndicator();
  whyToggle.title = explainTraceOn
    ? 'Explain this answer ON — each answer shows why it used the documents it did'
    : 'Explain this answer OFF — click to show a "Why this answer?" panel on each answer';
}
if (whyToggle) {
  updateWhyToggleUI();
  whyToggle.addEventListener('click', () => {
    explainTraceOn = !explainTraceOn;
    lsSet('lokyni_explain', explainTraceOn ? 'on' : 'off');
    updateWhyToggleUI();
  });
}

// ── Learn (outcome-aware retrieval) toggle ──
// When ON (default), answers are recorded, rating buttons appear, similar past
// questions are surfaced, and 👎 down-weighting applies. When OFF, the client omits
// the outcomes flag; the server records nothing, shows no rating buttons, surfaces
// nothing, and applies no down-weighting — Lokyni behaves as if the feature is off.
// Stored client-side like the Explain toggle.
let outcomesOn = lsGet('lokyni_outcomes') !== 'off';
const learnToggle = document.getElementById('learn-toggle');
function updateLearnToggleUI() {
  if (!learnToggle) return;
  learnToggle.classList.toggle('active', outcomesOn);
  learnToggle.setAttribute('aria-checked', outcomesOn ? 'true' : 'false');
  refreshToolsIndicator();
  learnToggle.title = outcomesOn
    ? 'Learn ON — rate answers 👍/👎 so Lokyni surfaces similar past questions and down-weights documents that led to bad answers'
    : 'Learn OFF — click to record answer outcomes and enable rating + learning';
}
if (learnToggle) {
  updateLearnToggleUI();
  learnToggle.addEventListener('click', () => {
    outcomesOn = !outcomesOn;
    lsSet('lokyni_outcomes', outcomesOn ? 'on' : 'off');
    updateLearnToggleUI();
  });
}

// Verify (faithfulness) toggle — opt-in, default OFF (it costs an extra LLM pass per
// answer). When on, each answer is fact-checked against its cited sources and gets a
// grounded/unverified badge. Stored client-side like the Explain and Learn toggles.
let faithfulnessOn = lsGet('lokyni_verify') === 'on';
const verifyToggle = document.getElementById('verify-toggle');
function updateVerifyToggleUI() {
  if (!verifyToggle) return;
  verifyToggle.classList.toggle('active', faithfulnessOn);
  verifyToggle.setAttribute('aria-checked', faithfulnessOn ? 'true' : 'false');
  refreshToolsIndicator();
  verifyToggle.title = faithfulnessOn
    ? 'Verify ON — each answer is fact-checked against its cited sources (adds a short check after the answer)'
    : "Verify OFF — click to fact-check each answer's claims against its cited sources";
}
if (verifyToggle) {
  updateVerifyToggleUI();
  verifyToggle.addEventListener('click', () => {
    faithfulnessOn = !faithfulnessOn;
    lsSet('lokyni_verify', faithfulnessOn ? 'on' : 'off');
    updateVerifyToggleUI();
  });
}

// Deep Research toggle — opt-in, default OFF, and ONE-SHOT. Unlike the sticky toggles (web search, Verify,
// Explain), Deep Research is heavyweight — a multi-step, multi-model research run over the corpus (and the web
// too, if the 🌐 toggle is also on). Leaving it sticky would silently re-run full research on every follow-up,
// which is slow and costly, so it instead arms for the NEXT message only and then turns itself back off (see the
// reset in sendMessage). That's also why it is never persisted across reloads — an armed one-shot shouldn't
// outlive the tab.
let deepResearchOn = false;
const researchToggle = document.getElementById('research-toggle');
function updateResearchToggleUI() {
  if (!researchToggle) return;
  researchToggle.classList.toggle('active', deepResearchOn);
  researchToggle.setAttribute('aria-checked', deepResearchOn ? 'true' : 'false');
  refreshToolsIndicator();
  researchToggle.title = deepResearchOn
    ? 'Deep Research armed — your next question runs as multi-step, cited research, then this turns back off'
    : 'Deep Research — click to run your next question as multi-step, cited research over your documents (and the web if web search is on)';
}
if (researchToggle) {
  updateResearchToggleUI();
  researchToggle.addEventListener('click', () => {
    deepResearchOn = !deepResearchOn;
    updateResearchToggleUI();
  });
}

// Suggest (follow-up questions) toggle — opt-in, default OFF. When on, each grounded
// answer gets a few one-click follow-up question chips (a small extra LLM pass that runs
// after the answer). Stored client-side like the other composer toggles. Hidden entirely
// when the feature is disabled in settings (see applySuggestVisibility).
let suggestOn = lsGet('lokyni_suggest') === 'on';
const suggestToggle = document.getElementById('suggest-toggle');
function updateSuggestToggleUI() {
  if (!suggestToggle) return;
  suggestToggle.classList.toggle('active', suggestOn);
  suggestToggle.setAttribute('aria-checked', suggestOn ? 'true' : 'false');
  refreshToolsIndicator();
  suggestToggle.title = suggestOn
    ? 'Follow-up suggestions ON — one-click follow-up questions appear under each answer'
    : 'Follow-up suggestions OFF — click to show one-click follow-up questions under each answer';
}
function applySuggestVisibility(enabled) {
  if (suggestToggle) suggestToggle.classList.toggle('hidden', !enabled);
  if (!enabled) suggestOn = false;
  updateSuggestToggleUI();
}
if (suggestToggle) {
  updateSuggestToggleUI();
  suggestToggle.addEventListener('click', () => {
    suggestOn = !suggestOn;
    lsSet('lokyni_suggest', suggestOn ? 'on' : 'off');
    updateSuggestToggleUI();
  });
}

// ── Composer Tools menu + header More menu (one reusable popover) ──────────────
// A single lightweight, accessible popover recipe drives both the header overflow menu and the
// composer's Tools menu. State is the panel's `hidden` attribute plus the trigger's aria-expanded.
// It closes on outside click and on Escape (restoring focus to the trigger), keeps only one popover
// open at a time, and arrow keys move between items. These are menus, not dialogs, so focus is not
// trapped — that heavier behavior stays reserved for the modal overlays (see setupModalA11y).
const openPopovers = new Set();
function closeAllPopovers(except) { for (const p of [...openPopovers]) if (p !== except) p.close(); }
function wirePopover(btn, panel, opts = {}) {
  if (!btn || !panel) return null;
  const focusables = () => [...panel.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])')].filter(el => el.offsetParent !== null);
  // Mobile presentation. On a phone the Tools panel is a bottom sheet: it covers the page with a
  // backdrop, gets a visible title and close control, and behaves like a modal dialog (Tab stays inside,
  // Escape/backdrop/close all dismiss). On desktop the exact same panel stays a compact popover. Only
  // the presentation changes — every row and handler is identical, so the two cannot drift.
  const sheetMq = (() => { try { return window.matchMedia(DOC_PANEL_OVERLAY_MQ); } catch { return null; } })();
  const isSheet = () => !!(opts.sheet && sheetMq && sheetMq.matches);
  const backdrop = opts.sheet ? document.getElementById('sheet-backdrop') : null;
  const closeBtn = opts.sheetCloseId ? document.getElementById(opts.sheetCloseId) : null;
  // Remember the desktop semantics so widening the viewport restores them exactly.
  const baseRole  = panel.getAttribute('role') || '';
  const baseLabel = panel.getAttribute('aria-label') || '';
  let sheetActive = false;
  const syncSheet = () => {
    const sheet = !panel.hidden && isSheet();
    if (sheet === sheetActive) return;
    sheetActive = sheet;
    if (sheet) {
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      if (opts.sheetTitleId) panel.setAttribute('aria-labelledby', opts.sheetTitleId);
      panel.removeAttribute('aria-label');   // the visible sheet title is its accessible name
      btn.setAttribute('aria-haspopup', 'dialog');   // the trigger now opens a modal sheet, not a group
      if (backdrop) backdrop.hidden = false;
    } else {
      if (baseRole) panel.setAttribute('role', baseRole); else panel.removeAttribute('role');
      panel.removeAttribute('aria-modal');
      panel.removeAttribute('aria-labelledby');
      if (baseLabel) panel.setAttribute('aria-label', baseLabel); else panel.removeAttribute('aria-label');
      btn.removeAttribute('aria-haspopup');
      if (backdrop) backdrop.hidden = true;
    }
  };
  let api;
  const setOpen = (open) => {
    if (open) closeAllPopovers(api);
    const wasSheet = !panel.hidden && isSheet();
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    btn.classList.toggle('open', open);
    if (open) openPopovers.add(api); else openPopovers.delete(api);
    syncSheet();
    if (open) {
      // In a sheet, land on the first VISIBLE option (the task) rather than the close control; the
      // dialog's name is announced when focus enters it. A feature toggle hidden by Settings is skipped.
      const firstRow = [...panel.querySelectorAll('.tool-row:not([disabled])')].find(el => el.offsetParent !== null);
      const f = (isSheet() && firstRow) || focusables()[0];
      try { (f || panel).focus(); } catch { /* best-effort */ }
    }
    // A sheet is modal, so closing it returns focus to the control that opened it. A desktop popover
    // keeps its prior outside-click behavior (no focus steal).
    else if (wasSheet) { try { btn.focus(); } catch { /* best-effort */ } }
  };
  api = { btn, panel, open: () => setOpen(true), close: () => setOpen(false), toggle: () => setOpen(panel.hidden), isOpen: () => !panel.hidden };
  btn.addEventListener('click', (e) => { e.stopPropagation(); api.toggle(); });
  if (closeBtn) closeBtn.addEventListener('click', (e) => { e.stopPropagation(); api.close(); });
  panel.addEventListener('click', (e) => {
    e.stopPropagation();
    if (opts.closeOnItemClick && e.target.closest('.menu-row,[role^="menuitem"]')) api.close();
  });
  panel.addEventListener('keydown', (e) => {
    // Keep Tab inside a modal sheet. This runs before the form-field bail-out below, so Tab still
    // cycles when focus is on the date inputs (a date input's Up/Down must remain native).
    if (e.key === 'Tab' && isSheet()) {
      const list = focusables(); if (!list.length) return;
      const first = list[0], last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      return;
    }
    // Don't hijack arrow/Home/End keys while a form field inside the panel has focus — a date input uses
    // Up/Down to change its value, and text fields use Home/End for the caret. Roving focus applies only
    // when focus is on a menu control, not inside an input.
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    const list = focusables(); if (!list.length) return;
    const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); (list[i + 1] || list[0]).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (list[i - 1] || list[list.length - 1]).focus(); }
    else if (e.key === 'Home') { e.preventDefault(); list[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); list[list.length - 1].focus(); }
  });
  // Crossing the breakpoint while a panel is open must add or shed the sheet presentation, not leave a
  // stale backdrop or dialog role behind. addListener is the Safari < 14 fallback for addEventListener.
  if (sheetMq) {
    const onChange = () => { if (!panel.hidden) syncSheet(); };
    try {
      if (sheetMq.addEventListener) sheetMq.addEventListener('change', onChange);
      else if (sheetMq.addListener) sheetMq.addListener(onChange);
    } catch { /* matchMedia is best-effort */ }
  }
  return api;
}
document.addEventListener('click', () => closeAllPopovers());
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !openPopovers.size) return;
  const last = [...openPopovers][openPopovers.size - 1];
  last.close();
  try { last.btn.focus(); } catch { /* best-effort */ }
});
wirePopover(document.getElementById('more-btn'), document.getElementById('more-menu'), { closeOnItemClick: true });
wirePopover(document.getElementById('tools-btn'), document.getElementById('tools-menu'), {
  sheet: true,
  sheetTitleId: 'tools-sheet-title',
  sheetCloseId: 'tools-sheet-close',
});

// The More-menu corpus-tool rows delegate to the existing doc-panel buttons (same modal, one source of
// truth) so Extract / Mind-map / Notes are reachable without opening the Documents drawer. The popover
// closes on item click (closeOnItemClick), then the underlying button's handler opens the overlay.
const delegateClick = (fromId, toId) =>
  document.getElementById(fromId)?.addEventListener('click', () => { try { document.getElementById(toId)?.click(); } catch {} });
delegateClick('menu-extract', 'extract-table-btn');
delegateClick('menu-map', 'mindmap-btn');
delegateClick('menu-notes', 'notes-btn');

// refreshToolsIndicator: keep the Tools button badge and the removable chip strip in sync with which
// answer options are on. Every enabled option counts and gets a chip (including the default-on Explain
// and Learn), so the badge reflects all active tools rather than a curated subset. State is read from
// the DOM (each toggle's `.active` class), so this is safe to call at any time, including before the
// later composer consts are initialized.
function refreshToolsIndicator() {
  const isOn = (id) => { const el = document.getElementById(id); return !!(el && el.classList.contains('active')); };
  const df = document.getElementById('date-from'), dt = document.getElementById('date-to');
  const dateEngaged = !!((df && df.value) || (dt && dt.value));

  // Reflect checked state on each menu row for assistive tech.
  for (const id of ['web-search-toggle', 'research-toggle', 'why-toggle', 'verify-toggle', 'suggest-toggle', 'learn-toggle']) {
    const el = document.getElementById(id); if (el) el.setAttribute('aria-checked', el.classList.contains('active') ? 'true' : 'false');
  }
  // The date row is a disclosure button (not a checkbox): reflect "a range is set" only visually via
  // the active class. Its aria-expanded is managed by the toggle handler.
  const dateRow = document.getElementById('date-filter-toggle');
  if (dateRow) dateRow.classList.toggle('active', dateEngaged);

  // Explain and Learn are on by default. They stay available in the menu but are not counted as
  // active choices, so a new user does not see a non-zero badge before changing anything. Chips and
  // the badge show only options the user turned on.
  const BASELINE_MODES = new Set(['why', 'learn']);
  const modes = [
    { id: 'web',      on: isOn('web-search-toggle'),              iconRef: '#ic-web',      label: 'Web search' },
    { id: 'research', on: isOn('research-toggle'),                iconRef: '#ic-research', label: 'Deep research' },
    { id: 'why',      on: isOn('why-toggle'),                     iconRef: '#ic-explain',  label: 'Explain' },
    { id: 'verify',   on: isOn('verify-toggle'),                  iconRef: '#ic-verify',   label: 'Verify' },
    { id: 'suggest',  on: isOn('suggest-toggle'),                 iconRef: '#ic-suggest',  label: 'Follow-ups' },
    { id: 'learn',    on: isOn('learn-toggle'),                   iconRef: '#ic-learn',    label: 'Learn' },
    { id: 'date',     on: dateEngaged,                            iconRef: '#ic-date',     label: 'Date range' },
  ].filter(m => m.on && !BASELINE_MODES.has(m.id));

  const badge = document.getElementById('tools-badge');
  if (badge) { if (modes.length) { badge.textContent = String(modes.length); badge.classList.remove('hidden'); } else badge.classList.add('hidden'); }

  const chips = document.getElementById('tool-chips');
  if (chips) {
    chips.innerHTML = modes.map((m) =>
      `<span class="tool-chip" data-mode="${m.id}"><svg class="ico" aria-hidden="true"><use href="${m.iconRef}"></use></svg> ${m.label}` +
      `<button type="button" class="tool-chip-x" data-mode="${m.id}" aria-label="Turn off ${m.label}" title="Turn off">×</button></span>`
    ).join('');
    chips.classList.toggle('hidden', modes.length === 0);
  }
}
// Removing a chip turns its mode off by reusing each toggle's own click handler, so all the existing
// state and persistence logic runs. Web search has a locked state a click will not clear, so it is
// handled directly.
document.getElementById('tool-chips')?.addEventListener('click', (e) => {
  const x = e.target.closest('.tool-chip-x'); if (!x) return;
  const mode = x.getAttribute('data-mode');
  if (mode === 'web') { webSearchOn = false; updateWebToggleUI(); }
  else if (mode === 'research') document.getElementById('research-toggle')?.click();
  else if (mode === 'why')      document.getElementById('why-toggle')?.click();
  else if (mode === 'verify')   document.getElementById('verify-toggle')?.click();
  else if (mode === 'suggest')  document.getElementById('suggest-toggle')?.click();
  else if (mode === 'learn')    document.getElementById('learn-toggle')?.click();
  else if (mode === 'date') {
    const f = document.getElementById('date-from'), t = document.getElementById('date-to');
    if (f) f.value = ''; if (t) t.value = '';
    refreshToolsIndicator();
  }
});
refreshToolsIndicator();

// ── Per-workspace persona ──
// A short instruction for how Lokyni answers in the active workspace (tone/role/audience),
// stored server-side per workspace. Loaded when the doc panel opens and saved on demand;
// it never triggers a reindex. Grounding is unaffected — answers still come only from the
// documents, with citations.
const personaText  = document.getElementById('persona-text');
const personaSave  = document.getElementById('persona-save');
const personaClear = document.getElementById('persona-clear');
const personaMsg   = document.getElementById('persona-msg');
async function loadPersona() {
  if (!personaText) return;
  try {
    const res = await fetch('/api/workspace/persona' + wsQuery());
    const data = await res.json();
    if (data && data.ok) personaText.value = data.persona || '';
  } catch { /* leave the field as-is on a transient error */ }
}
async function savePersona(value) {
  if (!personaText) return;
  if (personaMsg) { personaMsg.textContent = 'Saving…'; personaMsg.className = 'settings-hint'; }
  try {
    const res = await sendJSON('/api/workspace/persona' + wsQuery(), { persona: value });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'save failed');
    personaText.value = data.persona || '';
    if (personaMsg) { personaMsg.textContent = data.persona ? 'Persona saved for this workspace.' : 'Persona cleared.'; personaMsg.className = 'settings-hint'; }
  } catch (e) {
    if (personaMsg) { personaMsg.textContent = 'Could not save: ' + e.message; personaMsg.className = 'settings-hint error'; }
  }
}
if (personaSave)  personaSave.addEventListener('click', () => savePersona(personaText ? personaText.value : ''));
if (personaClear) personaClear.addEventListener('click', async () => {
  // Confirm only when there is actually a saved persona to lose — clearing an empty field is a harmless
  // no-op and should not nag. The textarea mirrors the saved value, so an empty field means nothing is stored.
  const hasPersona = personaText && personaText.value.trim();
  if (hasPersona && !(await showConfirm({ title: 'Clear workspace persona?', message: 'This removes the saved persona for this workspace. Answers still come only from your documents.', okLabel: 'Clear', danger: true }))) return;
  if (personaText) personaText.value = '';
  savePersona('');
});

// ── Web search offer (ask-first auto-suggest) ──
// When the server finds nothing in the documents for a web-answerable question, it
// emits `web_offer`. We show a Yes/No prompt; accepting runs the web search on the
// stashed query, declining dismisses it. The web is never hit until the user says yes.
socket.on('web_offer', (payload) => {
  hideThinking();
  // Fully reset streaming state so the accepted search starts clean. The failed
  // document attempt may have left an (now-empty) bubble in the DOM — remove its
  // whole row so it doesn't linger as a blank white bubble above the offer. Without
  // this reset, a leftover isStreaming=true would also send the first web chunk down
  // the "continue existing stream" branch and never hide the spinner.
  if (currentBubble && currentBubble.parentElement) {
    currentBubble.parentElement.remove();
  }
  resetStreaming();
  const data = parsePayload(payload);
  const row = document.createElement('div');
  row.className = 'msg-row bot';
  const bubble = document.createElement('div');
  bubble.className = 'bubble web-offer';
  const text = document.createElement('div');
  text.textContent = data.message || "I don't have that in your documents. Search the web?";
  const actions = document.createElement('div');
  actions.className = 'web-offer-actions';
  const yes = document.createElement('button');
  yes.className = 'web-offer-btn yes';
  yes.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#ic-web"/></svg> Search the web';
  const no = document.createElement('button');
  no.className = 'web-offer-btn no';
  no.textContent = 'No thanks';
  yes.addEventListener('click', () => {
    actions.remove();
    setInputState(true);
    showThinking();
    socket.emit('web_accept');
  });
  no.addEventListener('click', () => {
    socket.emit('web_decline');
    actions.remove();
    const dismissed = document.createElement('div');
    dismissed.className = 'web-offer-dismissed';
    dismissed.textContent = 'Okay — staying with your documents.';
    bubble.appendChild(dismissed);
    setInputState(false, true);   // the turn is over — release the composer now, don't wait for the heartbeat
  });
  actions.appendChild(yes); actions.appendChild(no);
  bubble.appendChild(text); bubble.appendChild(actions);
  row.appendChild(bubble); chatBox.appendChild(row); scrollToBottom();
});

// ── Date filter ──
const dateFilterToggle = document.getElementById('date-filter-toggle');
const dateFilterInputs = document.getElementById('date-filter-inputs');
const dateFilterClear  = document.getElementById('date-filter-clear');
if (dateFilterToggle) {
  dateFilterToggle.addEventListener('click', () => {
    const isOpen = !dateFilterInputs.classList.contains('hidden');
    dateFilterInputs.classList.toggle('hidden', isOpen);
    // aria-expanded reflects the sub-inputs disclosure; the row keeps its rich icon/label/description
    // markup (no textContent rewrite). The row's checked/.active state is owned by refreshToolsIndicator
    // and reflects whether a date range is actually set, not merely whether the inputs are showing.
    dateFilterToggle.setAttribute('aria-expanded', String(!isOpen));
    if (!isOpen) { try { (document.getElementById('date-from') || dateFilterInputs).focus(); } catch {} }
    refreshToolsIndicator();
  });
}
if (dateFilterClear) {
  dateFilterClear.addEventListener('click', () => {
    document.getElementById('date-from').value = '';
    document.getElementById('date-to').value = '';
    refreshToolsIndicator();
  });
}
// Keep the active indicator honest when a date is typed or cleared directly in the inputs.
document.getElementById('date-from')?.addEventListener('change', () => refreshToolsIndicator());
document.getElementById('date-to')?.addEventListener('change', () => refreshToolsIndicator());
msgInput.addEventListener('input', () => {
  msgInput.style.height = 'auto';
  msgInput.style.height = Math.min(msgInput.scrollHeight, 140) + 'px';
});
msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
// Starter prompts on the empty state fill the composer (they do not send), so a first-time user can
// begin with one tap and still edit the question first. Reuses the existing autosize via 'input'.
document.getElementById('starter-pills')?.addEventListener('click', (e) => {
  const pill = e.target.closest('.starter-pill'); if (!pill) return;
  msgInput.value = pill.getAttribute('data-q') || pill.textContent.trim();
  msgInput.dispatchEvent(new Event('input'));
  msgInput.focus();
});

// ── # command: type "#" in the input to reference a specific document as context ──
// Detects a "#partialname" token at the caret, shows a filtered picker of documents,
// and on selection adds that doc to the focused set (reusing selectedDocIds) so the
// message is answered against it. The "#token" text is stripped from the input.
const hashPicker = document.getElementById('hash-picker');
let hashActive = false, hashMatches = [], hashIndex = 0, hashTokenStart = -1;

// Combobox/listbox ARIA for the "#" document and "/" template pickers, so a screen reader announces that a
// picker opened, how it is navigated, and which option is active as the user arrows through. The composer
// textarea is the combobox; the picker is its listbox; each row is an option. Shared by both pickers.
// `pickerId` is the open listbox's id (null when closed); `activeOptId` is the active option's id.
function setComboState(pickerId, activeOptId) {
  try {
    if (pickerId) {
      msgInput.setAttribute('aria-expanded', 'true');
      msgInput.setAttribute('aria-controls', pickerId);
      if (activeOptId) msgInput.setAttribute('aria-activedescendant', activeOptId);
      else msgInput.removeAttribute('aria-activedescendant');
    } else {
      msgInput.setAttribute('aria-expanded', 'false');
      msgInput.removeAttribute('aria-controls');
      msgInput.removeAttribute('aria-activedescendant');
    }
  } catch (e) { /* best-effort */ }
}
// Static combobox attributes on the composer input, set once (the pickers are optional enhancements).
try {
  msgInput.setAttribute('role', 'combobox');
  msgInput.setAttribute('aria-autocomplete', 'list');
  msgInput.setAttribute('aria-expanded', 'false');
} catch (e) { /* best-effort */ }
if (hashPicker) { hashPicker.setAttribute('role', 'listbox'); hashPicker.setAttribute('aria-label', 'Matching documents'); }

function currentHashToken() {
  // Find a "#word" ending at the caret with no whitespace inside it.
  const pos = msgInput.selectionStart;
  const text = msgInput.value.slice(0, pos);
  const m = text.match(/#([^\s#]*)$/);
  if (!m) return null;
  return { query: m[1], start: pos - m[0].length };
}

function closeHashPicker() {
  hashActive = false; hashMatches = []; hashIndex = 0; hashTokenStart = -1;
  if (hashPicker) hashPicker.classList.add('hidden');
  setComboState(null);
}

function renderHashPicker() {
  if (!hashPicker || hashMatches.length === 0) { closeHashPicker(); return; }
  hashPicker.innerHTML = hashMatches.map((d, i) =>
    `<div class="hash-item${i === hashIndex ? ' active' : ''}" data-i="${i}" role="option" id="hash-opt-${i}" aria-selected="${i === hashIndex}">
       <span class="hash-icon">▤</span><span class="hash-name">${escapeHtml(d.name)}</span>
     </div>`).join('');
  hashPicker.classList.remove('hidden');
  setComboState('hash-picker', `hash-opt-${hashIndex}`);
  hashPicker.querySelectorAll('.hash-item').forEach(el => {
    el.addEventListener('mousedown', (ev) => { ev.preventDefault(); pickHash(Number(el.dataset.i)); });
  });
}

function updateHashPicker() {
  const tok = currentHashToken();
  if (!tok) { closeHashPicker(); return; }
  const q = tok.query.toLowerCase();
  hashMatches = docsCache
    .filter(d => d.indexed && d.name.toLowerCase().includes(q))
    .slice(0, 8);
  if (hashMatches.length === 0) { closeHashPicker(); return; }
  hashActive = true; hashIndex = 0; hashTokenStart = tok.start;
  renderHashPicker();
}

function pickHash(i) {
  const doc = hashMatches[i];
  if (!doc) return;
  // Add to the focused selection so retrieval scopes to it.
  selectedDocIds.add(doc.docId);
  // Strip the "#token" from the input.
  const pos = msgInput.selectionStart;
  msgInput.value = msgInput.value.slice(0, hashTokenStart) + msgInput.value.slice(pos);
  msgInput.focus();
  closeHashPicker();
  updateFilterBar();
  // Reflect the selection in the doc panel if it's open.
  const item = docListWrap.querySelector(`.doc-item[data-doc-id="${doc.docId}"]`);
  if (item) { item.classList.add('selected'); const c = item.querySelector('.di-check'); if (c) c.checked = true; }
}

msgInput.addEventListener('input', updateHashPicker);
msgInput.addEventListener('keydown', (e) => {
  if (!hashActive) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); hashIndex = (hashIndex + 1) % hashMatches.length; renderHashPicker(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); hashIndex = (hashIndex - 1 + hashMatches.length) % hashMatches.length; renderHashPicker(); }
  else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); pickHash(hashIndex); }
  else if (e.key === 'Escape') { e.preventDefault(); closeHashPicker(); }
}, true);   // capture phase so Enter picks instead of sending
msgInput.addEventListener('blur', () => setTimeout(closeHashPicker, 150));

// ── One-off file attachments ─────────────────────────────────────────────────
// Attach a file to ask about it for a single message. The file is sent to the
// server, which extracts its text (incl. OCR) in memory and returns it — nothing is
// saved to the library or indexed. The text rides along with the next message.
const attachBtn = document.getElementById('attach-btn');
const attachInput = document.getElementById('attach-input');
const attachChips = document.getElementById('attach-chips');

function renderAttachChips() {
  if (!attachChips) return;
  if (pendingAttachments.length === 0) { attachChips.classList.add('hidden'); attachChips.innerHTML = ''; return; }
  attachChips.classList.remove('hidden');
  attachChips.innerHTML = pendingAttachments.map((a, i) =>
    `<span class="attach-chip"><svg class="ico" aria-hidden="true"><use href="#ic-attach"/></svg> <span class="attach-name">${escapeHtml(a.name)}</span><button data-i="${i}" title="Remove" aria-label="Remove ${escapeHtml(a.name)}">✕</button></span>`).join('');
  attachChips.querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => { pendingAttachments.splice(Number(b.dataset.i), 1); renderAttachChips(); }));
}

if (attachBtn && attachInput) {
  attachBtn.addEventListener('click', () => attachInput.click());
  attachInput.addEventListener('change', async () => {
    const file = attachInput.files?.[0];
    attachInput.value = '';   // allow re-selecting the same file later
    if (!file) return;
    const chipId = 'attaching';
    if (attachChips) { attachChips.classList.remove('hidden'); attachChips.insertAdjacentHTML('beforeend', `<span class="attach-chip" id="${chipId}"><svg class="ico" aria-hidden="true"><use href="#ic-attach"/></svg> <span class="attach-name">${escapeHtml(file.name)}</span> …</span>`); }
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/documents/attach', { method: 'POST', body: fd });
      const data = await res.json();
      document.getElementById(chipId)?.remove();
      if (!data.ok) { showToast('Attach failed: ' + (data.error || 'unknown'), 'error'); renderAttachChips(); return; }
      pendingAttachments.push({ name: data.name, text: data.text });
      renderAttachChips();
    } catch (e) {
      document.getElementById(chipId)?.remove();
      showToast('Attach failed: ' + e.message, 'error');
      renderAttachChips();
    }
  });
}
inputForm.addEventListener('submit', (e) => {
  e.preventDefault();
  // Same button, two jobs: during a turn the submit is a Stop request, not a second message.
  if (turnActive) { requestStop(); return; }
  sendMessage();
});

// ── Helpers ──
function hideEmptyState() { if (emptyState) emptyState.style.display = 'none'; }
function scrollToBottom() { chatBox.scrollTop = chatBox.scrollHeight; }
// True when the view is at (or within a small threshold of) the bottom. Used to decide whether a
// streamed render should keep following the answer: if the user has scrolled up to re-read earlier
// messages, we must NOT yank them back down on every frame. When they scroll back to the bottom this
// returns true again and auto-follow resumes.
function isNearBottom(threshold = 80) {
  return chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < threshold;
}

let thinkingRow = null;
// A single visually-hidden polite live region so a screen reader hears status that is otherwise only
// visual — the answer starting to generate, and finishing. The streamed answer text itself is not a
// live region (that would read every token); only these boundaries are announced. Created lazily so
// placement and load order don't matter.
let _liveRegion = null;
function announce(msg) {
  try {
    if (!_liveRegion) {
      _liveRegion = document.getElementById('a11y-live')
        || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'a11y-live', className: 'sr-only' }));
      _liveRegion.setAttribute('aria-live', 'polite');
      _liveRegion.setAttribute('aria-atomic', 'true');
    }
    _liveRegion.textContent = '';
    _liveRegion.textContent = String(msg || '');
  } catch { /* best-effort — announcements are non-essential */ }
}

function showThinking() {
  turnActive = true;   // a turn is now in flight — keep the heartbeat from re-enabling the composer mid-turn
  turnFinalized = false;
  clearStopRequest();
  refreshSendButton(); // the same control is now Stop
  armTurnWatchdog();   // start the slow-turn notice; liveness signals (tokens/progress) push it forward
  hideThinking();
  hideEmptyState();
  announce('Generating an answer. Press Stop to cancel.');
  thinkingRow = document.createElement('div');
  thinkingRow.className = 'msg-row bot';
  const bubble = document.createElement('div');
  bubble.className = 'bubble thinking';
  bubble.setAttribute('role', 'status');
  bubble.setAttribute('aria-label', 'Generating an answer');
  bubble.innerHTML = '<span></span><span></span><span></span>';
  thinkingRow.appendChild(bubble);
  chatBox.appendChild(thinkingRow);
  // The composer was just disabled for the turn, so its focus dropped to <body>. Anchor focus on this
  // status bubble instead, so a keyboard user isn't left on the body mid-generation; focus returns to the
  // composer when the answer completes (setInputState(false, true)). Never steal focus from a panel the
  // user is actively using — isTypingElsewhere() is false only when focus is on the composer or the body.
  if (!isTypingElsewhere()) {
    bubble.setAttribute('tabindex', '-1');
    try { bubble.focus({ preventScroll: true }); } catch {}
  }
  scrollToBottom();
}
// Replace the animated dots with a status line (used for long operations like
// workspace synthesis and deep research, so the user sees what it's doing instead of an
// opaque wait). Only updates the bubble that is already on screen: a progress event that
// arrives after the answer has begun streaming must never create a second bubble above it.
function setThinkingStatus(text) {
  if (!thinkingRow) return;
  const bubble = thinkingRow.querySelector('.bubble');
  if (bubble) {
    bubble.classList.remove('thinking');
    // Drop the static aria-label so the role="status" live region announces the changing progress text
    // (an aria-label would otherwise pin the accessible name to "Generating an answer" and silence the
    // per-document synthesis updates for a screen-reader user).
    bubble.removeAttribute('aria-label');
    bubble.textContent = text;
  }
  scrollToBottom();
}
function hideThinking() {
  if (thinkingRow) { thinkingRow.remove(); thinkingRow = null; }
}

// Safety cap on retained message rows. Chat rows accumulate for the whole conversation (only "New
// conversation" clears them), each carrying its bubble plus per-answer source pills, hover-preview
// wiring, and any faith panel. Over a very long session that unbounded DOM makes scrolling and
// rendering progressively janky on modest hardware and phones. Trimming the oldest rows at each new
// turn bounds it; the limit is generous so a normal conversation is never touched, and the full
// history is still on the server. Trimming happens before a new turn, so no in-flight row is removed.
const MAX_MSG_ROWS = 400;   // ~200 turns
function capChatDom() {
  const rows = chatBox.querySelectorAll('.msg-row');
  if (rows.length <= MAX_MSG_ROWS) return;
  const cutoff = rows[rows.length - MAX_MSG_ROWS];   // the oldest message row we KEEP
  // Remove every child of the chat box before the cutoff row. That drops the old message rows AND the
  // per-answer sibling blocks (the "sources", "answer-meta", and "similar" rows are direct children of
  // the chat box, not nested in a message row), so trimming actually bounds the DOM and never leaves an
  // orphan block with no question/answer above it. Preserve the empty-state placeholder, which must stay
  // in the DOM for the "New conversation" reset to reuse.
  let node = chatBox.firstChild;
  while (node && node !== cutoff) {
    const next = node.nextSibling;
    if (node.nodeType === 1 && node.id !== 'empty-state') node.remove();
    node = next;
  }
}
function appendUserMessage(text) {
  hideEmptyState();
  capChatDom();   // drop the oldest turns first, so a marathon session can't grow the DOM without bound
  const row    = document.createElement('div'); row.className = 'msg-row user';
  const bubble = document.createElement('div'); bubble.className = 'bubble';
  bubble.textContent = text;
  row.appendChild(bubble); chatBox.appendChild(row); scrollToBottom();
}
function createBotBubble() {
  hideEmptyState();
  const row    = document.createElement('div'); row.className = 'msg-row bot';
  const bubble = document.createElement('div'); bubble.className = 'bubble streaming';
  bubble.setAttribute('dir', 'auto');   // right-to-left answers (Arabic/Hebrew) align and order correctly

  row.appendChild(bubble); chatBox.appendChild(row);
  return bubble;
}
function appendError(msg) {
  const row = document.createElement('div'); row.className = 'msg-row error-row';
  const b   = document.createElement('div'); b.className = 'error-bubble';
  b.setAttribute('role', 'alert');   // assertively announced to screen readers
  b.textContent = '⚠ ' + msg;
  row.appendChild(b); chatBox.appendChild(row); scrollToBottom();
}
// A quiet, non-error status row for a turn the user ended (Stop). Kept out of the answer bubble so
// Copy/Download still reproduce only the answer text. Announcement is handled by the shared live
// region in finalizeTurn, so this row is plain content (a freshly inserted role=status node is not
// reliably announced by every screen reader). dir="auto" keeps it correct in a right-to-left page.
function appendNotice(msg) {
  if (!msg) return;
  const row = document.createElement('div'); row.className = 'msg-row notice-row';
  const b   = document.createElement('div'); b.className = 'notice-bubble';
  b.setAttribute('dir', 'auto');
  b.textContent = msg;
  row.appendChild(b); chatBox.appendChild(row); scrollToBottom();
}

// One source of truth for file-type icons, mapping a file extension/type to a sprite id (see icons.ejs). The
// document list, the source pills, and the "answered from" chips all render through fileIconSvg, so they stay in
// sync and show the same themeable icon on every OS — unlike the old per-type color emoji, which varied by
// platform. Text documents (pdf/docx/txt/md/log) share one doc icon; structurally-different kinds get their own.
const FILE_ICON_ID = {
  pdf: 'ic-file-text', docx: 'ic-file-text', txt: 'ic-file-text', md: 'ic-file-text', log: 'ic-file-text',
  pptx: 'ic-file-slides',
  csv: 'ic-file-sheet', tsv: 'ic-file-sheet', xlsx: 'ic-file-sheet', xlsm: 'ic-file-sheet',
  epub: 'ic-file-book', json: 'ic-file-code',
  html: 'ic-web', htm: 'ic-web', web: 'ic-web',
  jpg: 'ic-image', jpeg: 'ic-image', png: 'ic-image', gif: 'ic-image', webp: 'ic-image', bmp: 'ic-image', tiff: 'ic-image', tif: 'ic-image', heic: 'ic-image', svg: 'ic-image',
};
// Inline SVG markup for a file-type icon, safe to drop into innerHTML (the id is from the fixed map above, never
// user input). `type` is an extension or fileType in any case; an unknown type falls back to a generic file icon.
const fileIconSvg = (type) => `<svg class="ico file-ico" aria-hidden="true"><use href="#${FILE_ICON_ID[String(type || '').toLowerCase()] || 'ic-file'}"/></svg>`;

// Build the in-app viewer href for a source (local viewer link with the cited passage range, or a
// web URL). Shared by the citation pills and the "answered from" strip so the open behavior is
// defined once. Returns '#' for anything that isn't a safe, known scheme.
function srcHref(src) {
  if (!src) return '#';
  if (src.isWeb) { const wu = src.url || src.viewerLink || ''; return SAFE_URL_SCHEME.test(String(wu).trim()) ? wu : '#'; }
  let href = src.viewerLink || '';
  if (src.passageEnd > src.passageStart) { const sep = href.includes('?') ? '&' : '?'; href += `${sep}start=${src.passageStart}&end=${src.passageEnd}`; }
  // Carry the window's workspace so the viewer serves the document from THAT workspace's folder — a
  // source cited by a non-active-workspace answer lives outside the active workspace's documents dir.
  const w = currentWorkspaceId();
  if (w) { const sep = href.includes('?') ? '&' : '?'; href += `${sep}workspace=${encodeURIComponent(w)}`; }
  return SAFE_URL_SCHEME.test(String(href).trim()) ? href : '#';
}

// ── Citation preview (hover/focus card) ──────────────────────────────────────
// One reusable card previews a citation without opening it: the source title, where in the document
// it came from, how strongly it matched, and a snippet of the exact cited passage. It is a pointer /
// keyboard enhancement — on touch, tapping a citation opens the full in-app viewer instead, so this
// never blocks or duplicates that. Built once and repositioned, so every citation shares one node.
let _srcPreviewEl = null, _srcPreviewHideTimer = null, _srcPreviewAnchor = null;
function srcPreviewEl() {
  if (_srcPreviewEl) return _srcPreviewEl;
  const el = document.createElement('div');
  el.className = 'src-preview hidden';
  el.id = 'src-preview';               // referenced by the active citation's aria-describedby
  el.setAttribute('role', 'tooltip');
  el.addEventListener('mouseenter', () => clearTimeout(_srcPreviewHideTimer));
  el.addEventListener('mouseleave', hideSourcePreview);
  document.body.appendChild(el);
  _srcPreviewEl = el;
  return el;
}
function hideSourcePreview() {
  clearTimeout(_srcPreviewHideTimer);
  _srcPreviewHideTimer = setTimeout(() => {
    if (_srcPreviewEl) _srcPreviewEl.classList.add('hidden');
    // Drop the link from whichever citation last described itself with the card.
    if (_srcPreviewAnchor) { try { _srcPreviewAnchor.removeAttribute('aria-describedby'); } catch { /* gone */ } _srcPreviewAnchor = null; }
  }, 120);
}
function showSourcePreview(anchor, src) {
  const el = srcPreviewEl();
  clearTimeout(_srcPreviewHideTimer);
  // Point the citation at the tooltip so a screen reader announces the preview on focus.
  if (_srcPreviewAnchor && _srcPreviewAnchor !== anchor) { try { _srcPreviewAnchor.removeAttribute('aria-describedby'); } catch { /* gone */ } }
  _srcPreviewAnchor = anchor;
  try { anchor.setAttribute('aria-describedby', 'src-preview'); } catch { /* best-effort */ }
  let loc = '';
  if (src.isWeb) { loc = webHost(src); }
  else if (src.docLength > 0 && src.passageEnd > 0) loc = `~${Math.round((src.passageStart / src.docLength) * 100)}% through the document`;
  const confLabel = CONFIDENCE_LABELS[src.confidence] || '';
  // Credibility tier for a web source (whitelisted class, never built from raw text).
  const tierCls = { official: 'tier-official', trusted: 'tier-trusted', community: 'tier-community' }[src.tier] || '';
  const tierLabel = (src.isWeb && src.tierLabel && tierCls) ? src.tierLabel : '';
  const credLabel = (src.credibility && Array.isArray(src.credibility.labels) && src.credibility.labels.length)
    ? src.credibility.labels.join(' · ') : '';
  const body = (src.snippet && src.snippet.trim()) || (src.text && src.text.trim()) || '';
  el.innerHTML =
    `<div class="src-preview-title">${escapeHtml(src.source || (src.isWeb ? 'Web source' : 'Source'))}</div>` +
    (loc || confLabel || tierLabel || credLabel
      ? `<div class="src-preview-meta">${loc ? `<span>${escapeHtml(loc)}</span>` : ''}${confLabel ? `<span class="src-preview-conf ${confClass(src.confidence)}">${escapeHtml(confLabel)}</span>` : ''}${tierLabel ? `<span class="src-preview-tier ${tierCls}">${escapeHtml(tierLabel)}</span>` : ''}${credLabel ? `<span class="src-preview-cred">${escapeHtml(credLabel)}</span>` : ''}</div>`
      : '') +
    (body
      ? `<div class="src-preview-snip">${escapeHtml(truncate(body, 260))}</div>`
      : `<div class="src-preview-snip src-preview-empty">Open the citation to view the source.</div>`) +
    `<div class="src-preview-hint">Click to open</div>`;
  el.classList.remove('hidden');
  positionSourcePreview(el, anchor);
}
function positionSourcePreview(el, anchor) {
  // Fixed to the viewport so it escapes the scrolling chat and any overflow clipping; it prefers to
  // sit above the citation, flips below when there isn't room, and clamps horizontally to stay on
  // screen. Pure geometry, no dependencies — identical across browsers.
  const r = anchor.getBoundingClientRect();
  const pw = el.offsetWidth, ph = el.offsetHeight, margin = 8;
  const left = Math.min(Math.max(margin, r.left), Math.max(margin, window.innerWidth - pw - margin));
  let top = r.top - ph - margin;
  if (top < margin) top = r.bottom + margin;
  // Clamp vertically so a tall card near a short viewport's edge stays fully on screen.
  top = Math.max(margin, Math.min(top, window.innerHeight - ph - margin));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}
function attachSourcePreview(el, src) {
  if (!el || !src) return;
  el.addEventListener('mouseenter', () => showSourcePreview(el, src));
  el.addEventListener('mouseleave', hideSourcePreview);
  el.addEventListener('focus', () => showSourcePreview(el, src));
  el.addEventListener('blur', hideSourcePreview);
}
// Escape hides the preview (matching the app's other dismissals); a scroll or resize dismisses it so
// it can never float detached from its citation.
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideSourcePreview(); });
window.addEventListener('scroll', () => { if (_srcPreviewEl && !_srcPreviewEl.classList.contains('hidden')) _srcPreviewEl.classList.add('hidden'); }, true);
window.addEventListener('resize', () => { if (_srcPreviewEl) _srcPreviewEl.classList.add('hidden'); });

function appendSources(sources, stats) {
  if (!sources || !sources.length) return;
  // Advisory credibility labels computed at index time (preprint host/DOI, retraction/concern language). The
  // short pill text and the explanation come from the server's one flag catalog, so adding a flag needs no
  // change here; a restored older session without shortLabels falls back to the flag id.
  const credibilityTag = (src) => {
    const c = src && src.credibility;
    const flags = (c && Array.isArray(c.flags)) ? c.flags.slice(0, 2) : [];
    if (!flags.length) return { html: '', title: '' };
    const short = Array.isArray(c.shortLabels) ? c.shortLabels : [];
    const title = (Array.isArray(c.labels) && c.labels.length) ? c.labels.join(' · ') : flags.join(' · ');
    const text = short[0] || flags[0];
    return {
      html: `<span class="pill-cred pill-cred-${escapeHtml(flags[0])}" title="${escapeHtml(title)}">${escapeHtml(text)}</span>`,
      title,
    };
  };
  // Best-effort: the caller (chat_end) re-enables the composer and attaches the answer controls
  // right after this, so a citation-rendering error must never escape and leave the input stuck
  // disabled. Any throw here is logged and contained; the answer text is already rendered.
  try {
  // ONE source presentation per answer: a numbered, clickable row below the answer with the count in
  // its label. The old duplicate "Answered from …" strip above the prose is gone, so the same sources
  // are no longer rendered, styled, and maintained twice.
  const total = sources.length;
  // The independence summary is computed server-side (one definition of publisher/syndication grouping).
  // Only use it for the full list; a capped analysis must not label a larger set.
  const independent = (stats && Number.isFinite(stats.independent) && stats.total === total) ? stats.independent : 0;
  const showIndep = independent > 0 && independent < total;
  const row = document.createElement('div'); row.className = 'sources-row';
  row.setAttribute('aria-label', `Sources (${total})${showIndep ? `, ${independent} independent` : ''}`);
  const lbl = document.createElement('span'); lbl.className = 'sources-label';
  lbl.textContent = `Sources (${total})`;
  if (showIndep) {
    const sub = document.createElement('span');
    sub.className = 'sources-sub';
    sub.textContent = ` · ${independent} independent`;
    lbl.appendChild(sub);
    lbl.title = `${total} sources from ${independent} independent source${independent === 1 ? '' : 's'}. Same-publisher pages and syndicated copies count once.`;
  }
  row.appendChild(lbl);
  sources.forEach((src, i) => {
    const pill = document.createElement('a');
    pill.className = 'source-pill';

    // Web sources point at a live external URL and show a globe icon plus the
    // page hostname; local document sources link into the viewer with a passage range.
    if (src.isWeb) {
      pill.classList.add('web-source');
      const wu = src.url || src.viewerLink || '';
      pill.href = SAFE_URL_SCHEME.test(String(wu).trim()) ? wu : '#';   // kept for copy-link; the click opens the in-app viewer
      let host = '';
      host = webHost(src);
      const cred = credibilityTag(src);
      pill.title = src.source + (host ? ` (${host})` : '') + (cred.title ? ` · ${cred.title}` : '');
      pill.innerHTML = `<span class="pill-num">${i + 1}</span><span class="pill-icon">${fileIconSvg('web')}</span><span class="pill-name">${escapeHtml(truncate(src.source || host, 32))}</span>${host ? `<span class="pill-loc">${escapeHtml(host)}</span>` : ''}${cred.html}`;
      // Open in the in-app viewer rather than a new OS window, so it works the same in the
      // browser and the desktop app (where a new window silently does nothing).
      pill.addEventListener('click', (e) => { e.preventDefault(); openSourceViewer(src); });
      attachSourcePreview(pill, src);
      row.appendChild(pill);
      return;
    }

    const cred = credibilityTag(src);
    pill.title  = src.source + (cred.title ? ` · ${cred.title}` : '');
    // The cited passage range travels in the viewer link so the viewer can jump to and highlight it.
    const safeHref = srcHref(src);
    pill.href   = safeHref;   // kept for copy-link; the click opens the in-app viewer
    // Open the document in the in-app viewer (a same-origin iframe) instead of a new window,
    // so a cited source opens identically in the browser and the desktop app.
    pill.addEventListener('click', (e) => { e.preventDefault(); openSourceViewer(src, safeHref); });
    attachSourcePreview(pill, src);
    const icon = fileIconSvg(src.fileType);
    let locationTag = '';
    if (src.docLength > 0 && src.passageEnd > 0) {
      const pct = Math.round((src.passageStart / src.docLength) * 100);
      locationTag = `<span class="pill-loc" title="Jump to cited passage">◆ ~${pct}%</span>`;
    }
    // Retrieval-confidence dot from the cross-encoder score: how strongly this document
    // actually matched. Shown only when the reranker scored it (src.confidence set).
    let confTag = '';
    if (src.confidence) {
      const label = CONFIDENCE_LABELS[src.confidence] || '';
      const score = (typeof src.rerankScore === 'number') ? ` (score ${src.rerankScore})` : '';
      confTag = `<span class="pill-conf ${confClass(src.confidence)}" role="img" title="${escapeHtml(label + score)}" aria-label="${escapeHtml(label)}"></span>`;
    }
    pill.innerHTML = `<span class="pill-num">${i + 1}</span><span class="pill-icon">${icon}</span><span class="pill-name">${escapeHtml(truncate(src.source || 'source', 28))}</span>${confTag}${cred.html}${locationTag}`;
    row.appendChild(pill);

    // Cropped figures/tables from visual ingest: a small toggle that reveals thumbnails of
    // the actual figures in this cited document. Present only when figure cropping is on.
    if (Array.isArray(src.figures) && src.figures.length) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fig-btn';
      btn.innerHTML = `<svg class="ico" aria-hidden="true"><use href="#ic-image"/></svg> ${src.figures.length}`;
      btn.title = `Show ${src.figures.length} figure${src.figures.length === 1 ? '' : 's'} from ${src.source}`;
      btn.setAttribute('aria-expanded', 'false');
      const panel = buildFigurePanel(src);
      btn.addEventListener('click', () => {
        const open = panel.classList.toggle('hidden');
        btn.setAttribute('aria-expanded', String(!open));
        if (!open) scrollToBottom();
      });
      row.appendChild(btn);
      // The panel is appended after the sources row so the thumbnails get full width.
      row.appendChild(panel);
    }
  });
  chatBox.appendChild(row); scrollToBottom();
  } catch (e) { console.error('appendSources failed:', e); }
}

// ── In-app source viewer ─────────────────────────────────────────────────────
// Opening a cited source stays inside the app so it behaves the same in the browser and the
// desktop app (a new OS window silently does nothing in the desktop webview). A LOCAL document
// is shown in a same-origin iframe of the existing viewer page; a WEB result is shown as a clean
// reader of the readable text Lokyni already fetched, with a link to the live original.
const sourceOverlay = document.getElementById('source-overlay');
const sourceFrame = document.getElementById('source-frame');
const sourceReader = document.getElementById('source-reader');
const sourceTitle = document.getElementById('source-title');
const sourceOpenOriginal = document.getElementById('source-open-original');

function closeSourceViewer() {
  if (!sourceOverlay) return;
  sourceOverlay.classList.add('hidden');
  // Release the iframe so an embedded document (e.g. a PDF) stops loading in the background.
  if (sourceFrame) { sourceFrame.classList.add('hidden'); sourceFrame.src = 'about:blank'; }
  if (sourceReader) { sourceReader.classList.add('hidden'); sourceReader.innerHTML = ''; }
}

function openSourceViewer(src, docHref) {
  if (!sourceOverlay || !src) return;
  sourceTitle.textContent = src.source || (src.isWeb ? 'Web source' : 'Source');
  sourceFrame.classList.add('hidden');
  sourceReader.classList.add('hidden');
  sourceOpenOriginal.classList.add('hidden');

  if (src.isImage) {
    // A cited figure/table crop, shown in the in-app overlay rather than a new OS window — so it
    // works the same in the browser and the desktop app (where target="_blank" does nothing). The
    // image element is built via the DOM (src set as a property) so the URL can't inject markup.
    sourceReader.innerHTML = '';
    const wrap = document.createElement('div'); wrap.className = 'sr-figure';
    const img = document.createElement('img');
    img.src = src.url; img.alt = src.source || 'figure'; img.loading = 'lazy';
    wrap.appendChild(img);
    sourceReader.appendChild(wrap);
    sourceReader.scrollTop = 0;
    sourceReader.classList.remove('hidden');
    // No "Open original" link here: the crop is a same-origin /api/figure URL that a target="_blank"
    // cannot open in the desktop webview, and the full crop is already shown in the overlay.
  } else if (src.isWeb) {
    let host = '';
    host = webHost(src);
    const body = (src.text && src.text.trim()) || (src.snippet && src.snippet.trim()) || '';
    sourceReader.innerHTML =
      (host ? `<div class="sr-host">${escapeHtml(host)}</div>` : '') +
      (body
        ? `<div class="sr-body">${escapeHtml(body)}</div>`
        : `<div class="sr-empty">No readable text was captured for this page. Use “Open original” to view it in your browser.</div>`);
    sourceReader.scrollTop = 0;
    sourceReader.classList.remove('hidden');
    const wu = src.url || '';
    if (SAFE_URL_SCHEME.test(String(wu).trim())) { sourceOpenOriginal.href = wu; sourceOpenOriginal.classList.remove('hidden'); }
  } else {
    let href = (docHref && docHref !== '#') ? docHref : (src.viewerLink || '');
    // Scheme-guard the fallback too, matching the rest of the URL hardening (viewerLink is a
    // server-generated relative path, so this passes; a malformed one is refused).
    if (!href || !SAFE_URL_SCHEME.test(String(href).trim())) return;
    const sep = href.includes('?') ? '&' : '?';
    // Escape from INSIDE the same-origin iframe: its keydown doesn't reach the parent's global
    // handler, so close the overlay from the embedded document too once it loads.
    sourceFrame.onload = () => {
      try { sourceFrame.contentDocument?.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSourceViewer(); }); }
      catch { /* cross-origin (not expected for the same-origin viewer) */ }
    };
    sourceFrame.src = `${href}${sep}embed=1`;   // embed=1 hides the viewer page's own toolbar
    sourceFrame.classList.remove('hidden');
  }
  sourceOverlay.classList.remove('hidden');
}
document.getElementById('source-close')?.addEventListener('click', closeSourceViewer);
sourceOverlay?.addEventListener('click', (e) => { if (e.target === sourceOverlay) closeSourceViewer(); });

// A hidden strip of figure thumbnails for one cited document. Each thumbnail links to the
// full-size crop (served from /api/figure/<id>) and shows its label + a short caption.
function buildFigurePanel(src) {
  const panel = document.createElement('div');
  panel.className = 'figures-panel hidden';
  src.figures.forEach((f) => {
    if (!f || !f.url || !SAFE_URL_SCHEME.test(String(f.url).trim())) return;
    const fig = document.createElement('figure');
    fig.className = 'figure-thumb';
    const labelPart = f.label ? f.label : (f.type ? f.type[0].toUpperCase() + f.type.slice(1) : 'Figure');
    const captionText = labelPart + (f.page ? ` · p.${f.page}` : '');
    // Name the window's workspace on the crop URL, exactly as the viewer link does, so a window viewing a
    // non-active workspace loads THAT workspace's figures (the server resolves and authorizes ?workspace).
    const furl = f.url + wsQuery(f.url.includes('?') ? '&' : '?');
    const a = document.createElement('a');
    // The href is kept so right-click "Save image" still works; a normal click opens the full crop
    // in the in-app viewer instead of a new OS window (which does nothing in the desktop app).
    a.href = furl;
    a.addEventListener('click', (e) => { e.preventDefault(); openSourceViewer({ isImage: true, url: furl, source: captionText }); });
    const img = document.createElement('img');
    img.src = furl; img.loading = 'lazy'; img.alt = f.label || 'figure';
    // If a crop failed to load (e.g. a wiped figures dir), hide the broken thumbnail.
    img.addEventListener('error', () => { fig.style.display = 'none'; });
    a.appendChild(img);
    const cap = document.createElement('figcaption');
    cap.textContent = captionText;
    cap.title = f.label || '';
    fig.appendChild(a); fig.appendChild(cap);
    panel.appendChild(fig);
  });
  return panel;
}

function truncate(name, max) {
  if (name.length <= max) return name;
  const ext = name.lastIndexOf('.');
  if (ext > 0) {
    const base = name.slice(0, ext), e = name.slice(ext);
    return base.slice(0, max - e.length - 1) + '…' + e;
  }
  return name.slice(0, max - 1) + '…';
}

// ── Socket messages ──
socket.on(TURN_PROTOCOL.progress, (data) => {
  // Live progress for a long-running turn (workspace synthesis, deep research, retrieval
  // stages): show what it's working on in the thinking bubble. Superseded automatically
  // once answer text streams in. Also counts as liveness for the slow-turn notice.
  if (data && data.text) { _turnStage = String(data.text); setThinkingStatus(data.text); }
  armTurnWatchdog();
});
// The server's stall attribution: it names the stage a turn has been quiet in for too long. Surface it
// immediately (rather than waiting for the client's own 2-minute notice), once per stage, and keep the turn
// live — a late token still lands in the same bubble.
socket.on('turn_stall', (data) => {
  if (!turnActive || !data) return;
  const stage = String(data.stage || _turnStage || '').trim();
  const label = stage ? `Still working — ${stage.replace(/…$/, '')} is taking longer than usual.` : TURN_SLOW_NOTICE;
  if (_turnStallNoticed === label) return;
  _turnStallNoticed = label;
  if (!isStreaming) setThinkingStatus(label);
  announce(label);
});
// The 'message' channel now carries ONLY answer text. Stream-control signals travel on
// their own events (chat_end, chat_retry) so no document text — or an answer quoting one
// — can be mistaken for a control token and end or blank the chat.
socket.on('message', (data) => {
  // Ignore a stray or reordered chunk that arrives AFTER the turn already ended (chat_end cleared
  // turnActive): without this it would spawn a phantom empty bubble and flip the composer state back
  // to disabled — and, because it wouldn't re-set turnActive, the 2s heartbeat could then re-enable
  // the composer mid-phantom-stream. Every streaming path sets turnActive via showThinking() before
  // the first chunk, so a legitimate token is never dropped here.
  if (!turnActive) return;
  if (!isStreaming || !currentBubble) {
    hideThinking();
    isStreaming = true;
    currentBubble = createBotBubble();
    setInputState(true);
  } else if (currentBubble?.classList.contains('retrying')) {
    // First chunk of retry — leave retrying class, streaming will replace it
    currentBubble.classList.remove('retrying');
    currentBubble.classList.add('streaming');
  }
  armTurnWatchdog();   // a live token arrived — push the no-response watchdog forward
  // The channel carries answer TEXT; coerce defensively so a non-string emit can never concatenate
  // "[object Object]" into the rendered answer.
  messageBuffer += (typeof data === 'string' ? data : String(data ?? ''));
  // Coalesce rendering to at most once per animation frame. Re-parsing the whole
  // Markdown buffer and rebuilding the bubble on every token is O(n²) over a long
  // answer and janks the page on modest hardware; one render per frame is smooth and
  // still visually live. The final, authoritative render happens on chat_end.
  scheduleStreamRender();
});
let _streamRenderQueued = false;
function scheduleStreamRender() {
  if (_streamRenderQueued) return;
  _streamRenderQueued = true;
  requestAnimationFrame(() => {
    _streamRenderQueued = false;
    if (!currentBubble) return;               // stream already ended — chat_end rendered the final text
    // Only auto-follow if the user is already at the bottom. Checked BEFORE the innerHTML update, since
    // appending content changes scrollHeight. This lets the user scroll up to read history mid-stream
    // without being dragged back down ~60x/second.
    const stick = isNearBottom();
    currentBubble.innerHTML = marked.parse(messageBuffer);
    if (stick) scrollToBottom();
  });
}
// The answer is complete: finalize the bubble, render its sources, and attach the meta
// controls (rating / "why" / faithfulness) that were buffered while streaming.
socket.on('answer_final', (t) => { pendingFinal = typeof t === 'string' ? t : null; });
// One turn ends through exactly one of these events. `chat_end` is the normal terminal signal;
// `chat_stopped` is the server's confirmation that a user Stop ended it. They share this finalizer so
// the bubble, sources, meta controls, and composer state can never behave differently between them.
// A turn that ended by New or disconnect has already reset locally, and a stray duplicate terminal
// event is ignored (turnFinalized), so no answer is finalized twice.
function finalizeTurn({ stopped = false } = {}) {
  if (turnFinalized) return;
  turnFinalized = true;
  clearStopRequest();
  turnActive = false;   // the turn is over — the heartbeat may re-enable the composer again
  clearTurnWatchdog();
  hideThinking();
  try {
  // A stop can land before the first token, in which case there is no bubble and no text to copy or
  // read back. Remember that so a stopped thinking-phase turn never reuses the previous answer's text
  // (Copy/Download are deduped, but hands-free would otherwise speak the prior answer aloud).
  const producedText = !!currentBubble;
  let answerRow = null;
  if (currentBubble) {
    answerRow = currentBubble.parentElement;
    currentBubble.classList.remove('streaming');
    // If the server's verification pass cleaned/corrected the answer, render that instead
    // of the raw streamed text — so a redaction or fix the user sees matches what's stored.
    if (pendingFinal !== null) messageBuffer = pendingFinal;
    currentBubble.innerHTML = marked.parse(messageBuffer);
    // Snapshot the finalized answer text before clearing it, so the "Copy" control (attached
    // below in applyPendingMeta) can reconstruct the answer as Markdown for the clipboard.
    lastAnswerText = messageBuffer;
    currentBubble = null; messageBuffer = ''; isStreaming = false;
  }
  // Mark the row as a finalized answer and carry the server-detected language in the DOM. This is the
  // single source the read-aloud sweep reads, so live answers finalized before the feature was enabled (and
  // restored answers) can get the control later without a reload or a second copy of the answer text.
  if (answerRow) {
    answerRow.dataset.answer = '1';
    answerRow.dataset.answerLang = pendingAnswerLang || '';
  }
  pendingFinal = null;
  // Snapshot the sources that belong to THIS answer before they're consumed, so the copy
  // control can append them as a source list.
  lastAnswerSources = Array.isArray(pendingSources) ? pendingSources.slice() : [];
  if (pendingSources) { appendSources(pendingSources, pendingSourceStats); pendingSources = null; pendingSourceStats = null; }
  // Let a screen reader know the answer is done and how many sources it drew on (the streamed text
  // itself is not announced token-by-token).
  const _nSrc = lastAnswerSources.length;
  if (stopped) {
    // A Stop keeps whatever had streamed so far, but does not pretend it is a finished answer:
    // no "ready" announcement, and a quiet centered notice below it. The notice is a separate row
    // so Copy/Download still reproduce only the answer text.
    announce('Answer stopped.');
    appendNotice('Stopped.');
  } else {
    announce(_nSrc ? `Answer ready, from ${_nSrc} source${_nSrc === 1 ? '' : 's'}.` : 'Answer ready.');
  }
  // Only attach answer controls (and trigger a hands-free read-back) when this turn actually produced
  // text. A Stop during the thinking phase has nothing to act on.
  if (!stopped || producedText) applyPendingMeta();
  // Remember which answer any late-arriving follow-up suggestions and Verify badge belong to. They
  // come on their own events after this turn ends (small post-answer LLM calls), so pin the row and
  // this turn's id now; a result for a different turn is ignored. pendingTurnId was set by the
  // 'answer_turn' event the server sends just before chat_end — ONLY on an answered turn. When it's
  // null (an unanswered turn: refusal, web offer, clarify, empty workspace), leave the target empty so
  // a prior answered turn's late payload can't misattach to this row.
  if (!stopped && pendingTurnId != null) {
    // Suggestions attach to the answer's meta block (below the action strip); the Verify badge attaches
    // to the action strip itself. Both are stable containers, never the sources row.
    suggestTargetRow  = lastAnswerMetaRow();
    faithTargetRow    = lastAnswerRow();
    confTargetRow     = lastAnswerRow();
    suggestTargetTurn = pendingTurnId;
    faithTargetTurn   = pendingTurnId;
    confTargetTurn    = pendingTurnId;
  } else {
    suggestTargetRow = null; faithTargetRow = null; confTargetRow = null;
    suggestTargetTurn = null; faithTargetTurn = null; confTargetTurn = null;
  }
  } catch (e) {
    // A render or meta-attach error (e.g. marked.parse, applyPendingMeta) must never leave the composer
    // disabled — the finally always re-enables it, matching appendSources' own fault-isolated contract.
    try { console.error('Turn finalize failed:', e); } catch {}
  } finally {
    // The answer is complete, so returning the cursor to the chat box is welcome.
    setInputState(false, true); scrollToBottom();
  }
}
socket.on(TURN_PROTOCOL.end, (payload) => {
  // Some answer paths (the single-document summary) have no answer_turn event, so chat_end can carry the
  // answer language. Read it before finalizing: applyPendingMeta attaches Read aloud during finalizeTurn.
  const lang = payload && typeof payload === 'object' && typeof payload.language === 'string' ? payload.language : '';
  const langCode = normalizeLanguageCode(lang);
  if (langCode) pendingAnswerLang = langCode;
  finalizeTurn({ stopped: false });
});
socket.on(TURN_PROTOCOL.stopped, () => {
  // A stop confirmation that arrives after the turn already ended normally is stale; clear the
  // pending button state but leave the finished answer alone.
  if (!turnActive) { clearStopRequest(); refreshSendButton(); return; }
  finalizeTurn({ stopped: true });
});
// Server is retrying — show spinner instead of clearing/reflashing the bubble.
socket.on('chat_retry', () => {
  if (currentBubble) {
    currentBubble.classList.remove('streaming');
    currentBubble.classList.add('retrying');
    currentBubble.innerHTML = '';
  }
  messageBuffer = '';
});
socket.on('sources', (s) => { pendingSources = s; });
socket.on('error', (msg) => {
  hideThinking();
  appendError(typeof msg === 'string' ? msg : 'An error occurred.');
  setInputState(false);
  resetStreaming();
});

// ── Document Manager ──
const dropZone       = document.getElementById('drop-zone');
const fileInput      = document.getElementById('file-input');
const uploadProgress = document.getElementById('upload-progress');
const docListWrap    = document.getElementById('doc-list-wrap');
const docListEmpty   = document.getElementById('doc-list-empty');
const docSearchInput = document.getElementById('doc-search-input');
const docSearchClear = document.getElementById('doc-search-clear');
let _docFilterTimer = null;

// Fold a name/path for a language-agnostic filter. NFKD decomposes accents and compatibility forms
// (full-width Latin, ligatures), stripping combining marks makes "café" match "cafe", and lowercasing
// makes the match case-insensitive. Matching is plain substring + AND across whitespace-separated
// tokens — no word-boundary assumptions, so scripts without spaces (Chinese, Japanese, Thai) work too.
// NFKD is not locale-sensitive, unlike toLocaleLowerCase(), so the result is stable across machines.
function foldDocText(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
// Bound a string by CODE POINTS (never splitting a surrogate pair), for a pasted query's stored work
// and its on-screen echo. Iterating stops as soon as the limit is reached, so a multi-megabyte paste
// never allocates an array of every character just to slice it.
const clipCodePoints = (text, max) => {
  let out = '';
  let n = 0;
  for (const ch of String(text || '')) {
    if (n >= max) break;
    out += ch;
    n++;
  }
  return out;
};
function docSearchTokens() {
  return foldDocText(clipCodePoints(docFilterQuery, 256)).split(' ').filter(Boolean);
}
function docMatchesFilter(doc, tokens) {
  if (!tokens.length) return true;
  // Cache the folded haystack on the loaded object: the list is rebuilt on every status heartbeat, and
  // re-normalizing every path on each keystroke would do needless work on a large library.
  if (!doc._searchText) doc._searchText = foldDocText(`${doc.name || ''} ${doc.relPath || ''}`);
  return tokens.every((token) => doc._searchText.includes(token));
}
// Apply a filter query. The input is the source; docFilterQuery is only the last applied value so a
// heartbeat re-render can reproduce the filtered view without reading the DOM.
function setDocFilter(value, { render = true } = {}) {
  if (_docFilterTimer) { clearTimeout(_docFilterTimer); _docFilterTimer = null; }
  docFilterQuery = String(value || '');
  if (docSearchInput && docSearchInput.value !== docFilterQuery) docSearchInput.value = docFilterQuery;
  if (docSearchClear) docSearchClear.hidden = !docFilterQuery.trim();
  if (render) renderDocList();
}
function clearDocFilter({ focus = false } = {}) {
  if (_docFilterTimer) { clearTimeout(_docFilterTimer); _docFilterTimer = null; }
  setDocFilter('');
  if (focus && docSearchInput) { try { docSearchInput.focus(); } catch { /* best-effort */ } }
}
// A workspace switch changes the corpus, so a filter from the previous workspace could hide everything.
// Called when the window starts viewing a different workspace, not on an ordinary list refresh.
function resetDocFilter() {
  if (_docFilterTimer) { clearTimeout(_docFilterTimer); _docFilterTimer = null; }
  setDocFilter('', { render: false });
}

async function loadDocuments() {
  try {
    const res  = await fetch('/api/documents' + wsQuery());
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    docsCache = data.documents || [];   // cached so the # command picker can use it
    renderDocList();
  } catch (e) {
    if (docListEmpty) {
      docListEmpty.textContent = 'Failed to load: ' + e.message;
      docListEmpty.style.display = 'block';
    }
  }
}

function updateFilterBar() {
  const label = document.getElementById('doc-filter-label');
  const btn   = document.getElementById('doc-select-all');
  const fcToggle = document.getElementById('doc-fullcontext-toggle');
  if (!label || !btn) return;
  const total = Array.isArray(docsCache) ? docsCache.length : 0;
  const shown = docListWrap ? docListWrap.querySelectorAll('.doc-item').length : 0;
  const filtering = !!docFilterQuery.trim();
  if (docSearchClear) docSearchClear.hidden = !filtering;
  if (selectedDocIds.size === 0) {
    label.textContent = filtering ? `Showing ${shown} of ${total}` : 'All documents';
    label.className = filtering ? 'filtered' : '';
    // When a filter is active, "Select all" selects only what the user can see. Say so, and say it in
    // the button itself so the scope is clear before the click rather than after.
    btn.textContent = filtering ? 'Select shown' : 'Select all';
    btn.title = filtering ? 'Focus every document shown by the current filter' : 'Select all / none';
    btn.disabled = shown === 0;   // nothing visible to select (an empty corpus or a no-match filter)
    // Full-Context only applies to a focused selection — hide it (and reset) when
    // nothing is selected, so it can't silently apply to the whole corpus.
    if (fcToggle) fcToggle.classList.add('hidden');
    fullContextMode = false;
    const fcCheck = document.getElementById('doc-fullcontext-check');
    if (fcCheck) fcCheck.checked = false;
  } else {
    label.textContent = `Focused: ${selectedDocIds.size} doc${selectedDocIds.size !== 1 ? 's' : ''}` +
      (filtering ? ` · showing ${shown} of ${total}` : '');
    label.className = 'focused';
    btn.textContent = 'Clear';
    btn.title = 'Clear the focused selection';
    btn.disabled = false;
    if (fcToggle) fcToggle.classList.remove('hidden');
  }
}

// The supported-format list, sourced from the server (a meta tag set from the single constants list)
// so a client hint can never drift from what the extractor accepts. Falls back to a generic phrase.
const SUPPORTED_FORMATS = (document.querySelector('meta[name="lokyni-ext-label"]') || {}).content
  || 'common text, PDF, Office, and image files';
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Format a timestamp for display, guarding an absent or invalid value with a fallback so a bad date never
// renders as "Invalid Date". `dateOnly` uses the shorter date-only form. Shared by the API-key, logs, audit,
// workspace, scheduler, and inbox views, which each formatted dates with the same inline NaN guard before this.
function fmtWhen(ts, fallback = '', dateOnly = false) {
  if (ts == null || ts === '') return fallback;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return fallback;
  return dateOnly ? d.toLocaleDateString() : d.toLocaleString();
}
// Escape a string for safe literal use inside a RegExp — shared so the character class isn't copied
// incompletely to a call site (an incomplete class is a silent correctness / ReDoS bug).
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Map a confidence value to a safe CSS class. The class comes from the server-projected vocabulary
// (SETTINGS_META.confidenceLevels[level].cls) — the SAME single source the answer-confidence chip uses — so
// the per-citation match-strength dot and the chip can never drift. The inline object is only a fallback for
// before the settings projection has loaded. Either way this is a fixed lookup over known levels, never
// interpolation of the raw value, so it can't become attribute injection if that ever carried free text.
const confClass = (c) => {
  const levels = (typeof SETTINGS_META !== 'undefined' && SETTINGS_META && SETTINGS_META.confidenceLevels) || null;
  if (levels && levels[c] && typeof levels[c].cls === 'string') return levels[c].cls;
  return ({ high: 'conf-high', medium: 'conf-medium', low: 'conf-low' }[c] || '');
};
// One place for the human labels shown on every confidence badge (the source preview card and the
// source pill), so the two cannot drift apart.
const CONFIDENCE_LABELS = { high: 'Strong match', medium: 'Moderate match', low: 'Weak match' };

// Harden marked against XSS. Chat answers are model output grounded in documents and
// (optionally) web pages — untrusted content that a crafted file/page could use to smuggle
// HTML or a javascript: link the model echoes back. Escape any raw HTML in the markdown,
// and drop dangerous URL schemes on links; ordinary markdown formatting still renders.
// Applies to every marked.parse call in this file.
// A single leading slash is a same-origin path (allowed); a protocol-relative "//host" points at an
// external origin, so it is rejected — no legitimate link here starts with "//".
const SAFE_URL_SCHEME = /^(https?:|mailto:|tel:|#|\/(?!\/)|\.)/i;
marked.use({ renderer: {
  html: (t) => escapeHtml(typeof t === 'string' ? t : (t && t.text) || ''),
  // Never render an image. A document could induce the model to emit a remote image whose
  // URL smuggles data out (the browser would fetch it on render); show the alt text inert
  // instead. The server also strips these (lib/verify sanitizeEgress); this covers any path
  // that bypasses it (e.g. a restored conversation rendered from history).
  image: (token) => escapeHtml((token && (token.text || token.title)) || '🖼️'),
  link(token) {
    const href = (token && token.href) || '';
    const safe = SAFE_URL_SCHEME.test(String(href).trim()) ? href : '#';
    let inner;
    try { inner = this.parser.parseInline(token.tokens); } catch { inner = escapeHtml((token && token.text) || ''); }
    return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
  },
} });

// Folders the user has collapsed, keyed by relative folder path. Module-level so the
// collapse state survives a re-render (a status heartbeat reloads the list often).
const collapsedFolders = new Set();

// Build a nested tree from the documents' relPath. Each node: { name, path, folders:
// Map, files: [] }. A document at the documents-dir root lands in the root node's files;
// one under `_connectors/<id>/` nests two folders deep — so a synced connector or a
// user's own subfolders render as a real tree instead of a flat, path-losing list.
function buildDocTree(docs) {
  const root = { name: '', path: '', folders: new Map(), files: [] };
  for (const doc of docs) {
    const rel = doc.relPath || doc.name;
    const parts = rel.split('/');
    parts.pop();   // drop the filename; the rest are folders
    let node = root, acc = '';
    for (const seg of parts) {
      acc = acc ? acc + '/' + seg : seg;
      if (!node.folders.has(seg)) node.folders.set(seg, { name: seg, path: acc, folders: new Map(), files: [] });
      node = node.folders.get(seg);
    }
    node.files.push(doc);
  }
  return root;
}
const countFilesIn = (node) => node.files.length + [...node.folders.values()].reduce((n, f) => n + countFilesIn(f), 0);
const collectDocIds = (node) => node.files.map(d => d.docId).concat([...node.folders.values()].flatMap(collectDocIds));

// Friendlier label for Lokyni's internal connector-ingest folder at the top level.
const folderLabel = (node, depth) => (depth === 0 && node.name === '_connectors') ? 'Connectors' : node.name;

function createDocItem(doc, depth) {
  const ext     = doc.name.split('.').pop().toLowerCase();
  const icon    = fileIconSvg(ext);
  const sizeStr = doc.size > 1048576 ? (doc.size / 1048576).toFixed(1) + ' MB' : (doc.size / 1024).toFixed(0) + ' KB';
  const item = document.createElement('div');
  item.className = 'doc-item' + (selectedDocIds.has(doc.docId) ? ' selected' : '');
  item.dataset.docId = doc.docId;
  if (depth) item.style.paddingLeft = (8 + depth * 16) + 'px';
  // Each per-row control names the document in its accessible name, exactly as the folder controls
  // name their folder. Without it a screen-reader user tabbing the tree hears the same generic label
  // ("Focus on this document", "Delete") on every row and cannot tell which file a control acts on —
  // the delete case being the most dangerous. The visible filename is a separate element, so it is not
  // the controls' accessible name on its own. doc.name is user-controlled, so it stays escaped.
  const nameAttr = escapeHtml(doc.name);
  // The name is its own link: clicking a document opens it. Selection stays on the checkbox (and on a
  // click elsewhere in the row), so the two actions no longer collide. The link comes from the server's
  // shared viewer builder; the window's workspace is appended exactly as citation links do.
  const viewerHref = doc.viewerLink ? `${doc.viewerLink}${wsQuery('&')}` : '';
  const nameHtml = viewerHref
    ? `<a class="di-name di-open" href="${escapeHtml(viewerHref)}" title="Open this document" aria-label="Open ${nameAttr}" dir="auto">${nameAttr}</a>`
    : `<div class="di-name" title="${nameAttr}" dir="auto">${nameAttr}</div>`;
  item.innerHTML = `
    <input type="checkbox" class="di-check" aria-label="Focus on ${nameAttr}" title="Focus on this document" ${selectedDocIds.has(doc.docId) ? 'checked' : ''}>
    <span class="di-icon" aria-hidden="true">${icon}</span>
    <div class="di-info">
      ${nameHtml}
      <div class="di-meta">${sizeStr}</div>
    </div>
    <span class="di-badge ${doc.indexed ? 'indexed' : 'pending'}">${doc.indexed ? 'indexed' : 'pending'}</span>
    <button class="di-summarize" aria-label="Summarize ${nameAttr}" title="Summarize this document" data-doc-id="${doc.docId}" ${doc.indexed ? '' : 'disabled'}>✦</button>
    <button class="di-del" aria-label="Remove ${nameAttr} from Lokyni" title="Remove from Lokyni" data-path="${escapeHtml(doc.relPath)}">✕</button>
  `;
  const checkbox = item.querySelector('.di-check');
  checkbox.addEventListener('change', (e) => {
    e.stopPropagation();
    if (checkbox.checked) { selectedDocIds.add(doc.docId); item.classList.add('selected'); }
    else { selectedDocIds.delete(doc.docId); item.classList.remove('selected'); }
    syncFolderChecks();
    updateFilterBar();
  });
  item.addEventListener('click', (e) => {
    // The name opens the document, the checkbox selects, and the action buttons do their own job.
    // Anywhere else on the row toggles selection, preserving the existing quick-select behavior.
    if (e.target.closest && e.target.closest('.di-del, .di-summarize, .di-open, .di-check')) return;
    checkbox.checked = !checkbox.checked;
    checkbox.dispatchEvent(new Event('change'));
  });
  const openLink = item.querySelector('.di-open');
  if (openLink) {
    openLink.addEventListener('click', (e) => {
      // Leave modified/middle clicks to the browser so "open in a new tab" still works like a real link.
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      openSourceViewer({ source: doc.name, viewerLink: openLink.getAttribute('href') || '' });
    });
  }
  item.querySelector('.di-del').addEventListener('click', (e) => { e.stopPropagation(); confirmDelete(doc.name, doc.relPath); });
  const sumBtn = item.querySelector('.di-summarize');
  if (sumBtn) sumBtn.addEventListener('click', (e) => { e.stopPropagation(); if (!sumBtn.disabled) summarizeDocument(doc.docId, doc.name); });
  return item;
}

// Reflect each folder checkbox's checked/indeterminate state from its descendants —
// called after any per-document selection change so folder headers stay in sync.
function syncFolderChecks() {
  docListWrap.querySelectorAll('.doc-folder').forEach(header => {
    const ids = (header._docIds || []);
    const sel = ids.filter(id => selectedDocIds.has(id)).length;
    const check = header.querySelector('.df-check');
    if (!check) return;
    check.checked = ids.length > 0 && sel === ids.length;
    check.indeterminate = sel > 0 && sel < ids.length;
  });
}

function renderDocNode(node, container, depth) {
  const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const folder of folders) {
    const collapsed = collapsedFolders.has(folder.path);
    const header = document.createElement('div');
    header.className = 'doc-folder' + (collapsed ? ' collapsed' : '');
    header.style.paddingLeft = (8 + depth * 16) + 'px';
    header.dataset.folderPath = folder.path;   // so focus can be restored to this row after a re-render
    // The row is a plain container: its expand control is a real <button> (the twisty) and its
    // "select all in this folder" control is a real checkbox — two sibling controls. Keeping them
    // siblings (rather than a role="button" row that CONTAINS a focusable checkbox) satisfies ARIA
    // (no focusable descendant inside a button) and gives one clean tab stop per action. A mouse
    // click anywhere on the row (except the checkbox) still toggles, via the row's click handler.
    // Fold the folder name into BOTH controls' accessible names. The twisty carries an aria-label
    // (which overrides its ▾ content) and the checkbox has no visible label, so without this every
    // folder's toggle and checkbox would announce identically and a screen-reader user couldn't tell
    // which folder each acts on.
    const label = folderLabel(folder, depth);
    const labelAttr = escapeHtml(label);
    header.innerHTML = `
      <button type="button" class="df-twisty" aria-label="Toggle folder: ${labelAttr}" aria-expanded="${!collapsed}">▾</button>
      <input type="checkbox" class="df-check" aria-label="Select all documents in ${labelAttr}" title="Focus every document in this folder">
      <span class="df-icon" aria-hidden="true"><svg class="ico"><use href="#ic-folder"/></svg></span>
      <span class="df-name">${escapeHtml(label)}</span>
      <span class="df-count">${countFilesIn(folder)}</span>`;
    const children = document.createElement('div');
    children.className = 'doc-folder-children';
    if (collapsed) children.style.display = 'none';

    const descIds = collectDocIds(folder);
    header._docIds = descIds;

    const twisty = header.querySelector('.df-twisty');
    const toggleFolder = () => {
      if (collapsedFolders.has(folder.path)) collapsedFolders.delete(folder.path);
      else collapsedFolders.add(folder.path);
      const nowCollapsed = collapsedFolders.has(folder.path);
      header.classList.toggle('collapsed', nowCollapsed);
      twisty.setAttribute('aria-expanded', String(!nowCollapsed));
      children.style.display = nowCollapsed ? 'none' : '';
    };
    // Mouse: a click anywhere on the row toggles, except the checkbox (which selects). The twisty
    // <button>'s own click bubbles here too, and keyboard activation (Enter/Space on the focused
    // twisty) fires a native click — so no separate keydown handler is needed.
    header.addEventListener('click', (e) => {
      if (e.target.classList.contains('df-check')) return;   // checkbox handles itself
      toggleFolder();
    });
    const fcheck = header.querySelector('.df-check');
    fcheck.addEventListener('change', (e) => {
      e.stopPropagation();
      if (fcheck.checked) descIds.forEach(id => selectedDocIds.add(id));
      else descIds.forEach(id => selectedDocIds.delete(id));
      const fp = folder.path;
      renderDocList();   // re-render to sync every child checkbox + selection style
      // The re-render replaced this checkbox, so keyboard/AT focus would drop to <body>. Restore it to
      // the equivalent folder checkbox on the rebuilt tree so the user keeps their place (WCAG 2.4.3).
      const again = docListWrap.querySelector(`.doc-folder[data-folder-path="${CSS.escape(fp)}"] .df-check`);
      if (again) again.focus();
    });

    container.appendChild(header);
    container.appendChild(children);
    renderDocNode(folder, children, depth + 1);
  }
  for (const doc of node.files.slice().sort((a, b) => a.name.localeCompare(b.name))) {
    container.appendChild(createDocItem(doc, depth));
  }
}

function renderDocList() {
  const all = Array.isArray(docsCache) ? docsCache : [];
  // Clear the previously-rendered tree, keeping the empty-state element.
  [...docListWrap.children].forEach(el => { if (el !== docListEmpty) el.remove(); });

  // Drop any selected ids that no longer exist. Prune against the FULL list, not the filtered subset:
  // a filter must never silently unselect documents it merely hides.
  const currentIds = new Set(all.map(d => d.docId));
  for (const id of [...selectedDocIds]) if (!currentIds.has(id)) selectedDocIds.delete(id);

  const tokens = docSearchTokens();
  const visible = tokens.length ? all.filter(d => docMatchesFilter(d, tokens)) : all;

  if (!all.length) {
    docListEmpty.textContent = 'No documents loaded';
    docListEmpty.style.display = 'block';
    updateFilterBar();
    return;
  }
  if (!visible.length) {
    const qText = docFilterQuery.trim();
    const q = clipCodePoints(qText, 80);
    const qShown = q === qText ? q : `${q}…`;
    docListEmpty.textContent = q ? `No documents match “${qShown}”.` : 'No documents match.';
    docListEmpty.style.display = 'block';
    updateFilterBar();
    return;
  }
  docListEmpty.style.display = 'none';

  renderDocNode(buildDocTree(visible), docListWrap, 0);
  syncFolderChecks();
  updateFilterBar();
}

// Full-Context toggle — inject the selected docs whole instead of by passages.
const fcCheck = document.getElementById('doc-fullcontext-check');
if (fcCheck) {
  fcCheck.addEventListener('change', () => { fullContextMode = fcCheck.checked; });
}

// Select-all / Clear button
const docSelectAll = document.getElementById('doc-select-all');
if (docSelectAll) {
  docSelectAll.addEventListener('click', () => {
    if (selectedDocIds.size > 0) {
      // Clear all
      selectedDocIds.clear();
      docListWrap.querySelectorAll('.doc-item').forEach(item => {
        item.classList.remove('selected');
        item.querySelector('.di-check').checked = false;
      });
    } else {
      // Select all indexed docs
      docListWrap.querySelectorAll('.doc-item').forEach(item => {
        const badge = item.querySelector('.di-badge');
        if (badge && badge.classList.contains('indexed')) {
          selectedDocIds.add(item.dataset.docId);
          item.classList.add('selected');
          item.querySelector('.di-check').checked = true;
        }
      });
    }
    // Bulk select/clear changes which documents are selected, so the folder-header checkboxes must
    // resync their checked/indeterminate state too — the per-document change handler already does
    // this, and without it here the folder rows would keep their stale state until the next render.
    syncFolderChecks();
    updateFilterBar();
  });
}

// Live document filter. Rendering is debounced so typing stays smooth on a large library; the input
// value remains the source of truth and the pending timer is cancelled whenever the value is applied.
if (docSearchInput) {
  docSearchInput.addEventListener('input', () => {
    if (docSearchClear) docSearchClear.hidden = !docSearchInput.value.trim();
    if (_docFilterTimer) clearTimeout(_docFilterTimer);
    _docFilterTimer = setTimeout(() => {
      _docFilterTimer = null;
      setDocFilter(docSearchInput.value);
    }, 90);
  });
  // A native clear (the × some browsers draw inside a type=search) fires `search`, not `input`.
  docSearchInput.addEventListener('search', () => setDocFilter(docSearchInput.value));
  docSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && docSearchInput.value) {
      e.preventDefault();
      e.stopPropagation();
      clearDocFilter({ focus: true });   // clear the filter first; a second Escape closes the panel
    }
  });
}
if (docSearchClear) docSearchClear.addEventListener('click', () => clearDocFilter({ focus: true }));

// Mark the page background inert while a modal is open, so assistive technology and pointer/Tab focus
// cannot reach the content behind the dialog — the modern complement to the Tab trap, which only keeps
// keyboard focus in but still leaves the background in the accessibility tree. Only the background regions
// (#header, #main) are inerted; every modal overlay is a SIBLING of these (appended to body or placed after
// </main>), so none is an ancestor being disabled. A counter handles nesting (a confirm opened from inside
// Settings): the background stays inert until the last dialog closes. `inert` also implies aria-hidden, so a
// screen reader skips the background entirely. Guarded for older engines that lack the property.
let _modalInertDepth = 0;
const _modalBgRegions = () => ['header', 'main'].map((id) => document.getElementById(id)).filter(Boolean);
function modalInertPush() {
  if (++_modalInertDepth !== 1) return;   // already inert from an outer dialog
  for (const el of _modalBgRegions()) { try { el.inert = true; } catch (_) { /* unsupported */ } }
}
function modalInertPop() {
  if (_modalInertDepth === 0) return;
  if (--_modalInertDepth !== 0) return;   // an outer dialog is still open
  for (const el of _modalBgRegions()) { try { el.inert = false; } catch (_) { /* unsupported */ } }
}

// Give a dynamically-created confirm overlay the same accessibility the static dialogs get from
// setupModalA11y: dialog semantics, an accessible name, initial focus, a Tab trap, and focus
// return to whatever opened it. These dialogs are added to and removed from the DOM (rather than
// shown by toggling a class), so a MutationObserver watches for the overlay's removal to run the
// focus-return cleanup — however it is closed (Cancel, an action button, Escape, or click-outside).
function enhanceConfirmDialog(overlay) {
  const box = overlay.querySelector('.del-confirm-box') || overlay;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('tabindex', '-1');
  const title = box.querySelector('h3');
  if (title) {
    if (!title.id) title.id = 'confirm-title-' + Math.random().toString(36).slice(2, 9);
    box.setAttribute('aria-labelledby', title.id);
  }
  // Associate the message/consequence text too, so a screen reader reads it on open — for a destructive
  // confirm the consequence ("Any tool using it will stop working.") matters as much as the title.
  const desc = box.querySelector('p');
  if (desc && desc.textContent.trim()) {
    if (!desc.id) desc.id = 'confirm-desc-' + Math.random().toString(36).slice(2, 9);
    box.setAttribute('aria-describedby', desc.id);
  }
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  const lastFocused = document.activeElement;
  const focusables = () => [...box.querySelectorAll(FOCUSABLE)].filter(n => n.offsetParent !== null);
  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    const list = focusables();
    if (!list.length) { e.preventDefault(); try { box.focus(); } catch (_) {} return; }
    const first = list[0], last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKey, true);
  modalInertPush();   // inert the background while this dialog is up (balanced in the removal observer)
  const mo = new MutationObserver(() => {
    if (overlay.isConnected) return;
    mo.disconnect();
    document.removeEventListener('keydown', onKey, true);
    modalInertPop();
    try { if (lastFocused && lastFocused.focus) lastFocused.focus(); } catch (_) { /* best-effort */ }
  });
  try { mo.observe(document.body, { childList: true }); } catch (_) {}
  try { (focusables()[0] || box).focus(); } catch (_) { /* focus is best-effort */ }
}

// In-app text-prompt modal, used wherever the app needs a line of input. It replaces
// window.prompt(), which the desktop webviews do not implement — WebView2 has no prompt() and
// wry/WKWebView returns null — so a prompt()-based flow silently does nothing in the packaged
// desktop app while working in a browser. This reuses the confirm-dialog styling and the shared
// a11y wiring (focus trap, focus return, labelled dialog). Resolves to the entered string, or
// null if the user cancels.
function showPromptModal({ title, message, defaultValue = '', placeholder = '', okLabel = 'OK', danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div'); overlay.className = 'del-confirm';
    // The confirm button is red (del-btn-ok) only for a destructive action; a benign action (create,
    // rename) uses the neutral accent style so it doesn't signal danger.
    const okClass = danger ? 'del-btn-ok' : 'del-btn-primary';
    overlay.innerHTML = `
      <div class="del-confirm-box prompt-modal">
        <h3>${escapeHtml(title || '')}</h3>
        ${message ? `<p>${escapeHtml(message)}</p>` : ''}
        <input type="text" class="prompt-input"${placeholder ? ` placeholder="${escapeHtml(placeholder)}"` : ''}>
        <div class="del-confirm-btns">
          <button class="del-btn-cancel">Cancel</button>
          <button class="prompt-ok ${okClass}">${escapeHtml(okLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const box   = overlay.querySelector('.del-confirm-box');
    const input = overlay.querySelector('.prompt-input');
    input.value = defaultValue || '';
    let settled = false;
    const done = (val) => { if (settled) return; settled = true; overlay.remove(); resolve(val); };
    overlay.querySelector('.del-btn-cancel').onclick = () => done(null);
    overlay.querySelector('.prompt-ok').onclick      = () => done(input.value);
    box.addEventListener('keydown', (e) => {
      // stopPropagation so Escape closes ONLY this dialog, not the Settings/Inbox modal it may sit on top
      // of: without it the key would keep bubbling to the global Escape handler and close the modal behind,
      // discarding unsaved edits.
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
      else if (e.key === 'Enter' && document.activeElement === input) { e.preventDefault(); e.stopPropagation(); done(input.value); }
    });
    enhanceConfirmDialog(overlay);
    try { input.focus(); input.select(); } catch (_) { /* focus is best-effort */ }
  });
}

// In-app confirm modal — a themed, promise-based replacement for window.confirm(). The native
// dialog is unstyled (matches no theme) and, in the packaged desktop webview, unreliable, so every
// destructive gate routes through this instead. Resolves true on confirm, false on Cancel/Escape/
// click-outside. Reuses the confirm-dialog styling and the shared a11y wiring (focus trap, focus
// return); default focus lands on Cancel and there is no global Enter=confirm, so an accidental
// keypress can't fire a destructive action — the user must explicitly activate the OK button.
function showConfirm({ title, message = '', okLabel = 'OK', cancelLabel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div'); overlay.className = 'del-confirm';
    const okClass = danger ? 'del-btn-ok' : 'del-btn-primary';
    overlay.innerHTML = `
      <div class="del-confirm-box msg-modal">
        <h3>${escapeHtml(title || '')}</h3>
        ${message ? `<p>${escapeHtml(message)}</p>` : ''}
        <div class="del-confirm-btns">
          <button class="del-btn-cancel">${escapeHtml(cancelLabel)}</button>
          <button class="confirm-ok ${okClass}">${escapeHtml(okLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const box = overlay.querySelector('.del-confirm-box');
    let settled = false;
    const done = (val) => { if (settled) return; settled = true; overlay.remove(); resolve(val); };
    overlay.querySelector('.del-btn-cancel').onclick = () => done(false);
    overlay.querySelector('.confirm-ok').onclick      = () => done(true);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(false); });   // click-outside cancels
    // stopPropagation so Escape closes ONLY this confirm, not a Settings/Inbox modal it sits on top of.
    box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); } });
    enhanceConfirmDialog(overlay);
  });
}

// Non-blocking toast — a themed, auto-dismissing replacement for window.alert(). alert() blocks the
// event loop, is unstyled, and behaves inconsistently in the desktop webview; a toast is themed,
// mobile-friendly, and never freezes the UI. Also mirrored to the screen-reader live region. Click to
// dismiss early. Best-effort: a failure here must never break the flow that raised it.
let _toastWrap = null;
function showToast(message, kind = 'info') {
  try {
    const msg = String(message == null ? '' : message);
    if (!_toastWrap) {
      _toastWrap = document.getElementById('toast-wrap')
        || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'toast-wrap', className: 'toast-wrap' }));
    }
    const el = document.createElement('div');
    el.className = 'toast ' + (kind === 'error' ? 'toast-error' : kind === 'success' ? 'toast-success' : 'toast-info');
    // The toast element IS its own live region (role=status/alert announces once on insertion), so it is
    // deliberately NOT also mirrored into the shared polite region — that would speak every toast twice.
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    // A leading glyph distinguishes success/error/info by more than the border color, so the status is
    // not conveyed by hue alone (helps color-blind/low-vision users). aria-hidden so it isn't read out.
    const glyph = document.createElement('span');
    glyph.className = 'toast-glyph'; glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = kind === 'error' ? '⚠' : kind === 'success' ? '✓' : 'ℹ';
    el.appendChild(glyph);
    el.appendChild(document.createTextNode(msg));
    _toastWrap.appendChild(el);
    let removed = false;
    const remove = () => { if (removed) return; removed = true; el.classList.add('toast-out'); setTimeout(() => el.remove(), 220); };
    const timer = setTimeout(remove, kind === 'error' ? 6000 : 4000);
    el.addEventListener('click', () => { clearTimeout(timer); remove(); });
  } catch { /* toast is best-effort — never throw into a caller's flow */ }
}

function confirmDelete(name, relPath) {
  const overlay = document.createElement('div'); overlay.className = 'del-confirm';
  // The listed documents are Lokyni's OWN stored copies (uploads, added web pages / YouTube transcripts, and
  // notes all live under the workspace's documents folder). Deleting one removes it from the index AND deletes
  // that stored copy from disk, so it no longer takes up space — the old "your file on disk is not affected"
  // wording was wrong for these and left people unsure whether the copy lingered. Any separate original the
  // user still has elsewhere (the file they uploaded from, or the live web page) is of course untouched. There
  // is deliberately no "remove from index but keep the file" option: a kept copy in the documents folder would
  // just be re-indexed on the next scan, so it could not durably stay out of the index anyway.
  overlay.innerHTML = `
    <div class="del-confirm-box">
      <h3>Delete this document?</h3>
      <p>${escapeHtml(name)}</p>
      <p class="del-confirm-note">This removes it from your library and the search index, and deletes Lokyni's stored copy from disk so it no longer takes up space. Any file you uploaded it from, or the original web page, is untouched.</p>
      <div class="del-confirm-btns">
        <button class="del-btn-cancel">Cancel</button>
        <button class="del-btn-ok">Delete</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  enhanceConfirmDialog(overlay);
  overlay.querySelector('.del-btn-cancel').onclick = () => overlay.remove();
  overlay.querySelector('.del-btn-ok').onclick = async () => {
    overlay.remove();
    try {
      const res  = await fetch('/api/documents?path=' + encodeURIComponent(relPath) + wsQuery('&'), { method: 'DELETE' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      loadDocuments();
    } catch (e) { appendError('Delete failed: ' + e.message); }
  };
}

if (document.getElementById('refresh-docs')) {
  document.getElementById('refresh-docs').addEventListener('click', loadDocuments);
}
if (document.getElementById('synthesize-ws')) {
  document.getElementById('synthesize-ws').addEventListener('click', synthesizeWorkspace);
}

// ── Extraction Tables ──────────────────────────────────────────────────────────
// Define columns, run an extraction across the workspace's documents (or just the selected ones) into a
// cited grid that fills live over the socket, and export it as CSV. The run is a server TOOL action, not a
// chat turn: it streams extract_columns → extract_row* → extract_done, can be cancelled (extract_cancel),
// and never touches the chat thread. All DOM is built with textContent/escapeHtml (cells hold untrusted
// document text), and the one object URL created for the CSV download is revoked right after the click.
(function initExtractTable() {
  const overlay = document.getElementById('extract-overlay');
  if (!overlay) return;
  const openBtn    = document.getElementById('extract-table-btn');
  const closeBtn   = document.getElementById('extract-close');
  const colsWrap   = document.getElementById('extract-columns');
  const addColBtn  = document.getElementById('extract-add-col');
  const selOnly    = document.getElementById('extract-selected-only');
  const setupMsg   = document.getElementById('extract-setup-msg');
  const setupBox   = document.getElementById('extract-setup');
  const runBox     = document.getElementById('extract-run');
  const progressEl = document.getElementById('extract-progress');
  const tableWrap  = document.getElementById('extract-table-wrap');
  const runBtn     = document.getElementById('extract-run-btn');
  const cancelBtn  = document.getElementById('extract-cancel');
  const exportBtn  = document.getElementById('extract-export');

  const MAX_COLUMNS = 12;
  let phase = 'setup';       // 'setup' | 'running' | 'done'
  let lastColumns = [];      // [{ key, label }] from the server (authoritative keys for row cells)
  let lastRows = [];         // [{ docId, name, cells }]

  const addColumnInput = (value = '') => {
    if (colsWrap.querySelectorAll('.extract-col-input').length >= MAX_COLUMNS) return;
    const row = document.createElement('div');
    row.className = 'extract-col-row';
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'extract-col-input'; input.maxLength = 80;
    input.placeholder = 'Column — e.g. "Key finding" or "Sample size"';
    input.value = value;
    const rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'extract-col-rm'; rm.setAttribute('aria-label', 'Remove column'); rm.textContent = '✕';
    rm.addEventListener('click', () => row.remove());
    row.appendChild(input); row.appendChild(rm);
    colsWrap.appendChild(row);
    return input;
  };
  const collectColumns = () => [...colsWrap.querySelectorAll('.extract-col-input')].map(i => i.value.trim()).filter(Boolean);

  const showSetup = () => {
    phase = 'setup';
    runBox.classList.add('hidden'); setupBox.classList.remove('hidden');
    cancelBtn.classList.add('hidden'); exportBtn.classList.add('hidden');
    runBtn.classList.remove('hidden'); runBtn.disabled = false; runBtn.textContent = 'Run extraction';
  };
  const finishRun = (note) => {
    phase = 'done';
    cancelBtn.classList.add('hidden');
    runBtn.classList.remove('hidden'); runBtn.disabled = false; runBtn.textContent = '← New extraction';
    if (note) progressEl.textContent = note;
    if (lastRows.length) exportBtn.classList.remove('hidden');
  };

  const openModal = () => {
    if (colsWrap.querySelectorAll('.extract-col-input').length === 0) { addColumnInput('Summary'); addColumnInput('Key finding'); }
    setupMsg.textContent = ''; tableWrap.innerHTML = ''; progressEl.textContent = '';
    lastColumns = []; lastRows = [];
    showSetup();
    overlay.classList.remove('hidden');
    const first = colsWrap.querySelector('.extract-col-input'); if (first) first.focus();
  };
  const closeModal = () => {
    if (phase === 'running') { try { socket.emit('extract_cancel'); } catch {} }
    overlay.classList.add('hidden');
  };

  openBtn?.addEventListener('click', openModal);
  closeBtn?.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  addColBtn?.addEventListener('click', () => { const i = addColumnInput(); if (i) i.focus(); });

  const renderHeader = () => {
    const head = document.createElement('tr');
    const docTh = document.createElement('th'); docTh.className = 'ex-doc'; docTh.textContent = 'Document'; head.appendChild(docTh);
    for (const c of lastColumns) { const th = document.createElement('th'); th.textContent = c.label; head.appendChild(th); }
    const table = document.createElement('table'); table.className = 'extract-table';
    const thead = document.createElement('thead'); thead.appendChild(head);
    const tbody = document.createElement('tbody'); tbody.id = 'extract-tbody';
    table.appendChild(thead); table.appendChild(tbody);
    tableWrap.innerHTML = ''; tableWrap.appendChild(table);
  };
  const appendRow = (row) => {
    const tbody = document.getElementById('extract-tbody');
    if (!tbody) return;
    const tr = document.createElement('tr');
    const tdDoc = document.createElement('td'); tdDoc.className = 'ex-doc'; tdDoc.textContent = row.name || row.docId || ''; tr.appendChild(tdDoc);
    for (const c of lastColumns) {
      const cell = (row.cells && row.cells[c.key]) || {};
      const v = (cell.value || '').trim();
      const td = document.createElement('td');
      td.textContent = v || '—';
      if (!v) td.className = 'ex-empty';
      if (cell.evidence) { td.title = cell.evidence; td.classList.add('ex-has-evidence'); }  // evidence quote on hover
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  };

  runBtn?.addEventListener('click', () => {
    if (phase === 'done') { showSetup(); return; }          // "New extraction" → back to the column editor
    const columns = collectColumns();
    if (columns.length === 0) { setupMsg.textContent = 'Add at least one column to extract.'; return; }
    phase = 'running';
    lastColumns = []; lastRows = [];
    setupBox.classList.add('hidden'); runBox.classList.remove('hidden');
    runBtn.classList.add('hidden'); cancelBtn.classList.remove('hidden'); exportBtn.classList.add('hidden');
    progressEl.textContent = 'Starting…'; tableWrap.innerHTML = '';
    const payload = { columns };
    const ws = currentWorkspaceId(); if (ws) payload.workspaceId = ws;
    if (selOnly.checked && selectedDocIds.size > 0) payload.selectedDocIds = [...selectedDocIds];
    socket.emit('extract_table', JSON.stringify(payload));
  });
  cancelBtn?.addEventListener('click', () => { try { socket.emit('extract_cancel'); } catch {} finishRun('Canceled.'); });

  // CSV export — client-side, zero round-trip. A UTF-8 BOM makes Excel read non-ASCII correctly; values are
  // RFC-4180-quoted. The object URL is revoked right after the click so nothing leaks.
  const toCsv = () => {
    // Guard against spreadsheet formula injection: cell text comes from untrusted documents, and a value
    // starting with = + - @ (or a leading tab/CR) is executed as a formula by Excel/Sheets/LibreOffice on
    // open. Prefix such a value with an apostrophe so it is treated as literal text, then RFC-4180 quote.
    const q = (s) => {
      s = String(s == null ? '' : s);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [['Document', ...lastColumns.map(c => c.label)].map(q).join(',')];
    for (const row of lastRows) {
      const cells = lastColumns.map(c => (row.cells && row.cells[c.key] && row.cells[c.key].value) || '');
      lines.push([row.name || row.docId || '', ...cells].map(q).join(','));
    }
    return lines.join('\r\n');
  };
  exportBtn?.addEventListener('click', () => {
    if (!lastRows.length) return;
    // Share the app's download helper so this gets the same "Save As" dialog. The leading BOM keeps Excel from
    // mis-reading UTF-8.
    triggerDownload('extraction.csv', 'text/csv;charset=utf-8', '﻿' + toCsv());
  });

  // ── Socket events (registered once at load; guarded so late events after close/cancel are ignored) ──
  socket.on('extract_columns', (p) => {
    const d = parsePayload(p);
    if (phase !== 'running') return;
    lastColumns = Array.isArray(d.columns) ? d.columns : [];
    renderHeader();
  });
  socket.on('extract_row', (p) => {
    const row = parsePayload(p);
    if (phase !== 'running' || !row) return;
    lastRows.push(row);
    appendRow(row);
  });
  socket.on('extract_progress', (p) => {
    const d = parsePayload(p);
    if (phase !== 'running') return;
    if (d && d.total) progressEl.textContent = `Extracting ${d.processed} of ${d.total}${d.current ? ' — ' + d.current : ''}…`;
  });
  socket.on('extract_done', (p) => {
    const d = parsePayload(p);
    if (phase !== 'running') return;
    if (Array.isArray(d.columns) && d.columns.length) lastColumns = d.columns;   // authoritative final keys
    let note = `Done — ${d.processed || lastRows.length} document${(d.processed || lastRows.length) === 1 ? '' : 's'}.`;
    if (d.omittedDocs) note += ` ${d.omittedDocs} not processed (over the limit).`;
    if (d.truncatedAny) note += ' Long documents were read only in part.';
    finishRun(note);
  });
  socket.on('extract_error', (p) => {
    const d = parsePayload(p);
    if (overlay.classList.contains('hidden')) return;
    if (phase === 'running') finishRun('');
    setupBox.classList.remove('hidden'); runBox.classList.add('hidden');
    phase = 'setup'; runBtn.textContent = 'Run extraction'; cancelBtn.classList.add('hidden'); runBtn.classList.remove('hidden');
    setupMsg.textContent = (d && d.error) || 'Something went wrong extracting the table.';
  });
})();

// ── Notes ───────────────────────────────────────────────────────────────────────
// Write notes that are stored as first-class documents (markdown under the workspace's notes/ folder), so the
// normal pipeline indexes them — searchable, #-citable, and surfaced by related-docs. A list on the left, an
// editor on the right, and a "related" strip that reuses the similarity endpoint. All server values are
// rendered via textContent/escapeHtml (note content is user-authored but still untrusted to the DOM).
(function initNotes() {
  const overlay = document.getElementById('notes-overlay');
  if (!overlay) return;
  const openBtn  = document.getElementById('notes-btn');
  const closeBtn = document.getElementById('notes-close');
  const listEl   = document.getElementById('notes-list');
  const newBtn   = document.getElementById('notes-new');
  const titleEl  = document.getElementById('note-title');
  const bodyEl   = document.getElementById('note-body');
  const saveBtn  = document.getElementById('note-save');
  const delBtn   = document.getElementById('note-delete');
  const msgEl    = document.getElementById('note-msg');
  const relatedEl= document.getElementById('note-related');

  let current = null;   // { relPath } of the open note, or null for a new (unsaved) note

  const open = () => { overlay.classList.remove('hidden'); newNote(); loadList(); };
  const close = () => overlay.classList.add('hidden');
  openBtn?.addEventListener('click', open);
  closeBtn?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const newNote = () => {
    current = null;
    titleEl.value = ''; titleEl.disabled = false; titleEl.classList.remove('hidden');
    bodyEl.value = ''; msgEl.textContent = '';
    delBtn.classList.add('hidden'); relatedEl.innerHTML = '';
    titleEl.focus();
  };

  async function loadList() {
    try {
      const r = await fetch('/api/documents/notes' + wsQuery());
      const d = await r.json();
      listEl.innerHTML = '';
      if (!d.ok || !d.notes.length) { const e = document.createElement('div'); e.className = 'notes-empty'; e.textContent = 'No notes yet.'; listEl.appendChild(e); return; }
      for (const n of d.notes) {
        const item = document.createElement('button');
        item.type = 'button'; item.className = 'notes-item';
        if (current && current.relPath === n.relPath) item.classList.add('active');
        const nm = document.createElement('div'); nm.className = 'notes-item-name'; nm.textContent = n.name;
        const ex = document.createElement('div'); ex.className = 'notes-item-excerpt'; ex.textContent = n.excerpt || '—';
        item.appendChild(nm); item.appendChild(ex);
        item.addEventListener('click', () => openNote(n.relPath));
        listEl.appendChild(item);
      }
    } catch { listEl.innerHTML = ''; const e = document.createElement('div'); e.className = 'notes-empty'; e.textContent = 'Could not load notes.'; listEl.appendChild(e); }
  }

  async function openNote(relPath) {
    try {
      const r = await fetch('/api/documents/note?path=' + encodeURIComponent(relPath) + (wsQuery('&') || ''));
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error();
      current = { relPath: d.relPath };
      titleEl.value = d.name; titleEl.disabled = true; titleEl.classList.remove('hidden');
      bodyEl.value = d.body || ''; msgEl.textContent = '';
      delBtn.classList.remove('hidden');
      loadList();
      loadRelated(d.docId);
      bodyEl.focus();
    } catch { msgEl.textContent = 'Could not open that note.'; }
  }

  async function saveNote() {
    const body = bodyEl.value;
    const payload = current ? { path: current.relPath, body } : { title: titleEl.value.trim() || 'Untitled note', body };
    saveBtn.disabled = true; msgEl.textContent = 'Saving…';
    try {
      const r = await fetch('/api/documents/note' + wsQuery(), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d && d.error);
      current = { relPath: d.relPath };
      titleEl.value = d.name; titleEl.disabled = true;
      delBtn.classList.remove('hidden');
      msgEl.textContent = 'Saved — indexing so it becomes searchable.';
      loadList();
      // Related needs the note indexed first; give the delta a moment, then try (best-effort).
      setTimeout(() => loadRelated(d.docId), 2500);
    } catch (e) { msgEl.textContent = (e && e.message) || 'Could not save the note.'; }
    finally { saveBtn.disabled = false; }
  }

  async function deleteNote() {
    if (!current) { newNote(); return; }
    // Route through the app's themed confirm, not native confirm() — the latter is unstyled and unreliable in
    // the desktop webview (every other destructive action in the app uses showConfirm for the same reason).
    if (!(await showConfirm({ title: 'Delete this note?', message: 'This cannot be undone.', okLabel: 'Delete', danger: true }))) return;
    try {
      const r = await fetch('/api/documents?path=' + encodeURIComponent(current.relPath) + (wsQuery('&') || ''), { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error();
      newNote(); loadList();
    } catch { msgEl.textContent = 'Could not delete the note.'; }
  }

  async function loadRelated(docId) {
    relatedEl.innerHTML = '';
    if (!docId) return;
    try {
      const r = await fetch('/api/documents/related?docId=' + encodeURIComponent(docId) + '&k=6' + (wsQuery('&') || ''));
      if (!r.ok) return;   // 202 warming / 404 not-indexed-yet — just show nothing
      const d = await r.json();
      if (!d.ok || !d.related || !d.related.length) return;
      const head = document.createElement('div'); head.className = 'note-related-head'; head.textContent = 'Related documents'; relatedEl.appendChild(head);
      const wrap = document.createElement('div'); wrap.className = 'note-related-pills';
      for (const rel of d.related) {
        const pill = document.createElement('span'); pill.className = 'note-related-pill'; pill.textContent = rel.name; wrap.appendChild(pill);
      }
      relatedEl.appendChild(wrap);
    } catch { /* related is a best-effort enhancement */ }
  }

  newBtn?.addEventListener('click', newNote);
  saveBtn?.addEventListener('click', saveNote);
  delBtn?.addEventListener('click', deleteNote);
})();

// ── Corpus mind-map ─────────────────────────────────────────────────────────────
// An interactive map of the workspace's knowledge-graph entities (the top-connected ones, bounded server-side)
// and how they connect. Rendered as inline SVG with a short, bounded force simulation — no graphing library, no
// continuous animation (the layout settles once, then stops, so it never spins a timer or drains the battery).
// The canvas is a navigable viewport: drag to pan, scroll / pinch / buttons to zoom, so a dense map stays legible
// (zoom in to read any label). Hovering or focusing a point highlights its connections and dims the rest; clicking
// SELECTS it and offers an explicit "Ask about this" action in the footer — a click never silently closes the map.
// All labels use textContent, so an entity name from an untrusted document can't inject markup. Pan/zoom is pure
// Pointer Events + a viewBox transform, so it behaves identically in the web app and the desktop app.
(function initMindmap() {
  const overlay = document.getElementById('mindmap-overlay');
  if (!overlay) return;
  const openBtn  = document.getElementById('mindmap-btn');
  const closeBtn = document.getElementById('mindmap-close');
  const svg      = document.getElementById('mindmap-svg');
  const statusEl = document.getElementById('mindmap-status');
  const metaEl   = document.getElementById('mindmap-meta');
  const bodyEl   = document.getElementById('mindmap-body');
  const footerEl = document.getElementById('mindmap-footer');
  const liveEl   = document.getElementById('mindmap-live');
  const SVGNS = 'http://www.w3.org/2000/svg';
  const W = 1000, H = 700;

  // Status overlay. Pass `action = { label, onClick }` to show a button under the message — used so an empty/off
  // map offers to turn the feature on and build it right here, instead of sending the user to a buried setting.
  let buildPoll = null;
  const setStatus = (t, action) => {
    statusEl.replaceChildren();
    if (t) { const p = document.createElement('div'); p.className = 'mm-status-text'; p.textContent = t; statusEl.appendChild(p); }
    if (action) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'mm-status-btn'; b.textContent = action.label;
      b.addEventListener('click', action.onClick);
      statusEl.appendChild(b);
    }
    statusEl.style.display = (t || action) ? 'flex' : 'none';
  };
  const announce  = (t) => { try { if (liveEl) liveEl.textContent = t || ''; } catch { /* ignore */ } };
  const stopBuildPoll = () => { if (buildPoll) { clearInterval(buildPoll); buildPoll = null; } };

  const close = () => { stopBuildPoll(); overlay.classList.add('hidden'); };
  openBtn?.addEventListener('click', () => { overlay.classList.remove('hidden'); load(); });
  closeBtn?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // Turn the knowledge graph on (if needed) and build it, right from the map — then poll until it's ready and
  // render. Enabling auto-starts the build server-side; when it's already on but empty, we kick the build. All
  // fetches are guarded; the poll is cleared if the modal closes so nothing runs in the background after.
  async function enableAndBuild(needEnable) {
    stopBuildPoll();
    setStatus('Building the map… this can take a moment on a large library. You can keep working.');
    try {
      if (needEnable) await sendJSON('/api/config', { useGraphRag: true });   // server auto-starts the build
      else await fetch('/api/graph/build', { method: 'POST' });
    } catch { setStatus('Could not start building the map. Please try again.'); return; }
    buildPoll = setInterval(async () => {
      let s;
      try { s = await fetch('/api/graph/status').then((r) => r.json()); } catch { return; }   // transient — keep polling
      if (s && s.build && s.build.running) {
        const b = s.build; setStatus(`Building the map…${b.total ? ` (${b.done}/${b.total})` : ''}`);
        return;
      }
      stopBuildPoll();
      if (s && s.graph && s.graph.nodes) load();   // built with entities → render it
      else setStatus('No connections found to map yet — add a few more documents, then try again.');
    }, 1500);
  }

  // ── Pan / zoom: make the SVG a navigable canvas by mutating its viewBox (a pure coordinate transform, so every
  //    node/edge hit-target and label stays correct). Cross-browser via Pointer Events (mouse + touch + pen), with
  //    a drag threshold so a click on a node is never swallowed. Attached ONCE (the SVG persists), fail-safe.
  const pz = (function attachPanZoom() {
    const initVB = { x: 0, y: 0, w: W, h: H };
    const vb = Object.assign({}, initVB);
    const MINW = W / 12, MAXW = W * 5;
    const apply = () => { try { svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`); } catch { /* ignore */ } };
    const toVB = (cx, cy) => { const r = svg.getBoundingClientRect(); const px = (cx - r.left) / (r.width || 1); const py = (cy - r.top) / (r.height || 1); return { x: vb.x + px * vb.w, y: vb.y + py * vb.h }; };
    function zoomAt(cx, cy, factor) {
      const p = toVB(cx, cy);
      const nw = Math.max(MINW, Math.min(MAXW, vb.w * factor)); const nh = nw * (H / W);
      const px = (p.x - vb.x) / vb.w, py = (p.y - vb.y) / vb.h;
      vb.x = p.x - px * nw; vb.y = p.y - py * nh; vb.w = nw; vb.h = nh; apply();
    }
    const centerZoom = (factor) => { const r = svg.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor); };
    try { svg.classList.add('pannable'); } catch { /* ignore */ }
    svg.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 1.12 : 0.89); }, { passive: false });
    const pts = new Map(); let pinch = 0, start = null, dragging = false;
    svg.addEventListener('pointerdown', (e) => { pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.size === 1) { start = { x: e.clientX, y: e.clientY }; dragging = false; } });
    svg.addEventListener('pointermove', (e) => {
      const prev = pts.get(e.pointerId); if (!prev) return;
      const r = svg.getBoundingClientRect();
      if (pts.size >= 2) {   // pinch-zoom around the midpoint
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const a = [...pts.values()]; const d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
        if (pinch) zoomAt((a[0].x + a[1].x) / 2, (a[0].y + a[1].y) / 2, pinch / (d || 1));
        pinch = d; return;
      }
      if (!dragging && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4) return;   // below threshold → let a click happen
      if (!dragging) { dragging = true; svg.classList.add('panning'); try { svg.setPointerCapture(e.pointerId); } catch { /* ignore */ } }
      e.preventDefault();
      vb.x -= (e.clientX - prev.x) * vb.w / (r.width || 1);
      vb.y -= (e.clientY - prev.y) * vb.h / (r.height || 1);
      apply();
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    const upHandler = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = 0; if (!pts.size) { dragging = false; svg.classList.remove('panning'); } try { svg.releasePointerCapture(e.pointerId); } catch { /* ignore */ } };
    svg.addEventListener('pointerup', upHandler); svg.addEventListener('pointercancel', upHandler);
    const reset = () => { Object.assign(vb, initVB); apply(); };
    // Controls bar (built once, pinned to the canvas corner).
    const bar = document.createElement('div'); bar.className = 'mm-controls';
    const mk = (glyph, aria, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'mm-ctrl'; b.textContent = glyph; b.setAttribute('aria-label', aria); b.title = aria; b.addEventListener('click', fn); return b; };
    bar.appendChild(mk('−', 'Zoom out', () => centerZoom(1.25)));
    bar.appendChild(mk('+', 'Zoom in',  () => centerZoom(0.8)));
    bar.appendChild(mk('⤢', 'Reset view', reset));
    try { if (bodyEl) bodyEl.appendChild(bar); } catch { /* ignore */ }
    return { reset, isDragging: () => dragging };
  })();

  // Selection + highlight state, reset on each load.
  let nodeEls = [], edgeEls = [], nodesRef = [], selectedIdx = -1;

  const clearHi = () => {
    for (const ln of edgeEls) ln.classList.remove('mm-hi', 'mm-dim');
    for (const g of nodeEls) g.classList.remove('mm-hi', 'mm-dim');
  };
  // Highlight node i: light its incident edges + neighbors, dim everything else.
  function applyHi(i) {
    const keep = new Set([i]);
    for (const ln of edgeEls) {
      const hit = ln._a === i || ln._b === i;
      ln.classList.toggle('mm-hi', hit); ln.classList.toggle('mm-dim', !hit);
      if (hit) { keep.add(ln._a); keep.add(ln._b); }
    }
    nodeEls.forEach((g, k) => { g.classList.toggle('mm-dim', !keep.has(k)); g.classList.toggle('mm-hi', keep.has(k) && k !== i); });
    nodeEls[i] && nodeEls[i].classList.remove('mm-dim');
  }
  // After a hover ends, go back to the selection's highlight (or clear when nothing is selected).
  const restoreHi = () => { if (selectedIdx >= 0) applyHi(selectedIdx); else clearHi(); };

  // A click on the empty canvas (not a node, not a pan-drag) clears the selection — back to the overview.
  // Attached ONCE (the SVG persists across reloads), so listeners never stack up.
  svg.addEventListener('click', (e) => {
    if (e.target === svg && !pz.isDragging()) {
      if (selectedIdx >= 0 && nodeEls[selectedIdx]) nodeEls[selectedIdx].classList.remove('mm-sel');
      selectedIdx = -1; clearHi(); setFooterHint();
    }
  });

  const setFooterHint = () => {
    if (footerEl) footerEl.textContent = 'Drag to pan · scroll or pinch to zoom · hover a point to trace its connections · click a point to ask about it.';
  };
  function selectNode(i) {
    const nd = nodesRef[i]; if (!nd) return;
    if (selectedIdx >= 0 && nodeEls[selectedIdx]) nodeEls[selectedIdx].classList.remove('mm-sel');
    selectedIdx = i;
    if (nodeEls[i]) nodeEls[i].classList.add('mm-sel');
    applyHi(i);
    if (footerEl) {
      footerEl.innerHTML = '';
      const info = document.createElement('span');
      const name = document.createElement('span'); name.className = 'mm-sel-name'; name.textContent = nd.label;
      info.appendChild(name);
      info.appendChild(document.createTextNode(`${nd.type ? ' · ' + nd.type : ''} — ${nd.degree} link${nd.degree === 1 ? '' : 's'}, ${nd.docs} doc${nd.docs === 1 ? '' : 's'}`));
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'mm-ask-btn';
      btn.textContent = `Ask about ${nd.label.length > 24 ? nd.label.slice(0, 23) + '…' : nd.label}`;
      btn.addEventListener('click', () => { close(); askAbout(nd.label); });
      footerEl.appendChild(info); footerEl.appendChild(btn);
    }
    announce(`Selected ${nd.label}. ${nd.degree} connection${nd.degree === 1 ? '' : 's'}. Press Enter to ask about it.`);
  }

  async function load() {
    stopBuildPoll();
    svg.innerHTML = ''; metaEl.textContent = '';
    nodeEls = []; edgeEls = []; nodesRef = []; selectedIdx = -1;
    setFooterHint();
    setStatus('Loading the map…');
    let data;
    try {
      const r = await fetch('/api/documents/graph' + wsQuery());
      data = await r.json();
      if (!r.ok || !data.ok) throw new Error((data && data.error) || 'Failed to load the map.');
    } catch (e) { setStatus('Could not load the map. Please try again.'); return; }
    if (!data.enabled) {
      setStatus('Map the people, places, and topics across your documents and how they connect. It’s off by default (it reads each document once to build).',
        { label: 'Turn on & build the map', onClick: () => enableAndBuild(true) });
      return;
    }
    // Defensive: never dereference nodes/total unguarded — a malformed server payload must show the empty
    // state, not throw a TypeError that leaves the modal stuck with no status.
    const nodes = Array.isArray(data.nodes) ? data.nodes : [];
    if (!data.built || !nodes.length) {
      setStatus('The map hasn’t been built yet.', { label: 'Build the map', onClick: () => enableAndBuild(false) });
      return;
    }
    setStatus('');
    metaEl.textContent = `${data.shown || nodes.length} of ${(data.total && data.total.nodes) || nodes.length} entities`;
    render(nodes, Array.isArray(data.edges) ? data.edges : []);
    pz.reset();   // recenter the viewport for the fresh layout
  }

  // A compact force-directed layout: repulsion between all nodes, spring attraction along edges, and gentle
  // centering. Bounded iterations over a bounded node set (≤150), so it is a few milliseconds, one time.
  function layout(nodes, edges) {
    const n = nodes.length;
    const pos = nodes.map((_, i) => ({ x: W / 2 + Math.cos(i / n * 6.283) * 220 + (Math.random() - 0.5) * 40, y: H / 2 + Math.sin(i / n * 6.283) * 220 + (Math.random() - 0.5) * 40 }));
    const idx = {}; nodes.forEach((nd, i) => { idx[nd.id] = i; });
    const links = edges.map(e => ({ a: idx[e.source], b: idx[e.target] })).filter(l => l.a != null && l.b != null);
    const ITER = 220, REPULSE = 24000, SPRING = 0.015, REST = 90, CENTER = 0.012;
    for (let it = 0; it < ITER; it++) {
      const fx = new Float64Array(n), fy = new Float64Array(n);
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        let dx = pos[i].x - pos[j].x, dy = pos[i].y - pos[j].y;
        let d2 = dx * dx + dy * dy || 0.01; const f = REPULSE / d2; const d = Math.sqrt(d2);
        const ux = dx / d, uy = dy / d; fx[i] += ux * f; fy[i] += uy * f; fx[j] -= ux * f; fy[j] -= uy * f;
      }
      for (const l of links) {
        let dx = pos[l.b].x - pos[l.a].x, dy = pos[l.b].y - pos[l.a].y; const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d - REST) * SPRING; const ux = dx / d, uy = dy / d;
        fx[l.a] += ux * f * 60; fy[l.a] += uy * f * 60; fx[l.b] -= ux * f * 60; fy[l.b] -= uy * f * 60;
      }
      for (let i = 0; i < n; i++) {
        fx[i] += (W / 2 - pos[i].x) * CENTER * 100; fy[i] += (H / 2 - pos[i].y) * CENTER * 100;
        const damp = 0.018; pos[i].x += Math.max(-30, Math.min(30, fx[i] * damp)); pos[i].y += Math.max(-30, Math.min(30, fy[i] * damp));
      }
    }
    // Fit the laid-out points into the viewBox with a margin.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pos) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
    const m = 60, sx = (W - 2 * m) / Math.max(1, maxX - minX), sy = (H - 2 * m) / Math.max(1, maxY - minY), s = Math.min(sx, sy);
    for (const p of pos) { p.x = m + (p.x - minX) * s; p.y = m + (p.y - minY) * s; }
    return { pos, links };
  }

  function render(nodes, edges) {
    const { pos, links } = layout(nodes, edges);
    svg.innerHTML = '';
    // A sphere-shade gradient (rebuilt with the SVG): a specular highlight toward the top-left fading to a shaded
    // far edge gives each flat dot real volume over ANY fill color and in BOTH themes — relative white/black, no
    // fixed color and no per-node filter, so it stays cheap at the node cap. Each node's overlay circle (below)
    // references it by url(#mm-sphere).
    const defs = document.createElementNS(SVGNS, 'defs');
    const grad = document.createElementNS(SVGNS, 'radialGradient');
    grad.setAttribute('id', 'mm-sphere'); grad.setAttribute('cx', '33%'); grad.setAttribute('cy', '27%'); grad.setAttribute('r', '75%');
    const mkStop = (off, color, op) => { const s = document.createElementNS(SVGNS, 'stop'); s.setAttribute('offset', off); s.setAttribute('stop-color', color); s.setAttribute('stop-opacity', op); return s; };
    grad.appendChild(mkStop('0%', '#ffffff', '0.6'));    // specular highlight toward the light
    grad.appendChild(mkStop('40%', '#ffffff', '0'));     // fade to the dot's own color through the middle
    grad.appendChild(mkStop('100%', '#000000', '0.42')); // shade the far edge so the dot reads as a sphere
    defs.appendChild(grad); svg.appendChild(defs);
    nodeEls = []; edgeEls = []; nodesRef = nodes; selectedIdx = -1;
    const maxDeg = Math.max(1, ...nodes.map(n => n.degree || 0));
    // Declutter: at rest only the top LABEL_CAP nodes by degree keep their labels, so even a dense hub map isn't a
    // wall of overlapping text — an absolute cap bounds the labelled set regardless of how the degrees are spread
    // (a relative cutoff still showed everything when many nodes shared a high degree). Every other node is "minor"
    // and reveals its label on hover / focus / highlight / selection; zoom in to read any.
    const LABEL_CAP = 18;
    const labeled = new Set(nodes.map((nd, i) => [i, nd.degree || 0]).sort((a, b) => b[1] - a[1]).slice(0, LABEL_CAP).map(p => p[0]));
    // Edges first (under the nodes); remember each end's node index for highlighting.
    const gEdges = document.createElementNS(SVGNS, 'g');
    for (const l of links) {
      const line = document.createElementNS(SVGNS, 'line');
      line.setAttribute('x1', pos[l.a].x); line.setAttribute('y1', pos[l.a].y);
      line.setAttribute('x2', pos[l.b].x); line.setAttribute('y2', pos[l.b].y);
      line.setAttribute('class', 'mm-edge');
      line._a = l.a; line._b = l.b;
      gEdges.appendChild(line); edgeEls.push(line);
    }
    svg.appendChild(gEdges);
    // Nodes + labels.
    nodes.forEach((nd, i) => {
      const r = 6 + 16 * Math.sqrt((nd.degree || 0) / maxDeg);
      const g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('class', 'mm-node' + (labeled.has(i) ? '' : ' mm-minor'));
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
      g.setAttribute('aria-label', `${nd.label}${nd.type ? ', ' + nd.type : ''}, ${nd.degree} connection${nd.degree === 1 ? '' : 's'}`);
      g.setAttribute('transform', `translate(${pos[i].x},${pos[i].y})`);
      const title = document.createElementNS(SVGNS, 'title');
      title.textContent = `${nd.label}${nd.type ? ' · ' + nd.type : ''} — ${nd.degree} link${nd.degree === 1 ? '' : 's'}, ${nd.docs} doc${nd.docs === 1 ? '' : 's'}`;
      g.appendChild(title);
      const c = document.createElementNS(SVGNS, 'circle');
      c.setAttribute('r', r); c.setAttribute('class', 'mm-dot');
      g.appendChild(c);
      // Sphere-shade overlay: a non-interactive sibling circle inside the node's own translated group (so it
      // pans/zooms and dims with the dot and never takes pointer events — clicks still fall through to the dot).
      const shade = document.createElementNS(SVGNS, 'circle');
      shade.setAttribute('r', r); shade.setAttribute('fill', 'url(#mm-sphere)'); shade.setAttribute('class', 'mm-sphere-shade'); shade.setAttribute('pointer-events', 'none');
      g.appendChild(shade);
      const label = document.createElementNS(SVGNS, 'text');
      label.setAttribute('class', 'mm-label'); label.setAttribute('x', r + 3); label.setAttribute('y', 4);
      label.textContent = nd.label.length > 28 ? nd.label.slice(0, 27) + '…' : nd.label;
      g.appendChild(label);
      // Hover/focus previews the node's connections; clicking SELECTS it (persistent) and offers the ask action.
      // A pan-drag that releases over a node must not count as a click — pz.isDragging() guards that.
      g.addEventListener('mouseenter', () => applyHi(i));
      g.addEventListener('mouseleave', restoreHi);
      g.addEventListener('focus', () => applyHi(i));
      g.addEventListener('blur', restoreHi);
      g.addEventListener('click', () => { if (!pz.isDragging()) selectNode(i); });
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (selectedIdx === i) { close(); askAbout(nd.label); } else selectNode(i); }
      });
      svg.appendChild(g); nodeEls.push(g);
    });
  }

  // Asking about an entity scopes the next question to it: drop a ready-made question into the composer and focus
  // it, so the user can send as-is or edit first (we never auto-send on their behalf). A toast confirms, so closing
  // the map and filling the box is never a silent surprise.
  function askAbout(name) {
    try {
      // Just the entity — Lokyni always answers from the documents, so appending "based on my documents"
      // was redundant AND hurt retrieval: the extra meta words pulled the query embedding toward
      // "documents / knowledge base" and away from the entity's actual content, which could drop the
      // similarity below the relevance gate and get a known corpus entity wrongly declined as off-topic.
      msgInput.value = `Tell me about ${name}.`;
      msgInput.style.height = 'auto'; msgInput.style.height = Math.min(msgInput.scrollHeight, 200) + 'px';
      msgInput.focus();
      try { showToast(`Added “Tell me about ${name}.” to your question — edit it or press Send.`, 'success'); } catch { /* toast optional */ }
    } catch { /* composer unavailable — nothing to do */ }
  }
})();

// ── URL ingestion ──
const urlInput   = document.getElementById('url-input');
const urlAddBtn  = document.getElementById('url-add-btn');
const urlStatus  = document.getElementById('url-ingest-status');
// Identifies the in-flight URL-ingest watch (below). A newer add — or the watch finishing — supersedes the
// previous one, so only the latest ever updates the status line.
let urlIngestWatch = null;
async function ingestUrl() {
  const url = (urlInput.value || '').trim();
  if (!url) return;
  urlAddBtn.disabled = true;
  urlStatus.className = 'url-status working';
  urlStatus.textContent = 'Fetching page…';
  try {
    const res = await sendJSON('/api/documents/url' + wsQuery(), { url });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Could not add the page');
    urlStatus.className = 'url-status working';
    urlStatus.textContent = `Added "${data.title}" (${data.chars.toLocaleString()} chars) — indexing…`;
    urlInput.value = '';
    loadDocuments();                                  // show the new document right away (as indexing)
    watchUrlIngestIndexed(data.file, data.title);     // then follow it to "indexed" and clear the line
  } catch (e) {
    urlStatus.className = 'url-status error';
    urlStatus.textContent = e.message;
  } finally {
    urlAddBtn.disabled = false;
  }
}

// Follow a just-added URL document until the index actually has it, then report done and refresh the list.
// Indexing runs in the BACKGROUND after /api/documents/url responds, so without this the "indexing…" line
// stayed forever and the document only appeared on the next manual panel open (the heartbeat refresh is gated
// on the panel being open and can dedupe itself away). This polls the documents list — which reports each
// document's indexed state — on a bounded schedule, refreshing the visible list each time so the entry flips
// to indexed without a reopen. A newer add or a timeout supersedes it, so it can never leak or run unbounded,
// and every network read is guarded so a transient failure simply retries instead of throwing.
async function watchUrlIngestIndexed(file, title) {
  if (!urlStatus) return;
  const token = (urlIngestWatch = {});
  const done = `Added "${title}" — indexed and searchable.`;
  const deadline = Date.now() + 90000;   // generous cap for a cold model / long transcript, then stop cleanly
  // Poll a CHEAP single-document check, not the full list: re-listing the whole corpus on every tick re-paid
  // an O(corpus) directory walk + stat-per-file + full-tree re-render (dozens of times for one ingest). The
  // list is refreshed ONCE, below, when the document actually lands.
  const statusUrl = '/api/documents/indexed?path=' + encodeURIComponent(file || '') + wsQuery('&');
  while (urlIngestWatch === token && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    if (urlIngestWatch !== token) return;             // a newer add took over
    let indexed = false;
    try {
      const res = await fetch(statusUrl);
      const data = await res.json();
      indexed = !!(data && data.ok && data.indexed);
    } catch { /* transient network/parse error — keep waiting, don't throw out of the loop */ }
    if (urlIngestWatch !== token) return;
    if (indexed) {
      urlIngestWatch = null;
      await loadDocuments();                          // one refresh so the entry flips to indexed in the list
      urlStatus.className = 'url-status ok';
      urlStatus.textContent = done;
      // Auto-clear so a stale success line doesn't linger — but only if it is still the line we set.
      setTimeout(() => { if (urlStatus.textContent === done) { urlStatus.textContent = ''; urlStatus.className = 'url-status'; } }, 6000);
      return;
    }
  }
  // Superseded or timed out. If still ours, leave an honest, non-alarming note rather than a stuck spinner.
  if (urlIngestWatch === token) {
    urlIngestWatch = null;
    urlStatus.className = 'url-status';
    urlStatus.textContent = `Added "${title}". It will be searchable once indexing finishes.`;
  }
}
if (urlAddBtn) {
  urlAddBtn.addEventListener('click', ingestUrl);
  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') ingestUrl(); });
}

// ── New conversation (with confirmation) ──
const newConvoBtn = document.getElementById('new-convo');
const newConfirmOverlay = document.getElementById('new-confirm-overlay');
const newConfirmOk     = document.getElementById('new-confirm-ok');
const newConfirmCancel = document.getElementById('new-confirm-cancel');

function doNewConvo() {
  socket.emit('reset_conversation');
  hideThinking();
  chatBox.innerHTML = '';
  // Re-attach the ORIGINAL empty-state node (innerHTML = '' detached it), not a clone. A clone
  // shares the id but not the cached `emptyState` reference, so hideEmptyState() would then hide the
  // detached original and leave the clone visible on every conversation after the first.
  if (emptyState) {
    chatBox.appendChild(emptyState);
    emptyState.style.display = '';
  }
  resetStreaming();
  // The user just started a new conversation and will type next.
  setInputState(false, true);
}

if (newConvoBtn) {
  newConvoBtn.addEventListener('click', () => {
    // Only confirm if there are messages in the chat
    if (chatBox.querySelector('.msg-row')) {
      newConfirmOverlay.classList.remove('hidden');
    } else {
      doNewConvo();
    }
  });
}
if (newConfirmOk) {
  newConfirmOk.addEventListener('click', () => {
    newConfirmOverlay.classList.add('hidden');
    doNewConvo();
  });
}
if (newConfirmCancel) {
  newConfirmCancel.addEventListener('click', () => newConfirmOverlay.classList.add('hidden'));
}
newConfirmOverlay?.addEventListener('click', (e) => {
  if (e.target === newConfirmOverlay) newConfirmOverlay.classList.add('hidden');
});

// ── Settings modal ──
const settingsBtn     = document.getElementById('settings-btn');
const settingsOverlay = document.getElementById('settings-overlay');
const settingsCancel  = document.getElementById('settings-cancel');
const settingsSave    = document.getElementById('settings-save');
const settingsBody    = document.getElementById('settings-body');
const settingsFilter  = document.getElementById('settings-filter');
const settingsFilterCount = document.getElementById('settings-filter-count');
const settingsHealthDetails = document.getElementById('cfg-health-details');
const settingsHealthList    = document.getElementById('cfg-health-list');
const settingsHealthNote    = document.getElementById('cfg-health-note');
// Save stays disabled until the live configuration has loaded. A failed GET previously left the form
// showing fallback values, so pressing Save could overwrite a working configuration with defaults.
let settingsLoaded = false;
const settingsStatus  = document.getElementById('settings-status');

const cfgProvider    = document.getElementById('cfg-provider');
const cfgModel       = document.getElementById('cfg-model');
const cfgEmbeddingsProvider = document.getElementById('cfg-embeddings-provider');
const cfgEmbeddings  = document.getElementById('cfg-embeddings');
const cfgEmbeddingContext = document.getElementById('cfg-embedding-context');
const cfgOllamaHost  = document.getElementById('cfg-ollama-host');
const cfgOpenaiKey   = document.getElementById('cfg-openai-key');
const cfgOpenaiBase  = document.getElementById('cfg-openai-base');
const cfgEmbedKey    = document.getElementById('cfg-embed-key');
const cfgEmbedBase   = document.getElementById('cfg-embed-base');
const cfgAnthropicKey  = document.getElementById('cfg-anthropic-key');
const cfgAnthropicBase = document.getElementById('cfg-anthropic-base');
const cfgTemperature = document.getElementById('cfg-temperature');
const cfgMaxTokens   = document.getElementById('cfg-max-tokens');
const cfgMaxHistory  = document.getElementById('cfg-max-history');
const cfgPassageSize = document.getElementById('cfg-passage-size');
const cfgQueryRewrite = document.getElementById('cfg-query-rewrite');
const cfgConvSummary   = document.getElementById('cfg-conv-summary');
const cfgIntentClassifier = document.getElementById('cfg-intent-classifier');
const cfgSuggestedQuestions = document.getElementById('cfg-suggested-questions');
const cfgMetaConversation = document.getElementById('cfg-meta-conversation');
const cfgTopicSwitchAck = document.getElementById('cfg-topic-switch-ack');
const cfgClarifyingQuestions = document.getElementById('cfg-clarifying-questions');
const cfgPartialMatch = document.getElementById('cfg-partial-match');
const cfgSemanticCache = document.getElementById('cfg-semantic-cache');
const cfgShowConfidence = document.getElementById('cfg-show-confidence');
const cfgAbstainWeak = document.getElementById('cfg-abstain-weak');
const cfgSemanticEntropy = document.getElementById('cfg-semantic-entropy');
const cfgSemanticEntropySamples = document.getElementById('cfg-semantic-entropy-samples');
const cfgReranker      = document.getElementById('cfg-reranker');
const cfgContextual    = document.getElementById('cfg-contextual-retrieval');
const cfgColbert       = document.getElementById('cfg-colbert-rerank');
const cfgRewriteModel   = document.getElementById('cfg-rewrite-model');
const cfgNumCtx          = document.getElementById('cfg-num-ctx');
// ── Secret fields ──
// API keys are never sent to the browser. A field whose key is already stored shows
// a placeholder and stays empty; leaving it empty on save means "unchanged". This
// prevents the classic failure where saving an unrelated setting silently wipes a
// stored credential the user couldn't see.
const SECRET_CLEAR = '__CLEAR__';

function applySecretField(el, isSet, emptyPlaceholder) {
  if (!el) return;
  el.value = '';
  el.dataset.wasSet = isSet ? '1' : '';
  el.dataset.cleared = '';
  el.placeholder = isSet ? '•••••••• (stored — type to replace)' : emptyPlaceholder;
  const btn = el.parentElement?.querySelector('.secret-clear');
  if (btn) btn.style.display = isSet ? '' : 'none';
}

function secretValue(el) {
  if (!el) return '';
  if (el.dataset.cleared === '1') return SECRET_CLEAR;   // explicit removal
  return el.value.trim();                                 // '' means unchanged
}

// Wire the Clear buttons — the only way to remove a stored key, so removal is always
// deliberate rather than a side effect of a blank field.
document.querySelectorAll('.secret-clear').forEach(btn => {
  btn.addEventListener('click', () => {
    const el = document.getElementById(btn.dataset.for);
    if (!el) return;
    el.value = '';
    el.dataset.cleared = '1';
    el.placeholder = 'will be removed on save';
    btn.style.display = 'none';
  });
});

const cfgOllamaKey       = document.getElementById('cfg-ollama-key');
const cfgWebSearch       = document.getElementById('cfg-web-search');
const cfgUrlCapture     = document.getElementById('cfg-url-capture');
const cfgWebAutosuggest  = document.getElementById('cfg-web-autosuggest');
const cfgWebRanking      = document.getElementById('cfg-web-ranking');
const cfgWebProxy        = document.getElementById('cfg-web-proxy');
const cfgWebProxyRotate  = document.getElementById('cfg-web-proxy-rotate');
const cfgWebProxyRetries = document.getElementById('cfg-web-proxy-retries');
const cfgWebProxyStrict  = document.getElementById('cfg-web-proxy-strict');
const cfgTtsEnabled      = document.getElementById('cfg-tts-enabled');
const cfgTtsVoice        = document.getElementById('cfg-tts-voice');
const cfgTtsVoiceRow     = document.getElementById('cfg-tts-voice-row');
const cfgTtsPreview      = document.getElementById('cfg-tts-preview');
const cfgTtsSpeed        = document.getElementById('cfg-tts-speed');
const cfgTtsSpeedRow     = document.getElementById('cfg-tts-speed-row');
const cfgTtsSpeedVal     = document.getElementById('cfg-tts-speed-val');
const cfgTtsLanguage     = document.getElementById('cfg-tts-language');
const cfgTtsLanguageRow  = document.getElementById('cfg-tts-language-row');
const cfgTtsSystemVoice  = document.getElementById('cfg-tts-system-voice');
const cfgTtsSystemLanguage = document.getElementById('cfg-tts-system-language');
const cfgTtsSystemVoiceRow = document.getElementById('cfg-tts-system-voice-row');
const cfgTtsVoicesDetails = document.getElementById('cfg-tts-voices-details');
const cfgTtsVoicesList = document.getElementById('cfg-tts-voices-list');
const cfgTtsVoicesNote = document.getElementById('cfg-tts-voices-note');
const cfgTtsSystemPreview = document.getElementById('cfg-tts-system-preview');
const cfgTtsOnlineVoices = document.getElementById('cfg-tts-online-voices');
const cfgTtsOnlineVoicesRow = document.getElementById('cfg-tts-online-voices-row');
const cfgPodcastVoicesRow = document.getElementById('cfg-podcast-voices-row');
const cfgPodcastVoiceA   = document.getElementById('cfg-podcast-voice-a');
const cfgPodcastVoiceB   = document.getElementById('cfg-podcast-voice-b');
const cfgPodcastPreviewA = document.getElementById('cfg-podcast-preview-a');
const cfgPodcastPreviewB = document.getElementById('cfg-podcast-preview-b');
const cfgSttEnabled      = document.getElementById('cfg-stt-enabled');
const cfgSttLanguage     = document.getElementById('cfg-stt-language');
const cfgSttLanguageRow  = document.getElementById('cfg-stt-language-row');
const cfgMicDevice       = document.getElementById('cfg-mic-device');
const cfgMicDeviceRow    = document.getElementById('cfg-mic-device-row');
const cfgAudioIngest     = document.getElementById('cfg-audio-ingest');
const cfgAudioMinutes    = document.getElementById('cfg-audio-minutes');
const cfgAudioMinutesRow = document.getElementById('cfg-audio-minutes-row');
const cfgEmbeddingBanks  = document.getElementById('cfg-embedding-banks');
const cfgCorrective      = document.getElementById('cfg-corrective-retrieval');
const cfgCrossLingual    = document.getElementById('cfg-cross-lingual');
const cfgDocSummaries    = document.getElementById('cfg-document-summaries');
const cfgAutoSynthesis   = document.getElementById('cfg-auto-synthesis');
const cfgRagFusion       = document.getElementById('cfg-rag-fusion');
const cfgHyde            = document.getElementById('cfg-hyde');
const cfgEntityGraph     = document.getElementById('cfg-entity-graph');
const cfgGraphRag        = document.getElementById('cfg-graph-rag');
const cfgAdaptive        = document.getElementById('cfg-adaptive-retrieval');
const cfgAuditLog        = document.getElementById('cfg-audit-log');
const cfgAllowNetwork    = document.getElementById('cfg-allow-network');
const cfgNetworkNote     = document.getElementById('cfg-network-note');
let authConfigured = false;   // whether a sign-in exists (account or SSO) — gates turning network access on
let networkWasOn = false;     // the saved value, so we only prompt to restart when it actually changes
// Show the explainer when network access is checked; block turning it on without a sign-in (never expose the
// documents unauthenticated). Mirrors the server gate, with a clear message instead of a silent revert.
function updateNetworkRow() {
  if (cfgNetworkNote) cfgNetworkNote.classList.toggle('hidden', !(cfgAllowNetwork && cfgAllowNetwork.checked));
}
if (cfgAllowNetwork) cfgAllowNetwork.addEventListener('change', () => {
  if (cfgAllowNetwork.checked && !authConfigured) {
    cfgAllowNetwork.checked = false;
    try { showToast('Set up an account first (Settings → Accounts) so sign-in is required — then you can allow access from other devices.', 'error'); } catch {}
  }
  updateNetworkRow();
});
const cfgDebug           = document.getElementById('cfg-debug');

// Hardware-aware model suggestions. Fetches /api/model-recommendations and lists chat +
// embedding models that suit this machine; clicking "Use" fills the model field. Kept
// self-contained; escapes all interpolated text (model names, system label) for safety.
const cfgSuggestBtn = document.getElementById('cfg-suggest-models');
const cfgSuggestBox = document.getElementById('cfg-model-suggestions');
function renderModelSuggestions(data) {
  const installed = new Set(data.installed || []);
  const isInstalled = (name) => installed.has(name) || [...installed].some(i => i.split(':')[0] === name.split(':')[0]);
  const item = (m, field) => {
    const tags = [];
    if (m.recommended) tags.push('<span class="ms-tag ms-rec">recommended</span>');
    if (m.fits === false) tags.push('<span class="ms-tag ms-big">may be too large</span>');
    if (isInstalled(m.name)) tags.push('<span class="ms-tag ms-inst">installed</span>');
    return `<div class="ms-item"><div class="ms-main"><code>${escapeHtml(m.name)}</code> ${tags.join(' ')}`
      + `<div class="ms-note">${escapeHtml(m.note || '')}</div></div>`
      + `<button type="button" class="ms-use" data-field="${field}" data-name="${escapeHtml(m.name)}">Use</button></div>`;
  };
  // Guard the system label: a well-formed but partial response (no `system`) would otherwise
  // throw here and surface the misleading "Could not reach the server."
  let html = data.system && data.system.label ? `<div class="ms-sys">${escapeHtml(data.system.label)}</div>` : '';
  html += '<div class="ms-group">Chat models</div>' + (data.chat || []).map(m => item(m, 'model')).join('');
  html += '<div class="ms-group">Embedding models</div>' + (data.embeddings || []).map(m => item(m, 'embeddings')).join('');
  for (const n of (data.notes || [])) html += `<div class="ms-note ms-general">${escapeHtml(n)}</div>`;
  html += '<div class="ms-note ms-general">Not installed? Pull it first: <code>ollama pull &lt;name&gt;</code></div>';
  cfgSuggestBox.innerHTML = html;
  cfgSuggestBox.classList.remove('hidden');
  cfgSuggestBox.querySelectorAll('.ms-use').forEach(btn => {
    btn.addEventListener('click', () => {
      const field = btn.getAttribute('data-field'), name = btn.getAttribute('data-name');
      if (field === 'model' && cfgModel) cfgModel.value = name;
      if (field === 'embeddings' && cfgEmbeddings) cfgEmbeddings.value = name;
      refreshModelPickers();   // reflect the applied suggestion in the dropdowns (uses the cached list)
      btn.textContent = 'Selected ✓';
      setTimeout(() => { btn.textContent = 'Use'; }, 1200);
    });
  });
}
if (cfgSuggestBtn && cfgSuggestBox) {
  cfgSuggestBtn.addEventListener('click', async () => {
    cfgSuggestBtn.disabled = true;
    const orig = cfgSuggestBtn.textContent;
    cfgSuggestBtn.textContent = 'Checking…';
    try {
      const r = await fetch('/api/model-recommendations');
      const data = await r.json();
      if (data && !data.error) renderModelSuggestions(data);
      else { cfgSuggestBox.textContent = 'Could not compute suggestions.'; cfgSuggestBox.classList.remove('hidden'); }
    } catch {
      cfgSuggestBox.textContent = 'Could not reach the server.'; cfgSuggestBox.classList.remove('hidden');
    } finally {
      cfgSuggestBtn.disabled = false; cfgSuggestBtn.textContent = orig;
    }
  });
}

// ── Indexed source folders ──
// Folders are indexed in place. The list is edited locally and saved with the rest
// of the settings; a preview call reports how many files a folder would add before
// the user commits to it.
let sourcePaths = [];
const sourceList     = document.getElementById('source-list');
const sourceNewPath  = document.getElementById('source-new-path');
const sourceNewRec   = document.getElementById('source-new-recursive');
const sourceAddBtn   = document.getElementById('source-add-btn');
const sourcePreviewMsg = document.getElementById('source-preview-msg');

// Ask the server how many files a folder currently contributes and show it inline.
// Runs when a folder is added, when subfolders is toggled, and when settings open.
async function countSource(i) {
  const s = sourcePaths[i];
  if (!s) return;
  const el = document.getElementById(`source-count-${i}`);
  if (el) el.textContent = '…';
  try {
    const qs = new URLSearchParams({ path: s.path, recursive: String(!!s.recursive) });
    const res = await fetch(`/api/source-preview?${qs}`);
    const data = await res.json();
    if (!res.ok) { if (el) el.textContent = '—'; return; }
    sourcePaths[i].count = data.count;
    const cur = document.getElementById(`source-count-${i}`);
    if (cur) cur.textContent = `${data.count} file${data.count === 1 ? '' : 's'}`;
  } catch {
    if (el) el.textContent = '—';
  }
}

function renderSourceList() {
  if (!sourceList) return;
  sourceList.innerHTML = '';
  if (sourcePaths.length === 0) {
    sourceList.innerHTML = '<div class="settings-hint">Only <code>data/documents</code> is indexed.</div>';
    return;
  }
  sourcePaths.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'source-item' + (s.enabled === false ? ' source-off' : '');

    // Enable toggle — an unchecked folder stays in the list but is not indexed, so
    // a folder can be paused without losing its settings.
    const on = document.createElement('input');
    on.type = 'checkbox';
    on.checked = s.enabled !== false;
    on.title = 'Index this folder';
    on.addEventListener('change', () => {
      sourcePaths[i].enabled = on.checked;
      renderSourceList();
      saveSourceFolders();
    });

    const label = document.createElement('span');
    label.className = 'source-path';
    label.title = s.path;
    label.textContent = s.path;

    // Controls live on their own line beneath the path, grouped together so each
    // label sits next to the checkbox it belongs to.
    const controls = document.createElement('div');
    controls.className = 'source-controls';

    // Per-folder subfolder control, editable after the folder is added.
    const recWrap = document.createElement('label');
    recWrap.className = 'source-flag-toggle';
    recWrap.title = 'Include subfolders';
    const rec = document.createElement('input');
    rec.type = 'checkbox';
    rec.checked = !!s.recursive;
    rec.addEventListener('change', () => {
      sourcePaths[i].recursive = rec.checked;
      saveSourceFolders();
      // Re-count so the user sees immediately what enabling subfolders picks up —
      // a folder with nothing at the top level often has plenty one level down.
      countSource(i);
    });
    recWrap.appendChild(rec);
    recWrap.appendChild(document.createTextNode(' subfolders'));

    const count = document.createElement('span');
    count.className = 'source-count';
    count.id = `source-count-${i}`;
    count.textContent = s.count === undefined ? '' : `${s.count} file${s.count === 1 ? '' : 's'}`;

    const del = document.createElement('button');
    del.type = 'button'; del.className = 'source-del'; del.textContent = '✕';
    del.title = 'Remove this folder';
    del.setAttribute('aria-label', 'Remove this folder');   // the ✕ glyph is not a usable accessible name
    del.addEventListener('click', async () => {
      // Removing a folder drops its documents from the index on the next pass, and
      // re-adding means re-embedding everything — worth a confirmation rather than
      // a one-click accident next to a checkbox.
      const count = s.count === undefined ? '' : ` (${s.count} file${s.count === 1 ? '' : 's'})`;
      const okGo = await showConfirm({
        title: 'Stop indexing this folder?',
        message: `${s.path}${count}\n\nThe files stay on disk, but they'll be removed from this workspace's index.`,
        okLabel: 'Stop indexing', danger: true,
      });
      if (!okGo) return;
      sourcePaths.splice(i, 1); renderSourceList(); saveSourceFolders();
    });

    controls.appendChild(recWrap);
    controls.appendChild(count);

    row.appendChild(on);
    row.appendChild(label);
    row.appendChild(del);
    row.appendChild(controls);
    sourceList.appendChild(row);
  });
}

// ── Folder picker ──
// A browser file dialog never exposes a real filesystem path, so folders are chosen
// by browsing the server's directories (Lokyni runs locally, with the user's own
// permissions). The picker starts at the home directory and is confined to it.
const pickerOverlay = document.getElementById('picker-overlay');
const pickerList    = document.getElementById('picker-list');
const pickerCurrent = document.getElementById('picker-current');
const pickerVolumes = document.getElementById('picker-volumes');
const pickerClose   = document.getElementById('picker-close');
const pickerCancel  = document.getElementById('picker-cancel');
const pickerSelect  = document.getElementById('picker-select');
const sourceBrowseBtn = document.getElementById('source-browse-btn');
let pickerPath = null;
// Which input the picker writes into when the user clicks "Use this folder".
// Defaults to the indexed-source input; the connector Browse button repoints it.
let pickerTarget = null;

async function pickerLoad(dir) {
  pickerList.innerHTML = '<div class="picker-empty">Loading…</div>';
  try {
    const qs = dir ? `?path=${encodeURIComponent(dir)}` : '';
    const res = await fetch(`/api/browse${qs}`);
    const data = await res.json();
    if (!res.ok) { pickerList.innerHTML = `<div class="picker-empty">${escapeHtml(data.error || 'Could not read that folder.')}</div>`; return; }
    pickerPath = data.path;
    pickerCurrent.textContent = data.path;

    // Volume shortcuts — home, external drives, network mounts, and (on Windows)
    // drive letters. Without these an external drive is unreachable: the picker
    // starts at home and there's no way to navigate across to another volume.
    if (pickerVolumes) {
      pickerVolumes.innerHTML = '';
      (data.volumes || []).forEach(v => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'picker-vol' + (data.path === v.path ? ' active' : '');
        const iconId = v.kind === 'home' ? 'ic-home' : v.kind === 'root' ? 'ic-drive' : 'ic-drive';
        b.innerHTML = `<svg class="ico" aria-hidden="true"><use href="#${iconId}"/></svg> ${escapeHtml(v.name)}`;
        b.title = v.path;
        b.addEventListener('click', () => pickerLoad(v.path));
        pickerVolumes.appendChild(b);
      });
    }

    pickerList.innerHTML = '';
    if (data.parent) {
      const up = document.createElement('button');
      up.type = 'button'; up.className = 'picker-item picker-up';
      up.textContent = '⬑  ..';
      up.addEventListener('click', () => pickerLoad(data.parent));
      pickerList.appendChild(up);
    }
    if (data.dirs.length === 0) {
      const none = document.createElement('div');
      none.className = 'picker-empty';
      none.textContent = 'No subfolders here — you can still select this folder.';
      pickerList.appendChild(none);
    }
    data.dirs.forEach(d => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'picker-item';
      b.innerHTML = `<svg class="ico" aria-hidden="true"><use href="#ic-folder"/></svg> ${escapeHtml(d.name)}`;
      b.addEventListener('click', () => pickerLoad(d.path));
      pickerList.appendChild(b);
    });
  } catch {
    pickerList.innerHTML = '<div class="picker-empty">Could not browse folders.</div>';
  }
}

function pickerOpen()  { pickerTarget = sourceNewPath; pickerOverlay.classList.remove('hidden'); pickerLoad(sourceNewPath.value.trim() || null); }
function pickerHide()  { pickerOverlay.classList.add('hidden'); }

// Open the picker targeting a specific input, seeded from its current value.
function pickerOpenFor(input) {
  pickerTarget = input;
  pickerOverlay.classList.remove('hidden');
  pickerLoad((input && input.value.trim()) || null);
}

if (sourceBrowseBtn) sourceBrowseBtn.addEventListener('click', pickerOpen);
const connectorBrowseBtn = document.getElementById('connector-browse-btn');
if (connectorBrowseBtn) connectorBrowseBtn.addEventListener('click', () => {
  pickerOpenFor(document.getElementById('connector-fs-path'));
});
if (pickerClose)  pickerClose.addEventListener('click', pickerHide);
if (pickerCancel) pickerCancel.addEventListener('click', pickerHide);
if (pickerSelect) pickerSelect.addEventListener('click', () => {
  if (pickerPath && pickerTarget) pickerTarget.value = pickerPath;
  pickerHide();
});
if (pickerOverlay) pickerOverlay.addEventListener('click', (e) => { if (e.target === pickerOverlay) pickerHide(); });

if (sourceAddBtn) {
  sourceAddBtn.addEventListener('click', async () => {
    const p = sourceNewPath.value.trim();
    if (!p) {
      sourcePreviewMsg.textContent = 'Enter a folder path, or use Browse to pick one.';
      return;
    }
    // Compare loosely: the stored path is the server-resolved form, which can differ
    // from what was typed by a trailing slash. A strict === would both miss a real
    // duplicate and, worse, give no feedback about why nothing happened.
    const norm = (x) => String(x).replace(/\/+$/, '');
    if (sourcePaths.some(s => norm(s.path) === norm(p))) {
      sourcePreviewMsg.textContent = 'That folder is already in the list.';
      return;
    }
    sourcePreviewMsg.textContent = 'Checking folder…';
    const recursive = sourceNewRec.checked;
    try {
      const qs = new URLSearchParams({ path: p, recursive: String(recursive) });
      const res = await fetch(`/api/source-preview?${qs}`);
      let data;
      try {
        data = await res.json();
      } catch {
        // A non-JSON response (proxy error page, truncated body) previously threw
        // into the outer catch, showing a generic message with no cause.
        sourcePreviewMsg.textContent = `Could not read that folder (server returned ${res.status}).`;
        return;
      }
      // A genuine error (missing folder, no permission) is the only reason not to
      // add. An empty result is NOT — the user picked this folder deliberately, and
      // files may appear later or live in subfolders. Previously an empty preview
      // silently discarded the folder, which looked like the Add button doing nothing.
      if (!res.ok) { sourcePreviewMsg.textContent = data.error || 'Could not read that folder.'; return; }

      sourcePaths.push({ path: data.path, recursive, maxDepth: 3, enabled: true, count: data.count });
      sourceNewPath.value = '';
      sourceNewRec.checked = false;
      renderSourceList();
      saveSourceFolders();

      const mb = (data.bytes / 1e6).toFixed(1);
      if (data.count === 0) {
        // Say what the folder DOES contain — "0 files" on a folder visibly full of
        // media is confusing, and an extension breakdown makes the reason obvious.
        const found = data.otherCount
          ? ` It has ${data.otherCount} other file${data.otherCount === 1 ? '' : 's'} (${(data.otherTypes || []).join(', ')}) that aren't supported types.`
          : '';
        sourcePreviewMsg.textContent = (recursive
          ? 'Added — but no supported documents found.'
          : 'Added — no supported documents at the top level. Tick “subfolders” to look deeper.')
          + found + ' Supported: ' + SUPPORTED_FORMATS;
      } else {
        sourcePreviewMsg.textContent =
          `Added — ${data.count} file${data.count === 1 ? '' : 's'} (${mb} MB)` +
          (data.atLimit ? ', at the file limit so some were skipped' : '') +
          '. Save to apply.';
      }
    } catch (e) {
      // Surface the actual reason — this path was previously indistinguishable from
      // the button simply doing nothing.
      sourcePreviewMsg.textContent = `Could not check that folder: ${e.message || e}`;
    }
  });
}

function updateProviderVisibility() {
  // The chat and embedding providers are independent, so a provider's connection rows (host/key/base)
  // must show when EITHER the chat provider or the embedding provider uses it. Example: chat on Anthropic
  // while embedding on OpenAI still needs the OpenAI key visible. Anthropic is chat-only, so its rows
  // follow the chat provider alone.
  const chat = cfgProvider?.value || 'ollama';
  const emb  = cfgEmbeddingsProvider?.value || 'ollama';
  const needOllama = chat === 'ollama' || emb === 'ollama';
  const needOpenai = chat === 'openai' || emb === 'openai';
  const needAnthropic = chat === 'anthropic';
  document.querySelectorAll('.cfg-ollama-row').forEach(r => r.classList.toggle('hidden', !needOllama));
  document.querySelectorAll('.cfg-openai-row').forEach(r => r.classList.toggle('hidden', !needOpenai));
  // The separate embed key/base apply ONLY to an OpenAI-compatible EMBED endpoint, so show them when the
  // embedding provider is openai (they fall back to the chat OpenAI key/base when left blank).
  document.querySelectorAll('.cfg-embed-openai-row').forEach(r => r.classList.toggle('hidden', emb !== 'openai'));
  document.querySelectorAll('.cfg-anthropic-row').forEach(r => r.classList.toggle('hidden', !needAnthropic));
}

// ── Easy model selection ─────────────────────────────────────────────────────
// Turn the free-text Model and Embeddings fields into a dropdown of the models actually
// available from the selected provider (Ollama's installed models, or the OpenAI model list),
// with a "Custom / enter manually…" escape hatch. The user picks from a list instead of typing
// an exact name. The text input stays the source of truth (the dropdown just sets its value), so
// saving, custom values, and a provider that can't be listed (offline) all keep working.
const _modelPickers = [];       // { input, select, blankLabel } — the Settings pickers (refreshed from the Settings fields)
const _modelListCache = {};     // "provider|host" -> { ts, models }

// Turn a free-text model field into a dropdown of the provider's available models (with a "Custom / enter
// manually…" fallback). `registry` is the list the picker registers into, so a separate surface (e.g. the
// first-run overlay) can keep its own pickers refreshed from its OWN provider/host fields instead of Settings'.
function attachModelPicker(input, blankLabel, kind, registry = _modelPickers) {
  if (!input || input.dataset.pickerAttached) return;
  input.dataset.pickerAttached = '1';
  const select = document.createElement('select');
  select.className = 'model-picker-select';
  // Accessible name: the settings labels have no `for`, so name the injected control from the
  // row's label text for screen readers.
  const labelText = input.closest('.settings-row')?.querySelector('label')?.textContent?.trim();
  if (labelText) select.setAttribute('aria-label', labelText);
  // Stack the dropdown above the custom text input (reusing the app's settings stack), so
  // "Custom" mode shows the field full-width below the dropdown instead of cramped beside it.
  const stack = document.createElement('div');
  stack.className = 'settings-input-stack';
  input.parentNode.insertBefore(stack, input);
  stack.appendChild(select);
  stack.appendChild(input);
  select.addEventListener('change', () => {
    if (select.value === '__custom__') { input.style.display = ''; input.focus(); }
    else { input.value = select.value; input.style.display = 'none'; }
  });
  registry.push({ input, select, blankLabel, kind: kind || '' });
}

function renderModelPicker(picker, models) {
  const { input, select, blankLabel } = picker;
  const current = (input.value || '').trim();
  const list = Array.isArray(models) ? models : [];
  select.innerHTML = '';
  const add = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; select.appendChild(o); };
  add('', blankLabel);
  add('__custom__', 'Custom / enter manually…');
  for (const m of list) add(m, m);
  if (current && list.includes(current)) { select.value = current; input.style.display = 'none'; }
  else if (current) { select.value = '__custom__'; input.style.display = ''; }   // a typed value not in the list
  else { select.value = ''; input.style.display = 'none'; }
}

async function fetchModelList(provider, host, baseUrl, kind) {
  const key = `${provider}|${host || ''}|${baseUrl || ''}|${kind || ''}`;
  const c = _modelListCache[key];
  if (c && Date.now() - c.ts < 60000) return c.models;   // brief per-session cache; provider/host change re-fetches
  try {
    const params = new URLSearchParams({ provider });
    if (provider === 'ollama' && host) params.set('host', host);
    if (provider === 'openai' && baseUrl) params.set('base_url', baseUrl);
    if (kind) params.set('kind', kind);
    const r = await fetch(`/api/models?${params.toString()}`);
    const j = await r.json();
    const models = (j && j.available && Array.isArray(j.models)) ? j.models : [];
    _modelListCache[key] = { ts: Date.now(), models };
    return models;
  } catch { return []; }
}

// Refresh every model dropdown from the currently-selected provider (and Ollama host), so
// switching the provider or editing the host re-lists without having to save first.
let _modelPickerSeq = 0;
async function refreshModelPickers() {
  if (!_modelPickers.length) return;
  const seq = ++_modelPickerSeq;
  // The embeddings picker lists from the EMBEDDING provider; the chat picker from the CHAT provider —
  // they can differ (e.g. Claude chat with Ollama embeddings). Resolve the provider per picker kind,
  // and its endpoint from that provider's own host/base field.
  const providerForKind = (kind) => (kind === 'embeddings')
    ? (cfgEmbeddingsProvider?.value || 'ollama')
    : (cfgProvider?.value || 'ollama');
  const endpointFor = (provider) => ({
    host:    provider === 'ollama' ? (cfgOllamaHost?.value || '') : '',
    baseUrl: provider === 'openai' ? (cfgOpenaiBase?.value || '') : '',
  });
  // Fetch each distinct kind once (chat pickers use the full list; the embeddings picker asks for
  // the embedding-only list), then paint every picker from its kind's list.
  const kinds = [...new Set(_modelPickers.map(p => p.kind || ''))];
  const lists = {};
  await Promise.all(kinds.map(async (k) => {
    const provider = providerForKind(k);
    const { host, baseUrl } = endpointFor(provider);
    lists[k] = await fetchModelList(provider, host, baseUrl, k);
  }));
  if (seq !== _modelPickerSeq) return;   // a newer refresh started — don't let this stale response repaint
  for (const p of _modelPickers) renderModelPicker(p, lists[p.kind || '']);
}

async function loadSettings() {
  settingsLoaded = false;
  if (settingsSave) settingsSave.disabled = true;
  settingsStatus.textContent = '';
  settingsStatus.className = '';
  try {
    const res  = await fetch('/api/config');
    const cfg  = await res.json();
    cfgProvider.value    = cfg.provider    || settingDefault('provider');
    cfgModel.value       = cfg.model       || '';
    if (cfgEmbeddingsProvider) cfgEmbeddingsProvider.value = cfg.embeddingsProvider || settingDefault('embeddingsProvider');
    cfgEmbeddings.value  = cfg.embeddingsModel || '';
    cfgOllamaHost.value  = cfg.ollamaHost  || '';
    // Make the Model and Embeddings fields dropdowns of the provider's available models (with a
    // Custom fallback). Attach is idempotent; refresh lists them from the current provider/host.
    attachModelPicker(cfgModel, '(choose a model)', 'chat');
    attachModelPicker(cfgEmbeddings, '(choose a model)', 'embeddings');
    refreshModelPickers();
    // Secrets are never sent to the browser. An empty field with a "stored"
    // placeholder means a key exists; typing replaces it, and the Clear button
    // removes it. This is what stops an unrelated settings save from wiping a key
    // the user can't see in the form.
    applySecretField(cfgOllamaKey, cfg.ollamaApiKeySet, 'leave empty for local Ollama');
    applySecretField(cfgOpenaiKey, cfg.openaiApiKeySet, 'sk-…');
    cfgOpenaiBase.value  = cfg.openaiBaseUrl || '';
    if (cfgEmbedKey)  applySecretField(cfgEmbedKey, cfg.embeddingsApiKeySet, 'leave empty to reuse the chat key');
    if (cfgEmbedBase) cfgEmbedBase.value = cfg.embeddingsBaseUrl || '';
    if (cfgAnthropicKey)  applySecretField(cfgAnthropicKey, cfg.anthropicApiKeySet, 'sk-ant-…');
    if (cfgAnthropicBase) cfgAnthropicBase.value = cfg.anthropicBaseUrl || '';
    cfgTemperature.value = cfg.temperature ?? settingDefault('temperature');
    cfgMaxTokens.value   = cfg.maxTokens ? cfg.maxTokens : '';   // 0 / unset = Auto → blank field (shows the "Auto" placeholder)
    cfgMaxHistory.value  = cfg.maxHistory  ?? settingDefault('maxHistory');
    cfgPassageSize.value = cfg.passageSize ?? settingDefault('passageSize');
    cfgQueryRewrite.checked = cfg.useQueryRewrite === true;
    cfgConvSummary.checked  = cfg.useConversationSummary === true;
    if (cfgIntentClassifier) cfgIntentClassifier.checked = cfg.useIntentClassifier === true;
    if (cfgSuggestedQuestions) cfgSuggestedQuestions.checked = cfg.useSuggestedQuestions === true;
    if (cfgMetaConversation) cfgMetaConversation.checked = cfg.useMetaConversation === true;
    if (cfgTopicSwitchAck) cfgTopicSwitchAck.checked = cfg.useTopicSwitchAck === true;
    if (cfgClarifyingQuestions) cfgClarifyingQuestions.checked = cfg.useClarifyingQuestions === true;
    if (cfgPartialMatch) cfgPartialMatch.checked = cfg.usePartialMatchTier === true;
    if (cfgSemanticCache) cfgSemanticCache.checked = cfg.useSemanticCache === true;
    if (cfgShowConfidence) cfgShowConfidence.checked = cfg.showAnswerConfidence === true;
    if (cfgAbstainWeak) cfgAbstainWeak.checked = cfg.abstainOnWeakEvidence === true;
    if (cfgSemanticEntropy) cfgSemanticEntropy.checked = cfg.useSemanticEntropy === true;
    if (cfgSemanticEntropySamples) cfgSemanticEntropySamples.value = cfg.semanticEntropySamples ?? settingDefault('semanticEntropySamples');
    if (cfgReranker) cfgReranker.checked = cfg.useReranker === true;
    if (cfgContextual) cfgContextual.checked = cfg.useContextualRetrieval === true;
    if (cfgColbert) cfgColbert.checked = cfg.useColbertRerank === true;
    if (cfgEmbeddingBanks) cfgEmbeddingBanks.checked = cfg.useEmbeddingBanks === true;
    if (cfgCorrective) cfgCorrective.checked = cfg.useCorrectiveRetrieval === true;
    if (cfgCrossLingual) cfgCrossLingual.checked = cfg.useCrossLingual === true;
    if (cfgDocSummaries) cfgDocSummaries.checked = cfg.useDocumentSummaries === true;
    if (cfgAutoSynthesis) cfgAutoSynthesis.checked = cfg.useAutoSynthesis === true;
    if (cfgRagFusion) cfgRagFusion.checked = cfg.useRagFusion === true;
    if (cfgHyde) cfgHyde.checked = cfg.useHyde === true;
    if (cfgEntityGraph) cfgEntityGraph.checked = cfg.useEntityGraph === true;
    if (cfgGraphRag) { cfgGraphRag.checked = cfg.useGraphRag === true; updateGraphRagActions(); if (cfgGraphRag.checked) refreshGraphStatus(); }
    if (cfgAdaptive) cfgAdaptive.checked = cfg.useAdaptiveRetrieval === true;
    if (cfgAuditLog) cfgAuditLog.checked = cfg.auditLog === true;
    authConfigured = cfg.authConfigured === true;
    networkWasOn = cfg.allowNetworkAccess === true;
    if (cfgAllowNetwork) { cfgAllowNetwork.checked = networkWasOn; updateNetworkRow(); }
    renderApiKeyScopes(cfg.apiKeyScopes);
    if (cfgDebug) cfgDebug.checked = cfg.debug === true;
    // The "Consolidate embedding banks" action only applies when banks are enabled.
    const showConsolidate = cfg.useEmbeddingBanks === true;
    document.getElementById('consolidate-banks-row')?.classList.toggle('hidden', !showConsolidate);
    document.getElementById('consolidate-banks-btnrow')?.classList.toggle('hidden', !showConsolidate);
    // Read-only bank reuse summary (its own /api/health fetch; hides itself when there is nothing to show).
    if (showConsolidate) { renderBankState(); } else { document.getElementById('cfg-bank-state-row')?.classList.add('hidden'); }
    // The "will this re-embed?" check only applies with banks on (otherwise a model change always rebuilds).
    document.querySelector('.cfg-embed-banks-only')?.classList.toggle('hidden', !showConsolidate);
    cfgRewriteModel.value    = cfg.rewriteModel || '';
    // numCtx 0 = automatic: leave the field blank, and show what auto resolved to (per the active model) as
    // the placeholder, so the operator sees the real window without it looking like a hard-set value.
    cfgNumCtx.value          = (cfg.numCtx && cfg.numCtx > 0) ? cfg.numCtx : '';
    if (cfgNumCtx) cfgNumCtx.placeholder = cfg.numCtxEffective ? ('auto · ' + cfg.numCtxEffective) : 'auto';
    if (cfgEmbeddingContext) cfgEmbeddingContext.value = cfg.embeddingContextTokens ?? settingDefault('embeddingContextTokens');
    if (cfgUseOcr)      cfgUseOcr.checked      = cfg.useOcr === true;
    if (cfgOcrEngine)   cfgOcrEngine.value     = cfg.ocrEngine === 'vision' ? 'vision' : settingDefault('ocrEngine');
    if (cfgOcrModel)    cfgOcrModel.value      = cfg.ocrVisionModel || '';
    if (cfgVisionDescribe) cfgVisionDescribe.checked = cfg.visionDescribe === true;
    if (cfgVisualIngest) cfgVisualIngest.checked = cfg.useVisualIngest === true;
    if (cfgVisualCrop) cfgVisualCrop.checked = cfg.visualIngestCropFigures === true;
    if (cfgVisionModelText) cfgVisionModelText.value = cfg.visionModel || '';
    populateVisionModels(cfg.visionModel || '');
    updateVisionRows();
    if (cfgOcrMaxPages) cfgOcrMaxPages.value   = cfg.ocrMaxPages ?? settingDefault('ocrMaxPages');
    ocrAutoWorkers = cfg.ocrWorkersAuto ?? null;
    ocrCpuCount    = cfg.cpuCount ?? null;
    if (cfgOcrWorkers) cfgOcrWorkers.value = cfg.ocrWorkers ? String(cfg.ocrWorkers) : '';
    updateOcrWorkersNote();
    renderOcrLanguages(cfg.ocrLanguageOptions || [], cfg.ocrLanguages || []);
    updateOcrVisibility();
    if (cfgWebSearch)      cfgWebSearch.checked      = cfg.useWebSearch === true;
    if (cfgUrlCapture)     cfgUrlCapture.value       = cfg.urlCapture || settingDefault('urlCapture');
    if (cfgWebAutosuggest) cfgWebAutosuggest.checked = cfg.webAutoSuggest === true;
    if (cfgWebRanking)     cfgWebRanking.checked     = cfg.useWebResultRanking === true;
    if (cfgWebProxy)       cfgWebProxy.value         = cfg.webProxyUrl || '';
    if (cfgWebProxyRotate) cfgWebProxyRotate.checked  = cfg.webProxyRotate === true;   // opt-in, default off
    if (cfgWebProxyRetries) cfgWebProxyRetries.value  = cfg.webProxyRetries ?? settingDefault('webProxyRetries');
    if (cfgWebProxyStrict) cfgWebProxyStrict.checked  = cfg.webProxyStrict === true;   // opt-in, default off
    applyWebSearchVisibility(cfg.useWebSearch === true);
    if (cfgTtsEnabled) cfgTtsEnabled.checked = cfg.ttsEnabled === true;
    // The saved per-language voice preferences come from the config API (the server has already normalized
    // their shape). A missing/malformed list is simply "Automatic".
    ttsSystemVoicePrefs = Array.isArray(cfg.ttsSystemVoices) ? cfg.ttsSystemVoices : [];
    populateTtsVoices(cfg.ttsVoice);
    populatePodcastVoices(cfg.podcastVoiceA, cfg.podcastVoiceB);
    populateTtsLanguages(cfg.ttsLanguage);
    if (cfgTtsOnlineVoices) cfgTtsOnlineVoices.checked = cfg.ttsAllowOnlineVoices === true;
    populateSystemVoiceOptions();
    if (cfgTtsSpeed) { const sp = (typeof cfg.ttsSpeed === 'number' ? cfg.ttsSpeed : settingDefault('ttsSpeed')); cfgTtsSpeed.value = sp; updateTtsSpeedLabel(); }
    applyTtsVisibility(cfg.ttsEnabled === true);
    if (cfgSttEnabled) cfgSttEnabled.checked = cfg.sttEnabled === true;
    populateSttLanguages(cfg.sttLanguage);
    // Remember the preferred microphone and fill the picker. Device names only appear after mic access is granted
    // once, so when voice input is already on, prompt for access (once) so the list fills instead of showing an
    // empty "no microphone" box. Works the same in the web app and the desktop app.
    voiceMicPref = { id: cfg.micDeviceId || '', label: cfg.micLabel || '' };
    populateMicDevices().then(() => { if (cfg.sttEnabled === true) primeMicLabels(); });
    applySttVisibility(cfg.sttEnabled === true);
    // Freshly re-read both voice statuses (did a model finish downloading? is one downloading now?) and show them
    // in Settings; start the shared poll if either model is still being fetched so the percent advances live.
    fetchTtsStatus(true).then((s) => { updateVoiceStatus(); if (voiceDownloadPending(s)) pollVoiceWarm(); });
    fetchSttStatus(true).then((s) => { updateVoiceStatus(); if (voiceDownloadPending(s)) pollVoiceWarm(); });
    if (cfgAudioIngest) cfgAudioIngest.checked = cfg.useAudioIngest === true;
    if (cfgAudioMinutes) cfgAudioMinutes.value = cfg.audioMaxMinutes ?? settingDefault('audioMaxMinutes');
    applyAudioIngestVisibility(cfg.useAudioIngest === true);
    applySuggestVisibility(cfg.useSuggestedQuestions === true);
    updateProviderVisibility();
    settingsLoaded = true;
    if (settingsSave) settingsSave.disabled = false;
  } catch (e) {
    settingsLoaded = false;
    if (settingsSave) settingsSave.disabled = true;
    settingsStatus.textContent = 'Failed to load settings. Close and reopen Settings to retry. Save is disabled so a partial load cannot overwrite your configuration.';
    settingsStatus.className = 'error';
  }
}

// ── API keys ──
const apikeyList     = document.getElementById('apikey-list');
const apikeyNameInp  = document.getElementById('apikey-name');
const apikeyCreateBtn = document.getElementById('apikey-create-btn');
const apikeyNew      = document.getElementById('apikey-new');

// Populate the per-key workspace scoping control. A key with NO workspaces checked can query every
// workspace (the API's empty-allowedWorkspaces = all rule); checking specific ones limits it to those,
// following least privilege. Rendered from the live workspace list so a new workspace appears here too.
async function populateKeyWorkspaces() {
  const host = document.getElementById('apikey-ws-list');
  if (!host) return;
  try {
    const data = await getJSON('/api/workspaces');
    const list = (data.workspaces || []);
    host.replaceChildren();
    if (!list.length) { host.innerHTML = '<span class="settings-hint">No workspaces yet.</span>'; return; }
    for (const w of list) {
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.className = 'apikey-ws'; cb.value = w.id;
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' ' + (w.name || w.id)));
      host.appendChild(label);
    }
  } catch { host.innerHTML = '<span class="settings-hint">Could not load workspaces.</span>'; }
}

async function loadApiKeys() {
  if (!apikeyList) return;
  populateKeyWorkspaces();
  apikeyList.innerHTML = '<div class="apikey-empty">Loading…</div>';
  try {
    const res = await fetch('/api/keys');
    const data = await res.json();
    const keys = (data.keys || []).filter(k => !k.revoked);
    if (keys.length === 0) {
      apikeyList.innerHTML = '<div class="apikey-empty">No API keys yet.</div>';
      return;
    }
    apikeyList.innerHTML = '';
    keys.forEach(k => {
      const row = document.createElement('div');
      row.className = 'apikey-row';
      const used = fmtWhen(k.lastUsed, 'never used', true);
      const rate = (k.rateLimit === 0) ? 'unlimited'
                 : (typeof k.rateLimit === 'number') ? `${k.rateLimit}/min`
                 : 'default';
      // Surface the key's workspace reach so an all-access key is never a silent default.
      const wsCount = Array.isArray(k.allowedWorkspaces) ? k.allowedWorkspaces.length : 0;
      const wsScope = wsCount === 0 ? 'all workspaces' : `${wsCount} workspace${wsCount !== 1 ? 's' : ''}`;
      row.innerHTML = `
        <div class="apikey-info">
          <span class="apikey-name">${escapeHtml(k.name)}</span>
          <span class="apikey-meta"><code>${escapeHtml(k.prefix)}…</code> · ${escapeHtml(k.scopes.join(', '))} · ${escapeHtml(wsScope)} · ${rate} · ${used}</span>
        </div>
        <button class="apikey-revoke" data-id="${k.id}" title="Revoke this key">Revoke</button>`;
      row.querySelector('.apikey-revoke').addEventListener('click', async (e) => {
        const id = e.target.dataset.id;
        if (!(await showConfirm({ title: 'Revoke this key?', message: 'Any tool using it will stop working.', okLabel: 'Revoke', danger: true }))) return;
        try {
          await fetch('/api/keys/' + encodeURIComponent(id), { method: 'DELETE' });
          loadApiKeys();
        } catch { showToast('Could not revoke the key.', 'error'); }
      });
      apikeyList.appendChild(row);
    });
  } catch {
    apikeyList.innerHTML = '<div class="apikey-empty">Could not load keys.</div>';
  }
}

// Render the API-key scope checkboxes from the server's scope list (authz.apiKeyScopeList), so the picker is
// single-sourced and can never offer a scope the server won't honor, nor miss one that's added. Keeps the
// `.apikey-scope` class + value the create handler reads. Falls back to the built-in four if the list is absent
// (e.g. an older cached /api/config), so the picker is never empty.
function renderApiKeyScopes(list) {
  const host = document.getElementById('apikey-scope-list');
  if (!host) return;
  const scopes = (Array.isArray(list) && list.length) ? list
    : [{ scope: 'search', label: 'search', desc: 'run searches', on: true },
       { scope: 'summarize', label: 'summarize', desc: 'summarize documents', on: true },
       { scope: 'read', label: 'read', desc: 'read documents', on: true },
       { scope: 'write', label: 'write', desc: 'add documents', on: false }];
  host.innerHTML = scopes.map((s) => {
    const hint = s.desc ? ` <span class="settings-hint">(${escapeHtml(s.desc)})</span>` : '';
    return `<label><input type="checkbox" class="apikey-scope" value="${escapeHtml(s.scope)}"${s.on ? ' checked' : ''}> ${escapeHtml(s.label)}${hint}</label>`;
  }).join('');
}
renderApiKeyScopes();   // render the built-in fallback immediately; loadSettings re-renders from the server list

if (apikeyCreateBtn) {
  apikeyCreateBtn.addEventListener('click', async () => {
    const name = (apikeyNameInp.value || '').trim();
    const scopes = Array.from(document.querySelectorAll('.apikey-scope'))
      .filter(cb => cb.checked).map(cb => cb.value);
    if (scopes.length === 0) { showToast('Select at least one scope.', 'error'); return; }
    // Workspace scoping: checked ids limit the key to those workspaces; none checked = all workspaces
    // (the server treats an empty/absent allowedWorkspaces as every workspace).
    const allowedWorkspaces = Array.from(document.querySelectorAll('.apikey-ws'))
      .filter(cb => cb.checked).map(cb => cb.value);
    const rateRaw = (document.getElementById('apikey-rate')?.value || '').trim();
    const body = { name, scopes };
    if (allowedWorkspaces.length) body.allowedWorkspaces = allowedWorkspaces;
    if (rateRaw !== '') {
      const n = parseInt(rateRaw, 10);
      if (Number.isInteger(n) && n >= 0) body.rateLimit = n;
    }
    apikeyCreateBtn.disabled = true;
    try {
      const res = await sendJSON('/api/keys', body);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      // Show the plaintext key ONCE.
      apikeyNew.classList.remove('hidden');
      apikeyNew.innerHTML = `
        <p class="apikey-warn">Copy this key now — it won't be shown again:</p>
        <div class="apikey-secret"><code>${escapeHtml(data.key)}</code><button class="apikey-copy">Copy</button></div>`;
      apikeyNew.querySelector('.apikey-copy').addEventListener('click', async () => {
        // Use the robust helper (with a legacy execCommand fallback) and only report success
        // if the copy actually worked. The key is shown once; over a plain-http LAN address
        // navigator.clipboard is undefined, and the old code claimed "Copied" while copying
        // nothing — silently losing the key.
        const btn = apikeyNew.querySelector('.apikey-copy');
        const ok = await copyTextToClipboard(data.key);
        btn.textContent = ok ? 'Copied' : 'Copy failed — select and copy manually';
      });
      apikeyNameInp.value = '';
      const rateEl = document.getElementById('apikey-rate'); if (rateEl) rateEl.value = '';
      document.querySelectorAll('.apikey-ws').forEach(cb => { cb.checked = false; });
      loadApiKeys();
    } catch (e) {
      showToast('Could not create key: ' + e.message, 'error');
    } finally {
      apikeyCreateBtn.disabled = false;
    }
  });
}

if (settingsBtn) {
  settingsBtn.addEventListener('click', () => {
    settingsOverlay.classList.remove('hidden');
    loadSettings();
    loadApiKeys();
    loadConnectors();
    loadTemplates();
    loadAutomations();
    loadSmtp();
    loadEval();
  });
}
cfgProvider?.addEventListener('change', () => { updateProviderVisibility(); refreshModelPickers(); });
cfgEmbeddingsProvider?.addEventListener('change', () => { updateProviderVisibility(); refreshModelPickers(); });
// Re-list the model dropdowns when the connection details that determine what's available
// change — a different Ollama host, or a new OpenAI key / base URL — so the list stays accurate
// without needing to save first. (`change` fires on blur, so this isn't per-keystroke.)
cfgOllamaHost?.addEventListener('change', refreshModelPickers);
cfgOpenaiBase?.addEventListener('change', refreshModelPickers);

// ── Connectors (MCP ingestion sources) ──
// Compact relative time for connector status ("just now", "5m ago", "2h ago", "3d ago").
function relTime(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

async function loadConnectors() {
  const list = document.getElementById('connector-list');
  if (!list) return;
  try {
    const res = await fetch('/api/connectors');
    const data = await res.json();
    list.innerHTML = '';
    if (!data.connectors || data.connectors.length === 0) {
      list.innerHTML = '<p class="settings-hint">No connectors yet.</p>';
      return;
    }
    for (const c of data.connectors) {
      const row = document.createElement('div');
      row.className = 'apikey-row connector-row';
      const detail = c.type === 'filesystem'
        ? (c.config?.path || '')
        : c.type === 'github'
          ? `${c.config?.owner || '?'}/${c.config?.repo || '?'}${c.config?.branch ? '@' + c.config.branch : ''}`
          : c.type;

      // Status: distinct classes for ok / error / never, with a relative time.
      let statusClass = 'connector-status-never', statusText = 'never synced';
      if (c.lastResult) {
        const when = c.lastSync ? relTime(c.lastSync) : '';
        if (c.lastResult.ok) {
          statusClass = 'connector-status-ok';
          statusText = `✓ synced ${c.lastResult.count} document${c.lastResult.count === 1 ? '' : 's'}${when ? ` · ${when}` : ''}`;
        } else {
          statusClass = 'connector-status-error';
          statusText = `✕ failed${when ? ` · ${when}` : ''}`;
        }
      }

      row.innerHTML = `
        <div class="apikey-info">
          <span class="apikey-name">${escapeHtml(c.name)}</span>
          <span class="apikey-meta">${escapeHtml(c.type)} · ${escapeHtml(detail)}</span>
          <span class="connector-status ${statusClass}">${statusText}</span>
          ${(c.lastResult && !c.lastResult.ok && c.lastResult.error)
            ? `<span class="connector-error-detail">${escapeHtml(c.lastResult.error)}</span>` : ''}
        </div>
        <div class="connector-actions">
          <button class="connector-test" data-id="${c.id}">Test</button>
          <button class="connector-sync" data-id="${c.id}">Sync</button>
          <button class="apikey-revoke" data-id="${c.id}">Remove</button>
        </div>`;
      list.appendChild(row);
    }
    list.querySelectorAll('.connector-test').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Testing…';
        try {
          const r = await fetch(`/api/connectors/${btn.dataset.id}/test`, { method: 'POST' });
          const d = await r.json();
          if (d.ok) showToast(`Connection OK — the server responded with ${d.toolCount} tool${d.toolCount === 1 ? '' : 's'}.`, 'success');
          else showToast('Connection failed: ' + (d.error || 'unknown error'), 'error');
        } catch (e) { showToast('Test failed: ' + e.message, 'error'); }
        finally { btn.disabled = false; btn.textContent = orig; }
      });
    });
    list.querySelectorAll('.connector-sync').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = 'Starting…';
        // Live progress arrives over the socket as 'sync_progress' for this connector.
        const onProgress = (payload) => {
          const p = parsePayload(payload, null);
          if (!p || p.connectorId !== btn.dataset.id) return;
          if (p.phase === 'connect')      btn.textContent = 'Connecting…';
          else if (p.phase === 'pull')    btn.textContent = `Reading ${p.done}/${p.total}…`;
          else if (p.phase === 'write')   btn.textContent = `Saving ${p.total}…`;
          else if (p.phase === 'index')   btn.textContent = `Indexing ${p.total}…`;
          else if (p.phase === 'done')    btn.textContent = 'Done';
        };
        socket.on('sync_progress', onProgress);
        try {
          const r = await fetch(`/api/connectors/${btn.dataset.id}/sync`, { method: 'POST' });
          const d = await r.json();
          if (!d.ok) showToast('Sync failed: ' + (d.error || 'unknown'), 'error');
        } catch (e) { showToast('Sync failed: ' + e.message, 'error'); }
        finally {
          socket.off('sync_progress', onProgress);
          loadConnectors(); loadDocuments?.();
        }
      });
    });
    list.querySelectorAll('.apikey-revoke').forEach(btn => {
      btn.addEventListener('click', () => confirmRemoveConnector(btn.dataset.id, btn));
    });
  } catch (e) {
    list.innerHTML = '<p class="settings-hint">Could not load connectors.</p>';
  }
}

const connectorAddBtn = document.getElementById('connector-add-btn');
if (connectorAddBtn) {
  connectorAddBtn.addEventListener('click', async () => {
    const uiType = document.getElementById('connector-type')?.value || 'filesystem';
    let name = (document.getElementById('connector-name')?.value || '').trim();
    // "Obsidian vault" is the filesystem engine with a friendlier label — a vault IS
    // a folder of Markdown, and .obsidian/ is already excluded by default. GitHub is
    // its own engine.
    let type, config = {};
    if (uiType === 'github') {
      type = 'github';
      const owner  = (document.getElementById('connector-gh-owner')?.value || '').trim();
      const repo   = (document.getElementById('connector-gh-repo')?.value || '').trim();
      const branch = (document.getElementById('connector-gh-branch')?.value || '').trim();
      const token  = (document.getElementById('connector-gh-token')?.value || '').trim();
      if (!owner || !repo) { showToast('Enter the repository owner and name (e.g. octocat / Hello-World).', 'error'); return; }
      config = { owner, repo };
      if (branch) config.branch = branch;
      if (token)  config.token = token;
      if (!name) name = `${owner}/${repo}`;
    } else {
      type = 'filesystem';
      const p = (document.getElementById('connector-fs-path')?.value || '').trim();
      if (!p) { showToast(uiType === 'obsidian' ? 'Select your Obsidian vault folder.' : 'Enter a folder path.', 'error'); return; }
      config.path = p;
      if (!name) name = uiType === 'obsidian' ? 'Obsidian vault' : '';
    }
    // Optional advanced override: pin the MCP server's npm package (supply-chain) or
    // repoint at a replacement. Shared across types; the server validates the spec.
    const pkg = (document.getElementById('connector-package')?.value || '').trim();
    if (pkg) config.package = pkg;
    connectorAddBtn.disabled = true;
    try {
      const res = await sendJSON('/api/connectors', { type, name, config });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      document.getElementById('connector-name').value = '';
      ['connector-fs-path', 'connector-gh-owner', 'connector-gh-repo', 'connector-gh-branch', 'connector-gh-token', 'connector-package']
        .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      loadConnectors();
    } catch (e) {
      showToast('Could not add connector: ' + e.message, 'error');
    } finally {
      connectorAddBtn.disabled = false;
    }
  });
}

// Adapt the connector form when the type changes. "Obsidian vault" is the filesystem
// engine relabeled — a vault is a folder of Markdown, and .obsidian/ is excluded by
// default, so it just works; the label/help make that obvious.
const connectorTypeSel = document.getElementById('connector-type');
if (connectorTypeSel) {
  connectorTypeSel.addEventListener('change', () => {
    const val = connectorTypeSel.value;
    const isGithub = val === 'github';
    const isVault  = val === 'obsidian';
    // Swap which config block is shown (filesystem/obsidian share one, github its own).
    const fsBlock = document.getElementById('connector-config-filesystem');
    const ghBlock = document.getElementById('connector-config-github');
    if (fsBlock) fsBlock.style.display = isGithub ? 'none' : '';
    if (ghBlock) ghBlock.style.display = isGithub ? '' : 'none';
    if (isGithub) return;   // github block is static; nothing more to adapt
    const label = document.getElementById('connector-path-label');
    const help  = document.querySelector('.connector-help');
    const input = document.getElementById('connector-fs-path');
    if (label) label.childNodes[0].nodeValue = isVault ? 'Vault folder: ' : 'Folder path: ';
    if (input) input.placeholder = isVault ? '/Users/you/Obsidian/MyVault' : '/Users/you/Documents/notes';
    if (help) help.innerHTML = isVault
      ? 'Point this at your Obsidian vault folder (the one containing your notes), or use <strong>Browse…</strong> to pick it. Lokyni indexes the vault’s Markdown notes; the <code>.obsidian</code> config folder and trash are skipped automatically.'
      : 'The full path to a folder on this machine — starting from the root (<code>/</code>), or use <strong>Browse…</strong> to pick one. Lokyni pulls the text files inside it (and subfolders) into this workspace. Dependency and build folders (<code>node_modules</code>, <code>.git</code>, <code>dist</code>, <code>venv</code>, etc.) are skipped automatically.';
  });
}

// Connector removal modal — three explicit choices, no ambiguous Cancel. The source
// folder on disk is never touched; "Delete documents" only removes Lokyni's copies.
function confirmRemoveConnector(id, triggerBtn) {
  const overlay = document.createElement('div'); overlay.className = 'del-confirm connector-remove-overlay';
  overlay.innerHTML = `
    <div class="del-confirm-box connector-remove-box">
      <h3>Remove this connector?</h3>
      <p class="connector-remove-note">The documents it pulled in are copies Lokyni made. Your original files on disk are never affected.</p>
      <div class="del-confirm-btns connector-remove-btns">
        <button class="del-btn-cancel">Cancel</button>
        <button class="connector-keep-btn">Remove, keep documents</button>
        <button class="del-btn-ok connector-delete-btn">Remove &amp; delete documents</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  enhanceConfirmDialog(overlay);

  const close = () => overlay.remove();
  const doRemove = async (deleteDocs) => {
    close();
    if (triggerBtn) triggerBtn.disabled = true;
    try {
      const qs = deleteDocs ? '?deleteDocs=true' : '';
      const r = await fetch(`/api/connectors/${id}${qs}`, { method: 'DELETE' });
      const d = await r.json();
      if (!d.ok) showToast('Could not remove the connector.', 'error');
    } catch (e) { showToast('Could not remove the connector: ' + e.message, 'error'); }
    loadConnectors(); loadDocuments?.();
  };

  overlay.querySelector('.del-btn-cancel').onclick = close;
  overlay.querySelector('.connector-keep-btn').onclick = () => doRemove(false);
  overlay.querySelector('.connector-delete-btn').onclick = () => doRemove(true);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}
// ── Settings filter + read-only health panel ────────────────────────────────────────────────────────────────
// The filter marks nonmatching blocks with .settings-filtered (never touching the feature-visibility .hidden
// state) and restores each collapsible's original open state on clear. Matching is a plain case-insensitive
// substring over the rendered label/hint, so it works for any language the UI is viewed in.
const settingsDetailsWasOpen = new WeakMap();
let settingsFilterWasActive = false;   // transitions into/out of filtering, so the open-state snapshot is fresh
function settingsSectionRows(section) {
  const rows = [];
  for (let el = section.nextElementSibling; el; el = el.nextElementSibling) {
    if (el.classList.contains('settings-section') || el.tagName === 'DETAILS') break;
    if (el.classList.contains('settings-row')) rows.push(el);
  }
  return rows;
}
function applySettingsFilter() {
  if (!settingsFilter || !settingsBody) return;
  const q = String(settingsFilter.value || '').trim().toLowerCase();
  // Snapshot collapsible state at the START of each filtering session. Without this, a group opened manually
  // between two filters would be restored to a stale state when the second filter is cleared.
  if (q && !settingsFilterWasActive) {
    settingsBody.querySelectorAll('details').forEach((d) => settingsDetailsWasOpen.set(d, d.open));
  }
  settingsFilterWasActive = !!q;
  const rows = [...settingsBody.querySelectorAll('.settings-row')];
  for (const row of rows) {
    const hit = !q || (row.textContent || '').toLowerCase().includes(q);
    row.classList.toggle('settings-filtered', !!q && !hit);
  }
  // A section whose own header matches reveals its whole block; otherwise it is hidden when nothing under it
  // is visible. This makes "Voice" find the whole Voice & audio section, not only rows containing that word.
  for (const section of settingsBody.querySelectorAll('.settings-section')) {
    const block = settingsSectionRows(section);
    const headerHit = !!q && (section.textContent || '').toLowerCase().includes(q);
    if (headerHit) for (const row of block) row.classList.remove('settings-filtered');
    const visible = !q || headerHit || block.some((row) => !row.classList.contains('settings-filtered') && !row.classList.contains('hidden'));
    section.classList.toggle('settings-filtered', !!q && !visible);
  }
  // Collapsible groups open when they contain a match (or their summary matches), and are hidden when empty.
  for (const details of settingsBody.querySelectorAll('details')) {
    if (!settingsDetailsWasOpen.has(details)) settingsDetailsWasOpen.set(details, details.open);
    const summaryHit = !!q && (details.querySelector('summary')?.textContent || '').toLowerCase().includes(q);
    const hasVisible = [...details.querySelectorAll('.settings-row, .settings-section')]
      .some((el) => !el.classList.contains('settings-filtered') && !el.classList.contains('hidden'));
    const show = !q || summaryHit || hasVisible;
    details.classList.toggle('settings-filtered', !show);
    if (q) details.open = show && (summaryHit || hasVisible);
    else details.open = settingsDetailsWasOpen.get(details);
  }
  const count = rows.filter((row) => !row.classList.contains('settings-filtered') && !row.classList.contains('hidden')).length;
  if (settingsFilterCount) {
    settingsFilterCount.textContent = !q ? '' : (count ? `${count} matching setting${count === 1 ? '' : 's'}` : 'No matching settings');
  }
}
function resetSettingsFilter() {
  if (!settingsFilter) return;
  settingsFilter.value = '';
  if (settingsBody) {
    settingsBody.querySelectorAll('.settings-filtered').forEach((el) => el.classList.remove('settings-filtered'));
    settingsBody.querySelectorAll('details').forEach((d) => {
      if (settingsDetailsWasOpen.has(d)) d.open = settingsDetailsWasOpen.get(d);
    });
  }
  if (settingsFilterCount) settingsFilterCount.textContent = '';
  settingsFilterWasActive = false;
}
if (settingsFilter) {
  settingsFilter.addEventListener('input', applySettingsFilter);
  settingsFilter.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Only take Escape when there is a filter to clear. With an empty filter it must fall through to the
    // shared modal handler, or a keyboard user could not close Settings with Escape (and Firefox focuses the
    // filter first, so this path is not hypothetical).
    if (!String(settingsFilter.value || '').trim()) return;
    e.preventDefault(); e.stopPropagation();   // clear the filter instead of closing Settings
    resetSettingsFilter();
    settingsFilter.focus();
  });
}

// The health panel is read-only: it displays the latest completed watchdog sweep, never runs one itself.
function renderSettingsHealth(findings, at) {
  if (!settingsHealthList || !settingsHealthNote) return;
  const list = (Array.isArray(findings) ? findings : []).slice(0, 50);
  const frag = document.createDocumentFragment();
  for (const f of list) {
    const row = document.createElement('div');
    row.className = 'health-row'; row.setAttribute('role', 'listitem');
    const check = document.createElement('span');
    check.className = 'health-check';
    check.textContent = String((f && (f.check || f.action)) || 'check');
    const detail = document.createElement('span');
    detail.className = 'health-detail';
    detail.textContent = String((f && f.detail) || '');
    row.appendChild(check); row.appendChild(detail); frag.appendChild(row);
  }
  settingsHealthList.replaceChildren(frag);
  const when = at ? new Date(at).toLocaleString() : '';
  if (!at) {
    settingsHealthNote.textContent = 'The first integrity sweep has not finished yet. Reopen this panel in a moment.';
  } else if (list.length) {
    settingsHealthNote.textContent = `${list.length} finding${list.length === 1 ? '' : 's'} in the latest sweep (${when}).`;
  } else {
    settingsHealthNote.textContent = `No issues found in the latest sweep (${when}).`;
  }
}
// Embedding-banks reuse summary — read-only, driven ENTIRELY by /api/health's index.banks (the single backend
// source, describeBankState), so the UI and backend can never drift. It shows that a provider switch reused the
// existing embeddings, which frozen banks a learned adapter keeps searchable, and whether a re-embed is pending.
// Language-agnostic: it renders provider/model names and fixed labels, never anything derived from documents.
async function renderBankState() {
  const row = document.getElementById('cfg-bank-state-row');
  const box = document.getElementById('cfg-bank-state');
  if (!row || !box) return;
  let st = null;
  try { const h = await getJSON('/api/health'); st = h && h.index && h.index.banks; } catch { st = null; }
  if (!st || !st.enabled || !Array.isArray(st.banks) || (st.banks.length <= 1 && !st.reused)) {
    row.classList.add('hidden'); box.replaceChildren(); return;
  }
  const frag = document.createDocumentFragment();
  const head = document.createElement('div');
  head.className = 'bank-state-head';
  head.textContent = st.banks.length > 1 ? `Your documents span ${st.banks.length} embedding banks:` : 'Embedding bank';
  frag.appendChild(head);
  if (st.reused) {
    const n = document.createElement('div');
    n.className = 'bank-note is-reused';
    n.textContent = '✓ Your most recent switch reused your existing embeddings — no re-embedding.';
    frag.appendChild(n);
  }
  for (const b of st.banks) {
    const r = document.createElement('div');
    r.className = 'bank-row is-' + (b && b.role === 'active' ? 'active' : b && b.role === 'adapter' ? 'adapter' : 'frozen');
    const dot = document.createElement('span'); dot.className = 'bank-dot';
    const label = document.createElement('span'); label.className = 'bank-label';
    label.textContent = `${(b && b.provider) || '?'} · ${(b && b.model) || '?'}`;
    const tag = document.createElement('span'); tag.className = 'bank-tag';
    tag.textContent = b && b.role === 'active' ? 'active'
      : b && b.role === 'adapter' ? (typeof b.top1 === 'number' ? `kept searchable (adapter, ${Math.round(b.top1 * 100)}% match)` : 'kept searchable (adapter)')
      : 'searchable through its own provider';
    r.appendChild(dot); r.appendChild(label); r.appendChild(tag);
    frag.appendChild(r);
  }
  if (st.notResilient) {
    const n = document.createElement('div');
    n.className = 'bank-note is-gap';
    n.textContent = 'Some documents still rely on a provider you switched away from. They stay fully searchable while it is reachable; if it becomes unavailable they fall back to keyword search. Consolidate below to embed everything with the current model.';
    frag.appendChild(n);
  }
  box.replaceChildren(frag);
  row.classList.remove('hidden');
}
// Pre-switch "will this re-embed?" check. Runs the measurement ONLY on this explicit click (never on keystroke),
// so a metered provider is never billed for a background check. Reads the current embeddings form values and asks
// the backend predictor (one source: banks.predictSwitch) what saving them would do.
const predictSwitchBtn = document.getElementById('predict-switch-btn');
const predictSwitchResult = document.getElementById('predict-switch-result');
if (predictSwitchBtn) {
  const setPredict = (cls, msg) => { if (predictSwitchResult) { predictSwitchResult.className = 'settings-hint predict-result ' + cls; predictSwitchResult.textContent = msg; } };
  // One place runs the prediction, shared by the explicit button and the debounced auto-check, so they can't
  // drift. `auto` runs are quiet about a bare empty field (no nagging while the user is still typing).
  let _predictSeq = 0;
  const runPredictSwitch = async ({ auto = false } = {}) => {
    const provider = document.getElementById('cfg-embeddings-provider')?.value || '';
    const model = (document.getElementById('cfg-embeddings')?.value || '').trim();
    const baseUrl = (document.getElementById('cfg-embed-base')?.value || '').trim();
    if (!model) { if (!auto) setPredict('dim', 'Enter an embeddings model first.'); else setPredict('dim', ''); return; }
    const seq = ++_predictSeq;
    if (!auto) predictSwitchBtn.disabled = true;
    setPredict('dim', 'Checking…');
    try {
      const data = await sendJSON('/api/embeddings/predict-switch', { provider, model, baseUrl }).then((r) => r.json());
      if (seq !== _predictSeq) return;   // a newer check started — don't paint a stale answer
      const cls = (data.outcome === 'reuse' || data.outcome === 'current') ? 'reuse' : data.outcome === 'new' ? 'warn' : 'dim';
      setPredict(cls, data.message || '');
    } catch { if (seq === _predictSeq) setPredict('dim', auto ? '' : 'Could not check right now.'); }
    finally { if (!auto) predictSwitchBtn.disabled = false; }
  };
  predictSwitchBtn.addEventListener('click', () => runPredictSwitch({ auto: false }));
  // Auto-check as the user edits — but ONLY on the local, no-cost embedder (Ollama), so a metered provider is
  // never billed for a background check (there the explicit button stays the only trigger). Debounced so it runs
  // once the field settles, not on every keystroke.
  let _predictTimer = null;
  const autoPredict = () => {
    const provider = document.getElementById('cfg-embeddings-provider')?.value || '';
    if (provider !== 'ollama') { setPredict('dim', ''); return; }   // metered providers: button only
    clearTimeout(_predictTimer);
    _predictTimer = setTimeout(() => runPredictSwitch({ auto: true }), 700);
  };
  document.getElementById('cfg-embeddings')?.addEventListener('input', autoPredict);
  document.getElementById('cfg-embeddings-provider')?.addEventListener('change', autoPredict);
  document.getElementById('cfg-embed-base')?.addEventListener('input', autoPredict);
}
async function loadSettingsHealth() {
  if (!settingsHealthDetails || !settingsHealthDetails.open) return;
  if (settingsHealthNote) settingsHealthNote.textContent = 'Loading the latest sweep…';
  try {
    const data = await getJSON('/api/watchdog');
    // The route is admin-only. A member gets a JSON error, not a sweep — say so plainly rather than showing a
    // misleading "sweep has not finished" note.
    if (data && data.error) {
      if (settingsHealthList) settingsHealthList.replaceChildren();
      if (settingsHealthNote) settingsHealthNote.textContent = 'Health information is only available to administrators.';
      return;
    }
    renderSettingsHealth(data && data.findings, data && data.at);
  } catch {
    if (settingsHealthList) settingsHealthList.replaceChildren();
    if (settingsHealthNote) settingsHealthNote.textContent = 'Health information is unavailable right now.';
  }
}
if (settingsHealthDetails) {
  settingsHealthDetails.addEventListener('toggle', () => { if (settingsHealthDetails.open) loadSettingsHealth(); });
}

// Close the Settings panel and stop the graph-build status poll if it's still running: a build can
// outlive the open panel, and without this the 1.5s poll would keep firing forever when the user
// closes Settings mid-build (or if the server dies without reporting completion). Reopening Settings
// refreshes the line, and the 'graph_build' socket event still updates it while closed.
function closeSettingsOverlay() {
  settingsOverlay.classList.add('hidden');
  if (graphStatusPoll) { clearInterval(graphStatusPoll); graphStatusPoll = null; }
  stopTtsWarmPoll();
  // The system-voice lookup only serves this panel; stop a bounded retry that is still running.
  stopSystemVoicePoll();
  // A filter is a transient view of this open panel; do not reopen Settings still filtered.
  resetSettingsFilter();
}
settingsCancel?.addEventListener('click', () => closeSettingsOverlay());
settingsOverlay?.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) closeSettingsOverlay();
});

// Escape closes the topmost open modal, matching the click-outside behavior (which also
// just hides the overlay). One handler covers every .modal-overlay dialog (settings, logs,
// inbox, the folder picker, confirmations) so a keyboard user is never trapped in one.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // Dynamic confirm dialogs (delete document, remove connector, rebuild index) are their
  // own elements, not .modal-overlay — dismiss the topmost, matching its Cancel button.
  const confirms = document.querySelectorAll('.del-confirm');
  if (confirms.length) { confirms[confirms.length - 1].remove(); return; }
  const open = Array.from(document.querySelectorAll('.modal-overlay:not(.hidden)'));
  if (open.length === 0) return;   // nothing open — let other Escape handlers (e.g. the # picker) run
  const top = open[open.length - 1];   // last in DOM order is visually on top
  // Route through a real close routine when one exists, so cleanup runs (the logs modal
  // must clear its auto-refresh interval — hiding it alone would leave it polling).
  if (top.id === 'logs-overlay') { try { logsHide(); return; } catch {} }
  if (top.id === 'source-overlay') { try { closeSourceViewer(); return; } catch {} }
  // The extract/notes/mindmap modals own real close routines (the × button) — reuse them so cleanup runs.
  // Critically, closing the Extract modal emits extract_cancel; a bare hide here would ESCAPE-orphan a running
  // extraction server-side and let late row/done events mutate a now-hidden modal. Settings is here too: its
  // close routine stops the graph-build status poll, which a bare class change would leave running forever.
  const CLOSE_BTN = { 'settings-overlay': 'settings-cancel', 'extract-overlay': 'extract-close', 'notes-overlay': 'notes-close', 'mindmap-overlay': 'mindmap-close', 'readas-overlay': 'readas-cancel' };
  if (CLOSE_BTN[top.id]) { try { document.getElementById(CLOSE_BTN[top.id]).click(); return; } catch {} }
  top.classList.add('hidden');
});

// Browser clipper — create a write-scoped key and build a bookmarklet embedding it.
// The plaintext key is only available at creation, so we generate the bookmarklet in
// the same step and show it once for the user to drag to their bookmarks bar.
const clipperCreateBtn = document.getElementById('clipper-create-btn');
if (clipperCreateBtn) {
  clipperCreateBtn.addEventListener('click', async () => {
    const hint = document.getElementById('clipper-hint');
    const result = document.getElementById('clipper-result');
    const link = document.getElementById('clipper-bookmarklet');
    clipperCreateBtn.disabled = true;
    if (hint) hint.textContent = 'Creating…';
    try {
      // Load the bookmarklet template FIRST, so a fetch failure can't leave an orphaned key created
      // for a bookmarklet we couldn't build. The template (clipper-bookmarklet.txt) is the single
      // source for the clipper — see that file.
      const tplRes = await fetch('/clipper-bookmarklet.txt');
      if (!tplRes.ok) throw new Error('Could not load the clipper template');
      const tpl = await tplRes.text();
      const res = await sendJSON('/api/keys', { name: 'clipper', scopes: ['write'] });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      // Fill this install's host and the new key (JSON-encoded so any character is safe), strip the
      // template's header comment, and collapse to a single-line javascript: URL to drag.
      const code = tpl
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/__LOKYNI_HOST__/g, JSON.stringify(location.origin))
        .replace(/__LOKYNI_KEY__/g, JSON.stringify(data.key))
        .replace(/\r?\n\s*/g, '')
        .trim();
      if (link) { link.href = code; }
      if (result) result.classList.remove('hidden');
      if (hint) hint.textContent = 'Created — drag the button to your bookmarks bar (it holds a key, so keep it private).';
      loadApiKeys?.();
    } catch (e) {
      if (hint) hint.textContent = 'Could not create: ' + e.message;
    } finally {
      clipperCreateBtn.disabled = false;
    }
  });
}

// background rebuild and poll /status until it finishes.
// Shared confirm-overlay + POST + status-poll for background index operations. Both
// "Rebuild index" and "Consolidate embedding banks" re-embed in the background and are
// tracked the same way (poll /status until indexing flips off), so they share this.
function confirmAndRunIndexOp({ btn, status, title, body, okLabel, endpoint, runningMsg }) {
  if (!btn) return;
  btn.addEventListener('click', () => {
    const overlay = document.createElement('div'); overlay.className = 'del-confirm rebuild-confirm-overlay';
    overlay.innerHTML = `
      <div class="del-confirm-box">
        <h3>${title}</h3>
        <p>${body}</p>
        <div class="del-confirm-btns">
          <button class="del-btn-cancel">Cancel</button>
          <button class="del-btn-ok">${okLabel}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    enhanceConfirmDialog(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('.del-btn-cancel').onclick = close;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('.del-btn-ok').onclick = async () => {
      close();
      btn.disabled = true;
      if (status) status.textContent = 'Starting…';
      try {
        const r = await fetch(endpoint, { method: 'POST' });
        const d = await r.json();
        if (!d.ok) { if (status) status.textContent = d.error || 'Could not start.'; btn.disabled = false; return; }
        if (status) status.textContent = runningMsg;
        // Wait a moment first so we don't read the brief window before indexing flips on.
        await new Promise(res => setTimeout(res, 2500));
        // Generous safety ceiling (~1 hour at 1.5s) so a wedged rebuild that never flips
        // `indexing` back off can't leave the button disabled and the UI spinning forever.
        // Far longer than any real rebuild, so it never trips on a legitimately long one.
        let polls = 0;
        const MAX_POLLS = 2400;
        const poll = setInterval(async () => {
          try {
            const s = await getJSON('/status');
            // A resumable bank re-embed runs across several delta batches, so `indexing` briefly flips off
            // between them. Treat the whole migration as running until it reports done/paused.
            const bm = s.bankMigration || {};
            const migrating = bm.status === 'running';
            if (migrating && bm.total && status) {
              status.textContent = `Re-embedding… ${bm.done || 0}/${bm.total} moved. This is resumable if interrupted.`;
            }
            if (!s.indexing && !migrating) {
              clearInterval(poll);
              if (status) {
                status.textContent = bm.status === 'paused'
                  ? `Paused — ${bm.remaining} document(s) left in an older bank. Run Consolidate again to resume; nothing moved is lost.`
                  : `Done — ${s.documents} documents indexed.`;
              }
              btn.disabled = false;
              loadDocuments?.();
              renderBankState?.();   // refresh the reuse summary once a consolidate/rebuild settles
            } else if (++polls >= MAX_POLLS) {
              clearInterval(poll);
              if (status) status.textContent = 'Still running — check Logs for progress.';
              btn.disabled = false;
            }
          } catch (_) { /* transient — keep polling */ }
        }, 1500);
      } catch (e) {
        if (status) status.textContent = 'Failed: ' + e.message;
        btn.disabled = false;
      }
    };
  });
}

confirmAndRunIndexOp({
  btn: document.getElementById('rebuild-index-btn'),
  status: document.getElementById('rebuild-index-status'),
  title: 'Rebuild the search index?',
  body: 'This wipes the index and re-reads every document from scratch. It can take a while for a large library, and search and related documents may be incomplete until it finishes. Your actual documents are never changed — only the index.',
  okLabel: 'Rebuild', endpoint: '/api/reindex',
  runningMsg: 'Rebuilding… this can take a while.',
});

confirmAndRunIndexOp({
  btn: document.getElementById('consolidate-banks-btn'),
  status: document.getElementById('consolidate-banks-status'),
  title: 'Consolidate embedding banks?',
  body: 'This moves every document into a single bank for your current embedding model and then removes the older banks, freeing the space they used. It runs in resumable batches: search stays available the whole time, older banks stay usable until their documents have moved, and if it is interrupted you can run Consolidate again to continue. Your documents are never changed — only the index.',
  okLabel: 'Consolidate', endpoint: '/api/consolidate-banks',
  runningMsg: 'Consolidating… this can take a while.',
});

// ── Knowledge graph (opt-in LLM graph) ──
// Show the build action only while the toggle is on, keep a short status line current, and let the user
// build/refresh the graph on demand. The build runs on the server (fire-and-forget); we poll its status
// and also listen for the completion broadcast. All best-effort — a failed fetch just leaves the line as
// it was and never blocks anything else in Settings.
const graphRagActions = document.getElementById('cfg-graph-rag-actions');
const graphRagStatusEl = document.getElementById('graph-rag-status');
const btnBuildGraph = document.getElementById('btn-build-graph');
let graphStatusPoll = null;
function updateGraphRagActions() {
  if (!graphRagActions) return;
  graphRagActions.classList.toggle('hidden', !(cfgGraphRag && cfgGraphRag.checked));
}
function renderGraphStatus(s) {
  if (!graphRagStatusEl || !s) return;
  const b = s.build || {};
  if (b.running) {
    const pct = b.total ? ` (${b.done}/${b.total})` : '';
    graphRagStatusEl.textContent = `Building…${pct}`;
    if (btnBuildGraph) btnBuildGraph.disabled = true;
  } else {
    if (btnBuildGraph) btnBuildGraph.disabled = false;
    const g = s.graph || {};
    if (b.status === 'error') graphRagStatusEl.textContent = 'Last build failed — try again.';
    else if (g.nodes) graphRagStatusEl.textContent = `Graph ready — ${g.nodes} entities, ${g.edges} relationships.`;
    else graphRagStatusEl.textContent = 'No graph yet — build it to enable graph search.';
    if (graphStatusPoll) { clearInterval(graphStatusPoll); graphStatusPoll = null; }
  }
}
async function refreshGraphStatus() {
  try {
    const r = await fetch('/api/graph/status');
    if (r.ok) renderGraphStatus(await r.json());
  } catch { /* leave the line as-is */ }
}
cfgGraphRag?.addEventListener('change', () => { updateGraphRagActions(); if (cfgGraphRag.checked) refreshGraphStatus(); });
btnBuildGraph?.addEventListener('click', async () => {
  if (!btnBuildGraph) return;
  // Rebuilding re-reads every document that changed through the model, so on a large library it can take a
  // long time. Confirm first, and reassure the user it is safe to leave: it runs in the background, saves its
  // progress as it goes, and automatically resumes where it left off next time the app opens.
  const ok = await showConfirm({
    title: 'Rebuild the knowledge graph?',
    message: 'Lokyni re-reads changed documents to refresh the graph. On a large library this can take a while. It runs in the background — you can keep working or close the app, and it resumes where it left off next time.',
    okLabel: 'Rebuild',
  });
  if (!ok) return;
  btnBuildGraph.disabled = true;
  if (graphRagStatusEl) graphRagStatusEl.textContent = 'Starting…';
  try {
    // Enable the graph server-side FIRST. The checkbox only toggled the UI; the setting persists on the main
    // Save button, so a user who ticked the box and clicked Build without saving would otherwise get
    // "The knowledge graph is not enabled." Persisting here (a partial config merge) makes Build just work.
    if (cfgGraphRag && cfgGraphRag.checked) { try { await sendJSON('/api/config', { useGraphRag: true }); } catch {} }
    const r = await fetch('/api/graph/build', { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { if (graphRagStatusEl) graphRagStatusEl.textContent = j.error || 'Could not start the build.'; btnBuildGraph.disabled = false; return; }
    if (graphStatusPoll) clearInterval(graphStatusPoll);
    graphStatusPoll = setInterval(refreshGraphStatus, 1500);
    refreshGraphStatus();
  } catch (e) {
    if (graphRagStatusEl) graphRagStatusEl.textContent = 'Could not start the build.';
    btnBuildGraph.disabled = false;
  }
});
socket.on('graph_build', (p) => { try { busyGraphBuild = !!(parsePayload(p) || {}).running; } catch {} refreshGraphStatus(); });

settingsSave?.addEventListener('click', async () => {
  if (!settingsLoaded) {
    settingsStatus.textContent = 'Settings have not loaded yet. Close and reopen Settings to retry.';
    settingsStatus.className = 'error';
    return;
  }
  settingsStatus.textContent = 'Saving…';
  settingsStatus.className = '';
  try {
    // Read a numeric field, falling back to the default only when the field is blank or unparseable — a
    // valid 0 (e.g. temperature 0, maxHistory 0) is kept, unlike `parseInt(...) || default` which would
    // wrongly replace it. Clearing a field then sending NaN would otherwise coerce to the range floor
    // server-side (e.g. a 1-token answer), which surprises the user.
    const numField = (el, def, float) => {
      const n = float ? parseFloat(el && el.value) : parseInt(el && el.value, 10);
      return Number.isFinite(n) ? n : def;
    };
    const body = {
      provider:        cfgProvider.value,
      model:           cfgModel.value,
      ...(cfgEmbeddingsProvider ? { embeddingsProvider: cfgEmbeddingsProvider.value } : {}),
      embeddingsModel: cfgEmbeddings.value,
      ollamaHost:      cfgOllamaHost.value,
      ollamaApiKey:           secretValue(cfgOllamaKey),
      openaiApiKey:    secretValue(cfgOpenaiKey),
      openaiBaseUrl:   cfgOpenaiBase.value.trim(),
      ...(cfgEmbedKey  ? { embeddingsApiKey: secretValue(cfgEmbedKey) } : {}),
      ...(cfgEmbedBase ? { embeddingsBaseUrl: cfgEmbedBase.value.trim() } : {}),
      ...(cfgAnthropicKey ? { anthropicApiKey: secretValue(cfgAnthropicKey) } : {}),
      ...(cfgAnthropicBase ? { anthropicBaseUrl: cfgAnthropicBase.value.trim() } : {}),
      temperature:     numField(cfgTemperature, settingDefault('temperature'), true),
      maxTokens:       numField(cfgMaxTokens, settingDefault('maxTokens'), false),   // blank → 0 = Auto (sized to the model at request time)
      maxHistory:      numField(cfgMaxHistory, settingDefault('maxHistory'), false),
      passageSize:     numField(cfgPassageSize, settingDefault('passageSize'), false),
      useQueryRewrite:        cfgQueryRewrite.checked,
      useConversationSummary: cfgConvSummary.checked,
      ...(cfgIntentClassifier ? { useIntentClassifier: cfgIntentClassifier.checked } : {}),
      ...(cfgSuggestedQuestions ? { useSuggestedQuestions: cfgSuggestedQuestions.checked } : {}),
      ...(cfgMetaConversation ? { useMetaConversation: cfgMetaConversation.checked } : {}),
      ...(cfgTopicSwitchAck ? { useTopicSwitchAck: cfgTopicSwitchAck.checked } : {}),
      ...(cfgClarifyingQuestions ? { useClarifyingQuestions: cfgClarifyingQuestions.checked } : {}),
      ...(cfgPartialMatch ? { usePartialMatchTier: cfgPartialMatch.checked } : {}),
      ...(cfgSemanticCache ? { useSemanticCache: cfgSemanticCache.checked } : {}),
      ...(cfgShowConfidence ? { showAnswerConfidence: cfgShowConfidence.checked } : {}),
      ...(cfgAbstainWeak ? { abstainOnWeakEvidence: cfgAbstainWeak.checked } : {}),
      ...(cfgSemanticEntropy ? { useSemanticEntropy: cfgSemanticEntropy.checked } : {}),
      ...(cfgSemanticEntropySamples ? { semanticEntropySamples: numField(cfgSemanticEntropySamples, settingDefault('semanticEntropySamples'), false) } : {}),
      ...(cfgReranker ? { useReranker: cfgReranker.checked } : {}),
      ...(cfgContextual ? { useContextualRetrieval: cfgContextual.checked } : {}),
      ...(cfgColbert ? { useColbertRerank: cfgColbert.checked } : {}),
      ...(cfgCorrective ? { useCorrectiveRetrieval: cfgCorrective.checked } : {}),
      ...(cfgCrossLingual ? { useCrossLingual: cfgCrossLingual.checked } : {}),
      ...(cfgDocSummaries ? { useDocumentSummaries: cfgDocSummaries.checked } : {}),
      ...(cfgAutoSynthesis ? { useAutoSynthesis: cfgAutoSynthesis.checked } : {}),
      ...(cfgRagFusion ? { useRagFusion: cfgRagFusion.checked } : {}),
      ...(cfgHyde ? { useHyde: cfgHyde.checked } : {}),
      ...(cfgEntityGraph ? { useEntityGraph: cfgEntityGraph.checked } : {}),
      ...(cfgGraphRag ? { useGraphRag: cfgGraphRag.checked } : {}),
      ...(cfgAdaptive ? { useAdaptiveRetrieval: cfgAdaptive.checked } : {}),
      ...(cfgAuditLog ? { auditLog: cfgAuditLog.checked } : {}),
      ...(cfgAllowNetwork ? { allowNetworkAccess: cfgAllowNetwork.checked } : {}),
      ...(cfgDebug ? { debug: cfgDebug.checked } : {}),
      rewriteModel:           cfgRewriteModel.value.trim(),
      numCtx:                parseInt(cfgNumCtx.value, 10) || settingDefault('numCtx'),   // blank / 0 = automatic (resolved per model)
      ...(cfgEmbeddingContext ? { embeddingContextTokens: parseInt(cfgEmbeddingContext.value) || settingDefault('embeddingContextTokens') } : {}),
      useOcr:                 cfgUseOcr ? cfgUseOcr.checked : settingDefault('useOcr'),
      ocrEngine:              cfgOcrEngine ? cfgOcrEngine.value : settingDefault('ocrEngine'),
      ocrVisionModel:         cfgOcrModel ? cfgOcrModel.value.trim() : '',
      visionDescribe:         cfgVisionDescribe ? cfgVisionDescribe.checked : settingDefault('visionDescribe'),
      useVisualIngest:        cfgVisualIngest ? cfgVisualIngest.checked : settingDefault('useVisualIngest'),
      visualIngestCropFigures: cfgVisualCrop ? cfgVisualCrop.checked : settingDefault('visualIngestCropFigures'),
      // Prefer the dropdown selection; fall back to the free-text field for a model
      // not yet pulled (so the user can name it before installing).
      visionModel:            (cfgVisionModel && cfgVisionModel.value) ? cfgVisionModel.value
                                : (cfgVisionModelText ? cfgVisionModelText.value.trim() : ''),
      ocrMaxPages:            parseInt(cfgOcrMaxPages?.value, 10) || settingDefault('ocrMaxPages'),
      // '' means Automatic — sent as empty so the server clears the override.
      ocrWorkers:             cfgOcrWorkers?.value ? parseInt(cfgOcrWorkers.value, 10) : '',
      ...(cfgOcrLanguages ? { ocrLanguages: selectedOcrLanguages() } : {}),
      useWebSearch:           cfgWebSearch ? cfgWebSearch.checked : settingDefault('useWebSearch'),
      ...(cfgUrlCapture ? { urlCapture: cfgUrlCapture.value } : {}),
      webAutoSuggest:         cfgWebAutosuggest ? cfgWebAutosuggest.checked : settingDefault('webAutoSuggest'),
      ...(cfgWebRanking ? { useWebResultRanking: cfgWebRanking.checked } : {}),
      ...(cfgWebProxy ? { webProxyUrl: cfgWebProxy.value.trim() } : {}),
      ...(cfgWebProxyRotate ? { webProxyRotate: cfgWebProxyRotate.checked } : {}),
      ...(cfgWebProxyRetries ? { webProxyRetries: parseInt(cfgWebProxyRetries.value, 10) || settingDefault('webProxyRetries') } : {}),
      ...(cfgWebProxyStrict ? { webProxyStrict: cfgWebProxyStrict.checked } : {}),
      ...(cfgTtsEnabled ? { ttsEnabled: cfgTtsEnabled.checked } : {}),
      ...(cfgTtsVoice && cfgTtsVoice.value ? { ttsVoice: cfgTtsVoice.value } : {}),
      ...(cfgTtsSpeed && cfgTtsSpeed.value ? { ttsSpeed: parseFloat(cfgTtsSpeed.value) || settingDefault('ttsSpeed') } : {}),
      ...(cfgTtsLanguage && cfgTtsLanguage.value ? { ttsLanguage: cfgTtsLanguage.value } : {}),
      ...(cfgTtsOnlineVoices ? { ttsAllowOnlineVoices: cfgTtsOnlineVoices.checked } : {}),
      ...(cfgTtsSystemVoice ? { ttsSystemVoices: ttsSystemVoicePrefs } : {}),
      ...(cfgPodcastVoiceA && cfgPodcastVoiceA.value ? { podcastVoiceA: cfgPodcastVoiceA.value } : {}),
      ...(cfgPodcastVoiceB && cfgPodcastVoiceB.value ? { podcastVoiceB: cfgPodcastVoiceB.value } : {}),
      ...(cfgSttEnabled ? { sttEnabled: cfgSttEnabled.checked } : {}),
      ...(cfgSttLanguage && cfgSttLanguage.value ? { sttLanguage: cfgSttLanguage.value } : {}),
      ...(cfgMicDevice ? { micDeviceId: voiceMicPref.id || '', micLabel: voiceMicPref.label || '' } : {}),
      ...(cfgAudioIngest ? { useAudioIngest: cfgAudioIngest.checked } : {}),
      ...(cfgAudioMinutes && cfgAudioMinutes.value ? { audioMaxMinutes: parseInt(cfgAudioMinutes.value, 10) || settingDefault('audioMaxMinutes') } : {}),
      ...(cfgEmbeddingBanks ? { useEmbeddingBanks: cfgEmbeddingBanks.checked } : {}),
    };
    const res = await sendJSON('/api/config', body);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Save failed');
    settingsStatus.textContent = `✓ Saved — using ${data.provider} · ${data.model}`;
    // A content-affecting change (OCR, document summaries, contextual retrieval, visual ingest, the embedding
    // window) or an embedding-identity change with banks off re-reads every existing document, so the server
    // starts that rebuild in the background. Tell the user so the change isn't "silent" — the header status
    // badge then shows the rebuild progress. With banks on, a new bank opens and nothing is re-embedded.
    if (data.reindexing) {
      try { showToast('Applying your change — rebuilding the search index in the background. You can keep working; new answers use it once it’s ready.', 'success'); } catch {}
    }
    // The listening address is chosen at startup, so a change to network access only takes effect on the next
    // launch. Prompt the user (once, only when it actually changed) and remember the new saved value.
    if (cfgAllowNetwork && cfgAllowNetwork.checked !== networkWasOn) {
      try {
        showToast(cfgAllowNetwork.checked
          ? 'Network access saved. Restart Lokyni to let other devices on your network reach it.'
          : 'Network access turned off. Restart Lokyni to stop listening on your network.', 'success');
      } catch {}
      networkWasOn = cfgAllowNetwork.checked;
    }
    applyWebSearchVisibility(cfgWebSearch ? cfgWebSearch.checked : true);
    // Turning the knowledge graph on auto-starts its build server-side (no separate Build click needed), so
    // reflect that live: poll the graph status so the Settings line shows "Building…" and then the result.
    if (cfgGraphRag && cfgGraphRag.checked) {
      try { if (graphStatusPoll) clearInterval(graphStatusPoll); graphStatusPoll = setInterval(refreshGraphStatus, 1500); refreshGraphStatus(); } catch {}
    }
    fetchTtsStatus(true).then((s) => { updateVoiceStatus(); try { attachRestoredControls(); } catch {} if (voiceDownloadPending(s)) pollVoiceWarm(); });   // the ttsEnabled/voice may have changed — re-read so the Read-aloud button + status reflect it (incl. on restored answers)
    fetchSttStatus(true).then((s) => { applyMicVisibility(); applyHandsfreeVisibility(); updateVoiceStatus(); if (voiceDownloadPending(s)) pollVoiceWarm(); });   // the sttEnabled/language may have changed — reflect it on the mic + hands-free buttons + status
    // Reflect the live model in the header (the page is rendered at server start,
    // so without this the badge would keep showing the old model until a restart).
    const hdrModel = document.getElementById('hdr-model');
    // Local (Ollama) vs cloud (OpenAI / Anthropic) — the name beside it tells the two cloud providers apart.
    const provIcon = data.provider === 'ollama' ? 'ic-local' : 'ic-cloud';
    const provName = data.provider === 'openai' ? 'OpenAI' : (data.provider === 'anthropic' ? 'Anthropic' : 'Ollama');
    if (hdrModel) hdrModel.innerHTML = `<svg class="ico" aria-hidden="true"><use href="#${provIcon}"/></svg> ${escapeHtml(provName)} · ${escapeHtml(data.model)}`;
    // Close modal after a moment
    setTimeout(() => closeSettingsOverlay(), 1800);
  } catch (e) {
    settingsStatus.textContent = e.message;
    settingsStatus.className = 'error';
  }
});

// ── Upload ──
if (dropZone) {
  dropZone.addEventListener('click', () => fileInput.click());
  // Keyboard access: the drop zone is an ARIA button, so Enter/Space must open the file picker
  // the same way a click does — otherwise a keyboard-only user cannot upload at all.
  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', () => { if (fileInput.files.length) uploadFiles(fileInput.files); fileInput.value = ''; });
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault(); dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  });
}

async function uploadFiles(files) {
  uploadProgress.innerHTML = '';
  uploadProgress.classList.add('visible');
  const uploads = Array.from(files).map((file) => uploadFile(file));
  const results = await Promise.allSettled(uploads);

  // Only show the "Indexing…" note if something actually uploaded. When every file
  // was rejected (e.g. an unsupported type, caught by the server's fileFilter), no
  // indexing happens — showing the note anyway left it spinning until the 20s cap
  // then vanishing, which looked like a silent failure.
  const anySucceeded = results.some(r => r.status === 'fulfilled' && r.value === true);
  if (!anySucceeded) {
    loadDocuments();
    setTimeout(() => uploadProgress.classList.remove('visible'), 3500);
    return;
  }

  // The transfer finishing isn't the same as the document being usable — embedding
  // runs afterwards and can take a while for a large PDF. Previously the progress
  // area vanished at this point, so the upload looked complete while the document
  // still showed "pending". Keep a status line until indexing actually settles.
  const note = document.createElement('div');
  note.className = 'upload-item indexing';
  note.innerHTML =
    '<div class="ui-name">Indexing…</div>' +
    '<div class="ui-bar-wrap"><div class="ui-bar indeterminate"></div></div>' +
    '<div class="ui-status">making the documents searchable</div>';
  uploadProgress.appendChild(note);
  loadDocuments();

  await waitForIndexing(note);
}

// Resolve once indexing has run and settled. The status heartbeat drives this, so
// there's no polling: wait for an `indexing` phase to start and finish, with a
// ceiling in case the change was small enough that indexing never visibly began.
function waitForIndexing(note) {
  return new Promise((resolve) => {
    let sawIndexing = false;
    let done = false;
    const finish = (msg) => {
      if (done) return;
      done = true;
      clearTimeout(cap);
      // .off is the modern name; fall back to removeListener on older clients so a
      // missing method can't leave the listener attached forever.
      if (typeof socket.off === 'function') socket.off('indexing_status', onStatus);
      else if (typeof socket.removeListener === 'function') socket.removeListener('indexing_status', onStatus);
      note.classList.add('done');
      note.querySelector('.ui-name').textContent = 'Indexed';
      note.querySelector('.ui-status').textContent = msg;
      const bar = note.querySelector('.ui-bar');
      bar.classList.remove('indeterminate');
      bar.style.width = '100%';
      loadDocuments();
      setTimeout(() => uploadProgress.classList.remove('visible'), 2500);
      resolve();
    };
    const onStatus = ({ indexing, documents }) => {
      if (indexing) { sawIndexing = true; return; }
      if (sawIndexing) finish(`${documents} document${documents !== 1 ? 's' : ''} ready`);
    };
    socket.on('indexing_status', onStatus);
    // Indexing may complete between heartbeats, or never visibly start for a tiny
    // file — don't leave the notice up forever.
    const cap = setTimeout(() => finish('ready'), 20000);
  });
}

function uploadFile(file) {
  return new Promise((resolve) => {
    const item = document.createElement('div'); item.className = 'upload-item';
    item.innerHTML = `
      <div class="ui-name">${escapeHtml(file.name)}</div>
      <div class="ui-bar-wrap"><div class="ui-bar"></div></div>
      <div class="ui-status">Uploading…</div>`;
    uploadProgress.appendChild(item);
    const bar    = item.querySelector('.ui-bar');
    const status = item.querySelector('.ui-status');

    const fd  = new FormData();
    fd.append('files', file);
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const pct = Math.round(e.loaded / e.total * 100);
        bar.style.width = pct + '%';
        status.textContent = pct < 100 ? `${pct}%` : 'Processing…';
      }
    });
    // XHR doesn't go through the fetch wrapper, so mirror that wrapper here: attach the CSRF token
    // (set after open, before send), and on a CSRF 403 — the token can be stale right after a
    // sign-in/out or a cluster secret change — refresh once and retry, exactly like every fetch()
    // mutation does, instead of surfacing a dead-end "Upload failed".
    let csrfRetried = false;
    const openAndSend = () => {
      xhr.open('POST', '/api/documents' + wsQuery());
      xhr.setRequestHeader('x-csrf-token', csrfToken);
      xhr.send(fd);
    };
    xhr.addEventListener('load', () => {
      if (xhr.status === 403 && !csrfRetried && /csrf/i.test(xhr.responseText || '')) {
        csrfRetried = true;
        refreshCsrf().then(openAndSend);   // one refresh-and-retry; csrfRetried blocks any loop
        return;
      }
      try {
        const data = JSON.parse(xhr.responseText);
        if (data.ok) { item.classList.add('done'); status.textContent = '✓ Uploaded'; resolve(true); }
        else throw new Error(data.error || 'Upload failed');
      } catch (e) { item.classList.add('error'); status.textContent = '✗ ' + e.message; resolve(false); }
    });
    xhr.addEventListener('error', () => { item.classList.add('error'); status.textContent = '✗ Network error'; resolve(false); });
    // Warm the token first if a very early upload beat the load-time refresh.
    if (csrfToken) openAndSend(); else refreshCsrf().then(openAndSend);
  });
}

// ── Log viewer ──
// Lokyni can run as a background service with no console, so errors would otherwise
// only exist in ~/.lokyni/*.log. This surfaces them in the UI.
const logsOverlay  = document.getElementById('logs-overlay');
const logsBtn      = document.getElementById('logs-btn');
const logsClose    = document.getElementById('logs-close');
const logsBody     = document.getElementById('logs-body');
const logsMeta     = document.getElementById('logs-meta');
const logsRefresh  = document.getElementById('logs-refresh');
const logsAuto     = document.getElementById('logs-autorefresh');
const logsTabOut   = document.getElementById('logs-tab-stdout');
const logsTabErr   = document.getElementById('logs-tab-stderr');
const logsTabAudit = document.getElementById('logs-tab-audit');
let logsStream = 'stdout';
let logsTimer  = null;
let logsCache  = null;

function renderLogs() {
  if (!logsCache || !logsBody) return;
  const d = logsCache[logsStream];
  if (!d) return;
  if (d.note) {
    logsBody.textContent = d.note;
    logsMeta.textContent = d.path;
    return;
  }
  const text = (d.lines || []).join('\n').trimEnd();
  logsBody.textContent = text || '(empty)';
  // In-memory output reports size 0; showing "0.0 KB" for it is just noise.
  const kb = (d.size / 1024).toFixed(1);
  logsMeta.textContent = d.size > 0 ? `${d.path} · ${kb} KB` : d.path;
  // Keep the newest output in view — that's what someone opening the logs wants.
  logsBody.scrollTop = logsBody.scrollHeight;
}

async function fetchLogs() {
  try {
    const res = await fetch('/api/logs?lines=400');
    if (!res.ok) throw new Error();
    // Merge (not replace) so the lazily-loaded audit tab survives a refresh of the log tabs.
    logsCache = Object.assign(logsCache || {}, await res.json());
    renderLogs();
  } catch {
    if (logsBody) logsBody.textContent = 'Could not load logs.';
  }
}

// The audit trail is structured; format each entry into one readable line and reuse the same
// <pre> renderer as the log tabs. A header line reports the tamper-evidence verdict.
async function fetchAudit() {
  try {
    const res = await fetch('/api/audit?limit=400');
    if (!res.ok) throw new Error();
    const d = await res.json();
    const entries = d.entries || [];
    let head;
    if (d.enabled === false) head = 'Audit log is turned off (auditLog: false).';
    else if (!d.integrity || d.integrity.checked === 0) head = 'No audited events yet.';
    else if (d.integrity.ok) head = `✓ Integrity verified — ${d.integrity.checked} sealed entries, chain intact.`;
    else head = `⚠ Integrity FAILED: ${(d.integrity.anomalies || []).join('; ')}`;
    const lines = entries.map(e => {
      const when = fmtWhen(e.ts, e.ts);
      const bits = [when, e.action, e.actor, e.target, e.detail, e.ip].filter(Boolean);
      return bits.join('  ·  ');
    });
    logsCache = Object.assign(logsCache || {}, { audit: { path: head, size: 0, lines } });
    renderLogs();
  } catch {
    if (logsBody) logsBody.textContent = 'Could not load the audit log.';
  }
}

// Fetch whichever tab is showing (audit and logs come from different endpoints).
function fetchCurrent() { return logsStream === 'audit' ? fetchAudit() : fetchLogs(); }

function setLogStream(s) {
  logsStream = s;
  // Roving tabindex: only the selected tab is in the Tab order (tabindex 0); the others are reachable with
  // the arrow keys (tabindex -1). This is the ARIA tablist keyboard pattern — one stop for the whole group.
  const setTab = (el, on) => {
    if (!el) return;
    el.classList.toggle('active', on);
    el.setAttribute('aria-selected', on ? 'true' : 'false');
    el.tabIndex = on ? 0 : -1;
  };
  setTab(logsTabOut, s === 'stdout');
  setTab(logsTabErr, s === 'stderr');
  setTab(logsTabAudit, s === 'audit');
  // Name the panel after whichever tab is active, so a screen reader announces the panel's current source.
  const activeTab = s === 'audit' ? logsTabAudit : (s === 'stderr' ? logsTabErr : logsTabOut);
  if (logsBody && activeTab) logsBody.setAttribute('aria-labelledby', activeTab.id);
  fetchCurrent();
}

function logsOpen() {
  logsOverlay?.classList.remove('hidden');
  fetchCurrent();
}
function logsHide() {
  logsOverlay?.classList.add('hidden');
  if (logsTimer) { clearInterval(logsTimer); logsTimer = null; }
  if (logsAuto) logsAuto.checked = false;
}

logsBtn?.addEventListener('click', logsOpen);
logsClose?.addEventListener('click', logsHide);
logsRefresh?.addEventListener('click', fetchCurrent);
// Copy the shown log so it can be pasted into a bug report or a chat message. Works in the desktop app
// and the browser alike (the clipboard helper falls back to a textarea when the async API is unavailable).
document.getElementById('logs-copy')?.addEventListener('click', async () => {
  const text = (logsBody && logsBody.textContent || '').trim();
  if (!text || text === '(empty)') { showToast('Nothing to copy yet', 'info'); return; }
  const ok = await copyTextToClipboard(text);
  showToast(ok ? 'Log copied to the clipboard' : 'Could not copy the log', ok ? 'info' : 'error');
});
logsTabOut?.addEventListener('click', () => setLogStream('stdout'));
logsTabErr?.addEventListener('click', () => setLogStream('stderr'));
logsTabAudit?.addEventListener('click', () => setLogStream('audit'));
// Arrow-key navigation across the log view tabs (ARIA tablist pattern): Left/Right (and Up/Down) move
// between tabs, Home/End jump to the ends, and the newly focused tab is activated and focused.
(function wireLogsTablistKeys() {
  const streams = ['stdout', 'stderr', 'audit'];
  const tabs = [logsTabOut, logsTabErr, logsTabAudit];
  const tablist = document.querySelector('.logs-tablist');
  if (!tablist || tabs.some((t) => !t)) return;
  tablist.addEventListener('keydown', (e) => {
    const cur = streams.indexOf(logsStream);
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (cur + 1) % streams.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (cur - 1 + streams.length) % streams.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = streams.length - 1;
    else return;
    e.preventDefault();
    setLogStream(streams[next]);
    try { tabs[next].focus(); } catch (_) { /* focus is best-effort */ }
  });
})();
logsAuto?.addEventListener('change', () => {
  if (logsAuto.checked) { fetchCurrent(); logsTimer = setInterval(fetchCurrent, 3000); }
  else if (logsTimer)   { clearInterval(logsTimer); logsTimer = null; }
});
logsOverlay?.addEventListener('click', (e) => { if (e.target === logsOverlay) logsHide(); });

// ── In-app guide (README viewer + search) ────────────────────────────────────
// Renders the shipped README and searches it without leaving the app. The README is fetched once
// and cached; search runs entirely client-side over the rendered text — highlighting matches,
// ranking sections by how much a topic is covered, and jumping between hits. Uses the app's own
// modal system (registered in setupModalA11y for the focus trap and Escape).
const helpOverlay = document.getElementById('help-overlay');
const helpBtn = document.getElementById('help-btn');
const helpBody = document.getElementById('help-body');
const helpSearchInput = document.getElementById('help-search-input');
const helpCountEl = document.getElementById('help-count');
const helpMatchesEl = document.getElementById('help-matches');
let helpBaseHTML = null;   // rendered README (with heading ids + fixed anchors), cached across opens
let helpMarks = [];        // current <mark> hits in document order
let helpIdx = -1;
let helpTocList = null;    // the README's Table-of-Contents list, skipped when highlighting
let helpSearchTimer = null;

// GitHub-style heading slug, so the README's own "[Section](#section)" TOC links resolve in-panel.
// Match GitHub's heading-slug algorithm so in-app Guide anchors resolve the same as the README's
// own TOC/cross-links: lowercase, drop punctuation (keep word chars, spaces, hyphens), then replace
// each whitespace character with a hyphen WITHOUT collapsing runs — so a heading like "Foo & Bar"
// (the "&" removed leaves two spaces) slugs to "foo--bar", exactly as GitHub does.
// Unicode-aware: keep letters and numbers in every script (not just ASCII \w), so a localized
// heading gets a real anchor instead of an empty id. Underscores and hyphens are preserved, and
// whitespace becomes a hyphen without collapsing runs, matching the README's own anchors.
const helpSlug = (s) => String(s).toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
// A regex-safe pattern where any run of spaces/hyphens is interchangeable, so "read only" finds
// "read-only" and metacharacters (for example c++) can't throw.
const helpFlex = (q) => escapeRegExp(q.trim()).replace(/[\s-]+/g, '[\\s-]+');
const helpSetCount = (t) => { if (helpCountEl) helpCountEl.textContent = t; };

// The Table of Contents is a link list; skip it when highlighting so a topic search does not just
// match its own index entry. It is the first list after the "Table of Contents" heading.
function helpFindToc() {
  helpTocList = null;
  helpBody.querySelectorAll('h1,h2,h3').forEach((h) => {
    if (helpTocList || !/^table of contents$/i.test(h.textContent.trim())) return;
    let n = h.nextElementSibling;
    while (n && n.tagName !== 'UL' && n.tagName !== 'OL') n = n.nextElementSibling;
    if (n) helpTocList = n;
  });
}

// Rewrite in-document ("#section") links to scroll within the panel instead of opening a new tab
// (the global Markdown renderer makes every link target="_blank"). Called after any innerHTML reset,
// since replacing the body drops the listeners — otherwise a TOC link stops working after a search.
function helpBindAnchors() {
  helpBody.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.removeAttribute('target');
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const id = a.getAttribute('href').slice(1);
      let t = null; try { t = helpBody.querySelector('#' + CSS.escape(id)); } catch {}
      if (t) t.scrollIntoView({ block: 'start' });
    });
  });
}

async function openHelp() {
  if (!helpOverlay) return;
  if (helpBaseHTML === null) {
    try {
      const res = await fetch('/readme.md', { cache: 'no-store' });
      if (!res.ok) throw new Error('unavailable');
      const md = await res.text();
      helpBody.innerHTML = (window.marked && marked.parse) ? marked.parse(md) : '';
      // Give every heading a stable, unique id. Duplicate headings (a common README pattern) would
      // otherwise share one id and make one TOC link unreachable; the -1/-2 suffix matches the
      // convention the README's own anchor links use.
      const seenHeadingIds = new Set();
      helpBody.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => {
        const base = h.id || helpSlug(h.textContent) || 'section';
        let id = base, n = 1;
        while (seenHeadingIds.has(id)) id = `${base}-${n++}`;
        h.id = id;
        seenHeadingIds.add(id);
      });
      helpBindAnchors();
      // Wide code blocks and tables scroll horizontally. Give each one a tab stop so a keyboard user
      // can reach and scroll it (WCAG 2.1.1); the tabindexes are captured in helpBaseHTML below.
      helpBody.querySelectorAll('pre, table').forEach((el) => { el.tabIndex = 0; });
      helpBaseHTML = helpBody.innerHTML;   // cache the clean rendered doc (with ids + fixed anchors)
    } catch {
      // Leave helpBaseHTML null so the next open retries — a transient fetch failure (a server
      // restart) must not stick the Guide on the error message until the whole app is reloaded.
      helpBody.innerHTML = '<p class="sr-empty">The guide is not available right now.</p>';
    }
  } else {
    helpBody.innerHTML = helpBaseHTML;   // reset any prior highlighting
    helpBindAnchors();                   // re-bind on the fresh nodes
  }
  helpFindToc();
  helpMarks = []; helpIdx = -1;
  if (helpSearchInput) helpSearchInput.value = '';
  helpSetCount(''); if (helpMatchesEl) helpMatchesEl.innerHTML = '';
  helpOverlay.classList.remove('hidden');
  setTimeout(() => { try { helpSearchInput.focus(); } catch {} }, 0);
}
function helpHide() { if (helpOverlay) helpOverlay.classList.add('hidden'); }

function helpHighlight(rx) {
  const marks = [];
  const walker = document.createTreeWalker(helpBody, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (helpTocList && helpTocList.contains(node)) return NodeFilter.FILTER_REJECT;
      const p = node.parentNode;
      if (p && (p.tagName === 'SCRIPT' || p.tagName === 'STYLE' || p.tagName === 'MARK')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets = [];
  let node; while ((node = walker.nextNode())) targets.push(node);
  for (const t of targets) {
    const text = t.nodeValue;
    rx.lastIndex = 0;
    if (!rx.test(text)) continue;   // cheap skip
    rx.lastIndex = 0;               // reset before exec — a /g regex carries lastIndex across calls
    const frag = document.createDocumentFragment();
    let last = 0, m;
    while ((m = rx.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const mark = document.createElement('mark');
      mark.className = 'help-hit';
      mark.textContent = m[0];
      frag.appendChild(mark);
      marks.push(mark);
      last = m.index + m[0].length;
      if (m[0].length === 0) rx.lastIndex++;   // guard against a zero-length match looping
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    t.parentNode.replaceChild(frag, t);
  }
  return marks;
}

function helpRenderSections() {
  // Group hits by the nearest preceding heading and rank sections by hit count, so "Jump to" points
  // where a topic is covered most, not the first incidental mention. Array sort is stable, so ties
  // keep document order (the walker visits in document order).
  const counts = new Map();
  let current = null;
  const w = document.createTreeWalker(helpBody, NodeFilter.SHOW_ELEMENT);
  let el;
  while ((el = w.nextNode())) {
    if (/^H[1-6]$/.test(el.tagName)) current = el;
    else if (el.tagName === 'MARK' && el.classList.contains('help-hit') && current) {
      counts.set(current, (counts.get(current) || 0) + 1);
    }
  }
  if (!helpMatchesEl) return;
  helpMatchesEl.innerHTML = '';
  const sections = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (!sections.length) return;
  const label = document.createElement('span');
  label.className = 'help-matches-label'; label.textContent = 'Jump to:';
  helpMatchesEl.appendChild(label);
  for (const [h, c] of sections) {
    const chip = document.createElement('button');
    chip.type = 'button'; chip.className = 'help-chip';
    chip.textContent = `${h.textContent} (${c})`;
    chip.addEventListener('click', () => h.scrollIntoView({ block: 'start' }));
    helpMatchesEl.appendChild(chip);
  }
}

function helpJump(i) {
  if (!helpMarks.length) return;
  if (helpIdx >= 0 && helpMarks[helpIdx]) helpMarks[helpIdx].classList.remove('help-hit-active');
  helpIdx = ((i % helpMarks.length) + helpMarks.length) % helpMarks.length;
  const mark = helpMarks[helpIdx];
  mark.classList.add('help-hit-active');
  mark.scrollIntoView({ block: 'center' });
  helpSetCount(`${helpIdx + 1} / ${helpMarks.length}`);
}

function helpSearch(q) {
  if (helpBaseHTML === null) return;
  q = (q || '').trim();
  helpBody.innerHTML = helpBaseHTML;   // restore the clean rendered doc before re-highlighting
  helpBindAnchors();                   // the reset dropped the listeners; re-bind so TOC links keep working
  helpFindToc();                       // re-find on the fresh nodes
  helpMarks = []; helpIdx = -1;
  if (!q) { helpSetCount(''); if (helpMatchesEl) helpMatchesEl.innerHTML = ''; return; }
  let rx; try { rx = new RegExp(helpFlex(q), 'gi'); } catch { helpSetCount(''); return; }
  helpMarks = helpHighlight(rx);
  if (!helpMarks.length && /\s/.test(q)) {   // exact phrase missed → match any word
    const words = q.split(/\s+/).map((w) => escapeRegExp(w)).filter(Boolean);
    if (words.length) { try { helpMarks = helpHighlight(new RegExp(words.join('|'), 'gi')); } catch {} }
  }
  if (!helpMarks.length) { helpSetCount('no matches'); if (helpMatchesEl) helpMatchesEl.innerHTML = ''; return; }
  helpRenderSections();
  helpJump(0);
}

helpBtn?.addEventListener('click', openHelp);
document.getElementById('help-close')?.addEventListener('click', helpHide);
helpOverlay?.addEventListener('click', (e) => { if (e.target === helpOverlay) helpHide(); });
helpSearchInput?.addEventListener('input', () => {
  clearTimeout(helpSearchTimer);
  helpSearchTimer = setTimeout(() => helpSearch(helpSearchInput.value), 140);
});
helpSearchInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); helpJump(helpIdx + (e.shiftKey ? -1 : 1)); }
});
document.getElementById('help-next')?.addEventListener('click', () => helpJump(helpIdx + 1));
document.getElementById('help-prev')?.addEventListener('click', () => helpJump(helpIdx - 1));
// Press "/" anywhere (except while typing or with a dialog open) to open the guide and search it.
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (document.querySelector('.modal-overlay:not(.hidden), .del-confirm')) return;
  e.preventDefault();
  openHelp();
});

// Indexing failures are pushed from the server so they're visible in the UI rather
// than only in a log file the user may not know exists.
socket.on('index_error', (payload) => {
  const data = parsePayload(payload);
  const bar = document.createElement('div');
  bar.className = 'index-error-bar';
  bar.innerHTML =
    `<span>⚠ Indexing problem: ${escapeHtml((data.message || 'unknown error').slice(0, 200))}</span>`;
  const view = document.createElement('button');
  view.type = 'button'; view.className = 'index-error-link'; view.textContent = 'View logs';
  view.addEventListener('click', () => { bar.remove(); logsOpen(); });
  const dismiss = document.createElement('button');
  dismiss.type = 'button'; dismiss.className = 'index-error-x'; dismiss.textContent = '✕';
  dismiss.setAttribute('aria-label', 'Dismiss'); dismiss.title = 'Dismiss';
  dismiss.addEventListener('click', () => bar.remove());
  bar.appendChild(view); bar.appendChild(dismiss);
  chatBox.appendChild(bar);
  scrollToBottom();
});

// ── Workspaces ──
// Each workspace is a separate document collection with its own index. Switching
// reloads the index server-side, so the picker disables while that happens.
const workspaceSelect = document.getElementById('workspace-select');
const NEW_WORKSPACE = '__new__';
const DEL_WORKSPACE = '__delete__';
const REN_WORKSPACE = '__rename__';

async function loadWorkspaces() {
  if (!workspaceSelect) return;
  try {
    const res = await fetch('/api/workspaces');
    if (!res.ok) return;
    const data = await res.json();

    // Build into a fragment and swap at the end. Clearing first meant any failure
    // after that point — a busy server mid-rebuild, a dropped request — left the
    // dropdown permanently empty with no way to pick a workspace.
    const frag = document.createDocumentFragment();
    (data.workspaces || []).forEach(w => {
      const o = document.createElement('option');
      o.value = w.id;
      // Disambiguate same-named workspaces by showing the id. Two workspaces both
      // called "Default" are indistinguishable otherwise, which is exactly what a
      // restore produces when it creates "default-2".
      const dupe = (data.workspaces || []).filter(x => x.name === w.name).length > 1;
      const label = dupe ? `${w.name} [${w.id}]` : w.name;
      o.textContent = `${label}${w.documents ? ` (${w.documents})` : ''}`;
      o.title = `${w.name} — ${w.id}`;
      if (w.id === data.active) o.selected = true;
      frag.appendChild(o);
    });

    const add = document.createElement('option');
    add.value = NEW_WORKSPACE; add.textContent = '+ New workspace…';
    frag.appendChild(add);
    const ren = document.createElement('option');
    ren.value = REN_WORKSPACE; ren.textContent = '✎ Rename this workspace…';
    frag.appendChild(ren);
    // The default can't be deleted — there must always be one to fall back to — so
    // only offer deletion when something else is active.
    if (data.active !== 'default') {
      const del = document.createElement('option');
      del.value = DEL_WORKSPACE; del.textContent = '✕ Delete this workspace…';
      frag.appendChild(del);
    }

    // Never rebuild while the user is interacting with the dropdown — replacing the
    // options closes it mid-click. `document.activeElement` is the reliable signal:
    // the select holds focus for the whole interaction, whereas mousedown/blur
    // brackets it inconsistently across browsers.
    if (document.activeElement === workspaceSelect) return;

    // Skip the rebuild entirely when nothing changed. Rebuilding identical options
    // is pure DOM churn that can still disturb an in-progress interaction.
    const sig = JSON.stringify({
      a: data.active,
      w: (data.workspaces || []).map(w => `${w.id}:${w.name}:${w.documents}`),
    });
    if (sig === workspaceSelect.dataset.sig) return;

    workspaceSelect.replaceChildren(frag);
    workspaceSelect.dataset.active = data.active;
    workspaceSelect.dataset.sig = sig;
  } catch { /* leave the existing list in place rather than blanking it */ }
}

workspaceSelect?.addEventListener('change', async () => {
  const value = workspaceSelect.value;
  const previous = workspaceSelect.dataset.active;

  if (value === REN_WORKSPACE) {
    workspaceSelect.value = previous;
    const current = workspaceSelect.options[workspaceSelect.selectedIndex]?.textContent || previous;
    // Only the display name changes; the folder name stays put so the documents and
    // index inside it aren't orphaned.
    const name = await showPromptModal({
      title: 'Rename workspace',
      message: 'New display name for this workspace:',
      defaultValue: current.replace(/\s*\(\d+\)$/, ''),
      okLabel: 'Rename',
    });
    if (!name || !name.trim()) return;
    try {
      const res = await sendJSON('/api/workspaces/rename', { id: previous, name: name.trim() });
      const data = await res.json();
      if (!res.ok) { showToast(data.error || 'Could not rename workspace', 'error'); return; }
      await loadWorkspaces();
    } catch { showToast('Could not rename workspace', 'error'); }
    return;
  }

  if (value === DEL_WORKSPACE) {
    workspaceSelect.value = previous;
    // Confirm against the DISPLAY name the user actually sees, not the internal id. The
    // dropdown shows a friendly name (with any "(count)" suffix), so ask for and compare that;
    // comparing against the opaque id made a user typing the visible name fail to confirm.
    const label = (workspaceSelect.options[workspaceSelect.selectedIndex]?.textContent || previous)
      .replace(/\s*\(\d+\)$/, '').trim();
    // Destructive and irreversible, so require the name to be typed rather than a
    // single confirm click.
    const typed = await showPromptModal({
      title: 'Delete workspace',
      message: `Delete the workspace "${label}"? This permanently removes its documents and index. Type the workspace name to confirm:`,
      placeholder: 'Workspace name',
      okLabel: 'Delete',
      danger: true,
    });
    if (typed === null) return;
    if (typed.trim() !== label) { showToast('Name did not match — nothing was deleted.', 'error'); return; }
    workspaceSelect.disabled = true;
    try {
      const res = await fetch(`/api/workspaces?id=${encodeURIComponent(previous)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) { showToast(data.error || 'Could not delete workspace', 'error'); return; }
      doNewConvo();
      await loadWorkspaces();
      refreshWorkspaceScopedPanel();
    } catch {
      showToast('Could not delete workspace', 'error');
    } finally {
      workspaceSelect.disabled = false;
    }
    return;
  }

  if (value === NEW_WORKSPACE) {
    workspaceSelect.value = previous;          // restore until the switch succeeds
    const name = await showPromptModal({
      title: 'New workspace',
      message: 'Name for the new workspace:',
      okLabel: 'Create',
    });
    if (!name || !name.trim()) return;
    try {
      const res = await sendJSON('/api/workspaces', { name: name.trim() });
      const ws = await res.json();
      if (!res.ok) { showToast(ws.error || 'Could not create workspace', 'error'); return; }
      await switchWorkspaceTo(ws.id);
    } catch { showToast('Could not create workspace', 'error'); }
    return;
  }
  await switchWorkspaceTo(value);
});

// Re-sync every workspace-scoped part of the Documents panel to the workspace the window is now
// viewing: the document list, the indexed-folder list, the persona field, and the "· WorkspaceName"
// label. Run after any change to which workspace this window shows (a switch, a delete, a restore) so a
// stale panel can never be edited into the wrong workspace — the folders and persona routes write to the
// workspace the fields reflect. Call AFTER loadWorkspaces(), which updates currentWorkspaceId().
function refreshWorkspaceScopedPanel() {
  // A different workspace is a different corpus. A filter carried over from the previous one could hide
  // every document in the new one, which reads as an empty workspace; reset it on a workspace change.
  resetDocFilter();
  if (typeof loadDocuments === 'function') loadDocuments();
  loadSourceFolders();
  loadPersona();
  updateDocPanelWorkspace();
}

async function switchWorkspaceTo(id) {
  // Switching reloads the whole index, which can take seconds on a large corpus.
  // Without visible feedback the app just looks frozen, so show progress in the
  // status badge and block input until it completes.
  workspaceSelect.disabled = true;
  setStatus('indexing', 'switching…');
  setInputState(true);
  try {
    const res = await sendJSON('/api/workspaces/switch', { id });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Could not switch workspace', 'error'); return; }
    // The server responds before the index finishes loading, so the switch is only
    // "done" when the status heartbeat reports the new workspace. Until then the
    // badge shows "switching…" and input stays disabled.
    // A workspace change means a different corpus — the current conversation no
    // longer refers to documents that are loaded, so start fresh. doNewConvo already
    // clears the thread and restores the empty state (the placeholder lives inside
    // chatBox, so clearing it manually would destroy the element).
    doNewConvo();
    await loadWorkspaces();
    refreshWorkspaceScopedPanel();
  } catch {
    showToast('Could not switch workspace', 'error');
  } finally {
    workspaceSelect.disabled = false;
    // The status heartbeat takes over from here; re-enable input so the user isn't
    // stuck if the switch failed.
    setInputState(false);
  }
}

loadWorkspaces();

// ── Indexed folders (Documents panel) ──
// These are per-workspace, so they load with the panel rather than with Settings —
// and they save immediately on change, since there's no Save button here. That also
// means a folder change triggers its own reindex without touching global config.
async function loadSourceFolders() {
  try {
    const res = await fetch('/api/config' + wsQuery());
    if (!res.ok) return;
    const cfg = await res.json();
    sourcePaths = Array.isArray(cfg.sourcePaths)
      ? cfg.sourcePaths.map(s => ({
          path: s.path, recursive: !!s.recursive,
          maxDepth: s.maxDepth || 3, enabled: s.enabled !== false,
        }))
      : [];
    renderSourceList();
    sourcePaths.forEach((_, i) => countSource(i));
    if (sourcePreviewMsg) sourcePreviewMsg.textContent = '';
  } catch { /* panel still usable without the list */ }
}

async function saveSourceFolders() {
  try {
    const res = await sendJSON('/api/config' + wsQuery(), {
      // Strip the transient per-folder count — UI state, not config.
      sourcePaths: sourcePaths.map(({ path, recursive, maxDepth, enabled }) =>
        ({ path, recursive, maxDepth, enabled })),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      if (sourcePreviewMsg) sourcePreviewMsg.textContent = d.error || 'Could not save folders.';
      return;
    }
    if (sourcePreviewMsg) sourcePreviewMsg.textContent = 'Saved — reindexing…';
  } catch {
    if (sourcePreviewMsg) sourcePreviewMsg.textContent = 'Could not save folders.';
  }
}

// Show which workspace the panel is showing, so the scope is never ambiguous.
async function updateDocPanelWorkspace() {
  const el = document.getElementById('doc-panel-ws');
  if (!el) return;
  try {
    const res = await fetch('/api/workspaces');
    if (!res.ok) return;
    const data = await res.json();
    const active = (data.workspaces || []).find(w => w.id === data.active);
    el.textContent = active ? `· ${active.name}` : '';
  } catch { el.textContent = ''; }
}

// ── Backup / restore ──
// Archives the active workspace to a single file. Restore shows what's inside before
// writing anything, since overwriting a workspace is destructive.
const backupPass    = document.getElementById('backup-passphrase');
const backupIdx     = document.getElementById('backup-include-index');
const backupDownBtn = document.getElementById('backup-download');
const restoreFile   = document.getElementById('restore-file');
const restorePass   = document.getElementById('restore-passphrase');
const restoreOver   = document.getElementById('restore-overwrite');
const restoreBtn    = document.getElementById('restore-run');
const restoreVerify = document.getElementById('restore-verify');
const backupMsg     = document.getElementById('backup-msg');

// Errors need to be legible: the hint style is 10px in the dim color, which is
// fine for guidance and unreadable for a failure the user has to act on.
const setBackupMsg = (t, kind = 'info') => {
  if (!backupMsg) return;
  backupMsg.textContent = t;
  backupMsg.className = 'backup-msg' + (kind === 'error' ? ' is-error' : kind === 'ok' ? ' is-ok' : '');
};

backupDownBtn?.addEventListener('click', async () => {
  setBackupMsg('Preparing backup…');
  // The streamed form POST can't use the fetch wrapper's 403-retry, so make sure the double-submit
  // token it carries as a body field is present: warm it if a very early click beat the load-time
  // refresh (otherwise the token is '' and the server rejects the backup with no visible error).
  if (!csrfToken) await refreshCsrf();
  // A same-origin form POST, not a query string: the passphrase travels in the request body so it never
  // lands in the URL, browser history, or profile sync. The browser handles the download and filename from
  // Content-Disposition and STREAMS a large archive straight to disk without buffering it in memory — so this
  // must not become a fetch()+blob() (that would hold the whole archive, possibly many GB with the index, in
  // memory). The form targets a hidden iframe, not the top window: a successful attachment downloads as usual,
  // but an ERROR response (which is not an attachment) renders into the throwaway iframe instead of navigating
  // the chat page away. Cross-browser safe (no top-level navigation on either outcome).
  const frameName = 'backup-dl-' + Date.now().toString(36);
  const frame = document.createElement('iframe');
  frame.name = frameName; frame.style.display = 'none';
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/api/backup';
  form.target = frameName;
  form.style.display = 'none';
  const add = (name, value) => {
    const i = document.createElement('input');
    i.type = 'hidden'; i.name = name; i.value = value;
    form.appendChild(i);
  };
  add('passphrase', backupPass?.value || '');
  add('includeIndex', String(!!backupIdx?.checked));
  // This is a streamed HTML form POST (it must not become fetch+blob — see above), so it can't set
  // an x-csrf-token header; carry the double-submit token as a body field, which requireCsrf also reads.
  add('_csrf', csrfToken);
  document.body.appendChild(frame);
  document.body.appendChild(form);
  form.submit();
  form.remove();
  // A streamed form download gives no completion callback, so report that it STARTED rather than falsely
  // claiming it finished (the old code said "downloaded" even when the server returned an error). Clean up
  // the hidden iframe after a grace period that also covers the browser's save dialog on large archives.
  setBackupMsg('Backup download started — check your downloads.', 'ok');
  setTimeout(() => { try { frame.remove(); } catch {} }, 60000);
});

restoreVerify?.addEventListener('click', async () => {
  const file = restoreFile?.files?.[0];
  if (!file) { setBackupMsg('Choose a .lokb backup file first.', 'error'); return; }
  const form = new FormData();
  form.append('file', file);
  form.append('passphrase', restorePass?.value || '');
  setBackupMsg('Verifying — decrypting and checking every file…');
  // A drill can take a while for a large archive; disable the button so a second click cannot race it (the
  // server also refuses concurrent drills, but the button should show that it is working).
  const btn = restoreVerify;
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/backup/verify', { method: 'POST', body: form });
    const out = await res.json();
    if (!res.ok) { setBackupMsg(out.error || 'That backup could not be verified.', 'error'); return; }
    const size = out.totalBytes ? ` (${(out.totalBytes / (1024 * 1024)).toFixed(1)} MB)` : '';
    setBackupMsg(`Verified — ${out.documents} document(s)${size}${out.encrypted ? ', decrypted' : ''}. The file is complete and restorable.`, 'ok');
  } catch {
    setBackupMsg('That backup could not be verified.', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
});

restoreBtn?.addEventListener('click', async () => {
  const file = restoreFile?.files?.[0];
  if (!file) { setBackupMsg('Choose a .lokb backup file first.', 'error'); return; }

  const form = new FormData();
  form.append('file', file);
  form.append('passphrase', restorePass?.value || '');

  // Inspect first so the confirmation can state exactly what will happen — restoring
  // over a workspace discards its current contents.
  setBackupMsg('Reading backup…');
  try {
    const res = await fetch('/api/backup/inspect', { method: 'POST', body: form });
    const info = await res.json();
    if (!res.ok) { setBackupMsg(info.error || 'Could not read that file.', 'error'); return; }

    const when = fmtWhen(info.created, 'unknown date');
    const overwrite = !!restoreOver?.checked;
    const what = `"${info.workspace.name}" — ${info.documentCount} document(s), saved ${when}`;
    const action = overwrite
      ? `This REPLACES the current workspace's documents and index.`
      : `This creates a new workspace; nothing existing is changed.`;
    const okRestore = await showConfirm({
      title: 'Restore this backup?',
      message: `Restore ${what}\n\n${action}`,
      okLabel: 'Restore', danger: overwrite,
    });
    if (!okRestore) { setBackupMsg(''); return; }

    const form2 = new FormData();
    form2.append('file', file);
    form2.append('passphrase', restorePass?.value || '');
    form2.append('overwrite', String(overwrite));
    if (overwrite) form2.append('targetId', workspaceSelect?.value || '');

    setBackupMsg('Restoring…');
    const res2 = await fetch('/api/backup/restore', { method: 'POST', body: form2 });
    const out = await res2.json();
    if (!res2.ok) { setBackupMsg(out.error || 'Restore failed.', 'error'); return; }

    setBackupMsg(`Restored ${out.documents} document(s) into "${out.workspaceId}".` +
      (out.includeIndex ? '' : ' The index will rebuild.'), 'ok');
    await loadWorkspaces();
    refreshWorkspaceScopedPanel();
  } catch {
    setBackupMsg('Restore failed.', 'error');
  }
});

// ── OCR settings ──
// The two methods trade quality against setup, and the difference matters enough
// that it's explained inline rather than left to the docs — the vision model needs a
// multi-gigabyte pull that Lokyni can't do for the user.
const cfgUseOcr      = document.getElementById('cfg-use-ocr');
const cfgOcrEngine   = document.getElementById('cfg-ocr-engine');
const cfgOcrModel    = document.getElementById('cfg-ocr-model');
const cfgVisionDescribe = document.getElementById('cfg-vision-describe');
const cfgVisualIngest   = document.getElementById('cfg-visual-ingest');
const cfgVisualCrop     = document.getElementById('cfg-visual-crop');
const cfgVisionModel    = document.getElementById('cfg-vision-model');
const cfgVisionModelText = document.getElementById('cfg-vision-model-text');
const cfgOcrMaxPages = document.getElementById('cfg-ocr-max-pages');
const ocrEngineNote  = document.getElementById('ocr-engine-note');

const OCR_NOTES = {
  tesseract:
    'Runs entirely inside Lokyni — nothing to install and no model to download. ' +
    'Accurate on clean, straight scans; struggles with skewed pages, faint text, ' +
    'columns and tables.',
  vision:
    'Sends each page to a vision model, which reads messy, skewed or dense scans ' +
    '(IDs, forms, tables) far more reliably than the built-in method and preserves ' +
    'structure. Pick a document-OCR-capable model in the "OCR vision model" field below ' +
    '(minicpm-v or llama3.2-vision) — small captioning models summarize instead of ' +
    'transcribing. The model must be pulled first (e.g. ollama pull minicpm-v). If it ' +
    'is not installed, Lokyni logs a warning and falls back to the built-in method.',
};

function updateOcrVisibility() {
  const on = !!cfgUseOcr?.checked;
  document.querySelectorAll('.cfg-ocr-row').forEach(r => r.classList.toggle('hidden', !on));
  const engine = cfgOcrEngine?.value || 'tesseract';
  if (ocrEngineNote) ocrEngineNote.textContent = OCR_NOTES[engine] || '';
  // The model name only applies to the vision method; the worker count only to the
  // built-in one (vision requests queue at the model server regardless).
  document.querySelectorAll('.cfg-ocr-vision-row')
    .forEach(r => r.classList.toggle('hidden', !on || engine !== 'vision'));
  document.querySelectorAll('.cfg-ocr-tess-row')
    .forEach(r => r.classList.toggle('hidden', !on || engine !== 'tesseract'));
}

cfgUseOcr?.addEventListener('change', updateOcrVisibility);
cfgOcrEngine?.addEventListener('change', updateOcrVisibility);

// ── Vision describe (optional image description) ──
// Populate the model dropdown from models installed in Ollama (best-effort). If
// none are found or Ollama is unreachable, the dropdown stays minimal and the user
// can type a model name in the text field instead — graceful degradation.
async function populateVisionModels(selected) {
  if (!cfgVisionModel) return;
  try {
    const r = await fetch('/api/models');
    const j = await r.json();
    const models = (j && j.available && Array.isArray(j.models)) ? j.models : [];
    cfgVisionModel.innerHTML = '<option value="">(choose a model)</option>';
    for (const m of models) {
      const o = document.createElement('option'); o.value = m; o.textContent = m;
      cfgVisionModel.appendChild(o);
    }
    if (selected && models.includes(selected)) cfgVisionModel.value = selected;
  } catch (_) { /* leave the minimal dropdown; text field is the fallback */ }
}

// Show the vision-model rows when EITHER image-describe or figure/table ingest is on —
// both use the same vision model, so the model picker must be reachable for either.
function updateVisionRows() {
  const on = (cfgVisionDescribe?.checked) || (cfgVisualIngest?.checked);
  document.querySelectorAll('.cfg-vision-row').forEach(r => r.classList.toggle('hidden', !on));
  // The figure-crop option only makes sense when figure/table ingest is on.
  const cropOn = !!cfgVisualIngest?.checked;
  document.querySelectorAll('.cfg-visual-crop-row').forEach(r => r.classList.toggle('hidden', !cropOn));
}
cfgVisionDescribe?.addEventListener('change', updateVisionRows);
cfgVisualIngest?.addEventListener('change', updateVisionRows);
// Picking from the dropdown clears the free-text field (dropdown wins), and vice
// versa, so it's clear which one is in effect.
cfgVisionModel?.addEventListener('change', () => { if (cfgVisionModel.value && cfgVisionModelText) cfgVisionModelText.value = ''; });
cfgVisionModelText?.addEventListener('input', () => { if (cfgVisionModelText.value && cfgVisionModel) cfgVisionModel.value = ''; });

// The worker count is the one OCR setting whose right value depends on the machine,
// so the UI states what "Automatic" resolves to here and what raising it costs.
const cfgOcrWorkers  = document.getElementById('cfg-ocr-workers');
const ocrWorkersNote = document.getElementById('ocr-workers-note');
let ocrAutoWorkers = null, ocrCpuCount = null;

function updateOcrWorkersNote() {
  if (!ocrWorkersNote) return;
  const v = cfgOcrWorkers?.value || '';
  if (!v) {
    ocrWorkersNote.textContent = ocrAutoWorkers
      ? `Automatic uses ${ocrAutoWorkers} page${ocrAutoWorkers === 1 ? '' : 's'} at a time on this machine (${ocrCpuCount} cores detected), leaving room for everything else.`
      : 'Chooses a safe number based on your processor.';
    return;
  }
  const n = parseInt(v, 10);
  const heavy = ocrCpuCount && n >= ocrCpuCount;
  ocrWorkersNote.textContent = n === 1
    ? 'One page at a time. Slowest, but barely touches the rest of the machine.'
    : `${n} pages at a time — roughly ${n}× faster on multi-page scans.` +
      (heavy ? ' That is at or above your core count, so the machine may feel sluggish while indexing.' : '');
}

cfgOcrWorkers?.addEventListener('change', updateOcrWorkersNote);

// Additional OCR languages. The catalog comes from the server (the same table the engine validates
// against), so the picker can never offer a code with no verified pack. English is the permanent floor;
// the stored list holds only the additional codes, capped so one selection cannot make every worker
// load an unbounded set of language packs.
const cfgOcrLanguages = document.getElementById('cfg-ocr-languages');
const ocrLanguagesNote = document.getElementById('ocr-languages-note');
const OCR_LANGUAGE_MAX = (SETTINGS_META.limits && SETTINGS_META.limits.ocrLanguages) || 4;
function selectedOcrLanguages() {
  if (!cfgOcrLanguages) return undefined;
  return [...cfgOcrLanguages.querySelectorAll('input[type="checkbox"]:not(:disabled):checked')]
    .map((cb) => cb.value)
    .filter(Boolean);
}
function updateOcrLanguageState() {
  if (!cfgOcrLanguages) return;
  const boxes = [...cfgOcrLanguages.querySelectorAll('input[type="checkbox"]:not(:disabled)')];
  const selected = boxes.filter((cb) => cb.checked).length;
  // At the cap, disable the unselected boxes too; unchecking one re-enables the rest.
  for (const cb of boxes) cb.disabled = !cb.checked && selected >= OCR_LANGUAGE_MAX;
  if (ocrLanguagesNote) {
    ocrLanguagesNote.textContent = selected
      ? `${selected} of ${OCR_LANGUAGE_MAX} additional languages selected. Each pack downloads once, then works offline.`
      : `English only. Choose up to ${OCR_LANGUAGE_MAX} additional languages; each pack downloads once, then works offline.`;
  }
}
function renderOcrLanguages(options, selected) {
  if (!cfgOcrLanguages) return;
  const list = Array.isArray(options) ? options : [];
  const selectedSet = new Set(Array.isArray(selected) ? selected : []);
  cfgOcrLanguages.replaceChildren();
  const base = list.find((o) => o && o.base) || { code: 'eng', name: 'English' };
  const baseLabel = document.createElement('label');
  baseLabel.className = 'settings-language base';
  const baseBox = document.createElement('input');
  baseBox.type = 'checkbox'; baseBox.checked = true; baseBox.disabled = true;
  baseLabel.appendChild(baseBox);
  baseLabel.appendChild(document.createTextNode(`${base.name || 'English'} (always included)`));
  cfgOcrLanguages.appendChild(baseLabel);
  for (const opt of list) {
    if (!opt || opt.base || !opt.code) continue;
    const label = document.createElement('label');
    label.className = 'settings-language';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = opt.code;
    box.checked = selectedSet.has(opt.code);
    box.addEventListener('change', updateOcrLanguageState);
    label.appendChild(box);
    label.appendChild(document.createTextNode(opt.name || opt.code));
    cfgOcrLanguages.appendChild(label);
  }
  updateOcrLanguageState();
}

// ── Why this answer ──
// Shows which documents were considered and why the ones that lost were dropped.
// The most common complaint about tools in this category is that when an answer
// ignores a document the failure feels arbitrary — this makes the reasoning legible
// without requiring the user to read a debug log.
// The post-answer meta events (trace, rating id, faithfulness) arrive WHILE the answer is
// still streaming — before its sources row is rendered (that happens on chat_end). They're
// buffered (declared in the State block above) and attached together in applyPendingMeta()
// at chat_end, once the row they hang off exists. Attaching on arrival landed them on the
// previous answer.
socket.on('retrieval_trace', (payload) => {
  try {
    pendingTrace = typeof payload === 'string' ? JSON.parse(payload) : payload;
  } catch { pendingTrace = null; }
});

// The row a just-finished answer's meta controls (rating, "why", faithfulness badge)
// attach to: its sources row when it has one, otherwise the answer bubble's row (an
// unanswered question is exactly when "why" matters most). Shared by all three attach
// helpers. Uses the LAST matching element rather than the CSS `:last-of-type` pseudo —
// that pseudo counts every sibling of the same tag (all the msg-rows are DIVs too), so
// it only coincidentally matched the newest answer.
// The answer's meta block sits after its sources row (or the answer itself when there are no sources).
// It is a stable container for the action strip and, later, follow-up suggestions. Keeping meta out of
// the sources row means actions never mix into the citation pills depending on which event arrives first.
function answerMetaFor(bot, { create = true } = {}) {
  if (!bot || !bot.parentNode) return null;
  let after = bot;
  for (let sib = bot.nextElementSibling; sib; sib = sib.nextElementSibling) {
    if (sib.classList.contains('sources-row')) { after = sib; continue; }
    if (sib.classList.contains('answer-meta')) return sib;   // reuse the existing block
    // A notice/error/similar row belongs to this answer's tail; keep looking for its meta block.
    if (sib.classList.contains('msg-row') && !sib.classList.contains('notice-row') && !sib.classList.contains('error-row')) break;
    if (sib.classList.contains('user')) break;
  }
  if (!create) return null;                                  // read-only lookup for a refresh sweep
  const meta = document.createElement('div');
  meta.className = 'answer-meta';
  after.parentNode.insertBefore(meta, after.nextSibling);
  return meta;
}
// The action strip for one answer. Created once, first inside the meta block, so a late Verify badge
// or a restored conversation's controls land in the same place as a live turn's. With `create: false` it only
// reports an existing strip, which lets a refresh pass inspect answers without adding empty blocks.
function answerActionsFor(bot, { create = true } = {}) {
  const meta = answerMetaFor(bot, { create });
  if (!meta) return null;
  let actions = meta.querySelector('.answer-actions');
  if (actions || !create) return actions || null;
  actions = document.createElement('div');
  actions.className = 'answer-actions';
  meta.insertBefore(actions, meta.firstChild);   // keep actions above follow-up suggestions
  return actions;
}
// The meta block for the newest answer, used to pin late follow-up suggestions.
function lastAnswerMetaRow() {
  const botRows = chatBox.querySelectorAll('.msg-row.bot');
  return answerMetaFor(botRows.length ? botRows[botRows.length - 1] : null);
}
// Insert a control into the action strip BEFORE the More menu, so the menu stays the last tab stop and
// the DOM order matches the visual order even though Copy creates the menu before ratings arrive.
function appendAnswerAction(row, el) {
  if (!row || !el) return;
  const menu = row.querySelector('.answer-menu');
  if (menu) row.insertBefore(el, menu); else row.appendChild(el);
}
// The action strip for the newest answer — the row every per-answer control attaches to.
function lastAnswerRow() {
  const botRows = chatBox.querySelectorAll('.msg-row.bot');
  return answerActionsFor(botRows.length ? botRows[botRows.length - 1] : null);
}

// Attach the buffered meta controls to the just-finished answer, in the order they read
// left-to-right (rating, then "why", then the faithfulness badge), and clear the buffers.
function applyPendingMeta() {
  // The copy control is always offered (it costs nothing and needs no server feature); the
  // others depend on their toggles having produced buffered data.
  // A hands-free voice turn reads its answer back automatically (below); don't ALSO attach the single-voice
  // Read-aloud button, which would both be redundant and — if clicked mid-read-back — hijack the shared audio
  // element's 'ended' handler and wedge the loop.
  const hfReadBack = (typeof HF !== 'undefined' && HF.active && handsfreeAwaitingAnswer && !!lastAnswerText.trim());
  if (lastAnswerText.trim()) {
    attachCopyButton(lastAnswerText, lastAnswerSources);
    attachDownloadButton(lastAnswerText, lastAnswerSources);
    // A podcast (Audio Overview) answer gets the two-voice "Play as podcast" control — but that path is
    // English-only (two bundled host voices). A confidently non-English podcast answer gets the language-aware
    // Read-aloud button instead, which uses a system voice rather than reading it with English hosts.
    const podcast = pendingPodcast && !isNonEnglishAnswer(pendingAnswerLang);
    if (podcast) attachPodcastButton(lastAnswerText);
    else if (!hfReadBack) attachReadAloudButton(lastAnswerText, null, pendingAnswerLang);
  }
  pendingPodcast = false;
  if (pendingOutcomeId) { attachRatingButtons(pendingOutcomeId); pendingOutcomeId = null; }
  if (pendingTrace)     { attachWhyButton(pendingTrace);        pendingTrace = null; }
  if (pendingFaith)     { attachFaithfulnessBadge(pendingFaith); pendingFaith = null; }
  if (pendingConf)      { attachConfidenceChip(pendingConf); pendingConf = null; }
  // In hands-free mode, speak the answer back (only for an answer that came FROM a voice utterance), then
  // resume listening. A typed question while hands-free is on still gets the Read-aloud button, not auto-play.
  if (hfReadBack) { handsfreeAwaitingAnswer = false; handsfreeSpeak(lastAnswerText, pendingAnswerLang); }
}

// Re-attach the content-derived controls (Copy, Download, Read aloud) to each answer rebuilt from saved history,
// so a reloaded conversation offers the same per-answer actions a live one does — not a bare transcript. The
// rating / "why" / faithfulness controls are live-only (their traces aren't saved), so they're not restored.
// Idempotent: each attach guards against a duplicate, so this is safe to run more than once — it's called on
// restore and again once the voice status resolves, so Read aloud appears even if the status arrived late.
function attachRestoredControls() {
  for (const a of restoredAnswers) {
    if (!a || !a.botRow || !a.botRow.isConnected || !a.text.trim()) continue;
    const row = answerActionsFor(a.botRow);
    attachCopyButton(a.text, a.sources, row);
    attachDownloadButton(a.text, a.sources, row);
  }
  attachAnswerReadAloud();
}

// Attach the language-aware Read-aloud control to every finalized answer currently on screen, and keep the
// controls already there in step with Settings. It covers an answer that finished before the feature was
// enabled, a language change that alters the spoken voice, and turning the feature off (which removes the
// control and its Read as menu entry). The rendered answer text and the row's data attributes are the single
// source, so no duplicate copy of each answer is kept in memory. Idempotent.
function attachAnswerReadAloud() {
  const available = readAloudAvailable();
  for (const row of chatBox.querySelectorAll('.msg-row.bot[data-answer="1"]')) {
    // Controls live in the answer's sibling meta block, not inside the message row. Read-only lookup: a pass
    // that has nothing to change must not create an empty block on every answer.
    const actions = answerActionsFor(row, { create: false });
    if (!actions) continue;
    const btn = actions.querySelector('.readaloud-btn[data-audio-kind="read"]');
    // A podcast answer owns a two-voice control instead; leave it untouched.
    if (actions.querySelector('.readaloud-btn[data-audio-kind="podcast"]')) continue;
    // With the feature off the only work is removal; skip reading every answer's text.
    if (!available) {
      if (btn) removeReadAloudControl(actions, btn);
      continue;
    }
    const bubble = row.querySelector('.bubble');
    const text = bubble ? (bubble.textContent || '') : '';
    const detected = row.dataset.answerLang || '';
    const lang = resolveReadAloudLanguage(detected);
    const mode = text.trim() ? readAloudMode(lang) : '';
    if (!mode) {
      if (btn) removeReadAloudControl(actions, btn);
      continue;
    }
    if (btn) { setReadAloudLabel(btn, lang, detected, mode); continue; }
    attachReadAloudButton(text, actions, detected);
  }
}
// Remove a per-answer read-aloud control when the feature is off or its language can no longer be spoken here.
// The Read as menu entry goes with it, so the menu never offers an action whose button is gone. A playing clip
// is stopped first, so nothing keeps speaking with no visible way to stop it.
function removeReadAloudControl(actions, btn) {
  if (ttsCurrentBtn === btn) { try { stopReadAloud(); } catch { /* already stopped */ } }
  try { btn.remove(); } catch { /* already detached */ }
  const item = actions && actions.querySelector('.ans-readas');
  if (item) item.remove();
}

// Rebuild a finished answer as Markdown — the answer text followed by a numbered source
// list — so it pastes cleanly into notes, an issue, or a document. Web sources become
// links; local documents are listed by name (their viewer links are app-local and
// meaningless outside Lokyni).
function answerToMarkdown(text, sources) {
  let out = (text || '').trim();
  const src = Array.isArray(sources) ? sources : [];
  if (src.length) {
    out += '\n\n**Sources:**\n';
    src.forEach((s, i) => {
      const label = s.source || s.url || `Source ${i + 1}`;
      out += (s.isWeb && s.url) ? `${i + 1}. [${label}](${s.url})\n` : `${i + 1}. ${label}\n`;
    });
  }
  return out;
}

// Copy text to the clipboard, degrading gracefully. The async Clipboard API needs a secure
// context (it is available on http://localhost and 127.0.0.1, but not on a plain-http LAN
// address); the textarea + execCommand fallback covers that and older browsers. Returns a
// promise that resolves true on success.
async function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    // iOS Safari/WKWebView won't establish a selection for a plain readonly textarea via .select(),
    // so execCommand('copy') returns false there. contentEditable + an explicit Range makes the
    // content selectable on iOS while staying a no-op on every other browser.
    ta.contentEditable = 'true';
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    const range = document.createRange();
    range.selectNodeContents(ta);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    try { ta.setSelectionRange(0, text.length); } catch { /* some engines reject this on an editable textarea */ }
    const ok = document.execCommand('copy');
    sel.removeAllRanges();
    ta.remove();
    return ok;
  } catch { return false; }
}

// ── Read aloud (local text-to-speech) ──
// The server synthesizes an answer to a WAV with a local voice model (lib/routes/tts.js), gated behind the
// ttsEnabled setting. Status is fetched once at startup (the voice list + whether the feature is on and possible
// on this install); the Read-aloud button appears on an answer only when it is. Playback uses one shared <audio>
// element, so starting a new read stops any previous one, and an in-flight synth is abortable. Everything
// degrades to no audio on any failure — it is a convenience, never load-bearing.
let ttsStatus = null;          // { enabled, available, voices:[{id,label}], defaultVoice, language, allowOnlineVoices, languages } — null until fetched
let ttsStatusPromise = null;
let ttsCurrentBtn = null;      // the button whose answer is currently loading/playing
let ttsGen = 0;                // bumped on every start/stop so a resolved-but-superseded synth is ignored
let ttsFetchAbort = null;      // AbortController for the in-flight synth request: stopping aborts the fetch so the client
                               // stops waiting and issues no further chunk requests. The current chunk may still finish
                               // synthesizing server-side (read-aloud is chunked, so that is at most one short chunk; the
                               // /api/tts worker has no per-request cancel), which is why Stop feels immediate regardless.
let systemSpeechGen = 0;       // bumped on every system-voice start/stop so stale utterance callbacks are ignored
// Saved per-language system-voice choices ({ lang, uri, name }) and the voices currently offered by the
// Settings picker. The server owns the preference's shape; the browser owns the installed voice list.
let ttsSystemVoicePrefs = [];
let systemVoiceChoices = [];
let ttsSystemVoiceLanguage = '';   // the language the Settings voice picker is browsing (independent of playback)
let onlineVoiceNoticeShown = false;   // one visible notice per page when an online system voice is actually used
let handsfreeSpeechGen = 0;           // invalidates a hands-free read-back start guard after a stop or newer read

// Audio playback goes through the Web Audio API (one shared AudioContext + a tracked source node), NOT an
// <audio> element: some webview engines report "no supported source" for a WAV in an <audio> tag, while
// decodeAudioData + an AudioBufferSourceNode plays it reliably everywhere and stops instantly for a barge-in.
// The context must be created/resumed inside a user gesture (browsers gate audio on an interaction). This mirrors
// the proven voice playback used elsewhere.
let audioCtx = null;           // the one shared AudioContext
let audioSources = [];         // all scheduled/playing AudioBufferSourceNodes (one for single-shot; several queued when streaming)
let audioNextTime = 0;         // the AudioContext time the next chunk should start at — drives sample-accurate, gapless playback
let audioStreamGen = 0;        // bumped on every stop, so an in-flight stream loop cancels itself
function getAudioCtx() {
  if (!audioCtx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) { try { audioCtx = new AC(); } catch {} } }
  return audioCtx;
}
// Call synchronously inside a click/tap handler so later programmatic playback is allowed.
function unlockAudio() { const ctx = getAudioCtx(); if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch {} } }
function stopAudioPlayback() {
  audioStreamGen++;            // cancel any streaming fetch/playback loop
  for (const s of audioSources) { try { s.onended = null; } catch {} try { s.stop(); } catch {} try { s.disconnect(); } catch {} }
  audioSources = []; audioNextTime = 0;
}
// Schedule a decoded buffer to play RIGHT AFTER whatever is already queued, sample-accurately. Chunks that arrive
// early queue up ahead in time (building a cushion that absorbs synthesis jitter — so it stays gapless even at
// higher speeds, where each chunk plays for less time); a chunk that arrives late just starts now and the clock
// resyncs. `onDone(src)` runs when THIS source finishes on its own.
function scheduleBuffer(decoded, onDone) {
  const ctx = getAudioCtx(); if (!ctx) return;
  const src = ctx.createBufferSource(); src.buffer = decoded; src.connect(ctx.destination);
  const startAt = Math.max(audioNextTime || 0, ctx.currentTime + 0.02);   // +20 ms so chunk 0 isn't scheduled in the past
  audioNextTime = startAt + decoded.duration;
  src.onended = () => { const i = audioSources.indexOf(src); if (i >= 0) audioSources.splice(i, 1); if (onDone) { try { onDone(src); } catch {} } };
  audioSources.push(src); src.start(startAt);
  return startAt;
}

// Split text into small sentence-ish chunks for STREAMING synthesis, so playback can start after just the first
// chunk instead of waiting for the whole answer. A smaller cap means faster time-to-first-audio.
// Language-agnostic: the terminator set spans Latin, CJK, Arabic/Urdu, Indic (danda), Armenian, Ethiopic and
// ellipses, and the hard length cap chunks ANY script (including Thai and others with no sentence punctuation),
// so streaming works regardless of language.
const TTS_TERMINATORS = '.!?。！？؟۔।॥։።…‥';
function splitForTTS(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const re = new RegExp('[^' + TTS_TERMINATORS + ']+[' + TTS_TERMINATORS + ']+["\')\\]»”’]*\\s*|[^' + TTS_TERMINATORS + ']+$', 'gu');
  const sentences = clean.match(re) || [clean];
  const MAX = 220, chunks = []; let cur = '';
  const pushCur = () => { if (cur) { chunks.push(cur); cur = ''; } };
  const hardSplit = (x) => { for (let i = 0; i < x.length; i += MAX) chunks.push(x.slice(i, i + MAX)); };
  // Progressive sizing: the first couple of chunks are kept small, so sound starts fast AND a playback cushion
  // builds quickly (each small chunk synthesizes in a flash). Once playback is comfortably ahead of synthesis,
  // chunks grow to MAX for fewer requests. The cap applies to the chunk currently being filled (index = count so far).
  const capFor = (n) => (n <= 1 ? 120 : MAX);
  for (const s of sentences) {
    const t = s.trim(); if (!t) continue;
    if (t.length > MAX) { pushCur(); hardSplit(t); continue; }
    // The FIRST chunk is a single sentence, so the very first audio is ready after synthesizing just one sentence
    // instead of the whole answer.
    if (chunks.length === 0 && !cur) { chunks.push(t); continue; }
    const cap = capFor(chunks.length);
    if ((cur + ' ' + t).trim().length > cap) { pushCur(); cur = t; }
    else cur = cur ? cur + ' ' + t : t;
  }
  pushCur();
  return chunks;
}

// Stream read-aloud: fetch each chunk's audio in order and SCHEDULE them back-to-back on the AudioContext clock,
// so sound starts as soon as the opening cushion is ready (not after the whole answer) and later chunks queue up
// ahead in time — gapless even at higher playback speeds. `bodyFor(chunk)` builds the POST body. onFirst fires
// when audio starts; onEnded when the last finishes; onError if NOTHING could be synthesized (a later failure
// just ends the stream after what already played). Non-blocking (off the main work), crash-proof (every
// fetch/decode guarded).
//
// Startup cushion (LEAD): the first chunk is one short sentence, which can finish playing before the next chunk
// is synthesized — an audible gap right after sentence one, worst at higher speeds where that sentence plays in
// half the wall-clock time. So we prebuffer the first few (small) chunks before the first note sounds; once those
// are playing, synthesis stays ahead of playback and the rest schedule gaplessly as they arrive.
async function streamReadAloud(text, { endpoint, bodyFor, onFirst, onEnded, onError } = {}) {
  const ctx = getAudioCtx();
  if (!ctx) { if (onError) onError(new Error('no audio support')); return; }
  if (ctx.state === 'suspended') { try { await ctx.resume(); } catch {} }
  const chunks = splitForTTS(text);
  if (!chunks.length) { if (onEnded) onEnded(); return; }
  const gen = ++audioStreamGen;
  audioSources = []; audioNextTime = 0;
  const ac = new AbortController(); ttsFetchAbort = ac;
  const LEAD = Math.min(2, chunks.length);   // chunks to prebuffer before the first note sounds
  let firstStarted = false, fetchDone = false;
  const cushion = [];                         // decoded buffers held until the cushion is full, then flushed in order
  const maybeEnd = () => { if (gen === audioStreamGen && fetchDone && audioSources.length === 0) { if (onEnded) onEnded(); } };
  const startPlaying = () => { for (const d of cushion) scheduleBuffer(d, () => maybeEnd()); cushion.length = 0; firstStarted = true; if (onFirst) onFirst(); };
  try {
    for (let i = 0; i < chunks.length; i++) {
      let decoded;
      try {
        const res = await sendJSON(endpoint, bodyFor ? bodyFor(chunks[i]) : { text: chunks[i] }, 'POST', { signal: ac.signal });
        if (res.status === 202) {
          // The model is still downloading (this request started it). Surface the live percent and keep the status
          // poll alive so Settings advances to "model ready", then a retry speaks. Nothing was synthesized, so stop.
          const d = await ttsDownloadingInfo(res);
          throw Object.assign(new Error('synth 202'), { status: 202, userMsg: ttsDownloadingMessage(d) });
        }
        if (!res.ok) throw Object.assign(new Error('synth ' + res.status), { status: res.status, userMsg: res.status === 503 ? 'Voice synthesis isn’t available on this install.' : undefined });
        const abuf = await res.arrayBuffer();
        if (gen !== audioStreamGen) return;
        decoded = await ctx.decodeAudioData(abuf.slice(0));
      } catch (e) {
        if (gen !== audioStreamGen || (ac.signal && ac.signal.aborted)) return;   // cancelled/superseded
        if (!firstStarted && !cushion.length) { if (onError) onError(e); return; }  // nothing synthesized yet → surface
        break;                                                                      // later chunk failed → play what we have
      }
      if (gen !== audioStreamGen) return;
      if (!firstStarted) {
        cushion.push(decoded);                 // fill the opening cushion…
        if (cushion.length >= LEAD) startPlaying();   // …then flush it and start playing
      } else {
        scheduleBuffer(decoded, () => maybeEnd());    // already playing — queue this one ahead in time (gapless)
      }
    }
    if (!firstStarted && cushion.length) startPlaying();   // answer ended before the cushion filled (short text)
    fetchDone = true; maybeEnd();
  } finally {
    if (ttsFetchAbort === ac) ttsFetchAbort = null;
  }
}
// Decode an audio arrayBuffer and play it as a single clip (podcast / voice preview), stopping anything already
// playing. `onended` fires when it finishes on its own (not when stopped). Reuses the shared scheduler.
async function playAudioBuffer(buf, onended) {
  const ctx = getAudioCtx();
  if (!ctx) throw new Error('no audio support');
  if (ctx.state === 'suspended') { try { await ctx.resume(); } catch {} }
  const decoded = await ctx.decodeAudioData(buf.slice(0));   // slice: decodeAudioData detaches the buffer it's given
  stopAudioPlayback();
  scheduleBuffer(decoded, () => { if (onended) onended(); });
}

function fetchTtsStatus(force) {
  if (force) { ttsStatus = null; ttsStatusPromise = null; }
  if (ttsStatusPromise) return ttsStatusPromise;
  const fallback = { enabled: false, available: false, voices: [], language: settingDefault('ttsLanguage') || 'auto', allowOnlineVoices: false, systemVoices: [], languages: [] };
  ttsStatusPromise = getJSON('/api/tts')
    .then((s) => {
      ttsStatus = (s && typeof s === 'object') ? s : fallback;
      // Take saved voice preferences from the status only while Settings is closed. When the dialog is open, the
      // form (loaded from the config API) is the source, so a status response cannot overwrite an unsaved pick.
      const overlay = document.getElementById('settings-overlay');
      const settingsOpen = !!overlay && !overlay.classList.contains('hidden');
      if (!settingsOpen && s && Array.isArray(s.systemVoices)) ttsSystemVoicePrefs = s.systemVoices;
      return ttsStatus;
    })
    .catch(() => { ttsStatus = fallback; return ttsStatus; });
  return ttsStatusPromise;
}
function ttsReady() { return !!(ttsStatus && ttsStatus.enabled && ttsStatus.available); }
// Read-aloud can also run entirely through the operating system's voices, so it is usable even when the bundled
// English model is unavailable — but only while the feature's master switch is on.
function systemSpeech() {
  try { return (typeof window !== 'undefined' && window.speechSynthesis) ? window.speechSynthesis : null; } catch { return null; }
}
function systemSpeechSupported() {
  try { return !!(systemSpeech() && typeof window !== 'undefined' && typeof window.SpeechSynthesisUtterance === 'function'); }
  catch { return false; }
}
function readAloudAvailable() {
  return !!(ttsStatus && ttsStatus.enabled && (ttsStatus.available || systemSpeechSupported()));
}

// Whole megabytes (base-1024), matching how the backend and model sizes are quoted. Number-only so the caller
// supplies the unit — keeps this locale-agnostic.
function voiceMB(bytes) { return Math.max(0, Math.floor((Number(bytes) || 0) / (1024 * 1024))); }
// "42% (38 / 90 MB)" from a download snapshot, or just "42%" when the total is under 1 MB — a model served
// mostly from cache reports only tiny files, whose MB round to 0, so "(0 / 0 MB)" would read as broken. One place
// so every progress string (the status line, the preview/read-aloud/mic notices) formats identically.
function voiceProgressText(d) {
  if (!d || typeof d.pct !== 'number') return '';
  return (d.totalBytes >= 1024 * 1024) ? `${d.pct}% (${voiceMB(d.bytes)} / ${voiceMB(d.totalBytes)} MB)` : `${d.pct}%`;
}

// A short, honest status for a voice feature, shown in Settings so a user can verify it's ready — or see exactly
// how its one-time model download is going, or why it failed — without digging through logs. Shared by the
// read-aloud and voice-input lines so the two never phrase the same state differently.
function voiceStatusText(st, { systemFallback = false } = {}) {
  if (!st || !st.enabled) return '';
  if (st.warming) {
    const d = st.download;
    if (d && typeof d.pct === 'number' && d.totalBytes > 0) {
      return `⬇ downloading the voice model… ${voiceProgressText(d)}`;
    }
    return '⏳ preparing the voice model…';
  }
  if (!st.available) return systemFallback && systemSpeechSupported() ? '✓ system voices only' : '⚠ not available on this install';
  if (st.downloaded) return '✓ model ready';
  // Not downloaded and not currently downloading: either it hasn't started yet, or the last attempt failed. Say
  // which, so the user isn't left staring at a silent "downloads on first use" that never progresses.
  if (st.downloadError) {
    const why = st.downloadError === 'stalled' || st.downloadError === 'timeout'
      ? 'the download stalled — check the connection to the model host'
      : 'the download didn’t finish';
    return `⚠ ${why}; it will retry`;
  }
  return '⬇ downloads on first use';
}
// While either voice model is downloading, refresh both statuses a few times so Settings advances from
// "downloading… 42%" to "ready" (and the percent ticks up) without the user closing and reopening the panel.
// Bounded, non-blocking, and only while the panel is open; the download continues in the background regardless.
// A feature that is on but not yet downloaded is polled too: the status route starts (and, after a failed
// attempt, restarts) the download when polled, so keeping the poll alive is what drives the retry.
let voiceWarmPoll = null;
let voiceWarmPollTries = 0;
function voiceDownloadPending(st) { return !!(st && st.enabled && st.available && !st.downloaded); }
function stopTtsWarmPoll() {
  if (voiceWarmPoll) { clearTimeout(voiceWarmPoll); voiceWarmPoll = null; }
  voiceWarmPollTries = 0;
}
function pollVoiceWarm() {
  if (voiceWarmPoll) return;
  const overlay = document.getElementById('settings-overlay');
  if (!overlay || overlay.classList.contains('hidden')) return;
  if (voiceWarmPollTries++ >= 150) return;   // ~10 minutes at 4s — stops polling even if a download never finishes
  voiceWarmPoll = setTimeout(() => {
    voiceWarmPoll = null;
    Promise.all([fetchTtsStatus(true), fetchSttStatus(true)])
      .then(([t, s]) => {
        updateVoiceStatus();
        if (voiceDownloadPending(t) || voiceDownloadPending(s)) pollVoiceWarm(); else voiceWarmPollTries = 0;
      })
      .catch(() => {});
  }, 4000);
}
function updateVoiceStatus() {
  const t = document.getElementById('cfg-tts-status'); if (t) t.textContent = voiceStatusText(ttsStatus, { systemFallback: true });
  const s = document.getElementById('cfg-stt-status'); if (s) s.textContent = voiceStatusText(sttStatus);
}

// A /api/tts POST answers 202 while the voice model is still downloading (the first use triggers it). Refresh
// status + start the shared poll so Settings shows the percent, and return the { pct, bytes, totalBytes } snapshot
// (or null) so the caller can phrase its own notice. Mirrors sttDownloadingInfo so read-aloud and voice input match.
async function ttsDownloadingInfo(res) {
  let info = null; try { info = await res.json(); } catch {}
  try { await fetchTtsStatus(true); updateVoiceStatus(); if (voiceDownloadPending(ttsStatus)) pollVoiceWarm(); } catch {}
  return (info && info.download) || null;
}
function ttsDownloadingMessage(d) {
  return (d && typeof d.pct === 'number' && d.totalBytes > 0)
    ? `The voice model is downloading… ${voiceProgressText(d)} — try again when it finishes.`
    : 'The voice model is downloading (one time, ~90 MB) — try again in a moment. See Settings for progress.';
}

// Fill the settings voice <select> from the live voice list, so it stays in sync with the server's set.
function populateTtsVoices(selected) {
  if (!cfgTtsVoice) return;
  fetchTtsStatus().then((s) => {
    const voices = Array.isArray(s.voices) ? s.voices : [];
    const want = selected || s.defaultVoice || (voices[0] && voices[0].id) || '';
    cfgTtsVoice.replaceChildren();
    for (const v of voices) {
      const o = document.createElement('option');
      o.value = v.id; o.textContent = v.label || v.id;
      if (v.id === want) o.selected = true;
      cfgTtsVoice.appendChild(o);
    }
  });
}
// Fill the read-aloud language picker from the server's catalog. "Automatic" is the default and matches each
// answer; choosing a code forces that language (useful when two Latin-script languages are hard to tell apart).
function populateTtsLanguages(selected) {
  if (!cfgTtsLanguage) return;
  fetchTtsStatus().then((s) => {
    const langs = sortedLanguageList(s.languages);
    const auto = settingDefault('ttsLanguage') || 'auto';
    const want = selected || s.language || auto;
    const frag = document.createDocumentFragment();
    const autoOpt = document.createElement('option');
    autoOpt.value = auto; autoOpt.textContent = 'Automatic (match each answer)';
    frag.appendChild(autoOpt);
    for (const l of langs) {
      if (!l || typeof l.code !== 'string') continue;
      const o = document.createElement('option');
      o.value = l.code; o.textContent = l.name || l.code;
      frag.appendChild(o);
    }
    cfgTtsLanguage.replaceChildren(frag);
    cfgTtsLanguage.value = (want === auto || langs.some((l) => l && l.code === want)) ? want : auto;
    populateSystemVoiceLanguageOptions(langs, cfgTtsLanguage.value);
    refreshSystemVoiceList({ restart: true });
  });
}
// The voice picker browses a language independently of read-aloud playback. The read-aloud setting decides what
// will be spoken; this setting only decides which language's installed voices the user is pinning/previewing.
// That lets someone keep Automatic playback and still choose a Spanish or French voice.
function browserLanguageCode() {
  try { return String(navigator.language || 'en').toLowerCase().split('-')[0]; } catch { return 'en'; }
}
function populateSystemVoiceLanguageOptions(langs, forced) {
  if (!cfgTtsSystemLanguage) return;
  const list = Array.isArray(langs) ? langs : [];
  if (!list.length) {
    cfgTtsSystemLanguage.replaceChildren();
    ttsSystemVoiceLanguage = '';
    return;
  }
  const auto = settingDefault('ttsLanguage') || 'auto';
  const has = (code) => list.some((l) => l.code === code);
  const forcedCode = (forced && forced !== auto && has(forced)) ? forced : '';
  const saved = Array.isArray(ttsSystemVoicePrefs)
    ? ttsSystemVoicePrefs.find((e) => e && has(e.lang))
    : null;
  const browser = browserLanguageCode();
  // Derive the browsing language from saved state on every open: a forced setting, then a language with a
  // pinned voice, then the browser language. An unsaved choice is therefore discarded by Cancel, like every
  // other Settings edit, instead of reappearing the next time the panel opens.
  const want = forcedCode || (saved && saved.lang) || (has(browser) ? browser : 'en');
  const frag = document.createDocumentFragment();
  for (const l of list) {
    const o = document.createElement('option');
    o.value = l.code; o.textContent = l.name || l.code;
    frag.appendChild(o);
  }
  cfgTtsSystemLanguage.replaceChildren(frag);
  cfgTtsSystemLanguage.disabled = false;
  const chosen = has(want) ? want : (has('en') ? 'en' : list[0].code);
  cfgTtsSystemLanguage.value = chosen;
  ttsSystemVoiceLanguage = chosen;
}

// ── System-voice picker (Settings) ──
// Automatic lets the browser choose the best local voice for the browsed language; selecting a voice pins it.
// Preferences are saved per language, so switching languages or returning to Automatic keeps each one.
const SYSTEM_VOICE_AUTO = '';   // the select's sentinel; the language's automatic choice
const SYSTEM_VOICE_NONE = '__none__';   // a disabled, explanatory row shown when no voice is available
// WebKit (and some embedded webviews) returns an empty voice list at first and may never fire voiceschanged.
// Poll briefly while the picker is open so it cannot sit on "Automatic" with no explanation. Bounded,
// non-blocking, and stopped as soon as a voice appears.
const SYSTEM_VOICE_POLL_MS = 300;
const SYSTEM_VOICE_POLL_TRIES = 20;   // about six seconds
let systemVoicePoll = null;
let systemVoicePollTries = 0;
let systemVoiceLoadState = 'idle';    // idle | loading | done
function systemVoiceList() {
  const synth = systemSpeech();
  if (!synth) return [];
  try { return Array.from(synth.getVoices() || []); } catch { return []; }
}
function voiceLangTag(voice) {
  return String((voice && voice.lang) || '').toLowerCase().replace(/_/g, '-');
}
// The subtags a browser may report for a catalog language: its code plus any aliases the server catalog ships
// (for example nb/nn for Norwegian, because installed voices never use the bare `no`). One lookup, so playback
// and the diagnostics panel match voices the same way.
function languageVoicePrefixes(code) {
  const meta = languageMeta(code);
  const base = String(code || '').toLowerCase();
  const aliases = (meta && Array.isArray(meta.aliases)) ? meta.aliases : [];
  const all = [base, ...aliases].map((a) => String(a || '').toLowerCase()).filter(Boolean);
  return all.length ? all : [base];
}
function voiceMatchesLanguage(voice, lang) {
  const tag = voiceLangTag(voice);
  if (!tag) return false;
  return languageVoicePrefixes(lang).some((want) => tag === want || tag.startsWith(want + '-'));
}
// Read-only diagnostics: list every catalog language and the voices this device reports for it. It uses the
// same catalog, the same language match, and the same local/online classification as playback, so the panel
// cannot drift from what read-aloud will actually do. Bounded rows and names keep a large voice list compact.
const TTS_VOICE_NAMES_CAP = 12;
const TTS_VOICE_NAME_CHARS = 60;
function ttsVoiceLabel(voice) {
  const raw = String((voice && (voice.name || voice.voiceURI)) || 'Unnamed voice');
  return raw.length > TTS_VOICE_NAME_CHARS ? `${raw.slice(0, TTS_VOICE_NAME_CHARS - 1)}…` : raw;
}
function ttsVoiceNames(voices, online) {
  const names = voices.slice(0, TTS_VOICE_NAMES_CAP)
    .map((v) => `${ttsVoiceLabel(v)}${online ? ' (online)' : ''}`);
  if (voices.length > TTS_VOICE_NAMES_CAP) names.push(`+${voices.length - TTS_VOICE_NAMES_CAP} more`);
  return names.join(' · ');
}
function renderTtsVoiceDiagnostics() {
  if (!cfgTtsVoicesDetails || !cfgTtsVoicesList || !cfgTtsVoicesNote || !cfgTtsVoicesDetails.open ||
      cfgTtsVoicesDetails.hidden) return;
  const langs = sortedLanguageList(ttsStatus && ttsStatus.languages);
  if (!langs.length) {
    // The catalog arrives with the voice status. Saying "no voices installed" before it lands would be a lie.
    cfgTtsVoicesList.replaceChildren();
    cfgTtsVoicesNote.textContent = 'The language list is still loading. Reopen this panel in a moment.';
    return;
  }
  const voices = systemVoiceList().slice(0, 500);   // browser-owned list, bounded for a safe scan
  const localBy = new Map(), onlineBy = new Map(), codeByPrefix = new Map();
  for (const l of langs) {
    localBy.set(l.code, []); onlineBy.set(l.code, []);
    for (const prefix of languageVoicePrefixes(l.code)) {
      if (!codeByPrefix.has(prefix)) codeByPrefix.set(prefix, l.code);
    }
  }
  let matched = 0;
  for (const v of voices) {
    if (!v) continue;
    // The base subtag is enough here (a voice tag is `lang-Script-REGION`): one map lookup per voice instead of
    // a scan of the whole catalog, so a large voice list stays cheap.
    const code = codeByPrefix.get(voiceLangTag(v).split('-')[0]);
    if (!code) continue;
    matched++;
    (v.localService === false ? onlineBy : localBy).get(code).push(v);
  }
  const frag = document.createDocumentFragment();
  let localLangs = 0, onlineOnlyLangs = 0, noneLangs = 0;
  for (const l of langs) {
    const local = localBy.get(l.code) || [];
    const online = onlineBy.get(l.code) || [];
    if (local.length) localLangs++;
    else if (online.length) onlineOnlyLangs++;
    else noneLangs++;
    const row = document.createElement('div');
    row.className = 'tts-voice-row'; row.setAttribute('role', 'listitem');
    const name = document.createElement('span');
    name.className = 'tts-voice-lang'; name.textContent = l.name || l.code;
    const detail = document.createElement('span');
    detail.className = 'tts-voice-detail';
    const parts = [];
    if (local.length) parts.push(ttsVoiceNames(local, false));
    if (online.length) parts.push(ttsVoiceNames(online, true));
    detail.textContent = parts.length ? parts.join(' · ') : 'No voice installed';
    row.appendChild(name); row.appendChild(detail); frag.appendChild(row);
  }
  cfgTtsVoicesList.replaceChildren(frag);
  if (!voices.length) {
    cfgTtsVoicesNote.textContent = systemVoiceLoadState !== 'done'
      ? 'Looking for installed system voices…'
      : 'No system voices are installed on this device. Install one in your system settings.';
    return;
  }
  const unmatched = Math.max(0, voices.length - matched);
  const bits = [
    `${localLangs} language${localLangs === 1 ? '' : 's'} with a local voice`,
    `${onlineOnlyLangs} with an online voice only`,
    `${noneLangs} with no voice`,
  ];
  if (unmatched) bits.push(`${unmatched} voice${unmatched === 1 ? '' : 's'} outside the read-aloud catalog`);
  cfgTtsVoicesNote.textContent = `${bits.join(' · ')}. Online voices are used only when allowed above.`;
}
// Status for the selected/automatic voice. A network-backed voice is called out explicitly, so the privacy
// consequence is visible before the user saves or plays anything.
function systemVoiceStatusText(installed, all, usable, chosen, allowOnline) {
  if (!installed.length) {
    if (!systemSpeechSupported()) return 'this app does not offer system voices';
    if (systemVoiceLoadState !== 'done') return 'looking for installed voices…';
    return 'no installed voice reported — the preview will try the system default';
  }
  if (!usable.length) {
    const hiddenOnline = all.some((v) => v && v.localService === false) && !allowOnline;
    return hiddenOnline
      ? 'only online voices installed — allow online voices to use one'
      : 'no voice installed for this language';
  }
  return (chosen && chosen.localService === false) ? '⚠ online voice — uses a network service' : '';
}
function updateSystemVoiceStatus(lang, selectedVoice) {
  const status = document.getElementById('cfg-tts-system-status');
  if (!status) return;
  const installed = systemVoiceList();
  const all = installed.filter((v) => voiceMatchesLanguage(v, lang));
  const allowOnline = !!(cfgTtsOnlineVoices && cfgTtsOnlineVoices.checked);
  const usable = all
    .filter((v) => v && (v.localService !== false || allowOnline))
    .sort((a, b) => (a.localService === false) - (b.localService === false));
  // Automatic picks from the local pool first (the same rule playback uses), so an online default cannot make
  // the status warn when a local voice is available.
  const localPool = usable.filter((v) => v && v.localService !== false);
  const onlinePool = usable.filter((v) => v && v.localService === false);
  const pool = localPool.length ? localPool : onlinePool;
  const chosen = selectedVoice || pool.find((v) => v.default === true) || pool[0] || null;
  status.textContent = systemVoiceStatusText(installed, all, usable, chosen, allowOnline);
}
function populateSystemVoiceOptions() {
  if (!cfgTtsSystemVoice) return;
  const lang = (cfgTtsSystemLanguage && cfgTtsSystemLanguage.value) || ttsSystemVoiceLanguage || 'en';
  const allowOnline = !!(cfgTtsOnlineVoices && cfgTtsOnlineVoices.checked);
  systemVoiceChoices = [];
  cfgTtsSystemVoice.replaceChildren();
  const auto = document.createElement('option');
  auto.value = SYSTEM_VOICE_AUTO;
  auto.textContent = 'Automatic (best local voice)';
  cfgTtsSystemVoice.appendChild(auto);
  const installed = systemVoiceList();
  const all = installed.filter((v) => voiceMatchesLanguage(v, lang));
  // Local voices first (a stable sort keeps the browser's order within each group), matching playback's
  // preference and the label the user sees.
  const usable = all
    .filter((v) => v && (v.localService !== false || allowOnline))
    .sort((a, b) => (a.localService === false) - (b.localService === false));
  if (!usable.length) {
    // Say why the list looks empty instead of leaving "Automatic" as an unexplained lone entry.
    const onlineOnly = all.some((v) => v && v.localService === false) && !allowOnline;
    const none = document.createElement('option');
    none.value = SYSTEM_VOICE_NONE;
    none.disabled = true;
    none.textContent = systemVoiceLoadState !== 'done'
      ? 'Looking for installed voices…'
      : onlineOnly
        ? 'Online voice only — allow online voices'
        : (installed.length ? 'No installed voice for this language' : 'No installed voice found');
    cfgTtsSystemVoice.appendChild(none);
  }
  usable.forEach((v, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `${v.name || v.voiceURI || 'System voice'}${v.localService === false ? ' (online)' : ''}`;
    cfgTtsSystemVoice.appendChild(o);
    systemVoiceChoices.push(v);
  });
  cfgTtsSystemVoice.disabled = false;
  const saved = findInstalledVoice(systemVoiceChoices, preferredSystemVoice(lang));
  cfgTtsSystemVoice.value = saved ? String(systemVoiceChoices.indexOf(saved)) : SYSTEM_VOICE_AUTO;
  setSystemVoicePreviewState(lang, usable.length > 0);
  updateSystemVoiceStatus(lang, saved);
}
// A preview must never be a dead button. When no installed voice is known, it stays operable: it explains
// itself through its tooltip and accessible description, and clicking it still tries the system default.
function setSystemVoicePreviewState(lang, hasUsable) {
  if (!cfgTtsSystemPreview) return;
  cfgTtsSystemPreview.disabled = false;   // always operable: it either plays or explains why it could not
  cfgTtsSystemPreview.classList.toggle('unavailable', !hasUsable);
  cfgTtsSystemPreview.title = hasUsable
    ? 'Preview this system voice'
    : (systemVoiceLoadState !== 'done'
      ? 'Looking for installed system voices'
      : `No installed voice for ${languageName(lang)} — the system default will be tried`);
}
function stopSystemVoicePoll() {
  if (systemVoicePoll) { clearTimeout(systemVoicePoll); systemVoicePoll = null; }
}
// Refresh the picker and, when the engine reports no voices yet, check again a bounded number of times. Some
// webviews populate the list only after a delay and never send voiceschanged; this gives them a fair chance
// without blocking anything or polling forever.
function refreshSystemVoiceList({ restart = false } = {}) {
  if (restart) { stopSystemVoicePoll(); systemVoicePollTries = 0; systemVoiceLoadState = 'idle'; }
  const previousState = systemVoiceLoadState;
  if (!systemSpeechSupported()) {
    // No point polling an engine that is absent; report it once and stop.
    systemVoiceLoadState = 'done';
    stopSystemVoicePoll();
    populateSystemVoiceOptions();
    try { renderTtsVoiceDiagnostics(); } catch { /* diagnostics are read-only */ }
    return;
  }
  const hasVoices = systemVoiceList().length > 0;
  if (hasVoices) {
    systemVoiceLoadState = 'done';
    stopSystemVoicePoll();
  } else if (!systemVoicePoll) {
    systemVoiceLoadState = systemVoicePollTries >= SYSTEM_VOICE_POLL_TRIES ? 'done' : 'loading';
  }
  populateSystemVoiceOptions();
  // Rebuilding the 69-row diagnostics list on every poll tick would be wasted work: only repaint it when
  // voices arrived or the state changed (loading -> done).
  if (hasVoices || systemVoiceLoadState !== previousState) {
    try { renderTtsVoiceDiagnostics(); } catch { /* diagnostics are read-only */ }
  }
  if (hasVoices || systemVoicePoll || systemVoicePollTries >= SYSTEM_VOICE_POLL_TRIES) return;
  systemVoicePoll = setTimeout(() => {
    systemVoicePoll = null;
    systemVoicePollTries++;
    refreshSystemVoiceList();
  }, SYSTEM_VOICE_POLL_MS);
}
// A short sample in the target language without a bundled phrase list: the browser supplies the language's own
// name (for example "español" or "日本語"), followed by neutral numbers. Older engines use the catalog name.
function voiceSampleText(lang) {
  try {
    const own = new Intl.DisplayNames([lang], { type: 'language' }).of(lang);
    if (own) return `${own}. 1, 2, 3.`;
  } catch { /* older engine — use the catalog name */ }
  const meta = languageMeta(lang);
  return `${meta ? meta.name : String(lang).toUpperCase()}. 1, 2, 3.`;
}
function previewSystemVoice(btn) {
  if (!btn || !cfgTtsSystemVoice) return;
  if (btn.classList.contains('playing') || btn.classList.contains('loading')) { stopReadAloud(); return; }
  const lang = (cfgTtsSystemLanguage && cfgTtsSystemLanguage.value) || ttsSystemVoiceLanguage || 'en';
  if (!systemSpeechSupported()) {
    showToast('This app does not offer system voices. Open Lokyni in your browser, or install a voice in your system settings.', 'error');
    return;
  }
  const raw = cfgTtsSystemVoice.value;
  const voice = raw ? (systemVoiceChoices[Number(raw)] || null) : null;
  const allowOnline = !!(cfgTtsOnlineVoices && cfgTtsOnlineVoices.checked);
  // Even with no installed voice in the list, an utterance still carries its language tag, and the system may
  // speak it with its default voice. So try rather than refuse; only report a failure if the engine never starts.
  const failMsg = IS_DESKTOP_APP
    ? 'Could not start a system voice here. If this is the desktop app, open Lokyni in your browser; otherwise check your device’s speech settings.'
    : 'Could not start a system voice. Check your device’s speech settings.';
  stopReadAloud();
  btn.classList.add('loading');
  let started = false;
  const timer = setTimeout(() => {
    if (started || !btn.classList.contains('loading')) return;
    stopReadAloud();
    showToast(failMsg, 'error');
  }, SYSTEM_START_TIMEOUT_MS);
  const clear = () => clearTimeout(timer);
  speakSystemText(voiceSampleText(lang), lang, {
    voice, allowOnline, noticeOnline: false,
    onFirst: () => {
      started = true; clear(); btn.classList.remove('loading'); btn.classList.add('playing');
      // A successful utterance is also what makes some webviews populate their voice list; re-check now.
      try { refreshSystemVoiceList({ restart: true }); } catch { /* the preview itself succeeded */ }
    },
    onEnded: () => { clear(); btn.classList.remove('playing', 'loading'); },
    onError: (e) => { clear(); btn.classList.remove('playing', 'loading'); showToast((e && e.userMsg) || failMsg, 'error'); },
  });
}
if (cfgTtsLanguage) cfgTtsLanguage.addEventListener('change', () => {
  const forced = cfgTtsLanguage.value;
  const auto = settingDefault('ttsLanguage') || 'auto';
  if (forced !== auto && cfgTtsSystemLanguage &&
      [...cfgTtsSystemLanguage.options].some((o) => o.value === forced)) {
    cfgTtsSystemLanguage.value = forced;
    ttsSystemVoiceLanguage = forced;
  }
  refreshSystemVoiceList({ restart: true });
});
if (cfgTtsSystemLanguage) cfgTtsSystemLanguage.addEventListener('change', () => {
  ttsSystemVoiceLanguage = cfgTtsSystemLanguage.value;
  refreshSystemVoiceList({ restart: true });
});
if (cfgTtsOnlineVoices) cfgTtsOnlineVoices.addEventListener('change', populateSystemVoiceOptions);
if (cfgTtsSystemVoice) {
  cfgTtsSystemVoice.addEventListener('change', () => {
    const lang = (cfgTtsSystemLanguage && cfgTtsSystemLanguage.value) || ttsSystemVoiceLanguage || 'en';
    const raw = cfgTtsSystemVoice.value;
    const voice = raw ? (systemVoiceChoices[Number(raw)] || null) : null;
    ttsSystemVoicePrefs = (Array.isArray(ttsSystemVoicePrefs) ? ttsSystemVoicePrefs : []).filter((e) => e && e.lang !== lang);
    if (voice) {
      // The cap is the server's (settings schema + validator share one constant). If the page projection is
      // missing, still save; the server trims to its own cap on write.
      const cap = Number(SETTINGS_META && SETTINGS_META.limits && SETTINGS_META.limits.ttsSystemVoices);
      if (!Number.isFinite(cap) || cap <= 0 || ttsSystemVoicePrefs.length < cap) {
        ttsSystemVoicePrefs.push({ lang, uri: voice.voiceURI || '', name: voice.name || '' });
      }
    }
    if (cfgTtsSystemPreview) setSystemVoicePreviewState(lang, systemVoiceChoices.length > 0);
    updateSystemVoiceStatus(lang, voice);
  });
}
if (cfgTtsSystemPreview) cfgTtsSystemPreview.addEventListener('click', () => previewSystemVoice(cfgTtsSystemPreview));
if (cfgTtsVoicesDetails) cfgTtsVoicesDetails.addEventListener('toggle', () => {
  if (cfgTtsVoicesDetails.open) refreshSystemVoiceList({ restart: true });
});
// Browsers populate the voice list asynchronously (and can add voices after a download), so refresh the picker
// when the engine reports a change. Guarded because a few engines expose the list without the event.
(function watchSystemVoices() {
  const synth = systemSpeech();
  if (!synth || typeof synth.addEventListener !== 'function') return;
  // One read at startup nudges engines that only start loading voices after the first getVoices() call.
  try { systemVoiceList(); } catch {}
  try {
    synth.addEventListener('voiceschanged', () => {
      // Only the open panel needs the update; a closed panel re-reads the list when it opens. This also
      // prevents a background retry from starting at page load or while read-aloud is off.
      const overlay = document.getElementById('settings-overlay');
      const row = document.getElementById('cfg-tts-system-voice-row');
      if (!overlay || overlay.classList.contains('hidden')) return;
      if (!row || row.classList.contains('hidden')) return;
      try { refreshSystemVoiceList({ restart: true }); } catch {}
    });
  } catch {}
})();
function applyTtsVisibility(enabled) {
  for (const el of [cfgTtsVoiceRow, cfgTtsSpeedRow, cfgTtsLanguageRow, cfgTtsSystemVoiceRow, cfgTtsOnlineVoicesRow, cfgPodcastVoicesRow]) {
    if (el) el.classList.toggle('hidden', !enabled);
  }
  if (cfgTtsVoicesDetails) cfgTtsVoicesDetails.hidden = !enabled;
  if (enabled) { try { refreshSystemVoiceList({ restart: true }); } catch {} }
  else { stopSystemVoicePoll(); }
}
if (cfgTtsEnabled) cfgTtsEnabled.addEventListener('change', () => applyTtsVisibility(cfgTtsEnabled.checked));

// Fill the two podcast host-voice <select>s from the live voice list (shared with the read-aloud picker).
function populatePodcastVoices(selA, selB) {
  if (!cfgPodcastVoiceA && !cfgPodcastVoiceB) return;
  fetchTtsStatus().then((s) => {
    const voices = Array.isArray(s.voices) ? s.voices : [];
    const fill = (sel, want, fallback) => {
      if (!sel) return;
      sel.replaceChildren();
      for (const v of voices) {
        const o = document.createElement('option');
        o.value = v.id; o.textContent = v.label || v.id;
        if (v.id === (want || fallback)) o.selected = true;
        sel.appendChild(o);
      }
    };
    // Fall back to the projected schema defaults, not hardcoded strings, so the picker can't drift from the
    // server's configured default voices (settingDefault reads the same SETTINGS_META the rest of the form uses).
    fill(cfgPodcastVoiceA, selA, settingDefault('podcastVoiceA'));
    fill(cfgPodcastVoiceB, selB, settingDefault('podcastVoiceB'));
  });
}
function updateTtsSpeedLabel() {
  if (cfgTtsSpeed && cfgTtsSpeedVal) cfgTtsSpeedVal.textContent = '(' + Number(cfgTtsSpeed.value).toFixed(1) + '×)';
}
if (cfgTtsSpeed) cfgTtsSpeed.addEventListener('input', updateTtsSpeedLabel);

// Preview a voice: synthesize a short sample with the chosen voice + current speed and play it via Web Audio,
// showing a play/stop state on the small preview button.
const VOICE_PREVIEW_TEXT = 'This is how I sound reading your documents.';
async function previewVoice(btn, voice) {
  if (!btn) return;
  if (btn.classList.contains('playing')) { stopReadAloud(); return; }   // clicking a playing preview stops it
  stopReadAloud(); unlockAudio();
  document.querySelectorAll('.voice-preview').forEach((b) => b.classList.remove('playing', 'loading'));
  const gen = ++ttsGen;
  const ac = new AbortController(); ttsFetchAbort = ac;
  btn.classList.add('loading');
  const speed = cfgTtsSpeed ? (parseFloat(cfgTtsSpeed.value) || 1) : 1;
  try {
    const res = await sendJSON('/api/tts', { text: VOICE_PREVIEW_TEXT, voice, speed }, 'POST', { signal: ac.signal });
    if (!res.ok) throw new Error('tts ' + res.status);
    const buf = await res.arrayBuffer();
    if (gen !== ttsGen) return;
    await playAudioBuffer(buf, () => btn.classList.remove('playing', 'loading'));
    if (gen === ttsGen) { btn.classList.remove('loading'); btn.classList.add('playing'); }
  } catch (e) {
    btn.classList.remove('loading', 'playing');
    if (gen !== ttsGen || (ac.signal && ac.signal.aborted)) return;
    // On first use the ~90 MB voice model downloads before it can speak, so a preview before it is ready fails.
    // Re-read the status and say WHY (downloading / not installed) instead of a bare error, and start the warm
    // poll so the Settings voice status flips to "model ready" once the download finishes — then a retry works.
    const st = await fetchTtsStatus(true).catch(() => null);
    if (st && st.available === false) {
      showToast('Voice synthesis isn’t available on this install.', 'error');
    } else if (st && (st.warming || st.downloaded === false)) {
      updateVoiceStatus(); pollVoiceWarm();
      const d = st.download;
      if (st.downloadError && !st.warming) {
        showToast('The voice model download didn’t finish — check the connection to the model host. It will retry.', 'error');
      } else if (d && typeof d.pct === 'number' && d.totalBytes > 0) {
        showToast(`The voice model is downloading… ${voiceProgressText(d)} — try the preview again when it finishes.`, 'info');
      } else {
        showToast('The voice model is downloading (one time, ~90 MB) — try the preview again in a moment. See Settings for progress.', 'info');
      }
    } else {
      showToast('Could not preview the voice.', 'error');
    }
  } finally {
    if (ttsFetchAbort === ac) ttsFetchAbort = null;
  }
}
if (cfgTtsPreview && cfgTtsVoice) cfgTtsPreview.addEventListener('click', () => previewVoice(cfgTtsPreview, cfgTtsVoice.value));
if (cfgPodcastPreviewA && cfgPodcastVoiceA) cfgPodcastPreviewA.addEventListener('click', () => previewVoice(cfgPodcastPreviewA, cfgPodcastVoiceA.value));
if (cfgPodcastPreviewB && cfgPodcastVoiceB) cfgPodcastPreviewB.addEventListener('click', () => previewVoice(cfgPodcastPreviewB, cfgPodcastVoiceB.value));

// A button's content: a play/stop icon + a label (so "Read aloud" / "Play as podcast" reads as a clear control).
const audioBtnHTML = (icon, label) => '<svg class="ico" aria-hidden="true"><use href="#' + icon + '"/></svg> ' + escapeHtml(label);

// ── Language-aware read-aloud ────────────────────────────────────────────────────────────────────────────
// The bundled voice model is English. For every other language the Web Speech API uses a voice already installed
// on the device, so coverage follows the operating system without another download. The language catalog, the
// setting, and the answer language all come from the server, so the two ends cannot drift.
const LANGUAGE_CODE_RE = /^[a-z]{2,3}$/;
// One guard for every language code that crosses a boundary: a socket payload, a saved answer, the Read as
// picker, or a forced language. The catalog includes a three-letter code (Filipino, `fil`), so both lengths are
// valid. One place owns the check and the normalization, so no caller re-invents the regex.
function isLanguageCode(value) {
  return typeof value === 'string' && LANGUAGE_CODE_RE.test(value);
}
function normalizeLanguageCode(value) {
  return isLanguageCode(value) ? value.toLowerCase() : '';
}
function languageMeta(code) {
  const list = (ttsStatus && Array.isArray(ttsStatus.languages)) ? ttsStatus.languages : [];
  return list.find((l) => l && l.code === code) || null;
}
// The server catalog is code-ordered for stable API output; the two user-facing pickers sort a copy by the
// English display name so a long, multilingual list stays easy to scan. One helper keeps both in step.
function sortedLanguageList(list) {
  return (Array.isArray(list) ? list : [])
    .filter((l) => l && typeof l.code === 'string')
    .sort((a, b) => String(a.name || a.code).localeCompare(String(b.name || b.code)));
}
function languageName(code) {
  const meta = languageMeta(code);
  return meta ? meta.name : String(code || '').toUpperCase();
}
// Online voices are opt-in, but make the actual use visible too. One notice per page keeps it informative
// without turning every answer into a toast; the Settings picker also marks the voice as online.
function noteOnlineVoice(code) {
  if (onlineVoiceNoticeShown) return;
  onlineVoiceNoticeShown = true;
  try { showToast(`Read aloud is using an online ${languageName(code)} voice.`, 'info'); } catch {}
}
function configuredReadAloudLanguage() {
  const auto = settingDefault('ttsLanguage') || 'auto';
  const raw = (ttsStatus && typeof ttsStatus.language === 'string') ? ttsStatus.language : auto;
  return raw === auto ? auto : (isLanguageCode(raw) ? raw : auto);
}
// The language this answer will be spoken in: an explicit setting wins; otherwise the answer's detected language,
// defaulting to English (the bundled local voice) when detection is uncertain.
function resolveReadAloudLanguage(detected) {
  const configured = configuredReadAloudLanguage();
  if (configured !== 'auto') return configured;
  return normalizeLanguageCode(detected) || 'en';
}
function isNonEnglishAnswer(detected) {
  const code = normalizeLanguageCode(detected);
  return !!code && code !== 'en';
}
// 'local' uses the bundled model; 'system' uses an installed operating-system voice; '' means this device cannot
// speak that language at all (so no misleading button is offered).
function readAloudMode(lang) {
  if (lang && lang !== 'en') return systemSpeechSupported() ? 'system' : '';
  if (ttsReady()) return 'local';
  return systemSpeechSupported() ? 'system' : '';
}
// Choose an installed voice for a language. Local voices are preferred; a voice the browser explicitly marks as
// non-local (network-backed) is used only when the user opted in. With no voice list yet, the utterance's lang tag
// still lets the browser pick its default, so speech works even before `getVoices()` populates.
function preferredSystemVoice(lang) {
  const list = Array.isArray(ttsSystemVoicePrefs) ? ttsSystemVoicePrefs : [];
  return list.find((e) => e && e.lang === lang) || null;
}
// Resolve a saved preference to an installed voice. The URI is exact and preferred; the name is the fallback
// because a voice URI can differ between browser and desktop surfaces while the installed name stays stable.
function findInstalledVoice(voices, pref) {
  if (!pref || !Array.isArray(voices)) return null;
  if (pref.uri) {
    const byUri = voices.find((v) => v && v.voiceURI === pref.uri);
    if (byUri) return byUri;
  }
  if (pref.name) return voices.find((v) => v && v.name === pref.name) || null;
  return null;
}
function systemVoiceChoice(code, { allowOnline } = {}) {
  const synth = systemSpeech();
  if (!synth) return { voice: null, hasVoices: false, matches: 0, blockedOnline: false };
  let voices = [];
  try { voices = synth.getVoices() || []; } catch { voices = []; }
  const want = String(code || '').toLowerCase();
  const matches = voices.filter((v) => voiceMatchesLanguage(v, want));
  const onlineAllowed = allowOnline === undefined
    ? !!(ttsStatus && ttsStatus.allowOnlineVoices === true)
    : !!allowOnline;
  // Prefer voices the browser explicitly marks local, then voices whose locality it does not report. Only a
  // voice explicitly marked non-local (network-backed) is gated behind the opt-in.
  const localKnown = matches.filter((v) => v && v.localService === true);
  const localUnknown = matches.filter((v) => v && v.localService !== true && v.localService !== false);
  const online = matches.filter((v) => v && v.localService === false);
  // A saved per-language choice wins when it is still installed and allowed; otherwise prefer the LOCAL pool
  // before considering any network-backed voice, even if the online voice is the browser's default.
  const preferred = findInstalledVoice(matches, preferredSystemVoice(want));
  const preferredUsable = !!(preferred && (preferred.localService !== false || onlineAllowed));
  const localPool = localKnown.concat(localUnknown);
  const onlinePool = onlineAllowed ? online : [];
  const pool = preferredUsable ? [preferred] : (localPool.length ? localPool : onlinePool);
  const voice = pool.find((v) => v.default === true) || pool[0] || null;
  return {
    voice,
    hasVoices: voices.length > 0,
    matches: matches.length,
    blockedOnline: !voice && matches.length > 0 && !onlineAllowed && online.length > 0,
  };
}
function speechLangTag(code, voice) {
  if (voice && voice.lang) return voice.lang;
  const meta = languageMeta(code);
  return (meta && meta.region) || code;
}
function stopSystemSpeech() {
  systemSpeechGen++;   // invalidate any queued utterance callbacks before cancelling
  const synth = systemSpeech();
  if (synth) { try { synth.cancel(); } catch {} }
}
// Speak text with a system voice, chunked by the same language-agnostic splitter the local engine uses. Chunking
// also avoids browser limits on a single long utterance. Synchronous on purpose: it is called from the click
// gesture, which several browsers require before speech starts.
function speakSystemText(text, code, { onFirst, onEnded, onError, voice, allowOnline, noticeOnline = true } = {}) {
  const synth = systemSpeech();
  const Utter = (typeof window !== 'undefined') ? window.SpeechSynthesisUtterance : null;
  if (!synth || typeof Utter !== 'function') { if (onError) onError(new Error('no system speech support')); return; }
  const chunks = splitForTTS(text);
  if (!chunks.length) { if (onEnded) onEnded(); return; }
  const onlineAllowed = allowOnline === undefined
    ? !!(ttsStatus && ttsStatus.allowOnlineVoices === true)
    : !!allowOnline;
  // An explicit voice (the Settings preview) must also respect the online gate, even before the choice is saved.
  if (voice && voice.localService === false && !onlineAllowed) {
    if (onError) onError(Object.assign(new Error('online voice'), {
      userMsg: `Only an online voice is available for ${languageName(code)}. Turn on online voices in Settings to use it.`,
    }));
    return;
  }
  const choice = systemVoiceChoice(code, { allowOnline: onlineAllowed });
  const chosen = voice || choice.voice;
  if (choice.blockedOnline) {
    if (onError) onError(Object.assign(new Error('online voice'), {
      userMsg: `Only an online voice is available for ${languageName(code)}. Turn on online voices in Settings to use it.`,
    }));
    return;
  }
  if (choice.hasVoices && !choice.matches && !chosen) {
    if (onError) onError(Object.assign(new Error('no voice'), {
      userMsg: `No system voice is installed for ${languageName(code)}. Install one in your system settings, or choose another read-aloud language in Settings.`,
    }));
    return;
  }
  if (noticeOnline && chosen && chosen.localService === false) noteOnlineVoice(code);
  const gen = ++systemSpeechGen;
  try { synth.cancel(); } catch {}   // clear anything stuck from a previous read
  try { synth.resume(); } catch {}
  const speed = (ttsStatus && typeof ttsStatus.speed === 'number') ? Math.min(2, Math.max(0.5, ttsStatus.speed)) : 1;
  const langTag = speechLangTag(code, chosen);
  let started = false, i = 0;
  const speakNext = () => {
    if (gen !== systemSpeechGen) return;
    if (i >= chunks.length) { if (onEnded) onEnded(); return; }
    const u = new Utter(chunks[i++]);
    u.lang = langTag;
    if (chosen) u.voice = chosen;
    u.rate = speed; u.pitch = 1; u.volume = 1;
    let settled = false;   // some engines can fire both end and error; advance exactly once per chunk
    const settle = (fn) => { if (settled) return; settled = true; if (fn) fn(); };
    u.onstart = () => {
      if (gen !== systemSpeechGen) return;
      if (!started) { started = true; if (onFirst) onFirst(); }
    };
    u.onend = () => { if (gen === systemSpeechGen) settle(speakNext); };
    u.onerror = (e) => {
      if (gen !== systemSpeechGen) return;
      const kind = (e && e.error) || '';
      if (kind === 'interrupted' || kind === 'canceled') { settle(); return; }   // a Stop or a newer read superseded this one
      if (!started) { settle(() => { if (onError) onError(Object.assign(new Error('speech'), { userMsg: 'Could not read the answer aloud with a system voice.' })); }); return; }
      settle(onEnded);
    };
    try { synth.speak(u); }
    catch (e) { settle(() => { if (!started) { if (onError) onError(e); } else if (onEnded) onEnded(); }); }
  };
  speakNext();
}
// The system-voice counterpart of toggleAudio, sharing the same button state and stop behavior.
let systemStartTimer = null;
const SYSTEM_START_TIMEOUT_MS = 4000;   // a silent engine should fail visibly instead of leaving a "Loading…" button
function clearSystemStartTimer() {
  if (systemStartTimer) { clearTimeout(systemStartTimer); systemStartTimer = null; }
}
function toggleSystemAudio(btn, text, lang) {
  if (ttsCurrentBtn === btn) { stopReadAloud(); return; }
  stopReadAloud();
  ttsCurrentBtn = btn;
  btn.classList.add('loading'); btn.innerHTML = audioBtnHTML('ic-play', 'Loading…'); btn.title = 'Click to cancel';
  const setPlaying = () => {
    clearSystemStartTimer();
    if (ttsCurrentBtn !== btn) return;
    btn.classList.remove('loading'); btn.classList.add('playing');
    btn.setAttribute('aria-pressed', 'true');
    announce(`Reading aloud with a ${languageName(lang)} system voice.`);
    btn.innerHTML = audioBtnHTML('ic-stop', 'Stop'); btn.title = 'Click to stop';
  };
  clearSystemStartTimer();
  systemStartTimer = setTimeout(() => {
    systemStartTimer = null;
    if (ttsCurrentBtn !== btn || !btn.classList.contains('loading')) return;
    stopReadAloud();
    showToast(`Could not start a ${languageName(lang)} system voice. Check your device’s speech settings, or choose another read-aloud language in Settings.`, 'error');
  }, SYSTEM_START_TIMEOUT_MS);
  speakSystemText(text, lang, {
    onFirst: setPlaying,
    onEnded: () => { clearSystemStartTimer(); if (ttsCurrentBtn === btn) stopReadAloud(); },
    onError: (e) => {
      clearSystemStartTimer();
      if (ttsCurrentBtn !== btn) return;
      stopReadAloud();
      showToast((e && e.userMsg) || 'Could not read the answer aloud.', 'error');
    },
  });
}
// Route one answer to the right engine. The answer's language decides; the setting can override it.
function toggleReadAloud(btn, text, detected, { forceLanguage = '' } = {}) {
  const forced = normalizeLanguageCode(forceLanguage);
  const lang = forced || resolveReadAloudLanguage(detected);
  const mode = readAloudMode(lang);
  if (mode === 'system') { toggleSystemAudio(btn, text, lang); return; }
  if (mode === 'local') {
    toggleAudio(btn, text, { endpoint: '/api/tts', errorMsg: 'Could not read the answer aloud.', stream: true });
    return;
  }
  showToast(`Read-aloud is not available for ${languageName(lang)} on this device.`, 'error');
}

// ── Per-answer "Read as…" override ──
// Lets one answer be re-read in a different language without changing the global setting. The catalog is the
// server's, so this picker cannot drift from the Settings language list. Uses a native select inside the shared
// modal system (focus trap + Escape + focus return) rather than a long custom list.
const readAsOverlay = document.getElementById('readas-overlay');
const readAsSelect = document.getElementById('readas-language');
const readAsDetected = document.getElementById('readas-detected');
const readAsGo = document.getElementById('readas-go');
const readAsCancel = document.getElementById('readas-cancel');
let readAsButton = null, readAsText = '';
function closeReadAs() {
  if (readAsOverlay) readAsOverlay.classList.add('hidden');
  readAsButton = null; readAsText = '';
}
function openReadAs(text, detected, btn) {
  if (!readAsOverlay || !readAsSelect || !readAsGo) return;
  const langs = sortedLanguageList(ttsStatus && ttsStatus.languages);
  if (!langs.length) { showToast('The language list is still loading. Try again in a moment.', 'info'); return; }
  if (!btn || !btn.isConnected || !String(text || '').trim()) return;
  readAsButton = btn;
  readAsText = text;
  const detectedCode = normalizeLanguageCode(detected);
  const detectedMeta = detectedCode ? languageMeta(detectedCode) : null;
  if (readAsDetected) readAsDetected.textContent = detectedMeta ? `Detected: ${detectedMeta.name}.` : 'Detected: uncertain.';
  const current = resolveReadAloudLanguage(detected);
  readAsSelect.replaceChildren();
  for (const l of langs) {
    if (!l || typeof l.code !== 'string') continue;
    const o = document.createElement('option');
    o.value = l.code; o.textContent = l.name || l.code;
    if (l.code === current) o.selected = true;
    readAsSelect.appendChild(o);
  }
  readAsOverlay.classList.remove('hidden');
}
if (readAsGo) readAsGo.addEventListener('click', () => {
  const btn = readAsButton, text = readAsText;
  const lang = readAsSelect ? readAsSelect.value : '';
  closeReadAs();
  if (btn && btn.isConnected && text && lang) toggleReadAloud(btn, text, null, { forceLanguage: lang });
});
if (readAsCancel) readAsCancel.addEventListener('click', closeReadAs);

function stopReadAloud() {
  handsfreeSpeechGen++;                          // invalidate any pending hands-free start guard
  ttsGen++;                                      // supersede any in-flight synth so its result is ignored
  clearSystemStartTimer();
  if (ttsFetchAbort) { try { ttsFetchAbort.abort(); } catch {} ttsFetchAbort = null; }   // also cancel the server-side synthesis (the route aborts on disconnect)
  stopAudioPlayback();                           // stop the Web Audio source node now (an 'ended' cleanup won't fire on a manual stop)
  stopSystemSpeech();                            // and cancel any operating-system utterance (barge-in / Stop)
  if (ttsCurrentBtn) { ttsCurrentBtn.innerHTML = audioBtnHTML('ic-play', ttsCurrentBtn.dataset.idle || 'Read aloud'); ttsCurrentBtn.classList.remove('playing', 'loading'); ttsCurrentBtn.setAttribute('aria-pressed', 'false'); ttsCurrentBtn.title = ttsCurrentBtn.dataset.idleTitle || ''; ttsCurrentBtn = null; }
  // Keep the small Settings preview buttons in sync (they don't go through ttsCurrentBtn).
  try { document.querySelectorAll('.voice-preview.playing, .voice-preview.loading').forEach((b) => b.classList.remove('playing', 'loading')); } catch {}
}
// Shared player for the local-voice buttons. Read-aloud STREAMS (`stream: true`): the text is chunked and each
// chunk's audio plays as soon as it's ready, so sound starts almost immediately instead of after the whole
// answer. Audio Overview is single-shot (the server returns one stitched two-voice WAV, so it can't be chunked
// client-side). Both share the button's loading/playing/cancel UI.
async function toggleAudio(btn, text, { endpoint, loadingLabel = 'Loading…', errorMsg = 'Could not play the audio.', stream = false, announceOnPlay = 'Reading aloud.' } = {}) {
  if (ttsCurrentBtn === btn) { stopReadAloud(); return; }   // clicking the active button stops it (and cancels the server work)
  stopReadAloud();                                          // a new clip stops any other that is playing
  unlockAudio();                                            // resume the AudioContext in THIS gesture, so playback is allowed after the await
  ttsCurrentBtn = btn;
  btn.classList.add('loading'); btn.innerHTML = audioBtnHTML('ic-play', loadingLabel); btn.title = 'Click to cancel';
  const setPlaying = () => { if (ttsCurrentBtn === btn) { btn.classList.remove('loading'); btn.classList.add('playing'); btn.setAttribute('aria-pressed', 'true'); if (announceOnPlay) announce(announceOnPlay); btn.innerHTML = audioBtnHTML('ic-stop', 'Stop'); btn.title = 'Click to stop'; } };
  const onErr = (e) => { if (ttsCurrentBtn === btn) { stopReadAloud(); showToast((e && e.userMsg) || errorMsg, 'error'); } };
  if (stream) {
    // Streaming path: plays chunk-by-chunk (fast first audio). onFirst flips to the Stop state, onEnded resets.
    await streamReadAloud(text, { endpoint, onFirst: setPlaying, onEnded: () => { if (ttsCurrentBtn === btn) stopReadAloud(); }, onError: onErr });
    return;
  }
  const gen = ++ttsGen;                                     // this clip's token; a later start/stop invalidates it
  const ac = new AbortController(); ttsFetchAbort = ac;     // so stopping aborts the fetch → the route aborts synthesis
  try {
    const res = await sendJSON(endpoint, { text }, 'POST', { signal: ac.signal });   // shared helper → CSRF + JSON Content-Type handled for us
    if (res.status === 202) {
      // 202 = the model is still downloading (the request started it). Show the live percent and keep the status
      // poll going so Settings advances to "model ready", after which a retry speaks.
      const d = await ttsDownloadingInfo(res);
      throw Object.assign(new Error('synth 202'), { userMsg: ttsDownloadingMessage(d) });
    }
    if (!res.ok) {
      // 503 = the voice engine isn't available on this install — say so clearly.
      const msg = res.status === 503 ? 'Voice synthesis isn’t available on this install.' : errorMsg;
      throw Object.assign(new Error('synth ' + res.status), { userMsg: msg });
    }
    const buf = await res.arrayBuffer();
    if (gen !== ttsGen) return;                             // superseded (user stopped or started another) — drop it
    await playAudioBuffer(buf, () => { if (ttsCurrentBtn === btn) stopReadAloud(); });   // on natural end, reset the button to idle
    setPlaying();
  } catch (e) {
    if (gen !== ttsGen || (ac.signal && ac.signal.aborted)) return;   // the user stopped/cancelled it — not an error
    onErr(e);
  } finally {
    if (ttsFetchAbort === ac) ttsFetchAbort = null;   // this request is done; don't abort it later
  }
}
// The idle tooltip for a read-aloud control, and the text stopReadAloud restores. It derives from the language
// that will actually be spoken plus the answer's detected language. One builder serves attach time and a
// Settings change that re-labels answers already on the screen, so the two can never disagree.
function readAloudTitle(lang, detected, mode) {
  const detectedCode = normalizeLanguageCode(detected);
  const detectedNote = detectedCode && detectedCode !== lang ? ` (detected ${languageName(detectedCode)})` : '';
  return mode === 'system'
    ? `Read this answer aloud with a ${languageName(lang)} system voice${detectedNote}`
    : `Read this answer aloud with a local voice${detectedNote}`;
}
function setReadAloudLabel(btn, lang, detected, mode) {
  const next = readAloudTitle(lang, detected, mode);
  if (btn.dataset.idleTitle === next) return;   // a no-op refresh writes nothing on a long transcript
  btn.dataset.idleTitle = next;
  // While a clip is loading or playing the title explains how to stop it; only the resting label changes.
  if (btn.getAttribute('aria-pressed') !== 'true' && !btn.classList.contains('loading')) {
    btn.title = next;
  }
}
function attachReadAloudButton(text, targetRow, detectedLang) {
  if (!readAloudAvailable()) return;                // feature off or no usable engine on this install
  const row = targetRow || lastAnswerRow();
  if (!row || row.querySelector('.readaloud-btn')) return;
  const lang = resolveReadAloudLanguage(detectedLang);
  const mode = readAloudMode(lang);
  if (!mode) return;                                // no local model and no system voice for this language
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'readaloud-btn'; btn.dataset.idle = 'Read aloud';
  btn.dataset.audioKind = 'read';
  btn.setAttribute('aria-pressed', 'false');
  setReadAloudLabel(btn, lang, detectedLang, mode);
  btn.innerHTML = audioBtnHTML('ic-play', 'Read aloud');
  btn.addEventListener('click', () => toggleReadAloud(btn, text, detectedLang));
  appendAnswerAction(row, btn);
  // A per-answer language override lives in the existing More menu, so the action strip stays compact. We close
  // the menu ourselves before opening the dialog and return true so addAnswerMenuItem does not re-focus its
  // trigger after the dialog has taken focus.
  addAnswerMenuItem(row, 'ans-readas', 'Read as…', 'Read this answer in another language', () => {
    const wrap = row.querySelector('.answer-menu');
    if (wrap && wrap._close) wrap._close(true);
    openReadAs(text, detectedLang, btn);
    return true;
  });
}
// After a podcast-format synthesis lands, offer a two-voice "Play as podcast" control on that answer instead of
// the single-voice Read-aloud. The dialogue text is sent to /api/podcast, which voices each host separately and
// stitches the audio. When the voice engine is off, show a one-line hint rather than a dead button.
function attachPodcastButton(text) {
  const row = lastAnswerRow();
  if (!row || row.querySelector('.readaloud-btn') || row.querySelector('.podcast-hint')) return;
  if (!ttsReady()) {
    const hint = document.createElement('span');
    hint.className = 'podcast-hint';
    hint.textContent = (ttsStatus && ttsStatus.enabled)
      ? 'Podcast audio needs the local voice model, which is not available on this install.'
      : 'Turn on “Read answers aloud” in Settings to play this as a podcast.';
    appendAnswerAction(row, hint);
    return;
  }
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'readaloud-btn'; btn.dataset.idle = 'Play as podcast';
  btn.dataset.audioKind = 'podcast';
  btn.setAttribute('aria-pressed', 'false');
  btn.dataset.idleTitle = 'Voice this dialogue as a two-host podcast (generated locally — may take a moment)'; btn.title = btn.dataset.idleTitle;
  btn.innerHTML = audioBtnHTML('ic-play', 'Play as podcast');
  btn.addEventListener('click', () => toggleAudio(btn, text, { endpoint: '/api/podcast', loadingLabel: 'Generating…', errorMsg: 'Could not generate the podcast audio.', announceOnPlay: 'Playing the podcast.' }));
  appendAnswerAction(row, btn);
}
// Kick the status fetch off at load so the Read-aloud button is ready to appear on the first answer — and, once
// it resolves, re-attach controls to any answers restored from history before the status was known.
fetchTtsStatus().then(() => { try { attachRestoredControls(); } catch {} });

// ── Ask by voice (local speech-to-text) ──
// Push-to-talk: the mic button records a question, the browser resamples it to 16 kHz mono PCM, the server
// transcribes it locally (lib/routes/stt.js), and the text fills the composer for editing before it is sent —
// so voice is just an input skin over the normal answer path, never a new one. Gated behind the sttEnabled
// setting and shown only when the browser can record; everything degrades to no button / a one-line message.
const micBtn = document.getElementById('mic-btn');
const STT_SAMPLE_RATE = 16000;          // Whisper's rate — the server expects exactly this
const MAX_RECORD_MS = 120000;           // auto-stop at 2 min (matches the server's audio cap), so a left-on mic can't grow unbounded
// Request the browser's own echo cancellation, noise suppression, and auto-gain for every voice capture. This
// matters most for hands-free: the mic is open while the answer plays, and without AEC the assistant's own voice
// coming back through the speakers could trip the barge-in detector (it would interrupt itself). These are
// hints — a browser may ignore one — so hands-free also guards the first moments of a read-back (see HF_BARGE_GUARD_MS).
const VOICE_AUDIO_HINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
let voiceMicPref = { id: '', label: '' };   // the remembered mic preference (from config); the label is kept so it resolves across surfaces
let voiceMicId   = '';                        // the deviceId resolved for THIS surface — what capture actually uses ('' = browser default)
// Build the getUserMedia constraints, pinning the chosen microphone when one is set. Safari rejects
// { deviceId: { exact: '' } }, so the deviceId is only added when we actually resolved one; otherwise the
// browser's own default microphone is used (unchanged behavior).
function voiceAudioConstraints() {
  const audio = Object.assign({}, VOICE_AUDIO_HINTS);
  if (voiceMicId) audio.deviceId = { exact: voiceMicId };
  return { audio };
}
// Resolve the saved preference to a deviceId that EXISTS on this surface: prefer an exact id match, then fall
// back to the remembered LABEL (a device id differs between the desktop app and a browser, but the label —
// e.g. "MacBook Pro Microphone" — is stable), else leave it as the browser default. Returns the mic list.
function resolveMicFrom(list) {
  const mics = (Array.isArray(list) ? list : []).filter((d) => d.kind === 'audioinput' && d.deviceId);
  let m = voiceMicPref.id ? mics.find((d) => d.deviceId === voiceMicPref.id) : null;
  if (!m && voiceMicPref.label) m = mics.find((d) => d.label && d.label === voiceMicPref.label);
  voiceMicId = m ? m.deviceId : '';
  return mics;
}
// Fill the Settings microphone picker. Device labels are only exposed after mic permission has been granted
// once, so before then we show a single hint instead of a mystery empty box (the proven cross-browser pattern).
// Works identically in the web app and the desktop app — both enumerate the system's input devices.
async function populateMicDevices() {
  if (!cfgMicDevice || !(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices)) return;
  let list = [];
  try { list = await navigator.mediaDevices.enumerateDevices(); } catch { return; }
  // A device's id AND label are both hidden until mic permission has been granted once — before that the browser
  // still reports an `audioinput` entry, but with empty id/label. So count the raw kind to tell "a mic exists but
  // we need permission" apart from "no mic at all", and only build real options from the named (post-grant) ones.
  const hasAudioInput = list.some((d) => d.kind === 'audioinput');
  const mics = resolveMicFrom(list);
  const named = mics.filter((d) => d.label);
  cfgMicDevice.replaceChildren();
  if (!named.length) {
    const o = document.createElement('option');
    o.value = ''; o.dataset.label = '';
    o.textContent = hasAudioInput ? 'Allow microphone access to list devices' : 'No microphone found';
    cfgMicDevice.appendChild(o);
    return;
  }
  const def = document.createElement('option');
  def.value = ''; def.dataset.label = ''; def.textContent = 'Default microphone';
  cfgMicDevice.appendChild(def);
  named.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId; o.dataset.label = d.label; o.textContent = d.label || ('Microphone ' + (i + 1));
    cfgMicDevice.appendChild(o);
  });
  cfgMicDevice.value = voiceMicId || '';   // reflect the resolved selection (Default when unresolved)
}
// Reveal microphone NAMES: the browser hides device labels/ids until mic permission is granted once, so a quick
// getUserMedia — immediately stopped, we only want the grant — unlocks them, then we re-read the list. Guarded so
// it prompts at most once per page. The desktop-app grant doesn't carry to a web browser, so the browser needs
// its own one-time prompt. Borrowed from the proven live-capture flow (don't reinvent it).
let micLabelsPrimed = false;
async function primeMicLabels() {
  if (micLabelsPrimed || !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) return;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    micLabelsPrimed = true;
    s.getTracks().forEach((t) => { try { t.stop(); } catch {} });
    await populateMicDevices();
  } catch { /* denied or no mic — keep the Default option; capture will surface a real error if it's actually used */ }
}
// Remember the preference immediately on change (so the current session's captures use it right away) — it is
// persisted to config when the user saves Settings.
if (cfgMicDevice) {
  cfgMicDevice.addEventListener('change', () => {
    voiceMicId = cfgMicDevice.value || '';
    const opt = cfgMicDevice.selectedOptions && cfgMicDevice.selectedOptions[0];
    voiceMicPref = { id: voiceMicId, label: (opt && opt.dataset.label) || '' };
  });
  // Opening the picker is a clear intent to choose a mic — prompt for access (once) so the real device names fill in.
  cfgMicDevice.addEventListener('pointerdown', () => { primeMicLabels(); });
  cfgMicDevice.addEventListener('focus', () => { primeMicLabels(); });
}
// Re-fill when the set of devices changes (a mic is plugged in or removed), so the picker stays accurate.
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  try { navigator.mediaDevices.addEventListener('devicechange', () => { populateMicDevices().catch(() => {}); }); } catch {}
}
// Load the remembered preference at startup so the FIRST capture after a reload uses the chosen device. Mic
// permission usually persists across reloads on localhost, so labels (and thus resolution) are available without
// a fresh gesture; a brand-new browser with no grant yet falls back to the default until access is allowed once.
async function loadMicPreference() {
  try { const cfg = await getJSON('/api/config'); voiceMicPref = { id: (cfg && cfg.micDeviceId) || '', label: (cfg && cfg.micLabel) || '' }; } catch {}
  try { if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) resolveMicFrom(await navigator.mediaDevices.enumerateDevices()); } catch {}
}
loadMicPreference();
let sttStatus = null;                   // { enabled, available, languages, defaultLanguage } — null until fetched
let sttStatusPromise = null;
let micRecording = false;
let micStream = null, micRecorder = null, micChunks = null, micAutoStop = null, micBusy = false;

// The browser can record only with MediaRecorder + getUserMedia over a secure context (localhost counts).
const micCapable = () => !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia
  && (window.AudioContext || window.webkitAudioContext) && (window.OfflineAudioContext || window.webkitOfflineAudioContext));

function fetchSttStatus(force) {
  if (force) { sttStatus = null; sttStatusPromise = null; }
  if (sttStatusPromise) return sttStatusPromise;
  sttStatusPromise = getJSON('/api/stt')
    .then((s) => { sttStatus = (s && typeof s === 'object') ? s : { enabled: false, available: false, languages: [] }; return sttStatus; })
    .catch(() => { sttStatus = { enabled: false, available: false, languages: [] }; return sttStatus; });
  return sttStatusPromise;
}
function sttReady() { return !!(sttStatus && sttStatus.enabled && sttStatus.available && micCapable()); }
function applyMicVisibility() { if (micBtn) micBtn.classList.toggle('hidden', !sttReady()); }

// A /api/stt POST answers 202 while the transcription model is still downloading (the first use triggers it).
// Refresh status + start the shared poll so Settings shows the percent, and return the { pct, bytes, totalBytes }
// snapshot (or null) so the caller can phrase its own notice. Shared by the push-to-talk and hands-free paths.
async function sttDownloadingInfo(res) {
  let info = null; try { info = await res.json(); } catch {}
  try { await fetchSttStatus(true); updateVoiceStatus(); if (voiceDownloadPending(sttStatus)) pollVoiceWarm(); } catch {}
  return (info && info.download) || null;
}
function sttDownloadingMessage(d) {
  return (d && typeof d.pct === 'number' && d.totalBytes > 0)
    ? `The voice-input model is downloading… ${voiceProgressText(d)} — try again when it finishes.`
    : 'The voice-input model is downloading (one time, ~75 MB) — try again in a moment. See Settings for progress.';
}

// Fill the settings language <select> from the live list, so it stays in sync with the server's set.
function populateSttLanguages(selected) {
  if (!cfgSttLanguage) return;
  fetchSttStatus().then((s) => {
    const langs = Array.isArray(s.languages) ? s.languages : [];
    const want = selected || s.defaultLanguage || (langs[0] && langs[0].code) || '';
    cfgSttLanguage.replaceChildren();
    for (const l of langs) {
      const o = document.createElement('option');
      o.value = l.code; o.textContent = l.label || l.code;
      if (l.code === want) o.selected = true;
      cfgSttLanguage.appendChild(o);
    }
  });
}
function applySttVisibility(enabled) {
  for (const el of [cfgSttLanguageRow, cfgMicDeviceRow]) if (el) el.classList.toggle('hidden', !enabled);
}
if (cfgSttEnabled) cfgSttEnabled.addEventListener('change', () => {
  applySttVisibility(cfgSttEnabled.checked);
  if (cfgSttEnabled.checked) primeMicLabels();   // turning voice on is intent to use the mic — fill the picker's device names
});
function applyAudioIngestVisibility(enabled) { if (cfgAudioMinutesRow) cfgAudioMinutesRow.classList.toggle('hidden', !enabled); }
if (cfgAudioIngest) cfgAudioIngest.addEventListener('change', () => applyAudioIngestVisibility(cfgAudioIngest.checked));

function setMicUI(state) {   // 'idle' | 'listening' | 'working'
  if (!micBtn) return;
  micBtn.classList.toggle('listening', state === 'listening');
  micBtn.classList.toggle('working', state === 'working');
  micBtn.setAttribute('aria-pressed', state === 'listening' ? 'true' : 'false');
  micBtn.disabled = state === 'working';
  micBtn.title = state === 'listening' ? 'Listening — click to stop and transcribe'
    : state === 'working' ? 'Transcribing…'
    : 'Ask by voice — click to record, click again to stop';
}

// decodeAudioData supports both the promise and the older callback form; cover both for cross-browser safety.
function decodeAudio(ctx, arrbuf) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = ctx.decodeAudioData(arrbuf, resolve, reject); } catch (e) { return reject(e); }
    if (p && typeof p.then === 'function') p.then(resolve, reject);
  });
}
// A recorded blob (whatever codec the browser chose) -> 16 kHz mono Float32 PCM, resampled anti-aliased by an
// OfflineAudioContext (the reliable cross-browser path) and downmixed to one channel.
async function pcm16kFromBlob(blob) {
  const arrbuf = await blob.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  let decoded;
  try { decoded = await decodeAudio(ctx, arrbuf); } finally { try { ctx.close(); } catch {} }
  const seconds = Math.min(decoded.duration || 0, MAX_RECORD_MS / 1000);
  const frames = Math.max(1, Math.ceil(seconds * STT_SAMPLE_RATE));
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const off = new OAC(1, frames, STT_SAMPLE_RATE);
  const src = off.createBufferSource(); src.buffer = decoded;
  src.connect(off.destination); src.start(0);
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);   // Float32Array, 16 kHz mono
}

function releaseMic() {
  if (micAutoStop) { clearTimeout(micAutoStop); micAutoStop = null; }
  if (micStream) { try { micStream.getTracks().forEach((t) => t.stop()); } catch {} micStream = null; }
  micRecorder = null; micChunks = null; micRecording = false;
}

async function startMic() {
  if (micRecording || micBusy) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia(voiceAudioConstraints());
  } catch (e) {
    // Permission denied or no device — one clear message, no retry loop.
    showToast('Microphone access was blocked. Allow it in your browser to ask by voice.', 'error');
    releaseMic();
    return;
  }
  populateMicDevices().catch(() => {});   // labels are now available — keep the Settings picker accurate
  try {
    micChunks = [];
    micRecorder = new MediaRecorder(micStream);
    micRecorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) micChunks.push(ev.data); };
    micRecorder.onstop = () => { finishMic().catch(() => { setMicUI('idle'); micBusy = false; }); };
    micRecorder.start();
    micRecording = true;
    setMicUI('listening');
    micAutoStop = setTimeout(() => { if (micRecording) stopMic(); }, MAX_RECORD_MS);
  } catch (e) {
    showToast('Could not start recording on this browser.', 'error');
    releaseMic(); setMicUI('idle');
  }
}
function stopMic() {
  if (!micRecording || !micRecorder) return;
  micRecording = false;
  if (micAutoStop) { clearTimeout(micAutoStop); micAutoStop = null; }
  setMicUI('working');
  micBusy = true;
  try { micRecorder.stop(); } catch { micBusy = false; setMicUI('idle'); releaseMic(); }   // onstop drives the rest
}
async function finishMic() {
  const chunks = micChunks || [];
  // Stop the mic tracks as soon as recording ends (don't hold the device during transcription).
  if (micStream) { try { micStream.getTracks().forEach((t) => t.stop()); } catch {} micStream = null; }
  micRecorder = null; micChunks = null;
  try {
    if (!chunks.length) { showToast('No audio was captured. Try again.', 'error'); return; }
    const blob = new Blob(chunks, { type: (chunks[0] && chunks[0].type) || 'audio/webm' });
    const pcm = await pcm16kFromBlob(blob);
    if (!pcm || pcm.length < STT_SAMPLE_RATE / 10) { showToast('That was too short to transcribe.', 'error'); return; }
    const lang = (sttStatus && sttStatus.defaultLanguage) ? sttStatus.defaultLanguage : 'en';
    // Send the typed-array view (exact bytes) rather than its backing buffer, which could be larger than the view.
    const res = await fetch('/api/stt?lang=' + encodeURIComponent(lang), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: pcm });
    if (res.status === 202) { showToast(sttDownloadingMessage(await sttDownloadingInfo(res)), 'info'); return; }
    if (!res.ok) throw new Error('stt ' + res.status);
    const data = await res.json().catch(() => ({}));
    const transcript = (data && typeof data.transcript === 'string') ? data.transcript.trim() : '';
    if (!transcript) { showToast('No speech was recognized. Try again.', 'error'); return; }
    fillComposerFromVoice(transcript);
  } catch (e) {
    showToast('Could not transcribe the audio.', 'error');
  } finally {
    micAutoStop = null; micBusy = false; setMicUI('idle');
  }
}
// Put the transcript in the composer for editing — append to anything already typed — then focus so the user
// can fix a misheard word and press Send. Dispatch 'input' so the auto-resize and send-button state update.
function fillComposerFromVoice(text) {
  const box = document.getElementById('message-input');
  if (!box) return;
  const cur = box.value.trim();
  box.value = cur ? (cur + ' ' + text) : text;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.focus();
  try { box.setSelectionRange(box.value.length, box.value.length); } catch {}
}
if (micBtn) micBtn.addEventListener('click', () => { if (micRecording) stopMic(); else startMic(); });
// Kick the status fetch off at load and reveal the mic button if the feature is on and the browser can record.
fetchSttStatus().then(applyMicVisibility);

// ── Hands-free voice mode (continuous turn detection + barge-in) ──
// A fully hands-free conversation: click once to start, then just talk. A local, model-free turn detector
// (vad.js, with an adaptive noise floor) watches the microphone, captures each utterance when you stop speaking,
// transcribes it (/api/stt), sends it as a question, and — with Read-aloud on — speaks the answer back while
// still listening, so you can BARGE IN (interrupt) simply by talking over it. Everything stays local; it
// degrades gracefully when the browser can't capture audio or the voice engine is off.
const handsfreeBtn = document.getElementById('handsfree-btn');
const HF_PREROLL_MS = 250;          // keep this much audio before speech starts, so the first word isn't clipped
const HF_MAX_UTTER_SECONDS = 30;    // hard cap on one captured utterance (bounded memory)
const HF_BARGE_GUARD_MS = 400;      // ignore a barge-in for this long after a read-back starts (echo-onset guard)
const HF_BUSY_WATCHDOG_MS = 180000; // recover a "busy" loop stuck this long (e.g. a turn whose end hooks never fired)
let handsfreeAwaitingAnswer = false;
let hfDlToastAt = 0;   // last time the "transcription model downloading" notice was shown, to throttle it in the HF loop
const HF = { active: false, busy: false, speaking: false, ctx: null, stream: null, node: null, scriptNode: null,
  detector: null, preroll: [], prerollSamples: 0, capturing: false, utter: [], utterSamples: 0, speakStart: 0, busyAt: 0 };

// Hands-free needs live PCM capture + resampling, NOT MediaRecorder (that's the push-to-talk path), so it has
// its own capability check. The AudioWorklet-or-ScriptProcessor choice is made at start (startHandsfree falls
// back), so it isn't required here.
const handsfreeCapable = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia
  && (window.AudioContext || window.webkitAudioContext) && (window.OfflineAudioContext || window.webkitOfflineAudioContext));
function handsfreeReady() {   // a turn detector loaded + STT enabled/available + the browser can capture+resample
  return typeof LokyniVAD !== 'undefined' && !!(sttStatus && sttStatus.enabled && sttStatus.available) && handsfreeCapable();
}
function applyHandsfreeVisibility() { if (handsfreeBtn) handsfreeBtn.classList.toggle('hidden', !handsfreeReady()); }
function setHandsfreeUI() {
  if (!handsfreeBtn) return;
  handsfreeBtn.classList.toggle('active', HF.active);
  handsfreeBtn.setAttribute('aria-pressed', HF.active ? 'true' : 'false');
  handsfreeBtn.title = HF.active
    ? 'Hands-free is on — just talk to ask, and talk over the answer to interrupt. Click to stop.'
    : 'Hands-free voice mode — talk to ask and hear answers back (click to start)';
}

// A raw Float32 buffer at the capture rate → 16 kHz mono (resampled anti-aliased via an OfflineAudioContext),
// the exact input the STT route expects. Mirrors pcm16kFromBlob for the live-capture path.
async function pcm16kFromFloat32(float32, srcRate) {
  if (!float32 || !float32.length) return new Float32Array(0);
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const frames = Math.max(1, Math.ceil(float32.length / srcRate * STT_SAMPLE_RATE));
  const off = new OAC(1, frames, STT_SAMPLE_RATE);
  const src = off.createBuffer(1, float32.length, srcRate);   // a buffer at the capture rate; the engine resamples it
  src.getChannelData(0).set(float32);
  const node = off.createBufferSource(); node.buffer = src; node.connect(off.destination); node.start(0);
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
}

async function startHandsfree() {
  if (HF.active) return;
  unlockAudio();   // prime the shared audio element in this gesture so answer read-backs can auto-play later
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia(voiceAudioConstraints()); }
  catch { showToast('Microphone access was blocked. Allow it to use hands-free voice.', 'error'); return; }
  populateMicDevices().catch(() => {});   // labels are now available — keep the Settings picker accurate
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  try { if (ctx.state === 'suspended') await ctx.resume(); } catch {}
  Object.assign(HF, { ctx, stream, active: true, busy: false, speaking: false, capturing: false,
    detector: LokyniVAD.createTurnDetector(), preroll: [], prerollSamples: 0, utter: [], utterSamples: 0 });
  const source = ctx.createMediaStreamSource(stream);
  const sink = ctx.createGain(); sink.gain.value = 0;   // a muted sink so the capture node is pulled but nothing is heard
  let wired = false;
  if (ctx.audioWorklet) {   // future-proof path
    try {
      await ctx.audioWorklet.addModule('/js/vad-worklet.js');
      const node = new AudioWorkletNode(ctx, 'vad-worklet');
      node.port.onmessage = (e) => onHandsfreeFrame(e.data, ctx.sampleRate);
      source.connect(node); node.connect(sink); sink.connect(ctx.destination);
      HF.node = node; wired = true;
    } catch { wired = false; }
  }
  if (!wired) {   // ScriptProcessor fallback for engines without AudioWorklet
    try {
      const sp = ctx.createScriptProcessor(2048, 1, 1);
      sp.onaudioprocess = (e) => onHandsfreeFrame(new Float32Array(e.inputBuffer.getChannelData(0)), ctx.sampleRate);
      source.connect(sp); sp.connect(sink); sink.connect(ctx.destination);
      HF.scriptNode = sp; wired = true;
    } catch { wired = false; }
  }
  if (!wired) { showToast('This browser can’t capture audio for hands-free.', 'error'); stopHandsfree(); return; }
  setHandsfreeUI();
  showToast('Hands-free on — just start talking.', 'info');
}

function stopHandsfree() {
  HF.active = false; HF.busy = false; HF.speaking = false; HF.capturing = false; handsfreeAwaitingAnswer = false;
  stopReadAloud();   // stop any answer currently playing
  try { if (HF.node) HF.node.disconnect(); } catch {}
  try { if (HF.scriptNode) { HF.scriptNode.disconnect(); HF.scriptNode.onaudioprocess = null; } } catch {}
  try { if (HF.stream) HF.stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { if (HF.ctx) HF.ctx.close(); } catch {}
  Object.assign(HF, { node: null, scriptNode: null, stream: null, ctx: null, detector: null, preroll: [], prerollSamples: 0, utter: [], utterSamples: 0, speakStart: 0, busyAt: 0 });
  setHandsfreeUI();
}

function onHandsfreeFrame(frame, rate) {
  if (!HF.active || !HF.detector || !frame || !frame.length) return;
  const frameMs = frame.length / rate * 1000;
  // Maintain a short pre-roll ring so a capture includes the moment just before speech was detected.
  HF.preroll.push(frame); HF.prerollSamples += frame.length;
  const prerollCap = Math.round(HF_PREROLL_MS / 1000 * rate);
  while (HF.preroll.length > 1 && HF.prerollSamples - HF.preroll[0].length > prerollCap) HF.prerollSamples -= HF.preroll.shift().length;

  const r = HF.detector.observe(frame, frameMs, HF.speaking);
  if (HF.speaking) {
    // Ignore a barge-in for the first moments of a read-back: that is when the answer's audio ramps up and any
    // residual echo (past the browser's echo cancellation) is most likely to look like speech.
    if (r.bargeIn && !(HF.speakStart && Date.now() - HF.speakStart < HF_BARGE_GUARD_MS)) bargeInHandsfree();
    return;
  }
  // Safety net: if the loop has been "busy" (transcribing / awaiting an answer, but not reading one back) far
  // longer than any turn should take — e.g. a socket drop meant the turn-end hooks never fired — recover so the
  // conversation never silently wedges.
  if (HF.busy) {
    if (HF.busyAt && Date.now() - HF.busyAt > HF_BUSY_WATCHDOG_MS) { HF.busy = false; handsfreeAwaitingAnswer = false; }
    return;
  }

  if (r.speech && !HF.capturing) { HF.capturing = true; HF.utter = HF.preroll.slice(); HF.utterSamples = HF.prerollSamples; }
  if (HF.capturing) {
    if (HF.utter[HF.utter.length - 1] !== frame) { HF.utter.push(frame); HF.utterSamples += frame.length; }   // the current frame is already in the pre-roll seed
    if (HF.utterSamples > HF_MAX_UTTER_SECONDS * rate) { r.endpoint = true; r.valid = true; }   // force-end an over-long turn
  }
  if (r.endpoint && HF.capturing) {
    const frames = HF.utter, valid = r.valid;
    HF.capturing = false; HF.utter = []; HF.utterSamples = 0;
    if (valid) { HF.busy = true; HF.busyAt = Date.now(); finalizeHandsfreeUtterance(frames, rate); }
  }
}

// The user talked over the answer — stop the playback (and the server synthesis) and start capturing at once.
function bargeInHandsfree() {
  stopReadAloud();
  HF.speaking = false; HF.busy = false; HF.speakStart = 0;
  if (HF.detector) HF.detector.reset();
  HF.capturing = true; HF.utter = HF.preroll.slice(); HF.utterSamples = HF.prerollSamples;
}

async function finalizeHandsfreeUtterance(frames, rate) {
  try {
    if (!msgInput || msgInput.disabled) { HF.busy = false; return; }   // a turn is already in flight — skip, keep listening
    let total = 0; for (const f of frames) total += f.length;
    const buf = new Float32Array(total); let o = 0; for (const f of frames) { buf.set(f, o); o += f.length; }
    const pcm = await pcm16kFromFloat32(buf, rate);
    if (!HF.active) return;
    if (!pcm || pcm.length < STT_SAMPLE_RATE / 5) { HF.busy = false; return; }   // < 200 ms — nothing meaningful
    const lang = (sttStatus && sttStatus.defaultLanguage) ? sttStatus.defaultLanguage : 'en';
    const res = await fetch('/api/stt?lang=' + encodeURIComponent(lang), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: pcm });
    if (res.status === 202) {
      // Model still downloading: start the status poll so Settings shows progress, and notice the user at most
      // once every 30 s so the continuous hands-free loop can't spam toasts. Keep listening — a retry works once ready.
      const d = await sttDownloadingInfo(res);
      if (Date.now() - hfDlToastAt > 30000) { hfDlToastAt = Date.now(); showToast(sttDownloadingMessage(d), 'info'); }
      HF.busy = false; return;
    }
    if (!res.ok) throw new Error('stt ' + res.status);
    const data = await res.json().catch(() => ({}));
    const transcript = (data && typeof data.transcript === 'string') ? data.transcript.trim() : '';
    if (!HF.active) return;
    if (!transcript || msgInput.disabled) { HF.busy = false; return; }   // nothing recognized, or a turn started meanwhile
    handsfreeAwaitingAnswer = true;
    msgInput.value = transcript;
    sendMessage();   // reuses the whole answer path; the completion hook reads the answer back
  } catch (e) {
    HF.busy = false;   // transient failure — keep listening
  }
}

// Speak an answer back during hands-free — STREAMED so it starts fast — reusing the shared stop so a barge-in
// cleanly cuts it. No button; it plays automatically, then we resume listening. Non-English answers go through the
// same language-aware routing as the Read-aloud button, so hands-free is not limited to the English voice.
async function handsfreeSpeak(text, detectedLang) {
  if (!readAloudAvailable() || !text || !text.trim()) { HF.busy = false; HF.speaking = false; return; }
  const lang = resolveReadAloudLanguage(detectedLang);
  const mode = readAloudMode(lang);
  if (!mode) { HF.busy = false; HF.speaking = false; return; }
  stopReadAloud();
  HF.speaking = true; HF.speakStart = 0;   // 0 until audio actually plays, so a barge-in DURING the "thinking" wait still works
  if (mode === 'system') {
    const speechGen = ++handsfreeSpeechGen;
    let started = false;
    // A system engine that never starts must not leave hands-free stuck "speaking" forever; fall back to text.
    // The guard is invalidated by any Stop/new read, so a stale guard cannot cut off a later answer.
    const startGuard = setTimeout(() => {
      if (speechGen !== handsfreeSpeechGen || started || !HF.speaking) return;
      HF.speaking = false; HF.busy = false;
      stopReadAloud();
    }, SYSTEM_START_TIMEOUT_MS);
    const clearGuard = () => clearTimeout(startGuard);
    speakSystemText(text, lang, {
      onFirst: () => { started = true; clearGuard(); HF.speakStart = Date.now(); },
      onEnded: () => { clearGuard(); if (HF.speaking) { HF.speaking = false; HF.busy = false; } },
      onError: () => { clearGuard(); HF.speaking = false; HF.busy = false; },
    });
    return;
  }
  await streamReadAloud(text, {
    endpoint: '/api/tts',
    onFirst: () => { HF.speakStart = Date.now(); },   // playback started — begin the echo-onset barge-in guard window
    onEnded: () => { if (HF.speaking) { HF.speaking = false; HF.busy = false; } },   // resume listening when the answer finishes
    onError: () => { HF.speaking = false; HF.busy = false; },   // on failure, resume listening (the answer is on screen)
  });
}

// Called when a turn ends (input re-enabled). For a hands-free utterance that produced a normal answer, the
// read-back is triggered from applyPendingMeta; this is the fallback for an UNANSWERED turn (a refusal, web
// offer, or empty-workspace message) so hands-free never gets stuck waiting.
function handsfreeTurnEndFallback() {
  setTimeout(() => {
    if (HF.active && handsfreeAwaitingAnswer && !HF.speaking) { handsfreeAwaitingAnswer = false; HF.busy = false; }
  }, 1500);
}

if (handsfreeBtn) handsfreeBtn.addEventListener('click', () => { if (HF.active) stopHandsfree(); else startHandsfree(); });
// Reveal the hands-free button under the same condition as the mic button (STT on + recordable).
fetchSttStatus().then(applyHandsfreeVisibility);

// ── Per-answer overflow menu ("⋯ More") ──
// The secondary content actions (Copy, Download, "Why this answer?") live in one compact overflow menu.
// The menu is created lazily on first use and shared by every action on that answer. It follows the
// menu-button keyboard contract: the trigger opens it with the first item focused, Up/Down/Home/End move
// between items, Escape closes and returns focus to the trigger, and leaving the menu closes it. Colors
// and layout come from CSS; the guard classes (ans-*) are for idempotency only.
let _answerMenuSeq = 0;
function answerActionMenu(row) {
  if (!row) return null;
  const existing = row.querySelector('.answer-menu');
  if (existing) return existing._list;
  const wrap = document.createElement('span');
  wrap.className = 'answer-menu';
  const listId = `answer-menu-${++_answerMenuSeq}`;
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'answer-menu-btn';
  btn.title = 'More actions';
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', listId);
  btn.innerHTML = '&#8943; More';   // ⋯ More
  const list = document.createElement('span');
  list.className = 'answer-menu-list';
  list.id = listId;
  list.setAttribute('role', 'menu');
  list.setAttribute('aria-label', 'Answer actions');
  list.hidden = true;
  const items = () => [...list.querySelectorAll('.answer-menu-item')].filter((el) => el.offsetParent !== null);
  const close = (focusBtn = false) => {
    if (list.hidden) return;
    list.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (focusBtn) { try { btn.focus(); } catch { /* best-effort */ } }
  };
  const open = () => {
    closeAllAnswerMenus();
    list.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    // Answers sit just above the composer, so a menu opening downward can be clipped by it. Flip it up
    // when there isn't room below — measured against the COMPOSER's top (the real lower edge of the
    // message area, since the composer overlays the bottom of the viewport), falling back to the viewport.
    try {
      const r = btn.getBoundingClientRect();
      const composer = document.getElementById('input-area');
      const lowerBound = composer ? composer.getBoundingClientRect().top : window.innerHeight;
      wrap.classList.toggle('drop-up', (lowerBound - r.bottom) < (list.offsetHeight + 12));
    } catch { /* measurement best-effort; default (down) still works */ }
    const first = items()[0];
    if (first) { try { first.focus(); } catch { /* best-effort */ } }
  };
  wrap._close = close;
  wrap._btn = btn;
  wrap._list = list;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (list.hidden) open(); else close(true);
  });
  btn.addEventListener('keydown', (e) => {
    // Down/Enter/Space on the trigger opens and moves into the menu; Up is the common reverse entry.
    if ((e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') && list.hidden) {
      e.preventDefault(); open();
    } else if (e.key === 'ArrowUp' && list.hidden) {
      e.preventDefault(); open();
      const all = items(); if (all.length) all[all.length - 1].focus();
    }
  });
  wrap.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    // Tab moves focus out of the menu; close without stealing focus so the browser can advance it normally.
    if (e.key === 'Tab') { close(false); return; }
    const listItems = items();
    if (!listItems.length) return;
    const i = listItems.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); (listItems[i + 1] || listItems[0]).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (listItems[i - 1] || listItems[listItems.length - 1]).focus(); }
    else if (e.key === 'Home') { e.preventDefault(); listItems[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); listItems[listItems.length - 1].focus(); }
  });
  // Close on an outside click (the document listener below) or Escape/Tab. A focusout-based close is
  // deliberately NOT used: WebKit may blur to the body while a pointer press moves toward a menu item, which
  // hid the menu before its click could fire. Keyboard users still get a deterministic Tab close above.
  wrap.appendChild(btn); wrap.appendChild(list);
  row.appendChild(wrap);
  return list;
}
// Add one labeled action to an answer's overflow menu. `fn(btn)` runs on click; return true to KEEP the menu open
// (e.g. Copy, so its "Copied ✓" feedback stays visible), otherwise the menu closes and focus returns to its trigger.
// Idempotent per guard class.
function addAnswerMenuItem(row, guardCls, label, title, fn) {
  const list = answerActionMenu(row);
  if (!list || list.querySelector('.' + guardCls)) return null;
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'answer-menu-item ' + guardCls; b.textContent = label;
  if (title) b.title = title; b.setAttribute('role', 'menuitem');
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const keepOpen = fn(b) === true;
    if (!keepOpen) { const w = row.querySelector('.answer-menu'); if (w && w._close) w._close(true); }
  });
  list.appendChild(b);
  return b;
}
function closeAllAnswerMenus() {
  document.querySelectorAll('.answer-menu').forEach((w) => { if (w._close) w._close(); });
}
// Close any open answer menu on an outside click or Escape (registered once).
document.addEventListener('click', () => closeAllAnswerMenus());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllAnswerMenus(); });

function attachCopyButton(text, sources, targetRow) {
  const row = targetRow || lastAnswerRow();
  if (!row) return;
  const md = answerToMarkdown(text, sources);
  addAnswerMenuItem(row, 'ans-copy', 'Copy', 'Copy this answer (with its sources) as Markdown', (btn) => {
    copyTextToClipboard(md).then((ok) => {
      btn.textContent = ok ? 'Copied ✓' : 'Copy failed';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
    return true;   // keep the menu open so the copy feedback is visible
  });
}

// Save a finished answer (with its sources) as a FILE — a REAL Word .docx (built server-side from the answer's
// Markdown via /api/export/docx, so it opens cleanly in Word, Pages, Google Docs and LibreOffice) or Markdown
// (.md). The .docx MIME, extension, and base label come from the server (CLIENT_SETTINGS.export, single-sourced
// in lib/docx.js) so the Save-As name, the picker's type filter, and the server's Content-Type /
// Content-Disposition can never disagree.
const EXPORT_META = (typeof SETTINGS_META !== 'undefined' && SETTINGS_META && SETTINGS_META.export) || {};
const DOCX_MIME = EXPORT_META.docxMime || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOCX_EXT = EXPORT_META.docxExt || 'docx';
const ANSWER_BASE_LABEL = EXPORT_META.answerBaseLabel || 'Lokyni answer';
function exportBaseName() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${ANSWER_BASE_LABEL} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// Save generated content (an answer export, an extraction table, a log) to a file. Where the browser supports it
// we open a real "Save As" dialog so the user picks the location and name — the File System Access API, available
// in Chromium browsers and the Windows desktop webview. Everywhere else we fall back to a normal download: in the
// desktop app the shell intercepts it and shows a native save dialog (see src-tauri on_download); in a plain
// browser it goes to the Downloads folder, so we say so rather than leaving the user guessing where it went.
// Must be called from within a user gesture (the Save As dialog needs transient activation).
// `content` is either the bytes/string to save, OR an async producer `() => (string|ArrayBuffer|Blob)` that is
// only run once we have somewhere to put the file (e.g. a .docx fetched from the server). Producing lazily matters
// for the Save As path: showSaveFilePicker must be opened INSIDE the click gesture, before any await, so we open
// it first and fetch the bytes afterward.
async function triggerDownload(filename, mime, content) {
  const produce = (typeof content === 'function') ? content : async () => content;
  // 1) A true "Save As" dialog where the File System Access API exists — Chromium browsers and the Windows
  //    desktop webview. Opened in-gesture; the bytes are produced after the user picks the location.
  if (window.showSaveFilePicker) {
    let handle = null;
    try {
      const ext = (String(filename).split('.').pop() || '').toLowerCase();
      const opts = { suggestedName: filename };
      if (ext) { const accept = {}; accept[mime] = ['.' + ext]; opts.types = [{ description: ext.toUpperCase() + ' file', accept }]; }
      handle = await window.showSaveFilePicker(opts);
    } catch (e) {
      if (e && e.name === 'AbortError') return;   // the user cancelled the dialog — not an error, don't also download
      handle = null;                              // unsupported options / permission — fall through to a normal download
    }
    if (handle) {
      try {
        const data = await produce(mime);         // fetch/build the bytes now that we have a destination
        const writable = await handle.createWritable();
        await writable.write(new Blob([data], { type: mime }));
        await writable.close();
        return;
      } catch (e) { showToast('Could not save the file.', 'error'); return; }
    }
  }
  // 2) Fallback: a normal browser download. In the DESKTOP app the shell intercepts this and shows a native save
  //    panel (see src-tauri on_download), so the user still chooses the location — the same experience, just via
  //    the OS instead of the browser API. In a plain browser without the API (Firefox/Safari) it goes to the
  //    Downloads folder, so we say where it landed rather than leaving the user guessing.
  try {
    const data = await produce(mime);
    const url = URL.createObjectURL(new Blob([data], { type: mime }));
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 1000);   // revoke once the download has started
    if (!IS_DESKTOP_APP) showToast('Saved “' + filename + '” to your Downloads folder.', 'success');
  } catch { showToast('Could not create the download.', 'error'); }
}
function downloadAnswer(format, text, sources) {
  const md = answerToMarkdown(text, sources);
  const base = exportBaseName();
  if (format === 'md') { triggerDownload(base + '.md', 'text/markdown;charset=utf-8', md); return; }
  // Word: a REAL .docx built on the server (jszip + marked) — opens cleanly in Word, Pages, Google Docs and
  // LibreOffice, unlike the old HTML-with-a-.doc-extension. Fetched lazily so the Save As dialog opens first.
  triggerDownload(base + '.' + DOCX_EXT, DOCX_MIME, async () => {
    const res = await sendJSON('/api/export/docx', { markdown: md });
    if (!res.ok) throw new Error('export failed ' + res.status);
    return await res.arrayBuffer();
  });
}
function attachDownloadButton(text, sources, targetRow) {
  const row = targetRow || lastAnswerRow();
  if (!row) return;
  addAnswerMenuItem(row, 'ans-dl-word', 'Download as Word', 'Save this answer (with its sources) as a Word document (.docx)',
    () => { downloadAnswer('docx', text, sources); });
  addAnswerMenuItem(row, 'ans-dl-md', 'Download as Markdown', 'Save this answer (with its sources) as Markdown (.md)',
    () => { downloadAnswer('md', text, sources); });
  // Citation export is offered only when the answer actually cites something.
  if (Array.isArray(sources) && sources.length) {
    addAnswerMenuItem(row, 'ans-cite-export', 'Export citations…', 'Save this answer’s sources for a reference manager (BibTeX, RIS, or CSL-JSON)',
      () => { openCitationExport(sources); });
  }
}

// ── Citation interoperability (export an answer's sources, import references) ───────────────────────────────
// Both directions go through the shared server module (lib/citations.js), so a field mapping or escape rule is
// defined once. The client only collects the choice and shows the server's result.
const citeExportOverlay  = document.getElementById('cite-export-overlay');
const citeExportFormat   = document.getElementById('cite-export-format');
const citeExportNote     = document.getElementById('cite-export-note');
const citeImportOverlay  = document.getElementById('cite-import-overlay');
const citeImportFile     = document.getElementById('cite-import-file');
const citeImportText     = document.getElementById('cite-import-text');
const citeImportStatus   = document.getElementById('cite-import-status');
let _citeExportSources = [];

function openCitationExport(sources) {
  _citeExportSources = Array.isArray(sources) ? sources.slice(0, 60) : [];
  if (!_citeExportSources.length) { showToast('This answer has no sources to export.', 'warn'); return; }
  if (citeExportNote) citeExportNote.textContent = `${_citeExportSources.length} citation${_citeExportSources.length === 1 ? '' : 's'} will be saved.`;
  citeExportOverlay?.classList.remove('hidden');
  citeExportFormat?.focus();
}
function downloadCitations() {
  if (!_citeExportSources.length) return;
  const format = (citeExportFormat && citeExportFormat.value) || 'bibtex';
  // The option carries the extension and MIME from the server's single format list, so a new format needs no
  // matching branch here.
  const opt = citeExportFormat && ((citeExportFormat.selectedOptions && citeExportFormat.selectedOptions[0])
    || citeExportFormat.options[citeExportFormat.selectedIndex]);
  const ext = (opt && opt.dataset && opt.dataset.ext) || 'bib';
  const mime = (opt && opt.dataset && opt.dataset.mime) || 'application/x-bibtex';
  const sources = _citeExportSources;
  citeExportOverlay?.classList.add('hidden');
  triggerDownload(`Lokyni citations.${ext}`, mime, async () => {
    const res = await sendJSON('/api/documents/citations/export' + wsQuery(), { sources, format });
    if (!res.ok) throw new Error('export failed ' + res.status);
    return await res.text();
  });
}

function openCitationImport() {
  if (citeImportStatus) citeImportStatus.textContent = '';
  if (citeImportText) citeImportText.value = '';
  if (citeImportFile) { try { citeImportFile.value = ''; } catch { /* not resettable in some engines */ } }
  citeImportOverlay?.classList.remove('hidden');
  citeImportFile?.focus();
}
async function importCitations() {
  if (!citeImportOverlay) return;
  const typed = citeImportText ? citeImportText.value.trim() : '';
  let text = typed;
  if (!text && citeImportFile && citeImportFile.files && citeImportFile.files[0]) {
    const file = citeImportFile.files[0];
    try {
      // File.text() is widely supported, but the desktop shell and older WebViews may lag; FileReader is the
      // universal fallback, so reference import works in every supported browser and app package.
      text = String(typeof file.text === 'function'
        ? await file.text()
        : await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result || '');
            r.onerror = () => reject(r.error || new Error('read failed'));
            r.readAsText(file);
          })).slice(0, 5 * 1024 * 1024);
    } catch { if (citeImportStatus) citeImportStatus.textContent = 'That file could not be read.'; return; }
  }
  if (!text.trim()) {
    if (citeImportStatus) citeImportStatus.textContent = 'Choose a file or paste references first.';
    return;
  }
  const btn = document.getElementById('cite-import-go');
  if (btn) btn.disabled = true;
  if (citeImportStatus) citeImportStatus.textContent = 'Importing…';
  try {
    const res = await sendJSON('/api/documents/citations/import' + wsQuery(), { text, format: 'auto' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || 'Import failed');
    if (citeImportStatus) citeImportStatus.textContent = `Imported ${data.count} reference${data.count === 1 ? '' : 's'}.`;
    citeImportOverlay.classList.add('hidden');
    showToast(`Imported ${data.count} reference${data.count === 1 ? '' : 's'} into this workspace.`, 'success');
    loadDocuments();
  } catch (e) {
    if (citeImportStatus) citeImportStatus.textContent = e.message || 'Import failed.';
  } finally {
    if (btn) btn.disabled = false;
  }
}
document.getElementById('cite-export-cancel')?.addEventListener('click', () => { citeExportOverlay?.classList.add('hidden'); _citeExportSources = []; });
document.getElementById('cite-export-go')?.addEventListener('click', downloadCitations);
document.getElementById('cite-import-cancel')?.addEventListener('click', () => citeImportOverlay?.classList.add('hidden'));
document.getElementById('cite-import-go')?.addEventListener('click', importCitations);
document.getElementById('cite-import-btn')?.addEventListener('click', openCitationImport);
for (const id of ['cite-export-overlay', 'cite-import-overlay']) {
  const ov = document.getElementById(id);
  if (ov) ov.addEventListener('click', (e) => { if (e.target === ov) ov.classList.add('hidden'); });
}

function attachWhyButton(trace) {
  const row = lastAnswerRow();
  if (!row) return;
  addAnswerMenuItem(row, 'ans-why', 'Why this answer?', 'See how this answer was built', () => { showWhyPanel(trace); });
}

// ── Faithfulness badge (Verify toggle) ──
// The server emits 'faithfulness' after a verified answer. Attach a grounded/unverified
// badge to the last answer; click it to expand the claims the sources don't fully support.
const FAITH_META = {
  high:   { cls: 'faith-high',   label: '✓ Backed by sources' },
  medium: { cls: 'faith-medium', label: '◐ Mostly backed by sources' },
  low:    { cls: 'faith-low',    label: '⚠ Some claims unverified' },
};
// The server sends this just before chat_end, tagging the answered turn with a monotonic id. Record
// it so the chat_end handler can pin it to the answer's row; the late faithfulness/suggestion payloads
// carry the same id, which is how a result attaches to the correct turn even across repeated queries.
socket.on('answer_turn', (payload) => {
  const data = parsePayload(payload);
  if (data && data.turnId != null) pendingTurnId = data.turnId;
  // An independence summary computed server-side (one definition, bounded); attached to the sources row.
  pendingSourceStats = (data && data.sourceStats && typeof data.sourceStats === 'object') ? data.sourceStats : null;
  // The answer language is used only for Read aloud; an absent/unknown value keeps the configured default.
  const code = normalizeLanguageCode(data && data.language);
  if (code) pendingAnswerLang = code;
});
socket.on('faithfulness', (payload) => {
  let data; try { data = typeof payload === 'string' ? JSON.parse(payload) : payload; } catch { return; }
  const fr = (data && Array.isArray(data.claims)) ? data : null;
  if (!fr) return;
  // Verify is a fire-and-forget post-answer pass, so the result arrives AFTER chat_end. Attach it to
  // the row pinned at chat_end, ignoring a result for a DIFFERENT turn (matched on the server's turn
  // id, so two identical consecutive queries never cross-attach). If it somehow arrives before the row
  // is pinned, buffer it for applyPendingMeta.
  if (fr.turnId == null || fr.turnId !== faithTargetTurn) return;   // only this turn's result attaches
  if (faithTargetRow) { attachFaithfulnessBadge(fr, faithTargetRow); faithTargetTurn = null; }
  else pendingFaith = fr;
});
// Answer confidence — one holistic high/medium/low chip, arriving on its own fire-and-forget event after the
// turn (same pattern as Verify). The level's label and css class come from the server-projected vocabulary
// (SETTINGS_META.confidenceLevels), so the page never carries a second copy of either.
socket.on('answer_confidence', (payload) => {
  let data; try { data = typeof payload === 'string' ? JSON.parse(payload) : payload; } catch { return; }
  if (!data || !data.level) return;
  if (data.turnId == null || data.turnId !== confTargetTurn) return;   // only this turn's verdict attaches
  // Keep confTargetTurn set: a turn can emit TWICE — the fast chip, then a lower chip from the self-consistency
  // re-check. The second must still attach (update in place), so we do not clear the target after the first.
  if (confTargetRow) attachConfidenceChip(data, confTargetRow);
  else pendingConf = data;
});
function attachConfidenceChip(cr, row) {
  row = row || lastAnswerRow();
  if (!row || !cr || !cr.level) return;
  // Replace any existing chip/caveat so a later, lower verdict (the opt-in self-consistency re-check) UPDATES
  // the chip in place instead of being dropped — otherwise the whole point of the stability check is invisible.
  row.querySelectorAll('.answer-conf-chip, .answer-conf-caveat').forEach((el) => el.remove());
  const levels = (SETTINGS_META && SETTINGS_META.confidenceLevels) || {};
  const meta = levels[cr.level] || null;
  const label = meta ? meta.label : (cr.level.charAt(0).toUpperCase() + cr.level.slice(1) + ' confidence');
  const cls = meta ? meta.cls : confClass(cr.level);
  const chip = document.createElement('span');
  chip.className = `answer-conf-chip ${cls}`;
  chip.textContent = label;
  const reasons = Array.isArray(cr.reasons) ? cr.reasons.filter(Boolean) : [];
  if (reasons.length) {
    chip.title = reasons.join(' ');
    chip.setAttribute('aria-label', `${label}. ${reasons.join(' ')}`);
  } else {
    chip.setAttribute('aria-label', label);
  }
  appendAnswerAction(row, chip);
  // Thin-evidence abstention (opt-in): an honest caveat shown beneath the controls, without altering the
  // answer text itself.
  if (cr.abstain && cr.abstainReason) {
    const caveat = document.createElement('div');
    caveat.className = 'answer-conf-caveat';
    caveat.textContent = `⚠ ${cr.abstainReason}`;
    appendAnswerAction(row, caveat);
  }
}
function attachFaithfulnessBadge(fr, row) {
  row = row || lastAnswerRow();
  if (!row || row.querySelector('.faith-badge')) return;

  // Numbers the answer states that no cited source backs up — a deterministic check (not the model's
  // opinion), so it is shown plainly whether or not the claim judge also ran. Quotations get the same
  // deterministic treatment: a substantial quoted span that is absent from the served text is flagged.
  const ung = (fr.figures && Array.isArray(fr.figures.ungrounded)) ? fr.figures.ungrounded : [];
  const unq = (fr.quotes && Array.isArray(fr.quotes.ungrounded)) ? fr.quotes.ungrounded : [];
  const hasJudge = fr.overall != null;
  const plural = (n) => (n === 1 ? '' : 's');
  const flagParts = [];
  if (ung.length) flagParts.push(`${ung.length} figure${plural(ung.length)}`);
  if (unq.length) flagParts.push(`${unq.length} quotation${plural(unq.length)}`);

  // Badge tone and label. A clean verdict from a SELF-JUDGE (the answer model grading itself, no distinct
  // faithfulnessModel) gets a neutral "self-checked" badge, not a confident green "Grounded". And an
  // unverified FIGURE or QUOTATION always pulls the tone down to a warning — never call an answer "Grounded"
  // when it states a number or quotation the sources don't contain.
  let meta;
  if (!hasJudge) {
    meta = { cls: 'faith-low', label: `⚠ ${flagParts.join(' and ')} not in sources` };
  } else {
    meta = (fr.overall === 'high' && fr.selfJudged)
      ? { cls: 'faith-selfcheck', label: '✓ Self-checked' }
      : (FAITH_META[fr.overall] || FAITH_META.medium);
    if ((ung.length > 0 || unq.length > 0) && (meta.cls === 'faith-high' || meta.cls === 'faith-selfcheck')) {
      meta = { cls: 'faith-medium', label: '◐ Mostly backed by sources' };
    }
  }
  const c = fr.counts || {};
  const flagged = (fr.claims || []).filter(x => x.verdict !== 'supported');

  // A unique id links the badge to its panel so this disclosure exposes state to assistive tech,
  // consistent with the date-filter toggle and the folder twisty (WCAG 4.1.2).
  const panelId = 'faith-panel-' + Math.random().toString(36).slice(2, 9);
  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = `faith-badge ${meta.cls}`;
  let label = meta.label;
  if (hasJudge) label += ` · ${c.supported || 0}/${(fr.claims || []).length} supported`;
  if (hasJudge && flagParts.length) label += ` · ⚠ ${flagParts.join(' + ')}`;
  badge.textContent = label;
  badge.title = 'How well this answer is backed by its cited sources — including whether the numbers and quotations it states appear in them. Click for details.';
  badge.setAttribute('aria-controls', panelId);
  badge.setAttribute('aria-expanded', 'false');
  appendAnswerAction(row, badge);

  const panel = document.createElement('div');
  panel.id = panelId;
  panel.className = 'faith-panel hidden';
  const lines = [];
  // Ungrounded figures first — the most concrete signal.
  for (const f of ung) {
    lines.push(
      `<div class="faith-line faith-un">
         <span class="faith-tag">figure</span>
         <span>${escapeHtml(f.raw || '')} — not found in your sources</span>
       </div>`);
  }
  // Substantial quotations that no cited source contains.
  for (const q of unq) {
    lines.push(
      `<div class="faith-line faith-un">
         <span class="faith-tag">quote</span>
         <span>“${escapeHtml(q.raw || '')}” — not found in your sources</span>
       </div>`);
  }
  if (hasJudge && flagged.length > 0) {
    for (const x of flagged) {
      lines.push(
        `<div class="faith-line ${x.verdict === 'unsupported' ? 'faith-un' : 'faith-part'}">
           <span class="faith-tag">${x.verdict === 'unsupported' ? 'unsupported' : 'partial'}</span>
           <span>${escapeHtml(x.text)}</span>
         </div>`);
    }
  }
  if (lines.length === 0) {
    // Only reached when the judge ran clean AND no figure or quotation was flagged.
    lines.push(fr.selfJudged
      ? '<div class="faith-line faith-ok">The answer model checked its own output and flagged nothing unsupported, and every number and quotation it states appears in your sources. Set a <code>faithfulnessModel</code> for an independent check.</div>'
      : '<div class="faith-line faith-ok">Every checked claim is supported by the cited sources, and every number and quotation the answer states appears in them.</div>');
  }
  panel.innerHTML = lines.join('');
  appendAnswerAction(row, panel);
  badge.addEventListener('click', () => {
    const open = panel.classList.toggle('hidden') === false;
    badge.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
}

// ── Outcome-aware retrieval: rating buttons + similar-query note ──
// The server sends 'outcome_id' after an answer with the id to rate. Attach 👍/👎
// to the last answer. 'similar_query' fires before an answer when this question
// closely matches a past 👍-rated one.
socket.on('outcome_id', (payload) => {
  const data = parsePayload(payload, null);
  pendingOutcomeId = (data && data.messageId) ? data.messageId : null;   // attached at chat_end
});
socket.on('rating_saved', (payload) => {
  const data = parsePayload(payload, null);
  if (!data) return;
  const row = document.querySelector(`.rating-row[data-mid="${data.messageId}"]`);
  if (!row || data.ok === false) return;
  row.querySelectorAll('.rate-btn').forEach(b => b.classList.remove('active'));
  const btn = row.querySelector(`.rate-btn[data-rating="${data.rating}"]`);
  if (btn) btn.classList.add('active');
  // Visible confirmation so the click clearly did something.
  let ack = row.querySelector('.rating-ack');
  if (!ack) { ack = document.createElement('span'); ack.className = 'rating-ack'; row.appendChild(ack); }
  ack.innerHTML = `Thanks — noted <svg class="ico" aria-hidden="true"><use href="#${data.rating === 1 ? 'ic-thumb-up' : 'ic-thumb-down'}"/></svg>`;
});
socket.on('similar_query', (payload) => {
  const data = parsePayload(payload, null);
  if (!data) return;
  const note = document.createElement('div');
  note.className = 'similar-note';
  note.textContent = '↩ You asked something similar before and it worked well.';
  chatBox.appendChild(note);
  announce('You asked something similar before.');   // this note arrives after the answer, so announce it
  scrollToBottom();
});

// ── Suggested follow-up questions ──
// Arrive after the turn ends (a small post-answer LLM pass). Render as one-click chips
// under the answer they belong to; clicking one asks it. A result for a different turn (matched on
// the server's turn id) is ignored, so chips never land on the wrong answer.
socket.on('suggested_questions', (payload) => {
  const data = parsePayload(payload, null);
  if (!data || !Array.isArray(data.questions) || !data.questions.length) return;
  if (data.turnId == null || data.turnId !== suggestTargetTurn) return;   // only this turn's chips attach
  const row = suggestTargetRow;
  if (!row || !row.isConnected || row.querySelector('.suggest-row')) return;
  const wrap = document.createElement('div');
  wrap.className = 'suggest-row';
  const lbl = document.createElement('span');
  lbl.className = 'suggest-label';
  lbl.textContent = 'Ask next';
  wrap.appendChild(lbl);
  const questions = data.questions.map(q => String(q || '').trim()).filter(Boolean).slice(0, 3);
  if (!questions.length) return;
  questions.forEach((q) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'suggest-chip';
    chip.textContent = q;
    chip.title = q;
    chip.addEventListener('click', () => {
      if (msgInput.disabled) return;   // a turn is already in flight
      msgInput.value = q;
      sendMessage();
    });
    wrap.appendChild(chip);
  });
  row.appendChild(wrap);
  // These one-click follow-ups arrive after the "answer ready" announcement, so tell a screen-reader user
  // they appeared (and how many) — otherwise the new actionable controls are silent.
  announce(`${questions.length} follow-up question${questions.length === 1 ? '' : 's'} available.`);
  scrollToBottom();
});

function attachRatingButtons(messageId) {
  const row = lastAnswerRow();
  if (!row || row.querySelector('.rating-row')) return;
  const wrap = document.createElement('div');
  wrap.className = 'rating-row';
  wrap.dataset.mid = messageId;
  wrap.innerHTML =
    '<span class="rating-label">Was this helpful?</span>' +
    '<button type="button" class="rate-btn" data-rating="1" title="Helpful" aria-label="Helpful"><svg class="ico" aria-hidden="true"><use href="#ic-thumb-up"/></svg></button>' +
    '<button type="button" class="rate-btn" data-rating="-1" title="Not helpful" aria-label="Not helpful"><svg class="ico" aria-hidden="true"><use href="#ic-thumb-down"/></svg></button>';
  wrap.querySelectorAll('.rate-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const rating = parseInt(btn.dataset.rating, 10);
      socket.emit('rate_answer', JSON.stringify({ messageId, rating, workspaceId: currentWorkspaceId() || undefined }));
    });
  });
  appendAnswerAction(row, wrap);
  scrollToBottom();
}

function showWhyPanel(trace) {
  const overlay = document.getElementById('why-overlay');
  const body    = document.getElementById('why-body');
  if (!overlay || !body) return;
  body.innerHTML = '';

  const q = document.createElement('div');
  q.className = 'why-query';
  q.textContent = trace.query;
  body.appendChild(q);

  if (Array.isArray(trace.steps) && trace.steps.length) {
    const h = document.createElement('div');
    h.className = 'why-heading';
    h.textContent = 'What happened';
    body.appendChild(h);
    const ul = document.createElement('ul');
    ul.className = 'why-steps';
    for (const s of trace.steps) {
      const li = document.createElement('li');
      li.textContent = s.detail;
      ul.appendChild(li);
    }
    body.appendChild(ul);
  }

  const cands = trace.candidates || [];
  if (cands.length) {
    const h2 = document.createElement('div');
    h2.className = 'why-heading';
    h2.textContent = `Documents considered (${cands.length})`;
    body.appendChild(h2);

    const list = document.createElement('div');
    list.className = 'why-list';
    for (const c of cands) {
      const row = document.createElement('div');
      row.className = 'why-doc' + (c.used ? ' used' : '');
      const name = document.createElement('span');
      name.className = 'why-doc-name';
      name.textContent = c.name || '(unnamed)';
      const state = document.createElement('span');
      state.className = 'why-doc-state';
      // The score is shown because it's the actual reason, but the sentence
      // carries the meaning — a bare number explains nothing.
      state.textContent = c.used
        ? 'used'
        : (c.dropped || 'not used');
      const score = document.createElement('span');
      score.className = 'why-doc-score';
      score.textContent = typeof c.rerank === 'number' ? c.rerank.toFixed(2) : '';
      score.title = 'Relevance score — higher is a closer match to the question';
      row.appendChild(name); row.appendChild(state); row.appendChild(score);
      list.appendChild(row);
    }
    body.appendChild(list);
  }

  const foot = document.createElement('div');
  foot.className = 'why-foot';
  foot.textContent = `Retrieval took ${trace.elapsedMs} ms.`;
  body.appendChild(foot);

  overlay.classList.remove('hidden');
}

document.getElementById('why-close')?.addEventListener('click', () =>
  document.getElementById('why-overlay')?.classList.add('hidden'));
document.getElementById('why-overlay')?.addEventListener('click', (e) => {
  if (e.target.id === 'why-overlay') e.target.classList.add('hidden');
});

// ── Prompt templates: "/" composer picker (mirrors the "#" document picker) ──────
let templatesCache = [];
const slashPicker = document.getElementById('slash-picker');
if (slashPicker) { slashPicker.setAttribute('role', 'listbox'); slashPicker.setAttribute('aria-label', 'Matching prompt templates'); }
let slashActive = false, slashMatches = [], slashIndex = 0, slashTokenStart = -1;

function currentSlashToken() {
  // "/word" ending at the caret, at input start or after whitespace (so "http://" etc.
  // never triggers it).
  const pos = msgInput.selectionStart;
  const text = msgInput.value.slice(0, pos);
  const m = text.match(/(^|\s)\/([^\s/]*)$/);
  if (!m) return null;
  return { query: m[2], start: pos - m[2].length - 1 };
}
function closeSlashPicker() { slashActive = false; slashMatches = []; slashIndex = 0; slashTokenStart = -1; if (slashPicker) slashPicker.classList.add('hidden'); setComboState(null); }
function renderSlashPicker() {
  if (!slashPicker || slashMatches.length === 0) { closeSlashPicker(); return; }
  slashPicker.innerHTML = slashMatches.map((t, i) =>
    `<div class="hash-item${i === slashIndex ? ' active' : ''}" data-i="${i}" role="option" id="slash-opt-${i}" aria-selected="${i === slashIndex}">
       <span class="hash-icon">/</span><span class="hash-name">${escapeHtml(t.name)}</span>
     </div>`).join('');
  slashPicker.classList.remove('hidden');
  setComboState('slash-picker', `slash-opt-${slashIndex}`);
  slashPicker.querySelectorAll('.hash-item').forEach(el => {
    el.addEventListener('mousedown', (ev) => { ev.preventDefault(); pickSlash(Number(el.dataset.i)); });
  });
}
function updateSlashPicker() {
  const tok = currentSlashToken();
  if (!tok) { closeSlashPicker(); return; }
  const q = tok.query.toLowerCase();
  slashMatches = templatesCache.filter(t => t.name.toLowerCase().includes(q)).slice(0, 8);
  if (slashMatches.length === 0) { closeSlashPicker(); return; }
  slashActive = true; slashIndex = 0; slashTokenStart = tok.start;
  renderSlashPicker();
}
function pickSlash(i) {
  const tpl = slashMatches[i];
  if (!tpl) return;
  const now = new Date(); const pad = n => String(n).padStart(2, '0');
  const builtins = {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    // Workspace label from the header selector, minus its trailing "(count)".
    workspace: (document.getElementById('workspace-select')?.selectedOptions[0]?.textContent || '').replace(/\s*\(\d+\)\s*$/, '').trim(),
  };
  const body = tpl.body.replace(/\{([a-zA-Z][\w-]*)\}/g, (full, name) => {
    const k = name.toLowerCase();
    return (k in builtins) ? builtins[k] : full;   // leave user placeholders for typing over
  });
  const pos = msgInput.selectionStart;
  const before = msgInput.value.slice(0, slashTokenStart);
  const after  = msgInput.value.slice(pos);
  msgInput.value = before + body + after;
  closeSlashPicker();
  msgInput.focus();
  // Select the first {placeholder} so the user can type over it; else caret after body.
  const firstTok = body.match(/\{[a-zA-Z][\w-]*\}/);
  if (firstTok) { const s = before.length + firstTok.index; msgInput.setSelectionRange(s, s + firstTok[0].length); }
  else { const c = before.length + body.length; msgInput.setSelectionRange(c, c); }
  msgInput.dispatchEvent(new Event('input'));   // trigger auto-resize
}
msgInput.addEventListener('input', updateSlashPicker);
msgInput.addEventListener('keydown', (e) => {
  if (!slashActive) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); slashIndex = (slashIndex + 1) % slashMatches.length; renderSlashPicker(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); slashIndex = (slashIndex - 1 + slashMatches.length) % slashMatches.length; renderSlashPicker(); }
  else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); pickSlash(slashIndex); }
  else if (e.key === 'Escape') { e.preventDefault(); closeSlashPicker(); }
}, true);   // capture phase so Enter picks instead of sending
msgInput.addEventListener('blur', () => setTimeout(closeSlashPicker, 150));

// ── Prompt-template management (Settings) ────────────────────────────────────────
async function loadTemplates() {
  try {
    const data = await getJSON('/api/prompts');
    templatesCache = data.templates || [];
  } catch { templatesCache = []; }
  renderTemplateList();
}
function renderTemplateList() {
  const list = document.getElementById('template-list');
  if (!list) return;
  if (!templatesCache.length) { list.innerHTML = '<p class="settings-hint">No templates yet.</p>'; return; }
  list.innerHTML = '';
  for (const t of templatesCache) {
    const row = document.createElement('div');
    row.className = 'apikey-row';
    row.innerHTML = `
      <div class="apikey-info">
        <span class="apikey-name">${escapeHtml(t.name)}${t.builtin ? ' <span class="settings-hint">(built-in)</span>' : ''}</span>
        <span class="apikey-meta" style="white-space:normal;">${escapeHtml(t.body)}</span>
      </div>
      <div class="connector-actions"><button class="apikey-revoke" data-id="${t.id}">Delete</button></div>`;
    row.querySelector('.apikey-revoke').addEventListener('click', async () => {
      if (!(await showConfirm({ title: 'Delete template?', message: `"${t.name}"`, okLabel: 'Delete', danger: true }))) return;
      try { await fetch(`/api/prompts/${t.id}`, { method: 'DELETE' }); loadTemplates(); } catch {}
    });
    list.appendChild(row);
  }
}
document.getElementById('template-add-btn')?.addEventListener('click', async () => {
  const name = (document.getElementById('template-name')?.value || '').trim();
  const body = (document.getElementById('template-body')?.value || '').trim();
  if (!name || !body) { showToast('Enter a name and a body.', 'error'); return; }
  try {
    const res = await sendJSON('/api/prompts', { name, body });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    document.getElementById('template-name').value = '';
    document.getElementById('template-body').value = '';
    loadTemplates();
  } catch (e) { showToast('Could not add template: ' + e.message, 'error'); }
});
document.getElementById('template-restore-btn')?.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/prompts/restore-builtins', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    showToast(data.added ? `Restored ${data.added} built-in template${data.added === 1 ? '' : 's'}.` : 'All built-in templates are already present.', data.added ? 'success' : 'info');
    loadTemplates();
  } catch (e) { showToast('Could not restore templates: ' + e.message, 'error'); }
});

// ── Scheduled automations (Settings) ─────────────────────────────────────────────
// ONE source for the schedule presets: the cron string, the dropdown option text, and the short label shown on
// each saved row. The preset <select> and the row label map are both derived from this, so a cron string and its
// label can never drift apart (previously the select options and the label map were separate literals).
const SCHEDULE_PRESETS = [
  { cron: '0 8 * * *',  option: 'Every day, 8am',         short: 'Daily 8am' },
  { cron: '0 8 * * 1',  option: 'Every Monday, 8am',      short: 'Mon 8am' },
  { cron: '0 8 1 * *',  option: '1st of each month, 8am', short: 'Monthly 8am' },
  { cron: '0 * * * *',  option: 'Every hour',             short: 'Hourly' },
];
const SCHEDULE_LABELS = Object.fromEntries(SCHEDULE_PRESETS.map((p) => [p.cron, p.short]));
// Fill the preset dropdown from the single source. Idempotent (rebuilds the option list), so calling it whenever
// the automations panel loads is safe.
function populateSchedulePresets() {
  const sel = document.getElementById('automation-schedule-preset');
  if (!sel) return;
  sel.innerHTML = SCHEDULE_PRESETS.map((p) => `<option value="${p.cron}">${p.option}</option>`).join('')
    + '<option value="custom">Custom cron…</option>';
}
async function loadAutomations() {
  populateSchedulePresets();
  const list = document.getElementById('automation-list');
  try {
    const data = await getJSON('/api/automations');
    const warn = document.getElementById('automation-cron-warning');
    if (warn) warn.style.display = data.cronAvailable === false ? 'block' : 'none';
    renderAutomationList(data.automations || []);
  } catch { if (list) list.innerHTML = '<p class="settings-hint">Could not load automations.</p>'; }
}
function renderAutomationList(items) {
  const list = document.getElementById('automation-list');
  if (!list) return;
  if (!items.length) { list.innerHTML = '<p class="settings-hint">No automations yet.</p>'; return; }
  list.innerHTML = '';
  for (const a of items) {
    const last = fmtWhen(a.lastRun, 'never run');
    const status = a.lastResult ? (a.lastResult.ok ? (a.lastResult.delivered ? 'delivered' : (a.lastResult.note || 'ran')) : ('failed: ' + (a.lastResult.error || ''))) : '';
    const row = document.createElement('div');
    row.className = 'apikey-row';
    row.innerHTML = `
      <div class="apikey-info">
        <span class="apikey-name">${escapeHtml(a.name)}${a.enabled ? '' : ' <span class="settings-hint">(paused)</span>'}</span>
        <span class="apikey-meta" style="white-space:normal;">${a.kind === 'digest' ? 'Digest' : 'Query'} · ${escapeHtml(SCHEDULE_LABELS[a.schedule] || a.schedule)}${a.delivery && a.delivery.email ? ' · ✉ ' + escapeHtml(a.delivery.email) : ''} · ${last}${status ? ' · ' + escapeHtml(status) : ''}</span>
      </div>
      <div class="connector-actions">
        <button class="connector-test" data-act="run">Run now</button>
        <button class="connector-sync" data-act="toggle">${a.enabled ? 'Pause' : 'Resume'}</button>
        <button class="apikey-revoke" data-act="del">Remove</button>
      </div>`;
    row.querySelector('[data-act="run"]').addEventListener('click', async (e) => {
      const btn = e.target; btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Running…';
      try {
        const r = await (await fetch(`/api/automations/${a.id}/run`, { method: 'POST' })).json();
        if (r.ok) { showToast(r.delivered ? 'Ran — result delivered to your Inbox.' : `Ran — ${r.note || 'nothing delivered'}.`, 'success'); refreshInboxBadge(); }
        else showToast('Run failed: ' + (r.error || 'unknown'), 'error');
      } catch (err) { showToast('Run failed: ' + err.message, 'error'); }
      finally { btn.disabled = false; btn.textContent = orig; loadAutomations(); }
    });
    row.querySelector('[data-act="toggle"]').addEventListener('click', async () => {
      try { await sendJSON(`/api/automations/${a.id}`, { enabled: !a.enabled }, 'PATCH'); loadAutomations(); } catch {}
    });
    row.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (!(await showConfirm({ title: 'Remove automation?', message: `"${a.name}"`, okLabel: 'Remove', danger: true }))) return;
      try { await fetch(`/api/automations/${a.id}`, { method: 'DELETE' }); loadAutomations(); } catch {}
    });
    list.appendChild(row);
  }
}
document.getElementById('automation-schedule-preset')?.addEventListener('change', (e) => {
  const custom = document.getElementById('automation-schedule-custom');
  if (custom) custom.style.display = e.target.value === 'custom' ? '' : 'none';
});
document.getElementById('automation-kind')?.addEventListener('change', (e) => {
  const q = document.getElementById('automation-query');
  if (q && q.parentElement) q.parentElement.style.display = e.target.value === 'digest' ? 'none' : '';
});
document.getElementById('automation-add-btn')?.addEventListener('click', async () => {
  const kind = document.getElementById('automation-kind').value;
  const name = (document.getElementById('automation-name').value || '').trim();
  const query = (document.getElementById('automation-query').value || '').trim();
  const presetSel = document.getElementById('automation-schedule-preset').value;
  const schedule = presetSel === 'custom' ? (document.getElementById('automation-schedule-custom').value || '').trim() : presetSel;
  const email = (document.getElementById('automation-email').value || '').trim();
  if (kind === 'query' && !query) { showToast('Enter a question for the saved-question automation.', 'error'); return; }
  if (!schedule) { showToast('Choose or enter a schedule.', 'error'); return; }
  try {
    const res = await sendJSON('/api/automations', { kind, name, query, schedule, delivery: email ? { email } : {} });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    document.getElementById('automation-name').value = '';
    document.getElementById('automation-query').value = '';
    document.getElementById('automation-email').value = '';
    loadAutomations();
  } catch (e) { showToast('Could not add automation: ' + e.message, 'error'); }
});

// ── Quality evaluation (Settings) ─────────────────────────────────────────────────
// Populated from the server's metric catalog (/api/eval), so a new metric needs no matching list here.
let EVAL_METRICS = [];
let EVAL_COMPARE_PICK = { a: '', b: '' };
const pct = (v) => (typeof v === 'number' && !Number.isNaN(v)) ? Math.round(v * 100) + '%' : 'n/a';
const deltaLabel = (d, higherIsBetter = true) => {
  if (typeof d !== 'number' || Number.isNaN(d) || Math.abs(d) < 0.005) return '';
  // `higherIsBetter` comes from the server's metric catalog for A/B rows; the existing last-run deltas keep
  // the default because every current metric rewards an increase.
  const improved = higherIsBetter ? d > 0 : d < 0;
  const pts = (d > 0 ? '+' : '−') + Math.abs(Math.round(d * 100)) + ' pts';
  return `<span style="color:var(--${improved ? 'success' : 'error'});font-size:11px;"> ${pts}</span>`;
};

async function loadEval() {
  try {
    const data = await getJSON('/api/eval');
    if (Array.isArray(data.metrics) && data.metrics.length) EVAL_METRICS = data.metrics.map((m) => [m.key, m.label, m.higherIsBetter !== false]);
    renderEvalQuestions(data.questions || [], data.maxQuestions || 25);
    renderEvalResults(data.lastRun || null, data.pipeline || null);
    renderEvalTrend(data.history || []);
    renderEvalCompare(data.runs || []);
  } catch {
    const list = document.getElementById('eval-question-list');
    if (list) list.innerHTML = '<p class="settings-hint">Could not load the evaluation set.</p>';
  }
}
function renderEvalQuestions(items, max) {
  const list = document.getElementById('eval-question-list');
  if (!list) return;
  const addBtn = document.getElementById('eval-add-btn');
  if (addBtn) addBtn.disabled = items.length >= max;
  if (!items.length) { list.innerHTML = '<p class="settings-hint">No evaluation questions yet — add a few representative ones, or use “Suggest from my documents” to propose some.</p>'; return; }
  list.innerHTML = '';
  for (const q of items) {
    const row = document.createElement('div');
    row.className = 'apikey-row';
    row.innerHTML = `<div class="apikey-info"><span class="apikey-name" style="white-space:normal;">${escapeHtml(q.text)}</span></div>
      <div class="connector-actions"><button class="apikey-revoke" aria-label="Remove question">Remove</button></div>`;
    row.querySelector('button').addEventListener('click', async () => {
      // Confirm first — removing a question drops it from the saved evaluation set, and rebuilding a
      // representative set is tedious to redo. Routed through the shared themed confirm (reliable in the
      // desktop webview, unlike native confirm()).
      if (!(await showConfirm({ title: 'Remove question?', message: `"${q.text}"`, okLabel: 'Remove', danger: true }))) return;
      try { await fetch(`/api/eval/${encodeURIComponent(q.id)}`, { method: 'DELETE' }); loadEval(); } catch {}
    });
    list.appendChild(row);
  }
}
function renderEvalResults(run, currentPipeline) {
  const box = document.getElementById('eval-results');
  if (!box) return;
  if (!run || !run.averages) { box.innerHTML = ''; return; }
  const when = fmtWhen(run.at, '');
  const avg = run.averages || {}, delta = run.delta || {};
  // The pipeline version the run used, and whether it still matches this build. A mismatch means the numbers
  // are not directly comparable to a new run; say so instead of silently mixing them.
  const rp = run.pipeline || {};
  const cp = currentPipeline || {};
  const pipelineNote = !rp.answer ? ''
    : (cp.answer && rp.answer !== cp.answer)
      ? ` · recorded with answer pipeline v${escapeHtml(String(rp.answer))} (now v${escapeHtml(String(cp.answer))}) — run again to compare`
      : ` · answer pipeline v${escapeHtml(String(rp.answer))}`;
  const cards = EVAL_METRICS.map(([k, label, higher]) =>
    `<div class="eval-metric"><div class="eval-metric-val">${pct(avg[k])}${deltaLabel(delta[k], higher !== false)}</div><div class="eval-metric-label">${escapeHtml(label)}</div></div>`).join('');
  const rows = (run.questions || []).map((q) => {
    const m = q.metrics || {};
    const scores = EVAL_METRICS.map(([k, label]) => `${escapeHtml(label.split(' ')[0])} ${pct(m[k])}`).join(' · ');
    // Which cited sources supported no sentence — the actionable part of the attribution score.
    const ca = q.citationAttribution;
    const attrNote = (ca && ca.unused && ca.unused.length)
      ? ` <span class="settings-hint">(${ca.unused.length} citation${ca.unused.length === 1 ? '' : 's'} unused: ${escapeHtml(ca.unused.join(', '))})</span>`
      : '';
    const note = q.status ? ` <span class="settings-hint">(${escapeHtml(q.status)})</span>` : (q.outOfScope ? ' <span class="settings-hint">(declined — out of scope)</span>' : '');
    const head = `<span class="eval-qtext">${escapeHtml(q.text)}${note}</span><span class="eval-qscores">${scores}${attrNote}</span>`;
    // Drill-down: why this row scored what it did. Native <details> (keyboard-accessible, no JS), and every
    // list is already bounded server-side. A row with no detail stays a plain line.
    const d = q.detail || {};
    const bits = [];
    if (Array.isArray(d.claims) && d.claims.length) {
      bits.push('<div class="eval-detail-h">Not fully supported</div><ul>' +
        d.claims.map((c) => `<li><span class="eval-detail-tag">${c.verdict === 'unsupported' ? 'unsupported' : 'partial'}</span> ${escapeHtml(c.text)}</li>`).join('') + '</ul>');
    }
    if (Array.isArray(d.figures) && d.figures.length) {
      bits.push('<div class="eval-detail-h">Figures not in the sources</div><ul>' +
        d.figures.map((f) => `<li>${escapeHtml(f)}</li>`).join('') + '</ul>');
    }
    if (Array.isArray(d.quotes) && d.quotes.length) {
      bits.push('<div class="eval-detail-h">Quotations not in the sources</div><ul>' +
        d.quotes.map((x) => `<li>“${escapeHtml(x)}”</li>`).join('') + '</ul>');
    }
    if (Array.isArray(d.attribution) && d.attribution.length) {
      bits.push('<div class="eval-detail-h">Citations used</div><ul>' +
        d.attribution.map((s) => `<li>${escapeHtml(s.source)} — ${s.matched ? `${s.matched} sentence${s.matched === 1 ? '' : 's'}` : 'no sentence'}</li>`).join('') + '</ul>');
    }
    if (q.answerPreview) bits.push(`<div class="eval-detail-h">Answer preview</div><div class="eval-detail-preview">${escapeHtml(q.answerPreview)}</div>`);
    if (!bits.length) return `<div class="eval-qrow">${head}</div>`;
    return `<details class="eval-qrow eval-qdetail"><summary>${head}</summary><div class="eval-detail">${bits.join('')}</div></details>`;
  }).join('');
  box.innerHTML = `<div class="eval-summary"><div class="settings-hint">Last run: ${escapeHtml(when)} · ${run.questionCount || 0} question(s)${pipelineNote}</div>
    <div class="eval-metrics">${cards}</div></div><div class="eval-qlist">${rows}</div>`;
}
// The standing quality trend: a sparkline per metric across the recorded run history, so a model/setting
// change can be seen to help or hurt over time, not just since the last run. Built from the bounded
// eval-history log; needs at least two runs to draw a line. Pure SVG, no library.
function renderEvalTrend(history) {
  const box = document.getElementById('eval-trend');
  if (!box) return;
  const runs = (Array.isArray(history) ? history : []).filter(r => r && r.averages);
  if (runs.length < 2) { box.innerHTML = ''; return; }
  const n = runs.length - 1;
  const spark = (key) => {
    const pts = runs.map((r, i) => ({ x: i, v: typeof r.averages[key] === 'number' ? r.averages[key] : null })).filter(p => p.v != null);
    if (pts.length < 2) return '<div class="eval-spark-empty">—</div>';
    const W = 160, H = 30, pad = 3;
    const coords = pts.map(p => `${(pad + (p.x / n) * (W - 2 * pad)).toFixed(1)},${(H - pad - Math.max(0, Math.min(1, p.v)) * (H - 2 * pad)).toFixed(1)}`).join(' ');
    return `<svg class="eval-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${coords}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  };
  const latest = runs[runs.length - 1].averages;
  const items = EVAL_METRICS.map(([k, label]) =>
    `<div class="eval-trend-item"><div class="eval-trend-head"><span>${escapeHtml(label)}</span><span class="eval-trend-now">${pct(latest[k])}</span></div>${spark(k)}</div>`).join('');
  const d0 = new Date(runs[0].at), d1 = new Date(runs[runs.length - 1].at);
  const range = (!isNaN(d0.getTime()) && !isNaN(d1.getTime())) ? `${d0.toLocaleDateString()} – ${d1.toLocaleDateString()}` : '';
  box.innerHTML = `<div class="eval-trend-wrap"><div class="settings-hint">Trend over ${runs.length} runs${range ? ' · ' + escapeHtml(range) : ''}</div><div class="eval-trend-grid">${items}</div></div>`;
}

// ── A/B comparison of recorded runs ──
// The server owns the metric catalog, the setup labels, and the better/worse direction; this view only
// formats what it returns, so a new metric or setup field needs no matching list here.
const runOptionLabel = (run) => {
  const model = run.setup && run.setup.model ? ` · ${run.setup.model}` : '';
  return `${fmtWhen(run.at, '')} · ${run.questionCount || 0} q${model}`;
};

function renderEvalCompare(runs) {
  const box = document.getElementById('eval-compare');
  if (!box) return;
  const list = Array.isArray(runs) ? runs.filter((r) => r && r.id) : [];
  if (list.length < 2) {
    box.innerHTML = '<p class="settings-hint">Run the evaluation at least twice to compare two runs.</p>';
    return;
  }
  const ids = list.map((r) => r.id);
  if (!ids.includes(EVAL_COMPARE_PICK.a)) EVAL_COMPARE_PICK.a = ids[Math.min(1, ids.length - 1)];
  if (!ids.includes(EVAL_COMPARE_PICK.b)) EVAL_COMPARE_PICK.b = ids[0];
  const options = (selected) => list.map((r) =>
    `<option value="${escapeHtml(r.id)}"${r.id === selected ? ' selected' : ''}>${escapeHtml(runOptionLabel(r))}</option>`).join('');
  box.innerHTML = `<div class="eval-compare-wrap">
    <div class="settings-subhead">Compare runs</div>
    <p class="settings-hint">Pick two recorded runs to see which metrics moved. Small differences can be noise; open the question breakdown to see what drove them.</p>
    <div class="eval-compare-controls">
      <label>Run A <select id="eval-compare-a">${options(EVAL_COMPARE_PICK.a)}</select></label>
      <label>Run B <select id="eval-compare-b">${options(EVAL_COMPARE_PICK.b)}</select></label>
      <button id="eval-compare-btn" type="button">Compare</button>
    </div>
    <div id="eval-compare-out"></div>
  </div>`;
  const selA = box.querySelector('#eval-compare-a');
  const selB = box.querySelector('#eval-compare-b');
  selA?.addEventListener('change', () => { EVAL_COMPARE_PICK.a = selA.value; });
  selB?.addEventListener('change', () => { EVAL_COMPARE_PICK.b = selB.value; });
  box.querySelector('#eval-compare-btn')?.addEventListener('click', async () => {
    const a = selA?.value || '', b = selB?.value || '';
    const out = box.querySelector('#eval-compare-out');
    if (!out) return;
    if (!a || !b || a === b) { out.innerHTML = '<p class="settings-hint">Choose two different runs.</p>'; return; }
    out.innerHTML = '<p class="settings-hint">Comparing…</p>';
    try {
      const res = await fetch(`/api/eval/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not compare those runs.');
      renderEvalCompareResult(out, data);
    } catch (e) {
      out.innerHTML = `<p class="settings-hint">${escapeHtml(e.message)}</p>`;
    }
  });
}

function renderEvalCompareResult(out, data) {
  const line = (label, run) => {
    const model = run.setup && run.setup.model ? ` · ${run.setup.model}` : '';
    const emb = run.setup && run.setup.embeddingsModel ? ` · ${run.setup.embeddingsModel}` : '';
    return `${label}: ${fmtWhen(run.at, '')} · ${run.questionCount || 0} question(s)${model}${emb}`;
  };
  const changed = (data.setup || []).filter((s) => s.different);
  const changes = changed.length
    ? `<div class="settings-hint">Setup changes: ${changed.map((s) => `${escapeHtml(s.label)} ${escapeHtml(s.a)} → ${escapeHtml(s.b)}`).join('; ')}</div>`
    : '<div class="settings-hint">The recorded setup is the same for both runs.</div>';
  const pipelineNote = data.pipelineChanged
    ? '<div class="settings-hint">These runs used different answer or index pipelines, so part of the change may come from that rather than the setup.</div>'
    : '';
  const rows = (data.metrics || []).map((m) => `<tr>
      <th scope="row">${escapeHtml(m.label)}</th>
      <td class="eval-compare-num">${pct(m.a)}${m.winner === 'a' ? ' <span class="eval-compare-win">better</span>' : ''}</td>
      <td class="eval-compare-num">${pct(m.b)}${m.winner === 'b' ? ' <span class="eval-compare-win">better</span>' : ''}</td>
      <td class="eval-compare-num">${deltaLabel(m.delta, m.higherIsBetter !== false) || '—'}</td>
    </tr>`).join('');
  // Per-question scores read the same metric rows, looked up by key, so their labels and direction cannot
  // drift from the table above.
  const qrows = (data.questions || []).map((q) => {
    const scores = (data.metrics || []).map((m) => {
      const row = (q.metrics || []).find((x) => x.key === m.key);
      const short = m.label.split(' ')[0];
      if (!row || row.a == null || row.b == null) return `${escapeHtml(short)} n/a`;
      return `${escapeHtml(short)} ${pct(row.a)} → ${pct(row.b)}`;
    }).join(' · ');
    const availability = !q.a ? ' (only in B)' : (!q.b ? ' (only in A)' : '');
    const status = (q.b && q.b.status) ? ` (${q.b.status})` : ((q.a && q.a.status) ? ` (${q.a.status})` : '');
    return `<div class="eval-qrow"><span class="eval-qtext">${escapeHtml(q.text)}${escapeHtml(availability)}${escapeHtml(status)}</span><span class="eval-qscores">${scores}</span></div>`;
  }).join('');
  out.innerHTML = `<div class="eval-compare-summary">
      <div class="settings-hint">${escapeHtml(line('A', data.a))}</div>
      <div class="settings-hint">${escapeHtml(line('B', data.b))}</div>
      ${pipelineNote}${changes}
    </div>
    <div class="eval-compare-table-wrap"><table class="eval-compare-table" aria-label="Run comparison">
      <thead><tr><th scope="col">Metric</th><th scope="col">A</th><th scope="col">B</th><th scope="col">Change (B − A)</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <details class="eval-compare-questions"><summary>Question breakdown</summary><div class="eval-qlist">${qrows}</div></details>`;
}

document.getElementById('eval-add-btn')?.addEventListener('click', async () => {
  const input = document.getElementById('eval-question-input');
  const text = (input && input.value || '').trim();
  if (!text) { showToast('Enter a question to add.', 'error'); return; }
  try {
    const res = await sendJSON('/api/eval', { text });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    if (input) input.value = '';
    loadEval();
  } catch (e) { showToast('Could not add question: ' + e.message, 'error'); }
});
document.getElementById('eval-run-btn')?.addEventListener('click', async (e) => {
  const btn = e.target; const status = document.getElementById('eval-status');
  btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Running…';
  if (status) { status.style.display = ''; status.textContent = 'Evaluating — this runs your model once per question…'; }
  try {
    const res = await fetch('/api/eval/run', { method: 'POST' });
    const data = await res.json();
    if (data.status === 'ok') { if (Array.isArray(data.metrics) && data.metrics.length) EVAL_METRICS = data.metrics.map((m) => [m.key, m.label, m.higherIsBetter !== false]); renderEvalResults(data.run, data.run && data.run.pipeline); renderEvalTrend(data.history || []); if (data.run && data.run.id) EVAL_COMPARE_PICK.b = data.run.id; renderEvalCompare(data.runs || []); if (status) status.textContent = 'Done.'; }
    else if (data.status === 'no-questions') { if (status) status.textContent = 'Add at least one question first.'; }
    else if (data.status === 'warming') { if (status) status.textContent = 'The workspace is still preparing — try again shortly.'; }
    else if (data.status === 'empty') { if (status) status.textContent = 'This workspace has no documents to evaluate.'; }
    else if (status) status.textContent = 'Evaluation failed: ' + (data.error || data.status || 'unknown');
  } catch (err) { if (status) status.textContent = 'Evaluation failed: ' + err.message; }
  finally { btn.disabled = false; btn.textContent = orig; }
});
document.getElementById('eval-seed-btn')?.addEventListener('click', async (e) => {
  const btn = e.target; const status = document.getElementById('eval-status');
  btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Suggesting…';
  if (status) { status.style.display = ''; status.textContent = 'Reading your documents to propose questions…'; }
  try {
    const res = await fetch('/api/eval/seed', { method: 'POST' });
    const data = await res.json();
    if (data.status === 'ok') { loadEval(); if (status) status.textContent = (data.added && data.added.length) ? `Added ${data.added.length} question(s) — edit or remove any you don't want.` : 'No new questions to add.'; }
    else if (data.status === 'full') { if (status) status.textContent = 'The question set is already full.'; }
    else if (data.status === 'warming') { if (status) status.textContent = 'The workspace is still preparing — try again shortly.'; }
    else if (data.status === 'empty') { if (status) status.textContent = 'This workspace has no documents to draw questions from.'; }
    else if (status) status.textContent = 'Could not suggest questions: ' + (data.error || data.status || 'unknown');
  } catch (err) { if (status) status.textContent = 'Could not suggest questions: ' + err.message; }
  finally { btn.disabled = false; btn.textContent = orig; }
});

// ── Automation inbox ─────────────────────────────────────────────────────────────
const inboxOverlay = document.getElementById('inbox-overlay');
const inboxBadge   = document.getElementById('inbox-badge');
async function refreshInboxBadge() {
  try {
    const data = await getJSON('/api/automations/inbox');
    const n = data.unread || 0;
    if (inboxBadge) { if (n > 0) { inboxBadge.textContent = n; inboxBadge.classList.remove('hidden'); } else inboxBadge.classList.add('hidden'); }
    // Surface unread on the collapsed More button too, so it is visible without opening the menu.
    const moreBadge = document.getElementById('more-badge');
    if (moreBadge) moreBadge.classList.toggle('hidden', n === 0);
  } catch {}
}
async function loadInbox() {
  const list = document.getElementById('inbox-list');
  if (!list) return;
  try {
    const data = await getJSON('/api/automations/inbox');
    const items = data.items || [];
    if (!items.length) { list.innerHTML = '<p class="settings-hint" style="padding:16px;">No automation results yet. Add a scheduled automation in Settings → Automations.</p>'; return; }
    list.innerHTML = '';
    for (const it of items) {
      const el = document.createElement('div');
      el.className = 'inbox-item' + (it.read ? '' : ' unread');
      el.innerHTML = `
        <div class="inbox-item-head">
          <span class="inbox-item-title">${escapeHtml(it.title)}</span>
          <span class="inbox-item-meta">${escapeHtml(it.name)}${(() => { const w = fmtWhen(it.created); return w ? ' · ' + escapeHtml(w) : ''; })()}</span>
        </div>
        <div class="inbox-item-body">${escapeHtml(it.body)}</div>
        ${it.sources && it.sources.length ? `<div class="inbox-item-sources">Sources: ${it.sources.map(escapeHtml).join(', ')}</div>` : ''}`;
      list.appendChild(el);
      if (!it.read) fetch(`/api/automations/inbox/${it.id}/read`, { method: 'POST' }).catch(() => {});
    }
    setTimeout(refreshInboxBadge, 400);
  } catch { list.innerHTML = '<p class="settings-hint" style="padding:16px;">Could not load inbox.</p>'; }
}
document.getElementById('inbox-btn')?.addEventListener('click', () => { inboxOverlay?.classList.remove('hidden'); loadInbox(); });
document.getElementById('inbox-close')?.addEventListener('click', () => inboxOverlay?.classList.add('hidden'));
inboxOverlay?.addEventListener('click', (e) => { if (e.target.id === 'inbox-overlay') e.target.classList.add('hidden'); });
document.getElementById('inbox-clear')?.addEventListener('click', async () => {
  if (!(await showConfirm({ title: 'Clear all inbox items?', okLabel: 'Clear', danger: true }))) return;
  try { await fetch('/api/automations/inbox', { method: 'DELETE' }); loadInbox(); refreshInboxBadge(); } catch {}
});
socket.on('automation_result', refreshInboxBadge);

// ── Email (SMTP) settings ────────────────────────────────────────────────────────
async function loadSmtp() {
  try {
    const { smtp } = await getJSON('/api/smtp');
    if (!smtp) return;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('smtp-host', smtp.host || '');
    set('smtp-port', smtp.port || 587);
    set('smtp-user', smtp.user || '');
    set('smtp-from', smtp.from || '');
    const sec = document.getElementById('smtp-secure'); if (sec) sec.value = smtp.secure ? 'true' : 'false';
    // Password is never returned; show a placeholder when one is stored.
    const pass = document.getElementById('smtp-pass');
    if (pass) pass.placeholder = smtp.passSet ? '•••••••• (leave blank to keep)' : 'SMTP password';
  } catch {}
}
function readSmtpForm() {
  return {
    host: (document.getElementById('smtp-host').value || '').trim(),
    port: document.getElementById('smtp-port').value,
    secure: document.getElementById('smtp-secure').value,
    user: (document.getElementById('smtp-user').value || '').trim(),
    pass: document.getElementById('smtp-pass').value,   // blank = keep existing
    from: (document.getElementById('smtp-from').value || '').trim(),
  };
}
document.getElementById('smtp-save-btn')?.addEventListener('click', async (e) => {
  const btn = e.target; btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Saving…';
  try {
    const res = await sendJSON('/api/smtp', readSmtpForm());
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    document.getElementById('smtp-pass').value = '';   // clear so it's not re-sent
    loadSmtp();
    showToast('SMTP settings saved.', 'success');
  } catch (err) { showToast('Could not save SMTP: ' + err.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = orig; }
});
document.getElementById('smtp-test-btn')?.addEventListener('click', async (e) => {
  const btn = e.target; btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Testing…';
  const out = document.getElementById('smtp-test-result');
  const show = (msg, ok) => { if (out) { out.style.display = 'block'; out.textContent = msg; out.style.color = ok ? 'var(--success)' : 'var(--warn-text)'; } };
  try {
    const body = { ...readSmtpForm(), to: (document.getElementById('smtp-test-to').value || '').trim() };
    const res = await sendJSON('/api/smtp/test', body);
    const data = await res.json();
    if (data.ok) show(data.sent ? '✓ Connected and sent a test email — check that inbox.' : '✓ Connection and login OK. (Add a "Send test to" address to send a real email.)', true);
    else show('✕ ' + (data.error || 'test failed'), false);
  } catch (err) { show('✕ ' + err.message, false); }
  finally { btn.disabled = false; btn.textContent = orig; }
});

// ── Accessible modal dialogs ─────────────────────────────────────────────────
// The modal overlays are shown/hidden by toggling the `.hidden` class from many places. Rather
// than change every call site, this observes each overlay's class and, when it becomes visible,
// marks it a dialog, moves keyboard focus inside, and traps Tab; when it hides, focus returns to
// whatever opened it. That gives keyboard and screen-reader users proper dialog behavior. The
// existing Escape-to-close and click-outside handlers still work — hiding the overlay simply
// triggers the "closed" path here. The first-run overlay is included too: it sets its own
// initial focus, but the shared handler adds the Tab trap and focus return it otherwise lacked.
// Associate every settings row's <label> with its control, so a screen reader announces a name for
// each field (the checkboxes were otherwise fully unnamed). The Settings modal is JS-driven and each
// control already carries a stable id, so linking them here — rather than hand-maintaining dozens of
// `for=` attributes — covers every current and future row and cannot drift. A row with only a button
// is skipped (the button's own text is its name).
(function associateSettingsLabels() {
  for (const row of document.querySelectorAll('.settings-row, .settings-row-full')) {
    const label = row.querySelector(':scope > label');
    if (!label || label.htmlFor) continue;
    const control = row.querySelector('input:not([type="hidden"]), select, textarea');
    if (control && control.id) label.htmlFor = control.id;
  }
})();

// Tag every fill-input settings row (text/number/select/secret field/stack) with a class, so the
// two-column and mobile-stacked layouts apply on browsers without CSS :has() (e.g. Firefox < 121). The
// CSS carries both the class and the :has() selector; this makes the class true without hand-maintaining
// it on dozens of template rows, and cannot drift. Checkbox rows are deliberately left untagged — they
// keep the default inline layout with the box pinned right.
(function tagSettingsInputRows() {
  for (const row of document.querySelectorAll('.settings-row')) {
    if (row.querySelector(':scope > input:not([type="checkbox"]), :scope > select, :scope > .settings-input-stack, :scope > .secret-field')) {
      row.classList.add('settings-row-input');
      // A stacked row (label above a vertical input stack) also needs the top-aligned label — tag it so the
      // :has()-free fallback (.settings-row-stacked in app.css) applies on browsers without :has() too.
      if (row.querySelector(':scope > .settings-input-stack')) row.classList.add('settings-row-stacked');
    } else if (row.querySelector(':scope > input[type="checkbox"]')) {
      // Checkbox rows: let the (hint-bearing) label grow and wrap so the box never gets pushed off the row.
      row.classList.add('settings-row-check');
    }
  }
})();

// Expose heading semantics on the static dialogs' titles and section dividers. They are styled <div>/<span>
// (so changing the tag would risk the layout), so apply role="heading" with a level here instead: a screen
// reader can then navigate the long Settings form by heading (the H key) rather than only by the dialog's
// own name. Zero visual change. The dynamic confirm/prompt dialogs already use real <h3> elements.
(function markModalHeadings() {
  for (const el of document.querySelectorAll('.modal-title')) {
    el.setAttribute('role', 'heading');
    el.setAttribute('aria-level', '2');
  }
  for (const el of document.querySelectorAll('.settings-section')) {
    el.setAttribute('role', 'heading');
    el.setAttribute('aria-level', '3');
  }
})();

(function setupModalA11y() {
  const OVERLAY_IDS = ['settings-overlay', 'new-confirm-overlay', 'logs-overlay', 'inbox-overlay', 'why-overlay', 'picker-overlay', 'source-overlay', 'firstrun-overlay', 'help-overlay', 'extract-overlay', 'notes-overlay', 'mindmap-overlay', 'readas-overlay', 'cite-export-overlay', 'cite-import-overlay'];
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  // A STACK of open overlays, not a single one: the folder picker opens from the Browse button
  // INSIDE the Settings modal, so dialogs nest. Tracking only one overlay meant closing the
  // nested picker removed the shared Tab trap (leaving Settings untrapped) and, when Settings
  // later closed, skipped focus return. The stack traps within the topmost overlay and restores
  // focus to each dialog's own opener as it closes.
  const stack = [];   // [{ overlay, lastFocused }], last entry = topmost
  const topOverlay = () => (stack.length ? stack[stack.length - 1].overlay : null);
  const focusablesIn = (el) => [...el.querySelectorAll(FOCUSABLE)].filter(n => n.offsetParent !== null);

  const onKeydown = (e) => {
    const active = topOverlay();
    if (e.key !== 'Tab' || !active) return;
    const items = focusablesIn(active);
    if (items.length === 0) { e.preventDefault(); active.focus(); return; }
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  const openDialog = (overlay) => {
    if (stack.some(s => s.overlay === overlay)) return;   // already tracked (defensive)
    if (stack.length === 0) document.addEventListener('keydown', onKeydown, true);
    stack.push({ overlay, lastFocused: document.activeElement });
    modalInertPush();   // inert the page background behind this overlay (balanced in closeDialog)
    const items = focusablesIn(overlay);
    try { (items[0] || overlay).focus(); } catch { /* focus is best-effort */ }
  };
  const closeDialog = (overlay) => {
    const idx = stack.findIndex(s => s.overlay === overlay);
    if (idx === -1) return;
    const [entry] = stack.splice(idx, 1);
    modalInertPop();
    if (stack.length === 0) document.removeEventListener('keydown', onKeydown, true);
    // Return focus to whatever opened THIS dialog — for a nested dialog that is the trigger inside
    // the parent, so the parent keeps its trap (still on the stack) and its focus context.
    try { if (entry.lastFocused && entry.lastFocused.focus) entry.lastFocused.focus(); } catch { /* best-effort */ }
  };

  for (const id of OVERLAY_IDS) {
    const overlay = document.getElementById(id);
    if (!overlay) continue;
    if (!overlay.getAttribute('role')) overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('tabindex', '-1');   // focusable as a fallback when it has no controls
    let hidden = overlay.classList.contains('hidden');
    new MutationObserver(() => {
      const nowHidden = overlay.classList.contains('hidden');
      if (nowHidden === hidden) return;
      hidden = nowHidden;
      if (nowHidden) closeDialog(overlay); else openDialog(overlay);
    }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
  }
})();

// ── First-run / connection setup ─────────────────────────────────────────────
// When no model provider is reachable, guide the user straight to connecting one instead of
// leaving them at a chat box that cannot answer. This also serves as a recovery prompt if the
// model later goes offline. Everything here is best-effort and never blocks the rest of the UI.
(function firstRunSetup() {
  const overlay = document.getElementById('firstrun-overlay');
  if (!overlay) return;
  const providerSel = document.getElementById('fr-provider');
  const statusEl    = document.getElementById('fr-status');
  const connectBtn  = document.getElementById('fr-connect');
  const skipBtn     = document.getElementById('fr-skip');
  const ollamaHost  = document.getElementById('fr-ollama-host');
  const ollamaModel = document.getElementById('fr-ollama-model');
  const openaiKey   = document.getElementById('fr-openai-key');
  const openaiModel = document.getElementById('fr-openai-model');
  const anthropicKey   = document.getElementById('fr-anthropic-key');
  const anthropicModel = document.getElementById('fr-anthropic-model');

  const wasSkipped = () => { try { return sessionStorage.getItem('firstrun_skipped') === '1'; } catch (e) { return false; } };
  const markSkipped = () => { try { sessionStorage.setItem('firstrun_skipped', '1'); } catch (e) { /* storage unavailable */ } };

  const hintEl = document.getElementById('fr-provider-hint');
  const syncRows = () => {
    const prov = providerSel.value;
    document.querySelectorAll('.fr-ollama-row').forEach((el) => el.classList.toggle('hidden', prov !== 'ollama'));
    document.querySelectorAll('.fr-openai-row').forEach((el) => el.classList.toggle('hidden', prov !== 'openai'));
    document.querySelectorAll('.fr-anthropic-row').forEach((el) => el.classList.toggle('hidden', prov !== 'anthropic'));
    if (hintEl) {
      const hints = {
        ollama: 'Runs privately on this computer — nothing leaves the machine. Needs enough memory (a GPU helps). If you do not have it yet, install it from ollama.com, then enter its address above.',
        openai: 'Works on any computer, with no local AI hardware needed. Requires an OpenAI API key, and your questions are sent to OpenAI to be answered.',
        anthropic: 'Works on any computer, with no local AI hardware needed. Requires an Anthropic API key, and your questions are sent to Anthropic (Claude) to be answered. Claude has no embeddings, so your documents are embedded locally with Ollama — install it from ollama.com for private, free embeddings.',
      };
      hintEl.textContent = hints[prov] || hints.ollama;
    }
  };
  providerSel.addEventListener('change', syncRows);
  skipBtn.addEventListener('click', () => { markSkipped(); overlay.classList.add('hidden'); });

  // A sensible default chat model per provider, so a brand-new user can connect in ONE click without having
  // to know a model name (the hardest part of setup). Matches the field placeholders; only ever fills an empty
  // field, and the user can change it before connecting. Embeddings keep their own built-in default (bge-m3 on
  // Ollama), so a blank embeddings setting still works.
  // One source for the per-provider defaults: the server's settings schema projection.
  const DEFAULT_MODELS = PROVIDER_MODEL_DEFAULTS;

  // The model fields become the same dropdown-with-Custom picker Settings uses, so a new user can PICK an
  // installed model instead of having to know its exact name (the hardest part of setup). These pickers refresh
  // from the first-run overlay's OWN provider/host fields (not Settings'), hence their own registry. For a local
  // Ollama the list is its installed models; for a hosted provider with no key entered yet the list is empty and
  // the field stays a plain text box with the sensible default — so connecting in one click still works.
  const _frPickers = [];
  const frModelInput = () => ({ ollama: ollamaModel, openai: openaiModel, anthropic: anthropicModel }[providerSel.value]);
  let _frPickerSeq = 0;
  const refreshFrPickers = async () => {
    const input = frModelInput();
    const picker = _frPickers.find((p) => p.input === input);
    if (!picker) return;
    const provider = providerSel.value;
    const host = provider === 'ollama' ? (ollamaHost.value || '') : '';
    const seq = ++_frPickerSeq;
    const models = await fetchModelList(provider, host, '', 'chat');
    if (seq !== _frPickerSeq) return;   // a newer refresh started — don't repaint from a stale response
    renderModelPicker(picker, models);
  };

  const prefill = async () => {
    try {
      const cfg = await getJSON('/api/config');
      providerSel.value = (cfg.provider === 'openai' || cfg.provider === 'anthropic') ? cfg.provider : 'ollama';
      if (cfg.ollamaHost) ollamaHost.value = cfg.ollamaHost;
      if (cfg.model) { ollamaModel.value = cfg.model; openaiModel.value = cfg.model; if (anthropicModel) anthropicModel.value = cfg.model; }
    } catch (e) { /* fall back to placeholders */ }
    if (!ollamaModel.value.trim()) ollamaModel.value = DEFAULT_MODELS.ollama;
    if (!openaiModel.value.trim()) openaiModel.value = DEFAULT_MODELS.openai;
    if (anthropicModel && !anthropicModel.value.trim()) anthropicModel.value = DEFAULT_MODELS.anthropic;
    // Attach the pickers once (idempotent), then list the active provider's models.
    attachModelPicker(ollamaModel, '(choose a model)', 'chat', _frPickers);
    attachModelPicker(openaiModel, '(choose a model)', 'chat', _frPickers);
    if (anthropicModel) attachModelPicker(anthropicModel, '(choose a model)', 'chat', _frPickers);
    syncRows();
    refreshFrPickers();
  };

  // Re-list when the provider changes or the Ollama host is edited (debounced), so the picker always reflects
  // what the chosen endpoint actually offers — the same behavior as the Settings model pickers.
  providerSel.addEventListener('change', refreshFrPickers);
  let _frHostTimer = null;
  ollamaHost.addEventListener('input', () => { clearTimeout(_frHostTimer); _frHostTimer = setTimeout(refreshFrPickers, 400); });

  const doConnect = async () => {
    const provider = providerSel.value;
    const payload = { provider };
    if (provider === 'ollama') {
      if (ollamaHost.value.trim())  payload.ollamaHost = ollamaHost.value.trim();
      if (ollamaModel.value.trim()) payload.model = ollamaModel.value.trim();
    } else if (provider === 'anthropic') {
      if (anthropicKey && anthropicKey.value)          payload.anthropicApiKey = anthropicKey.value;
      if (anthropicModel && anthropicModel.value.trim()) payload.model = anthropicModel.value.trim();
    } else {
      if (openaiKey.value)          payload.openaiApiKey = openaiKey.value;
      if (openaiModel.value.trim()) payload.model = openaiModel.value.trim();
    }
    connectBtn.disabled = true;
    statusEl.style.color = '';
    statusEl.textContent = 'Saving and testing the connection…';
    try {
      const save = await sendJSON('/api/config', payload);
      if (!save.ok) {
        const err = await save.json().catch(() => ({}));
        throw new Error(err.error || 'Could not save the settings');
      }
      const health = await getJSON('/api/health');
      const prov = health && health.provider;
      if (prov && prov.reachable) {
        statusEl.style.color = 'var(--success)';
        statusEl.textContent = '✓ Connected. Loading…';
        setTimeout(() => location.reload(), 700);
      } else {
        const detail = prov && prov.detail ? ` (${prov.detail})` : '';
        statusEl.style.color = 'var(--error)';
        statusEl.textContent = `✗ Saved, but the model is still not reachable${detail}. Check the host or key and try again.`;
        connectBtn.disabled = false;
      }
    } catch (e) {
      statusEl.style.color = 'var(--error)';
      statusEl.textContent = '✗ ' + (e.message || 'Connection failed');
      connectBtn.disabled = false;
    }
  };
  connectBtn.addEventListener('click', doConnect);
  // Enter in any field connects, so keyboard users don't have to Tab to the button.
  [ollamaHost, ollamaModel, openaiKey, openaiModel, anthropicKey, anthropicModel].forEach((el) => {
    if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doConnect(); } });
  });
  // Escape dismisses the overlay (via the shared handler); record the skip so it matches the
  // Skip button and does not re-show on a transient basis this session.
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') markSkipped(); });

  const showOverlay = () => {
    overlay.classList.remove('hidden');
    try { providerSel.focus(); } catch (e) { /* focus is best-effort */ }
  };

  // Show automatically only when the provider is unreachable and the user has not skipped
  // this session. A health-check failure stays silent so it can never block the app.
  (async () => {
    if (wasSkipped()) return;
    try {
      const health = await getJSON('/api/health');
      if (health && health.provider && health.provider.reachable === false) {
        await prefill();
        showOverlay();
      }
    } catch (e) { /* health unavailable — stay quiet */ }
  })();
})();

// Init: load templates so the "/" picker works immediately, and show any unread digests.
loadTemplates();
refreshInboxBadge();
