'use strict';
// Static contract guards for the server-rendered UI. These catch whole classes of browser bug that
// are invisible to the unit suite and easy to reintroduce while editing a template:
//
//   1. A <button> inside a <form> with no explicit type is a submit button. The composer's Tools
//      toggles sat inside the composer form, so choosing an answer option also sent whatever text
//      was already typed. Every form button must now say what it does.
//   2. Duplicate element ids silently break every getElementById/for= that resolves to the first one.
//   3. Every static .modal-overlay must be registered with the shared focus-trap/dialog helper, or
//      keyboard focus can leave the dialog and Escape handling can miss it.
//   4. The Settings Escape path must go through its close routine so interval cleanup still runs.
//
// Pure source parsing. No browser, model, or network. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

const VIEWS = [
  'lib/views/chat.ejs',
  'lib/views/login.ejs',
  'lib/views/account.ejs',
  'lib/views/admin-users.ejs',
  'lib/views/document-viewer.ejs',
];
const TEMPLATE_PARTS = ['lib/views/partials/header.ejs', 'lib/views/partials/doc-panel.ejs'];

try {
  for (const file of VIEWS) {
    const src = read(file);

    // ── 1. Form buttons declare their type ──
    const forms = [...src.matchAll(/<form\b[\s\S]*?<\/form>/g)].map(m => m[0]);
    for (const form of forms) {
      const buttons = [...form.matchAll(/<button\b[^>]*>/g)].map(m => m[0]);
      const untyped = buttons.filter(b => !/\btype\s*=/.test(b));
      ok(untyped.length === 0, `${file}: every button inside a form declares type (found ${untyped.length} untagged)`);
    }

    // ── 2. No duplicate ids ──
    // Only literal HTML ids count: a template-built id (inside a JS string) is not an element id.
    const ids = [...src.matchAll(/\bid="([A-Za-z][\w:.-]*)"/g)].map(m => m[1]);
    const seen = new Set(), dupes = new Set();
    for (const id of ids) { if (seen.has(id)) dupes.add(id); else seen.add(id); }
    ok(dupes.size === 0, `${file}: element ids are unique (duplicates: ${[...dupes].join(', ') || 'none'})`);
  }

  // ── 3. Every static modal overlay is registered with the focus trap ──
  const chatJs = read('lib/public/js/chat.js');
  const registered = (() => {
    const m = chatJs.match(/const OVERLAY_IDS = \[([\s\S]*?)\];/);
    assert.ok(m, 'the shared dialog helper lists its overlays');
    return new Set([...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]));
  })();
  const allMarkup = VIEWS.concat(TEMPLATE_PARTS).map(read).join('\n');
  const staticOverlays = [...allMarkup.matchAll(/<[^>]*class="[^"]*\bmodal-overlay\b[^"]*"[^>]*>/g)]
    .map(tag => tag[0].match(/\bid="([^"]+)"/))
    .filter(Boolean)
    .map(m => m[1]);
  for (const id of staticOverlays) {
    ok(registered.has(id), `modal #${id} is registered with the focus-trap/dialog helper`);
  }

  // ── 4. Settings Escape goes through the cleanup path, not a bare class toggle ──
  const closeMap = chatJs.match(/const CLOSE_BTN = \{([^}]*)\};/);
  ok(!!closeMap, 'the Escape handler has a close-routine map');
  ok(/'settings-overlay'\s*:\s*'settings-cancel'/.test(closeMap ? closeMap[1] : ''),
    'Escape closes Settings through its close routine (stops the graph-build poll)');
  ok(/if \(e\.key === 'Tab'\) \{ close\(false\); return; \}/.test(chatJs) && !/addEventListener\('focusout'/.test(chatJs.slice(chatJs.indexOf('function answerActionMenu'), chatJs.indexOf('function addAnswerMenuItem'))),
    'the answer menu closes on Tab and outside click, not on a WebKit-sensitive focusout');

  // ── 5. Mobile layout guards for the two forms that used to clip ──
  const css = read('lib/public/css/app.css');
  // A fixed pixel width on a settings/connector input is what pushed controls outside the panel.
  const fixedConnectorWidth = /<input id="connector-[^"]+"[^>]*style="[^"]*\bwidth\s*:\s*\d+px/.test(read('lib/views/chat.ejs'));
  ok(!fixedConnectorWidth, 'connector inputs size from CSS, not fixed inline pixel widths');
  ok(/\.settings-row-voices > \.voice-pick \{ flex: 1 1 auto; width: 100%; \}/.test(css),
    'the voice picker stacks full-width on a phone');
  ok(/\.connector-fields \.connector-input \{ flex: 1 1 100%; width: 100%; \}/.test(css),
    'connector inputs shrink to the panel width on a phone');
  ok(/\.connector-fields > label \{ flex: 1 1 auto; \}/.test(css),
    'connector fields allow their label and control to wrap');
  ok(/\.settings-row-action \{ flex-direction: column;/.test(css),
    'a settings row with an action button stacks on a phone (no clipped button)');

  // ── 6. UX regressions fixed after the browser review ──
  const chatEjs = read('lib/views/chat.ejs');
  ok(/#empty-add-doc \{[^}]*pointer-events: auto/.test(css),
    'the empty-state Add document button accepts a real mouse or touch click');
  ok(/#empty-state > div \{[^}]*align-items: center/.test(css),
    'the empty-state icon, label, and action share one centered column');
  ok(/#settings-body \{ flex: 1 1 auto; min-height: 0; overflow-y: auto;/.test(css) &&
    /\.settings-box \{[^}]*overflow: hidden;/.test(css),
    'Settings scrolls its body while the title and action footer stay visible');
  ok(/id="cfg-reranker"/.test(chatEjs) && /useReranker: cfgReranker\.checked/.test(chatJs),
    'the default-on cross-encoder can be toggled and saved from Settings');
  ok(/id="cfg-intent-classifier"/.test(chatEjs) && /useIntentClassifier: cfgIntentClassifier\.checked/.test(chatJs),
    'the default-on model-based follow-up classifier can be toggled and saved from Settings');
  ok(/settingsLoaded = false/.test(chatJs) && /settingsSave\.disabled = true/.test(chatJs),
    'Save is disabled until settings load, so a failed load cannot overwrite the configuration');
  ok(/BASELINE_MODES = new Set\(\['why', 'learn'\]\)/.test(chatJs),
    'default-on Explain and Learn do not inflate the Tools badge or chip strip');
  ok(/permanently deletes the current conversation/.test(chatEjs) && !/will clear the current conversation/.test(chatEjs),
    'the New conversation dialog says the conversation cannot be reopened');
  ok(/uploadFormats/.test(read('lib/views/partials/doc-panel.ejs')),
    'the drop-zone format hint is generated from the shared supported-format list');
  ok(/const DEFAULT_MODELS = PROVIDER_MODEL_DEFAULTS;/.test(chatJs), 'the first-run model defaults come from the server settings schema');
  ok(/<option value="8">/.test(chatEjs), 'the OCR worker control offers the documented maximum of 8');
  ok(require(path.join(ROOT, 'lib', 'config')).NUMERIC_RANGES.ocrWorkers.max === 8,
    'the OCR worker range matches the runtime and documented maximum');

  console.log(`\nALL UI-CONTRACT UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ UI-CONTRACT UNIT TEST FAILED:', e.message);
  process.exit(1);
}
