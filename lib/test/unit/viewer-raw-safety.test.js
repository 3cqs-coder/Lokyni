'use strict';
// Guards the document-viewer raw-bytes route (lib/routes/viewer.js /document/raw). A raw document is
// UNTRUSTED (web clip, connector sync, upload), so the route must never let the browser RENDER an executable
// document type (.html, .svg) inline and same-origin, where its scripts would run against the app origin (and
// could pull in a companion same-origin script, bypassing the nonce CSP). It serves only a safe set (PDF for
// the viewer iframe, raster images) inline and forces every other type to download, and always sets nosniff.
// It also answers a clean 400 on a malformed percent-escape instead of a generic 500. Source inspection (the
// route serves real files behind workspace/path-traversal guards, so exercising it needs a running server).
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const src = fs.readFileSync(path.join(PROJECT, 'lib', 'routes', 'viewer.js'), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // Isolate the /raw handler body.
  const rawIdx = src.indexOf("router.get('/raw'");
  ok(rawIdx !== -1, 'the /raw route exists');
  const rawBody = src.slice(rawIdx, src.indexOf("router.get('/view'"));

  // nosniff is always set on raw responses.
  ok(/res\.setHeader\('X-Content-Type-Options', 'nosniff'\)/.test(rawBody),
    '/raw sets X-Content-Type-Options: nosniff (no MIME sniffing into an executable type)');

  // FUNCTIONAL: the classifier is now a pure, exported helper so the inline/download decision is tested
  // directly — a source-only guard would survive a logic flip that moved a dangerous type into the inline set.
  const { dispositionFor } = require(path.join(PROJECT, 'lib', 'routes', 'viewer'));
  ok(typeof dispositionFor === 'function', 'dispositionFor is exported for direct testing');
  for (const safe of ['pdf', '.pdf', 'PNG', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']) {
    ok(dispositionFor(safe) === 'inline', `${safe} is served inline (safe to render)`);
  }
  for (const danger of ['html', '.html', 'htm', 'svg', '.SVG', 'xml', 'js', 'mjs', 'xhtml', 'exe', '', 'unknown']) {
    ok(dispositionFor(danger) === 'attachment', `${danger || '(empty)'} is forced to download (never inline)`);
  }
  // The route classifies via the helper and sets the header.
  ok(/const disposition = dispositionFor\(path\.extname\(real\)\)/.test(rawBody), '/raw classifies via dispositionFor');
  ok(/res\.setHeader\('Content-Disposition'/.test(rawBody), '/raw sets a Content-Disposition header');
  // It builds that header via the SHARED RFC 6266 helper, so a non-ASCII document name downloads with its real
  // name (filename*=UTF-8''…) instead of being mangled by encodeURIComponent into a quoted filename= value.
  ok(/require\('\.\.\/contentdisposition'\)\.contentDisposition\(path\.basename\(real\), disposition\)/.test(rawBody),
    '/raw encodes the filename via the shared contentDisposition helper (RFC 6266, non-ASCII-safe)');
  ok(!/encodeURIComponent\(path\.basename\(real\)\)/.test(rawBody), '/raw no longer percent-mangles the name into the quoted filename= value');

  // Both handlers guard decodeURIComponent so a malformed escape is a clean 400, not a 500.
  const decodeGuards = (src.match(/try \{ abs = path\.resolve\(decodeURIComponent\(filePath\)\); \}\s*catch \{ return res\.status\(400\)/g) || []).length;
  ok(decodeGuards === 2, 'both /raw and /view answer 400 on a malformed percent-escape (not a generic 500)');

  console.log('✓ viewer-raw-safety: untrusted raw documents download (not inline-render); nosniff set; malformed path is a 400');

  // The viewer shows the CURRENT document (a fresh extraction of the live file), so it never shows stale text
  // or the model-written blocks the index appends. The one exception: when a citation highlight range falls
  // BEYOND the extracted body (it points into an appended summary/figure block), it renders the indexed content
  // so that highlight resolves. It stays scoped to the active workspace and bounds the rendered size.
  ok(/processFileContent\(buffer, ext\)/.test(src), 'the viewer renders a fresh extraction of the live file by default');
  ok(/highlight && content != null && highlight\.end > content\.length && docId && wsId === state\.workspaceId/.test(src),
    'the viewer uses the indexed content only when a highlight falls beyond the fresh body (appended-block citation)');
  ok(/state\.parentMap\.get\(docId\)/.test(src) && /entry\.content\.length >= highlight\.end/.test(src),
    'the indexed-content fallback is scoped and range-checked (offsets resolve, no over-read)');
  ok(/content == null \|\| content\.length > VIEWER_MAX_BYTES/.test(src),
    'the viewer bounds the rendered size so a huge document cannot block the event loop');
  console.log('✓ viewer-raw-safety: shows the live document; indexed content only to resolve an appended-block highlight');

  console.log(`\nALL VIEWER-RAW-SAFETY UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ VIEWER-RAW-SAFETY UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
