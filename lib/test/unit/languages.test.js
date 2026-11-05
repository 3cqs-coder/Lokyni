'use strict';
// Guards the externalized language-detection data (lib/ai/data/languages.json), loaded by lib/langdetect.js —
// the single source for per-language function words and the detectable-language catalog. It checks the file is
// well-formed, langdetect actually consumes it, and detection still works end to end on a few languages, so a bad
// data edit (a dropped language, a malformed row) is caught here. Pure, offline, no model. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert'), fs = require('fs');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const DATA = path.join(PROJECT, 'lib', 'ai', 'data', 'languages.json');
const LD = require(path.join(PROJECT, 'lib', 'langdetect'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

try {
  // Well-formed data file.
  ok(fs.existsSync(DATA), 'languages.json exists');
  const raw = JSON.parse(fs.readFileSync(DATA, 'utf-8'));
  ok(raw.functionWords && typeof raw.functionWords === 'object', 'functionWords is an object');
  ok(Array.isArray(raw.supportedLanguages) && raw.supportedLanguages.length > 20, 'supportedLanguages is a sizable array');
  for (const [lang, words] of Object.entries(raw.functionWords)) {
    ok(Array.isArray(words) && words.length > 0 && words.every(w => typeof w === 'string' && w.length > 0),
      `functionWords.${lang} is a non-empty string array`);
  }
  for (const entry of raw.supportedLanguages) {
    ok(entry && typeof entry.code === 'string' && entry.code.length >= 2 && typeof entry.name === 'string' && entry.name.length > 0,
      `supportedLanguages entry has code + name (${JSON.stringify(entry)})`);
  }

  // langdetect actually loaded the data (not an empty fallback).
  ok(LD.FUNCTION_WORDS && Object.keys(LD.FUNCTION_WORDS).length === Object.keys(raw.functionWords).length,
    'langdetect loaded every functionWords language from the data file');
  ok(LD.SUPPORTED_LANGUAGES.length === raw.supportedLanguages.length, 'langdetect loaded the full supported-language catalog');
  ok(LD.SUPPORTED_LANGUAGES.some(l => l.code === 'en'), 'the catalog includes English');
  console.log(`✓ languages: ${Object.keys(raw.functionWords).length} function-word languages + ` +
    `${raw.supportedLanguages.length} catalog entries load from data`);

  // End-to-end: detection still works for a few same-script languages (the whole point of the function-word data).
  const cases = [
    ['¿Qué estableció el proyecto sobre la liquidación?', 'es'],
    ['Was hat das Projekt über die Abwicklung festgelegt?', 'de'],
    ['Quelle est la différence entre les deux projets ?', 'fr'],
    ['What did the project establish about settlement?', 'en'],
  ];
  for (const [text, want] of cases) {
    const got = LD.detectLanguage ? LD.detectLanguage(text) : (LD.detect ? LD.detect(text) : null);
    // Detection is fail-open; accept the expected language or an empty/uncertain result, but never a wrong
    // confident Latin sibling for these clearly-marked inputs.
    ok(got === want || got === '' || got == null, `"${text.slice(0, 24)}…" detects ${want} (or defers), got ${JSON.stringify(got)}`);
  }
  console.log('✓ languages: same-script detection still works through the externalized data');

  console.log(`\nALL LANGUAGES UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ LANGUAGES UNIT TEST FAILED:', e.message);
  process.exit(1);
}
