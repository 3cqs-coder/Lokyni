'use strict';
// Guards two wire contracts the FRONTEND and BACKEND must agree on exactly, where a mismatch fails SILENTLY (no
// error, just wrong behavior) — so a drift guard in CI is the only real protection.
//
//  1. STT AUDIO PARAMETERS (lib/voice/audioparams.js). The browser resamples the microphone to SAMPLE_RATE and
//     auto-stops at MAX_AUDIO_SECONDS; the server transcriber consumes exactly that rate and truncates at that
//     cap; the media-file decoder and ingester also target the rate. If any copy drifted, transcription would
//     degrade to garbage/empty, or a long clip's tail would be dropped, with no error. The value lives once in
//     audioparams.js, is projected to the page via settings-schema CLIENT_SETTINGS.audio, and every other site
//     imports it. This test fails if any site re-inlines the literal.
//
//  2. FAITHFULNESS VERDICT VOCABULARY. lib/trust/faithfulness.js grades each claim 'supported' | 'partial' |
//     'unsupported' and sends it over the socket; lib/public/js/chat.js branches on those exact strings to tag
//     and count claims. A server rename would make the client silently mis-tag every affected claim. This test
//     fails if the client compares a verdict the server does not emit, or the server emits one the client never
//     references.
//
// Pure static analysis, no module executed beyond requiring the two source-of-truth modules. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(PROJECT, ...p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // ── 1. STT audio parameters ──
  const audio = require(path.join(PROJECT, 'lib', 'voice', 'audioparams'));
  ok(audio.SAMPLE_RATE === 16000 && audio.MAX_AUDIO_SECONDS === 120, 'audioparams holds the expected STT values');

  const schema = require(path.join(PROJECT, 'lib', 'settings-schema'));
  ok(schema.CLIENT_SETTINGS.audio === audio || JSON.stringify(schema.CLIENT_SETTINGS.audio) === JSON.stringify(audio),
    'settings-schema projects audioparams verbatim as CLIENT_SETTINGS.audio (client reads the same numbers)');

  // Every backend site that needs the rate imports it from audioparams — none re-inlines 16000 for STT audio.
  for (const f of ['lib/voice/sttcore.js', 'lib/indexing/audioingest.js', 'lib/indexing/ffmpeg.js']) {
    const src = read(f);
    ok(/require\(['"][^'"]*\/audioparams['"]\)/.test(src), `${f} imports the shared audioparams`);
    ok(!/=\s*16000\b/.test(src), `${f} does not re-inline the 16000 sample-rate literal`);
  }
  // sttcore also carries the cap; it must come from the shared module too.
  ok(!/=\s*120\b/.test(read('lib/voice/sttcore.js').replace(/CHUNK_LENGTH_S[^\n]*/g, '')),
    'sttcore does not re-inline the 120-second audio cap');

  // The client reads both from the projected SETTINGS_META.audio, not a hardcoded assignment.
  const chat = read('lib/public/js/chat.js');
  ok(/SETTINGS_META\.audio\s*&&\s*SETTINGS_META\.audio\.SAMPLE_RATE/.test(chat), 'chat.js reads SAMPLE_RATE from the projected audio block');
  ok(/SETTINGS_META\.audio\s*&&\s*SETTINGS_META\.audio\.MAX_AUDIO_SECONDS/.test(chat), 'chat.js reads MAX_AUDIO_SECONDS from the projected audio block');
  ok(!/const\s+STT_SAMPLE_RATE\s*=\s*16000\b/.test(chat), 'chat.js does not hardcode STT_SAMPLE_RATE = 16000');
  ok(!/const\s+MAX_RECORD_MS\s*=\s*120000\b/.test(chat), 'chat.js does not hardcode MAX_RECORD_MS = 120000');

  // ── 2. faithfulness verdict vocabulary ──
  const VERDICTS = require(path.join(PROJECT, 'lib', 'trust', 'faithfulness')).VERDICTS;
  ok(Array.isArray(VERDICTS) && VERDICTS.length === 3, 'faithfulness exports its verdict vocabulary');
  const vset = new Set(VERDICTS);
  // (a) every verdict literal the client COMPARES against must be one the server emits.
  const compared = [...chat.matchAll(/\.verdict\s*[=!]==\s*'([a-z-]+)'/g)].map((m) => m[1]);
  ok(compared.length > 0, 'the client branches on verdict strings (sanity: found the comparisons)');
  for (const v of compared) ok(vset.has(v), `client compares verdict to '${v}', which must be a server verdict (${[...vset].join(', ')})`);
  // (b) every verdict the server emits must appear as a literal in the client, so a server rename the client did
  //     not follow fails here instead of silently mislabeling.
  for (const v of VERDICTS) ok(new RegExp(`'${v}'`).test(chat), `client references the '${v}' verdict the server can emit`);

  console.log(`\nALL WIRE-CONTRACT SINGLE-SOURCE TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ WIRE-CONTRACT SINGLE-SOURCE TEST FAILED:', e && e.message);
  process.exit(1);
}
