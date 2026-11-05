'use strict';

// ── parseworker — run the heavy synchronous document parsers off the event loop ──
//
// An XLSX workbook or a large JSON file parses synchronously, so on a big file it stalls
// the server's event loop mid-index — janking concurrent queries and the status stream.
// This offloads that work to a worker thread via the shared supervisor (lib/workerrpc.js),
// exactly as the reranker does. It is fully best-effort: on any worker failure the parse
// runs inline instead (the same result, just on the main thread), so indexing never breaks.
// The parsing itself lives in parsecore.js and runs inside the worker.

const path = require('path');
const { WorkerRpc } = require('../workerrpc');

const PARSE_TIMEOUT_MS = 60000;   // a very large workbook can take a while; still bounded

const _WORKER_CODE = `
  const { parentPort, workerData } = require('worker_threads');
  const core = require(workerData.coreModulePath);
  // Serialize so two large parses can't run at once and double the worker's memory.
  let chain = Promise.resolve();
  parentPort.on('message', (m) => {
    chain = chain.then(() => {
      try {
        if (m.op === 'xlsx') { parentPort.postMessage({ id: m.id, text: core.xlsxToText(m.buffer) }); return; }
        if (m.op === 'json') { parentPort.postMessage({ id: m.id, text: core.jsonToText(m.text) }); return; }
      } catch (e) { parentPort.postMessage({ id: m.id, error: (e && e.message) || String(e) }); }
    });
  });
`;

// Cap the worker's V8 heap so a pathological workbook or JSON file crashes just this worker
// (the supervisor respawns it, and the parse falls back inline) instead of growing the whole
// server toward an out-of-memory kill. Mirrors the reranker worker's heap cap.
const WORKER_HEAP_MB = require('../constants').PARSE_WORKER_HEAP_MB;   // shared cap with the fork child (extractprocess)

const _rpc = new WorkerRpc({
  name:       'parse',
  code:       _WORKER_CODE,
  workerData: () => ({ coreModulePath: path.join(__dirname, 'parsecore.js') }),
  timeoutMs:  PARSE_TIMEOUT_MS,
  resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
});

const _core = () => require('./parsecore');

// Parse an XLSX/XLSM workbook buffer to searchable text, off the event loop when possible.
const parseXlsx = async (buffer) => {
  try {
    const reply = await _rpc.request({ op: 'xlsx', buffer }, { timeoutMs: PARSE_TIMEOUT_MS });
    if (reply && !reply.error && typeof reply.text === 'string') return reply.text;
  } catch (e) {
    // A timeout OR a worker DEATH means this workbook is pathologically expensive or OOM-crashed the
    // heap-capped worker; re-running it inline would just freeze or crash the MAIN thread, so treat it as
    // unparseable. Only true unavailability (no worker was free to take the job) falls back to the inline
    // parse below — there nothing ran, so the input never crashed anything.
    if (e && e.unavailable) return _core().xlsxToText(buffer);
    return '';
  }
  // reply.error: the worker caught a parse error (not a crash) — reproduce it inline so the caller's
  // name-only fallback handles it exactly as before.
  return _core().xlsxToText(buffer);
};

// Pretty-print JSON text, off the event loop when possible.
const parseJson = async (text) => {
  try {
    const reply = await _rpc.request({ op: 'json', text }, { timeoutMs: PARSE_TIMEOUT_MS });
    if (reply && !reply.error && typeof reply.text === 'string') return reply.text;
  } catch (e) {
    // On a timeout OR a worker death (an OOM crash on this input), index the raw text — already searchable —
    // rather than re-parsing inline and risking another main-thread stall or crash. Only true unavailability
    // (no worker free) falls back to the inline pretty-print, where nothing ran and inline is the only option.
    if (e && e.unavailable) return _core().jsonToText(text);
    return _core().capText(text);
  }
  return _core().jsonToText(text);
};

// Terminate the worker on shutdown (registered by lokyni.js). Best-effort.
const shutdownParseWorker = () => { try { _rpc.shutdown('shutdown'); } catch {} };

module.exports = { parseXlsx, parseJson, shutdownParseWorker };
