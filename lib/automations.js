'use strict';
// Scheduled automations & proactive digests — flips Lokyni from pull to push. A saved
// per-workspace job runs on a cron schedule and delivers its result to an in-app inbox
// (and optionally email). The scheduler design:
//   - a start() with a delayed initial pass so the index/server finish coming up first;
//   - one cron.schedule per enabled job;
//   - every job body wrapped so a failure can never crash the process;
//   - idempotent result-hash dedup so a "what changed" digest doesn't re-notify when
//     nothing changed;
//   - a pluggable delivery sink (in-app inbox by default; optional email).
//
// node-cron is guard-loaded (like the MCP SDK) so a missing dependency disables the
// feature with a log rather than breaking startup.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const wsm = require('./workspaces');

let cron = null;
try { cron = require('node-cron'); } catch { /* disabled — reported in start() */ }

// Scheduled jobs run model work (synthesis / grounded query) exactly like the API, so they must draw from
// the SAME process-wide generation gate — otherwise several jobs firing at once (e.g. every workspace's
// 8:00 digest) would run unbounded concurrent generations and saturate the single local model, starving
// the UI. And a still-running job must never be re-entered by its own next cron fire, or a slow job on a
// frequent schedule would pile up. _running holds the keys of jobs currently executing.
const genGate = require('./gengate');
const _running = new Set();

const cronAvailable = () => !!cron;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ── Job registry (per-workspace, in workspace settings — exactly like connectors) ──
const list = (workspaceId) => {
  const s = wsm.loadSettings(cfg.DATA_DIR, workspaceId) || {};
  return Array.isArray(s.automations) ? s.automations : [];
};
// Enabled automations across all workspaces whose cron no longer validates — a hand-edit or
// a node-cron version change leaves them silently un-armed (`scheduleWorkspace` skips an
// invalid cron), so they never fire again. Used by the boot watchdog. Returns [] when cron
// isn't available (can't judge) or nothing is wrong; never throws.
// How many automations are enabled across all workspaces, regardless of whether node-cron loaded.
// invalidSchedules() short-circuits to [] when cron is unavailable, so it can't distinguish "no
// automations" from "cron missing, so nothing can be armed"; the boot watchdog uses this to surface the
// latter (enabled automations that will never fire because the scheduler dependency didn't load).
const enabledCount = () => {
  let n = 0;
  try {
    for (const ws of wsm.loadRegistry(cfg.DATA_DIR)) {
      for (const rec of list(ws.id)) if (rec && rec.enabled) n += 1;
    }
  } catch (e) { /* best-effort */ }
  return n;
};

const invalidSchedules = () => {
  if (!cron) return [];
  const out = [];
  try {
    for (const ws of wsm.loadRegistry(cfg.DATA_DIR)) {
      for (const rec of list(ws.id)) {
        // Mirror scheduleWorkspace's arm condition (truthy `enabled`), so this flags exactly
        // the automations the scheduler would try to run — not ones it already treats as off.
        if (rec && rec.enabled && (!cron.validate(String(rec.schedule || '')) || isTooFrequent(rec.schedule))) {
          out.push({ workspace: ws.id, name: rec.name || rec.id, schedule: rec.schedule });
        }
      }
    }
  } catch (e) { /* best-effort */ }
  return out;
};

const saveList = (workspaceId, automations) => {
  const s = wsm.loadSettings(cfg.DATA_DIR, workspaceId) || {};
  s.automations = automations;
  wsm.saveSettings(cfg.DATA_DIR, workspaceId, s);
};

const KINDS = new Set(['query', 'digest']);

// A per-workspace cap. Every automation can carry a small evidence snapshot and schedules model work on a
// shared budget, so an unbounded list would both bloat the workspace settings and allow a flood of timer work.
const MAX_AUTOMATIONS = 50;

