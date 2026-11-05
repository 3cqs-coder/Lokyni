'use strict';
// Central logging: an in-memory ring for the live log viewer, a daily-rotated file trail with
// retention, secret redaction, and level gating so a long-running process never spams the
// terminal. Modeled on the proven daily-rotation-plus-redaction logger used elsewhere.
//
// Design goals:
//   • QUIET BY DEFAULT: routine, high-frequency lines (per-file indexing progress, one-time
//     startup notices) go through debug()/progress(), which reach the ring and the daily file
//     but only reach the CONSOLE when DEBUG is on. Warnings, errors, and genuinely important
//     one-line notices print normally. So a normal run shows a handful of lines, not hundreds.
//   • DATED ROTATION with a SIZE CEILING: every captured line is also appended to
//     <logsDir>/YYYY-MM-DD.log, pruned after RETENTION_DAYS, so there is always a bounded on-disk
//     trail — even in a foreground terminal run where nothing redirects stdout. A single busy day
//     also can't grow one file without bound: past MAX_FILE_BYTES the day rolls to YYYY-MM-DD.N.log,
//     and retention prunes every generation alike. On by default; set "fileLogging": false in
//     config.json to keep everything in-memory only.
//   • NON-BLOCKING and BEST-EFFORT: the file write is a buffered append (Node buffers it), never
//     awaited on the hot path; every failure is swallowed so logging can never stall or crash a
//     caller. The only synchronous work is a once-a-day mkdir when the date rolls over.
//   • ONE REDACTION CHOKE POINT: console, ring, and file are all scrubbed by the same rules, so
//     a credential can never reach any of them whatever a caller passed.

const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const MAX_LINES = 2000;                 // recent console lines kept in memory for the viewer
const MAX_LINE_CHARS = 8192;            // bound one stored line so a huge object/stack can't bloat memory
const RETENTION_DAYS = 30;              // prune daily log files older than this
const MAX_FILE_BYTES = 100 * 1024 * 1024;    // roll one day's file to YYYY-MM-DD.N.log past this, so a chatty day can't grow one file without bound
const MAX_PENDING_BYTES = 4 * 1024 * 1024;   // slow-disk backpressure: drop lines rather than grow the buffer without bound
const WRITE_FAIL_COOLDOWN_MS = 30 * 1000;    // after a write error, stop touching the file this long (no per-line reopen storm)

const lines = [];
let installed = false;
let _origStdout = null;   // the real console.log, captured at install so gated lines can print without re-entering the wrap
let _origStderr = null;   // the real console.warn

const CONFIG_MODULE = require.resolve('./config');
// `config` logs a network-exposure warning while it is still evaluating, and the console wrapper below
// receives it. Reading a property off a partially initialized module triggers Node's circular-dependency
// warning, so wait until config has finished loading before consulting it. During load the defaults are
// "debug off, file logging on", matching a fresh install.
const configReady = () => {
  try { const m = require.cache[CONFIG_MODULE]; return !m || m.loaded !== false; } catch { return true; }
};
const isDebug = () => { try { if (!configReady()) return false; return !!require('./config').DEBUG; } catch { return false; } };
const fileEnabled = () => { try { if (!configReady()) return true; return require('./config').fileLogging !== false; } catch { return true; } };
const logsDir = () => path.join(os.homedir(), '.lokyni', 'logs');

