'use strict';
// ── ttscore — local text-to-speech synthesis, isolated from everything else ─────────────────────────────
//
// Runs INSIDE the TTS worker thread (see lib/voice/tts.js). Synthesizes speech fully locally with the Kokoro-82M
// model on the already-bundled @huggingface/transformers (v4) + onnxruntime-node — no cloud, no API key, no
// second runtime, and no native build. Kokoro is a StyleTTS2 model: text → phonemes (the pure-wasm `phonemizer`
// package) → token ids (the model's own tokenizer) → a per-voice "style" vector → the ONNX model → a 24 kHz
// waveform. The model (~90 MB quantized) downloads once from Hugging Face and then runs offline; voice packs
// are small .bin files cached beside it. Everything here is bounded and best-effort.
//
// Why port the pipeline here rather than use the `kokoro-js` wrapper: that package pins transformers v3, which
// conflicts with the v4 the reranker/ColBERT already use. Driving the model class directly keeps ONE transformers
// and ONE onnxruntime for the whole app.

const fs = require('fs');
const path = require('path');

// Bounds (OOM safety): a single request's text is capped, and it is synthesized sentence-by-sentence in chunks
// small enough that the token count stays under the model's 510-token window (so nothing is silently truncated),
// with the per-request audio length capped too. 24 kHz mono f32 is 96 KB/s, so the audio cap also bounds memory.
const MAX_TEXT_CHARS   = 8000;     // reject anything larger up front (a whole long answer still fits)
const MAX_CHUNK_CHARS  = 300;      // per synthesis call — keeps phoneme tokens well under the 510 window
const MAX_TOKENS       = 510;      // the model's input window (style vectors are indexed 0..509)
const MAX_AUDIO_SECONDS = 600;     // hard cap on produced audio (10 min) so a pathological input can't blow memory
const SAMPLE_RATE      = 24000;
const MODEL_ID         = 'onnx-community/Kokoro-82M-v1.0-ONNX';

let _model = null, _tokenizer = null, _Tensor = null;
const _voiceCache = new Map();     // voice -> Float32Array (style vectors), loaded once per process

// Offline-first load of the model + tokenizer, cached under the data directory (not node_modules), so a download
// survives an npm reinstall, sits in a container's data volume, and works on a read-only app filesystem. Loaded
// once; concurrent callers share the one in-flight promise.
let _loading = null;
const init = ({ cacheDir } = {}) => {
  if (_model && _tokenizer) return Promise.resolve();
  if (_loading) return _loading;
  _loading = (async () => {
    const transformers = await import('@huggingface/transformers');
    const { StyleTextToSpeech2Model, AutoTokenizer, Tensor, env } = transformers;
    _Tensor = Tensor;
    if (cacheDir) { try { env.cacheDir = cacheDir; } catch { /* fall back to the default */ } }
    // Offline-first, mirroring the reranker: load with no network call when the model is already cached, so a
    // machine where it is present works even when Hugging Face is blocked. Only a missing model reaches the net,
    // once; a partial/corrupt cache falls back to a clean remote fetch.
    const cached = (() => { try { return require('../retrieval/modelcache').isModelCached(cacheDir, MODEL_ID); } catch { return false; } })();
    const load = async (remote) => {
      try { env.allowRemoteModels = remote; } catch {}
      const [m, t] = await Promise.all([
        StyleTextToSpeech2Model.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'cpu' }),
        AutoTokenizer.from_pretrained(MODEL_ID),
      ]);
      _model = m; _tokenizer = t;
    };
    try { await load(!cached); }
    catch (_) { _model = _tokenizer = null; await load(true); }   // a stale offline cache → clean remote fetch
  })();
  // Clear the in-flight marker when it settles: on success _model/_tokenizer are set (so a later call returns
  // immediately); on failure clear everything so a later call retries the load. The returned promise rejects on
  // failure, so the caller falls back to no audio.
  _loading.then(() => { _loading = null; }, () => { _loading = null; _model = _tokenizer = null; });
  return _loading;
};

