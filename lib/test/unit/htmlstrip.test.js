'use strict';
// Unit test for lib/htmlstrip.js stripElements — the linear whole-element remover that replaced the
// quadratic pair-matching regexes in the HTML→text strippers (websearch.js, urlfetch.js). It must:
// remove a well-formed element and its content, handle multiple/nested target tags, leave the content
// after an UNCLOSED opening tag in place (matching the old net behavior), respect tag-name boundaries,
// and — the reason it exists — process adversarial markup with thousands of unclosed tags in linear
// time instead of stalling the event loop. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { stripElements, stripTags, decodeEntities } = require(path.join(PROJECT, 'lib', 'htmlstrip'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const norm = (s) => s.replace(/\s+/g, ' ').trim();

try {
  // ── Well-formed elements are removed with their content ──
  ok(norm(stripElements('a<script>evil()</script>b', ['script'])) === 'a b', 'a script block and its content are removed');
  ok(norm(stripElements('x<style>.a{color:red}</style>y', ['style'])) === 'x y', 'a style block and its content are removed');
  ok(norm(stripElements('<SCRIPT>bad</SCRIPT>keep', ['script'])) === 'keep', 'matching is case-insensitive');
  ok(norm(stripElements('a<script src="x">z</script>b<style>q</style>c', ['script', 'style'])) === 'a b c', 'multiple target tags are all removed');

  // ── Tag-name boundaries: a longer tag that merely starts with a target name is NOT removed ──
  ok(/scripting/.test(stripElements('<scripting>keep me</scripting>', ['script'])), 'a different tag that starts with the name is left alone');

  // ── An unclosed opening tag drops only the tag, keeping following content (old net behavior) ──
  const unclosed = stripElements('before<script>after with no close', ['script']);
  ok(/after with no close/.test(unclosed), 'content after an unclosed opening tag is preserved');
  ok(!/<script>/.test(unclosed), 'the unclosed opening tag itself is removed');

  // ── Empty / non-string / no-tags inputs are safe ──
  ok(stripElements('', ['script']) === '', 'empty string is safe');
  ok(stripElements('plain text', ['script']) === 'plain text', 'text with no target tags is unchanged');
  ok(stripElements('<script>x</script>', []) === '<script>x</script>', 'no tag list means no change');

  // ── Linearity: many unclosed tags complete fast (the quadratic regex would stall here) ──
  {
    const hostile = '<script>'.repeat(200000) + 'x'.repeat(200000);   // ~2 MB, all unclosed opens
    const t0 = Date.now();
    const out = stripElements(hostile, ['script', 'style']);
    const ms = Date.now() - t0;
    ok(typeof out === 'string', 'the hostile input returns a string');
    ok(ms < 2000, `adversarial unclosed-tag input is processed in linear time (${ms} ms, well under a stall)`);
    console.log(`✓ htmlstrip: 2 MB of unclosed <script> tags stripped in ${ms} ms (linear, no event-loop stall)`);
  }

  console.log('✓ htmlstrip: removes elements + content, honors boundaries, preserves post-unclosed content');

  // ── stripTags: comment + tag removal (block tags → newline) in one linear pass ──
  ok(norm(stripTags('a<b>bold</b>c')) === 'aboldc', 'an inline tag is removed, text kept');
  ok(stripTags('one<p>two</p>three').includes('\n'), 'a block tag becomes a newline (structure survives)');
  ok(norm(stripTags('x<!-- a comment -->y')) === 'xy', 'an HTML comment and its contents are removed');
  ok(norm(stripTags('x<!-- has a > inside -->y')) === 'xy', 'a `>` inside a comment does not end the comment early');
  ok(/keep this/.test(stripTags('<div>keep this')), 'content after an unclosed block tag is preserved');
  ok(stripTags('text with a < that never closes').includes('that never closes'), 'a `<` with no closing `>` leaves the rest as text');
  ok(/unterminated text here/.test(stripTags('<!-- unterminated text here')), 'an unterminated comment (no `-->`, no `>`) leaves its text in place, matching the old strip');
  ok(norm(stripTags('<br/>line')) === 'line' && stripTags('<br/>line').includes('\n'), 'a self-closing block tag (br) becomes a newline');
  ok(stripTags('') === '' && stripTags(null) === '', 'empty/null input is safe');

  // ── Linearity: the reason stripTags exists — adversarial markup must NOT stall (old /<[^>]+>/g was O(n²)) ──
  {
    const bareLts = '<'.repeat(4_000_000);               // 4 MB of `<` with no `>` — the catastrophic /<[^>]+>/g case
    const t0 = Date.now();
    const out1 = stripTags(bareLts);
    const ms1 = Date.now() - t0;
    ok(typeof out1 === 'string', 'bare-`<` flood returns a string');
    ok(ms1 < 2000, `4 MB of bare '<' is stripped in linear time (${ms1} ms; the old /<[^>]+>/g would hang here)`);

    const openComments = '<!--'.repeat(1_000_000);        // 4 MB of unclosed comment opens — the /<!--[\\s\\S]*?-->/g case
    const t1 = Date.now();
    const out2 = stripTags(openComments);
    const ms2 = Date.now() - t1;
    ok(typeof out2 === 'string' && ms2 < 2000, `4 MB of unclosed '<!--' is stripped in linear time (${ms2} ms, latch prevents re-scan)`);
    console.log(`✓ htmlstrip: stripTags handles 4 MB adversarial markup in ${ms1}/${ms2} ms (linear — fixes the main-process hang)`);
  }

  console.log('✓ htmlstrip: stripTags removes comments + tags, block→newline, preserves post-unclosed content');

  // ── decodeEntities: named + numeric refs, astral-safe (the shared decoder every extractor now uses) ──
  ok(decodeEntities('caf&#233;') === 'café', 'decimal numeric ref decodes (é)');
  ok(decodeEntities('&#x1F600;') === '😀' && decodeEntities('&#128512;') === '😀', 'astral emoji decodes via fromCodePoint (hex and decimal) — the fromCharCode bug is gone');
  ok(decodeEntities('&#x20BB7;') === '\u{20BB7}', 'an astral CJK character decodes correctly');
  ok(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;') === 'a & b <c> "d" \'e\'', 'the predefined named entities decode');
  ok(decodeEntities('x&nbsp;y') === 'x y', 'nbsp decodes to a space');
  ok(decodeEntities('&#0; &#xD800; &#1114112;') === '� � �', 'NUL, a lone surrogate, and an over-range code point become U+FFFD');
  ok(decodeEntities('&amp;lt; stays once') === '&lt; stays once', 'a single pass does not double-decode (&amp;lt; -> &lt;)');
  ok(decodeEntities('&notareal; &amp;') === '&notareal; &', 'an unknown named entity is left as written');
  console.log('✓ htmlstrip: decodeEntities handles named + numeric refs and is astral-safe');

  console.log(`\nALL HTMLSTRIP UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ HTMLSTRIP UNIT TEST FAILED:', e && e.message, e && e.stack);
  process.exit(1);
}
