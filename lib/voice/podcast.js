'use strict';
// Audio Overview — turn a workspace into a short two-host podcast.
//
// The dialogue SCRIPT is produced by the existing workspace synthesis (the 'podcast' format in api-core.js),
// fully grounded in the documents. This module turns that script into AUDIO: it parses the dialogue into turns,
// synthesizes each with the local TTS engine (lib/voice/tts.js) using two alternating voices, and stitches the
// clips into one WAV with a brief gap between turns. Fully local, bounded, and best-effort — a turn that fails
// to synthesize is skipped rather than failing the whole podcast, and the total audio is capped.

const tts = require('./tts');
const { encodeWav, SAMPLE_RATE } = require('./ttscore');   // reuse the one WAV encoder + the 24 kHz rate

const MAX_TURNS         = 200;     // cap turns so a runaway script can't synthesize forever
const MAX_TOTAL_SECONDS = 900;     // hard cap on produced audio (15 min) — OOM/time safety
const GAP_SECONDS       = 0.35;    // brief silence between turns so the dialogue doesn't run together

// Default voices: a female + a male, for an easy-to-follow contrast. Overridable via config. Both are reused from
// tts (which single-sources them from the settings schema), so the podcast defaults can never drift from the
// configured podcastVoiceA / podcastVoiceB.
const DEFAULT_VOICE_A = tts.DEFAULT_VOICE_A;
const DEFAULT_VOICE_B = tts.DEFAULT_VOICE_B;

// The two host NAMES are single-sourced from the SAME place that tells the model which names to use — the
// `hosts` field of the 'podcast' synthesis prompt (lib/ai/data/synthesis-formats.json) — so the parser here and
// the generator prompt can never drift (renaming a host there updates both the instruction and this matcher). The
// first host maps to voice A, the second to voice B. Falls back to the historical pair if the field is ever absent.
const _PODCAST_FMT = require('../ai/data/synthesis-formats.json').podcast || {};
const HOSTS = (Array.isArray(_PODCAST_FMT.hosts) && _PODCAST_FMT.hosts.length >= 2)
  ? _PODCAST_FMT.hosts.slice(0, 2).map((h) => String(h))
  : ['Alex', 'Sam'];
const { escapeRegExp } = require('../retrieval/keywords');   // shared escaper — one regex-escape class in the codebase
const _hostAlt = HOSTS.map((h) => escapeRegExp(h)).join('|');   // regex-escaped alternation of the host names

// Parse a dialogue script into [{ speaker: 'A'|'B', text }]. Accepts a line that starts with a host's name and a
// colon, with or without markdown emphasis ("**Alex:**", "Alex:", "_Sam_:"); a line with no speaker prefix is
// treated as a continuation of the current turn. Anything before the first speaker line (a title, a stray intro)
// is ignored. Language-agnostic for the spoken text — only the two host NAMES are matched.
const SPEAKER_RE = new RegExp(`^\\s*(?:[*_]{0,2})\\s*(${_hostAlt})\\s*(?:[*_]{0,2})\\s*:\\s*(.*)$`, 'i');
const parseDialogue = (script) => {
  const turns = [];
  let cur = null;
  const hostA = HOSTS[0].toLowerCase();
  for (const raw of String(script || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(SPEAKER_RE);
    if (m) {
      if (cur && cur.text.trim()) turns.push(cur);
      cur = { speaker: m[1].toLowerCase() === hostA ? 'A' : 'B', text: m[2].trim() };
    } else if (cur) {
      cur.text += ' ' + line;
    }
  }
  if (cur && cur.text.trim()) turns.push(cur);
  return turns;
};

// Strip markdown/formatting so the voice doesn't read symbols aloud. Removes emphasis markers, inline code,
// link syntax (keeping the visible text), leading list/quote markers, and collapses whitespace.
const cleanForSpeech = (text) => String(text || '')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')   // [text](url) -> text
  .replace(/[*_`~#>]+/g, ' ')                // emphasis / code / headings / quotes
  .replace(/\s+/g, ' ')
  .trim();

// Decode a 16-bit mono WAV (as the TTS engine produces) back to Float32 PCM for stitching.
const wavToFloat32 = (buf) => {
  if (!buf || buf.length <= 44) return new Float32Array(0);
  const dataLen = buf.readUInt32LE(40);
  const n = Math.min(Math.floor(dataLen / 2), Math.floor((buf.length - 44) / 2));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(44 + i * 2) / 32768;
  return out;
};

const isAvailable = () => tts.isAvailable();

// Synthesize a dialogue script → { wav (Buffer), sampleRate, turns, voiced }. Rejects when voice synthesis is
// unavailable or the script has no dialogue; otherwise best-effort (a failed turn is skipped). `signal` (an
// AbortSignal) and `onProgress({ turn, total })` are optional. Bounded by MAX_TURNS and MAX_TOTAL_SECONDS.
const synthesize = async (script, { voiceA, voiceB, speed, signal, onProgress } = {}) => {
  if (!tts.isAvailable()) throw Object.assign(new Error('voice synthesis is not available'), { unavailable: true });
  const vA = tts.isValidVoice(voiceA) ? voiceA : DEFAULT_VOICE_A;
  const vB = tts.isValidVoice(voiceB) ? voiceB : DEFAULT_VOICE_B;
  const sp = Math.min(2, Math.max(0.5, Number(speed) || 1));
  const turns = parseDialogue(script).slice(0, MAX_TURNS);
  if (!turns.length) throw new Error('no dialogue to voice');

  const maxSamples = MAX_TOTAL_SECONDS * SAMPLE_RATE;
  const gap = new Float32Array(Math.max(0, Math.round(GAP_SECONDS * SAMPLE_RATE)));
  const parts = [];
  let total = 0, voiced = 0;
  for (let i = 0; i < turns.length; i++) {
    if (signal && signal.aborted) break;
    const text = cleanForSpeech(turns[i].text);
    if (!text) continue;
    if (typeof onProgress === 'function') { try { onProgress({ turn: i + 1, total: turns.length }); } catch { /* best-effort */ } }
    let wavBuf = null;
    try { ({ wav: wavBuf } = await tts.synthesize(text, { voice: turns[i].speaker === 'A' ? vA : vB, speed: sp })); }
    catch { continue; }   // a failed turn is skipped, the podcast keeps going
    const pcm = wavToFloat32(wavBuf);
    if (!pcm.length) continue;
    if (parts.length) { parts.push(gap); total += gap.length; }   // gap between turns (not before the first)
    parts.push(pcm); total += pcm.length; voiced++;
    if (total >= maxSamples) break;   // audio cap reached — stop (bounded)
  }
  if (!voiced) throw new Error('podcast produced no audio');

  const all = new Float32Array(Math.min(total, maxSamples));
  let o = 0;
  for (const p of parts) { if (o >= all.length) break; const take = Math.min(p.length, all.length - o); all.set(p.subarray(0, take), o); o += take; }
  return { wav: encodeWav(all, SAMPLE_RATE), sampleRate: SAMPLE_RATE, turns: turns.length, voiced };
};

module.exports = { parseDialogue, cleanForSpeech, synthesize, isAvailable, DEFAULT_VOICE_A, DEFAULT_VOICE_B, MAX_TURNS, MAX_TOTAL_SECONDS };
