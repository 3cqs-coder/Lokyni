'use strict';
// Text-to-speech control plane — the "Read aloud" button's backend. Fully local: the answer text is synthesized
// by the Kokoro voice model in a worker thread (lib/voice/tts.js) and the WAV is streamed back for the browser
// to play. Nothing is sent to any cloud service. Gated behind the `ttsEnabled` setting (off by default, since
// the voice model is a one-time ~90 MB download), so it does nothing until a user turns it on.

const express = require('express');
const router = express.Router();
const tts = require('../voice/tts');
const { READ_ALOUD_LANGUAGES, isValidReadAloudLanguage } = require('../langdetect');
const { settingDefault } = require('../settings-schema');

// Status for the UI: is the feature on, is local synthesis possible on this install, the voice list, and the
// read-aloud language contract. `languages` is the single catalog the Settings picker renders, so the client
// never carries a second copy of the language list or its speech-region tags.
router.get('/', (req, res) => {
  const cfg = require('../config');
  res.json({
    enabled: cfg.ttsEnabled === true,
    available: tts.isAvailable(),
    downloaded: tts.isModelDownloaded(),
    warming: tts.isWarming(),
    voices: tts.VOICES,
    defaultVoice: tts.isValidVoice(cfg.ttsVoice) ? cfg.ttsVoice : tts.DEFAULT_VOICE,
    speed: typeof cfg.ttsSpeed === 'number' ? cfg.ttsSpeed : 1,
    language: isValidReadAloudLanguage(cfg.ttsLanguage) ? cfg.ttsLanguage : settingDefault('ttsLanguage'),
    allowOnlineVoices: cfg.ttsAllowOnlineVoices === true,
    systemVoices: Array.isArray(cfg.ttsSystemVoices) ? cfg.ttsSystemVoices : [],
    languages: READ_ALOUD_LANGUAGES,
  });
});

// Clamp a requested speed to the model's supported range; fall back to the configured default.
const resolveSpeed = (v, cfg) => {
  const n = Number(v);
  if (Number.isFinite(n)) return Math.min(2, Math.max(0.5, n));
  return typeof cfg.ttsSpeed === 'number' ? cfg.ttsSpeed : 1;
};

// Synthesize { text, voice? } → audio/wav. Off-thread (the worker), bounded by the core's caps, best-effort.
router.post('/', async (req, res) => {
  const cfg = require('../config');
  if (cfg.ttsEnabled !== true) return res.status(403).json({ error: 'Read-aloud is turned off. Enable it in Settings.' });
  const body = req.body || {};
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) return res.status(400).json({ error: 'No text to read.' });
  const voice = tts.isValidVoice(body.voice) ? body.voice : (tts.isValidVoice(cfg.ttsVoice) ? cfg.ttsVoice : tts.DEFAULT_VOICE);
  const speed = resolveSpeed(body.speed, cfg);
  try {
    const { wav } = await tts.synthesize(text, { voice, speed });
    res.set('Content-Type', 'audio/wav');
    res.set('Cache-Control', 'no-store');
    res.send(wav);
  } catch (e) {
    // Unavailable (optional dep/model missing) vs a real synthesis failure — both degrade to no audio in the UI.
    const status = e && e.unavailable ? 503 : 500;
    res.status(status).json({ error: e && e.unavailable ? 'Voice synthesis is not available on this install.' : 'Could not generate audio.' });
  }
});

module.exports = router;
