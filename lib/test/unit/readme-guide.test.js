'use strict';
// Guards the in-app Guide (the README viewer + search). The feature renders the shipped README, so
// the README must exist and be shipped, the server must serve it, and the UI must be wired. A
// packaging or wiring regression (the README not bundled, the route renamed, the button removed)
// then fails the build rather than shipping a broken or empty Guide. No model or network. Run:
// `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

try {
  // The README exists and has real content.
  const readme = read('docs/README.md');
  ok(readme.length > 1000, 'docs/README.md exists and is non-empty');

  // It ships: in the npm publish allowlist (which the desktop staging plan also derives from) and
  // copied into the Docker image, so it is present at runtime in every deployment.
  const pkg = JSON.parse(read('package.json'));
  ok(Array.isArray(pkg.files) && pkg.files.includes('docs/README.md'), 'the README is in the publish/staging allowlist');
  ok(/COPY[^\n]*docs\/README\.md/.test(read('docker/Dockerfile')), 'the Dockerfile copies the README into the image');

  // The server serves it at the conventional path.
  ok(/app\.get\('\/readme\.md'/.test(read('lib/server.js')), 'the server serves the README at /readme.md');

  // The UI is wired: a header button, the overlay with its search box, and the client fetch.
  ok(/id="help-btn"/.test(read('lib/views/partials/header.ejs')), 'the header has the Guide button');
  const chatEjs = read('lib/views/chat.ejs');
  ok(/id="help-overlay"/.test(chatEjs) && /id="help-search-input"/.test(chatEjs), 'the Guide overlay and its search box exist');
  ok(/id="help-matches"[^>]*role="group"[^>]*aria-label="Matching sections"/.test(chatEjs),
    'the Guide search results are a labelled group');
  const chatJs = read('lib/public/js/chat.js');
  ok(/fetch\('\/readme\.md'/.test(chatJs), 'the client fetches the README');
  ok(/'help-overlay'/.test(chatJs), 'the Guide overlay is registered for modal accessibility (focus trap / Escape)');
  // Heading anchors are Unicode-aware and unique, so a localized README and repeated headings both
  // keep working TOC links.
  ok(/const helpSlug = \(s\) =>[\s\S]{0,160}?\\p\{L\}/.test(chatJs), 'the Guide slug keeps letters in every script');
  ok(/seenHeadingIds/.test(chatJs) && /while \(seenHeadingIds\.has\(id\)\) id = `\$\{base\}-\$\{n\+\+\}`/.test(chatJs),
    'duplicate headings get unique ids instead of colliding');
  ok(/querySelectorAll\('pre, table'\)\.forEach\(\(el\) => \{ el\.tabIndex = 0; \}\)/.test(chatJs),
    'wide code blocks and tables get a keyboard tab stop');
  const guideCss = read('lib/public/css/app.css');
  ok(/\.help-modal \{[^}]*overflow: hidden/.test(guideCss), 'the Guide scrolls in its body, not in a non-focusable dialog');
  ok(/\.help-body pre:focus-visible, \.help-body table:focus-visible/.test(guideCss),
    'the scrollable Guide regions keep a visible focus ring');

  // The README must carry the public-facing details of the recent features (the single public doc).
  ok(/In-App Guide/.test(readme), 'the README documents the in-app Guide');
  ok(/--enforce-host-guard/.test(readme), 'the README documents --enforce-host-guard');
  ok(/--bind/.test(readme) && /--ollama-host/.test(readme), 'the README documents the runtime CLI flags');

  // The Guide is the README, so the recent behavior must actually be in it.
  for (const [re, label] of [
    [/Stopping a Turn and Long-Running Progress/, 'Stop / long-running progress'],
    [/Finding and Opening a Document/, 'document filter and open-by-name'],
    [/Sources \(N\)|single \*\*Sources/, 'the single source row'],
    [/bottom sheet titled \*\*Answer options\*\*/, 'the mobile Tools sheet'],
    [/ocrLanguages/, 'additional OCR languages'],
    [/Advanced → Conversation/, 'the new conversation toggles'],
    [/Read-aloud language/, 'the read-aloud language setting'],
    [/\*\*System voice\*\*/, 'the per-language system-voice picker'],
    [/saved per language|own language picker/, 'per-language voice preferences and context'],
    [/share a writing system/, 'script-aware language coverage'],
    [/Catalan|Latvian/, 'Latin-script catalog coverage'],
    [/\*\*Read as…\*\*/, 'the per-answer Read as dialog'],
    [/detected language/, 'the detected-language display'],
    [/\*\*Installed voices\*\*/, 'installed-voice diagnostics'],
    [/Settings shows \*\*preparing\*\*/, 'model preparation progress'],
    [/answers already on the screen/, 'live-answer reattachment'],
    [/updates those controls/, 'live re-labeling after a language change'],
    [/first read with it shows a brief notice/, 'the online-voice notice'],
    [/Allow online voices/, 'the online-voice opt-in'],
    [/desktop shell/, 'the desktop system-voice limitation'],
    [/system voice/i, 'system voices for non-English answers'],
    [/e2e:safari/, 'the automated Safari pass'],
    [/VoiceOver/, 'the screen-reader part of the manual pass'],
    [/English-only because both host voices/, 'the podcast language limitation'],
  ]) ok(re.test(readme), `the Guide covers ${label}`);

  console.log(`\nALL README-GUIDE UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ README-GUIDE UNIT TEST FAILED:', e.message);
  process.exit(1);
}
