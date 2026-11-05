'use strict';
// Guards the hands-free turn detector (lib/public/js/vad.js) — the pure, model-free logic that decides when a
// spoken turn starts and ends and when the user is interrupting. It is a UMD, so it loads under Node here and as
// window.LokyniVAD in the browser. No audio hardware, no model, no network. Run: `npm run test:unit`.

const path = require('path'), fs = require('fs'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const VAD = require(path.join(PROJECT, 'lib', 'public', 'js', 'vad.js'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

// A frame whose every sample is `amp`, so its RMS equals amp (loud = speech, 0 = silence).
const frame = (amp, n = 512) => { const f = new Float32Array(n); f.fill(amp); return f; };
const FRAME_MS = 32;
const LOUD = frame(0.1), QUIET = frame(0);

try {
  // ── frameRms ─────────────────────────────────────────────────────────────────────────────────────────────
  ok(Math.abs(VAD.frameRms(LOUD) - 0.1) < 1e-6, 'frameRms of a constant 0.1 frame is 0.1');
  eq(VAD.frameRms(QUIET), 0, 'frameRms of silence is 0');
  eq(VAD.frameRms(new Float32Array(0)), 0, 'frameRms of an empty frame is 0 (no NaN)');

  // ── a full turn: speech, then a long pause → one valid endpoint ────────────────────────────────────────────
  {
    const d = VAD.createTurnDetector();
    let endpoints = 0, valid = false, sawSpeech = false;
    for (let i = 0; i < 10; i++) { const r = d.observe(LOUD, FRAME_MS, false); if (r.speech) sawSpeech = true; }  // ~320 ms speech
    for (let i = 0; i < 45; i++) { const r = d.observe(QUIET, FRAME_MS, false); if (r.endpoint) { endpoints++; valid = r.valid; } }  // ~1.4 s silence
    ok(sawSpeech, 'sustained loud frames are detected as speech');
    eq(endpoints, 1, 'a turn ends with exactly one endpoint');
    ok(valid, 'a turn with enough speech is valid');
  }

  // ── a short blip is NOT a valid turn ───────────────────────────────────────────────────────────────────────
  {
    const d = VAD.createTurnDetector();
    for (let i = 0; i < 3; i++) d.observe(LOUD, FRAME_MS, false);   // ~96 ms < minSpeechMs (200)
    let endpoint = null;
    for (let i = 0; i < 45; i++) { const r = d.observe(QUIET, FRAME_MS, false); if (r.endpoint) endpoint = r; }
    ok(endpoint && endpoint.endpoint === true && endpoint.valid === false, 'a sub-200ms blip endpoints but is not a valid turn');
  }

  // ── pure silence never produces speech or an endpoint ──────────────────────────────────────────────────────
  {
    const d = VAD.createTurnDetector();
    let any = false;
    for (let i = 0; i < 100; i++) { const r = d.observe(QUIET, FRAME_MS, false); if (r.speech || r.endpoint) any = true; }
    ok(!any, 'silence yields neither speech nor an endpoint');
  }

  // ── barge-in: while the answer is playing, SUSTAINED speech interrupts (a blip does not) ────────────────────
  {
    const d = VAD.createTurnDetector();
    let bargedOnBlip = false;
    for (let i = 0; i < 3; i++) { const r = d.observe(LOUD, FRAME_MS, true); if (r.bargeIn) bargedOnBlip = true; }   // ~96 ms < bargeConfirmMs (150)
    d.observe(QUIET, FRAME_MS, true);
    ok(!bargedOnBlip, 'a short blip over the answer is not a barge-in');
    const d2 = VAD.createTurnDetector();
    let barged = false;
    for (let i = 0; i < 8 && !barged; i++) { const r = d2.observe(LOUD, FRAME_MS, true); if (r.bargeIn) barged = true; }  // sustained
    ok(barged, 'sustained speech over the answer is a barge-in');
  }

  // ── a long turn is force-ended (bounded) ───────────────────────────────────────────────────────────────────
  {
    const d = VAD.createTurnDetector({ maxTurnMs: 300 });
    let endpoint = false;
    for (let i = 0; i < 20 && !endpoint; i++) { const r = d.observe(LOUD, FRAME_MS, false); if (r.endpoint) endpoint = true; }
    ok(endpoint, 'a turn past maxTurnMs is force-ended even without a pause (bounded capture)');
  }

  // ── isLikelyComplete (semantic end-of-turn heuristic) ──────────────────────────────────────────────────────
  ok(VAD.isLikelyComplete('What is the budget?'), 'a question that ends with ? looks complete');
  ok(VAD.isLikelyComplete('That is the whole story.'), 'a sentence ending in . looks complete');
  ok(!VAD.isLikelyComplete('tell me about the budget and'), 'a trailing conjunction looks incomplete');
  ok(!VAD.isLikelyComplete('what about'), 'a trailing preposition looks incomplete');
  ok(!VAD.isLikelyComplete('summary,'), 'trailing pause punctuation looks incomplete');
  ok(!VAD.isLikelyComplete(''), 'empty text is not complete');

  // ── source guards: the browser wires the detector + capture + barge-in + read-back ─────────────────────────
  const chatJs = fs.readFileSync(path.join(PROJECT, 'lib', 'public', 'js', 'chat.js'), 'utf-8');
  ok(/LokyniVAD\.createTurnDetector/.test(chatJs), 'the hands-free loop uses the shared turn detector');
  ok(/audioWorklet|createScriptProcessor/.test(chatJs) && /createScriptProcessor/.test(chatJs), 'capture uses an AudioWorklet with a ScriptProcessor fallback');
  ok(/bargeInHandsfree/.test(chatJs) && /stopReadAloud\(\)/.test(chatJs), 'a barge-in stops the answer playback');
  ok(/handsfreeSpeak/.test(chatJs) && /handsfreeAwaitingAnswer/.test(chatJs), 'answers are read back only for voice-originated turns');
  ok(/HF_MAX_UTTER_SECONDS/.test(chatJs), 'the captured utterance is length-capped (bounded memory)');
  const worklet = fs.readFileSync(path.join(PROJECT, 'lib', 'public', 'js', 'vad-worklet.js'), 'utf-8');
  ok(/registerProcessor\('vad-worklet'/.test(worklet), 'the AudioWorklet processor is registered');

  console.log(`\nALL VAD TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ VAD TEST FAILED:', e && e.message);
  process.exit(1);
}
