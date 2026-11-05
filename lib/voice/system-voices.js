'use strict';
// ── system-voices — the saved preference for operating-system speech voices ────────────────────────────
//
// The browser owns the actual voice list: names and voice URIs differ between browsers and operating systems.
// This module therefore owns only the SHAPE of the saved preference — one bounded entry per read-aloud language
// — and is the single definition used by the config reader, the settings writer, and the /api/tts status route.
// A malformed or hand-edited value degrades to [] rather than reaching playback.
//
// An entry stores the browser's voiceURI and a human name. Resolution in the client prefers an exact URI and
// falls back to the same name within the language, so a preference survives a surface (browser vs. desktop
// shell) where the URI is different but the installed voice is the same.

const { READ_ALOUD_LANGUAGES } = require('../langdetect');

// At least twice the catalog, so adding languages can never silently make the cap smaller than one saved
// voice per language. Derived from the catalog instead of a second hard-coded count that would drift.
const MAX_SYSTEM_VOICES = Math.max(96, READ_ALOUD_LANGUAGES.length * 2);
const MAX_URI_CHARS = 512;
const MAX_NAME_CHARS = 128;
const MAX_INPUT_ENTRIES = MAX_SYSTEM_VOICES * 4;    // bound an oversized/malicious array before scanning all of it
const LANGUAGE_CODES = new Set(READ_ALOUD_LANGUAGES.map((l) => l.code));

const cleanText = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

// Normalize any stored or requested value into a bounded, de-duplicated array. The last entry for a language
// wins, so changing a preference never leaves two contradictory entries. Pure, synchronous, and never throws.
const normalize = (input) => {
  if (!Array.isArray(input)) return [];
  const byLang = new Map();
  const limit = Math.min(input.length, MAX_INPUT_ENTRIES);
  for (let i = 0; i < limit; i++) {
    const raw = input[i];
    if (!raw || typeof raw !== 'object') continue;
    const lang = cleanText(raw.lang, 3).toLowerCase();
    if (!LANGUAGE_CODES.has(lang)) continue;
    const uri = cleanText(raw.uri, MAX_URI_CHARS);
    const name = cleanText(raw.name, MAX_NAME_CHARS);
    if (!uri && !name) continue;   // an entry with neither identifier can never resolve
    byLang.set(lang, { lang, uri, name });
  }
  return [...byLang.values()]
    .sort((a, b) => (a.lang < b.lang ? -1 : a.lang > b.lang ? 1 : 0))
    .slice(0, MAX_SYSTEM_VOICES);
};

module.exports = { normalize, MAX_SYSTEM_VOICES };
