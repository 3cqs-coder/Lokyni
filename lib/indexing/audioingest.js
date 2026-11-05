'use strict';
// Audio/video ingestion — transcribe a media file into text so what is SPOKEN becomes a searchable, cited
// document (the same transcript-as-document shape the YouTube-caption path uses). Fully local and bounded:
//
//   • Decode to 16 kHz mono PCM: `.wav` natively (streamed from disk, no spawn, no dependency); every other
//     format via the bundled ffmpeg (fetched once; never a system binary), which streams the decode to a temp
//     PCM file so the media is never held in memory. When neither can decode a file, it degrades to name-only
//     indexing (the caller handles a null transcript) — a document is never dropped.
//   • Transcribe in bounded segments through the shared STT worker (lib/voice/stt.js), which internally windows
//     each segment — so memory stays flat regardless of the recording's length, and a long file can't OOM.
//   • Cache the transcript by file-content hash + language, so a re-index never re-transcribes an unchanged file.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fsp = fs.promises;

const SAMPLE_RATE = 16000;        // what the STT core consumes
const SEGMENT_SECONDS = 120;      // transcribe in 2-minute segments: bounds memory and keeps each worker call well
                                  // under its timeout; the worker windows each segment internally.
const MAX_WAV_BLOCK_BYTES = 8 * 1024 * 1024;   // hard ceiling on one native-WAV read block, so a high sample rate /
                                  // channel count in the header can't force a huge allocation (OOM safety).
const MEDIA_EXTS = new Set(require('../constants').MEDIA_EXTENSIONS);
const isMediaExt = (ext) => MEDIA_EXTS.has(String(ext || '').toLowerCase());

// Streaming SHA-256 of a file (flat memory, so a multi-GB media file is safe to hash) for the transcript cache.
const hashFileStream = (filePath) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  const s = fs.createReadStream(filePath);
  s.on('error', reject);
  s.on('data', (c) => h.update(c));
  s.on('end', () => resolve(h.digest('hex')));
});

