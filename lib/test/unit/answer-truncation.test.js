'use strict';
// Guards the mid-stream truncation handling. If the LLM stalls after streaming some tokens, streamChat's
// idle timeout ends the generator cleanly — indistinguishable from a complete answer — so a partial answer
// was previously streamed, saved to history, AND cached, to be replayed instantly as if complete. streamChat
// now marks the passed options object truncated on a mid-stream timeout; the retrieval result surfaces it;
// and the socket appends an "answer may be incomplete" caveat and skips caching that answer. This is awkward
// to drive with a real stalling provider, so it is checked at the source level. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const llm = fs.readFileSync(path.join(PROJECT, 'lib', 'llm.js'), 'utf-8');
const search = fs.readFileSync(path.join(PROJECT, 'lib', 'retrieval', 'search.js'), 'utf-8');
const socket = fs.readFileSync(path.join(PROJECT, 'lib', 'socket.js'), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  // streamChat marks truncation on the MID-stream idle timeout (the branch that already yielded content),
  // not on the establish-phase timeout (which yields nothing and is a retryable empty answer).
  ok(/if \(opts && typeof opts === 'object'\) opts\.truncated = true;/.test(llm), 'streamChat sets opts.truncated on a mid-stream idle timeout');
  // The mid-stream idle-timeout handler sets truncated and then breaks (keeps partial); the establish-phase
  // handler returns with no output instead. Match the first _lokTimeout handler (in the chunk loop).
  ok(/if \(e && e\._lokTimeout\) \{[\s\S]*?opts\.truncated = true;[\s\S]*?break;/.test(llm), 'the truncated flag is set in the chunk-loop timeout handler (mid-stream), which keeps the partial text');

  // The document answer threads a shared genOpts into streamChat and exposes it on the result.
  ok(/const genOpts = options\.signal \? \{ signal: options\.signal \} : \{\};/.test(search) && /yield\* streamChat\(messages, genOpts\)/.test(search), 'documentStream passes a shared genOpts (carrying any caller signal) into streamChat');
  ok(/stream: documentStream\(\),\s*\n\s*genOpts,/.test(search), 'the retrieval result exposes genOpts so the caller can read truncation after draining');

  // The socket reads it after draining, appends the shared UI caveat, and does NOT cache a truncated answer.
  ok(/truncated = !!\(result\.genOpts && result\.genOpts\.truncated\)/.test(socket), 'the socket captures the truncation flag after draining the stream');
  ok(/if \(truncated\) \{[\s\S]*?client\.emit\('message', require\('\.\/llm'\)\.TRUNCATION_NOTICE\)/.test(socket), 'a truncated answer gets the shared UI caveat');
  ok(/if \(scCacheable && responseText && !truncated\)/.test(socket), 'a truncated answer is never written to the semantic cache');
  // The caveat text is single-sourced in llm.js and says the answer may be incomplete.
  const { TRUNCATION_NOTICE } = require(path.join(PROJECT, 'lib', 'llm'));
  ok(typeof TRUNCATION_NOTICE === 'string' && /may be incomplete/.test(TRUNCATION_NOTICE), 'the shared truncation notice explains the answer may be incomplete');
  // The web and research paths EXPOSE genOpts on their result (they must NOT yield the caveat into the
  // stream — that would persist it into saved history and re-send it to the model on a follow-up, unlike the
  // document path). The socket surfaces it as a separate UI-only message, mirroring the document path.
  for (const f of ['lib/retrieval/webanswer.js', 'lib/retrieval/deepresearch.js']) {
    const src = fs.readFileSync(path.join(PROJECT, f), 'utf-8');
    ok(/yield\* streamChat\(messages, genOpts\)/.test(src) && /,\s*genOpts\b/.test(src),
      `${f} threads genOpts into streamChat and exposes it on the result`);
    ok(!/yield TRUNCATION_NOTICE/.test(src), `${f} does NOT yield the caveat into the stream (keeps it out of history)`);
  }
  // The socket emits the shared notice for a truncated web/research answer, after draining, kept out of history.
  ok((socket.match(/if \(result\.genOpts && result\.genOpts\.truncated\) \{\s*\n\s*try \{ client\.emit\('message', require\('\.\/llm'\)\.TRUNCATION_NOTICE\)/g) || []).length >= 2,
    'the socket surfaces truncation for both the web and research paths as a separate UI message');
  console.log('✓ answer-truncation: document, web, and research answers all flag a mid-stream stall (UI-only, never saved to history) and never cache a partial as complete');

  console.log(`\nALL ANSWER-TRUNCATION UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ ANSWER-TRUNCATION UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
