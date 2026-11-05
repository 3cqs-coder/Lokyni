'use strict';
// Guards the first-run "Connect a model" overlay reusing the Settings model picker, so a new user can PICK an
// installed model instead of typing its exact name:
//   • attachModelPicker takes a `registry` argument (default the Settings list), so a separate surface can keep
//     its own pickers refreshed from its OWN provider/host fields — no duplicated picker code;
//   • the first-run overlay attaches pickers to its three model fields into its own registry, and re-lists when
//     the provider changes or the Ollama host is edited (debounced);
//   • a one-click connect still works: the sensible default stays as the field's value (Custom) when it isn't an
//     exact installed tag, and a hosted provider with no key yet just lists nothing and stays a text box.
// Source guards (no DOM). Run: `npm run test:unit`.

const path = require('path'), fs = require('fs'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { MODEL_DEFAULTS } = require(path.join(PROJECT, 'lib', 'settings-schema'));
const chat = fs.readFileSync(path.join(PROJECT, 'lib', 'public', 'js', 'chat.js'), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // The shared picker helper is parametrized by a registry (default the Settings pickers), and registers into it.
  ok(/function attachModelPicker\(input, blankLabel, kind, registry = _modelPickers\)/.test(chat),
    'attachModelPicker takes a registry (so another surface can reuse it without the Settings refresh)');
  ok(/registry\.push\(\{ input, select, blankLabel, kind/.test(chat), 'the picker registers into the given registry');

  // The first-run overlay has its OWN registry and refresh, reading its own provider/host fields.
  ok(/const _frPickers = \[\];/.test(chat), 'the first-run overlay keeps its own picker registry');
  ok(/attachModelPicker\(ollamaModel, '\(choose a model\)', 'chat', _frPickers\)/.test(chat),
    'the first-run Ollama model field becomes a picker');
  ok(/attachModelPicker\(openaiModel, '\(choose a model\)', 'chat', _frPickers\)/.test(chat) &&
     /attachModelPicker\(anthropicModel, '\(choose a model\)', 'chat', _frPickers\)/.test(chat),
    'the first-run OpenAI and Anthropic model fields become pickers too');
  ok(/const refreshFrPickers = async \(\) =>/.test(chat), 'the first-run overlay lists models from its own fields');
  ok(/provider === 'ollama' \? \(ollamaHost\.value \|\| ''\) : ''/.test(chat),
    'the first-run picker lists from the first-run Ollama host, not the Settings host');
  ok(/if \(seq !== _frPickerSeq\) return;/.test(chat), 'a stale model-list response never repaints the picker');

  // Re-list on provider change and on host edit (debounced), matching the Settings pickers.
  ok(/providerSel\.addEventListener\('change', refreshFrPickers\)/.test(chat), 're-lists when the provider changes');
  ok(/ollamaHost\.addEventListener\('input', \(\) => \{ clearTimeout\(_frHostTimer\); _frHostTimer = setTimeout\(refreshFrPickers, 400\); \}\)/.test(chat),
    're-lists (debounced) when the Ollama host is edited');

  // One-click connect is preserved: the sensible per-provider defaults still prefill the fields.
  ok(MODEL_DEFAULTS.ollama === 'llama3.2' && MODEL_DEFAULTS.openai === 'gpt-4o' && MODEL_DEFAULTS.anthropic === 'claude-sonnet-4-5',
    'the shared settings schema defines a sensible default model per provider');
  ok(/const DEFAULT_MODELS = PROVIDER_MODEL_DEFAULTS;/.test(chat),
    'the first-run overlay consumes the shared provider defaults (one-click connect, no second copy)');

  console.log(`\nALL FIRSTRUN-MODEL-PICKER TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ FIRSTRUN-MODEL-PICKER TEST FAILED:', e && e.message);
  process.exit(1);
}
