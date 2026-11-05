'use strict';
// Guards the per-answer overflow menu ("⋯ More"): the secondary content actions (Copy, Download as Word,
// Download as Markdown, "Why this answer?") collapse into one compact menu so the action row stays uncluttered,
// while Read aloud and the rating/faithfulness controls stay inline. Also checks the menu closes on an outside
// click / Escape, that only one menu is open at a time, and that the old inline Download dropdown is gone.
// Source guards (no DOM). Run: `npm run test:unit`.

const path = require('path'), fs = require('fs'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(PROJECT, ...p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  const chat = read('lib', 'public', 'js', 'chat.js');
  // The shared menu + item helpers exist and are created lazily per answer row.
  ok(/function answerActionMenu\(row\)/.test(chat), 'there is a shared per-answer overflow menu');
  ok(/function addAnswerMenuItem\(row, guardCls, label, title, fn\)/.test(chat), 'items are added through one helper');
  ok(/list\.querySelector\('\.' \+ guardCls\)/.test(chat), 'each item is idempotent (guarded so re-attach never duplicates)');
  ok(/const keepOpen = fn\(b\) === true;/.test(chat), 'an item can keep the menu open (for the Copy feedback)');

  // Copy, both Download formats, and "Why this answer?" go INTO the menu (not inline on the row).
  ok(/addAnswerMenuItem\(row, 'ans-copy', 'Copy'/.test(chat), 'Copy is a menu item');
  ok(/addAnswerMenuItem\(row, 'ans-dl-word', 'Download as Word'/.test(chat) &&
     /downloadAnswer\('docx', text, sources\)/.test(chat), 'Download as Word is a menu item');
  ok(/addAnswerMenuItem\(row, 'ans-dl-md', 'Download as Markdown'/.test(chat) &&
     /downloadAnswer\('md', text, sources\)/.test(chat), 'Download as Markdown is a menu item');
  ok(/addAnswerMenuItem\(row, 'ans-why', 'Why this answer\?'/.test(chat), '"Why this answer?" is a menu item');
  // Copy keeps the menu open so its "Copied ✓" feedback is visible.
  ok(/return true;\s*\/\/ keep the menu open/.test(chat), 'Copy keeps the menu open for its feedback');

  // The old inline Download dropdown (.download-btn / .download-fmt / .download-menu) is gone.
  ok(!/class = 'download-btn'/.test(chat) && !/'download-fmt'/.test(chat),
    'the old inline Download dropdown was removed (folded into the overflow menu)');

  // Read aloud stays an inline pill (a primary action), not inside the menu.
  ok(/className = 'readaloud-btn'/.test(chat), 'Read aloud stays an inline control');

  // Only one menu open at a time, and it closes on an outside click / Escape.
  ok(/closeAllAnswerMenus\(\);\s*\n\s*list\.hidden = false;/.test(chat), 'opening a menu closes any other first');
  // The dropdown flips above the button when there isn't room below (the newest answer sits just above the
  // composer), measured against the composer's top so it is never clipped by it.
  ok(/getElementById\('input-area'\)/.test(chat) && /classList\.toggle\('drop-up'/.test(chat),
    'the menu flips up (vs the composer) when there is no room below');
  ok(/document\.addEventListener\('click', \(\) => closeAllAnswerMenus\(\)\)/.test(chat), 'an outside click closes the menu');
  ok(/if \(e\.key === 'Escape'\) closeAllAnswerMenus\(\)/.test(chat), 'Escape closes the menu');

  const css = read('lib', 'public', 'css', 'app.css');
  ok(/\.answer-menu-list \{[\s\S]*?position: absolute/.test(css), 'the menu is an anchored dropdown');
  ok(/\.answer-menu-list\[hidden\] \{ display: none; \}/.test(css), 'the dropdown is hidden until opened');
  ok(/\.answer-menu-item:hover \{ background: var\(--bg-elev\); color: var\(--accent\); \}/.test(css),
    'menu items use theme-aware hover colors (correct in dark/light/sepia)');
  ok(!/\.download-menu \{/.test(css), 'the dead .download-menu CSS was removed');
  ok(/\.answer-menu\.drop-up \.answer-menu-list \{ top: auto; bottom: calc\(100% \+ 4px\); \}/.test(css),
    'the drop-up style anchors the dropdown above the button');

  console.log(`\nALL ANSWER-ACTIONS-MENU TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ ANSWER-ACTIONS-MENU TEST FAILED:', e && e.message);
  process.exit(1);
}
