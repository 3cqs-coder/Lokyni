'use strict';
// Regression tests for isolated document parsing (lib/indexing/extractprocess.js +
// extractchild.js + extractcore.js). These exercise the REAL fork → child → extract → reply
// pipeline end to end using a JSON file (no native parser or network needed), and confirm the
// error contract the caller relies on: a child that starts and then fails rejects WITHOUT the
// forkFailed flag (so the caller skips the file rather than risk an inline OOM). Run:
// `npm run test:unit`.

const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { extractInChild, killAllChildrenSync } = require(path.join(PROJECT, 'lib', 'indexing', 'extractprocess'));
const extractcore = require(path.join(PROJECT, 'lib', 'indexing', 'extractcore'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-extract-'));
  try {
    // ── the pure core: JSON is pretty-printed so keys and values are searchable ──
    const coreOut = await extractcore.extract(Buffer.from('{"a":1,"b":"x"}'), '.json');
    ok(coreOut.kind === 'text' && coreOut.text.includes('"a": 1'), 'extractcore pretty-prints JSON');
    ok(extractcore.ISOLATABLE.has('.pdf') && extractcore.ISOLATABLE.has('.xlsx'), 'the isolatable set covers the heavy formats');
    console.log('✓ extract: the shared core extracts JSON and lists the isolatable formats');

    // ── the full isolated pipeline: fork → child reads the file → extract → reply ──
    const jf = path.join(dir, 'doc.json');
    fs.writeFileSync(jf, JSON.stringify({ hello: 'world', n: 42 }));
    const r = await extractInChild(jf, '.json');
    ok(r && r.kind === 'text' && r.text.includes('"hello": "world"'), 'a file is extracted in an isolated child process');
    console.log('✓ extract: the fork → child → extract → reply pipeline works end to end');

    // ── error contract: a child that started but failed rejects, and NOT as forkFailed ──
    let threw = false, forkFailed = false;
    try {
      await extractInChild(path.join(dir, 'does-not-exist.json'), '.json');
    } catch (e) { threw = true; forkFailed = !!(e && e.forkFailed); }
    ok(threw, 'a missing file makes the isolated parse reject');
    ok(!forkFailed, 'the rejection is NOT flagged forkFailed, so the caller skips the file rather than parsing it inline');
    console.log('✓ extract: a child-side failure rejects without the forkFailed flag');

    // ── never-orphan backstop: killAllChildrenSync force-kills any live parse child on an exit path ──
    // The fork happens synchronously inside extractInChild's promise executor, so the child is live and tracked
    // the instant the call returns — before it has even received the job. Killing it here (the onExitKill path)
    // must terminate it and make the pending parse reject, proving a sync-wedged child can't outlive shutdown.
    {
      const big = path.join(dir, 'kill-me.json');
      fs.writeFileSync(big, JSON.stringify({ x: 'y'.repeat(1000) }));
      const p = extractInChild(big, '.json');   // forks + registers the child synchronously
      killAllChildrenSync();                      // SIGKILL every tracked child, as shutdown.onExitKill does
      let killedReject = false;
      try { await p; } catch { killedReject = true; }
      ok(killedReject, 'killAllChildrenSync terminates a live parse child so its pending parse rejects (no orphan)');
      // A second call is a harmless no-op (the Set was cleared / the child already exited).
      killAllChildrenSync();
      ok(true, 'killAllChildrenSync is idempotent');
    }
    console.log('✓ extract: killAllChildrenSync force-kills live children (never-orphan backstop)');

    console.log(`\nALL EXTRACTPROCESS UNIT TESTS PASSED (${checks} checks)`);
    process.exitCode = 0;
  } catch (e) {
    console.error('\n✗ EXTRACTPROCESS UNIT TEST FAILED:', e && e.message);
    process.exitCode = 1;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
})();