const add = (workspaceId, def = {}) => {
  if (list(workspaceId).length >= MAX_AUTOMATIONS) {
    throw new Error(`A workspace can have at most ${MAX_AUTOMATIONS} automations. Remove one before adding another.`);
  }
  const kind = KINDS.has(def.kind) ? def.kind : 'query';
  const schedule = String(def.schedule || '').trim();
  if (!schedule) throw new Error('Automation needs a schedule (a cron expression, e.g. "0 8 * * 1").');
  if (cron && !cron.validate(schedule)) throw new Error(`Invalid cron schedule: "${schedule}".`);
  // Refuse a per-second (6-field) schedule: an automation runs model work that takes seconds to minutes,
  // so a per-second cadence can only waste cycles firing checks. Minute granularity (5 fields) is the
  // finest we allow; a still-running job is skipped by the in-flight guard, so a frequent minute schedule
  // is safe even if each run outlasts its interval.
  if (isTooFrequent(schedule)) throw new Error('Schedule is too frequent — use minute granularity (five cron fields), not seconds.');
  if (kind === 'query' && !String(def.query || '').trim()) throw new Error('A query automation needs a question.');
  const email = def.delivery && def.delivery.email ? String(def.delivery.email).trim() : '';
  // Validate the delivery address at SAVE time rather than letting a typo persist and turn into a silent
  // per-fire delivery failure on a scheduled job. A simple, length-bounded check (one @, a dotted domain, no
  // whitespace) — nodemailer does the strict parsing at send, this just catches obvious mistakes early.
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new Error(`"${email}" does not look like a valid email address.`);
  }
  const rec = {
    id: 'a_' + crypto.randomBytes(4).toString('hex'),
    name: String(def.name || def.query || (kind === 'digest' ? 'Workspace digest' : 'Automation')).slice(0, 80),
    kind,
    schedule,
    query: String(def.query || '').trim(),
    delivery: email ? { inbox: true, email } : { inbox: true },
    enabled: def.enabled !== false,
    created: Date.now(),
    lastRun: null,
    lastResult: null,
    lastResultHash: null,
  };
  const all = list(workspaceId);
  all.push(rec);
  saveList(workspaceId, all);
  scheduleWorkspace(workspaceId);
  return rec;
};

const remove = (workspaceId, id) => {
  const all = list(workspaceId);
  const next = all.filter(a => a.id !== id);
  if (next.length === all.length) return false;
  saveList(workspaceId, next);
  scheduleWorkspace(workspaceId);
  return true;
};

const setEnabled = (workspaceId, id, enabled) => {
  const all = list(workspaceId);
  const rec = all.find(a => a.id === id);
  if (!rec) return false;
  rec.enabled = !!enabled;
  saveList(workspaceId, all);
  scheduleWorkspace(workspaceId);
  return true;
};

// ── Execution ──────────────────────────────────────────────────────────────────

// A stable fingerprint of a workspace's document set (ids + names + sizes). Lets a
// "digest" job skip delivery when the corpus hasn't changed since the last run, so a
// scheduled overview only notifies when there's actually something new.
async function corpusFingerprint(workspaceId) {
  try {
    // listDocuments paginates (default 100, max 1000 per page). Page through the WHOLE corpus — fingerprinting
    // only the first page made a scheduled digest blind to any add/remove/change past that page, so it would
    // silently report "corpus unchanged" and never notify on a large workspace. Include the total count too,
    // so an add/remove is caught even at the page boundary. Return null if the workspace can't be read cleanly
    // (e.g. still warming), so a partial read is never mistaken for "unchanged".
    const apiCore = require('./api-core');
    const parts = [];
    let offset = 0, total = 0;
    do {
      const r = await apiCore.listDocuments(workspaceId, { limit: 1000, offset });
      if (!r || r.status !== 'ok') return null;
      total = r.total || 0;
      const docs = r.documents || [];
      for (const d of docs) parts.push(`${d.docId}:${d.name}:${d.size}`);
      if (docs.length === 0) break;   // no progress — avoid an infinite loop
      offset += docs.length;
    } while (offset < total);
    return sha256(`${total}|${parts.sort().join('|')}`);
  } catch { return null; }
}

const drain = async (stream, signal) => { let s = ''; if (stream) for await (const c of stream) { if (signal && signal.aborted) break; s += c; } return s; };

