'use strict';
// ----------------------------
// Provider Configuration
// ----------------------------
// Load from config.json if present; otherwise use built-in defaults. Configuration comes
// from config.json (which the Settings UI writes) and command-line arguments — not
// environment variables.
//
// config.json — the most common keys shown below with defaults. This is NOT exhaustive:
// every tunable (OCR/vision, conversational-intelligence toggles, web search, RRF weights,
// embedding banks, faithfulness, SMTP, bindAddress, …) is read the same way — see the
// "Configuration" section of the README for the complete, documented list.
// {
//   "provider":          "ollama" | "openai" | "anthropic",   // the CHAT provider
//   "model":             "llama3.2" | "gpt-4o" | "claude-sonnet-4-5" | etc,
//   "embeddingsProvider":"ollama" | "openai",   // optional — the provider used to EMBED, independent of
//                                               //   the chat provider; defaults to the chat provider when
//                                               //   it can embed, else Ollama (Anthropic cannot embed)
//   "embeddingsModel":   "bge-m3" | "nomic-embed-text" | "text-embedding-3-small",  // optional
//   "embeddingsApiKey":  "sk-...",                   // openai embed only — a SEPARATE key; blank reuses openaiApiKey
//   "embeddingsBaseUrl": "https://...",              // openai embed only — a SEPARATE base URL; blank reuses openaiBaseUrl
//   "ollamaHost":        "http://localhost:11434",  // ollama only
//   "ollamaApiKey":      "",                         // ollama only — for Ollama Cloud / authenticated proxies
//   "openaiApiKey":      "sk-...",                   // openai only
//   "openaiBaseUrl":     "https://...",              // openai only, optional
//   "anthropicApiKey":   "sk-ant-...",               // anthropic only
//   "anthropicBaseUrl":  "https://api.anthropic.com/v1/",  // anthropic only, optional (its compat endpoint)
//
//   // Tunable retrieval / UX settings (all optional, shown with defaults):
//   "maxHistory":       4,      // conversation turns kept in LLM context
//   "passageSize":      8000,   // chars served per document passage
//   "minCosineScore":   0.35,   // minimum FAISS cosine similarity to accept a query
//   "debounceTime":     3000,   // ms to wait after file change before re-indexing
//   "temperature":      0.35,   // LLM sampling temperature
//   "maxTokens":        1024,   // max tokens in LLM response
//   "assistantRole":    "You are a research assistant...",  // LLM persona
//
//   // Cross-encoder reranker (optional, disabled by default):
//   "useReranker":      true,   // enable cross-encoder passage reranking (on by default)
//   "rerankerModel":    "Xenova/ms-marco-MiniLM-L-6-v2"  // ~23MB quantized, downloads once
// }

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { DEFAULT_PORT, APP_NAME, DEFAULT_MAX_FILE_BYTES, CACHE_FILES } = require('./constants');
const { isValidReadAloudLanguage } = require('./langdetect');
const { normalize: normalizeSystemVoices } = require('./voice/system-voices');

// Canonical location of config.json — the live settings file and its shipped template
// (config.json.default) both live in a `config/` folder beside the install, resolved once and
// exported so every writer (/api/config, the SMTP route) targets the exact same file this reader
// loads, rather than each re-deriving a path that only agrees when cwd happens to equal the install dir.
const CONFIG_DIR  = path.resolve('config');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

let providerConfig = {};
try {
  const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  // JSON.parse succeeds for a literal `null`, an array, or a number/string too, none of which is a settings
  // object — reading `.provider` off such a value would throw an ugly stack trace at import. Treat a
  // non-plain-object config as broken so it hits the same actionable message below rather than crashing.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SyntaxError('config.json must contain a JSON object');
  }
  providerConfig = parsed;
} catch (e) {
  if (e && e.code === 'ENOENT') {
    // No config.json at all — a fresh install. Fall back to built-in defaults.
  } else {
    // A config.json EXISTS but couldn't be read or parsed — a hand-edit typo, a truncated
    // write, or a permissions problem. Silently booting on all-defaults would discard every
    // setting the user has (provider, model, keys, indexed folders) and behave as if freshly
    // installed, which is both mysterious and, for the stored provider keys, quietly wrong.
    // Refuse to start with an actionable message instead, so the mistake is obvious and fixable.
    if (e instanceof SyntaxError) {
      console.error(`\n❌ ${CONFIG_PATH} is not valid JSON: ${e.message}`);
      console.error('   Fix the JSON (a stray comma or an unquoted key is the usual cause),');
      console.error('   or delete the file to start fresh with defaults.');
    } else {
      console.error(`\n❌ Could not read ${CONFIG_PATH}: ${e.message}`);
      console.error('   Check the file’s permissions and that it is a readable file,');
      console.error('   or delete it to start fresh with defaults.');
    }
    console.error('   Lokyni will not start on a broken config, to avoid silently losing your settings.\n');
    process.exit(1);
  }
}

// Raw read of config.json for a WRITER that merges onto it (the Settings + SMTP routes).
// Returns {} on a missing/unreadable/broken file — deliberately different from the
// import-time read above, which refuses to start: a writer merging onto {} and writing a
// valid file is the safe recovery, not an exit. Single source for both routes.
const readRawConfig = () => {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};   // never merge onto null/array/primitive
  } catch (e) { return {}; }
};
// Durable atomic write of config.json through the shared `disk.writeFileAtomic` (unique per-writer temp +
// fsync-before-rename), so an interrupted or overlapping save can't leave a truncated or torn file that the
// import-time reader would then refuse to start on. Using the shared writer keeps this on the same hardened
// durable-write discipline as the rest of the app, instead of a private, weaker copy.
const writeConfigAtomic = (obj) => {
  // Create the config/ folder on first write — a fresh install runs on built-in defaults with no config
  // file, so the folder may not exist until the first Settings save. The folder and file are owner-only
  // (0700/0600) so another local user can't read them; on Windows these bits are effectively ignored, which
  // is harmless (the data-dir ACLs and the sealed secrets below are the boundary there).
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // Seal reversible secrets before the value ever touches disk, so the file never holds a plaintext credential
  // once a key exists. sealVerified round-trips first — a key problem degrades to plaintext (still 0600), never
  // an unrecoverable secret. Work on a clone so the caller's in-memory (plaintext) object is left untouched.
  const toWrite = JSON.parse(JSON.stringify(obj));
  for (const p of CONFIG_SECRET_PATHS) {
    const v = _getPath(toWrite, p);
    if (typeof v === 'string' && v) _setPath(toWrite, p, secretbox.sealVerified(v, p, SECRET_KEY_SRC));
  }
  // URL settings: seal only when the value actually embeds a credential, so a credential-free host list stays
  // legible at rest (and the common case writes exactly as before). A value already carrying the UI mask is a
  // caller bug guarded earlier (the writer keeps the stored value instead), so it never reaches here.
  for (const p of MASKCRED_PATHS) {
    const v = _getPath(toWrite, p);
    if (typeof v === 'string' && urlcreds.hasUrlCredentials(v)) _setPath(toWrite, p, secretbox.sealVerified(v, p, SECRET_KEY_SRC));
  }
  require('./disk').writeFileAtomic(CONFIG_PATH, JSON.stringify(toWrite, null, 2), 0o600);
};

// One-time, best-effort migration of an existing install's PLAINTEXT secrets to sealed form. Called once at
// server startup (primary only). No-op when there is no master key (nothing to seal with → keep plaintext),
// when config.json is absent/empty, or when every secret is already sealed. Re-saving through
// writeConfigAtomic seals each plaintext secret and leaves already-sealed ones untouched (idempotent). Never
// throws. Returns true only if it actually rewrote the file.
const migrateSecrets = () => {
  try {
    if (!secretbox.master(SECRET_KEY_SRC)) return false;
    const raw = readRawConfig();
    const hasPlaintext = CONFIG_SECRET_PATHS.some((p) => {
      const v = _getPath(raw, p);
      return typeof v === 'string' && v && !secretbox.isSealed(v);
    }) || MASKCRED_PATHS.some((p) => {
      const v = _getPath(raw, p);
      return typeof v === 'string' && urlcreds.hasUrlCredentials(v) && !secretbox.isSealed(v);
    });
    if (!hasPlaintext) return false;
    writeConfigAtomic(raw);
    return true;
  } catch { return false; }
};

// Read a numeric tunable robustly: coerce to a number, fall back to `def` when it is absent, empty, the
// wrong type, or non-finite, then clamp to [min, max] and round when `int`. The Settings API already
// clamps these on write, but a hand-edited config.json is the documented surface for advanced knobs and
// bypasses that — a wrong-type or out-of-range value (a string numCtx became NaN and silently disabled
// document truncation; maxTokens 0 produced empty answers) would otherwise poison the answer path. Making
// the READER clamp keeps one source of truth for the ranges regardless of how the value entered the file.
const num = (v, def, { min = -Infinity, max = Infinity, int = false } = {}) => {
  let n = (v === '' || v == null) ? def : Number(v);
  if (!Number.isFinite(n)) n = def;
  if (int) n = Math.round(n);
  return Math.min(max, Math.max(min, n));
};

// Single source of truth for the numeric-tunable ranges and the Settings defaults. The schema is
// consumed by the config READER below (each num() call passes its entry, so a hand-edited config.json is
// clamped on read), by the Settings WRITE path (lib/server.js builds its clamp table from NUMERIC_RANGES),
// and by the rendered page (a compact projection supplies defaults and input bounds). Defining them once
// means the read-side clamp, the write-side clamp, and the form can never drift.
const {
  NUMERIC_RANGES,
  MODEL_DEFAULTS,
  EMBEDDINGS_DEFAULTS,
  SECRET_KEYS,
  settingDefault: def,
} = require('./settings-schema');
const secretbox = require('./secretbox');
const { normalizeOcrLanguages } = require('./ocr-languages');

// Read a boolean setting using its schema default, preserving the existing truthiness semantics:
// a default-on flag treats anything except `false` as on; a default-off flag only treats `true` as on.
// A missing/null value takes the schema default, so the literal lives in one place.
const flag = (key, value) => {
  const d = def(key);
  if (value === undefined || value === null) return d === true;
  return d === true ? value !== false : value === true;
};

