'use strict';

/*

  Lokyni — private document intelligence.
  Copyright (C) 2026 3CQS

  This program is free software: you can redistribute it and/or modify it under the terms of the
  GNU Affero General Public License as published by the Free Software Foundation, either version 3
  of the License, or (at your option) any later version.

  This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
  even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
  Affero General Public License for more details.

  You should have received a copy of the GNU Affero General Public License along with this program.
  If not, see <https://www.gnu.org/licenses/>. The full text is in the LICENSE file.

*/

// lokyni.js — the command-line entry point. Kept slim: it checks the runtime, routes the CLI commands,
// and (for the server path) registers orderly shutdown and starts the web server. All user-facing CLI
// text lives in lib/clihelp.js. Runtime flags are command-line arguments, not environment variables;
// `debug` is read directly from argv in lib/config.js (const DEBUG = process.argv.includes('debug')).

// Fail fast with a clear message on an unsupported Node. Lokyni's core dependencies — the HTTP client
// (undici) used for the SSRF-guarded, IP-pinned fetch path, plus the retrieval, LLM, mail, Markdown, and
// file-watching (chokidar 6) libraries — require Node 22.22 or newer. package.json engines only warns at
// install, so without this a too-old-Node user would hit a cryptic error deep in startup instead of here.
{
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 22)) {
    console.error(`\n❌ Lokyni requires Node.js 22.22 or newer (you are running ${process.version}).`);
    console.error('   Install a current LTS from https://nodejs.org and try again.\n');
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const has  = (...names) => names.some(n => args.includes(n));

// Show a friendly name in the OS process list (ps / top / htop, and the command column of
// macOS Activity Monitor) instead of the bare "node", so the running server is easy to spot
// and target. Cross-platform and free: on Windows it sets the console title. The columns
// that key off the executable's on-disk filename instead — macOS Activity Monitor's Process
// Name and the Windows Task Manager Details tab — can't be set by any runtime API; the
// background-service install covers those by launching through a Node binary renamed "lokyni"
// (see ensureBrandedNode in lib/service.js). The stdio MCP server gets its own name so it's
// distinguishable from the web server in a process list.
try { process.title = has('--mcp') ? 'lokyni-mcp' : 'lokyni'; } catch (_) { /* best-effort cosmetic */ }

// Prefer IPv4 for outbound DNS. Node resolves "verbatim" by default (Node 17+), which
// often tries a host's IPv6 address first; on a machine whose IPv6 routing is broken or
// flapping, that surfaces as confusing "fetch failed" errors for the only things Lokyni
// reaches over the network — web search, the one-time reranker model download, and URL
// ingestion — even though IPv4 works. This keeps IPv6 as a fallback (IPv6-only hosts still
// work). Must run before any network-using module loads. Override with `--dns-order
// verbatim` (or `ipv6first`).
try {
  let order = 'ipv4first';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dns-order' && args[i + 1]) order = String(args[i + 1]).toLowerCase();
    else if (args[i].startsWith('--dns-order=')) order = args[i].split('=')[1].toLowerCase();
  }
  if (['ipv4first', 'ipv6first', 'verbatim'].includes(order)) require('dns').setDefaultResultOrder(order);
} catch (_) { /* older Node without setDefaultResultOrder, or a bad value: keep the default */ }

// Never-orphan guard, armed as EARLY as possible for the desktop sidecar. The full graceful stdin watch below
// (in startServer) is only armed after startWebServer() and the heavy startup requires; if the Tauri launcher
// is killed during that startup window — macOS and Windows have no parent-death signal (only Linux PDEATHSIG) —
// a half-started sidecar would be orphaned, holding the data-dir instance lock and the port so the NEXT launch
// fails. This minimal guard covers exactly that window: on the launcher's stdin pipe closing (its EOF on ANY
// exit), exit immediately. The full handler removes it and takes over the graceful teardown once it arms.
let _earlyStdinBail = null;
if (!has('--no-exit-with-parent') && args.includes('--desktop') && !process.stdin.isTTY) {
  _earlyStdinBail = () => process.exit(0);
  process.stdin.on('end', _earlyStdinBail);
  process.stdin.on('close', _earlyStdinBail);
  process.stdin.resume();
}

// Ask a yes/no question on the terminal. Resolves true only if the user types
// "yes" (case-insensitive). Used to gate destructive/expensive commands.
const confirmPrompt = (question) => new Promise((resolve) => {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(question, (answer) => {
    rl.close();
    resolve(String(answer || '').trim().toLowerCase() === 'yes');
  });
});

