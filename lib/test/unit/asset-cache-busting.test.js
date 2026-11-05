'use strict';
// Guards cache-busting for versioned static assets. App code (/js, /css) is served no-cache and
// vendored libraries (/vendor) are served with a one-year immutable cache, so EVERY such asset
// referenced from the HTML must carry a `?v=<assetVersion>` query — otherwise a bumped file kept at the
// same name is pinned in the browser cache and the app silently runs stale code after an update. This
// also verifies assetVersion folds in the vendored scripts' mtimes, so the token actually changes when a
// vendored library changes. `/ws/socket.io.js` is exempt: socket.io serves its own client with an
// ETag/revalidation, not under the immutable static rule. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  const viewsDir = path.join(PROJECT, 'lib', 'views');
  const views = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ejs')) views.push(full);
    }
  };
  walk(viewsDir);
  ok(views.length > 0, 'found EJS views to scan');

  // Every /vendor, /js, /css, and /fonts asset reference must carry a ?v= query (socket.io's /ws client is
  // exempt). /fonts covers the editable fonts.css @font-face manifest, which is served immutable like the rest;
  // the .woff2 binaries it url()-references are not linked from the HTML and are truly immutable (a new weight
  // is a new filename), so only the manifest needs a token.
  const assetRef = /(?:src|href)="(\/(?:vendor|js|css|fonts)\/[^"]+)"/g;
  let scanned = 0;
  for (const v of views) {
    const html = fs.readFileSync(v, 'utf-8');
    let m;
    while ((m = assetRef.exec(html)) !== null) {
      const url = m[1];
      scanned++;
      ok(/\?v=/.test(url), `${path.basename(v)}: ${url} carries a ?v= cache-busting query`);
    }
  }
  ok(scanned >= 3, `scanned the versioned asset references (found ${scanned})`);
  console.log(`✓ asset-cache-busting: all ${scanned} versioned asset references carry ?v=`);

  // assetVersion must include vendored scripts, so a vendored-lib bump changes the token.
  const serverSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'server.js'), 'utf-8');
  const avIdx = serverSrc.indexOf('const assetVersion = (() => {');
  ok(avIdx !== -1, 'assetVersion is computed in server.js');
  const avBlock = serverSrc.slice(avIdx, avIdx + 1600);
  ok(/walkFiles\(path\.join\(pubDir, 'vendor'\)/.test(avBlock) && /endsWith\('\.js'\)/.test(avBlock),
    'assetVersion folds in the vendored scripts\' mtimes via the shared walker (a vendored bump changes the token)');
  console.log('✓ asset-cache-busting: assetVersion tracks vendored script changes');

  // ── The boot-time vendor refresh is quiet in production: the vendored file ships committed, and its source
  //    package (e.g. marked) is a devDependency not installed in Docker/production, so a refresh that can't
  //    resolve the source must skip SILENTLY when the vendored file already exists — not warn on every boot. ──
  const cinIdx = serverSrc.indexOf('const copyIfNeeded =');
  ok(cinIdx !== -1, 'copyIfNeeded exists');
  const cinBlock = serverSrc.slice(cinIdx, cinIdx + 1500);
  ok(/const destExists = fsSync\.existsSync\(dest\)/.test(cinBlock), 'copyIfNeeded checks whether the vendored file already exists');
  ok(/catch\s*\{\s*\n\s*if \(!destExists\) console\.warn/.test(cinBlock),
    'an unresolvable source package warns ONLY when the vendored file is missing (silent in production where it ships)');
  ok(!/run: npm install -S/.test(cinBlock), 'no longer tells production to install a devDependency as a prod dependency');
  console.log('✓ asset-cache-busting: the vendor refresh is silent in production when the committed file is present');

  console.log(`\nALL ASSET-CACHE-BUSTING UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ ASSET-CACHE-BUSTING UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
