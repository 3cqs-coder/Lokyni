'use strict';
// Streaming pipeline UX: the retrieval phase surfaces live status ("Searching… → Reranking… → Writing the
// answer from N sources…") so a local-model wait reads as progress, not a freeze. The status is an optional,
// best-effort callback threaded through searchDocuments and emitted over the existing synth_progress channel
// (which drives the thinking bubble AND pushes the no-response watchdog forward). This guards that wiring and
// that it can never throw into the retrieval pipeline. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(PROJECT, ...p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  const search = read('lib', 'retrieval', 'search.js');

  // ── the stage() helper is optional + fault-isolated ──
  ok(/const stage = \(text\) => \{ try \{ if \(typeof options\.onStage === 'function'\) options\.onStage\(text\); \} catch/.test(search),
    'search.js defines a best-effort stage() helper (guarded so a status update can never affect the answer)');

  // ── stages fire at the three pipeline milestones, in order ──
  const iSearch = search.indexOf("stage('Searching your documents…')");
  const iRerank = search.indexOf('stage(`Reranking the top ${candidateChunks.length} passages…`)');
  const iWrite  = search.indexOf('stage(mergedDocs.length ?');
  ok(iSearch > 0, 'a "Searching…" stage fires before dense retrieval');
  ok(iRerank > 0, 'a "Reranking…" stage fires before the reranker, with the candidate count');
  ok(iWrite > 0, 'a "Writing the answer from N sources…" stage fires as generation begins');
  ok(iSearch < iRerank && iRerank < iWrite, 'the stages appear in pipeline order (search → rerank → write)');

  // ── the write stage names the locked-in source count (citations resolved) ──
  ok(/Writing the answer from \$\{mergedDocs\.length\} source/.test(search),
    'the answer stage reports how many sources locked in');

  // ── the "Searching…" stage is placed after the abort check, not before (no status for an aborted turn) ──
  ok(/if \(bailIfAborted\(\)\) return abortedResult\(\);\s*\n\s*stage\('Searching your documents…'\);/.test(search),
    'the search stage fires only after the abort check');

  // ── socket wires onStage onto the existing synth_progress channel, abort-guarded ──
  const sock = read('lib', 'socket.js');
  ok(/onStage: \(text\) => \{ if \(!abort\.signal\.aborted\) \{ stallThisTurn\.note\(text\); try \{ client\.emit\(TURN_PROTOCOL\.progress, \{ text \}\); \} catch \{\} \} \}/.test(sock),
    'the message handler forwards pipeline stages over the shared progress event (abort-guarded, and attributed)');

  // ── the client already renders synth_progress into the thinking bubble and re-arms the watchdog ──
  const chat = read('lib', 'public', 'js', 'chat.js');
  ok(/socket\.on\(TURN_PROTOCOL\.progress, \(data\) => \{[\s\S]{0,500}?setThinkingStatus\(data\.text\);[\s\S]{0,120}?armTurnWatchdog\(\);/.test(chat),
    'the client renders progress status in the thinking bubble and pushes the watchdog forward');

  console.log(`\nALL PIPELINE-STATUS UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ PIPELINE-STATUS UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
