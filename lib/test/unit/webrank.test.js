'use strict';
// Unit tests for the web-result source prior (lib/retrieval/webrank.js): domain-authority
// tiers, best-effort recency parsing, the composite ordering, and the safety guarantees
// (only reorders, never drops; input array untouched; empty/single inputs pass through).
// Pure logic — no network. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { rankWebResults, _domainScore, _recencyScore } = require(path.join(PROJECT, 'lib', 'retrieval', 'webrank'));

try {
  // ── Domain authority tiers ──
  assert.ok(_domainScore('https://cdc.gov/x')       === 1.0, '.gov top tier');
  assert.ok(_domainScore('https://mit.edu/y')       === 1.0, '.edu top tier');
  assert.ok(_domainScore('https://en.wikipedia.org/z') === 1.0, 'trusted reference top tier');
  assert.ok(_domainScore('https://example.org/a')   === 0.7, '.org mid tier');
  assert.ok(_domainScore('https://www.pinterest.com/p') <= 0.1, 'content-farm/social demoted');
  assert.ok(_domainScore('https://randomblog.io')   === 0.4, 'generic base tier');
  console.log('✓ webrank: domain-authority tiers');

  // ── Recency (best-effort from snippet dates) ──
  const now = new Date(2024, 5, 1).getTime();
  assert.ok(_recencyScore('3 days ago — foo', now) === 1.0, 'recent = 1.0');
  assert.ok(_recencyScore('2024-05-30 update', now) > 0.9, 'ISO date recent');
  assert.ok(_recencyScore('Jan 5, 2024 — bar', now) > 0 && _recencyScore('Jan 5, 2024 — bar', now) < 1, 'older date decays');
  assert.strictEqual(_recencyScore('no date here', now), 0, 'no date → 0, not a guess');
  console.log('✓ webrank: recency parsing + decay');

  // ── Ordering: authoritative + on-topic rise; spam sinks ──
  const q = 'python asyncio event loop';
  const input = [
    { title: 'SEO spam',            url: 'https://contentfarm.biz/x',  snippet: 'buy now cheap' },
    { title: 'asyncio docs',        url: 'https://docs.python.org/3/library/asyncio.html', snippet: 'The asyncio event loop is the core of every asyncio application.' },
    { title: 'Pinterest board',     url: 'https://www.pinterest.com/asyncio', snippet: 'python asyncio event loop pins' },
  ];
  const snapshot = JSON.stringify(input);
  const ranked = rankWebResults(q, input);
  assert.strictEqual(ranked.length, input.length, 'never drops a result');
  assert.strictEqual(ranked[0].url, 'https://docs.python.org/3/library/asyncio.html', 'authoritative + on-topic ranks first');
  assert.strictEqual(ranked[ranked.length - 1].url, 'https://contentfarm.biz/x', 'off-topic spam ranks last');
  assert.strictEqual(JSON.stringify(input), snapshot, 'input array is not mutated');
  console.log('✓ webrank: ordering favors authority+relevance, input untouched');

  // ── Safety on trivial inputs ──
  assert.deepStrictEqual(rankWebResults(q, []), [], 'empty stays empty');
  assert.strictEqual(rankWebResults(q, [input[0]]).length, 1, 'single passes through');
  console.log('✓ webrank: empty/single inputs safe');

  console.log('\nALL WEBRANK UNIT TESTS PASSED');
  process.exit(0);
} catch (e) {
  console.error('\n✗ WEBRANK UNIT TEST FAILED:', e.message);
  process.exit(1);
}
