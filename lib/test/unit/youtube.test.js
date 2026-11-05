'use strict';
// YouTube transcript ingestion: the pure URL-parsing and transcript-parsing logic that turns a YouTube video
// URL into an indexable document, plus the integration guard that the URL ingest path routes YouTube links to
// the transcript fetcher. The network fetch itself is best-effort and verified separately. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const yt = require(path.join(PROJECT, 'lib', 'youtube'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // ── videoId / isYouTubeUrl across the common URL forms ──
  ok(yt.videoId('https://www.youtube.com/watch?v=Vx7Qz2Lm9Kp') === 'Vx7Qz2Lm9Kp', 'watch?v= form');
  ok(yt.videoId('https://youtu.be/Vx7Qz2Lm9Kp?t=42') === 'Vx7Qz2Lm9Kp', 'youtu.be short form (ignores &t)');
  ok(yt.videoId('https://www.youtube.com/shorts/Vx7Qz2Lm9Kp') === 'Vx7Qz2Lm9Kp', 'shorts form');
  ok(yt.videoId('https://www.youtube.com/embed/Vx7Qz2Lm9Kp') === 'Vx7Qz2Lm9Kp', 'embed form');
  ok(yt.videoId('https://m.youtube.com/watch?v=Vx7Qz2Lm9Kp&feature=share') === 'Vx7Qz2Lm9Kp', 'mobile host + extra params');
  ok(yt.videoId('https://music.youtube.com/watch?v=Vx7Qz2Lm9Kp') === 'Vx7Qz2Lm9Kp', 'music host');
  ok(yt.videoId('https://example.com/watch?v=Vx7Qz2Lm9Kp') === null, 'a non-YouTube host is not a video');
  ok(yt.videoId('https://www.youtube.com/watch?v=tooshort') === null, 'an invalid id is rejected');
  ok(yt.videoId('not a url') === null, 'a non-URL is rejected');
  ok(yt.isYouTubeUrl('https://youtu.be/Vx7Qz2Lm9Kp') === true && yt.isYouTubeUrl('https://example.com') === false,
    'isYouTubeUrl mirrors videoId');

  // ── parseTimedText: handles both srv1 (<text>) and format-3 (<p>/<s>), strips tags, decodes entities ──
  const srv1 = '<transcript><text start="0" dur="1">Hello &amp; welcome</text><text start="1" dur="1"><b>to</b> the show</text><text start="2" dur="1">  </text></transcript>';
  ok(yt.parseTimedText(srv1) === 'Hello & welcome\nto the show', `srv1 XML parses to clean lines (got ${JSON.stringify(yt.parseTimedText(srv1))})`);
  const fmt3 = '<timedtext format="3"><body><p t="1360" d="900"><s ac="0">Synthetic</s><s ac="0"> caption</s></p><p t="2260" d="900">second line here</p><p t="3000" d="1"> </p></body></timedtext>';
  ok(yt.parseTimedText(fmt3) === 'Synthetic caption\nsecond line here', `format-3 <p>/<s> parses to clean lines (got ${JSON.stringify(yt.parseTimedText(fmt3))})`);

  // ── pickTrack: prefer manual English, then manual, then English, then first ──
  ok(yt.pickTrack([{ languageCode: 'es', kind: 'asr' }, { languageCode: 'en', kind: 'asr' }, { languageCode: 'en' }]).kind === undefined
    && yt.pickTrack([{ languageCode: 'es', kind: 'asr' }, { languageCode: 'en', kind: 'asr' }, { languageCode: 'en' }]).languageCode === 'en',
    'a manual English track is preferred over auto-generated ones');
  ok(yt.pickTrack([{ languageCode: 'fr' }, { languageCode: 'de', kind: 'asr' }]).languageCode === 'fr', 'falls back to any manual track');
  ok(yt.pickTrack([{ languageCode: 'en', kind: 'asr' }]).languageCode === 'en', 'falls back to an auto English track');
  ok(yt.pickTrack([]) === null && yt.pickTrack(null) === null, 'no tracks → null');

  // ── SSRF host allowlist: only YouTube/Google hosts, and look-alikes rejected ──
  ok(yt.isAllowedCaptionHost('www.youtube.com') && yt.isAllowedCaptionHost('youtube.com'), 'youtube.com and its subdomains are allowed');
  ok(yt.isAllowedCaptionHost('r1---sn-x.googlevideo.com') && yt.isAllowedCaptionHost('video.google.com'), 'googlevideo/google subdomains are allowed');
  ok(!yt.isAllowedCaptionHost('googlevideo.com.evil.com') && !yt.isAllowedCaptionHost('youtube.com.evil.com'), 'a suffix look-alike host is rejected');
  ok(!yt.isAllowedCaptionHost('evil.com') && !yt.isAllowedCaptionHost('') && !yt.isAllowedCaptionHost(null), 'an off-platform/empty host is rejected');

  // ── SSRF: the caption-track fetch routes through the shared nethost guard, so a 3xx from the (trusted-sourced
  //    but variable) baseUrl is re-vetted per hop and pinned — the isAllowedCaptionHost allowlist is only the
  //    initial gate and is NOT defeatable by a redirect to a private/loopback/metadata address. ──
  const ytSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'youtube.js'), 'utf-8');
  ok(/fetchNoPrivateRedirect\(tUrl\.href,/.test(ytSrc), 'the caption-track fetch goes through nethost.fetchNoPrivateRedirect (per-hop vetting + pinning)');
  ok(/redirect: 'manual'/.test(ytSrc), 'the track fetch uses manual redirects so each hop is re-vetted before it is contacted');
  ok(/_readCappedText\(tRes, TRANSCRIPT_MAX_BYTES, \{ timeoutMs: TIMEOUT_MS, signal \}\)/.test(ytSrc), 'the track body read is byte-capped, time-bounded, and cancellable');

  // ── integration: the URL ingest path routes YouTube links to the transcript fetcher ──
  const urlfetch = fs.readFileSync(path.join(PROJECT, 'lib', 'urlfetch.js'), 'utf-8');
  ok(/if \(youtube\.isYouTubeUrl\(urlObj\.href\)\) return youtube\.fetchTranscript\(urlObj\.href, signal\);/.test(urlfetch),
    'fetchArticle short-circuits a YouTube URL to the transcript fetcher');

  console.log(`\nALL YOUTUBE UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ YOUTUBE UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