// A wall-clock ceiling for ONE scheduled generation. The model's own idle timeout unwinds a dead stream, but a
// provider that trickles one token just under that idle bound indefinitely would hold a shared generation-gate
// slot forever (max 4) and could starve the UI/API. This hard ceiling aborts such a run so the slot is always
// released. Generous, so a legitimately long synthesis/answer finishes well within it.
const SCHED_RUN_MAX_MS = 5 * 60 * 1000;
const withSchedDeadline = async (fn) => {
  const ac = new AbortController();
  let t;
  // Race the work against a real deadline, not just a cooperative abort: the abort cancels a signal-honoring
  // model/retrieval call (the common path), but a step that ignores the signal would otherwise hang the await and
  // hold the run's in-flight slot forever. The race guarantees the outer promise settles at the ceiling either
  // way, so the slot is always released — mirroring the watchdog's _withTimeout.
  const deadline = new Promise((_, reject) => {
    t = setTimeout(() => {
      try { ac.abort(); } catch (e) { /* already aborted */ }
      reject(new Error(`scheduled run exceeded ${Math.round(SCHED_RUN_MAX_MS / 1000)}s and was stopped`));
    }, SCHED_RUN_MAX_MS);
    if (t && t.unref) t.unref();
  });
  try { return await Promise.race([fn(ac.signal), deadline]); }
  finally { clearTimeout(t); }
};

// Produce and deliver the job's result. Returns { delivered, changed, hash, note? }.
async function executeJob(workspaceId, rec, opts = {}) {
  const apiCore = require('./api-core');

  if (rec.kind === 'digest') {
    const fp = await corpusFingerprint(workspaceId);
    // Scheduled run + unchanged corpus → skip quietly. A manual "run now" always runs.
    if (!opts.manual && fp && rec.lastResultHash && fp === rec.lastResultHash) {
      return { delivered: false, changed: false, hash: fp, note: 'corpus unchanged' };
    }
    // Run the model work (synthesis + drain) inside the shared generation gate so it counts against the
    // one global concurrency budget the API and MCP also use, rather than adding uncapped load.
    const { r, body } = await withSchedDeadline((signal) => genGate.run(async () => {
      const r = await apiCore.runWorkspaceSynthesis(workspaceId, '', null, 'overview', signal);
      // Apply the same always-on answer safeguard the chat/API/MCP egress paths do (strip exfil vectors,
      // decline a system-prompt leak, correct a stated arithmetic slip). Without it, a scheduled digest emailed
      // or dropped in the inbox would be a weaker egress than every other surface — see the parity rule.
      return { r, body: r.status === 'ok' ? require('./verify').finalize(await drain(r.stream, signal)) : '' };
    }));
    if (r.status === 'warming') return { delivered: false, changed: false, note: 'warming' };
    if (r.status === 'empty')   return { delivered: false, changed: false, hash: fp, note: 'empty workspace' };
    const delivered = await deliver(workspaceId, rec, { title: rec.name, body, sources: [] });
    return { delivered, changed: true, hash: fp };
  }

  // kind 'query' — run the saved question through the same grounded path the API uses, inside the shared
  // generation gate (see the digest branch).
  const { r, body } = await withSchedDeadline((signal) => genGate.run(async () => {
    const r = await apiCore.runGroundedChat(workspaceId, [{ role: 'user', content: rec.query }], { signal });
    // Full grounded-answer finalize (verify pass + invented-citation + numeric-grounding caveats), the exact
    // sequence the chat/API/MCP egress applies — so a scheduled query emailed or dropped in the inbox is never
    // a weaker egress than any interactive surface. Shared via lib/answerfinalize.js.
    return { r, body: r.status === 'ok' ? require('./answerfinalize').finalizeGrounded(await drain(r.stream, signal), r.sources || [], r.idx) : '' };
  }));
  if (r.status === 'warming') return { delivered: false, changed: false, note: 'warming' };
  if (r.status === 'empty')   return { delivered: false, changed: false, note: 'empty workspace' };
  const sources = (r.sources || []).map(s => s.source).filter(Boolean);
  const hash = sha256(body);
  const changed = hash !== rec.lastResultHash;
  // Opt-in change-gating for a query automation: with delivery.onlyWhenChanged set, a scheduled run whose answer
  // is identical to the last one does NOT re-deliver (no duplicate inbox item, and crucially no duplicate email
  // on a frequent schedule). The default stays "deliver every run" (the "give me the answer each time" model); a
  // manual "run now" always delivers. The hash is still returned so lastResultHash tracks the latest answer.
  if (rec.delivery && rec.delivery.onlyWhenChanged && !changed && !opts.manual) {
    return { delivered: false, changed: false, hash };
  }
  // Evidence snapshot/diff: record what this run cited (identity + content digest) and compare it with the
  // previous run, so a scheduled question reports what is new, gone, or changed instead of repeating a wall
  // of text. The note is prepended to the delivered body only; the change hash stays the answer's own, so
  // change-gating is not affected by it. Bounded (lib/evidence). A first run has nothing to compare → no note.
  const evidence = require('./evidence');
  const snap = evidence.snapshot(r.sources || [], r.idx, body);
  const d = evidence.diff(rec.evidenceSnapshot, snap);
  const delivered = await deliver(workspaceId, rec, { title: rec.name, body: evidence.note(d) + body, sources });
  return { delivered, changed, hash, snapshot: snap };
}

