'use strict';
// Guards the local credibility flags: preprint hosts/DOIs and retraction/concern language are advisory labels,
// computed once at index time and carried to source pills. Pure, offline, bounded, and language-tolerant. No
// network or model. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');
const cred = require(path.join(PROJECT, 'lib', 'credibility'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };

try {
  // ── Preprint hosts and DOIs ──
  let f = cred.flagsFor({ source: 'https://www.biorxiv.org/content/10.1101/2024.01.01.123456', title: 'A study' });
  ok(f && f.flags.includes('preprint'), 'a bioRxiv URL is flagged as a preprint');
  f = cred.flagsFor({ source: 'paper.pdf', title: 'A study', text: 'doi: 10.21203/rs.3.rs-123456/v1' });
  ok(f && f.flags.includes('preprint'), 'a preprint DOI in the text is flagged');
  ok(cred.flagsFor({ source: 'https://example.org/article', title: 'A study', text: 'ordinary prose' }) === null,
    'an ordinary source has no flags');

  // ── Retraction and concern, including multilingual phrases ──
  for (const text of [
    'This article has been retracted by the publisher.',
    'Retraction notice: the findings could not be reproduced.',
    'The article was retracted in 2024.',
    'Este artículo ha sido retractado por la revista.',
    'Cet article a été rétracté par la revue.',
    'この論文は取り下げられました。',
    'Статья отозвана редакцией.',
  ]) {
    const r = cred.flagsFor({ source: 'paper.pdf', title: 'A study', text });
    ok(r && r.flags.includes('retraction'), `retraction language is flagged: ${text.slice(0, 30)}`);
  }
  f = cred.flagsFor({ source: 'paper.pdf', title: 'A study', text: 'The journal issued an expression of concern.' });
  ok(f && f.flags.includes('concern') && !f.flags.includes('retraction'), 'an expression of concern is its own flag');

  // ── Labels are present for every flag and bounded ──
  f = cred.flagsFor({ source: 'https://arxiv.org/abs/1234.5678', title: 'Preprint', text: 'This article has been retracted.' });
  ok(f.flags.includes('preprint') && f.flags.includes('retraction'), 'flags can combine');
  ok(f.labels.length === f.flags.length && f.labels.every((l) => typeof l === 'string' && l.length > 0),
    'every flag has a human label');
  ok(Array.isArray(f.shortLabels) && f.shortLabels.length === f.flags.length && f.shortLabels.every((l) => l && l.length < 20),
    'every flag has a short pill label from the same catalog');
  ok(cred.flagsFor(null) === null && cred.flagsFor({}) === null, 'missing input is handled safely');

  // ── Wiring: metadata at index time, source builders, session persistence, client pill ──
  const files = read('lib/indexing/files.js');
  ok(/require\('\.\.\/credibility'\)\.flagsFor\(\{ source: filePath, title: path\.basename\(filePath\), text: content \}\)/.test(files)
    && /metadata\.credibility = credibility/.test(files),
    'the indexer stores credibility flags with the document metadata');
  const search = read('lib/retrieval/search.js');
  ok(/entry\.metadata\.credibility \? \{ credibility: entry\.metadata\.credibility \}/.test(search),
    'local sources carry the stored flags');
  const webanswer = read('lib/retrieval/webanswer.js');
  ok(/credibility'\)\.flagsFor\(\{ source: r\.url, title: r\.title, text: r\.text \}\)/.test(webanswer),
    'web sources compute the same flags locally');
  const sessions = read('lib/sessions.js');
  ok(/s\.credibility && Array\.isArray\(s\.credibility\.flags\)/.test(sessions),
    'restored session sources keep their flags');
  const chat = read('lib/public/js/chat.js');
  ok(/function appendSources[\s\S]{0,900}?pill-cred/.test(chat) && /src\.preview|src-preview-cred/.test(chat),
    'the client shows a source pill tag and a preview label');
  ok(/shortLabels/.test(chat) && !/const CRED_LABEL =/.test(chat),
    'the client reads the short label from the server catalog, rather than keeping a second flag map');
  ok(/shortLabels: \(s\.credibility\.shortLabels \|\| \[\]\)/.test(read('lib/sessions.js')),
    'restored sessions keep the short labels for the pill');
  const css = read('lib/public/css/app.css');
  ok(/\.source-pill \.pill-cred/.test(css) && /\.src-preview-cred/.test(css),
    'the credibility labels have dedicated, theme-variable styles');

  console.log(`\nALL CREDIBILITY UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ CREDIBILITY UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
