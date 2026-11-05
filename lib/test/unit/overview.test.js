'use strict';
// Unit tests for the corpus-overview detector (lib/retrieval/overview.js) that gates
// auto workspace synthesis. Whole-corpus questions must be recognized; ordinary questions and
// per-document asks must NOT be (wrongly launching a slow synthesis is worse than missing a
// broad one). Pure and deterministic. Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { looksWorkspaceOverview } = require(path.join(PROJECT, 'lib', 'retrieval', 'overview'));

let checks = 0;
const yes = (q) => { checks++; assert.strictEqual(looksWorkspaceOverview(q), true,  `expected overview: "${q}"`); };
const no  = (q) => { checks++; assert.strictEqual(looksWorkspaceOverview(q), false, `expected NOT overview: "${q}"`); };

try {
  // ── whole-corpus questions route to synthesis ──
  yes('What are the common themes across all my documents?');
  yes('Give me an overview of this workspace');
  yes('Summarize everything');
  yes('summarize all my documents');
  yes('What recurring topics show up across these files?');
  yes('brief me on the corpus');
  yes("What's in my collection?");
  yes('How do these documents connect?');
  yes('Synthesize the whole workspace');
  console.log('✓ overview: whole-corpus questions are detected');

  // ── ordinary / per-document questions stay on normal retrieval ──
  no('Summarize this document');
  no('What is the Zephyr sensor throughput?');
  no('Who wrote the report?');
  no('What are the main points of section 3?');   // one document, no corpus cue
  no('tell me more');
  no('compare the two proposals');                // a 2-item comparison, not the whole corpus
  no('what is machine learning');
  no('');
  no('themes');                                    // too short / no corpus cue
  console.log('✓ overview: ordinary and per-document questions are not misrouted');

  console.log(`\nALL OVERVIEW UNIT TESTS PASSED (${checks} checks)`);
  process.exitCode = 0;
} catch (e) {
  console.error('\n✗ OVERVIEW UNIT TEST FAILED:', e && e.message);
  process.exitCode = 1;
}