// Configuration comes from config.json (which the Settings UI writes) with built-in
// defaults — not environment variables. Runtime flags like debug are command-line
// arguments (see below), matching how the app is launched (`npm start debug`).
// Read a string command-line argument, in either `--name value` or `--name=value` form. Command-line
// arguments are a configuration mechanism here alongside config.json (never environment variables),
// so a container or launcher can set the bind address or provider host without editing config.json.
const cliArg = (name) => {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && argv[i + 1] != null) return argv[i + 1];
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
  }
  return null;
};

// The per-user/per-OS data directory, resolved once (a relative --data-dir is made absolute so every reader
// agrees even if the process cwd changes later). Computed here, before the provider-key reads below, because
// the secret master-key file lives under it. The network-bind safety gate further down also needs it.
const DATA_DIR = (() => {
  const override = (cliArg('data-dir') || '').trim();
  return override ? path.resolve(override) : './data';
})();

// A read-only directory of BUNDLED OCR language packs, passed by the desktop shell (which ships the English
// floor pack as a resource) via --bundled-tessdata-dir. On first OCR these are seeded into the writable tessdata
// directory so a fresh — possibly offline — desktop install can read scanned pages without a network fetch. Unset
// in the standalone and container modes, where the fetch-once path is used instead; so one code path serves every
// mode. Made absolute so it resolves regardless of the process working directory.
const BUNDLED_TESSDATA_DIR = (() => {
  const v = (cliArg('bundled-tessdata-dir') || '').trim();
  return v ? path.resolve(v) : null;
})();

// ── Secrets at rest ────────────────────────────────────────────────────────────────────────────────────
// Reversible credentials in config.json (provider API keys, the SMTP password, the OIDC client secret) are
// sealed with lib/secretbox. The master-key source — resolved ONCE and shared with every other secret store
// (e.g. connectors) via the SECRET_KEY_SRC export — is, in order: an explicit --secret-key-file path, else
// $LOKYNI_SECRET_KEY (operator key, never written to disk), else a key file generated under the data dir,
// kept SEPARATE from config.json so a copied/shared config cannot carry the key that opens it.
const SECRET_KEY_SRC = (() => {
  const flagPath = (cliArg('secret-key-file') || '').trim();
  if (flagPath) return path.resolve(flagPath);
  const env = process.env[secretbox.ENV_VAR];
  if (env && String(env).length >= 16) return secretbox.ENV_SENTINEL;
  return path.join(DATA_DIR, 'secret.key');
})();
// The config.json paths holding a reversible secret: the schema's type:'secret' keys, plus the two nested
// credential fields. ONE list drives open-on-read, seal-on-write, and the lazy migration, so they can't drift.
const CONFIG_SECRET_PATHS = [...SECRET_KEYS, 'smtp.pass', 'oidc.clientSecret'];
// URL settings that MAY embed an inline credential (scheme://user:pass@host). Their password is a reversible
// credential, so it is sealed at rest — but ONLY when the value actually carries one, so a credential-free
// host list stays legible at rest and the common case is unchanged. These are opened on read like any secret,
// masked (password only) in the Settings echo, and a save that still carries the mask keeps the stored value.
const urlcreds = require('./urlcreds');
const MASKCRED_PATHS = ['webProxyUrl', 'ollamaHost', 'openaiBaseUrl', 'anthropicBaseUrl', 'embeddingsBaseUrl'];
const _getPath = (o, p) => p.split('.').reduce((x, k) => (x && typeof x === 'object') ? x[k] : undefined, o);
const _setPath = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); let x = o; for (const k of ks) { if (!x[k] || typeof x[k] !== 'object') return; x = x[k]; } x[last] = v; };
// Open any sealed secret in the loaded config IN PLACE, so every reader below (OPENAI_KEY, the exported oidc
// block, OLLAMA_HOST/OPENAI_BASE, the SMTP route) sees plaintext. A legacy plaintext value passes through
// unchanged and migrates on the next save; an unopenable sealed value is left verbatim so the dependent call
// fails cleanly, not the app. The maskcred URL fields open the same way (a sealed value only exists when it
// carried a credential; a plain host list is a no-op here).
let _sealedOpenFailed = false;
for (const p of [...CONFIG_SECRET_PATHS, ...MASKCRED_PATHS]) {
  const v = _getPath(providerConfig, p);
  if (typeof v !== 'string' || !v) continue;
  const opened = secretbox.readSecret(v, p, SECRET_KEY_SRC);
  if (secretbox.isSealed(opened)) _sealedOpenFailed = true;   // readSecret returned it still sealed → couldn't decrypt
  _setPath(providerConfig, p, opened);
}
// Surface a changed/missing master key loudly rather than let provider/SMTP/SSO auth fail with a confusing
// error and no clue. One dated warning (captured by the in-app log viewer); the credentials still fail cleanly,
// and re-entering them in Settings (or restoring the key) recovers. Honest self-heal: we never hide this.
if (_sealedOpenFailed) {
  console.warn('⚠️  A stored secret in config.json could not be decrypted — the secret key may have changed or be missing. The affected credential(s) (provider key, SMTP, or SSO) will fail to authenticate until the key is restored or the value is re-entered in Settings.');
}

const AI_PROVIDER  = providerConfig.provider     || def('provider');
// `--ollama-host <url>` overrides config.json, so a container can point at a bundled Ollama service
// (for example http://ollama:11434) without a config file existing yet on first run.
const OLLAMA_HOST  = (cliArg('ollama-host') || '').trim() || providerConfig.ollamaHost || def('ollamaHost');
// Optional bearer token for Ollama. Local installs need none, but Ollama Cloud and
// any authenticated reverse proxy in front of a remote Ollama require one. Sent as
// an Authorization header on both chat and embeddings requests.
const OLLAMA_KEY   = providerConfig.ollamaApiKey  || '';
// How long Ollama keeps the model loaded in memory after a request. Keeping it warm
// avoids a multi-second reload before each answer (an expired model is re-read from disk),
// which is the biggest free latency win for interactive use. Accepts Ollama's duration form
// ("30m", "1h") or a number of seconds; -1 keeps it loaded until Ollama restarts, 0 unloads
// immediately. Longer holds more memory. Ollama's own default is 5 minutes; Lokyni defaults
// to 30 minutes for a smoother single-user session.
const OLLAMA_KEEP_ALIVE = providerConfig.ollamaKeepAlive ?? def('ollamaKeepAlive');
// Idle timeout for a model call, in milliseconds. If no output arrives for this long — the
// provider is unreachable, the model is wedged, or a stream stalled mid-answer — the call is
// abandoned and the answer ends gracefully instead of hanging the request forever (the Ollama
// client sets no HTTP timeout of its own). Reset on every chunk, so a slow-but-progressing
// answer is never cut off. Clamped to [5000, 3600000] — the SAME bounds the /api/config writer
// enforces, so a value saved through the UI reads back and runs at exactly what was stored (a
// 1s timeout would cut off every real model call; an hour is the practical ceiling).
const LLM_TIMEOUT_MS = num(providerConfig.llmTimeoutMs, def('llmTimeoutMs'), NUMERIC_RANGES.llmTimeoutMs);
// Idle timeout for an EMBEDDING call, in milliseconds. A query embedding is a provider network
// call on the search hot path; if the endpoint accepts the connection but never responds (a model
// reload stall, a proxy that holds the connection, a network black-hole) the embed would otherwise
// hang forever, wedging the per-connection socket queue behind it. Bound it separately from
// generation because an embed is a short single request, not a streamed answer — on timeout the
// dense hit list degrades to empty (a normal miss) so retrieval still returns keyword results.
// Defaults lower than LLM_TIMEOUT_MS; minimum 5s.
const EMBED_TIMEOUT_MS = Math.max(5000, parseInt(providerConfig.embedTimeoutMs, 10) || 60000);
const OPENAI_KEY   = providerConfig.openaiApiKey  || '';
const OPENAI_BASE  = providerConfig.openaiBaseUrl || '';
// Anthropic (Claude) is reached through its OpenAI-compatible endpoint, so it reuses the whole OpenAI
// transport (streaming, abort, idle-timeout) with its own key and base URL — no extra dependency. Its
// base URL defaults to Anthropic's compatibility endpoint; an empty value falls back to that default.
const ANTHROPIC_KEY  = providerConfig.anthropicApiKey  || '';
const ANTHROPIC_BASE = (providerConfig.anthropicBaseUrl || '').trim() || 'https://api.anthropic.com/v1/';

// Providers that can produce embeddings. Anthropic has no embeddings endpoint, so it is a CHAT-only
// provider; a corpus is always embedded by one of these. Single source — consumers (the embeddings
// provider resolver below, config validation, the Settings UI) read it rather than re-listing.
const PROVIDERS_WITH_EMBEDDINGS = ['ollama', 'openai'];

// The embedding provider is resolved INDEPENDENTLY of the chat provider, so the chat model/provider can
// change (including to a chat-only provider like Anthropic) without ever re-embedding the corpus:
//   1. an explicit `embeddingsProvider` (must be one that can embed) wins;
//   2. else the chat provider, when it can embed (the common case — one provider for both);
//   3. else fall back to Ollama (local, no key), so selecting a chat-only provider still leaves a
//      working embedder instead of a provider that cannot embed.
const _rawEmbProvider = String(providerConfig.embeddingsProvider || '').trim().toLowerCase();
const EMBEDDINGS_PROVIDER = PROVIDERS_WITH_EMBEDDINGS.includes(_rawEmbProvider)
  ? _rawEmbProvider
  : (PROVIDERS_WITH_EMBEDDINGS.includes(AI_PROVIDER) ? AI_PROVIDER : 'ollama');

const LLM_MODEL = providerConfig.model || MODEL_DEFAULTS[AI_PROVIDER] || MODEL_DEFAULTS.ollama;

// Embeddings model — keyed to the EMBEDDING provider (not the chat provider), overridable via config.json.
// The Ollama default is a portable, multilingual open model: it runs the same on local Ollama or any
// OpenAI-compatible host, so the chat provider can change without the embeddings being tied to a
// vendor's proprietary model. A lighter model (nomic-embed-text, all-minilm) is one setting away for a
// memory-constrained machine — the Settings "Suggest models" picker recommends by available memory.
const EMBEDDINGS_MODEL = providerConfig.embeddingsModel
  || EMBEDDINGS_DEFAULTS[EMBEDDINGS_PROVIDER]
  || EMBEDDINGS_DEFAULTS.ollama;