// ── Secret redaction ─────────────────────────────────────────────────────────
// Credentials must never persist in logs — the viewer, the in-memory buffer, the daily files,
// and any service-manager file an operator might share all pass through here. A cheap trigger
// keeps the hot path free: the regexes only run on a line that could contain a secret.
const SECRET_TRIGGER = /key|token|secret|password|pass|bearer|authorization|cookie|:\/\/|sk-|lok_|aiza|hf_/i;
const REDACTIONS = [
  [/\b(bearer\s+)[\w.\-]+/gi, '$1***'],                                          // Authorization: Bearer <token>
  [/\b(basic\s+)[A-Za-z0-9+/=]+/gi, '$1***'],                                    // Authorization: Basic <base64 user:pass>
  [/\b((?:set-)?cookie:\s*)[^\r\n]+/gi, '$1***'],                                // Cookie / Set-Cookie header values
  [/\b(sk-)[A-Za-z0-9-]{16,}/g, '$1***'],                                        // OpenAI-style keys, incl. sk-proj-/sk-ant- (internal hyphens)
  [/\b(AIza)[0-9A-Za-z_\-]{20,}/g, '$1***'],                                     // Google / Gemini API keys
  [/\b(hf_)[A-Za-z0-9]{16,}\b/g, '$1***'],                                       // Hugging Face access tokens
  [/\b(lok_)[A-Za-z0-9_\-]{8,}\b/g, '$1***'],                                    // Lokyni API keys
  [/([a-z][a-z0-9+.\-]*:\/\/[^/\s:@]+:)[^/\s:@]+@/gi, '$1***@'],                 // user:pass@host in a URL
  [/([?&](?:api[_-]?key|apikey|access[_-]?token|token|key|password|secret|auth)=)[^&\s"']+/gi, '$1***'],   // ?token=… / ?key=… query params
  [/("?(?:password|passwd|pass|api[_-]?key|apikey|secret|token|authorization)"?\s*[:=]\s*"?)([^"\s,}]+)/gi, '$1***'],  // "password": "…" / pass=… / token=…
];
const redact = (text) => {
  if (!text || !SECRET_TRIGGER.test(text)) return text;
  let out = text;
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
  out = out.replace(/\*\*\*(?:\s+\*\*\*)+/g, '***');   // collapse adjacent masks left by overlapping rules
  return out;
};

// ── Daily-rotated, non-blocking file stream ──────────────────────────────────
let stream = null, streamDay = '', streamRoll = 0, dayBytes = 0;
let pendingBytes = 0;
let backpressured = false;
let writeFailUntil = 0;
let cleanInFlight = false;
const dayStamp = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

// Open the write stream for a given day and roll index. Roll 0 is `YYYY-MM-DD.log`; a size roll
// becomes `YYYY-MM-DD.N.log`. All generations share the date prefix so the same retention sweep prunes
// them. On a stream error (full disk, EACCES, the dir vanishing) it clears state and backs off, so the
// next write reopens cleanly instead of a per-line reopen storm.
const openLogStream = (dir, day, roll) => {
  const name = roll === 0 ? `${day}.log` : `${day}.${roll}.log`;
  const s = fs.createWriteStream(path.join(dir, name), { flags: 'a' });
  s.on('error', () => {
    try { s.destroy(); } catch (_) {}
    if (stream === s) { stream = null; streamDay = ''; }
    pendingBytes = 0; backpressured = false; writeFailUntil = Date.now() + WRITE_FAIL_COOLDOWN_MS;
  });
  s.on('drain', () => { backpressured = false; });
  return s;
};

const fileWrite = (line) => {
  if (!fileEnabled()) return;
  if (Date.now() < writeFailUntil) return;   // recent write error — back off rather than reopen/mkdir per line
  try {
    const dir = logsDir();
    const day = dayStamp(new Date());
    if (!stream || streamDay !== day) {
      if (stream) { try { stream.end(); } catch (_) {} }
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
      streamDay = day; streamRoll = 0; dayBytes = 0; pendingBytes = 0; backpressured = false;
      stream = openLogStream(dir, day, streamRoll);
      cleanOldLogs();   // prune on each date rollover (and first write of the process)
    }
    if (backpressured && pendingBytes > MAX_PENDING_BYTES) return;   // slow disk — drop rather than grow unbounded
    const chunk = `${line}\n`;
    const n = Buffer.byteLength(chunk, 'utf8');
    // Roll to a fresh numbered file once the current one hits the size cap, so a single busy day
    // (a large re-index, per-page OCR) can't grow one file without bound. Retention still prunes it.
    if (dayBytes + n > MAX_FILE_BYTES) {
      try { stream.end(); } catch (_) {}
      streamRoll += 1; dayBytes = 0; pendingBytes = 0; backpressured = false;
      stream = openLogStream(dir, day, streamRoll);
    }
    pendingBytes += n; dayBytes += n;
    const ok = stream.write(chunk, () => { pendingBytes -= n; if (pendingBytes < 0) pendingBytes = 0; });
    if (!ok) backpressured = true;
  } catch (_) { /* logging is best-effort — never throw into a caller */ }
};

