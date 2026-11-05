'use strict';
// Guards the Windows-safe rename retries in lib/disk.js. On Windows a scanner or indexer can briefly hold the
// target or the temp file, making rename fail with EPERM/EBUSY/EACCES; the atomic writers retry a bounded number
// of times instead of losing a settings/key/index write. POSIX keeps a single rename, and a non-retryable error
// is never retried. The retries are exercised by stubbing fs on any CI host. Run: `npm run test:unit`.

const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const disk = require(path.join(PROJECT, 'lib', 'disk'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lok-rename-')));
const realPlatform = process.platform;
const asPlatform = (p, fn) => {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
  try { return fn(); } finally { Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }); }
};
const asPlatformAsync = async (p, fn) => {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
  try { return await fn(); } finally { Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }); }
};
const locked = (code) => Object.assign(new Error(`simulated ${code}`), { code });

(async () => {
  const realRenameSync = fs.renameSync;
  const realRenameAsync = fs.promises.rename;
  try {
    // ── Windows sync writer: retries a transient lock, then succeeds ──
    const syncFile = path.join(dir, 'sync.json');
    let syncCalls = 0;
    fs.renameSync = (from, to) => {
      syncCalls += 1;
      if (syncCalls <= 2) throw locked('EBUSY');
      return realRenameSync(from, to);
    };
    asPlatform('win32', () => disk.writeFileAtomic(syncFile, '{"a":1}'));
    fs.renameSync = realRenameSync;
    ok(syncCalls === 3, `the sync writer retried a transient Windows lock (${syncCalls} attempts)`);
    ok(fs.readFileSync(syncFile, 'utf-8') === '{"a":1}', 'the sync write landed after the retries');

    // ── Windows async writer: retries, then succeeds ──
    const asyncFile = path.join(dir, 'async.json');
    let asyncCalls = 0;
    fs.promises.rename = async (from, to) => {
      asyncCalls += 1;
      if (asyncCalls <= 1) throw locked('EPERM');
      return realRenameAsync.call(fs.promises, from, to);
    };
    await asPlatformAsync('win32', () => disk.writeFileAtomicAsync(asyncFile, '{"b":2}'));
    fs.promises.rename = realRenameAsync;
    ok(asyncCalls === 2, `the async writer retried a transient Windows lock (${asyncCalls} attempts)`);
    ok(fs.readFileSync(asyncFile, 'utf-8') === '{"b":2}', 'the async write landed after the retry');

    // ── A non-retryable error is surfaced immediately on Windows ──
    let fatalCalls = 0;
    fs.renameSync = () => { fatalCalls += 1; throw locked('ENOSPC'); };
    asPlatform('win32', () => assert.throws(() => disk.writeFileAtomic(path.join(dir, 'full.json'), 'x'), /ENOSPC|simulated/));
    fs.renameSync = realRenameSync;
    ok(fatalCalls === 1, `a non-retryable Windows error is not retried (${fatalCalls} attempt)`);

    // ── POSIX keeps the one-shot rename, even on a transient-looking code ──
    let posixCalls = 0;
    fs.renameSync = () => { posixCalls += 1; throw locked('EBUSY'); };
    asPlatform('linux', () => assert.throws(() => disk.writeFileAtomic(path.join(dir, 'posix.json'), 'x'), /EBUSY|simulated/));
    fs.renameSync = realRenameSync;
    ok(posixCalls === 1, `POSIX does not add retry latency (${posixCalls} attempt)`);

    ok(!fs.readdirSync(dir).some((n) => n.endsWith('.tmp')), 'no temporary file is left after a failed or retried write');

    // ── Every durable/index/ingest rename goes through the shared helper, so a future edit cannot silently
    // reintroduce a one-shot Windows rename on a critical path. ──
    const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf8');
    for (const f of [
      'lib/indexing/parentmapstore.js', 'lib/indexing/ndjsonmapstore.js', 'lib/indexing/delta.js',
      'lib/indexing/banks.js', 'lib/indexing/figurestore.js', 'lib/urlfetch.js',
      'lib/backup.js', 'lib/workspaces.js', 'lib/mcp/connectors.js',
    ]) {
      ok(/rename(?:Sync)?WithRetry\(/.test(read(f)), `${f} uses the retrying rename`);
    }

    console.log(`\nALL DISK-RENAME-RETRY UNIT TESTS PASSED (${checks} checks)`);
    process.exitCode = 0;
  } catch (e) {
    console.error('\n✗ DISK-RENAME-RETRY UNIT TEST FAILED:', e && e.message);
    console.error(e && e.stack ? e.stack : e);
    process.exitCode = 1;
  } finally {
    fs.renameSync = realRenameSync;
    fs.promises.rename = realRenameAsync;
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
})();
