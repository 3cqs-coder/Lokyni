'use strict';
// Guards the post-answer background work. Verify and suggested follow-ups are useful, but they run extra
// generations on the same local model as the chat. If the user asks the next question while they are still
// running, that answer queues behind them and looks like the model itself is slow. A new question must
// cancel the previous turn's background work, and those calls must accept the abort signal.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

try {
  const socket = read('lib/socket.js');
  const suggest = read('lib/chat/suggest.js');
  const faith = read('lib/trust/faithfulness.js');

  ok(/abortBackgroundJobs\(\);\s*\n\s*\/\/ A new question supersedes/.test(socket) ||
     /A new question supersedes the previous answer's fire-and-forget work[\s\S]{0,300}?abortBackgroundJobs\(\);/.test(socket),
  'a new question cancels the previous turn’s background generations');

  ok(/const bg = new AbortController\(\);\s*\n\s*bgAborts\.add\(bg\);/.test(socket),
    'Verify runs under a tracked background controller');
  ok(/scoreAnswer\(answer, src, metaIdx, query, \{ signal: bg\.signal \}\)/.test(socket),
    'the Verify call receives the abort signal');
  ok(/if \(bg\.signal\.aborted\) return;/.test(socket),
    'a cancelled Verify result is not emitted');

  ok(/suggestQuestions\(\{ query, answer, sources: src, signal: bg\.signal \}\)/.test(socket),
    'the suggested-follow-up call receives the abort signal');
  ok(/if \(questions && questions\.length && client\.connected && !bg\.signal\.aborted\)/.test(socket),
    'cancelled suggestions are not emitted');

  ok(/const suggestQuestions = async \(\{ query, answer, sources, signal \} = \{\}\)/.test(suggest),
    'suggestQuestions accepts an abort signal');
  ok(/\.\.\.\(signal \? \{ signal \} : \{\}\)/.test(suggest),
    'the signal is passed into the suggestion completion');
  ok(/const runClaimJudge = async \(answer, context, cfg, query, corpusIdf, sourceFullText, signal = null\)/.test(faith),
    'the claim judge accepts an abort signal');
  ok(/\.\.\.\(signal \? \{ signal \} : \{\}\)/.test(faith),
    'the claim judge passes the signal into its completion');
  ok(/const scoreAnswer = async \(answer, sources, idx, query, \{ signal = null \} = \{\}\)/.test(faith),
    'scoreAnswer accepts an abort signal');

  console.log(`\nALL BACKGROUND-WORK UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ BACKGROUND-WORK UNIT TEST FAILED:', e && e.message);
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
}
