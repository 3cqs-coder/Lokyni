'use strict';
// One table for every config key the Settings UI can read or write, plus the numeric knobs the
// config reader and the /api/config writer both clamp. This is the single source of truth for:
//   • the default value used by the config reader (and by the page before a value loads);
//   • the numeric [min, max] bounds used by BOTH the reader clamp and the write clamp;
//   • which keys are writable, clearable, boolean, or secret;
//   • the provider model defaults used by the server and the first-run overlay.
//
// The page receives a compact projection of this table at render time (defaults + numeric ranges +
// provider model defaults), so the browser never carries a second copy of a default or a bound.
// Labels and explanatory hints stay in the view, where the surrounding layout lives.
//
// `uiMin`/`uiMax`/`step` are deliberate NARROWER limits for the Settings inputs (for example, the
// server accepts a 200,000-char passage, while the form offers up to 32,000). They live here beside
// the server bounds so the two can never drift, and the client applies them to `[data-setting]` inputs.

const MODEL_DEFAULTS = Object.freeze({ ollama: 'llama3.2', openai: 'gpt-4o', anthropic: 'claude-sonnet-4-5' });
// The canonical set of chat providers — derived from MODEL_DEFAULTS so there is ONE source. The config reader,
// the /api/models route, and the /api/config write-validator all check against this, so adding a provider here
// (with its default model) makes it accepted everywhere on the SERVER rather than being silently rejected by a
// stale literal. The UI dropdowns render from CLIENT_SETTINGS.providers below (derived from this list), so a new
// provider appears in the first-run overlay and the settings panel automatically. The one piece still written by
// hand is the provider-specific key/host field logic in chat.js; a drift-guard test (fe-be-drift.test.js) fails
// if that field logic ever stops covering a provider in this list, so the two cannot silently fall out of sync.
const PROVIDERS = Object.freeze(Object.keys(MODEL_DEFAULTS));
// The default embedding model is keyed to the EMBEDDING provider, not the chat provider: a portable,
// multilingual open model means the chat provider can change without re-embedding anything. 'local' is the
// bundled, zero-setup embedder — a small multilingual model run in-process (no Ollama, no key). Its id MUST match
// lib/retrieval/localembedcore.js DEFAULT_MODEL_ID (a drift guard asserts this in the unit suite).
const EMBEDDINGS_DEFAULTS = Object.freeze({ local: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', ollama: 'bge-m3', openai: 'text-embedding-3-small' });
// Display metadata for each provider — the ONE place provider labels live. The UI dropdowns render from this
// (via CLIENT_SETTINGS.providers / embeddingProviders) instead of hardcoding option text, so adding a provider to
// MODEL_DEFAULTS above and a row here makes it appear in every dropdown automatically. `note` is the short
// descriptor the first-run overlay appends ("Ollama — local and private"). A provider with no row here falls back
// to its id as the label, so a new provider is never invisible.
const PROVIDER_META = Object.freeze({
  local:     { label: 'Built-in (local)',    note: 'no setup, fully offline' },
  ollama:    { label: 'Ollama',              note: 'local and private' },
  openai:    { label: 'OpenAI / compatible', note: 'hosted' },
  anthropic: { label: 'Anthropic (Claude)',  note: 'hosted' },
});
const providerLabel = (id) => (PROVIDER_META[id] && PROVIDER_META[id].label) || id;
const providerNote  = (id) => (PROVIDER_META[id] && PROVIDER_META[id].note) || '';
// Bound for the saved per-language system-voice preferences. Shared with the validator so the form and the
// server can never disagree about how many entries fit.
const { MAX_SYSTEM_VOICES } = require('./voice/system-voices');
const { MAX_OCR_LANGUAGES } = require('./ocr-languages');

const SETTINGS = {
  // ── Model & provider ──
  provider:            { type: 'string',  default: 'ollama',                 writable: true },
  model:               { type: 'string',  default: '',    writable: true, clearable: true }, // '' → track the provider default in MODEL_DEFAULTS (clearable so "use the default" is reachable)
  embeddingsProvider:  { type: 'string',  default: 'local',                  writable: true }, // bundled local embedder by default — no Ollama/key needed; Ollama/OpenAI opt-in
  embeddingsModel:     { type: 'string',  default: '',    writable: true, clearable: true }, // '' → track the provider default in EMBEDDINGS_DEFAULTS (clearable so "use the default" is reachable)
  embeddingsApiKey:    { type: 'secret',  default: '',                       writable: true }, // openai embed only; falls back to openaiApiKey when blank
  embeddingsBaseUrl:   { type: 'string',  default: '',                       writable: true, clearable: true }, // openai embed only; falls back to openaiBaseUrl when blank
  ollamaHost:          { type: 'string',  default: 'http://localhost:11434', writable: true },
  ollamaKeepAlive:     { type: 'string',  default: '30m',                    writable: true },
  llmTimeoutMs:        { type: 'number',  default: 120000, min: 5000, max: 3600000, int: true, writable: true },
  ollamaApiKey:        { type: 'secret',  default: '',                       writable: true },
  openaiApiKey:        { type: 'secret',  default: '',                       writable: true },
  openaiBaseUrl:       { type: 'string',  default: '',                       writable: true, clearable: true },
  anthropicApiKey:     { type: 'secret',  default: '',                       writable: true },
  anthropicBaseUrl:    { type: 'string',  default: '',                       writable: true, clearable: true },

  // ── Generation ──
  temperature:         { type: 'number',  default: 0.35, min: 0, max: 2, int: false, writable: true, uiMin: 0, uiMax: 2, step: 0.05 },
  maxTokens:           { type: 'number',  default: 0,    min: 0, max: 1048576, int: true, writable: true, uiMin: 0, uiMax: 1048576, step: 256 },
  maxHistory:          { type: 'number',  default: 4,    min: 0, max: 1000,    int: true, writable: true, uiMin: 1, uiMax: 20, step: 1 },
  passageSize:         { type: 'number',  default: 8000, min: 100, max: 200000, int: true, writable: true, uiMin: 2000, uiMax: 32000, step: 1000 },
  numCtx:              { type: 'number',  default: 0,    min: 0, max: 1048576, int: true, writable: true, uiMin: 0, uiMax: 1048576, step: 2048 },
  embeddingContextTokens: { type: 'number', default: 2048, min: 128, max: 1048576, int: true, writable: true, uiMin: 128, uiMax: 131072, step: 128 },

  // ── Conversation ──
  useQueryRewrite:        { type: 'boolean', default: true, writable: true },
  useConversationSummary: { type: 'boolean', default: true, writable: true },
  rewriteMaxTokens:       { type: 'number',  default: 96,  min: 1, max: 100000, int: true, writable: true },
  summaryMaxTokens:       { type: 'number',  default: 400, min: 1, max: 100000, int: true, writable: true },
  historySummaryThresholdChars: { type: 'number', default: 6000, min: 0, max: 100000000, int: true, writable: true },
  historyProtectLastN:    { type: 'number',  default: null, min: 0, max: 1000, int: true, writable: true }, // null → maxHistory × 2
  rewriteModel:           { type: 'string',  default: '', writable: true, clearable: true },
  useIntentClassifier:    { type: 'boolean', default: true, writable: true },
  intentMaxTokens:        { type: 'number',  default: 160, min: 1, max: 100000, int: true, writable: true },
  intentModel:            { type: 'string',  default: '', writable: true, clearable: true },
  useMetaConversation:    { type: 'boolean', default: true, writable: true },
  useTopicSwitchAck:      { type: 'boolean', default: true, writable: true },
  useClarifyingQuestions: { type: 'boolean', default: true, writable: true },
  usePartialMatchTier:    { type: 'boolean', default: true, writable: true },
  useSemanticCache:       { type: 'boolean', default: false, writable: true },
  useSuggestedQuestions:  { type: 'boolean', default: true, writable: true },
  // Answer confidence: a single holistic high/medium/low verdict shown on an answer, blended from signals
  // Lokyni already computes (support, retrieval strength, figures, and — when on — self-consistency). On by
  // default and free (no extra model call on its own). Abstention leads a weak answer with an honest caveat
  // (off by default — it changes the answer text). Self-consistency re-asks the question a few times to catch
  // an unstable answer (off by default — it adds generations). See lib/confidence.js / lib/semanticentropy.js.
  showAnswerConfidence:   { type: 'boolean', default: true,  writable: true },
  abstainOnWeakEvidence:  { type: 'boolean', default: false, writable: true },
  useSemanticEntropy:     { type: 'boolean', default: false, writable: true },
  semanticEntropySamples: { type: 'number',  default: 3, min: 2, max: 6, int: true, writable: true, uiMin: 2, uiMax: 6, step: 1 },

  // ── Retrieval ──
  useReranker:            { type: 'boolean', default: true,  writable: true },
  useColbertRerank:       { type: 'boolean', default: false, writable: true },
  useContextualRetrieval: { type: 'boolean', default: false, writable: true },
  useEmbeddingBanks:      { type: 'boolean', default: true,  writable: true },
  useCorrectiveRetrieval: { type: 'boolean', default: false, writable: true },
  useCrossLingual:        { type: 'boolean', default: true,  writable: true },
  useDocumentSummaries:   { type: 'boolean', default: false, writable: true },
  useAutoSynthesis:       { type: 'boolean', default: false, writable: true },
  useRagFusion:           { type: 'boolean', default: false, writable: true },
  useAdaptiveRetrieval:   { type: 'boolean', default: false, writable: true },
  useHyde:                { type: 'boolean', default: false, writable: true },
  useEntityGraph:         { type: 'boolean', default: false, writable: true },
  useGraphRag:            { type: 'boolean', default: false, writable: true },

  // ── Web search ──
  useWebSearch:           { type: 'boolean', default: true,  writable: true },
  // Web page capture: auto = plain HTTP first, headless browser only when the page needs it; http = never
  // launch a browser; headless = always render. One setting for the single capture ladder in lib/urlfetch.js.
  urlCapture:             { type: 'string',  default: 'auto', writable: true, values: ['auto', 'http', 'headless'] },
  webAutoSuggest:         { type: 'boolean', default: true,  writable: true },
  useWebResultRanking:    { type: 'boolean', default: true,  writable: true },
  webProxyUrl:            { type: 'string',  default: '',    writable: true, clearable: true },
  webProxyRotate:         { type: 'boolean', default: false, writable: true },
  webProxyRetries:        { type: 'number',  default: 2, min: 0, max: 10, int: true, writable: true, uiMin: 0, uiMax: 10, step: 1 },
  webProxyStrict:         { type: 'boolean', default: false, writable: true },
  webSearchResultCount:   { type: 'number',  default: 5,     min: 1, max: 25, int: true, writable: false },
  webSearchFetchCount:    { type: 'number',  default: 3,     min: 1, max: 10, int: true, writable: false },
  webSearchMaxCharsPerPage: { type: 'number', default: 6000, min: 500, max: 200000, int: true, writable: false },
  webSearchTimeoutMs:     { type: 'number',  default: 15000, min: 1000, max: 120000, int: true, writable: false },

  // ── Indexing / OCR / vision ──
  sourceMaxFiles:         { type: 'number',  default: 500, min: 0, max: 100000000, int: true, writable: true },
  sourceMaxFileBytes:     { type: 'number',  default: 25 * 1024 * 1024, min: 0, max: 1099511627776, int: true, writable: true },
  useOcr:                 { type: 'boolean', default: true,  writable: true },
  ocrEngine:              { type: 'string',  default: 'tesseract', writable: true, values: ['tesseract', 'vision'] },
  ocrVisionModel:         { type: 'string',  default: 'llama3.2-vision', writable: true },
  ocrMaxPages:            { type: 'number',  default: 500, min: 1, max: 100000, int: true, writable: true, uiMin: 1, uiMax: 10000, step: 1 },
  ocrWorkers:             { type: 'number',  default: null, min: 1, max: 8, int: true, writable: true, clearable: true },
  ocrLanguages:           { type: 'array',   default: [], writable: true, maxItems: MAX_OCR_LANGUAGES },
  visionDescribe:         { type: 'boolean', default: false, writable: true },
  visionModel:            { type: 'string',  default: '',    writable: true },
  useVisualIngest:        { type: 'boolean', default: false, writable: true },
  visualIngestCropFigures: { type: 'boolean', default: false, writable: true },
  extractionMaxDocs:      { type: 'number',  default: 100,   min: 1, max: 100000, int: true, writable: false },
  extractionMaxCharsPerDoc: { type: 'number', default: 24000, min: 500, max: 500000, int: true, writable: false },
  rerankerDropBelow:      { type: 'number',  default: -8,    min: -20, max: 10, int: false, writable: false },

  // ── Voice / audio ──
  ttsEnabled:             { type: 'boolean', default: false, writable: true },
  ttsVoice:               { type: 'string',  default: 'af_heart', writable: true },
  ttsSpeed:               { type: 'number',  default: 1, min: 0.5, max: 2, int: false, writable: true, uiMin: 0.5, uiMax: 2, step: 0.1 },
  // 'auto' matches each answer's detected language; any other value forces one language. The code list lives in
  // lib/langdetect.js (READ_ALOUD_LANGUAGES), which also validates writes — one source for both ends.
  ttsLanguage:            { type: 'string',  default: 'auto', writable: true },
  // System voices that report themselves as online are never used unless this opt-in is on; local voices and
  // the bundled English model stay fully offline either way.
  ttsAllowOnlineVoices:   { type: 'boolean', default: false, writable: true },
  // Saved system-voice preference per read-aloud language: [{ lang, uri, name }]. The validator in
  // lib/voice/system-voices.js owns the shape and the same cap; the picker never invents extra entries.
  ttsSystemVoices:        { type: 'array',   default: [], writable: true, maxItems: MAX_SYSTEM_VOICES },
  podcastVoiceA:          { type: 'string',  default: 'af_heart', writable: true },
  podcastVoiceB:          { type: 'string',  default: 'am_michael', writable: true },
  sttEnabled:             { type: 'boolean', default: false, writable: true },
  sttLanguage:            { type: 'string',  default: 'en', writable: true },
  micDeviceId:            { type: 'string',  default: '', writable: true, clearable: true },
  micLabel:               { type: 'string',  default: '', writable: true, clearable: true },
  useAudioIngest:         { type: 'boolean', default: false, writable: true },
  audioMaxMinutes:        { type: 'number',  default: 180, min: 1, max: 1440, int: true, writable: true, uiMin: 1, uiMax: 1440, step: 1 },

  // ── Security / diagnostics ──
  auditLog:               { type: 'boolean', default: true,  writable: true },
  allowSignups:           { type: 'boolean', default: false, writable: true },
  allowNetworkAccess:     { type: 'boolean', default: false, writable: true },
  debug:                  { type: 'boolean', default: false, writable: true },
};

const ENTRIES = Object.entries(SETTINGS);
const KEYS = ENTRIES.map(([key]) => key);
const freezeDefault = (v) => (Array.isArray(v) ? Object.freeze(v.slice()) : v);
const SETTING_DEFAULTS = Object.freeze(Object.fromEntries(ENTRIES.map(([key, v]) => [key, freezeDefault(v.default)])));
const WRITABLE_KEYS = Object.freeze(ENTRIES.filter(([, v]) => v.writable === true).map(([key]) => key));
const CLEARABLE_KEYS = Object.freeze(ENTRIES.filter(([, v]) => v.clearable === true).map(([key]) => key));
const SECRET_KEYS = Object.freeze(ENTRIES.filter(([, v]) => v.type === 'secret').map(([key]) => key));
const BOOLEAN_KEYS = Object.freeze(ENTRIES.filter(([, v]) => v.type === 'boolean').map(([key]) => key));
const NUMERIC_RANGES = Object.freeze(Object.fromEntries(ENTRIES
  .filter(([, v]) => v.type === 'number' && Number.isFinite(v.min) && Number.isFinite(v.max))
  .map(([key, v]) => [key, Object.freeze({ min: v.min, max: v.max, ...(v.int !== undefined ? { int: v.int } : {}) })])));

// The compact projection the page receives. Defaults let the client fall back without duplicating a
// literal; numeric ranges let it apply the same (deliberately narrower) input bounds; the provider
// model maps keep the first-run overlay and the server on the same defaults.
const CLIENT_SETTINGS = Object.freeze({
  defaults: SETTING_DEFAULTS,
  numeric: Object.freeze(Object.fromEntries(ENTRIES
    .filter(([, v]) => v.type === 'number' && Number.isFinite(v.min) && Number.isFinite(v.max))
    .map(([key, v]) => [key, Object.freeze({
      min: v.min, max: v.max, int: v.int === true,
      ...(v.uiMin !== undefined ? { uiMin: v.uiMin } : {}),
      ...(v.uiMax !== undefined ? { uiMax: v.uiMax } : {}),
      ...(v.step !== undefined ? { step: v.step } : {}),
    })]))),
  modelDefaults: MODEL_DEFAULTS,
  embeddingDefaults: EMBEDDINGS_DEFAULTS,
  // Ordered provider lists the page renders its dropdowns from — one source for the option set AND the labels, so
  // the first-run overlay, the settings chat-provider picker, and the embeddings picker can never drift from the
  // backend provider set. Embeddings providers are only those with an embedding default (Anthropic has none).
  providers: Object.freeze(PROVIDERS.map(id => Object.freeze({ id, label: providerLabel(id), note: providerNote(id) }))),
  embeddingProviders: Object.freeze(Object.keys(EMBEDDINGS_DEFAULTS).map(id => Object.freeze({ id, label: providerLabel(id) }))),
  limits: Object.freeze({ ocrLanguages: SETTINGS.ocrLanguages.maxItems, ttsSystemVoices: SETTINGS.ttsSystemVoices.maxItems }),
  // The answer-confidence level vocabulary (label + css class), single-sourced from lib/confidence.js so the
  // chip on the page can never disagree with the backend on what a level is called or styled.
  confidenceLevels: require('./confidence').CONFIDENCE_LEVELS,
  // The answer-export download identity (MIME, extension, base label), single-sourced from lib/docx.js so the
  // client's Save-As picker and anchor download agree with the server's Content-Type / Content-Disposition.
  export: Object.freeze({
    docxMime: require('./docx').DOCX_MIME,
    docxExt: require('./docx').DOCX_EXT,
    answerBaseLabel: require('./docx').ANSWER_BASE_LABEL,
  }),
});

const settingDefault = (key) => SETTING_DEFAULTS[key];

module.exports = {
  SETTINGS,
  SETTING_DEFAULTS,
  SETTING_KEYS: KEYS,
  WRITABLE_KEYS,
  CLEARABLE_KEYS,
  SECRET_KEYS,
  BOOLEAN_KEYS,
  NUMERIC_RANGES,
  CLIENT_SETTINGS,
  MODEL_DEFAULTS,
  PROVIDERS,
  EMBEDDINGS_DEFAULTS,
  settingDefault,
};
