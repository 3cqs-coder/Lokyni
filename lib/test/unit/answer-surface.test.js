'use strict';
// Guards the consolidated answer surface:
//   • ONE source presentation per answer (the numbered pills below it), not a duplicate strip above;
//   • a stable answer-meta block whose action strip keeps a fixed order no matter which server event
//     (answer, late Verify badge, restored history) creates the controls;
//   • a keyboard-complete answer More menu (menu-button semantics, arrows, Home/End, Escape).
// Static contracts, so a later edit that re-splits sources or drops the menu's keyboard path fails the
// build. No model or network. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

try {
  const chat = read('lib/public/js/chat.js');
  const css  = read('lib/public/css/app.css');

  // ── 1. One source presentation ──
  ok(!/function renderAnsweredFrom\(/.test(chat), 'the duplicate "Answered from" strip is gone');
  ok(!/\.answered-from|\.af-chip|\.af-label|\.af-more/.test(css), 'the strip/chip styles are gone too');
  ok(/lbl\.textContent = `Sources \(\$\{total\}\)`/.test(chat),
    'the single sources row labels itself with the source count');
  ok(/row\.setAttribute\('aria-label', `Sources \(\$\{total\}\)/.test(chat),
    'the sources row exposes the same count to assistive technology');
  {
    const start = chat.indexOf('function appendSources(sources, stats)');
    const end = chat.indexOf('// ── In-app source viewer', start);
    const body = start === -1 ? '' : chat.slice(start, end === -1 ? undefined : end);
    ok(body.includes("className = 'sources-row'"), 'appendSources creates exactly one sources row');
  }
  ok((chat.match(/className = 'sources-row'/g) || []).length === 1, 'only one place creates a sources row');

  // ── 2. A stable meta block and action strip ──
  ok(/function answerMetaFor\(bot, \{ create = true \} = \{\}\)/.test(chat) &&
     /function answerActionsFor\(bot, \{ create = true \} = \{\}\)/.test(chat),
    'a dedicated meta block and action strip are created per answer, with a read-only lookup');
  ok(/if \(!create\) return null;/.test(chat),
    'a refresh pass can inspect answers without creating empty meta blocks');
  ok(/className = 'answer-meta'/.test(chat) && /className = 'answer-actions'/.test(chat),
    'the meta block and action strip have their own containers');
  ok(/meta\.insertBefore\(actions, meta\.firstChild\)/.test(chat),
    'actions stay above follow-up suggestions');
  ok(/function appendAnswerAction\(row, el\)[\s\S]{0,220}?row\.insertBefore\(el, menu\)/.test(chat),
    'late controls are inserted before the More menu, so the menu stays the last tab stop');
  ok(/suggestTargetRow  = lastAnswerMetaRow\(\)/.test(chat) && /faithTargetRow    = lastAnswerRow\(\)/.test(chat),
    'suggestions pin to the meta block while the Verify badge pins to the action strip');
  ok(/function lastAnswerRow\(\)[\s\S]{0,150}?return answerActionsFor\(/.test(chat),
    'every per-answer control attaches to the action strip, never the sources row');

  // The visual order is explicit, so arrival order cannot reshuffle the controls.
  ok(/\.answer-actions \.rating-row \{ order: 1;/.test(css) &&
     /\.answer-actions \.readaloud-btn, \.answer-actions \.podcast-hint \{ order: 2;/.test(css) &&
     /\.answer-actions \.faith-badge \{ order: 3;/.test(css) &&
     /\.answer-actions \.answer-menu \{ order: 99; margin-left: auto;/.test(css) &&
     /\.answer-actions \.faith-panel \{ order: 100; flex-basis: 100%;/.test(css),
    'the action strip order is rating → read aloud → Verify → More, with the Verify panel on its own line');
  ok(/\.answer-meta \.suggest-row \{ margin: 0; padding: 0 20px 10px; \}/.test(css),
    'follow-up suggestions sit below the actions, aligned with them');

  // ── 3. Keyboard-complete answer menu ──
  ok(/let _answerMenuSeq = 0;/.test(chat) && /const listId = `answer-menu-\$\{\+\+_answerMenuSeq\}`/.test(chat),
    'each answer menu gets a unique id');
  ok(/btn\.setAttribute\('aria-haspopup', 'menu'\)/.test(chat) &&
     /btn\.setAttribute\('aria-controls', listId\)/.test(chat),
    'the trigger advertises and names its menu');
  ok(/list\.setAttribute\('role', 'menu'\)/.test(chat) &&
     /list\.setAttribute\('aria-label', 'Answer actions'\)/.test(chat),
    'the popup is a labelled menu');
  ok(/const items = \(\) => \[\.\.\.list\.querySelectorAll\('\.answer-menu-item'\)\]/.test(chat),
    'the menu enumerates its visible items');
  ok(/if \(e\.key === 'Escape'\)[\s\S]{0,120}?close\(true\)/.test(chat),
    'Escape closes the menu and returns focus to its trigger');
  ok(/e\.key === 'ArrowDown'\) \{ e\.preventDefault\(\); \(listItems\[i \+ 1\] \|\| listItems\[0\]\)\.focus\(\)/.test(chat) &&
     /e\.key === 'ArrowUp'\) \{ e\.preventDefault\(\); \(listItems\[i - 1\] \|\| listItems\[listItems\.length - 1\]\)\.focus\(\)/.test(chat),
    'Up/Down move through the menu with wrap-around');
  ok(/e\.key === 'Home'\) \{ e\.preventDefault\(\); listItems\[0\]\.focus\(\)/.test(chat) &&
     /e\.key === 'End'\) \{ e\.preventDefault\(\); listItems\[listItems\.length - 1\]\.focus\(\)/.test(chat),
    'Home/End reach the first and last action');
  ok(/if \(e\.key === 'Tab'\) \{ close\(false\); return; \}/.test(chat) && !/addEventListener\('focusout'/.test(chat),
    'the menu closes on Tab and outside click, avoiding a WebKit focusout race that ate pointer clicks');
  ok(/const first = items\(\)\[0\];[\s\S]{0,100}?first\.focus\(\)/.test(chat),
    'opening the menu focuses its first action');
  ok(/if \(!keepOpen\) \{ const w = row\.querySelector\('\.answer-menu'\); if \(w && w\._close\) w\._close\(true\)/.test(chat),
    'an action that closes the menu returns focus to the trigger');

  // ── 4. One source row, one action strip, and the answer itself stay separate ──
  ok(!/sources-row[\s\S]{0,200}?rating-row/.test(chat),
    'actions are no longer appended into the sources row');
  ok(!/metaRowFor\(/.test(chat), 'the old sources-row-or-answer meta selector is gone');

  console.log(`\nALL ANSWER-SURFACE UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ ANSWER-SURFACE UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
