'use strict';
// Speech-to-text control plane — the microphone button's backend. Fully local: 16 kHz mono Float32 PCM captured
// and resampled in the browser is transcribed by the Whisper model in a worker thread (lib/voice/stt.js) and the
// text is returned for the composer to fill in (editable before the user sends it). Nothing is sent to any cloud
// service. Gated behind the `sttEnabled` setting (off by default, since the model is a one-time ~75 MB download),
// so it does nothing until a user turns it on.

const express = require('express');
const router = express.Router();
const stt = require('../voice/stt');

// A generous cap on the PCM body: 16 kHz mono Float32 is 64 KB/s, so ~16 MB covers the core's 2-minute audio cap
// with headroom. A larger body is refused by the parser (413) rather than buffered without bound.
const PCM_LIMIT = '16mb';

// Status for the UI: is the feature on, is local transcription possible on this install, the language list, and
// the configured default language.
router.get('/', (req, res) => {
  const cfg = require('../config');
  res.json({
    enabled: cfg.sttEnabled === true,
    available: stt.isAvailable(),
    downloaded: stt.isModelDownloaded(),
    warming: stt.isWarming(),   // so Settings can show "preparing the voice model…" during the first-boot download (parity with /api/tts)
    languages: stt.LANGUAGES,
    defaultLanguage: stt.isValidLanguage(cfg.sttLanguage) ? cfg.sttLanguage : stt.DEFAULT_LANGUAGE,
  });
});

// Transcribe raw 16 kHz mono Float32 PCM (the request body) → { transcript }. Off-thread (the worker), bounded by
// the core's caps, best-effort. The language comes from ?lang= (validated) or the configured default.
router.post('/', express.raw({ type: '*/*', limit: PCM_LIMIT }), async (req, res) => {
  const cfg = require('../config');
  if (cfg.sttEnabled !== true) return res.status(403).json({ error: 'Voice input is turned off. Enable it in Settings.' });
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  if (!buf || buf.length < 8) return res.status(400).json({ error: 'No audio received.' });
  // A Buffer from the body parser may be a slice of a pooled ArrayBuffer and so not 4-byte aligned, which a
  // Float32Array view requires — copy into a fresh, aligned buffer and drop any trailing partial sample.
  const aligned = Buffer.alloc(buf.length - (buf.length % 4));
  buf.copy(aligned, 0, 0, aligned.length);
  const pcm = new Float32Array(aligned.buffer, 0, aligned.length / 4);
  const lang = stt.isValidLanguage(req.query.lang) ? req.query.lang
    : (stt.isValidLanguage(cfg.sttLanguage) ? cfg.sttLanguage : stt.DEFAULT_LANGUAGE);
  try {
    const transcript = await stt.transcribe(pcm, { language: lang });
    res.set('Cache-Control', 'no-store');
    res.json({ transcript });
  } catch (e) {
    // Unavailable (optional dep/model missing) vs a real transcription failure — both degrade to no transcript.
    const status = e && e.unavailable ? 503 : 500;
    res.status(status).json({ error: e && e.unavailable ? 'Voice input is not available on this install.' : 'Could not transcribe the audio.' });
  }
});

module.exports = router;
