'use strict';
// Guards that the real logo is used everywhere it should be, not the old "◈" text glyph (which
// each platform's font drew differently and looked nothing like the brand mark). Covers the
// in-app header and the desktop splash screen, and pins the splash's inline mark to the same
// diamond path as the canonical icon.svg so it can't drift. Pure file read. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(PROJECT, ...p), 'utf8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

// The canonical logo's outer-diamond path — the single shape both the header (via icon.svg) and
// the splash (inline) must render.
const DIAMOND = 'M50 16 L84 50 L50 84 L16 50 Z';

try {
  const iconSvg = read('lib', 'public', 'icons', 'icon.svg');
  ok(iconSvg.includes(DIAMOND), 'icon.svg (the source of truth) contains the brand diamond path');

  // Header: uses the real icon file, not a glyph.
  const header = read('lib', 'views', 'partials', 'header.ejs');
  ok(header.includes('src="/icons/icon.svg"'), 'header renders the real icon.svg logo');
  ok(!header.includes('◈'), 'header no longer uses the ◈ text glyph');
  console.log('✓ branding-logo: the in-app header uses the real logo');

  // Desktop splash: self-contained (a tauri:// asset that paints before the server exists), so it
  // inlines the mark — pinned to the same diamond path as icon.svg, and no glyph.
  const splash = read('src-tauri', 'ui', 'index.html');
  ok(splash.includes(DIAMOND), 'the desktop splash inlines the same brand diamond path as icon.svg');
  ok(!splash.includes('◈'), 'the desktop splash no longer uses the ◈ text glyph');
  console.log('✓ branding-logo: the desktop splash uses the real logo');

  console.log(`\nALL BRANDING-LOGO UNIT TESTS PASSED (${checks} checks)`);
  process.exitCode = 0;
} catch (e) {
  console.error('\n✗ BRANDING-LOGO UNIT TEST FAILED:', e && e.message);
  process.exitCode = 1;
}
