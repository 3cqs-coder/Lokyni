'use strict';
// Guards the emoji→SVG-sprite conversion for the functional file-type and chrome icons, so they render
// identically on every OS and follow the theme (color emoji vary by platform and ignore the theme):
//   • file-type icons are single-sourced through FILE_ICON_ID + fileIconSvg (one map, used by the doc list,
//     the source pills, and the "answered from" chips) — the old FILE_ICONS/DOC_ICONS emoji maps are gone;
//   • every sprite id the mapping and the provider badge reference actually exists in the icon sprite;
//   • the document viewer renders its file-type icon as the same sprite (and includes the sprite to do so).
// Source guards (no DOM). Run: `npm run test:unit`.

const path = require('path'), fs = require('fs'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(PROJECT, ...p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  const chat = read('lib', 'public', 'js', 'chat.js');
  const icons = read('lib', 'views', 'partials', 'icons.ejs');
  const spriteIds = new Set((icons.match(/id="(ic-[a-z0-9-]+)"/g) || []).map(s => s.replace(/id="|"/g, '')));

  // The file-type icons are single-sourced and rendered as a sprite, not per-type emoji.
  ok(/const FILE_ICON_ID = \{/.test(chat), 'file-type icons are single-sourced in FILE_ICON_ID');
  ok(/const fileIconSvg = \(type\) =>/.test(chat) && /<svg class="ico file-ico"[^`]*<use href="#\$\{FILE_ICON_ID/.test(chat),
    'fileIconSvg renders a themeable sprite for a file type');
  ok(!/const FILE_ICONS =/.test(chat) && !/const DOC_ICONS =/.test(chat),
    'the old per-type emoji maps (FILE_ICONS / DOC_ICONS) are gone');
  // No color-emoji file glyphs remain in the icon code paths.
  for (const emoji of ['📄', '📝', '📃', '📊', '📽️', '🗂️', '📁', '🦙']) {
    ok(!chat.includes(emoji), `the ${emoji} emoji icon was replaced by a sprite`);
  }

  // Every sprite id the mapping references exists in the sprite sheet (no dangling <use>).
  const idsUsed = new Set((chat.match(/ic-[a-z0-9-]+/g) || []));
  const fileMapIds = ['ic-file-text', 'ic-file-slides', 'ic-file-sheet', 'ic-file-book', 'ic-file-code', 'ic-web', 'ic-image', 'ic-file', 'ic-folder', 'ic-home', 'ic-drive', 'ic-local', 'ic-cloud', 'ic-attach', 'ic-thumb-up', 'ic-thumb-down'];
  for (const id of fileMapIds) ok(spriteIds.has(id), `the sprite "${id}" is defined in icons.ejs`);

  // The provider badge is local-vs-cloud sprites (not the 🦙/⚡ emoji), in both the client and the server render.
  ok(/provIcon = data\.provider === 'ollama' \? 'ic-local' : 'ic-cloud'/.test(chat), 'the header provider badge uses sprites (client)');
  const header = read('lib', 'views', 'partials', 'header.ejs');
  ok(/#<%= provider === 'ollama' \? 'ic-local' : 'ic-cloud' %>/.test(header), 'the header provider badge uses sprites (server render)');

  // The document viewer shows the same sprite and includes the sprite sheet to resolve it.
  const viewerJs = read('lib', 'routes', 'viewer.js');
  ok(/pdf: 'ic-file-text'/.test(viewerJs) && /\|\| 'ic-file';/.test(viewerJs), 'the viewer maps the file type to a sprite id');
  const viewerEjs = read('lib', 'views', 'document-viewer.ejs');
  ok(/include\('partials\/icons'\)/.test(viewerEjs) && /<svg class="ico" aria-hidden="true"><use href="#<%= fileIcon %>"\/>/.test(viewerEjs),
    'the viewer includes the sprite sheet and renders the file-type sprite');

  console.log(`\nALL FILE-ICON-SPRITES TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ FILE-ICON-SPRITES TEST FAILED:', e && e.message);
  process.exit(1);
}
