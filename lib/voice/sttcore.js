'use strict';
// ── sttcore — local speech-to-text transcription, isolated from everything else ─────────────────────────────
//
// Runs INSIDE the STT worker thread (see lib/voice/stt.js). Transcribes speech fully locally with a Whisper model
// on the already-bundled @huggingface/transformers (v4) + onnxruntime-node — no cloud, no API key, no second
// runtime, and no native build. The model (~75 MB quantized) downloads once from Hugging Face and then runs
// offline, through the same offline-first loader the reranker/ColBERT cores use (modelload.makeLoader).
//
// Input is 16 kHz mono Float32 PCM in [-1, 1] — the browser resamples the microphone to exactly that before
// sending it, so there is no decode/resample step here. Output is the transcript text. Everything is bounded and
// best-effort: a load failure throws (the caller falls back to no transcript) rather than wedging.

const { makeLoader } = require('../retrieval/modelload');

// Bounds (OOM safety): the audio length per request is capped, and Whisper itself streams the audio in 30 s
// windows so memory stays flat regardless of clip length. 16 kHz mono Float32 is 64 KB/s, so the length cap also
// bounds the input buffer. A push-to-talk question is short; two minutes is a generous ceiling.
const SAMPLE_RATE       = 16000;   // Whisper's feature-extractor rate — the browser sends exactly this
const MAX_AUDIO_SECONDS = 120;     // hard cap on accepted audio (longer input is truncated, never rejected)
const CHUNK_LENGTH_S    = 30;      // Whisper window — long audio is processed in these, so memory stays flat
const STRIDE_LENGTH_S   = 5;       // overlap between windows, so words on a boundary aren't clipped

// Multilingual Whisper. The onnx-community build is primary; the Xenova mirror is a fallback if the first is
// unreachable on the one-time download (both are the same model). Quantized (q8) first for size/speed, falling
// back to fp32 if a platform can't load the quantized graph — exactly the reranker core's dtype ladder.
const MODEL_ID          = 'onnx-community/whisper-base';
const FALLBACK_MODEL_ID = 'Xenova/whisper-base';

let _asr = null;

// Offline-first load through the shared loader (post-failure cooldown, in-flight dedup, cache probe, remote
// retry — all single-sourced). The load callback tries the quantized model, then fp32, then the mirror, so a
// platform or host hiccup degrades instead of failing outright.
const init = makeLoader({
  isLoaded: () => !!_asr,
  reset:    () => { _asr = null; },
  load: async (transformers, modelId, onProgress) => {
    const { pipeline } = transformers;
    // progress_callback fires only on the first (remote) download; it is a harmless no-op on a cached load.
    const build = (id, dtype) => pipeline('automatic-speech-recognition', id, { device: 'cpu', dtype, progress_callback: onProgress });
    try { _asr = await build(modelId, 'q8'); return; }
    catch (_) { /* quantized graph unavailable on this platform → fp32 */ }
    try { _asr = await build(modelId, 'fp32'); return; }
    catch (e) {
      // The primary model id failed entirely (e.g. not reachable on first download). Try the mirror once, but
      // only when a remote fetch is actually allowed — offline with a missing primary should fail fast.
      if (modelId === MODEL_ID && transformers.env.allowRemoteModels) { _asr = await build(FALLBACK_MODEL_ID, 'q8'); return; }
      throw e;
    }
  },
});

// Transcribe 16 kHz mono Float32 PCM → text. `language` is a Whisper language code/name (e.g. 'en', 'es'); the
// browser's microphone already hands back PCM at SAMPLE_RATE, so there is nothing to decode or resample.
const transcribe = async ({ pcm, language = 'en', cacheDir, onProgress }) => {
  if (!(pcm instanceof Float32Array)) throw new Error('pcm must be a Float32Array');
  await init({ modelId: MODEL_ID, cacheDir, onProgress });   // the first transcription also downloads — report it
  if (!_asr) throw new Error('stt model not initialized');
  // Bound the input: clip to the max length so a pathological buffer can't blow memory (Whisper's own windowing
  // keeps per-window memory flat regardless).
  const maxSamples = MAX_AUDIO_SECONDS * SAMPLE_RATE;
  const audio = pcm.length > maxSamples ? pcm.subarray(0, maxSamples) : pcm;
  if (audio.length < SAMPLE_RATE / 10) return '';   // < 100 ms — nothing meaningful was said
  const out = await _asr(audio, {
    chunk_length_s: CHUNK_LENGTH_S,
    stride_length_s: STRIDE_LENGTH_S,
    return_timestamps: false,
    language,
    task: 'transcribe',   // never 'translate' — keep the speaker's own language (the answer path handles cross-lingual)
  });
  return ((out && out.text) || '').trim();
};

module.exports = { init, transcribe, SAMPLE_RATE, MAX_AUDIO_SECONDS, MODEL_ID, FALLBACK_MODEL_ID };
