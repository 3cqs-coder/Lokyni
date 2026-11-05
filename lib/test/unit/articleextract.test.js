'use strict';
// Guards off-thread article extraction (lib/articleextract.js + lib/articleextractcore.js). The extractor
// parses a DOM synchronously, so it runs in a worker through the shared supervisor and can be terminated on
// a timeout instead of freezing the event loop. The pure core is shared by the worker and the inline
// fallback. This test does a REAL off-thread round-trip (so it holds the loop with a ref'd timer, since the
// worker is unref'd), checks the output cap and surrogate-safe truncation, and source-guards the wiring and
// the fallback policy. Synthetic content. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const ae = require(path.join(PROJECT, 'lib', 'articleextract'));
const core = require(path.join(PROJECT, 'lib', 'articleextractcore'));
const read = (...p) => fs.readFileSync(path.join(PROJECT, ...p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

// The worker and its request timer are unref'd (so they never hold the process open in production), so a
// ref'd timer keeps THIS test's loop alive until the async work finishes.
const keepAlive = setTimeout(() => {}, 30000);
const done = (code) => { try { ae.shutdown(); } catch {} clearTimeout(keepAlive); process.exit(code); };

(async () => {
  try {
    // ── pure core: output cap + surrogate-safe truncation (never throws) ──
    eq(core.extract === undefined, false, 'core exposes extract');
    eq(core.capText('abc', 10), 'abc', 'capText leaves short text unchanged');
    eq(core.capText('abcdef', 3), 'abc', 'capText truncates to the cap');
    // A truncation that would land mid-surrogate drops the lone high surrogate (stays valid UTF-16).
    const emoji = '\u{1F600}\u{1F600}';                 // two astral code points = four UTF-16 units
    const capped = core.capText(emoji, 3);              // 3 units would split the second pair
    ok(!/[\ud800-\udbff]$/.test(capped), 'capText never leaves a dangling high surrogate');
    ok(core.MAX_CONTENT_CHARS > 0, 'a positive content cap is exported');

    // ── pure core: a parse failure / empty input yields null, never throws ──
    eq(await core.extract('', 'https://example.test/'), null, 'empty html → null');
    eq(await core.extract(null, 'https://example.test/'), null, 'null html → null (no throw)');

    // ── real off-thread round-trip: a valid article is extracted; the result content is capped ──
    const html = '<html><head><title>Synthetic Quarterly Review</title></head><body><article><h1>Synthetic Quarterly Review</h1>'
      + '<p>This is a synthetic paragraph about a fictional subject for testing extraction. </p>'.repeat(30)
      + '</article></body></html>';
    const data = await ae.extractArticle(html, 'https://example.test/review');
    ok(data && typeof data === 'object', 'extractArticle returns a data object off-thread');
    ok(/Synthetic Quarterly Review/.test(data.title || ''), 'the title is extracted');
    ok((data.content || '').length > 0 && data.content.length <= core.MAX_CONTENT_CHARS, 'content is present and within the cap');

    // ── never throws on empty / junk input, returns null ──
    eq(await ae.extractArticle('', 'https://example.test/'), null, 'empty html via the worker → null');
    ok((await ae.extractArticle('<<<not real html>>>', 'https://example.test/')) === null
       || typeof (await ae.extractArticle('<<<not real html>>>', 'https://example.test/')) === 'object', 'junk html → null or an object, never a throw');

    // ── SOURCE GUARDS: urlfetch extracts off-thread, and the fallback policy is correct ──
    const uf = read('lib', 'urlfetch.js');
    ok(/require\('\.\/articleextract'\)\.extractArticle\(/.test(uf), 'URL ingestion extracts via the off-thread manager');
    ok(!/const \{ extractFromHtml \} = require\('@extractus\/article-extractor'\)/.test(uf), 'urlfetch no longer calls the extractor inline on the main thread');
    const mgr = read('lib', 'articleextract.js');
    ok(/e\.unavailable.*core\.extract/s.test(mgr), 'falls back to inline extraction only when no worker was available');
    ok(/resourceLimits: \{ maxOldGenerationSizeMb/.test(mgr), 'the worker runs under a bounded heap (OOM-proof)');
    // The worker body posts data:null on failure (never an error) so the only non-resolution is timeout/death.
    ok(/postMessage\(\{ id: m\.id, data: data \|\| null \}\)/.test(mgr), 'the worker degrades to null, never throws across the boundary');

    console.log(`\nALL ARTICLEEXTRACT TESTS PASSED (${checks} checks)`);
    done(0);
  } catch (e) {
    console.error('\n✗ ARTICLEEXTRACT UNIT TEST FAILED:', e && e.message);
    done(1);
  }
})();
