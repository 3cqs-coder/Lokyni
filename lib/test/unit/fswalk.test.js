'use strict';
// Guards the shared depth-first file walker (lib/fswalk.js) that backup's file list and the workspace file
// count are both built on. Verifies: recursion into subfolders, relative-path output, the skipName policy
// (applied to both files and directories, before descent), error-swallowing on an unreadable/missing dir,
// that symlinks are not followed, and that listFiles/countFiles agree. Run: `npm run test:unit`.

const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { walkFiles, listFiles, countFiles, walkFilesAsync, listFilesAsync } = require(path.join(PROJECT, 'lib', 'fswalk'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-fswalk-'));
const cleanup = (code) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} process.exitCode = code; };

try {
  // Tree: a.txt, sub/b.txt, sub/deep/c.txt, .hidden, .DS_Store, sub/.dotdir/x.txt
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  fs.mkdirSync(path.join(dir, 'sub', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'b');
  fs.writeFileSync(path.join(dir, 'sub', 'deep', 'c.txt'), 'c');
  fs.writeFileSync(path.join(dir, '.hidden'), 'h');
  fs.writeFileSync(path.join(dir, '.DS_Store'), 'junk');
  fs.mkdirSync(path.join(dir, 'sub', '.dotdir'));
  fs.writeFileSync(path.join(dir, 'sub', '.dotdir', 'x.txt'), 'x');

  // ── no skip: every file, relative paths, recursive ──
  const all = listFiles(dir).map(p => p.replace(/\\/g, '/')).sort();
  assert.deepStrictEqual(all, ['.DS_Store', '.hidden', 'a.txt', 'sub/.dotdir/x.txt', 'sub/b.txt', 'sub/deep/c.txt']); checks++;
  ok(countFiles(dir) === 6, 'countFiles matches the full list length');

  // ── skip named OS junk only (backup's policy): dotfiles that are real files are KEPT ──
  const OS_JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
  const backupList = listFiles(dir, (n) => OS_JUNK.has(n)).map(p => p.replace(/\\/g, '/')).sort();
  assert.deepStrictEqual(backupList, ['.hidden', 'a.txt', 'sub/.dotdir/x.txt', 'sub/b.txt', 'sub/deep/c.txt']); checks++;
  ok(!backupList.includes('.DS_Store'), 'named OS junk is skipped');
  ok(backupList.includes('.hidden'), 'a real dotfile is NOT dropped (backup must never lose a document)');

  // ── skip all dotentries (countFiles' policy): dot-dirs are not descended, dotfiles excluded ──
  const docCount = countFiles(dir, (n) => n.startsWith('.'));
  ok(docCount === 3, 'dot-policy counts only a.txt, sub/b.txt, sub/deep/c.txt (dotfile + dot-dir contents excluded)');

  // ── skipName applies to directories before descent ──
  const noSub = listFiles(dir, (n) => n === 'sub').map(p => p.replace(/\\/g, '/')).sort();
  assert.deepStrictEqual(noSub, ['.DS_Store', '.hidden', 'a.txt']); checks++;

  // ── unreadable / missing root → empty, never throws ──
  ok(listFiles(path.join(dir, 'does-not-exist')).length === 0, 'a missing directory yields an empty list, no throw');
  ok(countFiles(path.join(dir, 'does-not-exist')) === 0, 'a missing directory counts 0');

  // ── symlinks are not followed (isDirectory/isFile are both false for a symlink Dirent) ──
  let symlinkMade = false;
  try {
    fs.symlinkSync(path.join(dir, 'sub'), path.join(dir, 'link-to-sub'));
    symlinkMade = true;
  } catch { /* some platforms/CI disallow symlinks — skip that assertion */ }
  if (symlinkMade) {
    const withLink = listFiles(dir).map(p => p.replace(/\\/g, '/'));
    ok(!withLink.some(p => p.startsWith('link-to-sub/')), 'a directory symlink is not followed');
  }

  // ── walkFiles passes both the full path and the correct relative path ──
  const pairs = [];
  walkFiles(dir, (full, rel) => pairs.push([full, rel]), (n) => n.startsWith('.') || n === 'link-to-sub');
  ok(pairs.every(([full, rel]) => full.endsWith(rel) && path.isAbsolute(full)), 'onFile gets an absolute full path and a matching relative path');

  // ── the async variant agrees exactly and awaits an async callback (used by the backup planning pass) ──
  (async () => {
    const asyncList = (await listFilesAsync(dir, (n) => OS_JUNK.has(n))).map(p => p.replace(/\\/g, '/')).sort();
    assert.deepStrictEqual(asyncList, backupList); checks++;
    const seen = [];
    await walkFilesAsync(dir, async (full, rel) => { await Promise.resolve(); seen.push(rel); },
      (n) => n.startsWith('.') || n === 'link-to-sub');
    ok(seen.length === pairs.length && seen.every((r) => pairs.some(([, p2]) => p2 === r)),
      'the async walker visits the same files and awaits its callback');
    console.log(`✓ fswalk: depth-first walk with a skip policy, error-safe, symlink-safe (${checks} checks)`);
    cleanup(0);
  })().catch((e) => { console.error('✗ fswalk async:', e && e.message); cleanup(1); });
} catch (e) {
  console.error('✗ fswalk:', e && e.message);
  cleanup(1);
}
