'use strict';
// Guards the single settings source (lib/settings-schema.js) end to end:
//   • the schema itself is well-formed (types, defaults, numeric bounds);
//   • the writable / clearable / secret / boolean lists and NUMERIC_RANGES are derived from it;
//   • the config reader uses the schema default (`def`) and boolean semantics (`flag`) instead of
//     carrying a second copy of each literal;
//   • the API derives its write allowlist/coercions from the schema;
//   • the page receives the compact projection and the client uses it for defaults, input bounds,
//     and provider model defaults;
//   • every settings control is present, and the default template agrees with the schema.
// No server spin-up, no model, no network. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const {
  SETTINGS, SETTING_DEFAULTS, WRITABLE_KEYS, CLEARABLE_KEYS, SECRET_KEYS, BOOLEAN_KEYS,
  NUMERIC_RANGES, CLIENT_SETTINGS, MODEL_DEFAULTS, EMBEDDINGS_DEFAULTS, settingDefault,
} = require(path.join(ROOT, 'lib', 'settings-schema'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

try {
  const configSrc = read('lib/config.js');
  const serverSrc = read('lib/server.js');
  const chatEjs = read('lib/views/chat.ejs');
  const chatJs = read('lib/public/js/chat.js');
  const defaultsFile = JSON.parse(read('config/config.json.default'));

  // ── 1. The schema is well-formed ──
  const entries = Object.entries(SETTINGS);
  ok(entries.length >= 60, `the schema covers the Settings surface (${entries.length} entries)`);
  const badType = entries.filter(([, v]) => !['string', 'number', 'boolean', 'secret', 'array'].includes(v.type));
  ok(badType.length === 0, `every entry has a known type (bad: ${badType.map(([k]) => k).join(', ') || 'none'})`);
  const badDefault = entries.filter(([, v]) => {
    if (v.type === 'number') return v.default !== null && !Number.isFinite(v.default);
    if (v.type === 'boolean') return typeof v.default !== 'boolean';
    if (v.type === 'array') return !Array.isArray(v.default);
    return typeof v.default !== 'string';
  });
  ok(badDefault.length === 0, `every default has its declared type (bad: ${badDefault.map(([k]) => k).join(', ') || 'none'})`);
  const badRange = entries.filter(([, v]) => v.type === 'number' && v.min !== undefined
    && (!Number.isFinite(v.min) || !Number.isFinite(v.max) || v.min > v.max));
  ok(badRange.length === 0, `every numeric range is finite and ordered (bad: ${badRange.map(([k]) => k).join(', ') || 'none'})`);
  const uiOutside = entries.filter(([, v]) => v.type === 'number' && v.uiMin !== undefined
    && (v.uiMin < v.min || v.uiMax > v.max || v.uiMin > v.uiMax));
  ok(uiOutside.length === 0, `no form-only bound escapes the server clamp (bad: ${uiOutside.map(([k]) => k).join(', ') || 'none'})`);
  ok(settingDefault('temperature') === 0.35 && settingDefault('useReranker') === true,
    'settingDefault reads the canonical table');
  ok(settingDefault('ttsLanguage') === 'auto' && SETTINGS.ttsLanguage.writable === true,
    'read-aloud language defaults to automatic and is writable');
  ok(settingDefault('ttsAllowOnlineVoices') === false && BOOLEAN_KEYS.includes('ttsAllowOnlineVoices'),
    'online system voices are an opt-in boolean');
  ok(Array.isArray(settingDefault('ttsSystemVoices')) && SETTINGS.ttsSystemVoices.maxItems > 0 &&
     CLIENT_SETTINGS.limits.ttsSystemVoices === SETTINGS.ttsSystemVoices.maxItems,
    'per-language system-voice preferences share one bounded array schema');

  // ── 2. Every derived set comes from that one table ──
  ok(WRITABLE_KEYS.length > 50 && WRITABLE_KEYS.every((k) => SETTINGS[k].writable === true),
    'writable keys are the schema entries marked writable');
  ok(CLEARABLE_KEYS.every((k) => SETTINGS[k].clearable === true) &&
     CLEARABLE_KEYS.includes('webProxyUrl') && CLEARABLE_KEYS.includes('micDeviceId'),
    'clearable keys are the schema entries marked clearable');
  ok(SECRET_KEYS.length === 4 && SECRET_KEYS.every((k) => SETTINGS[k].type === 'secret') &&
     ['ollamaApiKey', 'openaiApiKey', 'embeddingsApiKey', 'anthropicApiKey'].every((k) => SECRET_KEYS.includes(k)),
    'secret keys are exactly the schema entries typed secret (incl. the separate embeddings key)');
  ok(BOOLEAN_KEYS.length > 20 && BOOLEAN_KEYS.every((k) => SETTINGS[k].type === 'boolean'),
    'boolean keys are the schema entries typed boolean');
  ok(Object.keys(NUMERIC_RANGES).every((k) => SETTINGS[k].type === 'number'
    && NUMERIC_RANGES[k].min === SETTINGS[k].min && NUMERIC_RANGES[k].max === SETTINGS[k].max),
    'NUMERIC_RANGES is derived from the schema numbers');
  ok(NUMERIC_RANGES.ocrWorkers.max === 8 && NUMERIC_RANGES.maxTokens.min === 0,
    'the documented OCR-worker maximum and the Auto (0) token sentinel survive the move');

  // ── 3. The config reader uses the schema, not a second literal copy ──
  ok(/settingDefault: def/.test(configSrc) && /const flag = \(key, value\) =>/.test(configSrc),
    'config.js imports the schema default helper and defines the shared boolean reader');
  ok(/num\(providerConfig\.temperature, def\('temperature'\), NUMERIC_RANGES\.temperature\)/.test(configSrc),
    'numeric defaults read def(key) while keeping the shared clamp');
  ok(/flag\('useReranker', providerConfig\.useReranker\)/.test(configSrc) &&
     /flag\('useOcr', providerConfig\.useOcr\)/.test(configSrc) &&
     /flag\('auditLog', providerConfig\.auditLog\)/.test(configSrc),
    'boolean defaults route through flag(key, value)');
  ok(/providerConfig\.provider\s+\|\|\s+def\('provider'\)/.test(configSrc) &&
     /providerConfig\.ollamaHost \|\| def\('ollamaHost'\)/.test(configSrc),
    'string defaults route through def(key)');
  ok(/MODEL_DEFAULTS\[AI_PROVIDER\]/.test(configSrc) && /EMBEDDINGS_DEFAULTS\[EMBEDDINGS_PROVIDER\]/.test(configSrc),
    'the provider model defaults come from the schema, not a local map');
  ok(!/const NUMERIC_RANGES = \{/.test(configSrc) && !/const MODEL_DEFAULTS = \{/.test(configSrc),
    'config.js no longer carries its own numeric-range or model-default tables');

  // ── 4. The API derives its write contract from the schema ──
  ok(/const CONFIG_WRITABLE_KEYS = WRITABLE_KEYS;/.test(serverSrc), 'the write allowlist is the schema writable list');
  ok(/key === 'ttsLanguage'[\s\S]{0,120}isValidReadAloudLanguage\(val\)/.test(serverSrc),
    'the read-aloud language is enum-guarded on save (only auto or a catalog code persists)');
  ok(/const CLEARABLE = new Set\(CLEARABLE_KEYS\)/.test(serverSrc) &&
     /const SECRETS = new Set\(SECRET_KEYS\)/.test(serverSrc) &&
     /const BOOLEAN = new Set\(BOOLEAN_KEYS\)/.test(serverSrc),
    'the clearable, secret, and boolean coercions are all schema-derived');
  ok(/settingsSchema: CLIENT_SETTINGS/.test(serverSrc), 'the page receives the schema projection');

  // ── 5. The page and client consume the projection ──
  ok(/meta name="lokyni-settings" content="<%= JSON\.stringify\(typeof settingsSchema/.test(chatEjs),
    'the settings projection is handed to the page');
  ok(/const SETTINGS_META = \(\(\) =>/.test(chatJs) && /const settingDefault = \(key\) =>/.test(chatJs),
    'the client parses the projection and exposes one default helper');
  ok(/function applySettingRanges\(\)/.test(chatJs) &&
     /document\.querySelectorAll\('\[data-setting\]'\)/.test(chatJs),
    'the client applies the schema form bounds to every opted-in input');
  ok(/const DEFAULT_MODELS = PROVIDER_MODEL_DEFAULTS;/.test(chatJs),
    'the first-run overlay uses the schema provider defaults');
  ok(!/ollama: 'llama3\.2', openai: 'gpt-4o'/.test(chatJs), 'no second provider-model map survives in the client');
  ok(/settingDefault\('temperature'\)/.test(chatJs) && /settingDefault\('maxTokens'\)/.test(chatJs),
    'the client load/save fallbacks use the schema defaults');
  ok(/id="cfg-tts-language"/.test(chatEjs) && /id="cfg-tts-online-voices"/.test(chatEjs),
    'the read-aloud language picker and online-voice opt-in have Settings controls');
  ok(/id="cfg-tts-system-voice"/.test(chatEjs) && /id="cfg-tts-system-preview"/.test(chatEjs),
    'the per-language system-voice picker and preview have Settings controls');
  ok(/id="cfg-tts-system-language"/.test(chatEjs),
    'the voice picker has a language context independent of read-aloud playback');
  ok(/ttsLanguage: cfgTtsLanguage\.value/.test(chatJs) && /ttsAllowOnlineVoices: cfgTtsOnlineVoices\.checked/.test(chatJs) &&
     /ttsSystemVoices: ttsSystemVoicePrefs/.test(chatJs),
    'all voice controls round-trip through the config API');

  // Numeric inputs opt into the schema and no longer repeat a min/max/step.
  const numericIds = ['cfg-temperature','cfg-max-tokens','cfg-num-ctx','cfg-max-history','cfg-passage-size',
    'cfg-embedding-context','cfg-ocr-max-pages','cfg-web-proxy-retries','cfg-audio-minutes','cfg-tts-speed'];
  for (const id of numericIds) {
    const re = new RegExp(`id="${id}"[^>]*data-setting="([a-zA-Z]+)"`);
    const m = chatEjs.match(re);
    ok(!!m && !!SETTINGS[m[1]] && SETTINGS[m[1]].type === 'number', `${id} maps to a schema number`);
    ok(!new RegExp(`id="${id}"[^>]*\\bmin=`).test(chatEjs) && !new RegExp(`id="${id}"[^>]*\\bmax=`).test(chatEjs),
      `${id} does not repeat a hardcoded bound`);
  }
  // The three default-on feature checkboxes no longer hardcode checked: the server value decides.
  for (const id of ['cfg-query-rewrite','cfg-conv-summary','cfg-intent-classifier']) {
    ok(!new RegExp(`id="${id}"[^>]*\\bchecked`).test(chatEjs), `${id} takes its state from the server`);
  }

  // ── 6. The previously config-only conversation toggles are in Settings ──
  for (const [id, key] of [
    ['cfg-meta-conversation','useMetaConversation'],
    ['cfg-topic-switch-ack','useTopicSwitchAck'],
    ['cfg-clarifying-questions','useClarifyingQuestions'],
    ['cfg-partial-match','usePartialMatchTier'],
    ['cfg-semantic-cache','useSemanticCache'],
    ['cfg-suggested-questions','useSuggestedQuestions'],
  ]) {
    ok(new RegExp(`id="${id}"`).test(chatEjs), `${key} has a Settings control`);
    const refName = 'cfg' + id.replace(/^cfg-/, '').replace(/(^|-)([a-z])/g, (_, __, c) => c.toUpperCase());
    ok(new RegExp(`const ${refName} = document\\.getElementById\\('${id}'\\)`).test(chatJs),
      `${key} is wired in the client as ${refName}`);
    ok(new RegExp(`\\b${key}\\b`).test(chatJs), `${key} is loaded or saved by the client`);
    ok(WRITABLE_KEYS.includes(key), `${key} is writable through the API`);
  }

  // ── 7. The shipped template agrees with the schema ──
  for (const [key, value] of Object.entries(defaultsFile)) {
    ok(!!SETTINGS[key], `config.json.default key ${key} exists in the schema`);
    if (key === 'model') { ok(value === MODEL_DEFAULTS[defaultsFile.provider], 'the template model is the provider default'); continue; }
    if (key === 'embeddingsModel') { ok(value === '' || value === EMBEDDINGS_DEFAULTS[defaultsFile.embeddingsProvider || defaultsFile.provider] || value === EMBEDDINGS_DEFAULTS.ollama, 'the template embeddings model is blank (resolves to the per-provider default) or a concrete provider default'); continue; }
    ok(JSON.stringify(value) === JSON.stringify(SETTINGS[key].default), `config.json.default ${key} matches the schema`);
  }

  // ── 8. The projection carries no secret VALUE (only empty defaults) ──
  for (const k of SECRET_KEYS) ok(CLIENT_SETTINGS.defaults[k] === '', `the projection carries no secret value for ${k}`);
  ok(CLIENT_SETTINGS.modelDefaults.openai === MODEL_DEFAULTS.openai &&
     CLIENT_SETTINGS.embeddingDefaults.ollama === EMBEDDINGS_DEFAULTS.ollama,
    'the projection includes the provider model maps');
  ok(CLIENT_SETTINGS.limits.ocrLanguages === SETTINGS.ocrLanguages.maxItems,
    'the projection carries the OCR-language cap, so the form and the server agree');

  console.log(`\nALL SETTINGS-SCHEMA UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ SETTINGS-SCHEMA UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