// Embed-endpoint credentials for an OpenAI-COMPATIBLE embed provider, resolved INDEPENDENTLY of the chat
// provider. These are the RAW configured values (blank when unset, already opened from seal); the fallback to
// the chat OpenAI key/base is applied once at the use site (makeEmbeddings), so the Settings form shows blank
// when a value is relying on the chat default. A hosted embed endpoint (serving, say, a multilingual open model
// the chat vendor does not host) can thus carry its OWN key and host without disturbing the chat key, and a
// blank field changes nothing (no regression). The key is a schema `secret` (sealed at rest); the base is a
// MASKCRED path (userinfo sealed). Only the openai embed path reads these — an Ollama embed host stays on
// ollamaHost/ollamaApiKey.
const EMBEDDINGS_API_KEY  = providerConfig.embeddingsApiKey  || '';
const EMBEDDINGS_BASE_URL = providerConfig.embeddingsBaseUrl || '';

// The effective base URL for the EMBEDDING endpoint, resolved ONE way for every caller — the bank fingerprint
// (banks.currentMeta), the embedder (embeddings.makeEmbeddings) and the pre-switch predictor all call this, so a
// bank is always fingerprinted by the exact endpoint it is embedded against. Without this, an embeddings-endpoint
// change could silently mix two vector spaces into one bank. `override` is a frozen bank's own stored baseUrl and
// wins. It reads from the passed `cfg`, so it works with the live config and with an injected test config alike.
function embedBaseUrl(cfg, provider, override) {
  return String(override || (provider === 'openai' ? (cfg.EMBEDDINGS_BASE_URL || cfg.OPENAI_BASE || '') : (cfg.OLLAMA_HOST || '')));
}

// ----------------------------
// Application Configuration
// ----------------------------
// Debug logging is enabled by the `debug` command-line argument (`npm start debug`) OR by a
// `"debug": true` setting in config.json. The config-file path exists for the packaged desktop app,
// whose server is a bundled sidecar the user cannot pass a command-line argument to — a Settings
// toggle writes the flag, and the app restarts the sidecar to apply it. It is deliberately read once
// at startup (many modules capture DEBUG at load), so changing it takes effect on the next start.
const DEBUG        = process.argv.includes('debug') || flag('debug', providerConfig.debug);
// Port the web UI listens on. Configurable so it can avoid collisions and so the
// service commands (--status / --open) know where to look. The default lives in
// lib/constants.js so it's defined in exactly one place.
const PORT         = (() => {
  // A `--port N` (or `--port=N`) command-line argument overrides config.json, so a launcher
  // or a quick manual run can place the server on a specific or free port without editing
  // config. Command-line arguments are the configuration mechanism here, not environment
  // variables. Falls back to config.json, then to the default in lib/constants.js.
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    let v = null;
    if (argv[i] === '--port' && argv[i + 1]) v = argv[i + 1];
    else if (argv[i].startsWith('--port=')) v = argv[i].split('=')[1];
    if (v != null) {
      const n = parseInt(v, 10);
      if (Number.isInteger(n) && n > 0) return n;
    }
  }
  const p = parseInt(providerConfig.port, 10);
  return Number.isInteger(p) && p > 0 ? p : DEFAULT_PORT;
})();
// The address the web server binds to. Defaults to loopback so a private, local-first
// tool isn't unintentionally exposed to the whole network (its control plane — config,
// file browsing, backups — is same-origin, not API-key-gated). A reverse proxy on the
// same host reaches it on loopback unchanged. Set to '0.0.0.0' (via `--bind 0.0.0.0` or
// bindAddress in config.json) only if you deliberately want direct access from other machines —
// inside a container this is required so a published port can reach the server. The `--bind`
// argument takes precedence over config.json, so a container sets it without a config file.
// `allowNetworkAccess` is the friendly Settings toggle for the same thing: ON binds to 0.0.0.0 so other devices
// on the network can reach Lokyni. An explicit `--bind` / `bindAddress` still wins (advanced/container use). The
// safety gate below refuses to actually expose it to the network unless a sign-in is configured.
const ALLOW_NETWORK_ACCESS = flag('allowNetworkAccess', providerConfig.allowNetworkAccess);
// An explicit `--bind` / `bindAddress` is an advanced operator override (containers, reverse proxies) and wins
// over the friendly toggle. We remember when the network bind came from the TOGGLE (rather than an explicit
// address) so the auth gate below only ever overrides the toggle — never an address the operator chose by hand.
const _explicitBind = (cliArg('bind') || '').trim()
  || (typeof providerConfig.bindAddress === 'string' && providerConfig.bindAddress.trim() ? providerConfig.bindAddress.trim() : '');
let BIND_ADDRESS = _explicitBind || (ALLOW_NETWORK_ACCESS ? '0.0.0.0' : '127.0.0.1');
// Extra Host header values the DNS-rebinding guard accepts when bound to loopback. Empty by
// default: only loopback Hosts are allowed, which is correct for direct local use and for a
// reverse proxy that rewrites the upstream Host to localhost. Set this to your public
// hostname(s) in config.json (e.g. ["lokyni.example.com"]) when a proxy forwards the original
// Host unchanged, so the guard accepts them instead of returning "Unrecognized Host". This is a
// deployment/security setting, so it is config.json-only and never writable through the API.
const TRUSTED_HOSTS = Array.isArray(providerConfig.trustedHosts)
  ? providerConfig.trustedHosts.filter(h => typeof h === 'string' && h.trim()).map(h => h.trim().toLowerCase())
  : [];
// Force the DNS-rebinding Host guard ON even when NOT bound to loopback. Binding 0.0.0.0 is a
// mechanical requirement inside a container (a published port cannot reach a server bound to
// 127.0.0.1), not a decision to serve the open network — but the guard normally switches off for a
// non-loopback bind, which would leave the unauthenticated control plane exposed to a rebinding
// attack against someone browsing on the container host. The Docker image sets --enforce-host-guard
// so only loopback and configured trustedHosts are accepted; a native install that deliberately
// binds to the network for open LAN access leaves this off. config.json-only + CLI, never API-writable.
const ENFORCE_HOST_GUARD = process.argv.includes('--enforce-host-guard')
  || cliArg('enforce-host-guard') === 'true'
  || providerConfig.enforceHostGuard === true;
// DATA_DIR (workspaces, the index, API keys, ledgers, the reranker model, the secret key) is resolved once
// near the top of this module (it anchors the secret master-key path); see its definition above.
// Safety gate (the "auth before exposure" rule): the friendly network toggle must never expose Lokyni unless a
// way to sign in is configured — at least one account, or SSO — because the whole document corpus AND the
// same-origin control plane (config, file browsing, backups) would otherwise be open to anyone on the network.
// The Settings UI and the /api/config write path both block enabling the toggle without an account, so this only
// fires when the TOGGLE is on in a hand-edited config.json; when it does, fall back to loopback and warn loudly.
// An explicit `--bind` / `bindAddress` is an advanced, deliberate operator choice (containers, a reverse proxy
// in front, external network controls), so it is respected either way — but we still warn when it exposes an
// unauthenticated instance. Needs DATA_DIR, hence computed here.
{
  const isLoopbackBind = (a) => !a || a === '127.0.0.1' || a === '::1' || a === 'localhost';
  if (!isLoopbackBind(BIND_ADDRESS)) {
    let authed = false;
    try { authed = require('./users').count(DATA_DIR) > 0; } catch { /* users store unreadable → treat as no auth */ }
    if (!authed) { const o = providerConfig.oidc; authed = !!(o && o.enabled && o.issuer && o.clientId); }
    if (!authed) {
      if (_explicitBind) {
        console.warn(`⚠️  Lokyni is bound to ${BIND_ADDRESS} with no account set up — anyone who can reach this address can read your documents. Create an account (or put an authenticating proxy in front) to require sign-in.`);
      } else {
        console.warn('⚠️  Network access is on but no account is set up — staying on 127.0.0.1 so Lokyni is not left open to the network. Create an account in Settings, then restart.');
        BIND_ADDRESS = '127.0.0.1';
      }
    }
  }
}
// Documents and the vector index live under the ACTIVE workspace, so these are
// resolved on each access rather than fixed at import. Modules that need a stable
// path for one operation should read them once into a local.
const _ws = () => {
  // Required lazily: state has no dependencies, but requiring at module top would
  // create a cycle through the modules that import config.
  const st = require('./state');
  const wsm = require('./workspaces');
  const id = wsm.isValidId(st.workspaceId) ? st.workspaceId : wsm.DEFAULT_ID;
  return { id, wsm };
};
const currentDocsDir  = () => { const { id, wsm } = _ws(); return wsm.docsDirFor(DATA_DIR, id); };
const currentCacheDir = () => { const { id, wsm } = _ws(); return wsm.cacheDirFor(DATA_DIR, id); };
// The active workspace's persona — a short instruction prepended to the answer prompt so a
// workspace can set its own tone/role/audience. Read fresh on each access (like the
// workspace paths) so switching workspaces takes effect immediately, and returns '' when
// unset or unreadable so the answer path is unchanged by default. Grounding is untouched:
// buildMessages still appends the fixed grounding rules AFTER the persona.
const currentPersona = () => personaFor(_ws().id);

// The persona for a SPECIFIC workspace, not necessarily the active one. A window viewing a non-active
// workspace answers with THAT workspace's persona, so this resolves it by id. Returns '' when unset or
// unreadable so the prompt is unchanged by default. Only persona (and indexed folders) are per-workspace;
// the model, context size, and grounding rules are global, so this is the one per-request answer setting.
const personaFor = (workspaceId) => {
  try {
    const wsm = require('./workspaces');
    const id = wsm.isValidId(workspaceId) ? workspaceId : wsm.DEFAULT_ID;
    const p = wsm.loadSettings(DATA_DIR, id).persona;
    return typeof p === 'string' ? p.trim() : '';
  } catch { return ''; }
};

