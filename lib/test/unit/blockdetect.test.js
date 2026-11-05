'use strict';
// Guards content-based bot-wall detection (lib/blockdetect.js): a challenge/access-denied page served
// with HTTP 200 is recognized from its content, while real articles — even ones that mention a bot-wall
// vendor in passing — are never flagged. Also checks it is wired into the web-search and URL-ingest paths.
// Pure/offline. Run: `npm run test:unit` (or `node lib/test/unit/blockdetect.test.js`).

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { looksBlocked, MAX_BLOCK_LEN } = require(path.join(PROJECT, 'lib', 'blockdetect'));
const read = (...p) => fs.readFileSync(path.join(PROJECT, ...p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // ── Real block pages are flagged ──
  ok(looksBlocked('<html><head><title>Just a moment...</title></head><body><div class="cf-browser-verification">Checking your browser before accessing the site.</div></body></html>'),
    'a Cloudflare "just a moment" challenge is flagged');
  ok(looksBlocked('<html><body><script src="https://ct.datadome.co/c.js"></script><h1>Access denied</h1></body></html>'),
    'a DataDome / access-denied wall is flagged');
  ok(looksBlocked('<html><body><div class="g-recaptcha"></div>Verify you are human</body></html>'),
    'a reCAPTCHA human-check gate is flagged');
  ok(looksBlocked('<html><body>Please enable cookies.</body></html>'),
    'a short "please enable cookies" wall is flagged');

  // ── Real content is NOT flagged, even when it mentions a vendor ──
  const article = '<html><body><article>' + ('This is a long, genuine article about web security. '.repeat(120))
    + ' It discusses how Cloudflare and hCaptcha and datadome protect sites from bots. ' + ('More real prose here. '.repeat(80))
    + '</article></body></html>';
  ok(article.replace(/<[^>]+>/g, ' ').trim().length > MAX_BLOCK_LEN, 'the article fixture is genuinely long');
  ok(!looksBlocked(article), 'a long article that merely mentions Cloudflare/hCaptcha/DataDome is NOT flagged');
  ok(!looksBlocked(''), 'empty input is not a block');
  ok(!looksBlocked('<html><body><p>A short but ordinary page with no wall markers at all.</p></body></html>'),
    'a short ordinary page with no markers is not a block');

  // ── CPU bound: a huge body does not hang and is treated as real (plenty of visible text up front) ──
  const huge = '<p>' + ('lorem ipsum dolor sit amet '.repeat(200000)) + '</p>';
  const t0 = Date.now();
  ok(!looksBlocked(huge), 'a multi-MB real body is not flagged');
  ok(Date.now() - t0 < 1000, 'detection stays fast on a huge body (scan is bounded)');

  // ── ADVERSARIAL: hostile markup must not trigger quadratic stripping (regression guard). A regex strip
  //    froze the event loop for ~30s on these; the linear strip handles them in a few ms. Bound generously. ──
  for (const [label, s] of [
    ['many unterminated <', '<'.repeat(256 * 1024)],
    ['many open <a', '<a'.repeat(128 * 1024)],
    ['many <script', '<script'.repeat(40000)],
  ]) {
    const t = Date.now();
    looksBlocked(s);
    ok(Date.now() - t < 500, `hostile input (${label}) is handled in well under a second (no quadratic stall)`);
  }

  // ── Language-agnostic: a non-English challenge page is still caught by its vendor code token, not English ──
  const germanWall = '<html><body><div class="cf-browser-verification">Einen Moment bitte, Ihre Anfrage wird überprüft.</div></body></html>';
  ok(looksBlocked(germanWall), 'a non-English (German) Cloudflare wall is flagged via the language-agnostic code token');
  const japaneseWall = '<html><body><script src="https://ct.datadome.co/c.js"></script><p>アクセスが拒否されました。</p></body></html>';
  ok(looksBlocked(japaneseWall), 'a Japanese-text DataDome wall is flagged via the vendor token');
  // And a short non-English REAL page with no wall markers is not flagged.
  ok(!looksBlocked('<html><body><p>これは普通の短い日本語のページです。</p></body></html>'), 'a short ordinary Japanese page is not flagged');

  // ── Wired into the fetch paths ──
  const ws = read('lib', 'websearch.js');
  ok(/require\('\.\/blockdetect'\)\.looksBlocked\(html\)/.test(ws), 'web search treats a bot-check search page as a failure');
  ok(/require\('\.\/blockdetect'\)\.looksBlocked\(raw\)/.test(ws), 'a result page that is a bot-wall is not ingested');
  const uf = read('lib', 'urlfetch.js');
  ok(/looksBlocked\(html\)/.test(uf) && /bot-check \/ access wall/.test(uf), 'URL ingestion rejects a bot-wall page instead of indexing it');
  ok(/recordExit\(proxyUrl, html \? \(blocked \? 'blocked' : 'ok'\) : 'dead'\)/.test(uf), 'a blocked page records the exit as blocked (reachable), not dead');

  console.log(`\nALL BLOCKDETECT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ BLOCKDETECT UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
