'use strict';
// Guards the Settings modal's progressive-disclosure layout (lib/views/chat.ejs). The modal
// must open showing the core setup (Model & provider, Features) with the two heavy blocks — Advanced
// tuning and the Tools & data management suite (rebuild, API keys, clipper, connectors, templates,
// automations, email, evaluation) — behind collapsed <details>, so it stays a tidy, not-overwhelming
// dialog. A regression that flattens Tools & data back into an always-expanded section (a very long
// modal again) fails the build. Source inspection. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const ejs = fs.readFileSync(path.join(ROOT, 'lib', 'views', 'chat.ejs'), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  const bodyStart = ejs.indexOf('id="settings-body"');
  const bodyEnd = ejs.indexOf('id="settings-status"', bodyStart);
  ok(bodyStart !== -1 && bodyEnd > bodyStart, 'the settings body is present');
  const body = ejs.slice(bodyStart, bodyEnd);

  // Both heavy blocks are collapsible <details> (not always-expanded), and neither is force-open.
  const details = body.match(/<details[^>]*>/g) || [];
  ok(details.length >= 2, 'the settings body has at least two collapsible sections (Advanced, Tools & data)');
  ok(!/<details[^>]*\bopen\b/.test(body), 'no settings section is force-expanded by default');

  // The Advanced and Tools & data summaries exist.
  ok(/<summary>Advanced/.test(body), 'Advanced tuning is behind a collapsible summary');
  ok(/<summary>Tools &amp; data/.test(body), 'Tools & data is behind a collapsible summary');

  // The management controls live INSIDE the Tools & data <details> (between its summary and the body end).
  const toolsIdx = body.indexOf('<summary>Tools &amp; data');
  ok(toolsIdx !== -1, 'the Tools & data section is found');
  const toolsBlock = body.slice(toolsIdx);
  for (const id of ['rebuild-index-btn', 'connector-add-btn', 'template-add-btn', 'automation-add-btn', 'eval-results']) {
    ok(toolsBlock.includes(id), `the "${id}" control is inside the collapsed Tools & data section`);
  }
  ok(toolsBlock.includes('</details>'), 'the Tools & data section is properly closed');

  // ── Cross-browser: the settings-row layout does not rely on CSS :has() alone ──
  // Firefox < 121 has no :has(); the two-column and mobile-stacked layouts must still apply there via a
  // class fallback tagged by a small load-time script, so a row's input never overflows on an old browser.
  const css = fs.readFileSync(path.join(ROOT, 'lib', 'public', 'css', 'app.css'), 'utf-8');
  const chat = fs.readFileSync(path.join(ROOT, 'lib', 'public', 'js', 'chat.js'), 'utf-8');
  ok((css.match(/\.settings-row\.settings-row-input/g) || []).length >= 3,
    'the CSS carries a .settings-row-input class fallback beside the :has() selectors (desktop + mobile)');
  ok(/function tagSettingsInputRows\(\)/.test(chat) && /classList\.add\('settings-row-input'\)/.test(chat),
    'a load-time script tags fill-input rows so the layout works without :has()');

  console.log('✓ settings-layout: core setup up front; Advanced and Tools & data collapsed by default; :has()-free fallback');
  console.log(`\nALL SETTINGS-LAYOUT UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ SETTINGS-LAYOUT UNIT TEST FAILED:', e.message);
  process.exit(1);
}
