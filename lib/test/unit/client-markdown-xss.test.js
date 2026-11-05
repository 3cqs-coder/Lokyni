'use strict';
// Guards the client-side Markdown XSS defenses, the last line between untrusted content (uploaded or
// web-clipped documents, model output echoing them) and the browser DOM.
//
//   • The DOCUMENT VIEWER (lib/routes/viewer.js) renders .md through markdown-it into an unescaped EJS
//     sink, so its only safety is `html: false` (raw HTML escaped) plus the default link validator
//     (javascript:/vbscript:/data: neutralized). This test renders live payloads through the same
//     configuration and asserts they come out inert, and source-guards that viewer.js keeps html:false.
//   • The CHAT renderer (lib/public/js/chat.js) hardens the vendored marked with a custom renderer:
//     raw HTML escaped, images dropped to alt text, link hrefs restricted to a safe-scheme allow-list,
//     every link marked rel="noopener noreferrer". This test loads the ACTUAL vendored marked, applies
//     the same override, and fires payloads through it — then source-guards that chat.js still carries
//     each protection, so a future marked upgrade or edit that weakens the override is caught.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // ══ Document viewer: markdown-it with html:false renders untrusted markdown inert ══
  const MarkdownIt = require('markdown-it');
  const md = new MarkdownIt({ html: false, linkify: false });
  const rawHtml = md.render('Hello <img src=x onerror=alert(1)> <script>alert(2)</script>');
  ok(!/<img/i.test(rawHtml) && !/<script/i.test(rawHtml), 'viewer: raw HTML in a document is escaped, not emitted as live tags');
  ok(/&lt;img/i.test(rawHtml), 'viewer: the raw tag is HTML-escaped (rendered as inert text, so its handler never runs)');
  const jsLink = md.render('[click](javascript:alert(1))');
  ok(!/href="javascript:/i.test(jsLink), 'viewer: a javascript: link is neutralized by the default validator');
  const dataLink = md.render('[x](data:text/html,<script>alert(1)</script>)');
  ok(!/href="data:/i.test(dataLink), 'viewer: a data: link is neutralized');
  const viewerSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'routes', 'viewer.js'), 'utf-8');
  ok(/new MarkdownIt\(\{ html: false/.test(viewerSrc), 'viewer: MarkdownIt is constructed with html:false explicitly (the load-bearing default)');
  console.log('✓ client-markdown-xss: the document viewer renders untrusted markdown inert (html:false)');

  // ══ Chat renderer: the vendored marked + the chat.js override escapes HTML and sanitizes links ══
  const vendored = require(path.join(PROJECT, 'lib', 'public', 'vendor', 'marked', 'marked.umd.js'));
  const marked = new vendored.Marked();
  // Replicate chat.js's override verbatim (kept in sync by the source guards below).
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const SAFE_URL_SCHEME = /^(https?:|mailto:|tel:|#|\/(?!\/)|\.)/i;
  marked.use({ renderer: {
    html: (t) => escapeHtml(typeof t === 'string' ? t : (t && t.text) || ''),
    image: (token) => escapeHtml((token && (token.text || token.title)) || '🖼️'),
    link(token) {
      const href = (token && token.href) || '';
      const safe = SAFE_URL_SCHEME.test(String(href).trim()) ? href : '#';
      let inner;
      try { inner = this.parser.parseInline(token.tokens); } catch { inner = escapeHtml((token && token.text) || ''); }
      return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
    },
  } });

  const block = marked.parse('<img src=x onerror=alert(1)>');
  ok(!/<img/i.test(block), 'chat: a block-level raw <img> is escaped');
  const inline = marked.parse('text <b onclick=alert(1)>x</b> and <svg/onload=alert(1)>');
  ok(!/<b /i.test(inline) && !/<svg/i.test(inline) && /&lt;b onclick/i.test(inline),
    'chat: inline raw HTML is escaped to inert text (no live <b>/<svg> tags, so their handlers never run)');
  const jsA = marked.parse('[x](javascript:alert(1))');
  ok(!/href="javascript:/i.test(jsA) && /href="#"/.test(jsA), 'chat: a javascript: link href is rewritten to #');
  const protoRel = marked.parse('[x](//evil.com)');
  ok(!/href="\/\/evil\.com"/.test(protoRel), 'chat: a protocol-relative //host link is rejected');
  const img = marked.parse('![alt text](https://evil.com/beacon.png)');
  ok(!/<img/i.test(img) && /alt text/.test(img), 'chat: an image is dropped to its alt text (no network beacon)');
  const goodLink = marked.parse('[ok](https://example.com)');
  ok(/rel="noopener noreferrer"/.test(goodLink) && /target="_blank"/.test(goodLink), 'chat: a legitimate link keeps safe rel/target');
  console.log('✓ client-markdown-xss: the chat renderer escapes HTML, drops images, and sanitizes link hrefs');

  // ══ Source guards: chat.js still carries each protection (catches a drift from the replica above) ══
  const chatSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'public', 'js', 'chat.js'), 'utf-8');
  ok(/const escapeHtml = \(s\) =>/.test(chatSrc), 'chat: escapeHtml helper is present');
  ok(/const SAFE_URL_SCHEME = \/\^\(https\?:\|mailto:\|tel:\|#\|\\\/\(\?!\\\/\)\|\\\.\)\/i;/.test(chatSrc), 'chat: the safe-URL-scheme allow-list is unchanged');
  ok(/marked\.use\(\{ renderer: \{/.test(chatSrc), 'chat: the marked renderer override is installed');
  ok(/html: \(t\) => escapeHtml\(/.test(chatSrc), 'chat: the override escapes raw HTML tokens');
  ok(/image: \(token\) => escapeHtml\(/.test(chatSrc), 'chat: the override drops images to alt text');
  ok(/rel="noopener noreferrer"/.test(chatSrc), 'chat: rendered links carry rel="noopener noreferrer"');
  console.log('✓ client-markdown-xss: chat.js keeps the hardened renderer (drift guard)');

  console.log(`\nALL CLIENT-MARKDOWN-XSS UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ CLIENT-MARKDOWN-XSS UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
