'use strict';
// Tests the web-source credibility tier (lib/retrieval/webrank.js sourceTier) and its surfacing. The tier
// reuses the SAME domain signals as the ranking prior — it is a transparent structural hint, not a truth
// judgment — and only the notably-high/low tiers get a label so the UI stays uncluttered. The class the UI
// builds from the tier is whitelisted (never raw text). Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(PROJECT, ...p), 'utf-8');
const { sourceTier } = require(path.join(PROJECT, 'lib', 'retrieval', 'webrank'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

try {
  // ── sourceTier: official / established / forum-social / neutral ──
  eq(sourceTier('https://www.nih.gov/x').tier, 'official', '.gov is official');
  eq(sourceTier('https://mit.edu/x').tier, 'official', '.edu is official');
  eq(sourceTier('https://foo.ac.uk/x').tier, 'official', 'ac.uk is official');
  eq(sourceTier('https://en.wikipedia.org/wiki/X').tier, 'trusted', 'a well-known reference is established');
  eq(sourceTier('https://reuters.com/x').tier, 'trusted', 'a major news wire is established');
  eq(sourceTier('https://www.reddit.com/r/x').tier, 'community', 'a forum/social site is community');
  eq(sourceTier('https://medium.com/@x/y').tier, 'community', 'a self-publishing platform is community');
  eq(sourceTier('https://some-random-blog.example/x').tier, '', 'the neutral majority gets no tier (no badge)');
  eq(sourceTier('not a url').tier, '', 'an unparseable URL has no tier (no throw)');
  ok(sourceTier('https://nih.gov').label === 'official source', 'official carries a human label');

  // ── the web source pill carries the tier only when set ──
  const webanswer = read('lib', 'retrieval', 'webanswer.js');
  ok(/require\('\.\/webrank'\)\.sourceTier\(r\.url\)/.test(webanswer), 'webSource derives the tier from the URL');
  ok(/t\.tier \? \{ tier: t\.tier, tierLabel: t\.label \} : \{\}/.test(webanswer),
    'the tier is attached only when non-empty (no badge for the neutral majority)');

  // ── the preview renders it with a WHITELISTED class (never built from raw text), web-only ──
  const chat = read('lib', 'public', 'js', 'chat.js');
  ok(/\{ official: 'tier-official', trusted: 'tier-trusted', community: 'tier-community' \}\[src\.tier\] \|\| ''/.test(chat),
    'the tier CSS class is whitelisted, not interpolated from src.tier');
  ok(/const tierLabel = \(src\.isWeb && src\.tierLabel && tierCls\) \? src\.tierLabel : ''/.test(chat),
    'the tier label shows only for web sources with a known tier');
  ok(/src-preview-tier \$\{tierCls\}/.test(chat), 'the tier renders in the source preview meta row');

  // ── theme-correct styles exist for each tier ──
  const css = read('lib', 'public', 'css', 'app.css');
  ok(/\.src-preview-tier\.tier-official::before\s*\{\s*background: var\(--success\)/.test(css), 'official tier styled via a theme token');
  ok(/\.src-preview-tier\.tier-community::before\s*\{\s*background: transparent; border: 1px solid var\(--text-dim\)/.test(css),
    'community tier is a hollow dot (shape-distinct across themes) via a theme token');

  console.log(`\nALL SOURCE-CREDIBILITY TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ SOURCE-CREDIBILITY UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
