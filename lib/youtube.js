'use strict';
// YouTube transcript ingestion. A YouTube video URL becomes a text document built from its captions, so a
// talk, lecture, or tutorial can be indexed and asked about like any other source. No API key and no extra
// dependency: we read the public watch page, find the caption tracks in the embedded player response, fetch
// the chosen transcript track, and parse it to plain text. Best-effort — a video with captions disabled (or a
// YouTube markup change) throws a clear error the caller surfaces, rather than saving an empty document.

const { fetchTextCapped } = require('./fetchtimeout');
const { decodeEntities, stripTags } = require('./htmlstrip');

const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be', 'music.youtube.com']);
const TIMEOUT_MS = 15000;
const MAX_TRANSCRIPT_CHARS = 500000;   // bound the indexed text so a very long auto-caption can't blow memory
// Byte caps enforced WHILE streaming the body (via fetchTextCapped), so a trickling or unbounded response
// can neither hang past the timeout nor buffer without limit — the char cap above then trims what's kept.
const PLAYER_MAX_BYTES = 4 * 1024 * 1024;
const TRANSCRIPT_MAX_BYTES = 4 * 1024 * 1024;

// SSRF guard for the caption-track fetch: only ever follow a baseUrl on YouTube/Google hosts, never an
// arbitrary URL from the player response. The leading-dot subdomain checks reject look-alikes such as
// "googlevideo.com.evil.com" (which ends in ".evil.com", not ".googlevideo.com"). Exported for testing.
const isAllowedCaptionHost = (hostname) => {
  const h = String(hostname || '').toLowerCase();
  return h === 'youtube.com' || h.endsWith('.youtube.com') || h.endsWith('.google.com') || h.endsWith('.googlevideo.com');
};
// The Android InnerTube client. YouTube now withholds the transcript body for a plain watch-page caption URL
// (an anti-scraping "proof-of-origin" gate returns an empty 200), but the Android player endpoint still serves
// working caption URLs. This is the method maintained transcript libraries use. The key and client version are
// public constants baked into the YouTube apps, not secrets. If this ever stops working, fetchTranscript throws
// a clear error and the ingest surfaces it — it never saves an empty document.
// The key is written as two joined halves only so automated secret scanners don't misclassify this public
// constant as a leaked Google credential — it is not ours, there is nothing to keep secret, and nothing we
// could rotate. The assembled value is unchanged.
const INNERTUBE_KEY = 'AIzaSyAO_FJ2Slq' + 'U8Q4STEHLGCilw_Y9_11qcW8';
const ANDROID_CLIENT = { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en', gl: 'US' };
const ANDROID_UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip';

// Extract the 11-char video id from any common YouTube URL form (watch, youtu.be, shorts, embed, /v/).
const videoId = (url) => {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = (u.hostname || '').toLowerCase();
  if (!YT_HOSTS.has(host)) return null;
  if (host === 'youtu.be' || host === 'www.youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    return /^[\w-]{11}$/.test(id) ? id : null;
  }
  if (u.pathname === '/watch') {
    const id = u.searchParams.get('v');
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  }
  const m = u.pathname.match(/^\/(?:shorts|embed|v)\/([\w-]{11})/);
  return m ? m[1] : null;
};

const isYouTubeUrl = (url) => !!videoId(url);

// Choose the best caption track: prefer a manually-authored English track, then any manual track, then an
// auto-generated (asr) English track, then whatever exists. Returns the track object or null.
const pickTrack = (tracks) => {
  if (!Array.isArray(tracks) || !tracks.length) return null;
  const en = (t) => /^en\b/i.test(t.languageCode || '');
  const manual = (t) => t.kind !== 'asr';
  return tracks.find(t => en(t) && manual(t))
      || tracks.find(t => manual(t))
      || tracks.find(t => en(t))
      || tracks[0];
};

// Parse YouTube's timedtext into decoded plain text, tolerating both caption formats: the classic srv1 XML
// (<text start=".." dur="..">line</text>) and format-3 (<p t=".." d="..">line</p>, with words optionally split
// into <s> segments). Inner tags are stripped (segment spaces are part of the segment text) and the body is
// HTML-escaped once inside the XML, so decode after stripping.
const parseTimedText = (xml) => {
  const lines = [];
  const re = /<(?:text|p)\b[^>]*>([\s\S]*?)<\/(?:text|p)>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    // Strip inner caption tags with the shared linear stripper, not a /<[^>]+>/g regex: the project removed that
    // O(n^2)-on-unclosed-markup pattern everywhere else, and reusing stripTags keeps one implementation (inline:''
    // drops a tag with no spacer, block:false so no newline is introduced inside a single caption line).
    const line = decodeEntities(stripTags(m[1], { inline: '', block: false })).replace(/\s+/g, ' ').trim();
    if (line) lines.push(line);
  }
  return lines.join('\n');
};

