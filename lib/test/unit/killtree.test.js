'use strict';

// The never-orphan tree kill: a child spawned WITHOUT `detached` (an MCP connector, or the `node` server a `npx`
// launcher forks) shares the parent's group, so a process-group kill misses it. killProcessTreeSync must still
// discover and kill the descendant. This guards the regression where only the direct child was killed and its
// grandchild was orphaned on Unix. POSIX-only (Windows uses taskkill /T); skips when pgrep is unavailable.

const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const { killProcessTreeSync, descendantsSync } = require('../../killtree');

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (process.platform === 'win32') { console.log('ALL KILLTREE UNIT TESTS PASSED (skipped on Windows)'); return; }
  const probe = spawnSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' });
  if (!probe || probe.error) { console.log('ALL KILLTREE UNIT TESTS PASSED (skipped — pgrep unavailable)'); return; }

  // A parent that forks a long-lived child (NOT detached → shares the group) and prints the child's pid, exactly
  // the shape that used to orphan: the tracked pid is the parent, the real work is the child under it.
  const parentCode = "const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1e9)'],{stdio:'ignore'});process.stdout.write(String(c.pid));setInterval(()=>{},1e9);";
  const parent = spawn(process.execPath, ['-e', parentCode], { stdio: ['ignore', 'pipe', 'ignore'] });
  let childPid = 0;
  try {
    // Read the child's pid from the parent's stdout.
    childPid = await new Promise((resolve, reject) => {
      let buf = '';
      const t = setTimeout(() => reject(new Error('timed out waiting for child pid')), 5000);
      parent.stdout.on('data', (d) => { buf += d; const n = parseInt(buf.trim(), 10); if (Number.isInteger(n) && n > 0) { clearTimeout(t); resolve(n); } });
      parent.on('error', reject);
    });
    await sleep(100);

    ok(alive(parent.pid), 'the parent process is running');
    ok(alive(childPid), 'the child (would-be orphan) is running');
    // The core regression guard: the descendant walk FINDS the child (a group kill on the parent would miss it).
    ok(descendantsSync(parent.pid).includes(childPid), 'descendantsSync discovers the non-detached child');

    // Kill the whole tree from the parent pid, then wait for both to actually die.
    killProcessTreeSync(parent.pid);
    let gone = false;
    for (let i = 0; i < 50 && !gone; i++) { await sleep(50); gone = !alive(parent.pid) && !alive(childPid); }
    ok(!alive(childPid), 'the child is NOT orphaned — it was killed with the tree');
    ok(!alive(parent.pid), 'the parent is killed too');
  } finally {
    try { killProcessTreeSync(parent.pid); } catch {}
    try { if (childPid) process.kill(childPid, 'SIGKILL'); } catch {}
  }

  console.log(`ALL KILLTREE UNIT TESTS PASSED (${checks} checks)`);
})().catch((e) => { console.error('✗ KILLTREE UNIT TEST FAILED:', e && e.stack || e); process.exit(1); });
