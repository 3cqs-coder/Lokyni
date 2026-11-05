'use strict';
// Guards the local speech-to-text engine's non-model parts — no model download, no worker, no network — so the
// suite stays fast and deterministic:
//   • the manager's language contract (LANGUAGES codes well-formed, DEFAULT_LANGUAGE valid, isValidLanguage strict);
//   • transcribe() input/availability guards reject before any worker spawn (a non-Float32 input, and the
//     unavailable case) — so a bad call can never load the model or wedge;
//   • the core rejects a non-Float32 input synchronously (before init), keeps the speaker's own language
//     (task 'transcribe', never 'translate'), and reuses the shared offline-first loader;
//   • source guards: the route is gated on sttEnabled and streams JSON, config single-sources the language list,
//     and the worker is registered for orderly shutdown (no orphaned thread).
// Run: `npm run test:unit`.

const path = require('path'), fs = require('fs'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { SETTINGS, WRITABLE_KEYS, CLEARABLE_KEYS } = require(path.join(PROJECT, 'lib', 'settings-schema'));
const stt = require(path.join(PROJECT, 'lib', 'voice', 'stt'));
const sttcore = require(path.join(PROJECT, 'lib', 'voice', 'sttcore'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

(async () => {
  try {
    // ── language contract (manager) ──────────────────────────────────────────────────────────────────────
    ok(Array.isArray(stt.LANGUAGES) && stt.LANGUAGES.length >= 1, 'LANGUAGES is a non-empty list');
    for (const l of stt.LANGUAGES) {
      ok(/^[a-z]{2,3}$/.test(l.code), `language code ${l.code} is a short code`);
      ok(typeof l.label === 'string' && l.label.length > 0, `language ${l.code} has a human label`);
    }
    // Codes are unique (no accidental dupes that would confuse the picker).
    eq(new Set(stt.LANGUAGES.map((l) => l.code)).size, stt.LANGUAGES.length, 'language codes are unique');
    ok(stt.isValidLanguage(stt.DEFAULT_LANGUAGE), 'DEFAULT_LANGUAGE is a valid language');
    ok(stt.isValidLanguage('en'), 'isValidLanguage accepts a known code');
    ok(!stt.isValidLanguage('xx'), 'isValidLanguage rejects an unknown code');
    ok(!stt.isValidLanguage('') && !stt.isValidLanguage(null) && !stt.isValidLanguage(undefined), 'isValidLanguage rejects empty/null/undefined');
    eq(typeof stt.isAvailable(), 'boolean', 'isAvailable returns a boolean without loading the model');

    // ── transcribe() guards reject BEFORE any worker spawn ───────────────────────────────────────────────
    let threw = false;
    try { await stt.transcribe('not a Float32Array', {}); } catch (_) { threw = true; }
    ok(threw, 'manager.transcribe rejects a non-Float32 input (before spawning the worker)');
    threw = false;
    try { await sttcore.transcribe({ pcm: [1, 2, 3] }); } catch (_) { threw = true; }
    ok(threw, 'core.transcribe rejects a non-Float32 pcm synchronously (before init/model load)');

    // ── core constants ───────────────────────────────────────────────────────────────────────────────────
    eq(sttcore.SAMPLE_RATE, 16000, 'the core expects 16 kHz audio (Whisper rate)');
    ok(sttcore.MAX_AUDIO_SECONDS >= 30, 'there is a hard audio-length cap (OOM safety)');
    ok(/whisper/i.test(sttcore.MODEL_ID) && /whisper/i.test(sttcore.FALLBACK_MODEL_ID), 'primary + mirror model ids are Whisper builds');

    // ── source guards ────────────────────────────────────────────────────────────────────────────────────
    const coreSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'voice', 'sttcore.js'), 'utf-8');
    ok(/require\('\.\.\/retrieval\/modelload'\)/.test(coreSrc) && /makeLoader/.test(coreSrc), 'the core reuses the shared offline-first loader (no bespoke load lifecycle)');
    ok(/task:\s*'transcribe'/.test(coreSrc) && !/task:\s*'translate'/.test(coreSrc), "transcription keeps the speaker's language (task 'transcribe', never 'translate')");

    const routeSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'routes', 'stt.js'), 'utf-8');
    ok(/cfg\.sttEnabled !== true\) return res\.status\(403\)/.test(routeSrc), 'POST /api/stt is gated on sttEnabled (403 when off)');
    ok(/express\.raw\(/.test(routeSrc), 'the route uses a raw body parser for the PCM (not the JSON parser)');
    ok(/length % 4|% 4\)/.test(routeSrc), 'the PCM buffer is 4-byte aligned before the Float32 view');
    // Warm/status parity with TTS: the status route reports "preparing" during the one-time Whisper download.
    ok(typeof stt.isWarming === 'function', 'stt exposes isWarming() (parity with tts)');
    ok(stt.isWarming() === false, 'isWarming() is false before any warm');
    ok(/warming: stt\.isWarming\(\)/.test(routeSrc), 'the stt status route reports warming (so Settings can show "preparing the voice model…")');

    const cfgSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'config.js'), 'utf-8');
    ok(SETTINGS.sttEnabled.default === false, 'sttEnabled defaults OFF in the shared settings schema');
    ok(/flag\('sttEnabled', providerConfig\.sttEnabled\)/.test(cfgSrc), 'sttEnabled is read through the shared schema');
    ok(/sttEnabled, sttLanguage/.test(cfgSrc), 'sttEnabled/sttLanguage are exported from config');

    const serverSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'server.js'), 'utf-8');
    ok(WRITABLE_KEYS.includes('sttEnabled') && WRITABLE_KEYS.includes('sttLanguage'), 'sttEnabled/sttLanguage are in the shared writable schema');
    ok(/isValidLanguage\(val\)/.test(serverSrc), 'sttLanguage is enum-guarded on save (only a known language persists)');

    // ── microphone picker (web + desktop) ────────────────────────────────────────────────────────────────
    ok(/micDeviceId, micLabel/.test(cfgSrc), 'the preferred mic (id + label) is exported from config');
    ok(WRITABLE_KEYS.includes('micDeviceId') && WRITABLE_KEYS.includes('micLabel'), 'micDeviceId/micLabel are in the shared writable schema');
    ok(CLEARABLE_KEYS.includes('micDeviceId') && CLEARABLE_KEYS.includes('micLabel'), 'the mic preference is clearable (selecting the default resets it)');
    ok(/\.slice\(0, 256\)/.test(serverSrc), 'the stored mic id/label is length-bounded');
    const chatJs = fs.readFileSync(path.join(PROJECT, 'lib', 'public', 'js', 'chat.js'), 'utf-8');
    ok(/function voiceAudioConstraints/.test(chatJs) && /deviceId = \{ exact: voiceMicId \}/.test(chatJs), 'capture pins the chosen microphone (deviceId exact) when one is set');
    ok(/enumerateDevices/.test(chatJs) && /kind === 'audioinput'/.test(chatJs), 'the mic picker enumerates the system input devices (works in the browser and the desktop app)');
    ok(/function primeMicLabels/.test(chatJs) && /getUserMedia\(\{ audio: true \}\)/.test(chatJs) && /micLabelsPrimed/.test(chatJs), 'device NAMES are unlocked with a one-time permission prompt (labels are hidden until access is granted once)');
    ok(/function resolveMicFrom/.test(chatJs) && /d\.label === voiceMicPref\.label/.test(chatJs), 'the saved mic resolves by id, then by label across surfaces (desktop app vs browser)');
    ok(/addEventListener\('devicechange'/.test(chatJs), 'the picker refreshes when devices change (plug/unplug)');

    // ── per-answer controls survive a reload ─────────────────────────────────────────────────────────────
    ok(/function attachRestoredControls/.test(chatJs) && /restoredAnswers/.test(chatJs), 'answers rebuilt from history get their per-answer controls re-attached on reload');
    ok(/function attachAnswerReadAloud/.test(chatJs) && /row\.dataset\.answerLang/.test(chatJs), 'a restored answer gets the language-aware Read-aloud button back through the shared sweep');
    ok(/function attachReadAloudButton\(text, targetRow, detectedLang\)/.test(chatJs), 'the attach helper accepts a target row and the answer language (so it works on any restored answer, not just the last)');

    const bootSrc = fs.readFileSync(path.join(PROJECT, 'lokyni.js'), 'utf-8');
    ok(/speech-to-text worker/.test(bootSrc) && /voice\/stt'\)\.shutdown\(\)/.test(bootSrc),
      'the STT worker is registered for orderly shutdown (no orphaned thread)');

    console.log(`\nALL STT-ENGINE TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ STT-ENGINE TEST FAILED:', e && e.message);
    process.exit(1);
  }
})();