// ── Native WAV decode (no ffmpeg) ─────────────────────────────────────────────────────────────────────────
// Parse the fmt + data chunks, then stream the data chunk in frame-aligned blocks, downmix to mono, and resample
// to 16 kHz. Supports PCM (8/16/24/32-bit) and IEEE float (32-bit) — the common WAV encodings; anything else
// throws, and the caller falls back to ffmpeg (or name-only).
const readWavFmt = async (fh) => {
  const head = Buffer.allocUnsafe(12);
  await fh.read(head, 0, 12, 0);
  if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let off = 12, fmt = null, dataStart = 0, dataSize = 0;
  const ch = Buffer.allocUnsafe(8);
  for (let i = 0; i < 256; i++) {   // bounded chunk scan
    const { bytesRead } = await fh.read(ch, 0, 8, off);
    if (bytesRead < 8) break;
    const id = ch.toString('latin1', 0, 4);
    const size = ch.readUInt32LE(4);
    if (id === 'fmt ') {
      const body = Buffer.allocUnsafe(Math.min(size, 40));
      await fh.read(body, 0, body.length, off + 8);
      let audioFormat = body.readUInt16LE(0);
      const channels = body.readUInt16LE(2);
      const sampleRate = body.readUInt32LE(4);
      const bitsPerSample = body.readUInt16LE(14);
      if (audioFormat === 0xFFFE && body.length >= 26) audioFormat = body.readUInt16LE(24);   // WAVE_FORMAT_EXTENSIBLE → real subformat
      fmt = { audioFormat, channels, sampleRate, bitsPerSample };
    } else if (id === 'data') { dataStart = off + 8; dataSize = size; break; }
    off += 8 + size + (size & 1);   // chunks are word-aligned
  }
  if (!fmt || !dataStart) throw new Error('WAV missing fmt/data');
  if (![1, 3].includes(fmt.audioFormat)) throw new Error('unsupported WAV encoding ' + fmt.audioFormat);
  // Sanity-check the header-controlled fields. A crafted or unusual WAV declaring, say, an 8 MHz sample rate or
  // hundreds of channels must NOT drive the block allocation below — reject it here so it falls through to ffmpeg
  // (whose output is a fixed 16 kHz mono s16le stream with no rate-dependent allocation).
  if (!fmt.channels || fmt.channels > 8 || !fmt.sampleRate || fmt.sampleRate > 384000 || ![8, 16, 24, 32].includes(fmt.bitsPerSample)) {
    throw new Error('unsupported WAV format (' + fmt.channels + 'ch ' + fmt.sampleRate + 'Hz ' + fmt.bitsPerSample + 'bit)');
  }
  return { ...fmt, dataStart, dataSize };
};
const framesToMonoFloat = (buf, frames, fmt) => {
  const { channels, bitsPerSample, audioFormat } = fmt, bps = bitsPerSample / 8, out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const p = (f * channels + c) * bps;
      let v;
      if (audioFormat === 3 && bitsPerSample === 32) v = buf.readFloatLE(p);
      else if (bitsPerSample === 16) v = buf.readInt16LE(p) / 32768;
      else if (bitsPerSample === 8) v = (buf.readUInt8(p) - 128) / 128;           // 8-bit WAV is unsigned
      else if (bitsPerSample === 24) { const x = buf.readUIntLE(p, 3); v = (x >= 0x800000 ? x - 0x1000000 : x) / 0x800000; }
      else if (bitsPerSample === 32) v = buf.readInt32LE(p) / 0x80000000;
      else v = 0;
      sum += v;
    }
    out[f] = sum / channels;
  }
  return out;
};
const resampleLinear = (src, srcRate, dstRate) => {
  if (srcRate === dstRate) return src;
  const ratio = srcRate / dstRate, n = Math.max(0, Math.floor(src.length / ratio)), out = new Float32Array(n);
  for (let i = 0; i < n; i++) { const pos = i * ratio, i0 = Math.floor(pos), frac = pos - i0, a = src[i0] || 0, b = src[i0 + 1] != null ? src[i0 + 1] : a; out[i] = a + (b - a) * frac; }
  return out;
};
async function* wavSegments(filePath, maxSeconds) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const fmt = await readWavFmt(fh);
    const frameSize = (fmt.bitsPerSample / 8) * fmt.channels;
    if (!frameSize) throw new Error('bad WAV frame size');
    const maxFrames = maxSeconds ? Math.floor(maxSeconds * fmt.sampleRate) : Infinity;
    // Bound the block by BYTES, not just by the (header-controlled) sample rate × channels × bit depth, so a
    // high-rate or many-channel file can't force a huge up-front allocation. The generator simply yields more,
    // smaller sub-segments (each still well within the STT window). Flat memory regardless of the file.
    const framesPerBlock = Math.max(1, Math.min(SEGMENT_SECONDS * fmt.sampleRate, Math.floor(MAX_WAV_BLOCK_BYTES / frameSize)));
    let framesLeft = Math.min(Math.floor(fmt.dataSize / frameSize), maxFrames);
    let offset = fmt.dataStart;
    const buf = Buffer.allocUnsafe(framesPerBlock * frameSize);   // ≤ MAX_WAV_BLOCK_BYTES by the clamp above
    while (framesLeft > 0) {
      const want = Math.min(framesPerBlock, framesLeft) * frameSize;
      const { bytesRead } = await fh.read(buf, 0, want, offset);
      if (bytesRead < frameSize) break;
      const gotFrames = Math.floor(bytesRead / frameSize);
      offset += gotFrames * frameSize; framesLeft -= gotFrames;
      yield resampleLinear(framesToMonoFloat(buf, gotFrames, fmt), fmt.sampleRate, SAMPLE_RATE);
      if (bytesRead < want) break;
    }
  } finally { try { await fh.close(); } catch {} }
}

