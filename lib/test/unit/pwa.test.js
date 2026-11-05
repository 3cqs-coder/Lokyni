'use strict';
// Regression tests for the installable web app (PWA) and locally vendored fonts. These lock
// in the invariants that make the app installable and fully self-hosted:
//   • the icon and font files the UI references actually exist and are valid,
//   • fonts.css and the vendored woff2 files agree (no dangling or orphaned references),
//   • the page head wires up the manifest, the local fonts, and the service worker,
//   • the manifest route lists only icons that exist on disk,
//   • the service worker is network-only — it must never cache the app's own code, which would
//     risk silently serving stale UI after an upgrade.
// Pure file/string checks — no server, no network. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const PUB = path.join(PROJECT, 'lib', 'public');
const VIEWS = path.join(PROJECT, 'lib', 'views');   // templates live outside the served web root

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };
const read = (...p) => fs.readFileSync(path.join(...p), 'utf-8');
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

try {
  // ── icons exist and are valid PNGs (plus the SVG) ──
  const iconsDir = path.join(PUB, 'icons');
  for (const name of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'icon-180.png']) {
    const buf = fs.readFileSync(path.join(iconsDir, name));
    ok(buf.subarray(0, 8).equals(PNG_SIG), `${name} is a valid PNG`);
  }
  ok(read(iconsDir, 'icon.svg').includes('<svg'), 'icon.svg is present');
  console.log('✓ pwa: all app icons exist and are valid');

  // ── fonts are vendored locally and fonts.css agrees with the files on disk ──
  const fontsDir = path.join(PUB, 'fonts');
  const fontsCss = read(fontsDir, 'fonts.css');
  const referenced = [...fontsCss.matchAll(/url\('\/fonts\/([^']+\.woff2)'\)/g)].map(m => m[1]);
  ok(referenced.length >= 4, 'fonts.css declares multiple font faces');
  for (const f of referenced) ok(fs.existsSync(path.join(fontsDir, f)), `referenced font ${f} exists on disk`);
  const onDisk = fs.readdirSync(fontsDir).filter(f => f.endsWith('.woff2'));
  for (const f of onDisk) ok(referenced.includes(f), `vendored font ${f} is referenced by fonts.css (no orphan)`);
  ok(!/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(fontsCss), 'fonts.css contains no font-CDN URL');
  console.log(`✓ pwa: ${onDisk.length} fonts vendored locally and fully wired in fonts.css`);

  // ── the page head wires up the PWA and local fonts ──
  const chat = read(VIEWS, 'chat.ejs');
  ok(/rel="manifest"\s+href="\/manifest\.webmanifest"/.test(chat), 'chat.ejs links the web app manifest');
  ok(chat.includes('/fonts/fonts.css'), 'chat.ejs loads the local fonts');
  ok(/name="theme-color"/.test(chat), 'chat.ejs sets a theme-color');
  ok(/rel="apple-touch-icon"/.test(chat), 'chat.ejs sets an apple-touch-icon');
  ok(chat.includes("serviceWorker") && chat.includes("register('/sw.js')"), 'chat.ejs registers the service worker');
  // No external stylesheet/script hosts anywhere in the served pages.
  for (const view of ['chat.ejs', 'document-viewer.ejs']) {
    const html = read(VIEWS, view);
    ok(!/https?:\/\/[^"']*\.(?:css|js|woff2?)/.test(html), `${view} references no external CSS/JS/font URL`);
  }
  console.log('✓ pwa: the page head wires up the manifest, local fonts, and service worker');

  // ── the manifest route lists only icons that exist ──
  const server = read(PROJECT, 'lib', 'server.js');
  ok(server.includes("app.get('/manifest.webmanifest'"), 'server defines the manifest route');
  const manifestIcons = [...server.matchAll(/src:\s*'(\/icons\/[^']+)'/g)].map(m => m[1]);
  ok(manifestIcons.length >= 3, 'the manifest lists several icons');
  for (const src of manifestIcons) {
    ok(fs.existsSync(path.join(PUB, src.replace(/^\//, ''))), `manifest icon ${src} exists on disk`);
  }
  console.log('✓ pwa: every icon named in the manifest exists on disk');

  // ── the service worker is network-only (never caches app code) ──
  const sw = read(PUB, 'sw.js');
  ok(/addEventListener\('fetch'/.test(sw), 'the service worker has a fetch handler (installability)');
  ok(/fetch\(req\)/.test(sw), 'the service worker passes requests through to the network');
  ok(!/\.put\(/.test(sw) && !/caches\.match/.test(sw), 'the service worker never stores or serves cached app assets');
  ok(!/self\.clients\.claim\(/.test(sw),
    'the worker never claims a page mid-load, which made Firefox cancel an in-flight asset request');
  // It only intercepts top-level NAVIGATIONS (for the offline fallback); every other request — assets,
  // socket.io polls, media range/opaque requests — is left to the browser, keeping the worker off the hot path
  // and clear of browser-specific range/opaque re-issue edge cases. (Still never caches, so no stale-UI risk.)
  ok(/req\.mode !== 'navigate'\) return/.test(sw), 'the worker only intercepts navigations; it ignores asset/poll/range GETs');
  console.log('✓ pwa: the service worker is a navigation-only, never-caching offline fallback (no stale-code risk)');

  console.log(`\nALL PWA UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ PWA UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
