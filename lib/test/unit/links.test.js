'use strict';
// Guards the shared internal-link builders (lib/links.js). The in-app document viewer and figure-crop
// URLs were hand-built in several citation builders, so a route rename could leave some citations pointing
// at a dead path. These are now single-sourced; this test checks the builders encode correctly, STILL match
// the Express routes they mirror (viewer: GET /document/view, figures: GET /api/figure/:id), that no server
// module re-inlines the URL, and that the one browser copy stays in step. No server spin-up. Run:
// `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { viewerLink, figureUrl } = require(path.join(PROJECT, 'lib', 'links'));
const read = (...p) => fs.readFileSync(path.join(PROJECT, ...p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // ── builders encode the single user-controlled component (path separators, spaces, unicode) ──
  ok(viewerLink('reports/Q4 2025.pdf') === '/document/view?path=reports%2FQ4%202025.pdf', 'viewerLink encodes the source path');
  ok(figureUrl('abc123/4') === '/api/figure/abc123%2F4', 'figureUrl encodes the id');
  ok(viewerLink() === '/document/view?path=' && figureUrl() === '/api/figure/', 'the builders never throw on a missing argument');

  // ── the builders still match the Express routes they mirror (rename drift guard) ──
  const server = read('lib', 'server.js');
  const viewer = read('lib', 'routes', 'viewer.js');
  ok(/app\.use\('\/document',\s*viewerRouter\)/.test(server) && /router\.get\('\/view'/.test(viewer),
    'the viewer route is mounted at /document and serves /view (matches viewerLink)');
  ok(viewerLink('x').startsWith('/document/view?path='), 'viewerLink targets the mounted viewer route path');
  ok(/app\.get\('\/api\/figure\/:id'/.test(server), 'the figure route is /api/figure/:id (matches figureUrl)');
  ok(figureUrl('x').startsWith('/api/figure/'), 'figureUrl targets the figure route path');

  // ── no server module re-inlines these URLs (they go through the builders) ──
  for (const f of [['lib', 'retrieval', 'search.js'], ['lib', 'socket.js'], ['lib', 'retrieval', 'deepresearch.js']]) {
    const src = read(...f);
    ok(!/`\/document\/view\?path=\$\{encodeURIComponent/.test(src), `${f.join('/')} builds the viewer link via the helper, not inline`);
    ok(!/`\/api\/figure\/\$\{encodeURIComponent/.test(src), `${f.join('/')} builds the figure URL via the helper, not inline`);
  }
  ok(/require\('\.\.\/links'\)/.test(read('lib', 'retrieval', 'search.js')) && /require\('\.\/links'\)/.test(read('lib', 'socket.js')),
    'the citation builders import the shared link helpers');

  // ── the one browser copy (viewer-related.js can't require a Node module) builds the same path ──
  const client = read('lib', 'public', 'js', 'viewer-related.js');
  ok(/'\/document\/view\?path=' \+ encodeURIComponent\(/.test(client),
    'the browser copy builds the same /document/view?path= shape as viewerLink');

  console.log('✓ links: builders encode correctly, match the routes, and are the only source of these URLs');
  console.log(`\nALL LINKS UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ LINKS UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
