'use strict';
// Drift guards for values that, by necessity, appear in BOTH the backend/CSS and the frontend and so could fall
// out of sync. Where a value cannot be single-sourced at runtime (a CSS @media breakpoint cannot read a JS
// constant; a pre-paint script runs before the stylesheet loads), this test is the single source of TRUTH: it
// fails loudly the moment the two copies diverge, so neither can drift silently. Pure, offline, no model.
// Run: `npm run test:unit`.

const path = require('path'), fs = require('fs'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(PROJECT, ...p), 'utf-8');

const { CLIENT_SETTINGS } = require(path.join(PROJECT, 'lib', 'settings-schema'));
const chatEjs = read('lib', 'views', 'chat.ejs');
const chatJs  = read('lib', 'public', 'js', 'chat.js');
const appCss  = read('lib', 'public', 'css', 'app.css');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };
const setEq = (a, b) => a.size === b.size && [...a].every(x => b.has(x));

// Return the inner HTML of a <select id="..."> ... </select> block (null if absent).
const selectInner = (html, id) => {
  const m = html.match(new RegExp(`<select[^>]*id="${id}"[^>]*>([\\s\\S]*?)</select>`));
  return m ? m[1] : null;
};

try {
  // ── Guard 1 — provider enum (frontend ↔ backend) ───────────────────────────────────────────────────────────
  // Provider labels live once in settings-schema (PROVIDER_META) and the ordered lists derive from MODEL_DEFAULTS
  // / EMBEDDINGS_DEFAULTS, projected as CLIENT_SETTINGS.providers / embeddingProviders. The page RENDERS its three
  // dropdowns from those lists, so the option set cannot drift. This guard verifies the derivation is correct, the
  // template actually renders from the projection (not re-hardcoded options), and the provider-specific field logic
  // in chat.js still covers every provider — the one piece that is not auto-generated.
  const chatProviders = new Set(Object.keys(CLIENT_SETTINGS.modelDefaults));
  const embProviders  = new Set(Object.keys(CLIENT_SETTINGS.embeddingDefaults));
  ok(chatProviders.size >= 1 && embProviders.size >= 1, 'backend exposes provider sets');

  // The projected lists derive from the canonical provider sets and carry a label for each.
  ok(Array.isArray(CLIENT_SETTINGS.providers) && setEq(new Set(CLIENT_SETTINGS.providers.map(p => p.id)), chatProviders),
    'CLIENT_SETTINGS.providers ids match the chat provider set');
  ok(Array.isArray(CLIENT_SETTINGS.embeddingProviders) && setEq(new Set(CLIENT_SETTINGS.embeddingProviders.map(p => p.id)), embProviders),
    'CLIENT_SETTINGS.embeddingProviders ids match the embeddings provider set');
  ok(CLIENT_SETTINGS.providers.every(p => typeof p.label === 'string' && p.label.length > 0), 'every provider has a non-empty label');

  // Each dropdown renders from the projection and does NOT re-hardcode <option> values (which would reintroduce
  // the drift). The chat dropdowns use settingsSchema.providers; the embeddings one uses embeddingProviders.
  const frInner  = selectInner(chatEjs, 'fr-provider');
  const cfgInner = selectInner(chatEjs, 'cfg-provider');
  const embInner = selectInner(chatEjs, 'cfg-embeddings-provider');
  ok(frInner && cfgInner && embInner, 'the three provider dropdowns are present in chat.ejs');
  for (const [name, inner] of [['fr-provider', frInner], ['cfg-provider', cfgInner]]) {
    ok(/settingsSchema\.providers\.forEach/.test(inner), `${name} renders its options from settingsSchema.providers`);
    ok(!/<option[^>]*value="[a-z]/i.test(inner), `${name} has no hardcoded provider <option> (no drift source)`);
  }
  ok(/settingsSchema\.embeddingProviders\.forEach/.test(embInner), 'cfg-embeddings-provider renders from settingsSchema.embeddingProviders');
  ok(!/<option[^>]*value="[a-z]/i.test(embInner), 'cfg-embeddings-provider has no hardcoded provider <option>');

  // Every chat provider must be referenced in the UI's provider-specific key/host field logic (so a new provider
  // cannot ship with a dropdown entry but no field handling). A bare mention of the id string is enough signal.
  for (const p of chatProviders) {
    ok(chatJs.includes(`'${p}'`), `chat.js references provider "${p}" in its field logic`);
  }
  console.log(`✓ fe-be-drift: provider dropdowns render from the backend single source; field logic covers all (${chatProviders.size} chat, ${embProviders.size} embeddings)`);

  // ── Guard 2 — theme background colors (CSS ↔ pre-paint JS / meta) ───────────────────────────────────────────
  // The pre-paint theme script and the <meta name="theme-color"> tags run before app.css loads, so they must
  // hardcode the theme background hexes. Those literals must equal the --bg values app.css actually uses.
  const cssBg = new Set([...appCss.matchAll(/--bg:\s*(#[0-9a-fA-F]{6})\b/g)].map(x => x[1].toLowerCase()));
  ok(cssBg.size >= 2, `app.css defines theme --bg colors (${[...cssBg]})`);
  // Theme-chrome hexes the template hardcodes for the pre-paint path: the <meta name="theme-color"> tags and the
  // `var bg = { ... }[t] || '#...'` pre-paint fallback. These must exactly equal the current --bg set.
  const metaHex = [...chatEjs.matchAll(/name="theme-color"[^>]*content="(#[0-9a-fA-F]{6})"/g)].map(x => x[1].toLowerCase());
  const prepaintLine = (chatEjs.match(/var bg\s*=\s*\{[^;]*;/) || [''])[0];
  const prepaintHex = [...prepaintLine.matchAll(/#[0-9a-fA-F]{6}/g)].map(x => x[0].toLowerCase());
  const templateThemeHexes = new Set([...metaHex, ...prepaintHex]);
  ok(templateThemeHexes.size >= 1, 'chat.ejs hardcodes theme-chrome hexes for the pre-paint path');
  for (const h of templateThemeHexes) {
    ok(cssBg.has(h), `chat.ejs theme hex ${h} is a current app.css --bg value (not stale)`);
  }
  // And every current --bg must still be represented in the template, so renaming a theme color cannot leave the
  // pre-paint path on an old value.
  for (const h of cssBg) {
    ok(templateThemeHexes.has(h), `app.css --bg ${h} is reflected in chat.ejs pre-paint/meta (template not stale)`);
  }
  console.log(`✓ fe-be-drift: theme background hexes match between app.css and the pre-paint template (${[...cssBg].join(', ')})`);

  // ── Guard 3 — doc-panel responsive breakpoint (JS matchMedia ↔ CSS @media) ──────────────────────────────────
  // chat.js decides "panel is an overlay drawer" via matchMedia; app.css styles that drawer via @media. If the
  // two pixel values diverge there is a width band where JS and CSS disagree on the layout. Keep them equal.
  const jsBp = Number((chatJs.match(/DOC_PANEL_BREAKPOINT_PX\s*=\s*(\d+)/) || [])[1]);
  ok(Number.isFinite(jsBp) && jsBp > 0, `chat.js defines DOC_PANEL_BREAKPOINT_PX (got ${jsBp})`);
  ok(new RegExp(`@media \\(max-width:\\s*${jsBp}px\\)`).test(appCss),
    `app.css has an @media (max-width: ${jsBp}px) phone-layout rule matching the JS breakpoint`);
  ok(new RegExp(`@media \\(min-width:\\s*${jsBp + 1}px\\)`).test(appCss),
    `app.css has the matching @media (min-width: ${jsBp + 1}px) desktop rule`);
  // The JS must not reference a different literal breakpoint anywhere (all three matchMedia calls use the const).
  ok(!/matchMedia\(['"`]\(max-width:\s*\d+px\)/.test(chatJs),
    'chat.js builds every doc-panel media query from DOC_PANEL_BREAKPOINT_PX, not an inline literal');
  console.log(`✓ fe-be-drift: doc-panel breakpoint (${jsBp}px) matches between chat.js and app.css`);

  // ── Guard 4 — cross-browser vendor prefix completeness ──────────────────────────────────────────────────────
  // `user-select: none` only landed unprefixed in Safari/iOS 16.4, so every such rule needs the -webkit- prefix
  // or the element stays selectable on older iOS (e.g. a cursor:grab node whose label selects mid-drag). Each
  // `user-select: none` must be paired with a `-webkit-user-select: none` so a newly added rule cannot regress it.
  const standardUserSelect = (appCss.match(/(^|[^-])user-select:\s*none/g) || []).length;
  const webkitUserSelect   = (appCss.match(/-webkit-user-select:\s*none/g) || []).length;
  ok(standardUserSelect > 0, 'app.css has user-select:none rules to check');
  ok(webkitUserSelect >= standardUserSelect,
    `every user-select:none has a -webkit- prefix for old Safari/iOS (webkit ${webkitUserSelect} >= standard ${standardUserSelect})`);
  console.log(`✓ fe-be-drift: all ${standardUserSelect} user-select:none rules carry the -webkit- cross-browser prefix`);

  console.log(`\nALL FE/BE DRIFT-GUARD TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ FE/BE DRIFT-GUARD TEST FAILED:', e.message);
  process.exit(1);
}
