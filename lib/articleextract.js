'use strict';
// Off-thread article extraction.
//
// The readability extractor parses the page's DOM synchronously, so a huge or pathological page can stall
// the event loop — freezing the status stream, other in-flight queries, and the MCP endpoint for as long as
// the parse runs. Running it in a worker through the shared supervisor (workerrpc.js) lets a bad page be
// TERMINATED on a timeout instead of freezing the process. The pure extraction itself lives in
// articleextractcore.js and is shared by the worker body and the inline fallback, so they cannot drift.
//
// Fallback policy (matching the reranker managers): fall back to inline extraction ONLY when no worker was
// available to take the job (warming up, or a post-crash cooldown) — the pre-existing behavior, safe because
// nothing suggests THIS page is pathological. After a timeout or a worker death, do NOT run inline: the page
// already stalled or crashed the worker, and repeating it on the main thread is exactly the freeze we are
// preventing — return null, which the caller treats as "no article" (never a throw).
//
// Cross-platform: worker_threads behaves identically on macOS, Linux, and Windows.

const { WorkerRpc } = require('./workerrpc');
const core = require('./articleextractcore');

const WORKER_HEAP_MB = 512;        // cap the worker's V8 heap so a runaway page OOMs the thread, not the process
const EXTRACT_TIMEOUT_MS = 20000;  // a real extract is sub-second; this is the "the page wedged the parser" bound

// The worker body: require the pure core by its real on-disk path (so resolution does not depend on the
// worker's cwd), then extract per message. It never posts an error — a failed/empty extract posts data:null,
// so the only ways a request does not resolve are a timeout or a crash, which the supervisor handles.
const WORKER_CODE = `
  const { parentPort, workerData } = require('worker_threads');
  const core = require(workerData.coreModulePath);
  parentPort.on('message', async (m) => {
    try { const data = await core.extract(m.html, m.url, { maxChars: m.maxChars }); parentPort.postMessage({ id: m.id, data: data || null }); }
    catch { parentPort.postMessage({ id: m.id, data: null }); }
  });
`;

const rpc = new WorkerRpc({
  name: 'article-extract',
  code: WORKER_CODE,
  workerData: () => ({ coreModulePath: require.resolve('./articleextractcore') }),
  resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
  timeoutMs: EXTRACT_TIMEOUT_MS,
});

// Extract an article from already-fetched HTML, off the main thread. Returns the extractor's data object
// ({ title, content, image, author, published }) or null. Never throws.
const extractArticle = async (html, url, { timeoutMs = EXTRACT_TIMEOUT_MS } = {}) => {
  try {
    const m = await rpc.request({ html: String(html || ''), url, maxChars: core.MAX_CONTENT_CHARS }, { timeoutMs });
    return (m && m.data) || null;
  } catch (e) {
    if (e && e.unavailable) { try { return await core.extract(html, url); } catch { return null; } }
    return null;   // timeout / worker death → do NOT re-run inline (would repeat the stall); drop the page
  }
};

// Terminate the worker and reject any in-flight call — wired into graceful shutdown so nothing is orphaned.
const shutdown = () => { try { rpc.shutdown('article-extract shutdown'); } catch (_) { /* best-effort */ } };

module.exports = { extractArticle, shutdown };
