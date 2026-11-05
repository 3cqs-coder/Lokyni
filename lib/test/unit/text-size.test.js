'use strict';
// Guards the reading text-size (accessibility) control: a --read-scale multiplier scales the surfaces people
// READ — chat answers/questions, the document viewer, rendered Markdown — persisted per-device and restored
// before first paint (no flash) on BOTH the app and the document-viewer pages, while the chrome stays fixed so
// layout never breaks. Clamped to a safe range. Source guards (no DOM). Run: `npm run test:unit`.

const path = require('path'), fs = require('fs'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(PROJECT, ...p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  const css = read('lib', 'public', 'css', 'app.css');
  ok(/--read-scale:\s*1;/.test(css), 'app.css defines the --read-scale multiplier (default 1)');
  // The reading surfaces scale with it; their headings/code are em-based so one multiplier cascades.
  ok(/\.bubble \{[^}]*font-size: calc\(14px \* var\(--read-scale\)\)/.test(css), 'chat answers/questions (.bubble) scale');
  ok(/\.markdown \{ font-size: calc\(15px \* var\(--read-scale\)\)/.test(css), 'rendered Markdown (.markdown) scales');
  ok(/\.viewer-body pre \{[^}]*font-size: calc\(13px \* var\(--read-scale\)\)/.test(css), 'the document viewer\'s plain-text scales');
  // The per-theme bubble rules no longer hardcode a second font-size (single-sourced on .bubble).
  ok(!/\.user \.bubble \{[^}]*font-size: 14px/.test(css) && !/\.bot  \.bubble \{[^}]*font-size: 14px/.test(css),
    'the bubble font-size is single-sourced (not duplicated on the per-theme rules)');

  // Pre-paint restore on BOTH pages: the saved scale is applied before first paint (no flash), clamped to a
  // sane range so a bad stored value can't make the UI unusable.
  for (const [file, label] of [[['lib', 'views', 'chat.ejs'], 'the app'], [['lib', 'views', 'document-viewer.ejs'], 'the viewer']]) {
    const page = read(...file);
    ok(/parseFloat\(localStorage\.getItem\('readScale'\)\)/.test(page) &&
       /if \(s >= 0\.8 && s <= 2\) document\.documentElement\.style\.setProperty\('--read-scale', String\(s\)\)/.test(page),
      `${label} restores the saved text size before first paint (clamped)`);
  }

  // The client applies + persists + clamps, and the Settings control is wired as a live per-device preference.
  const chat = read('lib', 'public', 'js', 'chat.js');
  ok(/function applyReadScale\(scale\)/.test(chat) && /style\.setProperty\('--read-scale'/.test(chat) && /lsSet\('readScale'/.test(chat),
    'applyReadScale sets the CSS variable and persists it');
  ok(/const clampReadScale = \(v\) =>/.test(chat) && /READ_SCALE_MIN|READ_SCALE_MAX/.test(chat), 'the scale is clamped to a safe range');
  ok(/getElementById\('cfg-read-scale'\)/.test(chat) && /readScaleSel\.addEventListener\('change', \(\) => \{ currentReadScale = applyReadScale/.test(chat),
    'the Settings "Text size" control applies live on change');

  const ejs = read('lib', 'views', 'chat.ejs');
  ok(/<div class="settings-section">Appearance<\/div>/.test(ejs) && /id="cfg-read-scale"/.test(ejs),
    'Settings has an Appearance section with the Text size control');

  console.log(`\nALL TEXT-SIZE TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ TEXT-SIZE TEST FAILED:', e && e.message);
  process.exit(1);
}