// ── ffmpeg decode (everything else) ───────────────────────────────────────────────────────────────────────
// Decode to a temp s16le file via the bundled ffmpeg, then read it back in fixed-size segments (Int16->Float32).
async function* ffmpegSegments(filePath, maxSeconds) {
  const ffmpeg = require('./ffmpeg');
  const { pcmPath, cleanup } = await ffmpeg.decodeToPcmFile(filePath, { maxSeconds });
  // cleanup() must run even if opening the temp file fails, or the decoded PCM would leak on the data volume.
  try {
    const fh = await fsp.open(pcmPath, 'r');
    try {
      const bytesPerSeg = SEGMENT_SECONDS * SAMPLE_RATE * 2;   // s16le mono
      const buf = Buffer.allocUnsafe(bytesPerSeg);
      let off = 0;
      for (;;) {
        const { bytesRead } = await fh.read(buf, 0, bytesPerSeg, off);
        if (bytesRead < 2) break;
        off += bytesRead;
        const n = bytesRead >> 1;
        const f32 = new Float32Array(n);
        for (let i = 0; i < n; i++) f32[i] = buf.readInt16LE(i * 2) / 32768;
        yield f32;
        if (bytesRead < bytesPerSeg) break;
      }
    } finally { try { await fh.close(); } catch {} }
  } finally { cleanup(); }
}

// Transcribe each segment through the shared STT worker and join. A generous per-segment timeout (segment
// duration × 4, min 3 min) covers a slow CPU without the push-to-talk default tripping. Returns the joined text.
const transcribeSegments = async (iter, lang, name) => {
  const stt = require('../voice/stt');
  const timeoutMs = Math.max(180000, SEGMENT_SECONDS * 4 * 1000);
  const parts = [];
  let seg = 0;
  for await (const pcm of iter) {
    if (!pcm || pcm.length < SAMPLE_RATE / 10) continue;   // < 100 ms — nothing meaningful
    seg++;
    try { require('../logbuffer').progress(`   🎙️  Transcribing ${name} — segment ${seg}`); } catch {}
    const text = await stt.transcribe(pcm, { language: lang, timeoutMs });
    if (text) parts.push(text.trim());
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
};

// Transcribe a media file → the transcript text, or null when it can't be transcribed (unsupported here,
// ffmpeg unavailable, a decode error, or genuinely silent) — the caller then indexes the file by name. Never
// throws. Cached by content hash + language so a re-index never re-transcribes an unchanged file.
const transcribeMediaFile = async (filePath, { language = 'en', cacheDir = null, maxSeconds } = {}) => {
  const stt = require('../voice/stt');
  if (!stt.isAvailable()) return null;   // transformers missing — name-only
  const lang = stt.isValidLanguage(language) ? language : stt.DEFAULT_LANGUAGE;
  const cache = require('../transcriptcache');
  const name = path.basename(filePath);

  let hash = null;
  try { hash = await hashFileStream(filePath); } catch { return null; }   // unreadable — name-only
  const hit = cache.get(cache.keyFor(hash, lang), cacheDir);
  if (hit != null) return hit;

  const ext = path.extname(filePath).toLowerCase();
  const ffmpeg = require('./ffmpeg');
  let transcript = '';
  try {
    if (ext === '.wav') {
      // Prefer the native decoder; on an unusual WAV encoding it throws and we fall through to ffmpeg.
      try { transcript = await transcribeSegments(wavSegments(filePath, maxSeconds), lang, name); }
      catch (e) {
        const bin = await ffmpeg.ensure().catch(() => null);
        if (!bin) return null;   // native path failed and no ffmpeg — name-only
        transcript = await transcribeSegments(ffmpegSegments(filePath, maxSeconds), lang, name);
      }
    } else {
      transcript = await transcribeSegments(ffmpegSegments(filePath, maxSeconds), lang, name);
    }
  } catch (e) {
    // ffmpeg unavailable (no bundled build / offline) or a decode/transcription error → degrade to name-only.
    // Deliberately settled (not retry-pending): a corrupt/unsupported file would otherwise retry every re-index,
    // and an offline-fetch retry is better triggered by a rebuild than by hammering the mirror each scan.
    try { require('../logbuffer').progress(`   ⚠️  Could not transcribe ${name} (${(e && e.message) || e}) — indexing by name`); } catch {}
    return null;
  }
  transcript = (transcript || '').trim();
  if (!transcript) return null;   // genuinely silent — name-only
  try { cache.set(cache.keyFor(hash, lang), transcript, cacheDir); } catch {}
  return transcript;
};

module.exports = { isMediaExt, transcribeMediaFile, MEDIA_EXTS, SAMPLE_RATE, SEGMENT_SECONDS, flushCache: (dir) => { try { require('../transcriptcache').flush(dir); } catch {} } };
