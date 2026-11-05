'use strict';
// Guards the Settings filter and the read-only health panel. The filter must use its own class (never the
// feature-visibility .hidden state), restore collapsibles, clear on Escape without closing the dialog, and use
// the server's one latest-watchdog-sweep endpoint. The health panel is read-only, admin-gated, bounded, and
// accessible. Static contracts only — no browser, model, or network. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

try {
  const chat = read('lib/public/js/chat.js');
  const ejs = read('lib/views/chat.ejs');
  const css = read('lib/public/css/app.css');
  const server = read('lib/server.js');
  const watchdog = read('lib/watchdog.js');

  // ── Markup ──
  ok(/id="settings-filter"/.test(ejs) && /aria-label="Filter settings"/.test(ejs),
    'Settings has a labelled filter input');
  ok(/id="settings-filter-count"[^>]*aria-live="polite"/.test(ejs),
    'the filter result count is announced through a live region');
  ok(/id="cfg-health-details"/.test(ejs) && /id="cfg-health-list"[^>]*role="list"/.test(ejs) &&
     /id="cfg-health-note"[^>]*aria-live="polite"/.test(ejs),
    'the health panel has a collapsible, a labelled list, and a live status line');

  // ── Client behavior ──
  ok(/function applySettingsFilter\(/.test(chat) && /settings-filtered/.test(chat),
    'the filter marks nonmatching blocks with its own class');
  ok(/settingsFilter\.addEventListener\('input', applySettingsFilter\)/.test(chat),
    'typing filters immediately');
  ok(/e\.key !== 'Escape'/.test(chat) && /e\.stopPropagation\(\)/.test(chat) && /resetSettingsFilter\(\)/.test(chat),
    'Escape clears the filter and keeps the Settings dialog open');
  ok(/if \(!String\(settingsFilter\.value \|\| ''\)\.trim\(\)\) return;/.test(chat),
    'Escape with an empty filter falls through so the shared handler can close Settings');
  ok(/settingsDetailsWasOpen/.test(chat) && /details\.open = settingsDetailsWasOpen\.get\(details\)/.test(chat),
    'clearing the filter restores each collapsible group\'s original open state');
  ok(/settingsFilterWasActive/.test(chat) && /if \(q && !settingsFilterWasActive\)/.test(chat),
    'the open-state snapshot is refreshed at the start of each filtering session');
  ok(/function loadSettingsHealth\(/.test(chat) && /getJSON\('\/api\/watchdog'\)/.test(chat),
    'the health panel loads the latest sweep from the shared status endpoint');
  ok(/settingsHealthDetails\.addEventListener\('toggle'/.test(chat),
    'the health panel refreshes when opened');
  const closeAt = chat.indexOf('function closeSettingsOverlay()');
  ok(closeAt !== -1 && /resetSettingsFilter\(\)/.test(chat.slice(closeAt, closeAt + 700)),
    'closing Settings clears the filter so it cannot reopen filtered');

  // ── Server: one latest-sweep source, admin-only and bounded ──
  ok(/app\.get\('\/api\/watchdog', authmw\.requireGlobalAdmin/.test(server),
    'the health route is admin-only');
  ok(/require\('\.\/watchdog'\)\.lastFindings\(\)/.test(server) && /slice\(0, 100\)/.test(server),
    'the route uses the watchdog\'s latest-sweep snapshot and bounds the response');
  ok(/module\.exports = \{ register, list, run, stop, lastFindings \}/.test(watchdog) &&
     /function lastFindings\(\)/.test(watchdog),
    'the watchdog exports one read-only lastFindings accessor');

  // ── CSS ──
  ok(/\.settings-row\.settings-filtered,/.test(css) && /\.health-list/.test(css),
    'the filter and health list have dedicated styles');
  ok(!/\.settings-filtered[^}]*!important/.test(css),
    'the filter class does not use !important (it must not fight feature-visibility state)');

  console.log(`\nALL SETTINGS-HEALTH UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ SETTINGS-HEALTH UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
