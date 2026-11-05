'use strict';
// Source-inspection drift guard for the public data plane (lib/routes/apiv1.js). Two properties
// must not regress:
//   1. No 5xx handler returns a raw error message to a remote key-holder. An exception's text can
//      carry an internal detail (a filesystem path, a stack fragment, a dependency's error string);
//      leaking it off-box to a caller who holds only an API key is information disclosure. Every
//      catch routes through the fail() helper, which logs the real error server-side and returns a
//      fixed generic message.
//   2. Every model-backed endpoint (search, summarize, synthesize, chat/completions) passes through
//      the shared concurrency gate before it generates, and releases the slot in a finally — so a
//      burst of parallel requests can't saturate the single local model or hold many streams open at
//      once (a fast 429 with backpressure is returned instead). Reads (workspaces, documents) don't
//      generate and are not gated. No model, no network. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const src = fs.readFileSync(path.join(PROJECT, 'lib', 'routes', 'apiv1.js'), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

try {
  // ── 1. No raw error text is returned to the client on a failure path ──
  // The regression this guards: `res.status(500).json({ error: e.message })`. Match a JSON error
  // response whose value is the caught exception's own text, in any 4xx/5xx shape.
  ok(!/error:\s*e\.message/.test(src), 'no handler returns the raw exception text (e.message) to the caller');
  ok(!/error:\s*(e\.message\s*\|\||\(e\s*&&\s*e\.message\))/.test(src), 'no handler returns e.message even as a fallback string');

  // The generic-error helper exists and logs the real error server-side while returning a fixed message.
  ok(/const fail = \(res, e, label/.test(src), 'a shared fail() helper genericizes error responses');
  ok(/console\.error\(`❌ \/api\/v1\/\$\{label\} failed:`/.test(src), 'fail() logs the real error server-side');
  ok(/if \(!res\.headersSent\)/.test(src), 'fail() respects an already-sent (streaming) response');

  // Every catch block in the file routes through fail() — none returns its own ad-hoc error body.
  const catchCount = (src.match(/\}\s*catch\s*\(e\)\s*\{/g) || []).length;
  const failCount  = (src.match(/fail\(res, e,/g) || []).length;
  ok(catchCount > 0, 'the router has request-handler catch blocks');
  // Every top-level handler catch uses fail(); the only catches that don't are the inner
  // best-effort ones (post-ingest indexing, res.end() cleanup) that never answer the client.
  ok(failCount >= 7, `all client-answering catch blocks use fail() (found ${failCount})`);

  // ── 2. The generation gate wraps every model-backed endpoint ──
  // The gate is the shared, process-wide singleton (lib/gengate.js) so the HTTP API and the MCP server
  // draw from one concurrency budget for the single local model.
  ok(/const _genGate = require\('\.\.\/gengate'\)/.test(src), 'the API uses the shared process-wide generation gate');
  const gg = fs.readFileSync(path.join(PROJECT, 'lib', 'gengate.js'), 'utf-8');
  ok(/createSemaphore\(\{[^}]*queueMax:/.test(gg), 'the shared gate is a semaphore with a bounded queue');
  ok(/const acquireGen = async \(res\) =>/.test(src), 'an acquireGen() helper takes a slot or answers 429');
  ok(/res\.status\(429\)/.test(src) && /Retry-After/.test(src), 'a saturated gate answers 429 with Retry-After (backpressure)');

  const acquireCount = (src.match(/if \(!\(await acquireGen\(res\)\)\) return;/g) || []).length;
  const releaseCount = (src.match(/_genGate\.release\(\);/g) || []).length;
  eq(acquireCount, 4, 'the four model-backed endpoints (search, summarize, synthesize, chat/completions) each acquire a slot');
  eq(releaseCount, 4, 'each acquired slot is released in a finally (no leaked slot)');

  // The read-only routes must NOT be gated — they don't generate and gating them would add needless latency.
  // (Guard by counting: 4 acquires for 4 gen endpoints; if a read route were gated the count would rise.)
  ok(acquireCount === releaseCount, 'every acquire has exactly one matching release');

  // The browser control-plane "related documents" route is also model-backed (it embeds a query), so it
  // must draw from the SAME gate rather than opening concurrent embeds behind the gated paths. It uses
  // genGate.run() (acquire+release in one) and maps the gate's backpressure rejection to a 429.
  const docsSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'routes', 'documents.js'), 'utf-8');
  ok(/require\('\.\.\/gengate'\)\.run\(\(\) => require\('\.\.\/api-core'\)\.relatedDocuments\(/.test(docsSrc),
    'the related-documents route runs through the shared generation gate');
  ok(/e && e\.backpressure/.test(docsSrc) && /status\(429\)/.test(docsSrc) && /Retry-After/.test(docsSrc),
    'a saturated gate answers the related-documents route 429 with Retry-After');

  // ── 3. chat/completions appends the invented-citation caveat (parity with the in-app path) ──
  // The in-app socket path warns when an answer cites a document that was not among the retrieved sources;
  // the API must do the same so an external consumer gets the same caution. Both the streaming and the
  // non-streaming branch run the finalized answer through appendCitationCaveat (which wraps grounding.caveatFor,
  // best-effort, never throws).
  // The finalize sequence is single-sourced in lib/answerfinalize.js (so scheduled automations and the API chat
  // egress apply the EXACT same safeguards); apiv1 calls the shared finalizeGrounded rather than re-inlining the
  // composition, so a new safeguard step added to finalizeGrounded can't miss the API chat endpoint.
  const finSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'answerfinalize.js'), 'utf-8');
  ok(/const \{ finalizeGrounded \} = require\('\.\.\/answerfinalize'\)/.test(src),
    'apiv1 imports the shared finalizeGrounded from answerfinalize');
  ok(/const groundedTextParts = \(answer, sources, idx\) =>/.test(finSrc) && /require\('\.\/grounding'\)\.caveatFor\(text, sources\)/.test(finSrc),
    'the shared groundedTextParts helper applies grounding.caveatFor (best-effort, single-sourced for all surfaces)');
  ok(/require\('\.\/faithfulness'\)\.quoteCaveatFor\(text, sources, idx\)/.test(finSrc),
    'the shared groundedTextParts helper also applies the deterministic quotation guard');
  const groundedCalls = (src.match(/finalizeGrounded\(answer, r\.sources, r\.idx\)/g) || []).length;
  eq(groundedCalls, 2, 'both the streaming and non-streaming chat/completions branches apply the shared finalizeGrounded');
  ok(!/appendFigureCaveat\(appendCitationCaveat/.test(src), 'apiv1 no longer re-inlines the finalize composition (single-sourced)');
  console.log('✓ apiv1: chat/completions applies the shared finalizeGrounded on both branches (parity, no inlined copy)');

  // ── 3b. chat/completions also appends the NUMERIC-grounding caveat (parity with the always-on app check) ──
  // The in-app path runs faithfulness.checkFigures on EVERY document answer (not only when Verify is on) and
  // surfaces a badge for a figure the cited documents don't support; the API must warn inline too, or a caller
  // gets an unverified number silently. Both branches wrap the citation caveat with appendFigureCaveat, which
  // needs the resolved bundle — so runGroundedChat returns `idx`.
  ok(/const appendFigureCaveat = \(answer, sources, idx\) =>/.test(finSrc) && /require\('\.\/faithfulness'\)\.checkFigures\(answer, sources, idx\)/.test(finSrc),
    'the shared appendFigureCaveat() helper wraps faithfulness.checkFigures (best-effort)');
  // The shared finalizeGrounded composes the full sequence (the verify + citation parts from groundedTextParts,
  // then the figure caveat), and automations uses it for its query egress (parity).
  ok(/const finalizeGrounded = \(answer, sources, idx\) => \{/.test(finSrc)
    && /groundedTextParts\(answer, sources, idx\)[\s\S]*?appendFigureCaveat\(text \+ caveat, sources, idx\)/.test(finSrc),
    'finalizeGrounded composes verify.finalize + citation + quotation (via groundedTextParts) + figure caveat');
  const autoSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'automations.js'), 'utf-8');
  ok(/finalizeGrounded\(await drain\(r\.stream, signal\), r\.sources \|\| \[\], r\.idx\)/.test(autoSrc),
    'the automations query egress applies the shared finalizeGrounded (safeguard parity with chat/API/MCP)');
  ok(/require\('\.\/verify'\)\.finalize\(await drain\(r\.stream, signal\)\)/.test(autoSrc),
    'the automations digest egress applies the always-on verify pass (parity with the API synthesize path)');
  // (Both chat/completions branches get the numeric-grounding caveat via finalizeGrounded — asserted above by
  // groundedCalls === 2; finalizeGrounded composes verify.finalize + citation + figure caveats.)
  const coreSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'api-core.js'), 'utf-8');
  ok(/idx,\s*\/\/ the resolved bundle/.test(coreSrc) || /\bidx,/.test(coreSrc.slice(coreSrc.indexOf('runGroundedChat'), coreSrc.indexOf('runGroundedChat') + 2000)),
    'runGroundedChat returns the resolved idx so the API can run the numeric-grounding check');
  console.log('✓ apiv1: chat/completions appends the numeric-grounding caveat on both branches (parity with the app)');

  // The raw-passage search egress (runSearch, backing /api/v1/search and the MCP search tool) must strip
  // invisible/bidi "Trojan-Source" control chars before returning document text, the same single-sourced strip
  // the answer egress uses — otherwise a planted bidi/zero-width payload reaches an agent/consumer that renders
  // the result as a spoofing/exfil construct.
  ok(/stripInvisibleChars/.test(coreSrc) && /require\('\.\/constants'\)/.test(coreSrc),
    'runSearch strips invisible/bidi chars from returned passage text (egress parity for the raw search surface)');
  // The document NAME/SOURCE is egress too — a crafted filename (upload, connector-synced repo) can carry a bidi
  // override or zero-width payload. It is sanitized via a single-sourced safeName on every consumer-facing
  // source/name field (search passages, list_documents, summarize, related docs), not only on content.
  ok(/const safeName = \(s\) => stripInvisibleChars\(/.test(coreSrc), 'api-core has a single-sourced safeName egress helper for filenames');
  ok(/source: safeName\(src\.source/.test(coreSrc), 'search passages run the source name through safeName');
  ok(/name: safeName\(path\.basename/.test(coreSrc), 'the document listing runs each name through safeName');
  // safeName must actually strip the Trojan-Source ranges (functional check of the helper's effect).
  const { stripInvisibleChars } = require(path.join(PROJECT, 'lib', 'constants'));
  ok(!/[‪-‮​-‏⁦-⁩]/.test(stripInvisibleChars('evil‮​doc.txt')), 'stripInvisibleChars removes bidi/zero-width chars from a filename');
  console.log('✓ apiv1: the raw search egress sanitizes invisible/bidi characters (content AND filename)');

  // Query-length bound: runSearch (the shared core behind /api/v1/search AND the MCP search tool) must clamp
  // the query to MAX_QUERY_CHARS, so NO entrypoint can drive embedding/retrieval on an unbounded string. The
  // REST route rejects earlier with a 400; MCP and any future caller inherit this one shared bound (it was the
  // one search input the MCP surface did not cap). Mirrors the single-sourced k clamp in the same function.
  ok(/MAX_QUERY_CHARS/.test(coreSrc) && /\.slice\(0,\s*MAX_QUERY_CHARS\)/.test(coreSrc),
    'runSearch clamps the query to the shared MAX_QUERY_CHARS, so every search entrypoint (incl. MCP) is bounded');
  console.log('✓ apiv1: the search query length is bounded in the shared core (parity across REST and MCP)');

  // ── 3c. summarize + synthesize run the FULL finalize pass (not just sanitizeEgress) ──
  // The output is buffered before sending, so these buffered paths get the same post-answer pass as the
  // non-streaming summary and the in-app path: strip exfil AND decline a coaxed system-prompt leak AND correct
  // a stated arithmetic slip. A bare sanitizeEgress here would skip the leak canary + arithmetic.
  eq((src.match(/require\('\.\.\/verify'\)\.sanitizeEgress\(/g) || []).length, 0,
    'no summarize/synthesize path uses bare sanitizeEgress — all egress goes through finalize');
  // All five model-answer egress sites run the full finalize pass: the two chat/completions branches through the
  // shared finalizeGrounded (verify.finalize + caveats); the two SSE branches (summarize-stream, synthesize-SSE)
  // through the shared emitFinalizedSSE, whose default IS verify.finalize so no SSE path can skip it; and the
  // synthesize-JSON branch calls verify.finalize directly (none are grounded Q&A, so no citation/figure caveats).
  ok(/const emitFinalizedSSE = async \(res, stream, signal, finalize\) => \{[\s\S]*?\(finalize \|\| require\('\.\.\/verify'\)\.finalize\)\(collected\)/.test(src),
    'the shared SSE finalizer defaults to the full verify.finalize pass (covers summarize-stream + synthesize-SSE)');
  eq((src.match(/require\('\.\.\/verify'\)\.finalize\(/g) || []).length, 1,
    'the synthesize-JSON egress site runs verify.finalize directly (the two SSE sites run it via the shared helper default)');
  eq((src.match(/finalizeGrounded\(answer, r\.sources, r\.idx\)/g) || []).length, 2,
    'the two chat/completions egress sites run the full finalize pass via finalizeGrounded');
  console.log('✓ apiv1: summarize/synthesize apply the full finalize pass (leak canary + arithmetic), parity with the app');

  console.log('✓ apiv1: 5xx handlers return a generic message (no e.message leak); model endpoints are concurrency-gated');

  // Free-text model inputs are length-capped (a multi-megabyte query/focus is rejected with a 400, not pushed
  // into retrieval/prompt assembly), and a non-string workspace param is a 400 (resolveAccess), not a silent
  // fallback to the default.
  // The cap is single-sourced in constants.js and imported here, so the chat socket enforces the SAME limit.
  ok(/const \{[^}]*MAX_QUERY_CHARS[^}]*\} = require\('\.\.\/constants'\)/.test(src), 'the max free-text input length is imported from the shared constants (single-sourced)');
  ok(/const MAX_QUERY_CHARS = \d+;/.test(fs.readFileSync(path.join(PROJECT, 'lib', 'constants.js'), 'utf-8')), 'constants.js defines the MAX_QUERY_CHARS value');
  ok(/query\.length > MAX_QUERY_CHARS\) return res\.status\(400\)/.test(src), 'search rejects an over-long query (400)');
  ok(/focus\.length > MAX_QUERY_CHARS\) return res\.status\(400\)/.test(src), 'synthesize rejects an over-long focus (400)');
  // Parity: the chat socket enforces the same cap (it previously had none) with a clear message, not a 400.
  const sockSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'socket.js'), 'utf-8');
  ok(/content\.length > MAX_QUERY_CHARS/.test(sockSrc) && /require\('\.\/constants'\)\.MAX_QUERY_CHARS/.test(sockSrc),
    'the chat socket caps an over-long question using the same shared MAX_QUERY_CHARS');
  ok(/focus\.length > MAX_QUERY_CHARS/.test(sockSrc),
    'the socket synthesize handler caps an over-long focus too (parity with HTTP /synthesize)');
  console.log('✓ apiv1: free-text inputs are length-capped (400 on overflow); the socket enforces the same cap');

  console.log(`\nALL APIV1-HARDENING UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ APIV1-HARDENING UNIT TEST FAILED:', e.message);
  process.exit(1);
}