// Additional folders to index alongside data/documents. Files here are indexed
// IN PLACE — never copied — so the originals stay where the user keeps them and
// nothing is duplicated. Each entry is either a plain path string or an object:
//   { "path": "~/Documents/notes", "recursive": true, "maxDepth": 3 }
// Paths starting with ~ are expanded to the home directory.
const expandHome = (p) => (typeof p === 'string' && p.startsWith('~'))
  ? path.join(os.homedir(), p.slice(1))
  : p;

const normalizeSources = (raw) => (Array.isArray(raw) ? raw : []).map(entry => {
  const o = typeof entry === 'string' ? { path: entry } : (entry || {});
  if (!o.path) return null;
  // A folder can be disabled from the settings panel without removing its entry, so its path and
  // options are kept in the saved config for when it's switched back on. Disabling drops it from the
  // active source list here, so its documents are purged from the index (a disabled folder should not
  // return results); re-enabling re-indexes them, which for a large folder means re-embedding — the
  // config entry is preserved, not the index.
  if (o.enabled === false) return null;
  return {
    path:      path.resolve(expandHome(o.path)),
    recursive: o.recursive === true,          // off by default — one level only
    maxDepth:  Number.isInteger(o.maxDepth) ? o.maxDepth : 3,
  };
}).filter(Boolean);

// Indexed folders belong to the ACTIVE WORKSPACE, not the install. Sharing them
// globally meant a brand-new workspace immediately inherited every file from every
// configured folder — which defeats the purpose of having separate workspaces.
// A legacy global `sourcePaths` in config.json is still honored by the default
// workspace so existing installs keep working (see migrateLegacySources).
const currentSourcePaths = () => {
  try {
    const { id, wsm } = _ws();
    const ws = wsm.loadSettings(DATA_DIR, id);
    if (Array.isArray(ws.sourcePaths)) return normalizeSources(ws.sourcePaths);
    // Only the default workspace falls back to the old global setting.
    if (id === wsm.DEFAULT_ID) return normalizeSources(providerConfig.sourcePaths);
    return [];
  } catch { return []; }
};

// Guard rails for indexing folders the user doesn't curate. A Downloads directory
// can hold thousands of files, most irrelevant; without limits the vector store
// balloons and retrieval quality drops as the corpus is diluted.
// Allow the folder picker to browse from the filesystem root. Off by default: the
// picker already reaches the home directory and every mounted volume, and enabling
// this makes the browse endpoint able to enumerate directory names anywhere on the
// machine. Only useful for indexing system paths like /srv or /opt.
const BROWSE_FS_ROOT = providerConfig.browseFilesystemRoot === true;

// Clamp through num() (not a bare ??) so a hand-edited non-numeric or out-of-range value can't become NaN
// and silently disable these per-source OOM/size guards. Bounds match the /api/config writer table.
const SOURCE_MAX_FILE_BYTES = num(providerConfig.sourceMaxFileBytes, def('sourceMaxFileBytes'), NUMERIC_RANGES.sourceMaxFileBytes); // 25 MB
const SOURCE_MAX_FILES      = num(providerConfig.sourceMaxFiles, def('sourceMaxFiles'), NUMERIC_RANGES.sourceMaxFiles);      // per source folder
// Glob-ish substrings; a path containing any of these is skipped.
const SOURCE_EXCLUDE = Array.isArray(providerConfig.sourceExclude)
  ? providerConfig.sourceExclude
  : ['node_modules', '.git', 'Library/', '/AppData/', '.Trash', 'venv', '__pycache__'];
const currentManifestPath = () => path.join(currentCacheDir(), CACHE_FILES.manifest);

// Files smaller than this are skipped — they carry no useful signal and would
// dilute retrieval. Lower it if you keep genuinely short notes you want searchable.
// ── OCR ──
// Scanned PDFs and images carry no text layer, so they index as empty and vanish
// from the corpus silently. When enabled, those pages are rendered and recognized.
// ON by default because the default engine (tesseract) ships with Lokyni and needs
// nothing pulled — see the engine note below. It is slower than plain text extraction,
// so set "useOcr": false to skip it. (The heavier 'vision' engine still needs a model
// pulled first and is opt-in via ocrEngine.)
const USE_OCR          = flag('useOcr', providerConfig.useOcr);
// 'tesseract' is the default because it genuinely works on a fresh install: the
// package ships with Lokyni and its ~10 MB language data downloads automatically on
// first use. 'vision' produces markedly better results on messy scans, tables and
// multi-column layouts — but needs a multi-gigabyte model pulled first
// (`ollama pull llama3.2-vision`), which can't be done for the user. Selecting
// 'vision' without the model falls back to tesseract rather than failing.
const OCR_ENGINE       = require('./settings-schema').SETTINGS.ocrEngine.values.includes(providerConfig.ocrEngine) ? providerConfig.ocrEngine : def('ocrEngine');
const OCR_VISION_MODEL = providerConfig.ocrVisionModel || def('ocrVisionModel');
// Vision-describe: optionally describe images that have no extractable text so
// they become searchable by content. OFF by default and independent of the OCR
// engine — it needs a vision model the user explicitly selects, and vision models
// are heavy, so a user without the processing power simply leaves it off.
const VISION_DESCRIBE     = flag('visionDescribe', providerConfig.visionDescribe);
const VISION_MODEL        = providerConfig.visionModel || '';
const VISION_INPUT_MAX_EDGE = Number(providerConfig.visionInputMaxEdge) || 1024;
const VISION_TEMPERATURE  = providerConfig.visionTemperature == null ? 0.2 : Number(providerConfig.visionTemperature);
const VISION_MAX_TAGS     = Number(providerConfig.visionMaxTags) || 12;
// ── Visual ingest (figure / table QA) ──
// Describe figures, charts, and tables inside PDFs at index time with the vision model, so
// their content becomes searchable — a chart's takeaway or a table's data that the plain
// text layer loses. Each page is rendered and passed to the vision model; the descriptions
// are appended to the document's indexed text. OFF by default and independent of the
// image-only vision-describe: it needs a vision model the user selects (visionModel), is
// slow (one vision call per page), and applies only to PDFs. `visualIngestMaxPages` caps
// pages described per PDF; `visualIngestMaxBytes` skips PDFs too large to render safely in
// the main process (rendering loads the whole file, so a very large PDF is left to the
// text/OCR path only). Reuses the OCR page renderer and the vision backend — no new deps.
const useVisualIngest      = flag('useVisualIngest', providerConfig.useVisualIngest);
const visualIngestMaxPages = Number.isInteger(providerConfig.visualIngestMaxPages) ? providerConfig.visualIngestMaxPages : 20;
const visualIngestMaxBytes = Number.isFinite(providerConfig.visualIngestMaxBytes) ? providerConfig.visualIngestMaxBytes : 50 * 1024 * 1024;
// For office documents (DOCX/PPTX), visual ingest describes the images embedded in the file
// rather than rendering pages (there is no page renderer for those formats). This caps how
// many images are described per document, and the smallest edge an image must have to be
// worth describing — so decorative icons, bullets, and logos are skipped.
const visualIngestMaxImages = Number.isInteger(providerConfig.visualIngestMaxImages) ? providerConfig.visualIngestMaxImages : 12;
const visualIngestMinImageEdge = Number.isInteger(providerConfig.visualIngestMinImageEdge) ? providerConfig.visualIngestMinImageEdge : 160;
// Crop each detected figure/table into its own thumbnail image, saved alongside the index and
// shown on the cited source in the UI. This asks the vision model for a bounding box per
// figure (in addition to the description), then crops the rendered page (PDFs) or reuses the
// embedded image (DOCX/PPTX) with sharp. Off by default and only active when visual ingest is
// on; it adds a little work and some disk for the crops. Falls back gracefully: a figure with
// no usable box is still described in text, just without a thumbnail.
const visualIngestCropFigures = flag('visualIngestCropFigures', providerConfig.visualIngestCropFigures);
// A ceiling on pages per document. Memory is bounded regardless of length (pages are OCR'd in small
// slices), so the only cost of a higher cap is time — OCR is seconds per page — and a truncated document
// is always reported. The default is set high enough to read a typical long document (a contract, filing,
// or report) in full, while still capping a pathological multi-thousand-page scan so one document can't
// dominate a first index. Raise it in Settings for a corpus of very long scans.
// Clamp like the other numeric knobs (and matching the /api/config bounds), so a hand-edited config.json
// with 0, a negative, a string, or an absurd value can't flip the page cap to "unlimited" or a nonsense
// number — it falls back to a sane, bounded value instead.
const OCR_MAX_PAGES    = num(providerConfig.ocrMaxPages, def('ocrMaxPages'), NUMERIC_RANGES.ocrMaxPages);
// The embedding model's context window, in tokens. It bounds how large a single chunk may be before
// the embedder rejects it ("input length exceeds the context length"), which would drop that chunk from
// dense search. The default of 2048 tokens is a safe size that fits the common embedding models,
// including the default (bge-m3 accepts far more, so 2048-token chunks fit comfortably). If you switch
// to a model with a smaller window — many alternatives are 512 or 256 — lower this so chunks are sized
// to fit. Chunks are
// capped in CHARACTERS below this many tokens, which is always safe because a token never spans fewer
// than one character, so a chunk of N characters is at most N tokens regardless of language.
const EMBEDDING_CONTEXT_TOKENS = num(providerConfig.embeddingContextTokens, def('embeddingContextTokens'), NUMERIC_RANGES.embeddingContextTokens);
// How many pages to recognize at once. Defaults to roughly two fewer than the core
// count and capped at 4 (see lib/ocr.js) — enough to cut wall-clock time substantially
// without making the rest of the machine sluggish while indexing runs.
const OCR_WORKERS      = Number.isInteger(providerConfig.ocrWorkers) ? providerConfig.ocrWorkers : def('ocrWorkers');
// Additional OCR languages selected in Settings, normalized to the catalog's engine codes (English is
// always included by the engine and is not stored here). Bounded so one selection cannot make every
// worker load an unbounded set of packs.
const OCR_LANGUAGES    = Object.freeze(normalizeOcrLanguages(providerConfig.ocrLanguages));

