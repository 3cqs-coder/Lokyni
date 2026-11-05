'use strict';
// Guards the pre-generate confirmation for workspace synthesis (Overview / Study guide / FAQ / Timeline /
// Briefing / Flashcards). Clicking Generate reads across the WHOLE workspace and can take a while on a large
// library, so the user is told what it will do first. This asserts: every format in the picker has a plain
// description, and synthesizeWorkspace confirms before emitting the (expensive) synthesize request. Source
// inspection — the flow needs the live socket/DOM to run. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  const chat = read('lib/public/js/chat.js');
  const panel = read('lib/views/partials/doc-panel.ejs');
  const apiCore = read('lib/api-core.js');

  // ── the synthesis format catalog is the SINGLE source; the client holds no parallel maps ──
  // api-core SYNTHESIS_FORMATS is the one catalog: it carries each format's label + confirm phrase (+ audio
  // flag). The picker renders the options AND those UI fields from it as <option> data-attrs, and the client
  // reads them off the selected option — so there is no client-side label/description/flag map to drift.
  // The catalog's prompt text/labels live in a data file (lib/ai/data/synthesis-formats.json) with the rest of
  // the AI prompt wording; api-core loads it so there is still ONE source every consumer reads from.
  ok(/const SYNTHESIS_FORMATS = require\('\.\/ai\/data\/synthesis-formats\.json'\);/.test(apiCore),
    'api-core loads the SYNTHESIS_FORMATS catalog from the single data file');
  const catalog = require(path.join(PROJECT, 'lib', 'ai', 'data', 'synthesis-formats.json'));
  const formats = Object.keys(catalog);
  ok(formats.length >= 6, `the catalog defines the expected formats (found ${formats.length})`);
  for (const f of formats) {
    ok(typeof catalog[f].label === 'string' && catalog[f].label && typeof catalog[f].confirm === 'string' && catalog[f].confirm && typeof catalog[f].task === 'string' && catalog[f].task,
      `format "${f}" carries a label, a confirm phrase, and a task prompt`);
  }
  ok(catalog.podcast && catalog.podcast.audio === true, 'the audio (podcast) format is flagged audio:true in the catalog (not a client literal)');

  // The picker renders its options AND the UI data-attrs FROM the catalog, not from a hardcoded list.
  ok(/Object\.entries\(synthesisFormats\)\.forEach/.test(panel),
    'the picker renders its <option> list from the server catalog (synthesisFormats)');
  ok(/data-label="<%= fmt\.label %>"/.test(panel) && /data-confirm="<%= fmt\.confirm/.test(panel) && /data-audio="<%= fmt\.audio \? '1' : '' %>"/.test(panel),
    'each option carries the catalog label/confirm/audio as data-attrs');
  ok(!/<option value="(overview|studyGuide|faq|timeline|briefing|flashcards)">/.test(panel),
    'the picker has no hardcoded format options left to drift from the catalog');
  ok(/synthesisFormats \}\) %>/.test(read('lib/views/chat.ejs')),
    'the chat view passes the catalog into the doc-panel partial');
  ok(/synthesisFormats: SYNTHESIS_FORMATS/.test(read('lib/server.js')),
    'the chat route supplies the catalog to the view');

  // The client keeps NO parallel label/description map (the drift hazard this single-sourcing removes).
  ok(!/SYNTH_FORMAT_DESCRIPTIONS/.test(chat) && !/SYNTH_FORMAT_LABELS/.test(chat),
    'the client has no hardcoded format label/description maps (reads them from the option data-attrs instead)');
  ok(/opt\.dataset\.label/.test(chat) && /opt\.dataset\.confirm/.test(chat) && /opt\.dataset\.audio/.test(chat),
    'synthesizeWorkspace reads the label/confirm/audio off the selected option');
  ok(!/=== 'podcast'/.test(chat), 'no hardcoded "podcast" literal on the client (the audio flag comes from the catalog)');

  // ── Generate confirms BEFORE it emits the expensive synthesis, and bails if declined ──
  const fn = (chat.match(/async function synthesizeWorkspace\(\)[\s\S]*?\n\}/) || [''])[0];
  ok(fn, 'synthesizeWorkspace is async (it awaits the confirm)');
  const confirmAt = fn.indexOf('await showConfirm(');
  const emitAt    = fn.indexOf("socket.emit('synthesize_workspace'");
  ok(confirmAt !== -1 && emitAt !== -1 && confirmAt < emitAt,
    'the confirmation is awaited BEFORE the synthesize request is emitted');
  ok(/const ok = await showConfirm\(\{[\s\S]*?\}\);\s*\n\s*if \(!ok\) return;/.test(fn),
    'a declined confirmation returns without generating');
  ok(/read across every document in this workspace/.test(fn),
    'the message explains it reads across the whole workspace');
  ok(/if \(msgInput\.disabled\) return;[\s\S]*?await showConfirm[\s\S]*?if \(msgInput\.disabled\) return;/.test(fn),
    're-checks that no turn started while the dialog was open');

  console.log('✓ synthesize-confirm: Generate confirms and explains itself before reading the whole workspace');
  console.log(`\nALL SYNTHESIZE-CONFIRM UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ SYNTHESIZE-CONFIRM UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