async function cleanOldLogs() {
  if (cleanInFlight) return;
  cleanInFlight = true;
  try {
    const dir = logsDir();
    let files; try { files = await fsp.readdir(dir); } catch (_) { return; }
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const f of files) {
      if (!/^\d{4}-\d{2}-\d{2}(?:\.\d+)?\.log$/.test(f)) continue;   // only our own daily files, incl. size-rolled .N.log
      try { const st = await fsp.stat(path.join(dir, f)); if (st.mtimeMs < cutoff) await fsp.unlink(path.join(dir, f)); } catch (_) {}
    }
  } catch (_) {} finally { cleanInFlight = false; }
}

// Store one (already-redacted) block in the ring and the daily file. Splits on newlines so each
// stored entry is one line, matching how the viewer renders them.
const push = (stream_, text) => {
  for (const raw of String(text).split('\n')) {
    let line = raw.replace(/\s+$/, '');
    if (!line) continue;
    if (line.length > MAX_LINE_CHARS) line = line.slice(0, MAX_LINE_CHARS) + '…[truncated]';
    lines.push({ t: Date.now(), stream: stream_, line });
    fileWrite(line);
  }
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
};

// Wrap the console methods rather than process.stdout.write: anything that writes directly to the
// stream (the OCR stderr filter, for instance) isn't disturbed. Each call is formatted to one
// string, redacted once, then sent to the ring, the daily file, and the real stream — so a secret
// is scrubbed from the terminal, the viewer, and the file alike.
const install = () => {
  if (installed) return;
  installed = true;
  const wrap = (name, stream_) => {
    const original = console[name].bind(console);
    if (name === 'log') _origStdout = original;
    if (name === 'warn') _origStderr = original;
    console[name] = (...args) => {
      let text = null;
      try {
        text = redact(args.map(a =>
          typeof a === 'string' ? a
            : (a instanceof Error ? (a.stack || a.message) : require('util').inspect(a, { depth: 2 }))
        ).join(' '));
      } catch { /* never let logging break the caller */ }
      if (text != null) { push(stream_, text); original(text); }
      else { original(...args); }   // formatting failed (rare) — fall back to the raw args
    };
  };
  wrap('log',   'stdout');
  wrap('info',  'stdout');
  wrap('debug', 'stdout');   // console.debug defaults to stdout — capture it too so no server output escapes the in-app viewer
  wrap('warn',  'stderr');
  wrap('error', 'stderr');
  // Flush the tail on a graceful exit (exit handlers must be synchronous; end() flushes buffered data).
  try { process.once('exit', () => { try { if (stream) stream.end(); } catch (_) {} }); } catch (_) {}
  // Prune daily; unref so the timer never keeps the process alive.
  try { const t = setInterval(() => cleanOldLogs(), 24 * 60 * 60 * 1000); if (t.unref) t.unref(); } catch (_) {}
};

// Verbose, high-frequency diagnostics (indexing progress, routine startup notices). Always
// recorded to the ring and the daily file; printed to the CONSOLE only when DEBUG is on, so a
// normal long-running session doesn't spam the terminal. `progress` and `debug` differ only in
// intent (progress = per-item work; debug = one-time detail); both behave the same.
const emitGated = (text) => {
  const line = redact(String(text == null ? '' : text));
  push('stdout', line);
  if (isDebug()) { try { (_origStdout || console.log)(line); } catch (_) {} }
};
const debug = (text) => emitGated(text);
const progress = (text) => emitGated(text);

const recent = (limit = 400, stream_ = null) => {
  const filtered = stream_ ? lines.filter(l => l.stream === stream_) : lines;
  return filtered.slice(-limit);
};

module.exports = { install, recent, redact, debug, progress, cleanOldLogs, logsDir, RETENTION_DAYS };
