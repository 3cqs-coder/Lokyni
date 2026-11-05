'use strict';
// Source-guards the client-side reliability + compatibility hardening in lib/public/js/chat.js and the
// two small auth pages. These behaviors are DOM/socket-coupled, so — like client-markdown-xss.test.js —
// this asserts the protections are present in the shipped source, so a later edit that drops one is caught
// by `npm run test:unit`. Each guard below closes a concrete "stuck UI / phantom turn / silent failure /
// broken-on-a-browser" gap found in the frontend audit.
//
//   • Per-turn watchdog: a turn the server never ends (hung provider, uncaught server exception) must not
//     leave the composer disabled and the spinner spinning forever.
//   • message turn-guard: a stray/reordered chunk after chat_end must not spawn a phantom bubble.
//   • indexing_status parse-guard: a malformed socket payload must not throw out of the handler.
//   • CSRF: the XHR upload must refresh-and-retry on a 403 like every fetch() mutation; the streamed
//     backup must carry a warmed token; concurrent refreshes must coalesce.
//   • graph poll: closing Settings must stop the 1.5s build poll.
//   • iOS: the PDF viewer must expose a visible open/download link even in embed mode (blank-iframe escape),
//     and the clipboard fallback must select content the iOS way.
//   • esc(): the shared auth-page escaper must also escape the single quote (parity with chat.js).
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(PROJECT, ...p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  const chat = read('lib', 'public', 'js', 'chat.js');

  // ── Per-turn watchdog (HIGH: never-stuck) ──
  ok(/function armTurnWatchdog\(\)/.test(chat) && /function clearTurnWatchdog\(\)/.test(chat),
    'chat.js defines the per-turn watchdog (arm + clear)');
  ok(/armTurnWatchdog\(\);\s*\/\/ start the slow-turn notice/.test(chat),
    'the watchdog is armed when a turn starts (showThinking)');
  // Liveness pushes it forward from BOTH the token stream and the long-synthesis progress channel,
  // so a slow-but-live turn is never killed.
  ok((chat.match(/armTurnWatchdog\(\);/g) || []).length >= 3,
    'the watchdog is re-armed on liveness signals (token stream + synthesis progress)');
  ok(/function finalizeTurn\(\{[\s\S]{0,300}?clearTurnWatchdog\(\);/.test(chat),
    'the terminal-event finalizer stands the watchdog down');
  // The watchdog must never abandon a live turn: it used to resetStreaming() after two minutes of
  // silence, which cleared turnActive so every late token was dropped. It now only surfaces a notice.
  {
    const start = chat.indexOf('function armTurnWatchdog()');
    const end = chat.indexOf('// On (re)connect', start);
    const body = start === -1 ? '' : chat.slice(start, end === -1 ? undefined : end);
    ok(body && !/resetStreaming\(/.test(body) && !/appendError\(/.test(body) && !/setInputState\(/.test(body),
      'the silence watchdog keeps the turn live (no resetStreaming/appendError/setInputState) so late tokens still land');
  }
  ok(/function resetStreaming\(\)\s*\{\s*clearTurnWatchdog\(\);/.test(chat),
    'resetStreaming clears the watchdog (covers the error + disconnect paths)');

  // ── message turn-guard + defensive coercion ──
  ok(/socket\.on\('message',[\s\S]{0,800}?if \(!turnActive\) return;/.test(chat),
    'the message handler ignores a chunk that arrives after the turn ended (no phantom bubble)');
  ok(/messageBuffer \+= \(typeof data === 'string' \? data : String\(data \?\? ''\)\);/.test(chat),
    'the message buffer coerces a non-string emit instead of concatenating [object Object]');

  // ── indexing_status parse-guard ──
  ok(/socket\.on\('indexing_status', \(p\) => \{\s*const \{ indexing, ready, empty, documents, progress \} = parsePayload\(p\);/.test(chat),
    'indexing_status parses defensively via parsePayload (a malformed emit can only no-op)');

  // ── CSRF: upload 403 retry, backup token warm, refresh dedupe ──
  ok(/xhr\.status === 403 && !csrfRetried && \/csrf\/i\.test\(xhr\.responseText[\s\S]{0,160}?refreshCsrf\(\)\.then\(openAndSend\)/.test(chat),
    'the XHR upload refreshes-and-retries once on a CSRF 403, mirroring the fetch wrapper');
  ok(/backupDownBtn\?\.addEventListener\('click', async \(\)[\s\S]{0,700}?if \(!csrfToken\) await refreshCsrf\(\);/.test(chat),
    'the streamed backup warms the CSRF token before submitting the form');
  ok(/let _csrfRefresh = null;/.test(chat) && /if \(_csrfRefresh\) return _csrfRefresh;/.test(chat),
    'concurrent CSRF refreshes coalesce onto one in-flight probe');

  // ── graph-build poll is stopped when Settings closes ──
  ok(/function closeSettingsOverlay\(\)[\s\S]{0,220}?clearInterval\(graphStatusPoll\); graphStatusPoll = null;/.test(chat),
    'closing Settings clears the graph-build status poll');
  ok(!/settingsCancel\?\.addEventListener\('click', \(\) => settingsOverlay\.classList\.add\('hidden'\)\)/.test(chat),
    'the Settings close paths route through closeSettingsOverlay (not a bare hide that leaks the poll)');

  // ── iOS clipboard fallback selects content the iOS way ──
  ok(/ta\.contentEditable = 'true';/.test(chat) && /range\.selectNodeContents\(ta\);/.test(chat),
    'the clipboard fallback uses contentEditable + a Range so execCommand copy works on iOS');

  // ── iOS PDF: a visible open/download escape that survives embed mode ──
  const viewer = read('lib', 'views', 'document-viewer.ejs');
  ok(/viewer-pdf-actions[\s\S]{0,160}?href="<%= rawUrl %>" download="<%= fileName %>"/.test(viewer),
    'the PDF viewer renders a visible open/download link (iOS blank-iframe escape)');
  const css = read('lib', 'public', 'css', 'app.css');
  ok(/\.viewer-pdf-actions \{/.test(css) && !/\.viewer-body\.embed \.viewer-pdf-actions \{\s*display:\s*none/.test(css),
    'the PDF open/download link is not hidden by embed mode (unlike the toolbar)');

  // ── shared auth-page escaper covers the single quote (parity with chat.js) ──
  const authpage = read('lib', 'public', 'js', 'authpage.js');
  ok(/replace\(\/\[&<>"'\]\/g/.test(authpage) && /"'": '&#39;'/.test(authpage),
    'authpage.js esc() escapes the single quote too (safe in single-quoted attributes)');
  const admin = read('lib', 'views', 'admin-users.ejs');
  ok(!/data-id="' \+ u\.id \+ '"/.test(admin) && !/data-uid="' \+ m\.userId \+ '"/.test(admin),
    'admin-users.ejs routes user/member ids through esc() in attributes');

  // ── account.ejs must not scroll horizontally on a phone (parity with admin-users.ejs) ──
  // It is a standalone scrolling page, so it needs the body override that frees the centered wrapper from
  // app.css's fixed flex-column shell, and the session rows must be able to wrap/break a long user-agent
  // string — otherwise an unbreakable row forces the page wider than the viewport.
  const account = read('lib', 'views', 'account.ejs');
  ok(/body \{ display: block; height: auto; min-height: 100dvh; \}/.test(account),
    'account.ejs overrides the app shell body so the wrapper constrains to the viewport width');
  ok(/\.sess \{[^}]*flex-wrap: wrap/.test(account) && /\.sess span \{[^}]*overflow-wrap: anywhere/.test(account),
    'account.ejs session rows wrap and break long user-agent strings (no horizontal overflow)');

  // ── audit pass 2: the new modal hardening (chat.js + css) ──
  // Note delete uses the themed, reliable confirm — not native confirm() (unreliable in the desktop webview).
  ok(!/window\.confirm\(['"`]/.test(chat), 'no native window.confirm() calls remain (all destructive gates use showConfirm)');
  ok(/deleteNote[\s\S]{0,400}?await showConfirm\(\{ title: 'Delete this note\?'/.test(chat),
    'note delete routes through the themed showConfirm');
  // Escape must route the extract/notes/mindmap overlays through their real close (extract_cancel), not a bare hide.
  // Settings is included too: its close routine stops the graph-build status poll.
  const closeMap = chat.match(/CLOSE_BTN = \{([^}]*)\}/);
  ok(closeMap && ['extract-overlay', 'notes-overlay', 'mindmap-overlay', 'settings-overlay'].every(id => new RegExp(`'${id}'\\s*:`).test(closeMap[1])),
    'Escape routes the new overlays through their close buttons (so a running extraction is cancelled, not orphaned)');
  // CSV export neutralizes spreadsheet formula injection from untrusted cell text.
  ok(/if \(\/\^\[=\+\\-@\\t\\r\]\/\.test\(s\)\) s = "'" \+ s;/.test(chat),
    'CSV export prefixes formula-trigger cells (= + - @ / tab / CR) to prevent injection');
  // Mind-map load() never dereferences a malformed payload unguarded.
  ok(/const nodes = Array\.isArray\(data\.nodes\) \? data\.nodes : \[\];/.test(chat),
    'mind-map load() guards data.nodes/total against a malformed payload');
  // iOS zoom: the new modal inputs are in the coarse-pointer 16px rule.
  ok(/\.extract-col-input, #note-title, #note-body,\s*\n\s*\.help-search input, #date-from, #date-to \{ font-size: 16px; \}/.test(css),
    'the new modal inputs are in the iOS 16px no-zoom rule');
  // The doc-panel action row wraps on mobile (7 controls).
  ok(/\.doc-panel-actions \{[^}]*flex-wrap: wrap/.test(css), 'the doc-panel action row wraps (by panel width, at every viewport — the header is a column so controls never clip)');
  // The undefined --bg-soft token is gone; the real --surface2 is used.
  ok(!/--bg-soft/.test(css), 'the undefined --bg-soft token is no longer referenced (uses --surface2)');
  // Settings never scroll horizontally: a checkbox row's (hint-bearing) label grows + wraps instead of
  // pushing the box off the row, and the dialog clips any residual horizontal overflow.
  ok(/\.settings-row:has\(> input\[type="checkbox"\]\) > label[\s\S]{0,80}?flex: 1 1 auto; min-width: 0;/.test(css),
    'a checkbox settings-row label grows and wraps (box stays in view, no horizontal scroll)');
  ok(/\.settings-box \{[^}]*overflow: hidden/.test(css), 'the settings dialog clips horizontal overflow and keeps its footer visible');
  ok(/row\.classList\.add\('settings-row-check'\)/.test(chat), 'checkbox rows get the :has()-fallback class for Firefox < 121');
  // The three new overlays are proper dialogs.
  const ejs = read('lib', 'views', 'chat.ejs');
  ok((ejs.match(/role="dialog" aria-modal="true" aria-labelledby="(extract|notes|mindmap)-title"/g) || []).length === 3,
    'the extract/notes/mindmap overlays declare role="dialog" aria-modal');

  console.log(`\nALL FRONTEND-RELIABILITY-GUARD TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ FRONTEND-RELIABILITY-GUARD UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
