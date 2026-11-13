'use strict';

// Synchronously kill a process AND all of its descendants, cross-platform — the single source for "take down a
// whole process subtree" used by any shutdown backstop that must never orphan a grandchild.
//
// Why a tree walk rather than a process-group kill: a child is only reachable by `process.kill(-pid)` when it is
// its OWN group leader (spawned `detached`). A child spawned WITHOUT detachment (for example an MCP connector run
// through the SDK, or any `npx <server>` that forks a `node` grandchild) shares the parent's group, so a
// group kill keyed on its pid matches no group and the grandchild is orphaned. Windows already reaps the subtree
// with `taskkill /T`; this mirrors that on POSIX by discovering descendants with `pgrep` and killing them too.
//
// Sync (callable from a process 'exit' handler, where async cannot complete), bounded (a visited set caps the
// walk and blocks a pid-reuse cycle), crash-proof (never throws; a missing `pgrep` degrades to the direct + group
// kill, which is no worse than before — and a container or desktop whole-tree kill still reaps the rest).

const { spawnSync } = require('child_process');

// Descendant pids of `pid` (children, grandchildren, …) on POSIX via `pgrep -P`. Returns [] when pgrep is
// unavailable (a minimal image) so the caller falls back. Deepest-last discovery order (breadth-first).
function descendantsSync(pid) {
  const out = [];
  const seen = new Set([pid]);
  const queue = [pid];
  let guard = 0;
  while (queue.length && guard++ < 10000) {
    const p = queue.shift();
    let res;
    try { res = spawnSync('pgrep', ['-P', String(p)], { encoding: 'utf8', timeout: 2000 }); }
    catch { return out; }                 // pgrep unavailable → give up (caller falls back)
    if (!res || res.error) return out;
    for (const line of String(res.stdout || '').split('\n')) {
      const c = parseInt(line.trim(), 10);
      if (Number.isInteger(c) && c > 0 && !seen.has(c)) { seen.add(c); out.push(c); queue.push(c); }
    }
  }
  return out;
}

// SIGKILL `pid` and every descendant. Windows: `taskkill /T /F` (whole tree). POSIX: kill discovered descendants
// deepest-first, then the process group (a cheap catch-all if the child WAS a leader), then the root. Never throws.
function killProcessTreeSync(pid) {
  const p = Number(pid);
  if (!Number.isInteger(p) || p <= 0) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(p), '/T', '/F'], { stdio: 'ignore', timeout: 5000 }); } catch { /* best-effort */ }
    return;
  }
  const kids = descendantsSync(p);
  for (let i = kids.length - 1; i >= 0; i--) { try { process.kill(kids[i], 'SIGKILL'); } catch { /* already gone */ } }
  try { process.kill(-p, 'SIGKILL'); } catch { /* not a group leader — the descendant walk above covered it */ }
  try { process.kill(p, 'SIGKILL'); } catch { /* already gone */ }
}

module.exports = { killProcessTreeSync, descendantsSync };
