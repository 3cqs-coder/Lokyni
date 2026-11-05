'use strict';
// Guards the cross-file contract behind read-aloud: one catalog, one language-code guard, one voice matcher,
// one cap, and one set of Settings controls. These are the seams a future change tends to touch in one file and
// forget in another, which is exactly how the client and server drift apart. No server, model, network, or
// browser. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const {
  SUPPORTED_LANGUAGES, READ_ALOUD_LANGUAGES, SPEECH_ALIASES, DIACRITIC_LANG, DIACRITIC_FAMILY,
  FUNCTION_WORDS, regionFor, isValidReadAloudLanguage,
} = require(path.join(ROOT, 'lib', 'langdetect'));
const { MAX_SYSTEM_VOICES } = require(path.join(ROOT, 'lib', 'voice', 'system-voices'));
const { SETTINGS, CLIENT_SETTINGS } = require(path.join(ROOT, 'lib', 'settings-schema'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };
const eq = (a, b, msg) => { checks++; assert.deepStrictEqual(a, b, msg); };
const count = (src, re) => (src.match(re) || []).length;

try {
  // ── One catalog ──────────────────────────────────────────────────────────────────────────────────────
  const codes = READ_ALOUD_LANGUAGES.map((l) => l.code);
  const names = READ_ALOUD_LANGUAGES.map((l) => l.name);
  eq(new Set(codes).size, codes.length, 'catalog codes are unique');
  eq(new Set(names).size, names.length, 'catalog names are unique');
  eq(READ_ALOUD_LANGUAGES.length, SUPPORTED_LANGUAGES.length,
    'the read-aloud catalog covers every supported language');
  ok(codes.every((c) => /^[a-z]{2,3}$/.test(c)), 'every code is a lowercase two- or three-letter subtag');
  ok(READ_ALOUD_LANGUAGES.every((l) => l.region === (regionFor(l.code) || l.code)),
    'every speech region comes from the one region table');
  ok(READ_ALOUD_LANGUAGES.every((l) => /^[a-z]{2,3}-[A-Z]{2}$/.test(l.region)),
    'every speech region is a well-formed language-REGION tag');
  ok(READ_ALOUD_LANGUAGES.every((l) => l.region.split('-')[0] === l.code || l.code === 'no'),
    'the region uses the code, except Norwegian, whose installed voices are nb-NO');
  eq(READ_ALOUD_LANGUAGES.find((l) => l.code === 'no').region, 'nb-NO',
    'Norwegian advertises the speech region its voices actually use');
  ok(READ_ALOUD_LANGUAGES.every((l) => Array.isArray(l.aliases)),
    'every catalog entry carries an alias list (empty when none are needed)');

  // Detection tables may only name catalog languages; a typo would silently disable a hint.
  const catalogCodes = new Set(codes);
  ok(Object.keys(FUNCTION_WORDS).every((c) => catalogCodes.has(c)),
    'every function-word list belongs to a catalog language');
  ok(Object.keys(SPEECH_ALIASES).every((c) => catalogCodes.has(c)),
    'every alias entry belongs to a catalog language');
  ok(DIACRITIC_LANG.every(([c]) => catalogCodes.has(c)),
    'every unique-diacritic hint belongs to a catalog language');
  ok(DIACRITIC_FAMILY.every((f) => catalogCodes.has(f.fallback) && f.members.every((m) => catalogCodes.has(m))),
    'every shared-accent family member and fallback is a catalog language');

  // Voice matching must be able to reach the tags the catalog advertises, including the aliases.
  ok(SPEECH_ALIASES.no.includes('nb') && SPEECH_ALIASES.no.includes('nn'),
    'Norwegian voices tagged nb/nn are reachable');
  const aliasValues = Object.values(SPEECH_ALIASES).flat();
  ok(!aliasValues.some((a) => codes.includes(a)), 'no alias collides with a catalog code');
  ok(!aliasValues.some((a) => !/^[a-z]{2,3}$/.test(a)), 'every alias is a well-formed subtag');

  // ── One validity guard ───────────────────────────────────────────────────────────────────────────────
  ok(isValidReadAloudLanguage('auto') && isValidReadAloudLanguage('fil') && isValidReadAloudLanguage('FIL'),
    'the shared guard accepts automatic and a three-letter code');
  ok(!isValidReadAloudLanguage('f') && !isValidReadAloudLanguage('english') && !isValidReadAloudLanguage(''),
    'the shared guard rejects values outside the catalog');

  // ── One cap ──────────────────────────────────────────────────────────────────────────────────────────
  ok(MAX_SYSTEM_VOICES >= READ_ALOUD_LANGUAGES.length * 2,
    'the cap holds at least two voices per language, so catalog growth cannot shrink it below the catalog');
  eq(SETTINGS.ttsSystemVoices.maxItems, MAX_SYSTEM_VOICES, 'the settings schema uses the validator cap');
  eq(CLIENT_SETTINGS.limits.ttsSystemVoices, MAX_SYSTEM_VOICES, 'the page receives the same cap');

  // ── One voice-model default ───────────────────────────────────────────────────────────────────────────
  const tts = require(path.join(ROOT, 'lib', 'voice', 'tts'));
  eq(SETTINGS.ttsVoice.default, tts.DEFAULT_VOICE, 'the schema default voice is the engine default');
  ok(tts.isValidVoice(SETTINGS.ttsVoice.default), 'the schema default voice exists in the bundle');
  for (const key of ['podcastVoiceA', 'podcastVoiceB']) {
    ok(tts.isValidVoice(SETTINGS[key].default), `the ${key} default exists in the bundle`);
  }

  // ── One client-side code guard and one voice matcher ─────────────────────────────────────────────────
  const chatJs = read('lib/public/js/chat.js');
  eq(count(chatJs, /const LANGUAGE_CODE_RE =/g), 1, 'one language-code regular expression');
  ok(/function isLanguageCode\(/.test(chatJs) && /function normalizeLanguageCode\(/.test(chatJs),
    'one place validates and normalizes a code');
  eq(count(chatJs, /\^\[a-z\]\{2,3\}\$\/i/g), 0,
    'no inline case-insensitive code check survives outside the shared guard');
  eq(count(chatJs, /function voiceMatchesLanguage\(/g), 1, 'one voice-to-language matcher');
  ok(/voiceMatchesLanguage\(v, want\)/.test(chatJs), 'the playback voice chooser uses the shared matcher');
  ok(/languageVoicePrefixes\(/.test(chatJs) && /aliases/.test(chatJs),
    'the matcher reads the catalog aliases instead of a second local table');

  // ── Settings, diagnostics, and live controls ─────────────────────────────────────────────────────────
  const chatEjs = read('lib/views/chat.ejs');
  ok(/class="settings-row hidden settings-row-voices settings-row-voices-stacked" id="cfg-tts-system-voice-row"/.test(chatEjs),
    'the two voice controls stack on a phone like the other multi-voice rows');
  ok(/voice-field-label[^>]*>Language</.test(chatEjs) && /voice-field-label[^>]*>Voice</.test(chatEjs),
    'the language and voice pickers are visibly labelled');
  ok(/class="settings-hint voice-status voice-status-block" id="cfg-tts-system-status"/.test(chatEjs),
    'the voice status has its own wrapping line, so it cannot be clipped by the label');
  ok(/aria-describedby="cfg-tts-system-status"/.test(chatEjs),
    'the preview explains its state to assistive technology');
  ok(/aria-describedby="readas-detected"/.test(chatEjs),
    'the Read as picker is described by the detected language');
  ok(/aria-describedby="cfg-tts-voices-note"/.test(chatEjs),
    'the diagnostics list is described by its summary');
  ok(/function removeReadAloudControl\(/.test(chatJs) && /\.ans-readas/.test(chatJs),
    'turning read-aloud off removes its control and its menu entry');
  ok(/function setReadAloudLabel\(/.test(chatJs), 'a language change re-labels controls already on screen');
  ok(/answerActionsFor\(row, \{ create: false \}\)/.test(chatJs),
    'the refresh sweep inspects the existing action strip without creating an empty one');
  ok(/dataset\.audioKind = 'read'/.test(chatJs) && /data-audio-kind="read"/.test(chatJs),
    'a read-aloud control is marked and found with the same attribute');
  ok(/dataset\.audioKind = 'podcast'/.test(chatJs),
    'a podcast control is distinguishable from a read-aloud control');
  ok(/still loading/.test(chatJs) && /TTS_VOICE_NAME_CHARS/.test(chatJs),
    'diagnostics wait for the catalog and bound the names they display');

  // ── The browse language and the empty voice list ─────────────────────────────────────────────────────
  ok(/const want = forcedCode \|\| \(saved && saved\.lang\)/.test(chatJs),
    'the browsing language derives from saved state, so Cancel discards an unsaved choice');
  ok(/function refreshSystemVoiceList/.test(chatJs) && /SYSTEM_VOICE_POLL_TRIES/.test(chatJs),
    'a voice list that populates late is polled for a bounded time');
  ok(/function closeSettingsOverlay[\s\S]{0,400}?stopSystemVoicePoll\(\)/.test(chatJs),
    'closing Settings stops a retry that is still running');
  ok(/else \{ stopSystemVoicePoll\(\); \}/.test(chatJs),
    'turning read-aloud off stops the voice-list retry');
  ok(/function setSystemVoicePreviewState/.test(chatJs) && /classList\.toggle\('unavailable'/.test(chatJs),
    'the preview stays operable and explains an empty voice list');
  ok(!/cfgTtsSystemPreview\.disabled = !/.test(chatJs),
    'the preview is never silently disabled');

  // ── The status route serves the one catalog ─────────────────────────────────────────────────────────
  const routeSrc = read('lib/routes/tts.js');
  ok(/languages: READ_ALOUD_LANGUAGES/.test(routeSrc), 'the status route serves the shared catalog');
  ok(/isValidReadAloudLanguage\(cfg\.ttsLanguage\)/.test(routeSrc),
    'the status route validates with the shared guard');

  // ── Docs stay current ────────────────────────────────────────────────────────────────────────────────
  const docs = read('docs/README.md');
  ok(!/playwright|test:webkit/i.test(docs), 'the docs never require a runner the project does not ship');
  ok(/e2e:safari/.test(docs) && /VoiceOver/.test(docs),
    'the automated Safari pass and the manual VoiceOver check are documented');

  console.log(`\nALL READ-ALOUD DRIFT UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ READ-ALOUD DRIFT UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
