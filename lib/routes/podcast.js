'use strict';
// Audio Overview control plane — turns a generated dialogue script into a two-host podcast WAV, fully locally.
// The script itself is produced by the normal workspace synthesis (the 'podcast' format); this route only
// synthesizes the AUDIO from that text, so it reuses the same local voice engine as Read-aloud and is gated
// behind the same `ttsEnabled` setting (the voice model is a one-time download). Nothing is sent to any cloud.

const express = require('express');
const router = express.Router();
const podcast = require('../voice/podcast');

// Status for the UI: audio is possible only when read-aloud's engine is on and available on this install.
router.get('/', (req, res) => {
  const cfg = require('../config');
  res.json({ enabled: cfg.ttsEnabled === true, available: podcast.isAvailable() });
});

// Synthesize { text } (a two-host dialogue) → audio/wav. Off-thread (the TTS worker), bounded by the module's
// caps, best-effort. Aborts synthesis if the client disconnects, so a cancelled podcast frees the worker.
router.post('/', async (req, res) => {
  const cfg = require('../config');
  if (cfg.ttsEnabled !== true) return res.status(403).json({ error: 'Audio Overview needs read-aloud. Enable "Read answers aloud" in Settings.' });
  const text = (req.body && typeof req.body.text === 'string') ? req.body.text : '';
  if (!text.trim()) return res.status(400).json({ error: 'No script to voice.' });
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });   // client left — stop synthesizing
  try {
    const speed = typeof cfg.ttsSpeed === 'number' ? cfg.ttsSpeed : 1;
    const { wav } = await podcast.synthesize(text, { voiceA: cfg.podcastVoiceA, voiceB: cfg.podcastVoiceB, speed, signal: ac.signal });
    if (ac.signal.aborted) return;
    res.set('Content-Type', 'audio/wav');
    res.set('Cache-Control', 'no-store');
    res.send(wav);
  } catch (e) {
    if (ac.signal.aborted) return;
    const status = e && e.unavailable ? 503 : 500;
    res.status(status).json({ error: e && e.unavailable ? 'Voice synthesis is not available on this install.' : 'Could not generate the podcast audio.' });
  }
});

module.exports = router;