// Service management commands run and exit without starting the server. Plain
// `node lokyni.js` (and `node lokyni.js debug`) behave exactly as before, and pm2
// is unaffected by any of this.
// Account recovery, run on the host by the operator (who already has filesystem access, so this adds no new
// trust and needs no email/SMTP). Usage:
//   node lokyni.js --reset-password <username> --password <new>
//   echo "<new>" | node lokyni.js --reset-password <username>     (keeps the password out of shell history)
// It hashes the new password, stores it, and revokes that user's existing sessions. Respects --data-dir.
const resetPasswordCli = async () => {
  const i = args.indexOf('--reset-password');
  const username = (args[i + 1] && !args[i + 1].startsWith('--')) ? args[i + 1] : '';
  if (!username) { console.error('Usage: node lokyni.js --reset-password <username> [--password <new>]'); process.exitCode = 1; return; }
  const cfg = require('./lib/config');
  const users = require('./lib/users');
  const accounts = require('./lib/accounts');
  const rec = users.getByUsername(cfg.DATA_DIR, username);
  if (!rec) {
    const known = users.list(cfg.DATA_DIR).map(u => u.username);
    console.error(`No user named "${username}".` + (known.length ? ` Known users: ${known.join(', ')}` : ' There are no accounts yet.'));
    process.exitCode = 1; return;
  }
  // Read the new password from --password, else from piped stdin, else prompt (interactive TTY).
  const pwIdx = args.indexOf('--password');
  let password = (pwIdx !== -1 && args[pwIdx + 1]) ? args[pwIdx + 1] : '';
  if (!password) {
    password = await new Promise((resolve) => {
      if (process.stdin.isTTY) process.stdout.write(`New password for "${username}": `);
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { data += c; });
      process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
      if (process.stdin.isTTY) process.stdin.on('data', (c) => { if (c.includes('\n')) { process.stdin.pause(); resolve(data.replace(/\r?\n$/, '')); } });
    });
  }
  try {
    await accounts.changePassword(cfg.DATA_DIR, rec.id, password);
    console.log(`✓ Password reset for "${username}". Their other sessions have been signed out.`);
  } catch (e) {
    console.error(`Could not reset the password: ${e.message || e}`);
    process.exitCode = 1;
  }
};

// Headless RAG-quality evaluation of a workspace's saved questions (for CI / automation / Docker). Reuses the
// SAME runEval the in-app dashboard uses, prints a plain-text report, and exits non-zero when it can't run.
// No web server, no PID file. Requires the model provider to be reachable (it answers + judges each question).
const runEvalCli = async () => {
  const i = args.indexOf('--eval');
  const next = args[i + 1];
  const workspaceArg = (next && !next.startsWith('-')) ? next : null;
  const { initIndex, runLifecycleExclusive } = require('./lib/indexing/init');
  try { await runLifecycleExclusive(() => initIndex()); }
  catch (e) { console.error(`Index build failed — cannot evaluate: ${e && e.message ? e.message : e}`); process.exitCode = 2; return; }
  const ws = workspaceArg || require('./lib/state').workspaceId;
  const evalx = require('./lib/eval');
  const { METRIC_KEYS, METRIC_LABELS: LABELS } = require('./lib/evalmetrics');
  const pct = (v) => (typeof v === 'number' && !Number.isNaN(v)) ? Math.round(v * 100) + '%' : 'n/a';
  const sign = (d) => (typeof d === 'number' && Math.abs(d) >= 0.005) ? ` (${d > 0 ? '+' : '−'}${Math.abs(Math.round(d * 100))} pts vs last run)` : '';
  let result;
  try { result = await evalx.runEval(ws); }
  catch (e) { console.error(`Evaluation failed: ${e && e.message ? e.message : e}`); process.exitCode = 2; return; }
  const { status, run } = result || {};
  if (status !== 'ok' || !run) {
    const msg = {
      'no-questions': `No saved evaluation questions for workspace "${ws}". Add some in Settings → Tools & data (or use "Suggest from my documents").`,
      'empty': `Workspace "${ws}" has no documents to evaluate.`,
      'warming': `Workspace "${ws}" is still preparing — try again shortly.`,
      'busy': `An evaluation is already running for workspace "${ws}".`,
    }[status] || `Could not evaluate workspace "${ws}" (${status || 'unknown'}).`;
    console.error(msg);
    process.exitCode = 1; return;
  }
  const lines = [`\nQuality evaluation — workspace "${ws}" — ${run.questionCount} question(s)`, 'Averages:'];
  for (const k of METRIC_KEYS) lines.push(`  ${LABELS[k] || k}: ${pct(run.averages[k])}${sign(run.delta && run.delta[k])}`);
  lines.push('\nPer question:');
  for (const q of run.questions || []) {
    const tag = q.status ? `[${q.status}]` : (q.outOfScope ? '[declined — out of scope]' : '[ok]');
    lines.push(`  ${tag} ${q.text}`);
    if (!q.status) {
      lines.push('        ' + METRIC_KEYS.map(k => `${(LABELS[k] || k).split(' ')[0]} ${pct(q.metrics && q.metrics[k])}`).join(' · '));
      const ca = q.citationAttribution;
      if (ca && ca.unused && ca.unused.length) lines.push(`        ${ca.unused.length} citation(s) supported no sentence: ${ca.unused.join(', ')}`);
      const det = q.detail || {};
      if (Array.isArray(det.claims) && det.claims.length) lines.push(`        ${det.claims.length} claim(s) not fully supported`);
      if (Array.isArray(det.figures) && det.figures.length) lines.push(`        ${det.figures.length} figure(s) not in the sources: ${det.figures.join(', ')}`);
      if (Array.isArray(det.quotes) && det.quotes.length) lines.push(`        ${det.quotes.length} quotation(s) not in the sources`);
    }
  }
  console.log(lines.join('\n'));
  // Exit 0 — the run completed. The scores are advisory trends, not a pass/fail gate.
};

