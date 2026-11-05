'use strict';
// Unit tests for the shared path helpers (lib/paths.js). Focus on realWithin, which the folder
// browser, source-preview, and document delete use to keep a request inside its allowed roots.
// Two properties matter and pull in opposite directions:
//   - It must REFUSE a symlink that lives inside a root but points OUTSIDE it (escape protection).
//   - It must ACCEPT a legitimate path when the ROOT itself is a symlink/firmlink (a symlinked
//     home on Linux, or macOS /tmp -> /private/tmp) — the pass-8 regression where only the target
//     was resolved and the textual root then didn't match, wrongly returning 403.
// Uses real symlinks in a temp dir; symlink-specific checks are skipped where the OS refuses to
// create one (e.g. Windows without privilege). Run: `npm run test:unit`.

const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { isWithin, realWithin, statWithTimeout, indexedRoots, safeStoredFilename } = require(path.join(PROJECT, 'lib', 'paths'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

// Resolve the temp base itself (macOS tmp is under a /var -> /private/var symlink) so the "real"
// paths below are canonical to begin with.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-paths-')));
const cleanup = (code) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(code); };

(async () => {
  try {
    // ── isWithin basics ──
    ok(isWithin('/a/b/c', '/a/b') === true, 'isWithin: child is inside parent');
    ok(isWithin('/a/b', '/a/b') === true, 'isWithin: a path is within itself');
    ok(isWithin('/a/bc', '/a/b') === false, 'isWithin: sibling with a shared prefix is not inside');

    const root = path.join(tmp, 'root');
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(root); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(root, 'inside.txt'), 'x');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'y');

    // ── containment without symlinks ──
    ok(await realWithin(path.join(root, 'inside.txt'), [root]) !== null, 'a file inside the root is accepted');
    ok(await realWithin(path.join(outside, 'secret.txt'), [root]) === null, 'a file outside the root is refused');
    // A non-existent path falls back to its textual form and is judged by containment.
    ok(await realWithin(path.join(root, 'nope.txt'), [root]) !== null, 'a non-existent in-root path is accepted (caller surfaces ENOENT)');
    ok(await realWithin(path.join(outside, 'nope.txt'), [root]) === null, 'a non-existent out-of-root path is refused');

    // ── symlink cases (skipped if the OS refuses symlink creation) ──
    let symlinksWork = true;
    const linkRoot = path.join(tmp, 'linkroot');
    const escape = path.join(root, 'escape');
    try {
      fs.symlinkSync(root, linkRoot);       // linkroot -> root (a symlinked ROOT)
      fs.symlinkSync(outside, escape);      // root/escape -> outside (an ESCAPING symlink inside the root)
    } catch (e) { symlinksWork = false; }

    if (symlinksWork) {
      // The regression: the root itself is a symlink. Real-vs-real must ACCEPT (the pass-8 bug,
      // which compared the resolved target against the textual root, wrongly rejected this).
      ok(await realWithin(path.join(linkRoot, 'inside.txt'), [linkRoot]) !== null, 'a file under a symlinked root is accepted');
      ok(await realWithin(path.join(linkRoot, 'inside.txt'), [root]) !== null, 'accepted when the request goes through a symlink but the root is listed by its real path');
      // Escape protection: a symlink inside the root that points outside must be REFUSED.
      ok(await realWithin(path.join(escape, 'secret.txt'), [root]) === null, 'a symlink inside the root that escapes it is refused');
      // The resolved path returned is the real one (canonical), not the symlinked input.
      const resolved = await realWithin(path.join(linkRoot, 'inside.txt'), [root]);
      ok(resolved === path.join(root, 'inside.txt'), 'realWithin returns the resolved real path');
      console.log('✓ paths: realWithin accepts a symlinked root, refuses an escaping symlink, returns the real path');
    } else {
      console.log('… paths: symlink checks skipped (OS refused symlink creation)');
    }

    // ── statWithTimeout: the shared bounded stat used by the offline-roots probe and the Windows
    // drive-letter scan, so a hung network mount can never freeze either. ──
    const st = await statWithTimeout(root, 1500);
    ok(st && st.isDirectory() === true, 'statWithTimeout resolves Stats for a real directory');
    let rejected = false;
    try { await statWithTimeout(path.join(tmp, 'does-not-exist'), 1500); }
    catch { rejected = true; }
    ok(rejected, 'statWithTimeout rejects for a missing path');
    // The timeout itself is not asserted here: racing a real local stat against a timer is
    // non-deterministic (a warm stat can win a tiny budget), so a timing assertion would be flaky.
    // offlineRoots already depends on the timeout behaving, and the resolve/reject paths above
    // cover the contract this helper adds.

    // ── indexedRoots: the single-sourced [DOCS_DIR, ...SOURCE_PATHS] list that BOTH the warm-start
    // wipe guard and the delta purge hold-back probe for reachability. If either omitted DOCS_DIR, a
    // slow/half-mounted docs volume could be misread as "gone" and trigger a wipe or purge. ──
    ok(JSON.stringify(indexedRoots('/docs', [{ path: '/a' }, { path: '/b' }])) === JSON.stringify(['/docs', '/a', '/b']),
      'indexedRoots puts DOCS_DIR first, then each source path');
    ok(JSON.stringify(indexedRoots('/docs', [])) === JSON.stringify(['/docs']), 'indexedRoots with no sources is just DOCS_DIR');
    ok(JSON.stringify(indexedRoots('/docs', null)) === JSON.stringify(['/docs']), 'indexedRoots tolerates a missing source list');
    ok(JSON.stringify(indexedRoots('', [{ path: '/a' }, null, { path: '' }])) === JSON.stringify(['/a']),
      'indexedRoots drops falsy roots (empty DOCS_DIR, null/blank source entries)');
    console.log('✓ paths: indexedRoots single-sources the [DOCS_DIR, ...sources] reachability set');

    // ── safeStoredFilename: turns an untrusted upload name into one safe to write on this host ──
    // Separators and control chars are stripped on every platform (a component can't escape its dir,
    // and NUL/newlines can't corrupt a write or a log line). The Windows-only rules (forbidden chars,
    // trailing dots/spaces, reserved device names) are exercised by faking process.platform, so the
    // guard is verified on any CI host rather than only when the suite happens to run on Windows.
    ok(safeStoredFilename('report.pdf') === 'report.pdf', 'an ordinary name is unchanged');
    ok(safeStoredFilename('../../etc/passwd') === 'passwd', 'a traversal name is reduced to its basename');
    ok(!/[/\\]/.test(safeStoredFilename('a/b\\c.txt')), 'no path separator of either kind survives');
    ok(!safeStoredFilename('a\u0000b\nc.txt').includes('\u0000') && !safeStoredFilename('a\u0000b\nc.txt').includes('\n'),
      'NUL and newline control chars are replaced');
    ok(safeStoredFilename('') === 'file' && safeStoredFilename(null) === 'file', 'an empty/absent name falls back to "file"');
    ok(safeStoredFilename('..') === 'file' && safeStoredFilename('.') === 'file', 'a traversal component is never returned as a filename');
    const longName = safeStoredFilename('a'.repeat(300) + '.pdf');
    ok(longName.length <= 120 && longName.endsWith('.pdf'),
      'an overlong upload name is capped while keeping its extension (Windows path budget)');
    ok(safeStoredFilename('a'.repeat(300)).length === 120, 'an overlong extensionless name is capped');
    const emojiName = safeStoredFilename('😀'.repeat(200) + '.pdf');
    ok([...emojiName].length <= 120 && emojiName.endsWith('.pdf'),
      'a long non-Latin name is capped by code point and keeps its extension');
    ok(Buffer.from(emojiName, 'utf8').toString('utf8') === emojiName,
      'the cap never splits a surrogate pair');

    const realPlatform = process.platform;
    const asPlatform = (p, fn) => {
      Object.defineProperty(process, 'platform', { value: p, configurable: true });
      try { return fn(); } finally { Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }); }
    };
    // On POSIX, characters Windows forbids are legal and preserved (the user's name is kept as-is).
    asPlatform('linux', () => {
      ok(safeStoredFilename('a:b*c?.txt') === 'a:b*c?.txt', 'POSIX keeps :*? and other Windows-illegal chars');
      ok(safeStoredFilename('CON.txt') === 'CON.txt', 'POSIX does not treat CON as reserved');
      ok(safeStoredFilename('name. ') === 'name. ', 'POSIX keeps a trailing dot/space');
    });
    // On Windows, the forbidden set is neutralized, trailing dots/spaces are dropped, and a reserved
    // device basename is renamed so it can actually be created.
    asPlatform('win32', () => {
      const win = safeStoredFilename('a:b*c?"<>|.txt');
      ok(!/[:*?"<>|]/.test(win) && win.startsWith('a_b_c') && win.endsWith('.txt'), 'Windows replaces every forbidden character');
      ok(safeStoredFilename('name. ') === 'name', 'Windows drops trailing dots and spaces');
      ok(safeStoredFilename('CON') === '_CON' && safeStoredFilename('lpt9.log') === '_lpt9.log', 'a reserved device name is prefixed');
      ok(safeStoredFilename('contour.txt') === 'contour.txt', 'a name that only starts with a reserved word is left alone');
    });
    console.log('✓ paths: safeStoredFilename strips separators/controls everywhere and applies Windows rules only on win32');

    console.log(`\nALL PATHS UNIT TESTS PASSED (${checks} checks)`);
    cleanup(0);
  } catch (e) {
    console.error('\n✗ PATHS UNIT TEST FAILED:', e.message);
    cleanup(1);
  }
})();
