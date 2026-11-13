'use strict';
// Single source of truth for the speech-to-text audio parameters that several layers must agree on exactly.
// These are ONE decision each, and every site that touches audio for transcription derives from here — no site
// carries its own copy:
//
//   SAMPLE_RATE       the rate the STT core consumes (16 kHz mono Float32). The browser resamples the microphone
//                     to it before sending raw PCM (lib/public/js/chat.js, via the projected copy below), the
//                     media-file decoder targets it (lib/indexing/ffmpeg.js), and the streaming media ingester
//                     resamples to it (lib/indexing/audioingest.js). The server transcriber's feature extractor
//                     assumes exactly it (lib/voice/sttcore.js). If any two disagreed, transcription would
//                     silently degrade to garbage or empty with no error — so the value lives here once.
//   MAX_AUDIO_SECONDS the hard cap on audio accepted per transcription request (longer input is truncated, never
//                     rejected). The browser auto-stops a recording at this length so a left-on mic cannot grow
//                     unbounded, and the server truncates to it as an OOM bound. A silent mismatch would drop the
//                     tail of a long utterance with no feedback, so it too lives here once.
//
// Projected to the browser through lib/settings-schema.js CLIENT_SETTINGS.audio, so the client reads the same
// numbers the server uses instead of hardcoding a second copy. This module is a zero-dependency leaf (like
// system-voices and ocr-languages) so the schema can import it without pulling in the model runtime.
//
// NOTE: these are STT-side values. Text-to-speech uses its own, different rate and cap (lib/voice/ttscore.js,
// 24 kHz / 600 s) — a separate decision, deliberately not shared with these.

const SAMPLE_RATE = 16000;        // Whisper's feature-extractor rate: 16 kHz mono Float32 PCM
const MAX_AUDIO_SECONDS = 120;    // 2 minutes; longer audio is truncated to this, never rejected

module.exports = Object.freeze({ SAMPLE_RATE, MAX_AUDIO_SECONDS });
