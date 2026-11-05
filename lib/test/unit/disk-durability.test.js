'use strict';
// Guards the directory-fsync durability step (lib/disk.js). The atomic writers fsync a renamed file's bytes,
// but on POSIX the directory entry that makes the new name visible is a separate write — a crash just after a
// returned rename() can lose it. The durable writers now fsync the containing directory after the rename.
// A crash can't be simulated in a unit test, so this verifies the helpers are safe (never throw, no-op on an
// invalid/Windows-unsupported target), the atomic writers still round-trip, and the wiring is in place.
// Run: `npm run test:unit`.

const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const disk = require(path.join(PROJECT, 'lib', 'disk'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-disk-'));
const done = (code) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} process.exitCode = code; };

(async () => {
  try {
    // ── fsyncDirSync / fsyncDir: best-effort, never throw (valid dir, missing dir, a file-not-dir) ──
    disk.fsyncDirSync(dir);                                   // valid directory
    disk.fsyncDirSync(path.join(dir, 'nope'));                // missing — must not throw
    await disk.fsyncDir(dir);
    await disk.fsyncDir(path.join(dir, 'nope'));
    const aFile = path.join(dir, 'f.txt'); fs.writeFileSync(aFile, 'x');
    disk.fsyncDirSync(aFile);                                 // a file, not a dir — must not throw
    await disk.fsyncDir(aFile);
    ok(true, 'fsyncDir/fsyncDirSync never throw on valid, missing, or non-directory targets');

    // ── the durable writers still round-trip correctly (regression) ──
    const jf = path.join(dir, 'sync.json');
    disk.writeFileAtomic(jf, JSON.stringify({ a: 1 }), 0o600);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(jf, 'utf-8')), { a: 1 }); checks++;
    ok((fs.statSync(jf).mode & 0o777) === 0o600 || process.platform === 'win32', 'writeFileAtomic applies the mode (POSIX)');
    const af = path.join(dir, 'async.json');
    await disk.writeJsonAtomic(af, { b: 2 });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(af, 'utf-8')), { b: 2 }); checks++;
    // No temp files are left behind by a successful write.
    ok(!fs.readdirSync(dir).some(n => n.includes('.tmp-')), 'no leftover temp files after a successful atomic write');

    // ── wiring guards: the durable writers and the FAISS store save fsync the directory after the rename ──
    const src = fs.readFileSync(path.join(PROJECT, 'lib', 'disk.js'), 'utf-8');
    ok(/renameSyncWithRetry\(tmp, file\);\s*\n\s*fsyncDirSync\(path\.dirname\(file\)\)/.test(src), 'writeFileAtomic fsyncs the dir after the sync rename');
    ok(/await renameWithRetry\(tmp, file\);\s*\n\s*await fsyncDir\(path\.dirname\(file\)\)/.test(src), 'writeJsonAtomic fsyncs the dir after the async rename');
    const delta = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'delta.js'), 'utf-8');
    ok(/await require\('\.\.\/disk'\)\.fsyncDir\(dir\);/.test(delta), 'saveStoreAtomic fsyncs the bank/cache dir after renaming the store files');

    console.log(`✓ disk-durability: the rename itself is made durable (dir fsync), writers still round-trip (${checks} checks)`);
    done(0);
  } catch (e) {
    console.error('✗ disk-durability:', e && e.message);
    done(1);
  }
})();
