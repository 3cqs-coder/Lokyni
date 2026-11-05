'use strict';
// Drift guard for the POST /api/config writable-key allowlist (server.CONFIG_WRITABLE_KEYS).
// A recurring regression risk is a feature toggle getting exposed by GET /api/config but left
// out of the allowlist (so it can never be saved), or a toggle silently dropped from the
// allowlist, or a duplicate/typo creeping in. This asserts the allowlist stays well-formed and
// keeps every user-facing feature toggle writable. No server spin-up needed. Run: `npm run test:unit`.

const path = require('path'), fs = require('fs'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { CONFIG_WRITABLE_KEYS } = require(path.join(PROJECT, 'lib', 'server'));
const { BOOLEAN_KEYS: SCHEMA_BOOLEAN_KEYS, WRITABLE_KEYS: SCHEMA_WRITABLE_KEYS, NUMERIC_RANGES: SCHEMA_RANGES } = require(path.join(PROJECT, 'lib', 'settings-schema'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  ok(Array.isArray(CONFIG_WRITABLE_KEYS) && CONFIG_WRITABLE_KEYS.length > 0, 'allowlist is a non-empty array');
  ok(CONFIG_WRITABLE_KEYS.every(k => typeof k === 'string' && k.length > 0), 'every entry is a non-empty string');

  // No duplicates (a duplicate usually means a bad merge or a copy-paste slip).
  const dupes = CONFIG_WRITABLE_KEYS.filter((k, i) => CONFIG_WRITABLE_KEYS.indexOf(k) !== i);
  ok(dupes.length === 0, `no duplicate keys (found: ${[...new Set(dupes)].join(', ') || 'none'})`);
  console.log('✓ config-drift: allowlist is well-formed with no duplicates');

  // Every user-facing feature toggle must stay writable — guards against one being dropped.
  const MUST_BE_WRITABLE = [
    'useReranker', 'useColbertRerank', 'useContextualRetrieval', 'useEmbeddingBanks', 'useIntentClassifier',
    'useCorrectiveRetrieval', 'useCrossLingual', 'useSemanticCache', 'useSuggestedQuestions', 'useRagFusion',
    'useAdaptiveRetrieval', 'useHyde', 'useEntityGraph', 'useGraphRag', 'useDocumentSummaries', 'useAutoSynthesis',
    'useWebSearch', 'webAutoSuggest', 'useOcr', 'visionDescribe', 'useVisualIngest',
    'visualIngestCropFigures', 'auditLog', 'debug',
  ];
  const missing = MUST_BE_WRITABLE.filter(k => !CONFIG_WRITABLE_KEYS.includes(k));
  ok(missing.length === 0, `every feature toggle is writable (missing: ${missing.join(', ') || 'none'})`);
  console.log('✓ config-drift: every user-facing feature toggle is in the allowlist');

  // Every boolean toggle in the allowlist must ALSO be in the server's BOOLEAN coercion set, or a POST
  // would persist the raw string "false" — which is truthy, the exact bug the coercion prevents. The two
  // lists are separate in server.js, so tie them together here. (Every MUST_BE_WRITABLE `use*`/known
  // boolean is checked; non-boolean writable keys like model names are intentionally not in BOOLEAN.)
  const serverSrcForBool = fs.readFileSync(path.join(PROJECT, 'lib', 'server.js'), 'utf-8');
  ok(/const BOOLEAN = new Set\(BOOLEAN_KEYS\)/.test(serverSrcForBool),
    'the BOOLEAN coercion set is derived from the shared settings schema');
  const BOOLEAN_KEYS = new Set(SCHEMA_BOOLEAN_KEYS);
  const KNOWN_BOOLEANS = MUST_BE_WRITABLE.filter(k => k.startsWith('use') || k.startsWith('web') || k === 'visionDescribe' || k === 'visualIngestCropFigures' || k === 'auditLog' || k === 'debug');
  const notCoerced = KNOWN_BOOLEANS.filter(k => CONFIG_WRITABLE_KEYS.includes(k) && !BOOLEAN_KEYS.has(k));
  ok(notCoerced.length === 0, `every boolean toggle is in the BOOLEAN coercion set (missing: ${notCoerced.join(', ') || 'none'})`);
  console.log('✓ config-drift: every boolean toggle is coerced from the schema (no raw-string persistence)');

  // The writable allowlist itself is the schema's writable list, not a second hand-maintained array.
  ok(SCHEMA_WRITABLE_KEYS.length === CONFIG_WRITABLE_KEYS.length
     && SCHEMA_WRITABLE_KEYS.every(k => CONFIG_WRITABLE_KEYS.includes(k)),
    'the server writable allowlist is exactly the schema writable list');

  // Config.json-only knobs must NOT be writable via the API. They are set by editing
  // config.json, and GET /api/config does not return them — so making one writable would
  // create a write-only key (a POST can set it, but neither GET nor the UI can read it back).
  // `port` and `browseFilesystemRoot` are additionally kept out for safety. This list must
  // stay in sync with the "intentionally NOT here" note on CONFIG_WRITABLE_KEYS in server.js.
  const CONFIG_JSON_ONLY = [
    'ragFusionQueries', 'hydeMaxTokens', 'visualIngestMaxPages', 'visualIngestMaxBytes',
    'correctiveCosineMax', 'webOfferMaxRerankerScore', 'webSearchResultCount', 'webSearchFetchCount',
    'webSearchMaxCharsPerPage', 'webSearchTimeoutMs', 'port', 'sourceExclude', 'browseFilesystemRoot',
    'minFileSize', 'visionInputMaxEdge', 'visionTemperature', 'visionMaxTags',
    'rrfK', 'rrfFaissWeight', 'rrfBm25Weight', 'fileLogging',
  ];
  const leaked = CONFIG_JSON_ONLY.filter(k => CONFIG_WRITABLE_KEYS.includes(k));
  ok(leaked.length === 0, `config.json-only knobs stay out of the allowlist (leaked: ${leaked.join(', ') || 'none'})`);
  console.log('✓ config-drift: config.json-only tuning knobs are not API-writable');

  // Every writable key must be a real config.js reader — no phantoms/typos. config.json keys
  // are camelCase and mostly differ from the exported constant names (ollamaHost → OLLAMA_HOST),
  // so we check that readRawConfig round-trips each: a value written under the key is read back.
  const cfg = require(path.join(PROJECT, 'lib', 'config'));
  ok(typeof cfg.readRawConfig === 'function', 'config exposes readRawConfig for the round-trip check');

  // The documented "key invariant": every writable key is ALSO returned by GET /api/config, so each
  // round-trips through the Settings UI rather than being write-only. server.js claims a drift guard
  // asserts this, so actually assert it here. Parse the GET handler's returned object and collect its
  // property names (line-start `key:`, so comments and value expressions don't count). The two
  // secrets are returned as presence flags (…Set), never the value.
  const serverSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'server.js'), 'utf-8');
  const getStart = serverSrc.indexOf("app.get('/api/config'");
  const getEnd   = serverSrc.indexOf("app.post('/api/config'");
  ok(getStart !== -1 && getEnd > getStart, 'the GET /api/config handler is present before POST');
  const getBlock = serverSrc.slice(getStart, getEnd);
  const returnedKeys = new Set([...getBlock.matchAll(/^\s+([a-zA-Z][a-zA-Z0-9]*)\s*:/gm)].map(m => m[1]));
  const SECRET_RETURNED_AS = { ollamaApiKey: 'ollamaApiKeySet', openaiApiKey: 'openaiApiKeySet', anthropicApiKey: 'anthropicApiKeySet', embeddingsApiKey: 'embeddingsApiKeySet' };
  const writeOnly = CONFIG_WRITABLE_KEYS.filter(k => !returnedKeys.has(SECRET_RETURNED_AS[k] || k));
  ok(writeOnly.length === 0, `every writable key is returned by GET /api/config (write-only: ${writeOnly.join(', ') || 'none'})`);
  console.log('✓ config-drift: every writable key round-trips through GET /api/config');

  // ── Numeric bounds are now SINGLE-SOURCED in config.js NUMERIC_RANGES, consumed by BOTH the config
  //    reader (each num() clamp) and the Settings writer (server.js builds its clamp table from it). This
  //    makes the old reader/writer drift (the llmTimeoutMs 1000-vs-5000 bug) structurally impossible rather
  //    than merely checked, so this guards that the single-sourcing is actually wired both ways.
  const configSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'config.js'), 'utf-8');
  const RANGES = cfg.NUMERIC_RANGES;
  ok(Object.keys(SCHEMA_RANGES).length === Object.keys(RANGES).length, 'config re-exports the schema numeric ranges without a second table');
  ok(RANGES && typeof RANGES === 'object', 'config.js exports the shared NUMERIC_RANGES table');
  const rangeKeys = Object.keys(RANGES);
  ok(rangeKeys.length >= 12, `NUMERIC_RANGES defines the numeric knobs (found ${rangeKeys.length})`);
  // Every entry is well-formed: finite min <= max, and `int` (when present) is boolean.
  const malformed = rangeKeys.filter(k => {
    const r = RANGES[k];
    return !r || !Number.isFinite(r.min) || !Number.isFinite(r.max) || r.min > r.max
      || (('int' in r) && typeof r.int !== 'boolean');
  });
  ok(malformed.length === 0, `every NUMERIC_RANGES entry is well-formed (malformed: ${malformed.join(', ') || 'none'})`);

  // The web-search numeric knobs are hand-edit-only (config.json-only, above), so the READER clamp is their
  // only guard against an out-of-range/non-integer value — e.g. a fetch-count that would fan out thousands of
  // concurrent page fetches, or a per-page char cap that would buffer gigabytes. They must be in the table.
  const WEB_NUMERIC = ['webSearchResultCount', 'webSearchFetchCount', 'webSearchMaxCharsPerPage', 'webSearchTimeoutMs'];
  const unclamped = WEB_NUMERIC.filter(k => !RANGES[k] || typeof RANGES[k].max !== 'number');
  ok(unclamped.length === 0, `web-search numeric knobs are reader-clamped via NUMERIC_RANGES (unclamped: ${unclamped.join(', ') || 'none'})`);

  // The WRITER must derive its clamp table from the shared ranges — no competing hardcoded literal.
  ok(/Object\.entries\(require\('\.\/config'\)\.NUMERIC_RANGES\)/.test(serverSrc),
    'server.js builds its Settings clamp table from config.NUMERIC_RANGES (single source)');
  ok(!/const NUMERIC = \{\s*temperature:/.test(serverSrc),
    'server.js no longer carries its own hardcoded NUMERIC bounds literal (would reintroduce drift)');

  // The READER must route each shared knob through the shared ranges — not an inline {min,max} that could
  // drift. Every key in NUMERIC_RANGES that the reader reads should appear as `NUMERIC_RANGES.<key>`; the
  // one documented exception is ocrWorkers, whose reader keeps special null auto-size semantics (the range
  // still protects the write path).
  const readerExceptions = new Set(['ocrWorkers']);
  const notRouted = rangeKeys.filter(k => !readerExceptions.has(k)
    && new RegExp(`providerConfig\\.${k}\\b`).test(configSrc)   // the reader actually reads this knob
    && !new RegExp(`num\\(providerConfig\\.${k},[^;]*NUMERIC_RANGES\\.${k}\\)`).test(configSrc));
  ok(notRouted.length === 0,
    `every reader knob clamps through the shared NUMERIC_RANGES (not routed: ${notRouted.join(', ') || 'none'})`);
  console.log('✓ config-drift: numeric bounds are single-sourced in config.NUMERIC_RANGES (reader + writer both derive from it)');

  // ── Single-source hygiene: a few values that were duplicated as re-typed literals across files. ──
  const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');
  // The 500 MB upload default lives once in constants.DEFAULT_MAX_FILE_BYTES; config and the upload route
  // derive from it, never a re-typed `500 * 1024 * 1024`.
  ok(/DEFAULT_MAX_FILE_BYTES\s*=\s*500 \* 1024 \* 1024/.test(read('lib/constants.js')), 'the 500 MB upload default is defined once in constants');
  ok(/num\(providerConfig\.maxFileBytes,\s*DEFAULT_MAX_FILE_BYTES/.test(read('lib/config.js')), 'config derives MAX_FILE_SIZE from the shared default');
  ok(!/500 \* 1024 \* 1024/.test(read('lib/routes/documents.js')), 'the upload route does not re-type the 500 MB literal (uses DEFAULT_MAX_FILE_BYTES)');
  // The API-key scope vocabulary is single-sourced (authz.SCOPE_CAPS → apikeys.ALL_SCOPES); the watchdog must
  // not re-type the scope names as a fallback that would go stale when a scope is added.
  ok(!/\['search',\s*'summarize',\s*'read',\s*'write'\]/.test(read('lib/watchdog.js')), 'the watchdog does not hardcode the scope-name list (derives from apikeys.ALL_SCOPES)');
  // The default voices are single-sourced from the settings schema; the engine fallbacks and the frontend
  // picker derive from it rather than re-typing the voice ids.
  ok(/_SCHEMA\.ttsVoice\.default/.test(read('lib/voice/tts.js')) && /_SCHEMA\.podcastVoiceA\.default/.test(read('lib/voice/tts.js')) && /_SCHEMA\.podcastVoiceB\.default/.test(read('lib/voice/tts.js')),
    'tts derives its default voices (read-aloud + both podcast hosts) from the settings schema');
  ok(/tts\.DEFAULT_VOICE_A\b/.test(read('lib/voice/podcast.js')) && /tts\.DEFAULT_VOICE_B\b/.test(read('lib/voice/podcast.js')),
    'podcast reuses the tts podcast-host default voices (A from podcastVoiceA, B from podcastVoiceB — no re-typed ids)');
  ok(/settingDefault\('podcastVoiceA'\)/.test(read('lib/public/js/chat.js')) && /settingDefault\('podcastVoiceB'\)/.test(read('lib/public/js/chat.js')),
    'the podcast-voice picker falls back to the projected schema defaults, not hardcoded voice ids');
  console.log('✓ config-drift: upload-size default, scope vocabulary, and default voices are each single-sourced');

  // The chat-provider enum is single-sourced (schema PROVIDERS = MODEL_DEFAULTS keys); the /api/models route and
  // the /api/config write-validator derive from it, never a re-typed ['ollama','openai','anthropic'] literal.
  const schema = require(path.join(PROJECT, 'lib', 'settings-schema'));
  ok(Array.isArray(schema.PROVIDERS) && schema.PROVIDERS.join(',') === Object.keys(schema.MODEL_DEFAULTS).join(','),
    'schema.PROVIDERS is derived from MODEL_DEFAULTS (one source)');
  ok(/new Set\(PROVIDERS\)/.test(read('lib/server.js')) && /if \(PROVIDERS\.includes\(val\)\)/.test(read('lib/server.js')),
    'the /api/models and /api/config provider checks derive from schema.PROVIDERS (no hardcoded list)');
  ok(!/val === 'ollama' \|\| val === 'openai' \|\| val === 'anthropic'/.test(read('lib/server.js')),
    'the hardcoded three-provider literal is gone from the write-validator');
  // The ocrEngine enum is single-sourced in the schema values, consumed by both config read and the writer.
  ok(Array.isArray(schema.SETTINGS.ocrEngine.values) && schema.SETTINGS.ocrEngine.values.join(',') === 'tesseract,vision',
    'ocrEngine has a schema values list (single source)');
  ok(/SETTINGS\.ocrEngine\.values\.includes/.test(read('lib/config.js')) && /SETTINGS\.ocrEngine\.values\.includes/.test(read('lib/server.js')),
    'both the config reader and the writer validate ocrEngine against the schema values');
  console.log('✓ config-drift: the provider enum and ocrEngine enum are single-sourced from the schema');

  console.log(`\nALL CONFIG-DRIFT UNIT TESTS PASSED (${checks} checks)`);
  process.exitCode = 0;
} catch (e) {
  console.error('\n✗ CONFIG-DRIFT UNIT TEST FAILED:', e && e.message);
  process.exitCode = 1;
}