const MIN_FILE_SIZE    = num(providerConfig.minFileSize, 50, { min: 0, max: 1099511627776, int: true });
// Upper ceiling on a single file the indexer will read into memory. A file larger than
// this (only reachable by dropping one directly into the documents folder — uploads are
// already capped) is skipped rather than risk an out-of-memory crash of the whole server.
// Defaults to 500 MB, matching the upload limit. Clamped through num() (not a bare ??) so a
// hand-edited string/NaN can't make the size comparison NaN and silently remove the OOM ceiling;
// the floor is 1 KB so the guard always stays meaningful.
const MAX_FILE_SIZE    = num(providerConfig.maxFileBytes, DEFAULT_MAX_FILE_BYTES, { min: 1024, max: 1099511627776, int: true });
const BATCH_SIZE       = 64;
const CONCURRENCY      = 4;

// Tunable — overridable via config.json
const DEBOUNCE_TIME    = num(providerConfig.debounceTime,   3000, { min: 250, max: 600000, int: true });
const maxHistory       = num(providerConfig.maxHistory, def('maxHistory'), NUMERIC_RANGES.maxHistory);
const PASSAGE_SIZE     = num(providerConfig.passageSize, def('passageSize'), NUMERIC_RANGES.passageSize);
const MIN_COSINE_SCORE = num(providerConfig.minCosineScore, 0.35, { min: 0, max: 1 });
// Cosine at/above which a SHORT answer that the English refusal regex did not catch is judged a refusal by
// meaning (so a model refusing in another language is still offered a web fallback and not cached). Compared
// against canonical refusal prototypes with the default multilingual embedding model (bge-m3), where refusals
// measured ~0.80-0.92 and real answers ~0.24-0.49; 0.72 sits conservatively in that gap. Fail-open and only
// ever ADDS a missed refusal verdict, so a stricter value simply does less. Config-only knob, one source here.
const REFUSAL_SIM_THRESHOLD = num(providerConfig.refusalSimThreshold, 0.72, { min: 0, max: 1 });
// The off-topic ABSTENTION cutoff on the cross-encoder (reranker) score — the model-agnostic companion
// to MIN_COSINE_SCORE. A cosine floor depends on the embedding model's score distribution (nomic, bge-m3
// and every other model sit at different scales), so no single cosine value fits whatever model a user
// picks. The cross-encoder is a SEPARATE model that scores each (query, passage) pair directly, with a
// fixed scale (ms-marco: roughly -11 irrelevant to +9 strongly relevant) that does NOT move when the
// embedding model changes — so one absolute cutoff generalizes across any embedding model. When the
// reranker is on and EVERY served passage scores below this, the corpus has no genuinely relevant source
// and the answer abstains instead of citing noise. The default (-8) sits safely below even a weak-but-
// relevant passage (which scores about -1 to -5), so it drops only passages the model actively judged
// off-topic. Fail-open: when the reranker is off or did not score, this gate is skipped entirely (so
// behavior is exactly as before). Raise it to be stricter, lower it to keep more.
const RERANKER_DROP_BELOW = num(providerConfig.rerankerDropBelow, def('rerankerDropBelow'), NUMERIC_RANGES.rerankerDropBelow);
const TEMPERATURE      = num(providerConfig.temperature, def('temperature'), NUMERIC_RANGES.temperature);
// 0 = AUTO: the answer length cap is sized to the model at request time (llm.js), so a long answer (e.g. a
// full-document summary) is never silently truncated out of the box and switching models needs no retuning. An
// operator can still pin a specific cap. Defaulting to auto; an existing config that pinned a number keeps it.
const MAX_TOKENS       = num(providerConfig.maxTokens, def('maxTokens'), NUMERIC_RANGES.maxTokens);
// The default persona ships as a data file (lib/ai/data/persona.txt); a config override
// still wins. Kept out of the code so the prompt wording lives in one editable place.
const ASSISTANT_ROLE   = providerConfig.assistantRole
  || require('./promptdata').read('persona.txt')
  || 'You are a research assistant whose sole purpose is to answer questions about the documents in your knowledge base.';

// Cross-encoder reranker — enabled by default. The model (~23MB quantized) downloads
// from HuggingFace on first use and caches under the data directory (data/models). If the download
// fails (offline, blocked network) retrieval falls back silently to FAISS order.
// The model MUST be a Transformers.js-compatible repo with ONNX weights — the
// Xenova/ namespace mirrors the cross-encoder models with the ONNX files that
// Transformers.js requires (the bare cross-encoder/ repos ship PyTorch only).
// Set "useReranker": false in config.json to disable.
const USE_RERANKER    = flag('useReranker', providerConfig.useReranker);
const RERANKER_MODEL  = providerConfig.rerankerModel || 'Xenova/ms-marco-MiniLM-L-6-v2';   // || so an empty value also falls to the default — this is the single source, consumers don't re-specify it

// Late-interaction (ColBERT-style) reranking — an opt-in second-stage refinement that re-sorts the
// cross-encoder's candidate passages by token-level MaxSim for sharper passage-anchor selection. Off
// by default (it adds a heavier per-token model pass); the token-embedding model is a config.json-only
// advanced knob. Both are read live where they matter (the on/off via available(), the model at boot).
const USE_COLBERT_RERANK = flag('useColbertRerank', providerConfig.useColbertRerank);
const COLBERT_MODEL      = providerConfig.colbertModel     || 'Xenova/all-MiniLM-L6-v2';   // || so an empty value also falls to the default (single source; consumers don't re-specify it)

// Entity-graph traversal depth for relationship ("how are X and Y connected?") recall. 1 (default)
// finds documents whose entities directly bridge the query's named entities — the original behavior.
// 2 also follows a two-step path (seed → intermediate → intermediate → seed), so a longer chain of
// connections surfaces the linking documents a one-hop search misses. Clamped to 1-3; higher hops
// trade a little recall noise for reach, so the conservative default is 1. A config.json-only knob.
const GRAPH_HOPS = Math.max(1, Math.min(3, parseInt(providerConfig.graphHops, 10) || 1));

// Knowledge graph (LLM-extracted). When on, the model reads each document once and extracts its
// entities and typed relationships into a per-workspace graph that relationship/multi-hop questions
// traverse — richer than the free co-occurrence graph, at the cost of one model call per document at
// build time (cached by content hash, so unchanged documents are never re-read; enabling it on an
// existing corpus is a background pass that re-embeds nothing). Off by default. The extraction model
// is a config.json-only knob; empty uses the main chat model.
const useGraphRag   = flag('useGraphRag', providerConfig.useGraphRag);
const GRAPH_RAG_MODEL = providerConfig.graphRagModel || '';

// Contextual Retrieval — at index time, prepend an LLM-written "where this chunk sits
// in the document" blurb to each chunk before embedding, sharpening the vectors. Opt-in
// because it adds one (cached) LLM call per chunk at index time. Applies to documents
// indexed while it's on, so rebuild the index (Settings → Rebuild index) to apply it to
// an existing corpus.
const useContextualRetrieval = flag('useContextualRetrieval', providerConfig.useContextualRetrieval);

// Embedding banks — keep a separate vector index ("bank") per embedding model instead of
// one index bound to a single model. Changing the embedding model then adds a fresh
// active bank and leaves the old one in place (frozen but still searched), so an
// embedding-model switch no longer forces a full, blocking re-embed of the whole corpus:
// existing documents stay searchable via their old bank while new/changed ones are
// embedded into the new one, and queries search every bank and fuse the results.
// On by default so switching the embedding model (or AI provider) never forces a blocking
// re-embed: a corpus that has only ever used one model keeps a single bank and the query
// path is the same single-index scan with no overhead, and an existing single index migrates
// into a bank in place on first boot (nothing is re-embedded). Set to false to force the
// older single-index behavior, where an embedding-model change wipes and rebuilds the corpus.
const useEmbeddingBanks = flag('useEmbeddingBanks', providerConfig.useEmbeddingBanks);

// Faithfulness scoring — a post-answer LLM pass that grades whether each claim in an
// answer is supported by its cited passages (opt-in per message via the "Verify" toggle).
// faithfulnessModel is an optional dedicated judge model: fact-checking wants a CAPABLE
// model (a 7B–8B chat model judges reliably; a small ~3B model gives shaky verdicts), so
// set this to your most capable local model even if the main answer model is smaller.
// Empty → use the main chat model.
const faithfulnessMaxTokens = providerConfig.faithfulnessMaxTokens ?? 200;
const faithfulnessModel      = providerConfig.faithfulnessModel      ?? '';

// Follow-up context — conversational RAG improvements.
// useQueryRewrite: ask the LLM to rewrite follow-up questions into self-contained
//   retrieval queries (resolves "it"/"that"/"the second one" references).
// useConversationSummary: keep a rolling compressed summary of older turns so the
//   model can resolve references to discussion outside the verbatim history window.
const useQueryRewrite          = flag('useQueryRewrite', providerConfig.useQueryRewrite);
const rewriteMaxTokens         = num(providerConfig.rewriteMaxTokens, def('rewriteMaxTokens'), NUMERIC_RANGES.rewriteMaxTokens);
const rewriteModel             = providerConfig.rewriteModel             ?? '';
const useConversationSummary   = flag('useConversationSummary', providerConfig.useConversationSummary);
const summaryMaxTokens         = num(providerConfig.summaryMaxTokens, def('summaryMaxTokens'), NUMERIC_RANGES.summaryMaxTokens);
const historySummaryThresholdChars = num(providerConfig.historySummaryThresholdChars, def('historySummaryThresholdChars'), NUMERIC_RANGES.historySummaryThresholdChars);
const historyProtectLastN     = num(providerConfig.historyProtectLastN, maxHistory * 2, NUMERIC_RANGES.historyProtectLastN);

