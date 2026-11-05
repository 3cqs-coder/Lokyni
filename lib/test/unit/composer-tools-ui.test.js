'use strict';
// Guards the unified header (the "⋯ More" overflow menu) and composer (the "Tools" menu with a
// removable-chip active-state strip). These collapse many secondary actions and answer modes into
// two accessible popovers so the interface stays uncluttered for non-technical users. The markup,
// the reusable popover wiring, and the styling must stay in sync: a regression that renames the
// menu ids, drops a mode row, or removes the popover/refresh logic then fails the build rather than
// shipping a broken or overwhelming UI. No model or network. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

try {
  const header = read('lib/views/partials/header.ejs');
  const chatEjs = read('lib/views/chat.ejs');
  const chatJs = read('lib/public/js/chat.js');
  const css = read('lib/public/css/app.css');

  // ── Header: the "⋯ More" overflow menu holds the secondary actions ──
  ok(/id="more-btn"[^>]*aria-haspopup="menu"[^>]*aria-controls="more-menu"/.test(header), 'the header has a More button controlling the More menu');
  ok(/id="more-menu"[^>]*role="menu"/.test(header), 'the More menu is a role=menu popover');
  for (const id of ['logs-btn', 'inbox-btn', 'help-btn']) {
    ok(new RegExp(`id="${id}"`).test(header), `the More menu still contains ${id}`);
  }
  // The primary actions stay out front, and Settings + the model badge remain in the bar.
  for (const id of ['workspace-select', 'docs-toggle', 'new-convo', 'settings-btn']) {
    ok(new RegExp(`id="${id}"`).test(header), `the header keeps ${id} visible`);
  }
  ok(/id="hdr-model"/.test(header), 'the (shrunk) model indicator remains in the header');

  // ── Composer: every answer mode collapses into the Tools panel ──
  // The Tools button is a disclosure for the options panel: aria-expanded + aria-controls, and NOT
  // aria-haspopup (the popup is a group of checkboxes, not a menu/listbox/dialog).
  ok(/id="tools-btn"[^>]*aria-expanded=[^>]*aria-controls="tools-menu"/.test(chatEjs), 'the Tools button is a disclosure for the Tools panel');
  ok(!/id="tools-btn"[^>]*aria-haspopup/.test(chatEjs), 'the Tools button does not claim aria-haspopup (its popup is a group, not a menu)');
  // The panel is a group of checkboxes plus a date sub-group — NOT a role=menu (a menu may only
  // contain menuitems, so the date inputs could not validly nest inside one).
  ok(/id="tools-menu"[^>]*role="group"/.test(chatEjs), 'the Tools panel is a role=group (not a menu)');
  ok(!/id="tools-menu"[^>]*role="menu"/.test(chatEjs), 'the Tools panel is not mislabeled as a menu');
  ok(/id="tools-badge"/.test(chatEjs), 'the Tools button has an active-count badge');
  ok(/id="tool-chips"/.test(chatEjs), 'the composer has the active-mode chip strip');
  // All seven mode toggles keep their original ids (so their existing handlers are unchanged) and
  // live inside the Tools panel as checkbox rows.
  const toolsMenu = chatEjs.slice(chatEjs.indexOf('id="tools-menu"'), chatEjs.indexOf('id="message-input"'));
  for (const id of ['web-search-toggle', 'research-toggle', 'why-toggle', 'verify-toggle', 'suggest-toggle', 'learn-toggle', 'date-filter-toggle']) {
    ok(new RegExp(`id="${id}"`).test(toolsMenu), `the Tools panel contains the ${id} row`);
  }
  ok(/id="date-filter-inputs"[^>]*role="group"/.test(toolsMenu), 'the date-range inputs are a group inside the Tools panel');
  // The old always-visible toggle row must be gone.
  ok(!/id="date-filter-row"/.test(chatEjs), 'the old always-visible date-filter row is removed');
  ok(/role="checkbox"/.test(toolsMenu) && !/role="menuitemcheckbox"/.test(toolsMenu), 'the mode rows are checkboxes (valid inside a group), not menuitemcheckbox');

  // ── One reusable, accessible popover drives both menus ──
  ok(/function wirePopover\(/.test(chatJs), 'the reusable wirePopover helper exists');
  ok(/wirePopover\(document\.getElementById\('more-btn'\)/.test(chatJs), 'the More menu is wired via wirePopover');
  ok(/wirePopover\(document\.getElementById\('tools-btn'\)/.test(chatJs), 'the Tools menu is wired via wirePopover');
  ok(/function refreshToolsIndicator\(/.test(chatJs), 'the tools indicator refresher exists');
  ok(/getElementById\('tool-chips'\)\?\.addEventListener/.test(chatJs), 'removing a chip is wired');
  // Web search is a plain STICKY toggle (like Explain/Verify): no hidden double-click/long-press "lock" and
  // no silent one-shot reset — the always-visible active-options chip shows it is on before every send and
  // turns it off in one click. Guard that the confusing tri-state is gone and the toggle is a simple flip.
  ok(!/webSearchLocked/.test(chatJs), 'the hidden web-search "locked" tri-state is gone (no webSearchLocked)');
  ok(!/_longPressed/.test(chatJs), 'the hidden long-press lock gesture is gone');
  ok(/webToggle\.addEventListener\('click', \(\) => \{ webSearchOn = !webSearchOn; updateWebToggleUI\(\); \}\)/.test(chatJs),
    'the web toggle is a plain sticky on/off flip routed through updateWebToggleUI');
  ok(/webToggle\.classList\.toggle\('active', webSearchOn\)[\s\S]*?refreshToolsIndicator\(\);/.test(chatJs),
    'updateWebToggleUI rebuilds the tools indicator, so every web-state change keeps the badge in sync');
  // Deep Research is the opposite of the sticky toggles: it is heavyweight (multi-step, multi-model), so it is
  // ONE-SHOT — armed for the next message, never persisted, and disarmed right after the message is sent.
  ok(!/lokyni_research/.test(chatJs), 'Deep Research is not persisted (no sticky localStorage key)');
  ok(/let deepResearchOn = false;/.test(chatJs), 'Deep Research starts off every session (not restored sticky)');
  ok(/if \(deepResearchOn\) \{ deepResearchOn = false; updateResearchToggleUI\(\); \}/.test(chatJs),
    'Deep Research disarms itself after a message is sent (one-shot, never silently repeats)');
  // Popover accessibility: closes on Escape and on outside click.
  ok(/e\.key !== 'Escape'/.test(chatJs) && /closeAllPopovers/.test(chatJs), 'popovers close on Escape and outside click');
  // The date handler must no longer overwrite the row markup with a bare string.
  ok(!/dateFilterToggle\.textContent =/.test(chatJs), 'the date row keeps its rich markup (no textContent rewrite)');

  // ── Styling is present for the new components ──
  for (const sel of ['.tools-menu', '.tool-row', '.tool-chip', '.tools-badge', '.hdr-menu', '.menu-row', '.hdr-model']) {
    ok(css.includes(sel), `app.css styles ${sel}`);
  }
  // Both menus become bottom sheets on narrow screens (thumb reach + room for descriptions).
  ok(/\.tools-menu, \.hdr-menu \{[\s\S]*position: fixed/.test(css), 'the menus render as bottom sheets on mobile');
  // The bottom sheet caps its height with dvh (with a vh fallback), so its top can't sit under the mobile
  // browser toolbar.
  ok(/max-height: 80vh; max-height: 80dvh;/.test(css), 'the mobile bottom sheet uses a dvh height cap with a vh fallback');

  // ── The popover keyboard nav does not hijack keys from a form field inside it ──
  // A date input in the Tools menu uses Up/Down to change its value; the roving-focus handler must bail
  // when focus is on an INPUT/SELECT/TEXTAREA, or native date entry breaks.
  ok(/t\.tagName === 'INPUT' \|\| t\.tagName === 'SELECT' \|\| t\.tagName === 'TEXTAREA'\)\) return;/.test(chatJs),
    'the popover arrow-key handler yields to a focused form field');

  // ── The "#" and "/" pickers expose combobox/listbox semantics to screen readers ──
  ok(/setAttribute\('role', 'combobox'\)/.test(chatJs) && /function setComboState\(pickerId, activeOptId\)/.test(chatJs),
    'the composer input is a combobox and its picker state is wired to ARIA');
  ok((chatJs.match(/setAttribute\('role', 'listbox'\)/g) || []).length >= 2, 'both pickers are listboxes');
  ok(/role="option" id="hash-opt-\$\{i\}" aria-selected=/.test(chatJs) && /role="option" id="slash-opt-\$\{i\}" aria-selected=/.test(chatJs),
    'each picker row is an option with a stable id and selected state (aria-activedescendant target)');

  // ── The composer gives the text field its own full-width row on a phone ──
  ok(/#input-form \{ max-width: 100%; flex-wrap: wrap; \}/.test(css) && /#message-input \{ flex-basis: 100%; order: -1; \}/.test(css),
    'the mobile composer wraps so the input is full-width instead of squeezed to a sliver');
  // The per-answer control buttons meet the 24px touch minimum on a phone.
  ok(/\.rate-btn, \.fig-btn, \.readaloud-btn, \.answer-menu-btn, \.answer-menu-item \{ min-height: 24px;/.test(css), 'the per-answer rating/figure/read-aloud buttons and the overflow menu meet the mobile touch-target minimum');

  console.log(`\nALL COMPOSER/HEADER UI UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ COMPOSER/HEADER UI UNIT TEST FAILED:', e.message);
  process.exit(1);
}