// Run one automation now (used by both the cron trigger and the "run now" button) and
// persist its outcome. Never throws — a failing job records the error and moves on.
async function runNow(workspaceId, id, opts = {}) {
  const rec = list(workspaceId).find(a => a.id === id);
  if (!rec) return { ok: false, error: 'No such automation' };
  // Skip if this job is already running (its previous fire hasn't finished). node-cron does not skip
  // overlapping fires, so without this a job whose run outlasts its interval would pile up — several copies
  // queued on the model at once, growing memory. A skip is not a failure, so it does not overwrite lastResult.
  const runKey = `${workspaceId}:${id}`;
  if (_running.has(runKey)) return { ok: false, skipped: true, note: 'already running' };
  _running.add(runKey);
  // Persist the outcome through a fresh read-modify-write: executeJob can take tens of
  // seconds, and writing back the array we read at entry would clobber any automation
  // added/removed meanwhile. Patch only this record's own fields onto current state.
  const patch = (fields) => wsm.updateSettings(cfg.DATA_DIR, workspaceId, (s) => {
    const live = Array.isArray(s.automations) && s.automations.find(a => a.id === id);
    if (live) Object.assign(live, fields);
    return s;
  });
  try {
    const result = await executeJob(workspaceId, rec, opts);
    patch({
      lastRun: Date.now(),
      lastResult: { ok: true, delivered: result.delivered, changed: result.changed, note: result.note || null },
      ...(result.hash ? { lastResultHash: result.hash } : {}),
      ...(result.snapshot ? { evidenceSnapshot: result.snapshot } : {}),
    });
    return { ok: true, ...result };
  } catch (e) {
    // Transient backpressure (the shared generation gate was saturated) is not a job failure — record it
    // as a skip so a busy moment doesn't show up as a broken automation in the UI. It runs on its next fire.
    if (e && e.backpressure) return { ok: false, skipped: true, note: 'busy' };
    patch({ lastRun: Date.now(), lastResult: { ok: false, error: e.message } });
    return { ok: false, error: e.message };
  } finally {
    _running.delete(runKey);
  }
}

// ── Delivery sink (in-app inbox always; email when configured) ───────────────────
// Bound a single result's stored/sent body. The model answer is already token-bounded, but nothing else caps
// it, so a digest over a large corpus plus the 200-item inbox (and an unbounded email) could grow large. Cap
// defensively with a visible truncation note.
const MAX_RESULT_CHARS = 100000;   // ~100 KB per item
async function deliver(workspaceId, rec, payload) {
  const rawBody = typeof payload.body === 'string' ? payload.body : '';
  const body = rawBody.length > MAX_RESULT_CHARS ? rawBody.slice(0, MAX_RESULT_CHARS) + '\n\n[...truncated]' : rawBody;
  payload = { ...payload, body };
  const item = inboxAdd(workspaceId, rec, payload);
  try { require('./socket').broadcast('automation_result', { workspaceId, automationId: rec.id, item }); } catch { /* no clients */ }
  let email = false;
  if (rec.delivery && rec.delivery.email) {
    try {
      const res = await require('./mailer').sendMail({
        to: rec.delivery.email,
        // Strip CR/LF from the subject (defense-in-depth against header injection; nodemailer also strips).
        subject: `[Lokyni] ${String(payload.title || '').replace(/[\r\n]+/g, ' ')}`,
        text: payload.body + (payload.sources?.length ? `\n\nSources: ${payload.sources.join(', ')}` : ''),
      });
      email = res.ok;
      if (!res.ok) console.warn(`[automations] email delivery failed: ${res.error}`);
    } catch (e) { console.warn(`[automations] email delivery error: ${e.message}`); }
  }
  return { inbox: true, email };
}

