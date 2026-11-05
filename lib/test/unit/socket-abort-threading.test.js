'use strict';
// Guards that the socket generation paths cancel a stalled model promptly and never start work for a
// client that already left. streamChat honors opts.signal (aborting the provider request between/within
// chunks — covered functionally by api-abort-on-disconnect.test.js); this guards the WIRING that gets the
// turn's abort signal all the way into the answer and summary streams, plus the pre-stream disconnect
// bail-outs:
//   • the main document-answer path threads the turn's AbortSignal through searchDocuments into the
//     streamChat call, so a New/disconnect cancels the provider request immediately instead of waiting
//     for the next token (a stalled model would otherwise hold the serialized generation queue for the
//     full idle timeout);
//   • summarize_document passes the signal into streamChat too;
//   • both handlers bail if the client disconnected while the workspace bundle was warming (the disconnect
//     fired before the turn's controller existed, so nothing else would cancel it).
// The socket path needs a live model to exercise end to end, so these are source-inspection guards.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  const search = read('lib/retrieval/search.js');
  const socket = read('lib/socket.js');

  // ── shared socket helpers (no per-handler copy to drift): payload parsing and turn release ──
  // A client may send a JSON string or an object; every handler normalizes through one parsePayload, and
  // every generation finally releases through one releaseTurn. Both are single-sourced.
  ok(/const parsePayload = \(raw\) => \(typeof raw === 'string' \? JSON\.parse\(raw\) : \(raw \|\| \{\}\)\);/.test(socket),
    'socket defines one shared parsePayload helper');
  ok(!/typeof raw === 'string' \? JSON\.parse\(raw\) : \(raw \|\| \{\}\)/.test(socket.replace(/const parsePayload[^\n]*\n/, '')),
    'no handler re-inlines the payload parse (all route through parsePayload)');
  ok((socket.match(/parsePayload\(raw\)/g) || []).length >= 4, 'the socket handlers parse payloads through parsePayload');

  // ── search.js threads the caller's signal into the answer stream's genOpts ──
  ok(/const genOpts = options\.signal \? \{ signal: options\.signal \} : \{\};/.test(search),
    'searchDocuments puts the caller signal onto genOpts (the answer stream honors it)');
  ok(/yield\* streamChat\(messages, genOpts\);/.test(search),
    'the document answer stream passes genOpts (carrying the signal) to streamChat');

  // ── the RETRIEVAL phase (before generation) also honors the signal, at each provider-call boundary ──
  // An abandoned turn otherwise runs the full sequence of aux-LLM round-trips (intent, corrective, query
  // expansion, HyDE) and the cross-encoder rerank to completion, holding the serialized queue against the
  // next real question. searchDocuments bails at each boundary, returning the same empty shape the
  // out-of-scope path uses (which the socket handler already re-checks and handles).
  ok(/const bailIfAborted = \(\) => options\.signal && options\.signal\.aborted;/.test(search),
    'searchDocuments defines an abort check keyed on the caller signal');
  ok(/const abortedResult = \(\) => \(\{ stream: _abortedStream\(\)[\s\S]*?aborted: true/.test(search),
    'an abandoned turn returns the empty, caller-safe aborted result');
  ok(/if \(bailIfAborted\(\)\) return abortedResult\(\);[\s\S]{0,120}?let faissResults = await denseSearch/.test(search),
    'retrieval bails before the dense search');
  ok((search.match(/if \(bailIfAborted\(\)\) return abortedResult\(\);/g) || []).length >= 3,
    'retrieval bails at multiple phase boundaries (dense, augmentation, rerank)');
  ok(/&& !bailIfAborted\(\)\) \{[\s\S]*?correctiveQuery/.test(search),
    'corrective retrieval is skipped once the turn is aborted');

  // ── the main message handler passes the turn signal into searchDocuments and bails if the client left ──
  const sdIdx = socket.indexOf('const result = await searchDocuments(');
  ok(sdIdx !== -1, 'the main handler calls searchDocuments');
  ok(/idx, signal: abort\.signal,/.test(socket.slice(sdIdx, sdIdx + 400)),
    'the main handler passes signal: abort.signal into searchDocuments');
  // The main handler's disconnect bail-out sits between its abort creation and the retrieval loop.
  ok(/don't start an expensive generation for a dead socket[\s\S]{0,200}if \(!client\.connected\) return;/.test(socket),
    'the main handler bails after bundle warming if the client already disconnected');

  // ── the socket heartbeat tolerates a busy event loop (heavy index / GC pause) ──
  // At Socket.IO's 20s default, a big native FAISS add or a post-reindex GC pause drops the client
  // mid-answer and loses the turn. The timeout must stay generously above that default.
  const pingTimeout = socket.match(/pingTimeout:\s*(\d+)/);
  ok(pingTimeout && Number(pingTimeout[1]) >= 60000,
    'the socket ping timeout is raised well above the 20s default so a heavy-work stall does not drop the client');
  ok(/pingInterval:\s*\d+/.test(socket), 'a matching ping interval is set');

  // ── summarize_document threads the signal and bails on a pre-stream disconnect ──
  const sumIdx = socket.indexOf("client.on('summarize_document'");
  ok(sumIdx !== -1, 'the summarize_document handler exists');
  const sumBlock = socket.slice(sumIdx, sumIdx + 7000);
  ok(/for await \(const chunk of streamChat\(req\.messages, \{ signal: abort\.signal \}\)\)/.test(sumBlock),
    'summarize_document passes the abort signal into streamChat');
  ok(/if \(!client\.connected\) return;/.test(sumBlock),
    'summarize_document bails before streaming if the client already disconnected');

  console.log('✓ socket-abort-threading: answer + summary streams receive the turn signal and skip work for a gone client');

  // ── workspace synthesis threads the turn signal into BOTH its LLM phases ──
  // runWorkspaceSynthesis is a map/reduce: a per-document summary pass (the bulk of the runtime) followed by
  // one reduce-phase synthesis stream. It checks signal?.aborted at loop boundaries, but without threading
  // the signal INTO each model call a single stalled document (map) or the final stream (reduce) could run
  // for the full idle timeout after a New/disconnect. Both calls must carry { signal }.
  const apiCore = read('lib/api-core.js');
  const synIdx = apiCore.indexOf('runWorkspaceSynthesis');
  ok(synIdx !== -1, 'runWorkspaceSynthesis exists in api-core');
  const synBlock = apiCore.slice(synIdx, apiCore.indexOf('const runSummarize', synIdx));
  ok(/summarizeToString\(entry, \{ signal \}\)/.test(synBlock),
    'the synthesis map phase threads the turn signal into each per-document summary');
  ok(/streamChat\(messages, \{ signal \}\)/.test(synBlock),
    'the synthesis reduce phase threads the turn signal into the final synthesis stream');
  console.log('✓ socket-abort-threading: workspace synthesis cancels both its map and reduce model calls on abort');

  // ── Deep Research grades its answer against the TURN'S workspace, not the active one ──
  // A research answer's sources are indexed docs from turnWs. emitAnswerMeta must get that workspace's
  // index as `idx`, or faithfulness/figures resolve the source ids against the active state, find none, and
  // the Verify/numeric badge silently never appears for research on a non-active workspace.
  const drIdx = socket.indexOf('🔬 Deep research error');
  const drBlock = socket.slice(socket.lastIndexOf('const result = await deepResearch', drIdx), drIdx);
  ok(/getBundleNonBlocking\(turnWs\)[\s\S]*?metaIdx = acq\.bundle/.test(drBlock),
    'runDeepResearch resolves the turn workspace bundle for the faithfulness check');
  ok(/emitAnswerMeta\(\{[^}]*idx: metaIdx \}\)/.test(drBlock),
    'runDeepResearch passes the turn-workspace idx into emitAnswerMeta (badge resolves on a non-active workspace)');

  console.log('✓ socket-abort-threading: Deep Research grades its answer against the turn workspace index');
  console.log(`\nALL SOCKET-ABORT-THREADING UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ SOCKET-ABORT-THREADING UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
