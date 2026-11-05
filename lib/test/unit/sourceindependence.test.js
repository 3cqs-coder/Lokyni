'use strict';
// Functional tests for source-independence analysis (lib/sourceindependence.js). The module is pure, so the
// clustering and de-duplication are tested directly: resolve a registrable domain, measure near-duplicate
// text, count independent sources, and collapse syndicated copies while keeping distinct same-site pages.
// Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const si = require(path.join(PROJECT, 'lib', 'sourceindependence'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

try {
  // ── registrableDomain ──
  eq(si.registrableDomain('https://www.example.com/page'), 'example.com', 'strips www and path');
  eq(si.registrableDomain('https://sub.example.com/x'), 'example.com', 'a subdomain maps to the publisher');
  eq(si.registrableDomain('https://news.bbc.co.uk/story'), 'bbc.co.uk', 'multi-label suffix handled');
  eq(si.registrableDomain('https://example.co.uk'), 'example.co.uk', 'bare multi-label domain');
  eq(si.registrableDomain('not a url'), '', 'unparseable URL -> empty (treated as unknown/independent)');

  // ── shingles / jaccard ──
  const a = si.shingles('the quick brown fox jumps over the lazy dog');
  const b = si.shingles('the quick brown fox jumps over the lazy dog');
  eq(si.jaccard(a, b), 1, 'identical text -> Jaccard 1');
  const c = si.shingles('completely different words here with nothing shared at all friend');
  ok(si.jaccard(a, c) < 0.1, 'disjoint text -> near-zero Jaccard');
  eq(si.jaccard(si.shingles(''), a), 0, 'empty text -> 0 (no throw)');

  // ── analyze: independent count ──
  const dup = 'Breaking: the central bank raised rates today in a widely expected move by analysts everywhere.';
  const r1 = si.analyze([
    { url: 'https://a.com/1', text: dup },
    { url: 'https://mirror.org/1', text: dup },          // syndicated copy of the same text
    { url: 'https://b.com/x', text: 'A totally separate article about gardening tomatoes in spring soil beds.' },
  ]);
  eq(r1.total, 3, 'counts all sources');
  eq(r1.independent, 2, 'two independent sources (the syndicated pair collapses to one)');
  eq(r1.dependent, 1, 'one dependent (duplicate) source');

  const r2 = si.analyze([
    { url: 'https://site.com/a', text: 'alpha one two three four five six seven' },
    { url: 'https://site.com/b', text: 'beta eight nine ten eleven twelve thirteen fourteen' },   // same domain, different text
  ]);
  eq(r2.independent, 1, 'same publisher under two paths counts as one independent source');

  // ── dedupeByContent: collapse syndicated copies, keep distinct ──
  const items = [
    { url: 'https://a.com/1', text: dup },
    { url: 'https://mirror.org/1', text: dup },                                  // near-duplicate -> dropped
    { url: 'https://site.com/a', text: 'alpha one two three four five six seven eight' },
    { url: 'https://site.com/b', text: 'beta nine ten eleven twelve thirteen fourteen fifteen' },   // same domain, DIFFERENT text -> kept
  ];
  const d = si.dedupeByContent(items);
  eq(d.dropped, 1, 'one near-duplicate copy dropped');
  eq(d.kept.length, 3, 'distinct pages (including two different pages on one site) are kept');
  eq(d.kept[0].url, 'https://a.com/1', 'the FIRST (best-ranked) copy of a duplicate survives');
  ok(d.kept.some(x => x.url === 'https://site.com/a') && d.kept.some(x => x.url === 'https://site.com/b'),
    'same-site but different-content pages are NOT collapsed');

  // Edge cases: empty / single / no-text never throw and never drop.
  eq(si.dedupeByContent([]).kept.length, 0, 'empty input -> empty kept');
  eq(si.dedupeByContent([{ url: 'https://x.com', text: 'solo' }]).dropped, 0, 'single item -> nothing dropped');

  // ── summarize ──
  eq(si.summarize(r1), '3 sources, 2 independent', 'summarize reports the honest count');
  eq(si.summarize({ total: 3, independent: 3, dependent: 0, clusters: [] }), '', 'all-independent -> no note');

  // ── statsFor: the compact summary attached to an answer's sources row ──
  const st = si.statsFor([
    { url: 'https://a.com/1', text: dup },
    { url: 'https://mirror.org/1', text: dup },
    { url: 'https://b.com/x' },
  ]);
  eq(st.total, 3, 'statsFor counts every source');
  eq(st.independent, 2, 'statsFor groups the syndicated pair');
  ok(/3 sources, 2 independent/.test(st.summary), 'statsFor produces the display summary');
  const allIndependent = si.statsFor([{ url: 'https://a.com/1' }, { url: 'https://b.com/2' }]);
  eq(allIndependent.independent, 2, 'different publishers stay independent');
  eq(allIndependent.summary, '', 'all-independent -> no display suffix');
  eq(si.statsFor([{ source: 'a.pdf' }]), null, 'a single source needs no summary');
  const local = si.statsFor([
    { source: 'a.pdf', viewerLink: '/document/view?path=a.pdf' },
    { source: 'b.docx', viewerLink: 'http://localhost:7887/document/view?path=b.docx' },
  ]);
  eq(local.total, 2, 'local documents are counted');
  eq(local.independent, 2, 'local documents without a URL are independent by default');
  eq(si.statsFor(null), null, 'a missing list is handled safely');

  // ── Near-duplicate detection is language-agnostic (the shingler tokenizes Unicode, not just ASCII) ──
  // Two identical non-Latin articles on different domains are one syndicated copy, not two independent sources.
  const ruText = 'Вереслав Томичев сообщил о новом протоколе гравиметрического метода измерения мутности осадка в реке сегодня.';
  const ru = si.statsFor([
    { url: 'https://a.example/x', title: 't', snippet: ruText },
    { url: 'https://b.example/y', title: 't', snippet: ruText },
    { url: 'https://c.example/z', title: 't', snippet: 'Совершенно другая тема про домашнее сетевое оборудование и настройку маршрутизаторов.' },
  ]);
  eq(ru.independent, 2, 'two identical Cyrillic articles collapse to one source (ASCII-only shingling would have said 3)');
  // Same, for a CJK (spaceless) script — the tokenizer emits bigrams, so near-dupes still cluster.
  const jaText = '勾配測定プロトコルは川の堆積物の濁りを新しい重量法で測定することを報告した。';
  const ja = si.statsFor([
    { url: 'https://d.example/1', title: 't', snippet: jaText },
    { url: 'https://e.example/2', title: 't', snippet: jaText },
  ]);
  eq(ja.independent, 1, 'two identical Japanese articles collapse to one source (spaceless script still de-duplicated)');
  console.log('✓ source-independence: near-duplicate detection works across non-Latin and spaceless scripts');

  console.log(`\nALL SOURCE-INDEPENDENCE TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ SOURCE-INDEPENDENCE UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
