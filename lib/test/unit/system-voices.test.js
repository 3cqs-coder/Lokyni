'use strict';
// Guards the saved per-language system-voice preference: its bounded shape (the single definition used by the
// config reader, the settings writer, and the status route), plus the wiring that exposes the picker. The
// browser owns the actual voice list; this module only stores identifiers, so no network, model, or DOM.
// Run: `npm run test:unit`.

const path = require('path'), fs = require('fs'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');
const { normalize, MAX_SYSTEM_VOICES } = require(path.join(PROJECT, 'lib', 'voice', 'system-voices'));
const { SETTINGS, CLIENT_SETTINGS } = require(path.join(PROJECT, 'lib', 'settings-schema'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };

try {
  // ── Shape ────────────────────────────────────────────────────────────────────────────────────────────
  eq(normalize(null), [], 'a missing value degrades to automatic');
  eq(normalize('not-an-array'), [], 'a non-array value degrades to automatic');
  eq(normalize([]), [], 'an empty list is valid');
  eq(normalize([{ lang: 'es', uri: 'urn:voice:es', name: 'Español' }]),
    [{ lang: 'es', uri: 'urn:voice:es', name: 'Español' }], 'a well-formed entry round-trips');
  eq(normalize([{ lang: 'fil', uri: 'urn:voice:fil', name: 'Filipino' }]),
    [{ lang: 'fil', uri: 'urn:voice:fil', name: 'Filipino' }], 'a three-letter language code survives normalization');

  // Case/space normalization, deterministic ordering, and one entry per language (last wins).
  const messy = normalize([
    { lang: ' FR ', uri: ' fr-uri ', name: ' Français ' },
    { lang: 'es', uri: 'es-old', name: 'Old Spanish' },
    { lang: 'de', uri: '', name: 'Deutsch' },
    { lang: 'es', uri: 'es-new', name: 'New Spanish' },
  ]);
  eq(messy.map((e) => e.lang), ['de', 'es', 'fr'], 'entries are sorted by language');
  eq(messy.find((e) => e.lang === 'fr').uri, 'fr-uri', 'language and identifier whitespace is trimmed');
  eq(messy.find((e) => e.lang === 'es').name, 'New Spanish', 'the last entry for a language wins');
  eq(messy.find((e) => e.lang === 'de').uri, '', 'a name alone is enough to resolve a voice');

  // Unknown languages and entries with no identifier are dropped.
  eq(normalize([
    { lang: 'xx', uri: 'x', name: 'Unknown' },
    { lang: 'auto', uri: 'x', name: 'Automatic' },
    { lang: 'es', uri: '', name: '' },
    { lang: 'pt', uri: 'p', name: 'Português' },
  ]), [{ lang: 'pt', uri: 'p', name: 'Português' }], 'only supported languages with an identifier survive');

  // Strings are bounded so a hand-edited config cannot grow the preference unbounded.
  const long = normalize([{ lang: 'ja', uri: 'u'.repeat(2000), name: 'n'.repeat(2000) }]);
  ok(long[0].uri.length <= 512 && long[0].name.length <= 128, 'identifiers are bounded');

  // Every catalog language can be saved, and the shared cap leaves headroom for future catalog growth.
  const { READ_ALOUD_LANGUAGES } = require(path.join(PROJECT, 'lib', 'langdetect'));
  const allLangs = READ_ALOUD_LANGUAGES.map((l) => ({ lang: l.code, uri: 'u-' + l.code, name: l.name }));
  eq(normalize(allLangs).length, READ_ALOUD_LANGUAGES.length, 'every catalog language can be saved');
  ok(READ_ALOUD_LANGUAGES.length <= MAX_SYSTEM_VOICES, 'the catalog fits under the shared cap');

  // The input scan itself is bounded, so an oversized array cannot make normalization walk it all.
  const oversized = Array.from({ length: MAX_SYSTEM_VOICES * 4 }, () => ({ lang: 'xx' }));
  oversized.push({ lang: 'es', uri: 'late', name: 'Late' });
  eq(normalize(oversized), [], 'an oversized input is scanned only within the bound');

  // ── Wiring ──────────────────────────────────────────────────────────────────────────────────────────
  ok(SETTINGS.ttsSystemVoices && SETTINGS.ttsSystemVoices.type === 'array' &&
     Array.isArray(SETTINGS.ttsSystemVoices.default) && SETTINGS.ttsSystemVoices.writable === true,
    'the shared schema defines a writable array preference');
  eq(SETTINGS.ttsSystemVoices.maxItems, MAX_SYSTEM_VOICES, 'the schema cap is the validator cap (no drift)');
  eq(CLIENT_SETTINGS.limits.ttsSystemVoices, MAX_SYSTEM_VOICES, 'the page receives the same cap');

  const cfgSrc = read('lib/config.js');
  ok(/normalizeSystemVoices\(providerConfig\.ttsSystemVoices\)/.test(cfgSrc), 'the config reader normalizes the stored list');
  const serverSrc = read('lib/server.js');
  ok(/key === 'ttsSystemVoices'[\s\S]{0,200}normalize\(val\)/.test(serverSrc),
    'the settings writer validates and normalizes the list');
  ok(/ttsSystemVoices:\s*cfg\.ttsSystemVoices/.test(serverSrc), 'the config API returns the saved list');
  const routeSrc = read('lib/routes/tts.js');
  ok(/systemVoices:\s*Array\.isArray\(cfg\.ttsSystemVoices\)/.test(routeSrc), 'the voice status exposes the saved list');

  const chatJs = read('lib/public/js/chat.js');
  ok(/populateSystemVoiceOptions/.test(chatJs) && /previewSystemVoice/.test(chatJs),
    'the client has a system-voice picker and preview');
  ok(/voiceschanged/.test(chatJs) && /Intl\.DisplayNames/.test(chatJs),
    'the picker refreshes when voices load and the preview is language-aware');
  ok(/ttsSystemVoices:\s*ttsSystemVoicePrefs/.test(chatJs), 'the client saves the per-language preference');
  ok(/findInstalledVoice/.test(chatJs) && /voiceURI/.test(chatJs) && /\.name === pref\.name/.test(chatJs),
    'a saved preference resolves by URI, then by name across surfaces');
  ok(/localService === false/.test(chatJs) && /allowOnlineVoices === true/.test(chatJs),
    'online voices remain gated by the opt-in');
  const chatEjs = read('lib/views/chat.ejs');
  ok(/id="cfg-tts-system-voice"/.test(chatEjs) && /id="cfg-tts-system-preview"/.test(chatEjs),
    'the Settings row and its preview button exist');
  ok(/id="cfg-tts-system-language"/.test(chatEjs) && /populateSystemVoiceLanguageOptions/.test(chatJs),
    'the voice picker has its own language context');
  ok(/id="cfg-tts-voices-details"/.test(chatEjs) && /id="cfg-tts-voices-list"/.test(chatEjs) &&
     /function renderTtsVoiceDiagnostics/.test(chatJs),
    'the read-only installed-voice diagnostics panel is wired');
  ok(/id="readas-detected"/.test(chatEjs) && /Detected:/.test(chatJs),
    'the per-answer dialog shows the detected language');
  ok(/id="readas-overlay"/.test(chatEjs) && /id="readas-language"/.test(chatEjs) && /id="readas-go"/.test(chatEjs),
    'the per-answer Read as dialog is wired in the page');
  ok(/function openReadAs/.test(chatJs) && /ans-readas/.test(chatJs) && /forceLanguage/.test(chatJs),
    'the answer menu opens the per-answer language dialog and bypasses the global language');

  console.log(`\nALL SYSTEM-VOICES UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ SYSTEM-VOICES UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