// Unified intent classification. When enabled, a single LLM pass reads the
// conversation and returns { intent, targetDocs, resolvedQuery } — consolidating
// topic-shift detection, comparison detection, continuation detection, and query
// rewrite into one decision. Falls back to the heuristic pipeline on any failure,
// so the previous behavior is always available. Gated so it can be A/B tested
// against a specific local model before being relied on.
const useIntentClassifier      = flag('useIntentClassifier', providerConfig.useIntentClassifier);
const intentMaxTokens          = num(providerConfig.intentMaxTokens, def('intentMaxTokens'), NUMERIC_RANGES.intentMaxTokens);
// How many documents whole-workspace synthesis will summarize before the reduce step.
// Each document is one sequential LLM summary call, so this bounds how long synthesis
// takes and how long the local model is occupied. Raise it (at the cost of a longer
// wait) if you want broader coverage of a large workspace. When a workspace has more
// documents than this, synthesis samples ACROSS the collection rather than taking the
// first N, and says so.
// num() (not a bare ??) so a hand-edited non-numeric value can't become NaN and make synthesis silently
// return "empty" (cap = Math.max(1, NaN) = NaN, so the doc loop never runs).
const synthesisMaxDocs         = num(providerConfig.synthesisMaxDocs, 60, { min: 1, max: 100000, int: true });
// Extraction Tables: the ceiling on how many documents one extraction run processes, and how much of each
// document's text the per-document extraction reads. Both via num() so a hand-edited non-numeric value
// can't become NaN (which would make the doc loop never run) — the same guard synthesisMaxDocs uses. The
// per-doc char cap keeps a huge document's extraction prompt inside the context window and bounds memory.
const extractionMaxDocs        = num(providerConfig.extractionMaxDocs, def('extractionMaxDocs'), NUMERIC_RANGES.extractionMaxDocs);
const extractionMaxCharsPerDoc = num(providerConfig.extractionMaxCharsPerDoc, def('extractionMaxCharsPerDoc'), NUMERIC_RANGES.extractionMaxCharsPerDoc);
const intentModel              = providerConfig.intentModel              ?? '';
// Natural-chat features (all default on; independently toggleable):
//  - meta-conversational turns ("what did I just ask?") answered from history
//  - a spoken acknowledgment when the topic switches ("Switching to X —")
//  - one clarifying question when a reference is genuinely ambiguous
//  - a soft "partial match" tier instead of a hard out-of-scope refusal
const useMetaConversation      = flag('useMetaConversation', providerConfig.useMetaConversation);
const useTopicSwitchAck        = flag('useTopicSwitchAck', providerConfig.useTopicSwitchAck);
const useClarifyingQuestions   = flag('useClarifyingQuestions', providerConfig.useClarifyingQuestions);
const usePartialMatchTier      = flag('usePartialMatchTier', providerConfig.usePartialMatchTier);
// Semantic answer cache. When on, a fresh, standard question asked again against an
// unchanged corpus returns its previous answer instantly, skipping retrieval and generation.
// Guarded so a hit is only ever a genuine repeat (same corpus fingerprint + answer-affecting
// settings + exact question); any index change retires the cached answers. Off by default —
// a repeat is cheap correctness-wise, but the guarantee is stronger when nothing is reused.
const useSemanticCache         = flag('useSemanticCache', providerConfig.useSemanticCache);
// Suggested follow-up questions. After a grounded answer, a short auxiliary LLM pass
// proposes a few natural next questions, shown as one-click chips under the answer. Master
// switch — on by default, but the chips only appear when the user also arms the composer's
// suggestions toggle for the session, so the extra (small, fire-and-forget) call never runs
// unless they want it. Set false to disable the feature entirely. The generation never
// blocks or delays the answer: it runs after the answer has finished streaming.
const useSuggestedQuestions    = flag('useSuggestedQuestions', providerConfig.useSuggestedQuestions);
const suggestedQuestionsMaxTokens = providerConfig.suggestedQuestionsMaxTokens ?? 120;
const suggestedQuestionsModel  = providerConfig.suggestedQuestionsModel  ?? '';
// Answer confidence (see lib/confidence.js). The chip is on by default and free on its own. Abstention and
// self-consistency are off by default (they change the answer or add generations); samples applies only when
// self-consistency is on.
const showAnswerConfidence     = flag('showAnswerConfidence', providerConfig.showAnswerConfidence);
const abstainOnWeakEvidence    = flag('abstainOnWeakEvidence', providerConfig.abstainOnWeakEvidence);
const useSemanticEntropy       = flag('useSemanticEntropy', providerConfig.useSemanticEntropy);
const semanticEntropySamples   = num(providerConfig.semanticEntropySamples, def('semanticEntropySamples'), NUMERIC_RANGES.semanticEntropySamples);
// Parse large documents in an isolated, memory-capped child process, so a huge or malformed
// file (a PDF/DOCX/XLSX/EPUB/JSON) can never grow the server's memory into an out-of-memory
// crash — the child is bounded and, if it can't cope, the file is indexed by name instead.
// Only files at or above parseIsolationMinBytes take this path; smaller files parse inline
// (no child-process overhead). On by default. Set useParseIsolation false to always parse
// inline (for a constrained environment where forking a helper isn't possible) — but that
// removes the memory/time safety net, so a huge or malformed file can then stall or OOM the
// main process; only disable it for trusted documents.
const useParseIsolation        = providerConfig.useParseIsolation        ?? true;
const parseIsolationMinBytes   = Number.isFinite(providerConfig.parseIsolationMinBytes)
  ? providerConfig.parseIsolationMinBytes : 4 * 1024 * 1024;
// RAG-Fusion (multi-query retrieval). When on, a fresh query is expanded into a few
// alternative phrasings by a small auxiliary LLM call; each phrasing runs its own dense
// search and the candidate lists are fused with reciprocal rank fusion. This widens recall
// — a passage the user's exact wording missed but a paraphrase finds is surfaced for the
// reranker to consider — at the cost of one extra LLM call and a few extra vector searches
// per query. Opt-in while it settles; when off, retrieval is unchanged. It never runs on a
// retry, in focus mode, or on an attachment query (those are not corpus-recall problems).
const useRagFusion             = flag('useRagFusion', providerConfig.useRagFusion);
// How many ADDITIONAL query phrasings to generate (the original query is always included).
const ragFusionQueries         = Math.max(1, Math.min(6, parseInt(providerConfig.ragFusionQueries, 10) || 3));
const ragFusionModel           = providerConfig.ragFusionModel           ?? '';
// Adaptive retrieval routing. When on, the expensive multi-query augmentation (RAG-Fusion)
// runs only for questions a cheap, deterministic complexity check rates as involved
// (comparative, multi-part, multi-entity, or long) — so a simple factual lookup takes the
// fast single-query path while a broad question gets the wider recall. Only has an effect
// when an augmentation it gates is enabled; off by default so enabling RAG-Fusion alone runs
// it on every fresh query (predictable), and this layers cost-saving routing on top.
const useAdaptiveRetrieval     = flag('useAdaptiveRetrieval', providerConfig.useAdaptiveRetrieval);
// HyDE (Hypothetical Document Embeddings). When on, a small auxiliary LLM call drafts a
// short hypothetical passage that WOULD answer the question, and that passage is embedded
// and used as an extra dense query — its wording sits in "answer space", closer to how the
// real documents phrase things, so it surfaces passages a bare question vector can miss
// (helpful when the user asks in lay terms about technical material). The extra candidate
// list is fused with the others by reciprocal rank fusion; the drafted passage is NEVER
// shown or used as an answer, only as a retrieval probe, so it cannot introduce fabrication.
// Opt-in, best-effort, and — like RAG-Fusion — skipped on retries, focus mode, and
// attachment answers, and gated by adaptive routing when that is on.
const useHyde                  = flag('useHyde', providerConfig.useHyde);
const hydeModel                = providerConfig.hydeModel                ?? '';
const hydeMaxTokens            = providerConfig.hydeMaxTokens            ?? 200;
// Entity graph (multi-hop "how are X and Y related" retrieval). When on, a co-occurrence graph
// of the entities in the corpus is built lazily from the loaded documents (a pure-JS extractor
// — no model call, no dependency, no on-disk store). For a question that names two or more
// known entities, the entities that BRIDGE them become an extra dense query, so a document
// connecting them through a third entity — which a literal search would miss — is pulled into
// the candidate set and fused like any other recall source. Recall only: the model still
// answers from real passages. Opt-in, best-effort, and — like RAG-Fusion/HyDE — skipped on
// retries, focus mode, and attachment answers, and gated by adaptive routing when that is on.
const useEntityGraph           = flag('useEntityGraph', providerConfig.useEntityGraph);
// Document summaries (the first level of a collapsed-tree hierarchical index). At index time
// a short summary of each document is written by the model and appended to the document's
// indexed text as a clearly-labeled block, so a broad "what is this about / what are the
// themes" question retrieves the summary and the model reads a coherent synthesis rather than
// a stray fragment. The summary is grounded in the document's own text and cites that
// document. Off by default; it adds one (cached) model call per document at index time, so
// enabling it and rebuilding the index applies it — like contextual retrieval and visual
// ingest. Reuses the existing summarizer; no new dependency.
const useDocumentSummaries     = flag('useDocumentSummaries', providerConfig.useDocumentSummaries);
const documentSummaryModel     = providerConfig.documentSummaryModel     ?? '';
// Auto workspace synthesis (collapsed-tree hierarchical index, stage 2). When on, a broad
// whole-corpus question ("what are the common themes across all my documents?", "overview of
// this workspace") is answered by the existing map-reduce workspace synthesis — which reads
// across the collection — instead of top-k passage retrieval, which only sees a few
// documents. Only unambiguous whole-corpus phrasing routes this way (see retrieval/overview);
// everything else stays on the normal retrieval path. Off by default because synthesis can be
// slow on a large workspace, so it is an opt-in convenience over the manual Generate action.
const useAutoSynthesis         = flag('useAutoSynthesis', providerConfig.useAutoSynthesis);
// Corrective retrieval (CRAG-style recover-gate). When a query matches the corpus only
// weakly — something came back, but not a confident match — reformulate the query once and
// retrieve again, merging the results, so the reranker gets a second, differently-phrased
// shot at the right passage before answering from a mediocre one. Costs one extra LLM
// rephrase + retrieval on weak matches only; opt-in while it settles. Off = unchanged.
const useCorrectiveRetrieval   = flag('useCorrectiveRetrieval', providerConfig.useCorrectiveRetrieval);
// When a question is in a different language than its strongest document match, keyword signals (BM25) are noise
// — the two share no words — so trust the multilingual embedding (dense-only ranking, keyword gates relaxed).
// The embedding model aligns meaning across languages, so the right document is still the top dense hit. No model
// call; detected language-agnostically. Default on; turn off to require keyword overlap in every language.
const useCrossLingual          = flag('useCrossLingual', providerConfig.useCrossLingual);
// Cosine below which a top match counts as "weak" and triggers a corrective pass (only
// when useCorrectiveRetrieval is on). Above this, retrieval is confident and left alone.
const correctiveCosineMax      = providerConfig.correctiveCosineMax      ?? 0.6;

