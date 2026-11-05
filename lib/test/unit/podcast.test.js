'use strict';
// Guards Audio Overview's non-model parts — no TTS model, no worker, no network — so the suite stays fast:
//   • parseDialogue turns a two-host script into ordered (speaker, text) turns, tolerant of markdown emphasis
//     and continuation lines, and ignores anything before the first speaker line;
//   • cleanForSpeech strips markdown so the voice never reads symbols aloud;
//   • the 'podcast' synthesis format exists (so the dialogue SCRIPT reuses the existing synthesis), and the
//     audio route is gated on ttsEnabled and the player/cancel wiring is in place.
// Run: `npm run test:unit`.

const path = require('path'), fs = require('fs'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const podcast = require(path.join(PROJECT, 'lib', 'voice', 'podcast'));
const { SYNTHESIS_FORMATS } = require(path.join(PROJECT, 'lib', 'api-core'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

try {
  // ── parseDialogue ────────────────────────────────────────────────────────────────────────────────────────
  const script = [
    'Audio Overview',                         // a stray title before the first speaker — ignored
    '**Alex:** Welcome to the show. Today we look at the quarterly report.',
    '**Sam:** Thanks, Alex. The headline is a fifteen percent jump in revenue.',
    'That is the biggest in two years.',      // continuation of Sam's turn (no speaker prefix)
    'Alex: Why did that happen?',             // plain "Name:" form, no markdown
    '_Sam_: Mostly the new product line.',    // underscore emphasis
  ].join('\n');
  const turns = podcast.parseDialogue(script);
  eq(turns.length, 4, 'four turns parsed (the title is ignored, the continuation is merged)');
  eq(turns[0].speaker, 'A', 'first turn is host A (Alex)');
  eq(turns[1].speaker, 'B', 'second turn is host B (Sam)');
  ok(/biggest in two years/.test(turns[1].text), 'a continuation line is merged into the current turn');
  eq(turns[2].speaker, 'A', 'the plain "Alex:" form (no markdown) is recognized');
  eq(turns[3].speaker, 'B', 'the underscore-emphasis "_Sam_:" form is recognized');
  eq(podcast.parseDialogue('').length, 0, 'empty script yields no turns');
  eq(podcast.parseDialogue('Just some prose with no speakers.').length, 0, 'prose with no speaker lines yields no turns');

  // ── host names are single-sourced from the synthesis prompt (no parser↔prompt drift) ──
  // The parser's SPEAKER_RE is built from `hosts` in synthesis-formats.json — the SAME file that tells the model
  // which names to use. Assert the field exists, the prompt prose names each host (so renaming one without the
  // other fails here), and the parser recognizes lines built from the DECLARED names, mapping host 1→A, 2→B.
  const fmt = require(path.join(PROJECT, 'lib', 'ai', 'data', 'synthesis-formats.json')).podcast;
  ok(Array.isArray(fmt.hosts) && fmt.hosts.length === 2, 'the podcast format declares exactly two host names');
  for (const h of fmt.hosts) ok(typeof fmt.task === 'string' && fmt.task.includes(h), `the prompt prose names host "${h}" (drift guard)`);
  const declared = podcast.parseDialogue(`**${fmt.hosts[0]}:** first line\n**${fmt.hosts[1]}:** second line`);
  eq(declared.length, 2, 'the parser recognizes lines built from the declared host names');
  eq(declared[0].speaker, 'A', 'the first declared host maps to voice A');
  eq(declared[1].speaker, 'B', 'the second declared host maps to voice B');

  // ── cleanForSpeech ───────────────────────────────────────────────────────────────────────────────────────
  ok(!/[*_`#>]/.test(podcast.cleanForSpeech('**Bold** and _italic_ and `code` and # heading')), 'markdown markers are stripped for speech');
  eq(podcast.cleanForSpeech('See [the report](http://x/y) for details.'), 'See the report for details.', 'link syntax keeps the visible text, drops the URL');
  eq(podcast.cleanForSpeech('  spaced   out  '), 'spaced out', 'whitespace is collapsed and trimmed');

  // ── defaults / contract ──────────────────────────────────────────────────────────────────────────────────
  ok(podcast.DEFAULT_VOICE_A && podcast.DEFAULT_VOICE_B && podcast.DEFAULT_VOICE_A !== podcast.DEFAULT_VOICE_B, 'two distinct default host voices');
  ok(podcast.MAX_TURNS >= 1 && podcast.MAX_TOTAL_SECONDS >= 60, 'turn and total-audio caps exist (bounded)');
  eq(typeof podcast.isAvailable(), 'boolean', 'isAvailable returns a boolean without loading the model');

  // ── the dialogue SCRIPT reuses the existing synthesis (a new format, grounded) ──────────────────────────────
  ok(SYNTHESIS_FORMATS.podcast && /Alex|Sam/.test(SYNTHESIS_FORMATS.podcast.task), 'a "podcast" synthesis format produces a two-host dialogue');
  ok(/do not invent/i.test(SYNTHESIS_FORMATS.podcast.task), 'the podcast script prompt enforces grounding (no invented facts)');
  eq(SYNTHESIS_FORMATS.podcast.label, 'Audio Overview', 'the format is labeled Audio Overview in the Generate menu');

  // ── source guards ────────────────────────────────────────────────────────────────────────────────────────
  const pod = fs.readFileSync(path.join(PROJECT, 'lib', 'voice', 'podcast.js'), 'utf-8');
  ok(/require\('\.\/ttscore'\)/.test(pod) && /encodeWav/.test(pod), 'the WAV encoder is reused from the TTS core (no duplicate encoder)');
  ok(/signal && signal\.aborted/.test(pod), 'synthesis checks the abort signal between turns (cancellable)');

  const route = fs.readFileSync(path.join(PROJECT, 'lib', 'routes', 'podcast.js'), 'utf-8');
  ok(/cfg\.ttsEnabled !== true\) return res\.status\(403\)/.test(route), 'POST /api/podcast is gated on ttsEnabled (403 when off)');
  ok(/res\.on\('close'.*abort|ac\.abort\(\)/.test(route) && /signal: ac\.signal/.test(route), 'the route aborts synthesis when the client disconnects/cancels');

  const chatJs = fs.readFileSync(path.join(PROJECT, 'lib', 'public', 'js', 'chat.js'), 'utf-8');
  ok(/ttsFetchAbort/.test(chatJs) && /\.abort\(\)/.test(chatJs), 'the client cancels the in-flight synth (aborts the fetch → server stops)');
  ok(/attachPodcastButton/.test(chatJs) && /\/api\/podcast/.test(chatJs), 'a "Play as podcast" control posts to /api/podcast');
  ok(/function toggleAudio/.test(chatJs), 'Read-aloud and podcast share one audio player (toggleAudio)');

  console.log(`\nALL PODCAST TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ PODCAST TEST FAILED:', e && e.message);
  process.exit(1);
}
