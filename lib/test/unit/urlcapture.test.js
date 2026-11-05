'use strict';
// Guards the URL capture ladder and its content-quality gate. The plain-HTTP tier must be tried before the
// headless browser, a poor result must escalate (or fail in HTTP-only mode), and a rendered page must still be
// rejected when it is a wall or an error shell. The gate itself is language-agnostic: length/structure plus a
// small multilingual wall/not-found vocabulary. No browser, network, or model. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');
const cq = require(path.join(PROJECT, 'lib', 'contentquality'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };

const normalText = ('The project team met on Tuesday to review the new plan. ' +
  'They agreed on the budget and the delivery schedule. ' +
  'The next review is in four weeks, with a progress note before then. ').repeat(6);

try {
  // ── The pure gate ──
  ok(cq.assessHttpArticle({ title: 'Project review', text: normalText }, '<html>' + 'x'.repeat(2000) + '</html>').ok,
    'a long, structured article passes the HTTP gate');
  ok(!cq.assessHttpArticle({ title: 'Project review', text: 'Too short.' }).ok,
    'a thin page is rejected');
  ok(!cq.assessHttpArticle({ title: 'Project review', text: normalText }, '<html>' + 'x'.repeat(400000) + '</html>').ok,
    'a page that is almost all markup is rejected');
  ok(!cq.assessHttpArticle({ title: 'Just a moment…', text: 'Checking your browser before accessing the site.' }).ok,
    'a bot-check wall is rejected');
  ok(!cq.assessHttpArticle({ title: 'Page not found', text: 'The page you requested is not here. ' .repeat(20) }).ok,
    'a soft 404 is rejected');
  ok(!cq.assessHttpArticle({ title: 'Home', text: normalText }).ok,
    'a generic title is rejected');
  const cjk = '这是项目计划中非常重要的一部分内容，团队已经完成了审查。'.repeat(20);
  ok(cq.assessHttpArticle({ title: '项目计划', text: cjk }).ok,
    'a CJK article without spaces passes');
  ok(!cq.assessHttpArticle(null).ok, 'a missing article is rejected without throwing');
  eq(cq.assessHttpArticle(null).ok, false, 'assessment is total');

  // The rendered-page gate is deliberately looser (short articles are allowed) but still rejects walls/errors.
  ok(cq.assessCapturedArticle({ title: 'A short note', text: 'A short but real note.' }).ok,
    'a rendered short page is allowed');
  ok(!cq.assessCapturedArticle({ title: 'Just a moment…', text: 'Checking your browser before accessing the site.' }).ok,
    'a rendered bot wall is still rejected');
  ok(!cq.assessCapturedArticle({ title: 'Page not found', text: 'The page you requested is not here.' }).ok,
    'a rendered soft 404 is still rejected');
  ok(!cq.assessCapturedArticle({ title: 'x', text: '' }).ok, 'an empty rendered page is rejected');

  // ── The ladder and settings are wired to one another ──
  const urlfetch = read('lib/urlfetch.js');
  ok(/const fetchHttpArticle = async \(url, signal/.test(urlfetch) && /const assembleArticle = /.test(urlfetch),
    'the plain-HTTP tier and the shared article assembler exist');
  ok(/captureHint\(host\) !== 'browser'/.test(urlfetch) && /rememberCapture\(host, 'browser'\)/.test(urlfetch),
    'the per-host hint skips a doomed HTTP attempt and remembers the browser fallback');
  ok(/assessHttpArticle\(plain\.article, plain\.html\)/.test(urlfetch) && /assessCapturedArticle\(article\)/.test(urlfetch),
    'both capture tiers use the content-quality gate');
  ok(/captureHttpError\(response && typeof response\.status/.test(urlfetch),
    'the rendered tier still rejects an HTTP error before extraction');

  const schema = require(path.join(PROJECT, 'lib', 'settings-schema'));
  eq(schema.SETTINGS.urlCapture.default, 'auto', 'the capture mode defaults to auto');
  ok(schema.SETTINGS.urlCapture.writable === true, 'the capture mode is writable');
  eq(schema.SETTINGS.urlCapture.values, ['auto', 'http', 'headless'], 'the allowed modes have one source in the schema');
  ok(/SETTINGS\.urlCapture\.values/.test(read('lib/config.js')) && /SETTINGS\.urlCapture\.values\.includes/.test(read('lib/server.js')),
    'config and the settings writer both validate against the schema list');
  const cfg = require(path.join(PROJECT, 'lib', 'config'));
  ok(['auto', 'http', 'headless'].includes(cfg.urlCapture), 'the config exposes a validated capture mode');

  const server = read('lib/server.js');
  ok(/key === 'urlCapture'.*?SETTINGS\.urlCapture\.values\.includes/.test(server),
    'the settings writer rejects an unknown capture mode');
  const chat = read('lib/public/js/chat.js');
  const ejs = read('lib/views/chat.ejs');
  ok(/id="cfg-url-capture"/.test(ejs) && /cfgUrlCapture/.test(chat) && /urlCapture: cfgUrlCapture\.value/.test(chat),
    'Settings exposes and saves the capture mode');
  ok(/urlCaptureValues/.test(ejs) && /urlCaptureValues: require\('\.\/settings-schema'\)\.SETTINGS\.urlCapture\.values/.test(server),
    'the select renders its values from the schema, not a second list');

  console.log(`\nALL URL-CAPTURE UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ URL-CAPTURE UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
