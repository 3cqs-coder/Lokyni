'use strict';
// Guards button-text contrast in every theme. Primary and destructive buttons use white text on a
// solid background token (--accent-strong / --error-strong), and the accent is also used AS text on
// the theme background. All three must meet WCAG AA (>= 4.5:1) in the dark, light, and sepia themes
// — the dark theme previously failed (white on the bright accent was ~3.2:1), which is why the solid
// button background is a separate, deeper token from the text/border accent. This parses the theme
// blocks in app.css and computes the ratios, so lowering a token below AA fails the build. Run:
// `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const CSS = path.resolve(__dirname, '..', '..', '..', 'lib', 'public', 'css', 'app.css');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

// WCAG relative luminance + contrast ratio for a #rrggbb (or #rgb) color.
const lum = (hex) => {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
};
const ratio = (a, b) => { const L1 = lum(a), L2 = lum(b); const hi = Math.max(L1, L2), lo = Math.min(L1, L2); return (hi + 0.05) / (lo + 0.05); };

try {
  const css = fs.readFileSync(CSS, 'utf-8');
  const block = (selector) => {
    const m = css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([\\s\\S]*?)\\}'));
    if (!m) throw new Error(`theme block not found: ${selector}`);
    return m[1];
  };
  const token = (body, name) => {
    const m = body.match(new RegExp('--' + name + ':\\s*(#[0-9a-fA-F]{3,6})\\s*;'));
    if (!m) throw new Error(`token --${name} not found (or not a hex value)`);
    return m[1];
  };

  // Every var() must resolve to a token defined in :root. A typo such as var(--surfce) fails silently in the
  // browser (the declaration is dropped), which is exactly the kind of theme drift a visual check misses. Also
  // ensure the light/sepia blocks define no token that :root lacks, so an override can never target a dead name.
  const rootTokens = new Set([...block(':root').matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]));
  const usedTokens = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  const undefinedTokens = [...usedTokens].filter((t) => !rootTokens.has(t));
  ok(undefinedTokens.length === 0, `every var() resolves in :root (missing: ${undefinedTokens.join(', ') || 'none'})`);
  for (const [name, selector] of [['light', '.light'], ['sepia', '.sepia']]) {
    const extras = [...new Set([...block(selector).matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]))]
      .filter((t) => !rootTokens.has(t));
    ok(extras.length === 0, `${name}: no token is defined outside :root (orphans: ${extras.join(', ') || 'none'})`);
  }

  for (const [name, selector] of [['dark', ':root'], ['light', '.light'], ['sepia', '.sepia']]) {
    const b = block(selector);
    const bg = token(b, 'bg'), accent = token(b, 'accent');
    const accentStrong = token(b, 'accent-strong'), errorStrong = token(b, 'error-strong');
    ok(ratio('#ffffff', accentStrong) >= 4.5, `${name}: white on --accent-strong meets AA (${ratio('#ffffff', accentStrong).toFixed(2)}:1)`);
    ok(ratio('#ffffff', errorStrong) >= 4.5, `${name}: white on --error-strong meets AA (${ratio('#ffffff', errorStrong).toFixed(2)}:1)`);
    ok(ratio(accent, bg) >= 4.5, `${name}: --accent as text on --bg meets AA (${ratio(accent, bg).toFixed(2)}:1)`);
  }

  // The accent is also used AS text/border on the darker interactive surfaces in every theme — hover
  // and active states put accent text on --accent-dim (active), --pill-hover / --bg-elev (hover), and
  // --surface2. Each must meet AA. The active-state --accent-dim pair is the one that regressed in the
  // dark theme (accent on the navy tint was ~3.5:1 across the active header button, the primary confirm
  // button, picker rows, and the web-search offer), so it is checked in all three themes here.
  for (const [name, selector] of [['dark', ':root'], ['light', '.light'], ['sepia', '.sepia']]) {
    const b = block(selector);
    const accent = token(b, 'accent');
    for (const surf of ['accent-dim', 'pill-hover', 'bg-elev', 'surface2']) {
      const r = ratio(accent, token(b, surf));
      ok(r >= 4.5, `${name}: --accent as text on --${surf} meets AA (${r.toFixed(2)}:1)`);
    }
  }

  // --text-dim colors small (9-13px) secondary text — hints, metadata, menu/tool descriptions, pill
  // locations, placeholders — which sits not only on the base background but also on the elevated and
  // hover rows. So it must meet the 4.5:1 normal-text threshold on EVERY surface it can land on, in
  // every theme. (It regressed on light/sepia across all surfaces and on dark's elevated/hover rows.)
  for (const [name, selector] of [['dark', ':root'], ['light', '.light'], ['sepia', '.sepia']]) {
    const b = block(selector);
    const dim = token(b, 'text-dim');
    for (const surf of ['bg', 'surface', 'surface2', 'bg-elev', 'pill-hover']) {
      const r = ratio(dim, token(b, surf));
      ok(r >= 4.5, `${name}: --text-dim on --${surf} meets AA (${r.toFixed(2)}:1)`);
    }
  }

  // --text-mid colors small secondary text pervasively (header buttons, modal bodies, source pills,
  // viewer notes, blockquotes), landing on the base background and on the elevated and hover rows. Its
  // tightest real pairs sit just above AA (light --text-mid on --pill-hover / --bg-elev ~4.5-4.6:1),
  // so it is guarded here to keep a future darkening of an elevated surface from silently crossing AA.
  for (const [name, selector] of [['dark', ':root'], ['light', '.light'], ['sepia', '.sepia']]) {
    const b = block(selector);
    const mid = token(b, 'text-mid');
    for (const surf of ['bg', 'surface', 'surface2', 'bg-elev', 'pill-hover']) {
      const r = ratio(mid, token(b, surf));
      ok(r >= 4.5, `${name}: --text-mid on --${surf} meets AA (${r.toFixed(2)}:1)`);
    }
  }

  // --success and --error are used AS text (status badges, connector/upload/backup/faithfulness
  // statuses, rating acks). --success text lands on its own tint and on the surfaces/elevated rows;
  // --error text lands on surfaces and elevated rows. Both must meet AA on each in every theme (they
  // failed as light/sepia success text and light error-on-elevated). --success-bg / --error-strong
  // are separate background tokens and are not checked here.
  for (const [name, selector] of [['dark', ':root'], ['light', '.light'], ['sepia', '.sepia']]) {
    const b = block(selector);
    const success = token(b, 'success'), error = token(b, 'error');
    for (const surf of ['success-bg', 'surface', 'surface2', 'bg-elev']) {
      const r = ratio(success, token(b, surf));
      ok(r >= 4.5, `${name}: --success as text on --${surf} meets AA (${r.toFixed(2)}:1)`);
    }
    for (const surf of ['surface', 'surface2', 'bg-elev', 'bg']) {
      const r = ratio(error, token(b, surf));
      ok(r >= 4.5, `${name}: --error as text on --${surf} meets AA (${r.toFixed(2)}:1)`);
    }
  }

  // The auth pages (login / account / admin-users) carry their own inline button styles instead of the shared
  // classes, so they must use the deep solid token (--accent-strong) for white button text — using the bright
  // --accent (as they once did) gives ~3.2:1 in the default dark theme. Guard each so it can't regress.
  const VIEWS = path.resolve(__dirname, '..', '..', '..', 'lib', 'views');
  for (const f of ['login.ejs', 'account.ejs', 'admin-users.ejs']) {
    const v = fs.readFileSync(path.join(VIEWS, f), 'utf-8');
    ok(/background:\s*var\(--accent-strong\);\s*color:\s*#fff/.test(v),
      `${f}: the white-text CTA button uses --accent-strong (AA in every theme)`);
    ok(!/background:\s*var\(--accent\);\s*color:\s*#fff/.test(v),
      `${f}: no white-text button uses the bright --accent (sub-AA in dark)`);
  }

  // The standalone pages (login / account / admin-users / document-viewer) set the browser/PWA chrome color
  // with hardcoded theme-color <meta> hexes and an inline pre-paint script, because the stylesheet is not yet
  // parsed when that script runs, so they cannot read the --bg token live the way the main app does. That makes
  // the literals a DRIFT risk: if a theme's --bg changes in app.css, these pages would keep tinting the window
  // with the old color. Guard it — each page must carry the CURRENT --bg hex for every theme, so a token change
  // fails here until the page literals are updated to match.
  const bgByTheme = {
    dark:  token(block(':root'), 'bg'),
    light: token(block('.light'), 'bg'),
    sepia: token(block('.sepia'), 'bg'),
  };
  for (const f of ['login.ejs', 'account.ejs', 'admin-users.ejs', 'document-viewer.ejs']) {
    const v = fs.readFileSync(path.join(VIEWS, f), 'utf-8').toLowerCase();
    for (const [name, hex] of Object.entries(bgByTheme)) {
      ok(v.includes(hex.toLowerCase()),
        `${f}: the theme-color chrome hex for the ${name} theme matches --bg (${hex}) — no drift from app.css`);
    }
  }

  // Cross-platform layout invariant: the settings body scrolls, and its toggle checkboxes are right-aligned. On
  // GNOME/WebKitGTK (Linux) the platform scrollbar is an OVERLAY that floats on top of the content and covered
  // those toggles, making them unclickable — which shipped once. Defining a ::-webkit-scrollbar switches WebKit to
  // a classic, space-taking scrollbar so the content sits to its LEFT and the toggles stay clickable (a gutter
  // alone can't fix an overlay scrollbar). Guard that the settings body defines its own scrollbar width.
  ok(/#settings-body::-webkit-scrollbar\s*\{[^}]*width:/.test(css),
    'the scrolling settings body defines a classic (space-taking) scrollbar so it never overlays the right-aligned toggles');

  console.log(`\nALL THEME-CONTRAST UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ THEME-CONTRAST UNIT TEST FAILED:', e.message);
  process.exit(1);
}