const runServiceCommand = async () => {
  const svc = require('./lib/service');
  if (has('--install'))        svc.installService({
                                 inPlace:  has('--in-place'),
                                 relocate: has('--relocate'),
                                 noOpen:   has('--no-open'),
                               });
  else if (has('--uninstall')) svc.uninstallService();
  else if (has('--restart'))   svc.restartService();
  else if (has('--status'))    await svc.statusService();
  else if (has('--open'))      svc.openInBrowser();
};

const startServer = async ({ forceRebuild = false } = {}) => {
  // Capture console output in memory so the log viewer works even when Lokyni is
  // run from a terminal, where no service manager is redirecting output to a file.
  require('./lib/logbuffer').install();

  // Prove the data and configuration folders are writable before startup. A read-only bind mount or a
  // root-owned host folder otherwise fails later as a generic mkdir error, after the server has already
  // begun warming. The real write probe also catches a full volume; the guidance names the folder and the
  // container ownership fix.
  {
    const cfgEarly = require('./lib/config');
    const disk = require('./lib/disk');
    const path = require('path');
    const checks = [
      ['data directory', cfgEarly.DATA_DIR || './data'],
      ['configuration directory', path.dirname(cfgEarly.CONFIG_PATH)],
    ];
    for (const [label, dir] of checks) {
      const probe = disk.probeWritable(dir);
      if (probe.ok) continue;
      console.error(`\n❌ Lokyni cannot write to its ${label}: ${probe.path}`);
      if (probe.code === 'ENOSPC') console.error('   The volume is full. Free space or move the data directory.');
      else console.error('   Check the folder permissions and that it is not mounted read-only.');
      console.error('   Docker: use a named volume, or make a host folder writable by the container user (uid 1000 by default):');
      console.error('     sudo chown -R 1000:1000 <host-folder>');
      console.error('   Standalone: choose a writable location with --data-dir.');
      process.exit(1);
    }
  }

  // Warn about a nearly-full data volume before the first write fails. This is the failure that
  // otherwise surfaces later as a cryptic "ENOSPC: no space left on device" during indexing or a
  // backup. Best-effort and bounded: a slow mount must not delay startup, and an unmeasurable
  // volume stays quiet rather than guessing.
  try {
    const cfgEarly = require('./lib/config');
    const disk = require('./lib/disk');
    let timer;
    const free = await Promise.race([
      disk.freeBytesAsync(cfgEarly.DATA_DIR || './data'),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), 1500); if (timer.unref) timer.unref(); }),
    ]);
    if (timer) clearTimeout(timer);
    if (free != null && free < disk.LOW_DISK_BYTES) {
      const MB = 1024 * 1024;
      console.warn(`\n⚠️  Only ${Math.round(free / MB)} MB free on the volume holding ${cfgEarly.DATA_DIR || './data'}.`);
      console.warn('   Indexing, OCR caches, backups, and temporary uploads can fail or leave the index inconsistent.');
      console.warn('   Free space, or start with --data-dir pointing at a volume with room.\n');
    }
  } catch { /* observability only — never block startup */ }

  const { startWebServer } = require('./lib/server');
  const { initIndex, initIndexReadOnly, startReadOnlyRefresh, startWatcher, stopWatchers, runLifecycleExclusive, sweepOrphanVectors } = require('./lib/indexing/init');
  const { writePidFile, removePidFile } = require('./lib/service');
  const shutdown = require('./lib/shutdown');
  const state = require('./lib/state');
  let server;   // set by startWebServer() below; captured by the 'web server' teardown

  // Register every long-lived resource for orderly teardown on Ctrl-C / kill / crash,
  // then install the signal handlers. Order matters: stop taking new work first (close
  // the web server so no new query/index request arrives, stop the file watchers so no
  // new index run is triggered), let any in-flight index finish its write so the
  // on-disk cache isn't left truncated, THEN kill the workers, close browsers, and
  // flush caches. Each is loaded lazily and guarded so a missing optional dependency
  // (e.g. puppeteer) just skips that step.
  shutdown.register('web server', async () => {
    // Disconnects clients (clearing their per-connection status intervals) and stops accepting new connections,
    // so nothing new starts mid-teardown. io.close() closes the shared HTTP server too, so no separate
    // server.close() is needed. Drop IDLE keep-alive sockets first so the close does not sit waiting for them to
    // time out on their own — as the FIRST teardown step that could otherwise eat most of the shutdown budget and
    // starve the later worker/cache steps. A bounded safety net then force-drops anything still lingering, so this
    // step can never stall the rest of teardown. Both calls are guarded for an older runtime that lacks them.
    try { if (server && server.closeIdleConnections) server.closeIdleConnections(); } catch { /* skip */ }
    const t = setTimeout(() => { try { if (server && server.closeAllConnections) server.closeAllConnections(); } catch {} }, 1500);
    if (t && t.unref) t.unref();
    try { await require('./lib/socket').closeSocket(); } finally { clearTimeout(t); }
  });
  shutdown.register('file watchers', async () => { await stopWatchers(); });
  shutdown.register('quiesce indexing', async () => {
    // Wait out an in-progress delta so its FAISS/manifest writes complete rather than
    // being cut mid-file (the 8s hard cap still bounds this; a cut index self-heals to
    // a rebuild on next start, but finishing avoids that cost).
    if (state.indexPromise) { try { await state.indexPromise; } catch { /* it logs its own errors */ } }
  });
  shutdown.register('OCR workers', async () => {
    await require('./lib/ocr').releaseTesseract();
  });
  shutdown.register('reranker worker', async () => {
    require('./lib/retrieval/reranker').shutdownReranker();
  }, () => { try { require('./lib/retrieval/reranker').shutdownReranker(); } catch {} });
  shutdown.register('late-interaction worker', async () => {
    require('./lib/retrieval/colbert').shutdownColbert();
  }, () => { try { require('./lib/retrieval/colbert').shutdownColbert(); } catch {} });
  shutdown.register('local-embedder worker', async () => {
    require('./lib/retrieval/localembed').shutdown();
  }, () => { try { require('./lib/retrieval/localembed').shutdown(); } catch {} });
  shutdown.register('parse worker', async () => {
    require('./lib/indexing/parseworker').shutdownParseWorker();
  }, () => { try { require('./lib/indexing/parseworker').shutdownParseWorker(); } catch {} });
  shutdown.register('article-extract worker', async () => {
    require('./lib/articleextract').shutdown();
  }, () => { try { require('./lib/articleextract').shutdown(); } catch {} });
  shutdown.register('text-to-speech worker', async () => {
    require('./lib/voice/tts').shutdown();
  }, () => { try { require('./lib/voice/tts').shutdown(); } catch {} });
  shutdown.register('speech-to-text worker', async () => {
    require('./lib/voice/stt').shutdown();
  }, () => { try { require('./lib/voice/stt').shutdown(); } catch {} });
  shutdown.register('media-decode (ffmpeg) children', async () => {
    require('./lib/indexing/ffmpeg').killAll();
  }, () => { try { require('./lib/indexing/ffmpeg').killAll(); } catch {} });
  // Synchronous last-resort backstop (like the browser/parse children) so a hard exit can't orphan an ffmpeg decode.
  shutdown.onExitKill(() => { try { require('./lib/indexing/ffmpeg').killAll(); } catch { /* best-effort */ } });
  shutdown.register('URL-ingestion browsers', async () => {
    const urlfetch = require('./lib/urlfetch');
    await urlfetch.closeAllBrowsers();
    await urlfetch.sweepStaleProfiles();
  });
  // Unconditional backstop: force-kill any Chromium still open on ANY exit path (including an
  // abnormal exit or a graceful shutdown that timed out mid-close), so a browser can never orphan.
  shutdown.onExitKill(() => { try { require('./lib/urlfetch').killAllBrowsersSync(); } catch { /* best-effort */ } });
  // Same backstop for document-parse children: a child wedged in a synchronous native parse can't act on its
  // own self-guards, so SIGKILL any still-live parse child on every exit path — it can never orphan.
  shutdown.onExitKill(() => { try { require('./lib/indexing/extractprocess').killAllChildrenSync(); } catch { /* best-effort */ } });
  shutdown.register('MCP connectors', async () => {
    await require('./lib/mcp/client').closeAllConnectors();
  });
  // Same backstop for connector children: a connector server is an untrusted spawned process, so SIGKILL any
  // still-live one on every exit path (abrupt exit, or a graceful shutdown that timed out mid-sync).
  shutdown.onExitKill(() => { try { require('./lib/mcp/client').killAllConnectorsSync(); } catch { /* best-effort */ } });
  shutdown.register(
    'OCR cache flush',
    async () => { require('./lib/ocrcache').flush(); },
    // Sync fallback for the 'exit' path — flushing is a synchronous writeFileSync,
    // so it works even when the event loop is already stopping.
    () => { require('./lib/ocrcache').flush(); },
  );
  shutdown.register(
    'contextual-retrieval cache flush',
    async () => { require('./lib/indexing/context').flush(); },
    () => { try { require('./lib/indexing/context').flush(); } catch {} },
  );
  shutdown.register('scheduled automations', async () => { require('./lib/automations').stopAll(); },
                                              () => { try { require('./lib/automations').stopAll(); } catch {} });
  shutdown.register('pid file', async () => { removePidFile(); }, () => { removePidFile(); });
  shutdown.install();

  // Refuse to run a second instance against the SAME data directory. The port bind (EADDRINUSE) only stops
  // a second copy on the same port; two instances on the same data dir with different ports, a service plus
  // a manual run, or a shutdown/startup race would otherwise all write the same files at once and corrupt
  // shared state — most visibly the tamper-evident audit log's sealed chain, but also sessions and index
  // caches. The lock is stale-tolerant (a crashed instance's lock is taken over) and fail-open (any lock
  // error lets startup proceed). `--no-instance-lock` is an escape hatch for the rare intentional case.
  // In cluster mode a READ REPLICA coexists with the primary over a shared data dir, so it skips the
  // exclusive single-instance lock. The PRIMARY (and a normal single node) still takes it — which also
  // prevents a second primary from starting and creating two writers against the shared index.
  if (!has('--no-instance-lock') && !require('./lib/cluster').isReplica()) {
    const { APP_NAME } = require('./lib/constants');
    // Wait a little longer than the graceful-shutdown hard cap, so a slow teardown of a previous instance
    // (up to that cap) still hands off cleanly instead of this one refusing.
    const lock = await require('./lib/instancelock').acquire(require('./lib/config').DATA_DIR, { waitMs: shutdown.HARD_TIMEOUT_MS + 4000 });
    if (!lock.ok) {
      console.error(`\n✖ Another copy of ${APP_NAME} is already running against this data directory`);
      console.error(`  (process ${lock.holder && lock.holder.pid} on ${lock.holder && lock.holder.host}).`);
      console.error('  Running two at once would corrupt the shared index, sessions, and audit log.');
      console.error('  Stop the other copy first, or start this one with a separate data directory.');
      console.error('  If you are certain no other copy is running, start again with --no-instance-lock.\n');
      process.exit(1);
    }
    // Release the lock on EVERY exit path, including a force-exit after the shutdown hard cap. onExitKill
    // runs unconditionally on 'exit'; release() is idempotent and only deletes our own lock, so running it
    // here (rather than as an ordered async step that a timed-out shutdown could skip) guarantees a clean
    // handoff. A crash that skips 'exit' entirely just leaves a stale lock the next start takes over.
    shutdown.onExitKill(() => { try { lock.release(); } catch {} });
  }

  // Record the pid so --status / --restart can find this process regardless of how
  // it was started (foreground, pm2, launchd, systemd, or scheduled task).
  writePidFile();
  server = startWebServer();

  // Exit when our LAUNCHER goes away, so no start is ever left orphaned — holding the port and data
  // directory and, with several stacked up, corrupting the tamper-evident audit log through concurrent
  // writes. An EOF on our end of stdin means the parent's end of the pipe/socket closed, which the OS
  // does on ANY exit of that parent (normal, crash, Force Quit, SIGKILL, Windows "End Task") on every
  // platform — so we shut down cleanly instead of lingering. This covers the desktop sidecar AND any
  // other supervised start (a test harness, a background boot whose parent holds the pipe), while never
  // touching an interactive terminal, a pm2/fork-managed process, or a real service on /dev/null — see
  // lib/supervise for the exact rule and why each is excluded. `--no-exit-with-parent` opts out for an
  // unusual launch that trips the heuristic. A literal "quit" line is the desktop app's cooperative stop
  // channel (used on Windows, where a windowless child has no SIGTERM to honor).
  //
  // It MUST be armed BEFORE the (possibly long or wedged) index build below: if it were armed after
  // `await initIndex()` and a rebuild stalled — e.g. a chat model chosen as the embeddings model, which
  // can't embed — the watch would never start, and the launcher going away would leave us orphaned.
  const supervise = require('./lib/supervise');
  const exitWithParent = !has('--no-exit-with-parent') && (
    (args.includes('--desktop') && !process.stdin.isTTY) ||
    supervise.exitsWithParent({ isTTY: process.stdin.isTTY, hasIpc: Boolean(process.send), kind: supervise.stdinKind() })
  );
  if (exitWithParent) {
    // Hand off from the early startup-window guard (above): remove its blunt process.exit listeners so the
    // graceful teardown below owns the parent-death path from here on.
    if (_earlyStdinBail) { process.stdin.removeListener('end', _earlyStdinBail); process.stdin.removeListener('close', _earlyStdinBail); _earlyStdinBail = null; }
    // Run the real graceful teardown (cache flushes, worker cleanup, pid removal) on EVERY platform,
    // bounded by shutdown.js's hard timeout. Going through process.kill(SIGTERM) would work on Unix
    // but on Windows maps to an abrupt TerminateProcess that runs no shutdown handler — so the
    // end-of-session cache flushes would be lost and workers left dangling on a normal quit.
    const stop = () => { try { shutdown.gracefulExit('desktop stop', 0); } catch { process.exit(0); } };
    // Decode stdin as UTF-8 at the stream level so its StringDecoder spans chunk boundaries — a drag-drop "ingest"
    // line can carry non-ASCII paths (accented or CJK filenames), and a multi-byte character split across two pipe
    // reads would otherwise decode to U+FFFD on each half and corrupt that path (the file would then silently fail
    // to ingest). "quit" is pure ASCII, so the cooperative stop is unaffected either way.
    try { process.stdin.setEncoding('utf8'); } catch { /* fall back to default decoding */ }
    let buf = '';
    process.stdin.on('data', (d) => {
      buf += String(d);
      // Match a whole LINE, buffered across chunks so a split delivery ("qu" + "it\n") still triggers and a stray
      // byte can't mis-fire it. Two commands from the desktop shell: a bare "quit" (cooperative stop), and
      // "ingest\t<abs path>\t<abs path>…" (files dropped on the window — copy them into the active workspace and
      // reindex). Drops are handled HERE, over this private pipe, because recent WebKitGTK no longer exposes
      // dropped files to the webview's HTML5 dataTransfer on Linux. Fire-and-forget: a bad drop must never affect
      // the stdin watch or the server.
      let nl; while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (line.trim() === 'quit') return stop();
        if (line.startsWith('ingest\t')) {
          const paths = line.slice('ingest\t'.length).split('\t').filter(Boolean);
          try { require('./lib/desktopdrop').ingestLocalPaths(paths).catch(() => {}); } catch {}
        }
      }
      // Bounded so stray input without a newline can't grow the buffer without limit, but generous enough to
      // hold ONE ingest line carrying a large multi-file drop (a selection of hundreds of files tab-joined). A
      // "quit" line is tiny; a 1 MB ceiling fits several thousand absolute paths, far past any real drag-drop,
      // while still capping a pathological stream. The tail keeps a partially received final line intact.
      if (buf.length > 1048576) buf = buf.slice(-1048576);
    });
    process.stdin.on('end', stop);        // the app's pipe end closed — it exited by some means
    process.stdin.on('error', () => {});  // a broken stdin pipe must never crash the long-running server
    process.stdin.resume();
    shutdown.register('stdin watch', async () => { try { process.stdin.pause(); } catch {} }, () => { try { process.stdin.pause(); } catch {} });
  }

  // Pre-flight: warn (don't block) if Ollama is unreachable or configured models
  // aren't pulled, so a first-time user gets a clear heads-up up front instead of a
  // confusing failure mid-question. Fire-and-forget — never delays startup.
  require('./lib/preflight').runPreflight();
  // Scheduled automations run in this long-lived server process; start() schedules
  // them after a short delay so the index finishes warming first.
  require('./lib/automations').start();
  // The web server is already listening and the UI/socket path degrades gracefully when
  // the index isn't ready ("still building…"), so an index-build failure must NOT take
  // the whole server down. Log it and stay up; the file watcher and manual rebuild can
  // recover it without a restart.
  const cluster = require('./lib/cluster');
  if (cluster.isReplica()) {
    // READ REPLICA: never build or mutate the shared index — the primary owns all writes. Load the active
    // workspace read-only and poll for the primary's updates (picked up via the manifest mtime). No watcher,
    // no delta, no reindex. This is what lets several replicas serve reads over one shared data directory.
    console.log('🧩 Cluster read replica — serving the shared index read-only (writes go to the primary).');
    try { await initIndexReadOnly(); } catch (e) { console.error(`⚠️  Replica index load failed (will retry): ${e && e.message ? e.message : e}`); }
    const refreshTimer = startReadOnlyRefresh();
    shutdown.register('replica refresh', () => { try { clearInterval(refreshTimer); } catch {} });
  } else {
    try {
      // Run the boot build THROUGH the lifecycle lock. The web server is already listening (and scheduled
      // automations have started), so a workspace switch, a manual rebuild, or a document upload can arrive
      // while this cold build is still warming — and those lifecycle ops only coordinate with each other via
      // this lock. Enrolling the boot build here makes any such op queue behind it instead of racing a
      // half-loaded index into the wrong workspace's directory. (initIndex itself is NOT lock-wrapped — a
      // switch calls it while already holding the lock — so wrapping only the top-level boot call is correct.)
      await runLifecycleExclusive(() => initIndex({ forceRebuild }));
    } catch (e) {
      console.error(`⚠️  Index build failed at startup — the server is up but search may be degraded until it recovers: ${e && e.message ? e.message : e}`);
    }
  }
  // Arm the file watchers only AFTER initIndex has resolved the active workspace. initIndex reopens
  // the workspace the user was last in (which may not be the default), and the watcher's watched
  // directories (DOCS_DIR / SOURCE_PATHS) are live getters keyed off that active workspace — so
  // arming it earlier would bind chokidar to the DEFAULT workspace's folders and silently miss every
  // change in the one actually loaded. The initial build already scanned everything, so nothing is
  // lost by starting the watch here; run it even if the build above failed, so a manual recovery still
  // gets real-time indexing. (The stdin exit-with-parent watch above, which prevents orphans, must
  // stay before the build and is unaffected.) A read replica never watches/indexes — the primary does.
  if (!cluster.isReplica()) startWatcher();
  // Reclaim any orphaned vectors a deleted document left behind in the active index (the single index, or
  // the active embedding bank — see sweepOrphanVectors). One-shot, background, primary only, serialized
  // through the lifecycle lock — it never blocks boot and never re-embeds. A replica must never write the
  // shared index, so it is skipped here and guarded again inside the sweep.
  if (!cluster.isReplica()) { sweepOrphanVectors().catch(() => {}); }
  // Boot-integrity self-checks (warn-only). Fire-and-forget after the index settles so a
  // check can compare the built index against config; a finding is logged, never fatal.
  require('./lib/watchdog').run({ audit: true }).catch(() => {});
  // Re-run the sweep periodically. Lokyni is a long-running service, so some findings only
  // appear after boot — a disk that fills, an audit log tampered with, an automation whose
  // cron drifts. Unref'd so it never holds the process open; cleared on shutdown.
  const watchdogTimer = setInterval(
    () => { require('./lib/watchdog').run({ audit: true }).catch(() => {}); },
    6 * 60 * 60 * 1000,
  );
  watchdogTimer.unref();
  shutdown.register('watchdog timer', async () => { clearInterval(watchdogTimer); try { require('./lib/watchdog').stop(); } catch {} }, () => clearInterval(watchdogTimer));

  // Actively sweep expired auth-session files so a user who signs in once and never returns doesn't leave a
  // stale credential-hash file forever (lazy expiry only reaps a session that is looked up again). Unref'd so
  // it never holds the process open; the per-file deletes are idempotent, so it is safe on every node of a
  // shared-data-dir cluster. Runs on every deployment mode (single-user too — a cheap no-op when empty).
  try {
    const pruneTimer = require('./lib/authsessions').startPrune(require('./lib/config').DATA_DIR);
    shutdown.register('session prune', async () => { clearInterval(pruneTimer); }, () => clearInterval(pruneTimer));
  } catch (_) { /* session prune is best-effort */ }

  // Bound the supervisor-written log files so a long-running install can't fill the disk. When
  // run under pm2, launchd, or systemd, stdout/stderr are redirected into these files and
  // nothing rotates them; the cap copies one prior generation aside and truncates in place
  // (see lib/logcap.js). A no-op when run from a terminal (the files don't exist). The desktop
  // app uses its own rotated log instead, so these are simply absent there.
  try {
    const { LOG_PATH, ERR_PATH } = require('./lib/service');
    const LOG_MAX_BYTES = 10 * 1024 * 1024;   // ~10 MB each, plus one retained .1 generation
    const capLogs = () => require('./lib/logcap').capFiles([LOG_PATH, ERR_PATH], LOG_MAX_BYTES).catch(() => {});
    capLogs();   // once at boot
    const logCapTimer = setInterval(capLogs, 30 * 60 * 1000);
    logCapTimer.unref();
    shutdown.register('log cap timer', async () => { clearInterval(logCapTimer); }, () => clearInterval(logCapTimer));
  } catch (_) { /* logging cap is best-effort */ }
};

