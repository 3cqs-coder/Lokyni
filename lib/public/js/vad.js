// ── vad.js — turn detection for real-time, hands-free voice ──────────────────────────────────────────────
//
// Given a stream of Float32 audio frames it makes the decisions that make a hands-free conversation feel
// natural, with no model and no dependency (fast enough for a tight audio loop, identical on every platform):
//   • speech vs silence — with an ADAPTIVE noise floor, so background noise doesn't trip it and a soft talker
//     still registers;
//   • end-of-turn (endpoint) — holds through short thinking pauses so the speaker isn't cut off mid-sentence;
//   • barge-in — confirmed only on SUSTAINED speech, so a cough or a short "mm-hm" doesn't stop the assistant.
//
// Pure and side-effect-free, so it runs the same in the browser (window.LokyniVAD) and under Node (for tests).
// A stronger acoustic VAD could later drive the speech/silence call through the `speechOverride` argument
// without changing this interface.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LokyniVAD = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Root-mean-square energy of one Float32 frame.
  function frameRms(f32) {
    if (!f32 || !f32.length) return 0;
    let sum = 0;
    for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
    return Math.sqrt(sum / f32.length);
  }

  // Words that, at the end of an utterance, usually mean the speaker is NOT done — a trailing conjunction,
  // article, preposition, pronoun, or filler. Used only for the OPTIONAL early-endpoint check at a short pause.
  // Deliberately kept INLINE, not in the shared lib/ai/data/lexicon.json: this is a different decision from the
  // retrieval word lists (acoustic end-of-turn, not topic signal), it has one consumer, and this module must stay
  // a pure, dependency-free UMD that the browser loads as a plain script — it cannot synchronously require() a
  // JSON. Moving it would force a Node copy plus a browser fallback, which is the very drift the lexicon prevents.
  // Its behavior is pinned by lib/test/unit/vad.test.js (isLikelyComplete), which loads THIS file.
  var CONTINUATION_WORDS = new Set([
    'and', 'or', 'but', 'so', 'because', 'if', 'when', 'while', 'as', 'than', 'then',
    'the', 'a', 'an', 'to', 'of', 'for', 'with', 'at', 'in', 'on', 'by', 'from', 'into',
    'about', 'over', 'under', 'my', 'your', 'our', 'their', 'i', 'we', 'they', 'he', 'she',
    'it', 'is', 'are', 'was', 'were', 'um', 'uh', 'er', 'like', 'well', 'also', 'that', 'this',
  ]);

  // Does this (partial) transcript look like a COMPLETE thought? Pure text, no model — used to decide whether
  // to answer at a short pause (complete) or keep listening (the speaker trailed off mid-thought).
  function isLikelyComplete(text) {
    var t = String(text || '').trim();
    if (!t) return false;
    if (/[.?!]["')]?$/.test(t)) return true;                 // ended a sentence
    if (/[,;:]$/.test(t)) return false;                      // trailing pause punctuation
    var words = t.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean);
    if (words.length < 2) return false;                      // too short to be a whole turn
    if (CONTINUATION_WORDS.has(words[words.length - 1])) return false;
    return true;
  }

  function createTurnDetector(opts) {
    opts = opts || {};
    var cfg = {
      minSpeechMs:    opts.minSpeechMs    || 200,    // shorter than this = a blip, ignored
      pauseSilenceMs: opts.pauseSilenceMs || 350,    // a short pause → a candidate turn end
      endSilenceMs:   opts.endSilenceMs   || 1200,   // hard end even if the sentence looks open
      maxTurnMs:      opts.maxTurnMs      || 20000,  // hard cap on one turn (bounded capture)
      bargeConfirmMs: opts.bargeConfirmMs || 150,    // sustained speech before a barge-in counts
      marginDb:       opts.marginDb       || 6,      // speech must exceed the noise floor by this
      absFloor:       opts.absFloor       || 0.008,  // absolute minimum to ever count as speech
    };
    var ratio = Math.pow(10, cfg.marginDb / 20);     // 6 dB ≈ 2×
    var st = { floor: 0.005, voiced: false, speechMs: 0, silenceMs: 0, turnMs: 0, bargeMs: 0, pauseFired: false };

    // Classify one frame, adapting the noise floor. During likely silence the floor tracks the ambient level
    // quickly; during speech it drifts up only slowly, so a rising background doesn't swallow the voice.
    function classify(rms) {
      var loud = rms > st.floor * ratio;
      st.floor = loud ? (st.floor * 0.999 + rms * 0.001) : (st.floor * 0.95 + rms * 0.05);
      if (st.floor < 0.002) st.floor = 0.002;
      return rms > st.floor * ratio && rms > cfg.absFloor;
    }

    return {
      // speaking=true → we're playing the answer and only watching for a barge-in. `speechOverride` (optional
      // bool) lets a learned VAD make the speech/silence call; omitted, the adaptive energy gate decides.
      observe: function (frame, frameMs, speaking, speechOverride) {
        var rms  = frameRms(frame);
        var gate = classify(rms); // keep the noise floor current + provide the fallback
        var speech = (speechOverride === true || speechOverride === false) ? speechOverride : gate;
        var out = { speech: speech, pause: false, endpoint: false, valid: false, bargeIn: false };

        if (speaking) {
          if (speech) { st.bargeMs += frameMs; if (st.bargeMs >= cfg.bargeConfirmMs) { out.bargeIn = true; st.bargeMs = 0; } }
          else st.bargeMs = 0;
          return out;
        }

        if (speech) { st.voiced = true; st.speechMs += frameMs; st.silenceMs = 0; st.pauseFired = false; }
        else if (st.voiced) { st.silenceMs += frameMs; }
        if (st.voiced) st.turnMs += frameMs;

        var realTurn = st.speechMs >= cfg.minSpeechMs;

        // Candidate turn-end at a short pause — fires once per pause so the caller can run a semantic
        // completeness check before deciding to answer.
        if (st.voiced && realTurn && !st.pauseFired && st.silenceMs >= cfg.pauseSilenceMs) {
          st.pauseFired = true;
          out.pause = true;
        }

        // Hard end — commit regardless (a long pause, or the max turn length). Clears the per-turn state here so
        // it fires exactly once even without an explicit reset().
        if (st.voiced && (st.silenceMs >= cfg.endSilenceMs || st.turnMs >= cfg.maxTurnMs)) {
          out.endpoint = true;
          out.valid    = realTurn;
          st.voiced = false; st.speechMs = 0; st.silenceMs = 0; st.turnMs = 0; st.pauseFired = false;
        }
        return out;
      },

      // Clear per-turn accumulators (keep the learned noise floor across turns).
      reset: function () { st.voiced = false; st.speechMs = 0; st.silenceMs = 0; st.turnMs = 0; st.bargeMs = 0; st.pauseFired = false; },

      noiseFloor: function () { return st.floor; },
    };
  }

  return { createTurnDetector: createTurnDetector, isLikelyComplete: isLikelyComplete, frameRms: frameRms };
});
