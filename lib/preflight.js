'use strict';

// Startup pre-flight check.
//
// The most common first-run stumble isn't a bug — it's the environment: Ollama isn't
// running, or the configured model was never pulled. Without a check, the server
// starts cleanly, the user opens the UI, asks a question, and only THEN hits a
// failure, at the worst possible moment. This runs once at startup and prints clear,
// actionable warnings up front so the fix is obvious ("run: ollama pull llama3.2")
// instead of a confusing mid-question error.
//
// It never blocks startup — a warning is informational. Ollama might be started a
// moment later, or the user may be pointing at a remote provider we can't probe. The
// goal is a helpful heads-up, not a gate.

const c = require('./config');

// Ollama reports models tagged (`llama3.2:latest`); config usually names them bare
// (`llama3.2`). Match on the base name so a pulled model isn't reported missing over
// a tag mismatch. This is DELIBERATELY looser than modelname.sameModel (which keeps an
// explicit tag like `:3b`): this is only an advisory "is it pulled?" warning, so matching
// the family avoids a false "missing" warning when a size variant is installed — do not
// swap in the stricter comparison here.
const baseName = (m) => String(m || '').split(':')[0].toLowerCase();

const hasModel = (installed, wanted) => {
  if (!wanted) return true; // nothing configured to check
  const want = baseName(wanted);
  return installed.some((m) => baseName(m) === want);
};

// Run the check. Returns nothing; prints warnings as a side effect. Best-effort and
// fully guarded — a check that itself throws must never stop the server.
const runPreflight = async () => {
  try {
    if (c.AI_PROVIDER === 'openai' || c.AI_PROVIDER === 'anthropic') {
      await preflightOpenAICompatible(c.AI_PROVIDER);
      return;
    }
    if (c.AI_PROVIDER !== 'ollama') return; // unknown provider — nothing to probe

    await preflightOllama();
  } catch {
    // A failed check is never worth blocking or crashing startup over.
  }
};

// OpenAI-compatible providers (OpenAI itself and Anthropic via its compatible endpoint) can't be
// checked the way Ollama can — there's no free local model list, and verifying a key means spending a
// request. So we check the two things that actually trip first-time users, cheaply: (1) a key is set at
// all, and (2) the endpoint is reachable. We deliberately DON'T validate the key's correctness or the
// model catalog beyond what a free models-list probe reveals. One function serves both providers; only
// the label, key, base, and config-key names differ.
const preflightOpenAICompatible = async (provider) => {
  const isAnthropic = provider === 'anthropic';
  const label   = isAnthropic ? 'Anthropic' : 'OpenAI';
  const key     = isAnthropic ? c.ANTHROPIC_KEY : c.OPENAI_KEY;
  const keyName = isAnthropic ? 'anthropicApiKey' : 'openaiApiKey';
  const base    = (isAnthropic ? (c.ANTHROPIC_BASE || 'https://api.anthropic.com/v1/')
                               : (c.OPENAI_BASE || 'https://api.openai.com/v1')).replace(/\/+$/, '');

  // 1. No key at all — the single most common setup mistake.
  if (!key) {
    console.warn(`\n⚠️  Provider is "${provider}" but no API key is set.`);
    console.warn('    Lokyni started, but questions will fail until you add a key.');
    console.warn(`    • Set "${keyName}" in config.json`);
    if (!isAnthropic) console.warn('    • For a non-OpenAI compatible endpoint, also set "openaiBaseUrl"');
    console.warn('');
    return; // no point probing reachability without a key
  }

  // 2. Endpoint reachability — a wrong base URL or no connectivity is the other common failure. Probe
  // the models list (cheap, supported by OpenAI, the Anthropic compat endpoint, and most compatible
  // servers). A 401/403 means "reachable but key rejected" — still useful to report. Any other answer
  // means something is responding at that URL.
  try {
    const r = await require('./fetchtimeout').fetchWithTimeout(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}` },
    }, 2500);
    if (r.status === 401 || r.status === 403) {
      console.warn(`\n⚠️  The ${label} endpoint (${base}) rejected the API key (HTTP ${r.status}).`);
      console.warn('    Lokyni started, but questions will fail until the key is corrected.');
      console.warn(`    • Check "${keyName}" in config.json\n`);
    }
    // Any other status (200, or a 404 on a compatible server that lacks /models)
    // means something is answering — reachable enough. Stay quiet.
  } catch {
    console.warn(`\n⚠️  The ${label} endpoint (${base}) is not reachable.`);
    console.warn('    Lokyni started, but questions will fail until it can be reached.');
    console.warn(`    • Check "${isAnthropic ? 'anthropicBaseUrl' : 'openaiBaseUrl'}" in config.json and your internet connection\n`);
  }
};

const preflightOllama = async () => {
    const { listOllamaModels } = require('./llm');
    const installed = await listOllamaModels({ OLLAMA_HOST: c.OLLAMA_HOST, OLLAMA_KEY: c.OLLAMA_KEY });

    // Unreachable → the single most useful message to show a first-time user.
    if (installed === null) {
      console.warn(`\n⚠️  Ollama not reachable at ${c.OLLAMA_HOST}`);
      console.warn('    Lokyni started, but questions will fail until Ollama is running.');
      console.warn('    • Install it from https://ollama.com if you haven\'t');
      console.warn('    • Start it, then reload the page — no need to restart Lokyni\n');
      return;
    }

    // Reachable — check that the models the current config actually uses are present.
    // Only the models that will really be called: the LLM and embeddings always; the
    // OCR/vision models only when those features are enabled.
    const wanted = [];
    if (c.LLM_MODEL)        wanted.push({ role: 'chat model',       name: c.LLM_MODEL });
    if (c.EMBEDDINGS_MODEL) wanted.push({ role: 'embeddings model', name: c.EMBEDDINGS_MODEL });
    if (c.USE_OCR && c.OCR_ENGINE === 'vision' && c.OCR_VISION_MODEL) {
      wanted.push({ role: 'OCR vision model', name: c.OCR_VISION_MODEL });
    }
    if (c.VISION_DESCRIBE && c.VISION_MODEL) {
      wanted.push({ role: 'image-describe model', name: c.VISION_MODEL });
    }

    const missing = wanted.filter((w) => !hasModel(installed, w.name));
    if (missing.length > 0) {
      console.warn('\n⚠️  Some configured models are not installed in Ollama:');
      for (const m of missing) {
        console.warn(`    • ${m.role}: "${m.name}" — run:  ollama pull ${m.name}`);
      }
      console.warn('    Lokyni started; features using these models will fail until the models are pulled.\n');
    }
};

// baseName/hasModel are exported for unit testing — the tag-vs-bare-name match is the one bit of real logic
// here, and a regression would make a pulled model falsely report as missing (noisy startup warnings).
module.exports = { runPreflight, baseName, hasModel };