// ── In-app inbox store (global JSON, capped) ─────────────────────────────────────
const inboxPath = () => path.join(cfg.DATA_DIR, 'automation-inbox.json');
const INBOX_CAP = 200;
function inboxLoad() { try { const a = JSON.parse(fs.readFileSync(inboxPath(), 'utf-8')); return Array.isArray(a) ? a : []; } catch { return []; } }
function inboxSave(items) { fs.mkdirSync(path.dirname(inboxPath()), { recursive: true }); require('./disk').writeFileAtomic(inboxPath(), JSON.stringify(items.slice(-INBOX_CAP), null, 2)); }
function inboxAdd(workspaceId, rec, payload) {
  const items = inboxLoad();
  const item = {
    id: 'm_' + crypto.randomBytes(4).toString('hex'),
    automationId: rec.id, workspaceId, name: rec.name,
    title: payload.title, body: payload.body, sources: payload.sources || [],
    created: Date.now(), read: false,
  };
  items.push(item);
  inboxSave(items);
  return item;
}
const inboxList = () => inboxLoad().slice().reverse();   // newest first
const inboxMarkRead = (id) => { const items = inboxLoad(); const it = items.find(i => i.id === id); if (it) { it.read = true; inboxSave(items); } return !!it; };
const inboxClear = () => { inboxSave([]); return true; };
const inboxUnreadCount = () => inboxLoad().filter(i => !i.read).length;

// ── Scheduler ────────────────────────────────────────────────────────────────────
const _tasks = new Map();   // `${workspaceId}:${automationId}` → cron task
let _startTimer = null;     // the delayed initial-schedule timer, so shutdown can cancel it

// A 6-field cron expression is per-second; automations run model work, so minute granularity (5 fields) is
// the finest we allow. Shared by add() (reject), scheduleWorkspace() (don't arm), and invalidSchedules().
const isTooFrequent = (s) => String(s || '').trim().split(/\s+/).length > 5;

// Tear a cron task fully down. node-cron v4 keeps a process-global registry of every scheduled task, and
// task.stop() only PAUSES it — it stays in that registry and can't be garbage-collected. Only destroy()
// unregisters, so re-arming on every add/remove/toggle would otherwise leak a dead task each time over the
// long-lived process. Fall back to stop() if a future runtime lacks destroy().
const destroyTask = (task) => { try { (typeof task.destroy === 'function' ? task.destroy() : task.stop()); } catch {} };

// (Re)register cron jobs for one workspace: stop its existing tasks, then schedule each
// enabled, valid automation. Called on every add/remove/toggle so the live schedule
// always matches the stored config.
function scheduleWorkspace(workspaceId) {
  if (!cron) return;
  // Only the PRIMARY arms cron. Guard here too (not just in start()) so EVERY caller — add/remove/setEnabled and
  // any future one — is safe: a replica arming cron would fire every scheduled job on every node (duplicate
  // digests, shared-inbox/state races), the exact hazard start()'s guard prevents. A replica still serves reads.
  if (require('./cluster').isReplica()) return;
  for (const [key, task] of _tasks) {
    if (key.startsWith(workspaceId + ':')) { destroyTask(task); _tasks.delete(key); }
  }
  let armed = 0;
  for (const rec of list(workspaceId)) {
    // Skip a per-second (6-field) schedule on the arm path too, not just in add() — records can be
    // hand-edited in the settings file, and cron.validate() accepts 6 fields.
    if (!rec.enabled || !cron.validate(rec.schedule) || isTooFrequent(rec.schedule)) continue;
    // A hand-edited settings file can exceed the cap add() enforces. Bound the armed timers too; the lifecycle
    // watchdog reports the excess and tells the operator which workspace needs cleanup.
    if (armed >= MAX_AUTOMATIONS) {
      console.warn(`⚠️  ${workspaceId} has more than ${MAX_AUTOMATIONS} enabled automations — not arming the rest. Remove the extra jobs.`);
      break;
    }
    armed += 1;
    const task = cron.schedule(rec.schedule, () => {
      runNow(workspaceId, rec.id).catch(e => console.warn(`[automations] job ${rec.id} error: ${e.message}`));
    });
    _tasks.set(`${workspaceId}:${rec.id}`, task);
  }
}

