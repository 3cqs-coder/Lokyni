'use strict';
// Unit tests for the prompt-template library and the scheduled-automations registry.
// Runs in an isolated temp data dir (config.json + DATA_DIR are cwd-relative, so a
// chdir isolates it — the same trick the eval harness uses), never touching ./data.
// Covers the pure logic: template CRUD + seeding, automation registry + cron
// validation + delivery config + enable/remove, and the inbox store. The full run
// (executing a job through the LLM) is exercised by the API integration path, not here.
//
// Run: `npm run test:unit` (or `node lib/test/unit/prompts-automations.test.js`).

const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');

const PROJECT = path.resolve(__dirname, '..', '..', '..');   // lib/test/unit → repo root
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-unit-'));
fs.mkdirSync(path.join(tmp, 'data', 'workspaces', 'default'), { recursive: true });
process.chdir(tmp);   // './config/config.json' + './data' now resolve inside tmp (absent here → defaults)

const cleanup = (code) => { try { process.chdir(PROJECT); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(code); };

try {
  // ── Prompt templates ──
  const prompts = require(path.join(PROJECT, 'lib', 'prompts'));
  let t = prompts.list();
  assert.strictEqual(t.length, 5, 'should seed 5 built-in templates on first run');
  assert.ok(t.every(x => x.builtin), 'seeds are marked builtin');
  const added = prompts.add({ name: 'Mine', body: 'Do {topic} now' });
  assert.strictEqual(prompts.list().length, 6);
  prompts.update(added.id, { name: 'Renamed' });
  assert.strictEqual(prompts.list().find(x => x.id === added.id).name, 'Renamed');
  assert.throws(() => prompts.add({ name: '', body: 'x' }), /name/i);
  assert.throws(() => prompts.add({ name: 'x', body: '' }), /body/i);
  // Bounds: a huge body is truncated (not unbounded), and the library is count-capped.
  const big = prompts.add({ name: 'Big', body: 'y'.repeat(20000) });
  assert.ok(big.body.length <= 8000, 'a template body is truncated to the cap');
  prompts.remove(big.id);
  // Fill to the cap (200) and confirm the next add is refused.
  while (prompts.list().length < 200) prompts.add({ name: 'f' + prompts.list().length, body: 'x' });
  assert.throws(() => prompts.add({ name: 'overflow', body: 'x' }), /At most 200/);
  // trim back to just the builtins + the original 'added' template so the later assertions still hold
  for (const p of prompts.list().filter(x => !x.builtin && x.id !== added.id)) prompts.remove(p.id);
  assert.strictEqual(prompts.remove(added.id), true);
  assert.strictEqual(prompts.remove('nope'), false);
  assert.strictEqual(prompts.list().length, 5);
  console.log('✓ prompts: seed + CRUD + validation');

  // ── restoreBuiltins: re-adds deleted built-ins (by name), never duplicates existing ones ──
  // Delete two built-ins, then restore. The seed only runs once (file present), so without restore they'd be
  // gone for good; restore brings back exactly the missing ones.
  const before = prompts.list();
  prompts.remove(before[0].id);
  prompts.remove(before[1].id);
  assert.strictEqual(prompts.list().length, 3, 'two built-ins deleted');
  let r = prompts.restoreBuiltins();
  assert.strictEqual(r.added, 2, 'restore re-adds exactly the two missing built-ins');
  assert.strictEqual(prompts.list().length, 5, 'the library is back to the five built-ins');
  r = prompts.restoreBuiltins();
  assert.strictEqual(r.added, 0, 'a second restore is a no-op (no duplicates)');
  assert.strictEqual(prompts.list().length, 5, 'still five — nothing duplicated');
  // A user template with a built-in's name is not clobbered or duplicated by restore.
  prompts.remove(prompts.list().find(x => x.name === 'Timeline').id);
  prompts.add({ name: 'Timeline', body: 'my own timeline prompt' });
  assert.strictEqual(prompts.restoreBuiltins().added, 0, 'restore skips a built-in name the user already occupies');
  console.log('✓ prompts: restoreBuiltins re-adds only missing built-ins, never duplicates');

  // ── Automations registry ──
  const auto = require(path.join(PROJECT, 'lib', 'automations'));
  assert.strictEqual(auto.cronAvailable(), true, 'node-cron available');
  assert.deepStrictEqual(auto.list('default'), []);
  const a = auto.add('default', { name: 'Daily brief', kind: 'query', query: 'summary', schedule: '0 8 * * *' });
  assert.strictEqual(auto.list('default').length, 1);
  assert.strictEqual(auto.list('default')[0].delivery.inbox, true);
  assert.throws(() => auto.add('default', { kind: 'query', query: 'x', schedule: 'bogus' }), /Invalid cron/);
  assert.throws(() => auto.add('default', { kind: 'query', schedule: '0 8 * * *' }), /needs a question/i);
  // A per-second (6-field) schedule is rejected — model work takes seconds to minutes, so a per-second
  // cadence can only waste cycles (see the in-flight guard for overlapping fires).
  assert.throws(() => auto.add('default', { kind: 'query', query: 'x', schedule: '* * * * * *' }), /too frequent/i);
  const d = auto.add('default', { kind: 'digest', schedule: '0 9 * * 1', delivery: { email: 'me@example.com' } });
  assert.strictEqual(d.delivery.email, 'me@example.com');
  // A malformed delivery address is rejected at save time, not left to fail silently on every scheduled fire.
  assert.throws(() => auto.add('default', { kind: 'digest', schedule: '0 9 * * 1', delivery: { email: 'not-an-email' } }), /valid email/i);
  assert.throws(() => auto.add('default', { kind: 'digest', schedule: '0 9 * * 1', delivery: { email: 'a@b@c.com' } }), /valid email/i);
  assert.throws(() => auto.add('default', { kind: 'digest', schedule: '0 9 * * 1', delivery: { email: 'x@' + 'a'.repeat(260) + '.com' } }), /valid email/i);
  assert.strictEqual(auto.setEnabled('default', a.id, false), true);
  assert.strictEqual(auto.list('default').find(x => x.id === a.id).enabled, false);
  assert.strictEqual(auto.remove('default', a.id), true);
  assert.strictEqual(auto.remove('default', 'nope'), false);
  assert.strictEqual(auto.list('default').length, 1);
  // A per-workspace cap bounds the settings file and the number of armed timers; the API returns the message.
  assert.strictEqual(auto.MAX_AUTOMATIONS, 50, 'automations have a documented per-workspace cap');
  assert.ok(/MAX_AUTOMATIONS/.test(fs.readFileSync(path.join(PROJECT, 'lib', 'automations.js'), 'utf-8')) &&
    /at most \$\{MAX_AUTOMATIONS\}/.test(fs.readFileSync(path.join(PROJECT, 'lib', 'automations.js'), 'utf-8')),
    'add() enforces the cap with a clear message');
  assert.ok(/up to 50 automations/.test(fs.readFileSync(path.join(PROJECT, 'docs', 'README.md'), 'utf-8')),
    'the guide documents the same cap');
  assert.ok(/if \(armed >= MAX_AUTOMATIONS\)/.test(fs.readFileSync(path.join(PROJECT, 'lib', 'automations.js'), 'utf-8')),
    'the arm path also bounds a hand-edited file that exceeds the cap');
  console.log('✓ automations: registry + cron validation + delivery config + enable/remove');

  // ── source guards: the scheduler tears tasks down with destroy() and skips per-second on the arm path ──
  // node-cron v4 keeps a global task registry that stop() only pauses; teardown must destroy() to unregister,
  // or every add/remove/toggle leaks a dead task over the long-lived process. And a hand-edited 6-field
  // schedule must be skipped when arming (not just rejected in add), and flagged by invalidSchedules.
  const autoSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'automations.js'), 'utf-8');
  assert.ok(/typeof task\.destroy === 'function' \? task\.destroy\(\) : task\.stop\(\)/.test(autoSrc), 'destroyTask prefers destroy() (unregisters) over stop()');
  assert.ok(!/for \(const \[, task\] of _tasks\) \{ try \{ task\.stop\(\)/.test(autoSrc), 'stopAll no longer uses a bare stop() that would leak the task registry');
  assert.ok(/!cron\.validate\(rec\.schedule\) \|\| isTooFrequent\(rec\.schedule\)/.test(autoSrc), 'scheduleWorkspace skips a per-second schedule when arming');
  assert.ok(/isTooFrequent\(rec\.schedule\)/.test(autoSrc.slice(autoSrc.indexOf('invalidSchedules'))) || /cron\.validate\(String\(rec\.schedule[\s\S]*?isTooFrequent/.test(autoSrc), 'invalidSchedules flags a per-second schedule too');
  // Behavioral: node-cron destroy() actually unregisters (so the leak fix is effective on the pinned runtime).
  { const cron = require('node-cron'); const before = cron.getTasks().size; const t = cron.schedule('* * * * *', () => {}); t.destroy(); assert.strictEqual(cron.getTasks().size, before, 'destroy() removes the task from the node-cron registry'); }
  console.log('✓ automations: teardown destroys (no task-registry leak) and the arm path rejects per-second schedules');

  // ── Source guards: scheduled model work is bounded and can't overlap itself ──
  assert.ok(/const genGate = require\('\.\/gengate'\)/.test(autoSrc) && /genGate\.run\(/.test(autoSrc),
    'automations run their model work through the shared generation gate (not uncapped)');
  assert.ok(/const _running = new Set\(\)/.test(autoSrc) && /if \(_running\.has\(runKey\)\) return \{ ok: false, skipped: true/.test(autoSrc) && /_running\.delete\(runKey\)/.test(autoSrc),
    'a still-running automation is skipped by an in-flight guard rather than re-entered');
  assert.ok(/if \(e && e\.backpressure\) return \{ ok: false, skipped: true, note: 'busy' \}/.test(autoSrc),
    'a gen-gate backpressure rejection is recorded as a skip, not a job failure');
  console.log('✓ automations: model work is gen-gated and guarded against overlapping runs');

  // ── Source guards: scheduled runs are wall-clock-bounded, delivery is size-capped and change-gatable ──
  assert.ok(/const SCHED_RUN_MAX_MS = /.test(autoSrc) && /const withSchedDeadline = async/.test(autoSrc),
    'a scheduled generation runs under a wall-clock deadline (a trickling provider cannot hold a gen-gate slot forever)');
  assert.ok(/withSchedDeadline\(\(signal\) => genGate\.run/.test(autoSrc) && /runGroundedChat\(workspaceId, \[\{ role: 'user', content: rec\.query \}\], \{ signal \}\)/.test(autoSrc),
    'the deadline signal is threaded into the grounded generation');
  assert.ok(/drain = async \(stream, signal\)/.test(autoSrc) && /signal && signal\.aborted\) break/.test(autoSrc),
    'drain stops reading once the deadline aborts');
  assert.ok(/const MAX_RESULT_CHARS = /.test(autoSrc) && /rawBody\.length > MAX_RESULT_CHARS \? rawBody\.slice\(0, MAX_RESULT_CHARS\)/.test(autoSrc),
    'the stored/emailed result body is size-capped');
  assert.ok(/rec\.delivery\.onlyWhenChanged && !changed && !opts\.manual/.test(autoSrc),
    'a query automation can opt into change-gated delivery (no duplicate email flood on a frequent schedule)');
  assert.ok(/subject: `\[Lokyni\] \$\{String\(payload\.title \|\| ''\)\.replace\(\/\[\\r\\n\]\+\/g, ' '\)\}`/.test(autoSrc),
    'the email subject strips CR/LF (header-injection defense-in-depth)');
  assert.ok(/function start\(\) \{[\s\S]*?if \(_startTimer\) return;/.test(autoSrc),
    'start() is idempotent (a second call cannot orphan the initial-schedule timer)');
  console.log('✓ automations: scheduled runs are deadline-bounded; delivery is size-capped, change-gatable, and header-safe; start() is idempotent');

  // ── evictWorkspace tears down a deleted workspace's armed cron tasks (no orphaned jobs) ──
  // When a workspace is deleted, its scheduled automations must stop firing — otherwise they keep running
  // against files that no longer exist. evictWorkspace destroys every task keyed to that workspace without
  // re-arming, and is safe (and a no-op) on a workspace that has none.
  {
    const cronLib = require('node-cron');
    fs.mkdirSync(path.join(tmp, 'data', 'workspaces', 'evictme'), { recursive: true });
    const beforeAdd = cronLib.getTasks().size;
    const ev = auto.add('evictme', { kind: 'query', query: 'q', schedule: '0 7 * * *' });
    auto.setEnabled('evictme', ev.id, true);   // ensure it is armed
    assert.ok(cronLib.getTasks().size > beforeAdd, 'an enabled automation arms a cron task');
    auto.evictWorkspace('evictme');
    assert.strictEqual(cronLib.getTasks().size, beforeAdd, 'evictWorkspace destroys the workspace\'s cron tasks (no orphan left firing)');
    auto.evictWorkspace('never-existed');   // safe no-op on an unknown workspace
  }
  // The delete route must release the deleted workspace's in-memory state (automations, bundle, graph).
  const serverSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'server.js'), 'utf-8');
  const delIdx = serverSrc.indexOf('wsm.deleteWorkspace(cfg.DATA_DIR, id)');
  const delBlock = serverSrc.slice(delIdx, delIdx + 900);
  assert.ok(/evictWorkspace\(id\)/.test(delBlock) && /invalidateBundle\(id\)/.test(delBlock) && /clearGraph\(id\)/.test(delBlock),
    'the delete route evicts the workspace\'s automations, bundle cache, and merged graph');
  console.log('✓ automations: evictWorkspace tears down a deleted workspace\'s cron tasks, and delete wires the evictions');

  // ── Inbox store ──
  assert.deepStrictEqual(auto.inboxList(), []);
  assert.strictEqual(auto.inboxUnreadCount(), 0);
  assert.strictEqual(auto.inboxClear(), true);
  console.log('✓ inbox: empty-state + clear');

  auto.stopAll();
  console.log('\nALL UNIT TESTS PASSED');
  cleanup(0);
} catch (e) {
  console.error('\nUNIT TEST FAILED:', e.message);
  cleanup(1);
}
