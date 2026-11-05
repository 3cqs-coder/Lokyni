'use strict';
// Guards a static-serving hygiene fix: the EJS view templates must NOT live under the directory that
// express.static serves (lib/public). They used to sit at lib/public/views, so `GET /views/chat.ejs`
// returned their raw source — the static middleware runs before any route. They now live at lib/views,
// outside the web root, and the view engine is pointed there. This test fails if either the templates
// drift back under lib/public or the view-engine path is repointed into the served root. No server needed.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // The templates exist in their new home, and NOT under the served static root.
  ok(fs.existsSync(path.join(PROJECT, 'lib', 'views', 'chat.ejs')),
    'the chat template lives at lib/views (outside the web root)');
  ok(!fs.existsSync(path.join(PROJECT, 'lib', 'public', 'views')),
    'no views directory remains under lib/public (the express.static root)');

  // The view engine is pointed outside the static root, and NOT at lib/public.
  const server = fs.readFileSync(path.join(PROJECT, 'lib', 'server.js'), 'utf-8');
  ok(/app\.set\('views', path\.join\(__dirname, 'views'\)\)/.test(server),
    'the view engine renders from lib/views');
  ok(!/app\.set\('views'[^\n]*'public'[^\n]*'views'/.test(server),
    'the view engine is not pointed back into the served public directory');

  console.log('✓ views-not-served: EJS templates live outside the static web root, so their source is not served');
  console.log(`\nALL VIEWS-NOT-SERVED UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ VIEWS-NOT-SERVED UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