// Phonemize text with the pure-wasm espeak-ng, then apply the phoneme fix-ups Kokoro's training expects (espeak
// emits 'r'/'x' where the model wants 'ɹ'/'k', plus a couple of model-specific corrections). Mirrors the
// reference pipeline's post-processing so audio quality matches. British voices (b*) use en-gb, others en-us.
const phonemizeText = async (text, voice) => {
  const { phonemize } = await import('phonemizer');
  const lang = String(voice || '').startsWith('b') ? 'en-gb' : 'en-us';
  let ph = (await phonemize(text, lang)).join(' ');
  ph = ph
    .replace(/kəkˈoʊɹoʊ/g, 'kˈoʊkəɹoʊ').replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
    .replace(/ʲ/g, 'j').replace(/r/g, 'ɹ').replace(/x/g, 'k').replace(/ɬ/g, 'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ').replace(/ z(?=[;:,.!?¡¿—…"«»"" ]|$)/g, 'z');
  return ph.trim();
};

// Load a voice's style vectors (a Float32Array), fetching the small .bin from Hugging Face once and caching it
// beside the model so later use is offline. Cached in-memory per process. Returns null on any failure.
const loadVoice = async (voice, cacheDir) => {
  if (_voiceCache.has(voice)) return _voiceCache.get(voice);
  const dir = path.join(cacheDir || '.', 'kokoro-voices');
  const file = path.join(dir, `${voice}.bin`);
  let buf = null;
  try { buf = fs.readFileSync(file); } catch { /* not cached yet — fetch below */ }
  if (!buf) {
    const url = `https://huggingface.co/${MODEL_ID}/resolve/main/voices/${voice}.bin`;
    const ab = await fetch(url).then((r) => { if (!r.ok) throw new Error(`voice fetch ${r.status}`); return r.arrayBuffer(); });
    buf = Buffer.from(ab);
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, buf); } catch { /* cache is best-effort */ }
  }
  // A fresh, 4-byte-aligned copy — a Buffer from Node's shared pool need not be aligned for a Float32Array view.
  const aligned = Buffer.alloc(buf.length); buf.copy(aligned);
  const vec = new Float32Array(aligned.buffer, aligned.byteOffset, Math.floor(aligned.byteLength / 4));
  _voiceCache.set(voice, vec);
  return vec;
};

// Split text into synthesis chunks at sentence boundaries, each bounded to MAX_CHUNK_CHARS so the token count
// stays under the model window. A single over-long sentence is hard-split on whitespace.
const chunkText = (text) => {
  const sentences = String(text).replace(/\s+/g, ' ').trim().match(/[^.!?。！？]+[.!?。！？]*\s*/g) || [String(text)];
  const chunks = [];
  let cur = '';
  const pushHardSplit = (s) => {
    for (let i = 0; i < s.length; i += MAX_CHUNK_CHARS) chunks.push(s.slice(i, i + MAX_CHUNK_CHARS).trim());
  };
  for (const s of sentences) {
    const t = s.trim();
    if (!t) continue;
    if (t.length > MAX_CHUNK_CHARS) { if (cur) { chunks.push(cur); cur = ''; } pushHardSplit(t); continue; }
    if ((cur + ' ' + t).trim().length > MAX_CHUNK_CHARS) { if (cur) chunks.push(cur); cur = t; }
    else cur = (cur ? cur + ' ' : '') + t;
  }
  if (cur) chunks.push(cur);
  return chunks.filter(Boolean);
};

// Synthesize one chunk's phonemes → a Float32 waveform at 24 kHz.
const synthChunk = async (phonemes, voiceVec, speed) => {
  const { input_ids } = _tokenizer(phonemes, { truncation: true });
  const n = input_ids.dims.at(-1);
  if (!n || n < 1) return new Float32Array(0);
  const offset = 256 * Math.min(Math.max(n - 2, 0), MAX_TOKENS - 1);
  const style = voiceVec.slice(offset, offset + 256);
  const out = await _model({
    input_ids,
    style: new _Tensor('float32', style, [1, 256]),
    speed: new _Tensor('float32', [speed], [1]),
  });
  const wf = out && out.waveform && out.waveform.data;
  return wf ? Float32Array.from(wf) : new Float32Array(0);
};

// Encode mono Float32 PCM as a 16-bit WAV (the universal format every browser <audio> plays). Returns a Buffer.
const encodeWav = (f32, sampleRate) => {
  const n = f32.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    let s = f32[i]; s = s < -1 ? -1 : s > 1 ? 1 : s;
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7FFF), 44 + i * 2);
  }
  return buf;
};

// Synthesize text → { wav (Buffer), sampleRate }. Chunked, bounded, best-effort; throws only on a hard failure
// (model load failed, no audio produced) so the caller can fall back to no audio.
const synthesize = async ({ text, voice = 'af_heart', speed = 1, cacheDir }) => {
  const clean = String(text || '').slice(0, MAX_TEXT_CHARS).trim();
  if (!clean) throw new Error('no text to synthesize');
  const v = (/^[ab][fm]_[a-z]+$/.test(voice)) ? voice : 'af_heart';
  const sp = Math.min(Math.max(Number(speed) || 1, 0.5), 2);
  await init({ cacheDir });
  const voiceVec = await loadVoice(v, cacheDir);
  if (!voiceVec) throw new Error('voice unavailable');
  const maxSamples = MAX_AUDIO_SECONDS * SAMPLE_RATE;
  const parts = [];
  let total = 0;
  for (const chunk of chunkText(clean)) {
    const ph = await phonemizeText(chunk, v);
    if (!ph) continue;
    const wf = await synthChunk(ph, voiceVec, sp);
    if (wf.length) { parts.push(wf); total += wf.length; }
    if (total >= maxSamples) break;   // audio cap reached — stop (bounded)
  }
  if (!total) throw new Error('synthesis produced no audio');
  const all = new Float32Array(Math.min(total, maxSamples));
  let o = 0;
  for (const p of parts) { if (o >= all.length) break; const take = Math.min(p.length, all.length - o); all.set(p.subarray(0, take), o); o += take; }
  return { wav: encodeWav(all, SAMPLE_RATE), sampleRate: SAMPLE_RATE };
};

module.exports = { init, synthesize, chunkText, encodeWav, phonemizeText, MODEL_ID, SAMPLE_RATE, MAX_TEXT_CHARS };