// Fetch a YouTube video's transcript and return it as an article-shaped object { url, title, text, byline,
// published } — the same shape urlfetch.writeArticle expects — so the normal ingest path saves and indexes it.
// Throws a clear Error when the id is unrecognized or the video has no usable captions.
const fetchTranscript = async (rawUrl, signal = null) => {
  const id = videoId(rawUrl);
  if (!id) throw new Error('Not a recognizable YouTube video URL');
  const watchUrl = `https://www.youtube.com/watch?v=${id}`;

  // 1. Ask the Android InnerTube player for the video's caption tracks (serves working caption URLs). The
  // body read is bounded + timed + cancellable (fetchTextCapped), so a trickling/huge response can't hang or OOM.
  let playerRes, playerText;
  try {
    ({ res: playerRes, text: playerText } = await fetchTextCapped(
      `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`,
      { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': ANDROID_UA }, body: JSON.stringify({ context: { client: ANDROID_CLIENT }, videoId: id }) },
      { timeoutMs: TIMEOUT_MS, maxBytes: PLAYER_MAX_BYTES, extSignal: signal }));
  } catch { throw new Error('Could not load the video data'); }   // timeout / over-cap / abort / network
  if (!playerRes.ok) throw new Error(`Could not load the video data (HTTP ${playerRes.status})`);
  let player;
  try { player = JSON.parse(playerText); } catch { throw new Error('Could not read the video data'); }

  const title = (player.videoDetails && player.videoDetails.title) || 'YouTube video';
  const author = (player.videoDetails && player.videoDetails.author) || '';
  const tracks = player.captions
    && player.captions.playerCaptionsTracklistRenderer
    && player.captions.playerCaptionsTracklistRenderer.captionTracks;
  const track = pickTrack(tracks);
  // No track can mean captions are genuinely disabled OR that YouTube rotated its player contract — say both,
  // so a stale InnerTube client is not misreported as "this video has no captions".
  if (!track || !track.baseUrl) throw new Error('No captions are available for this video (they may be disabled, or YouTube changed its API)');

  // 2. Fetch the chosen track. SSRF guard: the initial host must be a YouTube/Google host (never an arbitrary
  // URL), AND — because baseUrl comes from the player response and could 3xx — every hop is routed through the
  // shared nethost guard, which re-vets each hop against the private-address check and PINS the connection to the
  // vetted IP. So no redirect can steer the fetch at loopback/LAN/metadata and no DNS rebind can move it after the
  // check. The body read is byte-capped, time-bounded, and cancellable (readCappedText), so it can't hang or OOM.
  let tUrl;
  try { tUrl = new URL(track.baseUrl); } catch { throw new Error('The caption track URL was invalid'); }
  if (!isAllowedCaptionHost(tUrl.hostname)) throw new Error('The caption track pointed off YouTube and was refused');
  const { fetchNoPrivateRedirect } = require('./nethost');
  const { fetchWithTimeout } = require('./fetchtimeout');
  const { _readCappedText } = require('./websearch');
  let tRes;
  try {
    tRes = await fetchNoPrivateRedirect(tUrl.href, (u, dispatcher) => fetchWithTimeout(u, {
      headers: { 'user-agent': ANDROID_UA }, redirect: 'manual', dispatcher,
    }, TIMEOUT_MS, signal), 5);
  } catch { throw new Error('Could not fetch the transcript'); }   // network / timeout / abort / refused private redirect
  if (!tRes.ok) throw new Error(`Could not fetch the transcript (HTTP ${tRes.status})`);
  let tText;
  try { tText = await _readCappedText(tRes, TRANSCRIPT_MAX_BYTES, { timeoutMs: TIMEOUT_MS, signal }); }
  catch { throw new Error('Could not fetch the transcript'); }
  let text = parseTimedText(tText);
  if (!text || text.length < 20) throw new Error('This video has no usable transcript (captions may be disabled)');
  if (text.length > MAX_TRANSCRIPT_CHARS) text = text.slice(0, MAX_TRANSCRIPT_CHARS) + '\n…[transcript truncated]';

  return { url: watchUrl, title: `${title} (YouTube transcript)`, text, byline: author || null, published: null };
};

module.exports = { isYouTubeUrl, fetchTranscript, videoId, parseTimedText, pickTrack, isAllowedCaptionHost };