// Live web search (opt-in per query). When the user enables the web toggle for a
// message, Lokyni searches the web (DuckDuckGo, no API key), fetches the top
// results, extracts readable text, and answers from those pages through the same
// grounding + citation flow used for local documents — with sources pointing to
// the live URLs. This is OFF unless the user explicitly turns it on for a message,
// so the default fully-local privacy posture is never changed silently.
// `useWebSearch` is a master switch: when false, the feature is disabled entirely
// and the UI toggle has no effect.
// Read answers aloud with a fully-local text-to-speech voice (Kokoro, via the already-bundled transformers +
// onnxruntime). OFF by default: the voice model is a ~90 MB one-time download, so it is opt-in rather than a
// surprise on first use. When on, a Read-aloud button appears under each answer; nothing is sent to any cloud
// service. `ttsVoice` is the default voice (see lib/voice/tts.js VOICES).
const ttsEnabled               = flag('ttsEnabled', providerConfig.ttsEnabled);
const ttsVoice                 = (typeof providerConfig.ttsVoice === 'string' && providerConfig.ttsVoice) || def('ttsVoice');
// Read-aloud language: 'auto' (match each answer) or a supported code. A forced non-English language is served by
// the operating system's voices, so the bundled English model need not be downloaded (see server.js warm-up).
const ttsLanguage              = isValidReadAloudLanguage(providerConfig.ttsLanguage)
  ? String(providerConfig.ttsLanguage).toLowerCase() : def('ttsLanguage');
// Some system voices are network-backed. They are used only when this opt-in is on; local voices and the bundled
// model stay offline regardless.
const ttsAllowOnlineVoices     = flag('ttsAllowOnlineVoices', providerConfig.ttsAllowOnlineVoices);
// Per-language system-voice choices. The browser owns the voice list; this stores only the bounded preference
// shape (lib/voice/system-voices.js), so a malformed config degrades to automatic selection.
const ttsSystemVoices          = normalizeSystemVoices(providerConfig.ttsSystemVoices);
// Playback speed for read-aloud / voice answers / podcasts — the local voice model supports it natively (0.5×–2×,
// 1× normal). Pitch is NOT a knob the local model exposes, so it is deliberately not offered.
const ttsSpeed                 = num(providerConfig.ttsSpeed, def('ttsSpeed'), NUMERIC_RANGES.ttsSpeed);
// Audio Overview (a two-host podcast generated from a workspace) uses the same local TTS engine with two voices,
// one per host. These pick the two host voices (see lib/voice/tts.js VOICES); the defaults are a contrasting
// female/male US pair. Power settings — set them in config.json if you want different hosts.
const podcastVoiceA            = (typeof providerConfig.podcastVoiceA === 'string' && providerConfig.podcastVoiceA) || def('podcastVoiceA');
const podcastVoiceB            = (typeof providerConfig.podcastVoiceB === 'string' && providerConfig.podcastVoiceB) || def('podcastVoiceB');
// Ask a question by voice: the microphone is captured and resampled in the browser, then transcribed fully
// locally by a Whisper model (via the already-bundled transformers + onnxruntime). OFF by default: the model is
// a ~75 MB one-time download, so it is opt-in. When on, a microphone button appears in the composer; the
// transcript fills the box (editable) and is sent through the normal answer path — nothing is sent to any cloud
// service. `sttLanguage` is the spoken-language code (see lib/voice/stt.js LANGUAGES).
const sttEnabled               = flag('sttEnabled', providerConfig.sttEnabled);
const sttLanguage              = (typeof providerConfig.sttLanguage === 'string' && providerConfig.sttLanguage) || def('sttLanguage');
// Preferred microphone for voice input, chosen in Settings. A device id is per-browser (origins get different
// ids for the same physical mic), so the device's LABEL is stored too; when the id doesn't resolve on another
// surface — the desktop app versus a web browser — the label is matched instead, so the same default applies in
// both. Empty = the browser's own default microphone. The actual capture lives in the browser; these are just
// the remembered preference.
const micDeviceId              = (typeof providerConfig.micDeviceId === 'string' && providerConfig.micDeviceId.slice(0, 256)) || '';
const micLabel                 = (typeof providerConfig.micLabel === 'string' && providerConfig.micLabel.slice(0, 256)) || '';
// Audio/video file ingestion: transcribe an uploaded or indexed media file (a lecture, meeting, podcast, or
// video) with the same local speech-to-text engine, so what is SPOKEN becomes a searchable, cited document.
// OFF by default (it reuses the ~75 MB STT model, a one-time download, and compressed/video formats need the
// bundled ffmpeg — fetched once into the data directory, never a system binary). `.wav` is decoded natively, so
// it works even before ffmpeg is fetched. `audioMaxMinutes` caps how much of a long recording is transcribed
// (OOM/time safety).
const useAudioIngest           = flag('useAudioIngest', providerConfig.useAudioIngest);
const audioMaxMinutes          = num(providerConfig.audioMaxMinutes, def('audioMaxMinutes'), NUMERIC_RANGES.audioMaxMinutes);
const useWebSearch             = flag('useWebSearch', providerConfig.useWebSearch);
// How a pasted web page is captured. 'auto' tries a bounded plain HTTP fetch and escalates to the headless
// browser only when the result is thin, walled, or an error shell; 'http' never launches a browser; 'headless'
// always renders. Read live by lib/urlfetch.js, so a Settings change applies to the next capture.
const URL_CAPTURE_VALUES = require('./settings-schema').SETTINGS.urlCapture.values;
const URL_CAPTURE = URL_CAPTURE_VALUES.includes(String(providerConfig.urlCapture || '').toLowerCase())
  ? String(providerConfig.urlCapture).toLowerCase()
  : 'auto';
// When true, on a genuine corpus miss for a web-answerable question, Lokyni OFFERS
// to search the web (ask-first). The user's local-only default is preserved — the
// web is never hit until they accept. Set false to disable auto-suggestion entirely
// (the explicit 🌐 toggle still works).
const webAutoSuggest           = flag('webAutoSuggest', providerConfig.webAutoSuggest);
// The web auto-suggest only offers when the best cross-encoder (reranker) score for
// the failed query is at or below this threshold — i.e. no retrieved document was a
// genuine match. ms-marco reranker scores are roughly -11 (irrelevant) to +9
// (strongly relevant); 0 is a reasonable "no real match" cutoff. Raise it to offer
// web more readily, lower it to be stricter. Only applies when the reranker is on;
// if the reranker is disabled the gate is skipped (offer proceeds on the heuristic).
const webOfferMaxRerankerScore = providerConfig.webOfferMaxRerankerScore ?? 0;
// Clamped via num()/NUMERIC_RANGES like every peer knob (not a raw `?? default`), so a hand-edited config.json
// can't set an out-of-range or non-integer value that would, for example, make deep-research fan out thousands
// of concurrent page fetches per sub-question.
const webSearchResultCount     = num(providerConfig.webSearchResultCount, def('webSearchResultCount'), NUMERIC_RANGES.webSearchResultCount);     // results to request
const webSearchFetchCount      = num(providerConfig.webSearchFetchCount, def('webSearchFetchCount'), NUMERIC_RANGES.webSearchFetchCount);      // top results to fetch full text for
const webSearchMaxCharsPerPage = num(providerConfig.webSearchMaxCharsPerPage, def('webSearchMaxCharsPerPage'), NUMERIC_RANGES.webSearchMaxCharsPerPage); // readable-text cap per page
const webSearchTimeoutMs       = num(providerConfig.webSearchTimeoutMs, def('webSearchTimeoutMs'), NUMERIC_RANGES.webSearchTimeoutMs);
// Optional outbound (egress) proxy for all web access — search, page fetches, and URL ingestion. Empty =
// direct (the default). A bare "host:port" is treated as http://host:port. Falls back to the standard
// HTTPS_PROXY/HTTP_PROXY/ALL_PROXY environment variables when unset (resolved in lib/webproxy.js). Used to
// work behind a mandated corporate proxy, or to avoid tying every request to one IP.
const WEB_PROXY_URL            = String(providerConfig.webProxyUrl || '').trim();
// Opt-in rotation. When OFF (the default), a configured pool uses its first proxy; when ON, Lokyni rotates
// across the pool per request (round-robin). Both the proxy and its rotation are opt-in.
const WEB_PROXY_ROTATE         = flag('webProxyRotate', providerConfig.webProxyRotate);
// Retries through a DIFFERENT proxy when a request is blocked or fails (proxies get rate-limited/blocked).
// Tunable; 0 disables retrying. Only engages when a proxy pool is configured. Default 2.
const WEB_PROXY_RETRIES        = num(providerConfig.webProxyRetries, def('webProxyRetries'), NUMERIC_RANGES.webProxyRetries);
// Strict no-leak mode. Opt-in: when ON, a web request for which a proxy is configured but cannot be
// applied FAILS rather than silently connecting directly and exposing the real IP. Off by default.
const WEB_PROXY_STRICT         = flag('webProxyStrict', providerConfig.webProxyStrict);
// Reorder raw web-search results by a "source prior" — domain authority, how well the
// title/snippet match the query, and recency — before Lokyni fetches the top pages, so
// the pages it actually reads and grounds on are the most trustworthy and on-topic ones
// rather than whatever order the search engine returned. Set false to keep engine order.
const useWebResultRanking      = flag('useWebResultRanking', providerConfig.useWebResultRanking);

// Model context window (tokens). Retrieved passages can be large (e.g. a 32K-char window from a 920K
// document ≈ 8K tokens); too small a window truncates the SYSTEM prompt first, dropping the grounding rules
// and producing degenerate one-word answers. The default is 0 = AUTOMATIC: the effective window is resolved
// per model from the model's real trained window (capped for memory safety), so it is never silently too
// small, and a bigger model's larger window is used without hand-tuning (see lib/modelcontext.js and the
// resolver in lib/llm.js). A positive value here is an explicit override and is used verbatim.
const numCtx = num(providerConfig.numCtx, def('numCtx'), NUMERIC_RANGES.numCtx);

