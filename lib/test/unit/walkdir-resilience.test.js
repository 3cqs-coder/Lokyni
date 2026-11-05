'use strict';
// Guards walkDirectory's per-subtree resilience (lib/indexing/files.js). An unreadable SUBFOLDER of
// the curated documents directory (a permission blip, a symlinked folder whose target unmounted, or a
// folder removed mid-scan) must NOT abort the whole scan: the readable documents still index, the
// Documents panel still lists them (GET /api/documents calls walkDirectory with no report and must not
// throw), and the affected subtree is flagged incomplete so the delta HOLDS its documents rather than
// purging them ("missing from the scan" must never be read as "deleted").
//
// Uses a real unreadable dir; the restriction asserts are skipped where the OS/user still allows the
// read (e.g. running as root, or a platform that ignores the mode). Run: `npm run test:unit`.

const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { walkDirectory, collectAllFiles } = require(path.join(PROJECT, 'lib', 'indexing', 'files'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-walk-')));
const cleanup = (code) => {
  try { fs.chmodSync(path.join(tmp, 'sub'), 0o755); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(code);
};

(async () => {
  try {
    // A readable top-level doc plus a subfolder with its own doc.
    fs.writeFileSync(path.join(tmp, 'top.txt'), 'hello');
    fs.mkdirSync(path.join(tmp, 'sub'));
    fs.writeFileSync(path.join(tmp, 'sub', 'inner.txt'), 'world');

    // ── Baseline: everything readable ──
    let report = {};
    let files = await walkDirectory(tmp, report);
    ok(files.some(f => f.endsWith('top.txt')) && files.some(f => f.endsWith('inner.txt')),
      'walkDirectory lists files in the root and in subfolders');
    ok(!report.incomplete, 'a fully-readable scan is not marked incomplete');

    // ── Make the subfolder unreadable and re-scan ──
    fs.chmodSync(path.join(tmp, 'sub'), 0o000);
    let stillReadable = true;
    try { fs.readdirSync(path.join(tmp, 'sub')); } catch { stillReadable = false; }

    if (!stillReadable) {
      report = {};
      files = await walkDirectory(tmp, report);
      ok(files.some(f => f.endsWith('top.txt')), 'the readable top-level document is still found when a subfolder is unreadable');
      ok(!files.some(f => f.endsWith('inner.txt')), 'the unreadable subfolder is skipped, not indexed');
      ok(report.incomplete === true, 'an unreadable subfolder marks the scan incomplete (so the delta HOLDS, not purges)');

      // The Documents-panel / bundle contract: called with NO report, it must not throw — best-effort.
      let threw = false;
      try { await walkDirectory(tmp); } catch { threw = true; }
      ok(!threw, 'walkDirectory without a report never throws on an unreadable subfolder (Documents panel stays populated)');

      console.log('✓ walkdir-resilience: an unreadable subfolder is skipped, flagged incomplete, and never throws');
    } else {
      console.log('… walkdir-resilience: OS/user still read the 0o000 dir (likely root) — restriction asserts skipped');
    }

    // ── Source guard: collectAllFiles routes the docs scan through walkDirectory WITH a report and
    // marks incompleteRoots on partial failure (so it holds rather than purges). ──
    const src = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'files.js'), 'utf-8');
    ok(/walkDirectory\(docsDir, docsReport\)/.test(src) && /if \(docsReport\.incomplete\) incompleteRoots\.push/.test(src),
      'collectAllFiles passes a report to walkDirectory and holds (incompleteRoots) on partial failure');
    ok(typeof collectAllFiles === 'function', 'collectAllFiles is exported');

    console.log(`\nALL WALKDIR-RESILIENCE UNIT TESTS PASSED (${checks} checks)`);
    cleanup(0);
  } catch (e) {
    console.error('\n✗ WALKDIR-RESILIENCE UNIT TEST FAILED:', e.message);
    cleanup(1);
  }
})();
