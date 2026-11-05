'use strict';
// Unit test for the DuckDuckGo lite results parser (lib/websearch.js parseDdgLite). It pairs each
// result anchor with the snippet that follows it, and must (1) decode the DDG redirect to the real
// URL, (2) pair titles with the correct snippets by document order, and (3) stop scanning once it has
// the requested number of results — the bound that keeps the synchronous regex work off the whole
// (capped but still large) page so a padded or pathological listing can't stall the event loop. No
// network. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { _parseDdgLite: parseDdgLite } = require(path.join(PROJECT, 'lib', 'websearch'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

// Build one DDG-lite result block. The redirect href carries the real URL in the `uddg` param.
const block = (n) => {
  const real = `https://example.com/page${n}`;
  return `<tr><td><a rel="nofollow" href="//duckduckgo.com/l/?kh=-1&uddg=${encodeURIComponent(real)}">Result title ${n}</a></td></tr>` +
         `<tr><td class="result-snippet">Snippet body number ${n}.</td></tr>`;
};

try {
  // ── Pairing + redirect decode over a normal listing ──
  {
    const html = `<html><body>${[1, 2, 3, 4, 5].map(block).join('')}</body></html>`;
    const results = parseDdgLite(html, 3);
    eq(results.length, 3, 'returns exactly the requested number of results');
    eq(results[0].url, 'https://example.com/page1', 'the tracking redirect is decoded to the real URL');
    eq(results[0].title, 'Result title 1', 'the title is extracted and stripped');
    eq(results[0].snippet, 'Snippet body number 1.', 'each result is paired with the snippet that follows it');
    eq(results[2].url, 'https://example.com/page3', 'results stay in document order');
    console.log('✓ websearch-parse: decodes redirects and pairs titles with the following snippet');
  }

  // ── Early stop: a huge padded listing is not scanned past the requested count ──
  {
    // 2,000 result blocks, then a megabyte of trailing junk. If the parser swept the whole string it
    // would do far more work; asking for 2 results must touch only the first blocks.
    const many = Array.from({ length: 2000 }, (_, i) => block(i + 1)).join('');
    const junk = '<div>' + 'x'.repeat(1024 * 1024) + '</div>';
    const html = `<html><body>${many}${junk}</body></html>`;
    const results = parseDdgLite(html, 2);
    eq(results.length, 2, 'only the requested results are returned from a huge listing');
    eq(results[0].url, 'https://example.com/page1', 'the first result is correct');
    eq(results[1].snippet, 'Snippet body number 2.', 'the second result is paired correctly');
    console.log('✓ websearch-parse: stops scanning once the requested count is reached (bounded work)');
  }

  // ── Robustness: empty, junk, and no-result inputs are safe ──
  {
    eq(parseDdgLite('', 5).length, 0, 'empty HTML yields no results');
    eq(parseDdgLite('<html><body>no results here</body></html>', 5).length, 0, 'a page with no result anchors yields none');
    // An anchor whose uddg is not a valid URL is dropped, not returned with a broken link.
    const bad = '<a href="//duckduckgo.com/l/?uddg=not%20a%20url">Broken</a>';
    eq(parseDdgLite(bad, 5).length, 0, 'an undecodable redirect is skipped');
    // A non-http(s) redirect target (file:/data:/javascript:) is dropped — it is never fetchable AND must not
    // reach the UI as a source pill's link.
    for (const scheme of ['file:///etc/passwd', 'data:text/html,<b>x', 'javascript:alert(1)']) {
      const mal = `<a href="//duckduckgo.com/l/?uddg=${encodeURIComponent(scheme)}">Bad scheme</a><td class="result-snippet">s</td>`;
      eq(parseDdgLite(mal, 5).length, 0, `a ${scheme.split(':')[0]}: redirect target is dropped (http(s) only)`);
    }
    console.log('✓ websearch-parse: empty, result-less, malformed, and non-http(s) redirect inputs are handled safely');
  }

  console.log(`\nALL WEBSEARCH-PARSE UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ WEBSEARCH-PARSE UNIT TEST FAILED:', e && e.message, e && e.stack);
  process.exit(1);
}