// Reciprocal Rank Fusion weights. FAISS (semantic) and BM25 (keyword) result lists
// are fused with these weights; the defaults (0.3 / 0.7, K=60) favor keyword
// precision, which suits identifier-heavy corpora. Raise rrfFaissWeight toward BM25's
// for a prose corpus where questions are paraphrased and exact-term overlap is rare.
// Single source for the default values: used here as the config defaults AND exported so rrf.js's
// defense-in-depth fallbacks reference the same numbers (they can't drift).
const RRF_DEFAULTS = { faissWeight: 0.3, bm25Weight: 0.7, k: 60 };
const rrfFaissWeight = num(providerConfig.rrfFaissWeight, RRF_DEFAULTS.faissWeight, { min: 0, max: 1 });
const rrfBm25Weight  = num(providerConfig.rrfBm25Weight, RRF_DEFAULTS.bm25Weight, { min: 0, max: 1 });
const rrfK           = num(providerConfig.rrfK,           RRF_DEFAULTS.k, { min: 1, max: 100000, int: true });

// Optional SMTP block for emailing scheduled-automation digests. When absent, digests
// are still delivered to the in-app inbox — email is purely additive and opt-in.
// { host, port, secure, user, pass, from }
const smtp = providerConfig.smtp || null;

// Tamper-evident security audit trail (data/audit.jsonl): records key lifecycle, config
// changes, index rebuilds, failed authentications, and external ingests as a hash chain the
// boot-time watchdog verifies. On by default; set false to disable entirely (useful for a
// purely local single-user install that wants nothing written). Never touches the answer path.
const auditLog = flag('auditLog', providerConfig.auditLog);

// Multi-user: allow self-service signup. Off by default — an admin creates accounts. When on, anyone who can
// reach the login page can create their own account (and the first-ever account always becomes the admin
// regardless of this flag). Future-proofs the public-signup path without a code change.
const allowSignups = flag('allowSignups', providerConfig.allowSignups);

// Optional single sign-on (OpenID Connect). Off by default; local accounts are unchanged. Configured as an
// `oidc` object in config.json (issuer + client registered with your identity provider). Secrets stay in
// config.json, never surfaced to the browser. See the "Single Sign-On" section of the README.
const oidc = (() => {
  const o = (providerConfig.oidc && typeof providerConfig.oidc === 'object') ? providerConfig.oidc : {};
  const str = (v, d = '') => (typeof v === 'string' ? v : d);
  return {
    enabled:        o.enabled === true,
    issuer:         str(o.issuer).replace(/\/+$/, ''),
    clientId:       str(o.clientId),
    clientSecret:   str(o.clientSecret),
    scopes:         str(o.scopes).trim() || 'openid profile email',
    buttonLabel:    (str(o.buttonLabel).trim() || 'Sign in with SSO').slice(0, 40),
    redirectUri:    str(o.redirectUri),                      // optional; derived from the request when empty
    autoCreateUsers: o.autoCreateUsers !== false,            // default true: provision a user on first SSO login
    // Link an SSO identity to an EXISTING local account by its verified email (default true, for the common
    // single trusted-IdP case). Set false for a multi-tenant or less-trusted IdP, where a verified-email claim
    // an attacker can influence must not be able to bridge into a pre-existing (possibly privileged) account.
    linkByEmail:    o.linkByEmail !== false,
    defaultRole:    o.defaultRole === 'admin' ? 'admin' : 'member',
    usernameClaim:  str(o.usernameClaim) || 'preferred_username',
    emailClaim:     str(o.emailClaim) || 'email',
  };
})();
// SSO is only actually usable when enabled AND the essential fields are present.
const ssoEnabled = () => oidc.enabled && !!oidc.issuer && !!oidc.clientId;

// Optional horizontal scale-out: run several app instances over ONE shared data directory. Off by default
// (a normal single node). When on, exactly one instance is the PRIMARY (does all indexing/writes) and the
// rest are read REPLICAS (serve search/chat/read from the shared index, refusing writes). See the "Scaling"
// section of the README. Roles are static (set per instance) so there is no split-brain. CLI flags
// (--cluster/--primary/--replica) override this block for a given process.
const cluster = (() => {
  const c = (providerConfig.cluster && typeof providerConfig.cluster === 'object') ? providerConfig.cluster : {};
  return { enabled: c.enabled === true, role: c.role === 'replica' ? 'replica' : 'primary' };
})();

// Persistent, dated diagnostic logging to ~/.lokyni/logs/YYYY-MM-DD.log (pruned after 30 days).
// On by default so there is always a bounded on-disk trail, even in a foreground terminal run.
// Set false to keep logs in memory (and the terminal) only — nothing is written to disk.
const fileLogging = providerConfig.fileLogging !== false;

// App identity — change here to rename everywhere
// APP_NAME comes from lib/constants.js and is re-exported here so existing
// consumers (server.js, llm.js) keep importing it from config unchanged.

module.exports = {
  APP_NAME, CONFIG_PATH, expandHome,
  AI_PROVIDER, OLLAMA_HOST, OLLAMA_KEY, OLLAMA_KEEP_ALIVE, LLM_TIMEOUT_MS, EMBED_TIMEOUT_MS, OPENAI_KEY, OPENAI_BASE, LLM_MODEL,
  ANTHROPIC_KEY, ANTHROPIC_BASE, EMBEDDINGS_PROVIDER, PROVIDERS_WITH_EMBEDDINGS, EMBEDDINGS_API_KEY, EMBEDDINGS_BASE_URL, embedBaseUrl,
  DEBUG, PORT, BIND_ADDRESS, ALLOW_NETWORK_ACCESS, TRUSTED_HOSTS, ENFORCE_HOST_GUARD, DATA_DIR, BUNDLED_TESSDATA_DIR, EMBEDDINGS_MODEL,
  SOURCE_MAX_FILE_BYTES, SOURCE_MAX_FILES, SOURCE_EXCLUDE, BROWSE_FS_ROOT,
  MIN_FILE_SIZE, MAX_FILE_SIZE, BATCH_SIZE, CONCURRENCY,
  USE_OCR, OCR_ENGINE, OCR_VISION_MODEL, OCR_MAX_PAGES, OCR_WORKERS, OCR_LANGUAGES, EMBEDDING_CONTEXT_TOKENS,
  VISION_DESCRIBE, VISION_MODEL, VISION_INPUT_MAX_EDGE, VISION_TEMPERATURE, VISION_MAX_TAGS,
  useVisualIngest, visualIngestMaxPages, visualIngestMaxBytes, visualIngestMaxImages, visualIngestMinImageEdge, visualIngestCropFigures,
  DEBOUNCE_TIME, maxHistory, PASSAGE_SIZE, MIN_COSINE_SCORE, REFUSAL_SIM_THRESHOLD, RERANKER_DROP_BELOW,
  TEMPERATURE, MAX_TOKENS, ASSISTANT_ROLE,
  USE_RERANKER, RERANKER_MODEL, USE_COLBERT_RERANK, COLBERT_MODEL, GRAPH_HOPS, useGraphRag, GRAPH_RAG_MODEL, useContextualRetrieval, useEmbeddingBanks,
  faithfulnessMaxTokens, faithfulnessModel,
  useQueryRewrite, rewriteMaxTokens, rewriteModel,
  useConversationSummary, summaryMaxTokens, historySummaryThresholdChars, historyProtectLastN,
  useIntentClassifier, intentMaxTokens, intentModel, synthesisMaxDocs, extractionMaxDocs, extractionMaxCharsPerDoc,
  useMetaConversation, useTopicSwitchAck, useClarifyingQuestions, usePartialMatchTier,
  useCorrectiveRetrieval, useCrossLingual, correctiveCosineMax, useSemanticCache,
  useDocumentSummaries, documentSummaryModel, useAutoSynthesis,
  useRagFusion, ragFusionQueries, ragFusionModel, useAdaptiveRetrieval,
  useHyde, hydeModel, hydeMaxTokens, useEntityGraph,
  useSuggestedQuestions, suggestedQuestionsMaxTokens, suggestedQuestionsModel,
  showAnswerConfidence, abstainOnWeakEvidence, useSemanticEntropy, semanticEntropySamples,
  useParseIsolation, parseIsolationMinBytes,
  useWebSearch, urlCapture: URL_CAPTURE, webAutoSuggest, webOfferMaxRerankerScore, webSearchResultCount, webSearchFetchCount, webSearchMaxCharsPerPage, webSearchTimeoutMs, useWebResultRanking, WEB_PROXY_URL, WEB_PROXY_ROTATE, WEB_PROXY_RETRIES, WEB_PROXY_STRICT,
  ttsEnabled, ttsVoice, ttsSpeed,
  ttsLanguage, ttsAllowOnlineVoices, ttsSystemVoices,
  podcastVoiceA, podcastVoiceB,
  sttEnabled, sttLanguage, micDeviceId, micLabel,
  useAudioIngest, audioMaxMinutes,
  numCtx,
  rrfFaissWeight, rrfBm25Weight, rrfK, RRF_DEFAULTS,
  smtp, auditLog, fileLogging, allowSignups, oidc, ssoEnabled, cluster,
  readRawConfig, writeConfigAtomic, migrateSecrets, SECRET_KEY_SRC, CONFIG_SECRET_PATHS, MASKCRED_PATHS,
  NUMERIC_RANGES,
  personaFor,
};

// Workspace-relative paths are exposed as getters so every consumer sees the active
// workspace immediately after a switch. Destructuring these at import time would
// capture a stale value — read them off the config object instead
// (e.g. `require('./config').DOCS_DIR`).
Object.defineProperties(module.exports, {
  DOCS_DIR:         { enumerable: true, get: currentDocsDir },
  SOURCE_PATHS:     { enumerable: true, get: currentSourcePaths },
  CACHE_DIR:        { enumerable: true, get: currentCacheDir },
  MANIFEST_PATH:    { enumerable: true, get: currentManifestPath },
  // configurable so a test can stub the active-workspace persona without a live workspace.
  WORKSPACE_PERSONA:{ enumerable: true, configurable: true, get: currentPersona },
});