(async () => {
  try {
    if (has('--help', '-h')) { console.log(require('./lib/cli').helpText()); return; }
    if (has('--reset-password')) { await resetPasswordCli(); return; }
    if (has('--mcp')) {
      // MCP server over stdio (for Claude Desktop / Cursor / agents). stdout is the
      // protocol channel and must carry ONLY MCP JSON-RPC, so redirect all console
      // logging to stderr first — otherwise the index's startup logs would corrupt
      // the stream. No web server, no PID file.
      // Redirect EVERY console method that defaults to stdout — log, info, AND debug — to stderr. Missing
      // console.debug would let a stray debug line (ours or a dependency's) write non-JSON to stdout and
      // corrupt the MCP stream. warn/error/trace already go to stderr.
      console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
      console.info = console.log;
      console.debug = console.log;
      const { initIndex, runLifecycleExclusive } = require('./lib/indexing/init');
      // Degrade, don't die — same invariant as the web path: an index-build failure (a cold start
      // with documents present while the embeddings provider is unreachable, a native-module load
      // error) must not abort the MCP server. Log to stderr (stdout is the protocol channel) and
      // still serve; the tools return "still building"/empty until the index recovers.
      try {
        // Through the lifecycle lock, matching the web path, so any later lifecycle op serializes behind it.
        await runLifecycleExclusive(() => initIndex());
      } catch (e) {
        console.error(`⚠️  Index build failed at startup — MCP is up but search may be degraded until it recovers: ${e && e.message ? e.message : e}`);
      }
      await require('./lib/mcp/server').runStdio();
      return;   // stays alive on the stdio transport
    }
    if (has('--eval')) { await runEvalCli(); return; }
    if (has('--install', '--uninstall', '--restart', '--status', '--open')) {
      await runServiceCommand();
      return;
    }
    // --reindex wipes the vector store and rebuilds from documents, then runs
    // normally. Use it when the index's internal ids have drifted from the current
    // document paths (e.g. the documents directory moved). Because it re-reads and
    // re-OCRs the ENTIRE library (slow, and easy to trigger by accident), confirm
    // first — unless --yes is passed or there's no interactive terminal.
    if (has('--reindex')) {
      const skipPrompt = has('--yes', '-y') || !process.stdin.isTTY;
      if (!skipPrompt) {
        const ok = await confirmPrompt(require('./lib/cli').reindexConfirm());
        if (!ok) { console.log('Aborted — index left unchanged.'); return; }
      }
    }
    await startServer({ forceRebuild: has('--reindex') });
  } catch (error) {
    if (error && error.code === 'ENOSPC') {
      let dataDir = './data';
      try { dataDir = require('./lib/config').DATA_DIR || dataDir; } catch { /* config may be the thing that failed */ }
      console.error('\n❌ Lokyni could not start because the disk holding its data is full.');
      console.error(`   Data directory: ${dataDir}`);
      console.error('   Free space on that volume, or start with --data-dir pointing at one with room.');
      console.error('   Docker: the storage backing /state is full — free space or recreate the volume.\n');
    } else {
      console.error('Failed to initialize:', error && error.message ? error.message : error);
    }
    process.exit(1);
  }
})();