// Tear down every armed task for a workspace WITHOUT re-arming — for when the workspace is being deleted,
// so its cron jobs stop firing (and leave the global node-cron registry) instead of running against a
// workspace whose files are gone. scheduleWorkspace would also work once the settings file is removed, but
// this is explicit and does not depend on delete ordering or on list() returning empty.
function evictWorkspace(workspaceId) {
  if (!cron) return;
  for (const [key, task] of _tasks) {
    if (key.startsWith(workspaceId + ':')) { destroyTask(task); _tasks.delete(key); }
  }
}

function scheduleAll() {
  if (!cron) return;
  for (const ws of wsm.listWorkspaces(cfg.DATA_DIR, { withCounts: false })) {
    try { scheduleWorkspace(ws.id); } catch (e) { console.warn(`[automations] schedule "${ws.id}" failed: ${e.message}`); }
  }
}

function start() {
  if (!cron) { console.log('⏰ Automations disabled — node-cron not installed (run `npm install`).'); return; }
  // Only the PRIMARY runs the scheduler. In a primary+replica cluster every node shares the data dir, so if
  // each replica armed the cron too, every scheduled job would fire on every node — sending duplicate digest
  // emails and racing the shared inbox/state writes. Guard here (not just at the caller) so any future caller
  // is safe as well. A replica still serves reads; it just never owns the schedule.
  if (require('./cluster').isReplica()) { require('./logbuffer').debug('⏰ Automations: read replica — scheduler not started (primary owns it).'); return; }
  // Idempotent: a second start() while the initial-schedule timer is still pending must not overwrite (and
  // orphan) the first handle — that stray timer would then fire scheduleAll() with no way for stopAll() to
  // cancel it. One caller today, but the guard makes a future double-call safe.
  if (_startTimer) return;
  // Delayed initial pass so the index finishes warming first. Jobs fire in the server's
  // local timezone and only while this process is running. The handle is tracked (and
  // unref'd) so shutdown can cancel a still-pending start — otherwise a shutdown within
  // this window could fire scheduleAll() AFTER stopAll(), re-arming the cron tasks.
  _startTimer = setTimeout(() => {
    _startTimer = null;
    try { scheduleAll(); } catch (e) { console.warn(`[automations] initial schedule error: ${e.message}`); }
    // Only worth a terminal line when something is actually scheduled; an idle "0 jobs" is noise.
    const msg = `⏰ Automations started — ${_tasks.size} scheduled job${_tasks.size === 1 ? '' : 's'}`;
    if (_tasks.size > 0) console.log(msg); else require('./logbuffer').debug(msg);
  }, 8000);
  if (typeof _startTimer.unref === 'function') _startTimer.unref();
}

function stopAll() {
  if (_startTimer) { clearTimeout(_startTimer); _startTimer = null; }
  for (const [, task] of _tasks) { destroyTask(task); }
  _tasks.clear();
}

module.exports = {
  MAX_AUTOMATIONS,
  cronAvailable, invalidSchedules, enabledCount,
  list, add, remove, setEnabled, runNow,
  start, stopAll, evictWorkspace,
  inboxList, inboxMarkRead, inboxClear, inboxUnreadCount,
  // Test-only: the corpus change-detection fingerprint (must page the whole corpus, not just the first page).
  __test: { corpusFingerprint },
};
