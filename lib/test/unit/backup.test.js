'use strict';
// Regression tests for backup restore data-safety (lib/backup.js). These lock in the
// guarantee that a restore can NEVER destroy the existing workspace: a wrong passphrase or
// a corrupt archive must leave the current data intact (the restore stages then swaps only
// after full verification), a correct restore must replace the contents, and a failed
// restore into a new workspace must not leave a phantom registered. Uses a real encrypted
// backup written and read through the module — no network, no model. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), os = require('os');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const B = require(path.join(PROJECT, 'lib', 'backup'));
const wsm = require(path.join(PROJECT, 'lib', 'workspaces'));

let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) throw new Error(msg); };

// writeBackup streams to a Writable; wait for the file to finish.
const writeToFile = (dataDir, id, file, opts) => new Promise((resolve, reject) => {
  const s = fs.createWriteStream(file);
  s.on('error', reject);
  s.on('close', resolve);
  B.writeBackup(dataDir, id, s, opts).then(() => { if (!s.writableEnded) s.end(); }).catch(reject);
});

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-bktest-'));
  try {
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    wsm.ensureWorkspace(dataDir, 'default');
    const wsDir = wsm.workspaceDir(dataDir, 'default');
    fs.mkdirSync(path.join(wsDir, 'documents'), { recursive: true });
    fs.mkdirSync(path.join(wsDir, 'vector_store'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'documents', 'orig.txt'), 'ORIGINAL v1');
    fs.writeFileSync(path.join(wsDir, 'vector_store', 'index.faiss'), 'OLDINDEX');

    const bk = path.join(root, 'backup.lkb');
    await writeToFile(dataDir, 'default', bk, { passphrase: 'correct-horse' });
    ok(fs.existsSync(bk) && fs.statSync(bk).size > 0, 'an encrypted backup is produced');

    // Mutate the live workspace so we can detect whether a failed restore preserved it.
    fs.writeFileSync(path.join(wsDir, 'documents', 'orig.txt'), 'MODIFIED v2');
    fs.writeFileSync(path.join(wsDir, 'documents', 'extra.txt'), 'EXTRA');

    // 1) Wrong passphrase, overwrite=true → must throw AND leave the live data untouched.
    let threw = false;
    try { await B.restoreBackup(dataDir, bk, { passphrase: 'WRONG', overwrite: true }); }
    catch { threw = true; }
    ok(threw, 'a wrong passphrase rejects the restore');
    ok(fs.readFileSync(path.join(wsDir, 'documents', 'orig.txt'), 'utf8') === 'MODIFIED v2', 'existing data survives a wrong-passphrase restore');
    ok(fs.existsSync(path.join(wsDir, 'documents', 'extra.txt')), 'a file added after the backup survives a failed restore');
    const leftover = fs.readdirSync(path.dirname(wsDir)).filter(n => /\.restoring|\.old-/.test(n));
    ok(leftover.length === 0, 'a failed restore leaves no staging/aside directories behind');
    console.log('✓ backup: a wrong passphrase never destroys the existing workspace');

    // 1b) Restore drill: verify the SAME archive end to end into a throwaway staging dir. It must prove every
    // file decrypts and checksums, leave the live workspace byte-for-byte untouched, register nothing, and
    // leave no temporary directory behind.
    const registryBefore = wsm.loadRegistry(dataDir).length;
    const verify = await B.restoreBackup(dataDir, bk, { passphrase: 'correct-horse', verify: true });
    ok(verify && verify.verified === true, 'a verify drill reports success');
    ok(verify.documents >= 1, 'the drill counts the documents it checked');
    ok(verify.workspaceId === 'default', 'the drill reports the archive workspace, not a uniquified target');
    ok(verify.encrypted === true, 'the drill reports that the archive was encrypted');
    ok(fs.readFileSync(path.join(wsDir, 'documents', 'orig.txt'), 'utf8') === 'MODIFIED v2', 'a verify drill leaves live data untouched');
    ok(fs.existsSync(path.join(wsDir, 'documents', 'extra.txt')), 'a verify drill leaves added files in place');
    ok(wsm.loadRegistry(dataDir).length === registryBefore, 'a verify drill registers no workspace');
    const drillLeftovers = fs.readdirSync(dataDir).filter(n => /^\.backup-verify-/.test(n));
    ok(drillLeftovers.length === 0, 'a verify drill removes its staging directory');
    let drillThrew = false;
    try { await B.restoreBackup(dataDir, bk, { passphrase: 'WRONG', verify: true }); } catch { drillThrew = true; }
    ok(drillThrew, 'a verify drill rejects the wrong passphrase');
    ok(fs.readFileSync(path.join(wsDir, 'documents', 'orig.txt'), 'utf8') === 'MODIFIED v2', 'a failed drill still leaves live data untouched');
    ok(fs.readdirSync(dataDir).filter(n => /^\.backup-verify-/.test(n)).length === 0, 'a failed drill cleans up too');
    console.log('✓ backup: the restore drill verifies every file without touching live data');

    // 2) Corrupt/truncated archive → must throw and preserve data.
    const truncated = path.join(root, 'trunc.lkb');
    fs.writeFileSync(truncated, fs.readFileSync(bk).subarray(0, 40));
    let threw2 = false;
    try { await B.restoreBackup(dataDir, truncated, { passphrase: 'correct-horse', overwrite: true }); }
    catch { threw2 = true; }
    ok(threw2, 'a corrupt/truncated archive rejects the restore');
    ok(fs.readFileSync(path.join(wsDir, 'documents', 'orig.txt'), 'utf8') === 'MODIFIED v2', 'existing data survives a corrupt-archive restore');
    console.log('✓ backup: a corrupt archive never destroys the existing workspace');

    // 3) Correct restore → replaces contents (v1 back, extra.txt gone, index restored).
    await B.restoreBackup(dataDir, bk, { passphrase: 'correct-horse', overwrite: true });
    ok(fs.readFileSync(path.join(wsDir, 'documents', 'orig.txt'), 'utf8') === 'ORIGINAL v1', 'a correct restore brings back the backed-up content');
    ok(!fs.existsSync(path.join(wsDir, 'documents', 'extra.txt')), 'a correct overwrite restore removes files not in the backup');
    ok(fs.readFileSync(path.join(wsDir, 'vector_store', 'index.faiss'), 'utf8') === 'OLDINDEX', 'the index is restored from the backup');
    ok(fs.readdirSync(path.dirname(wsDir)).filter(n => /\.restoring|\.old-/.test(n)).length === 0, 'a successful restore leaves no staging/aside directories');
    console.log('✓ backup: a correct restore replaces contents cleanly');

    // 4) Failed restore into a NEW workspace id → no phantom left registered.
    const before = wsm.loadRegistry(dataDir).length;
    let threw3 = false;
    try { await B.restoreBackup(dataDir, truncated, { passphrase: 'correct-horse', targetId: 'brandnew' }); }
    catch { threw3 = true; }
    ok(threw3, 'a failed restore into a new id rejects');
    ok(wsm.loadRegistry(dataDir).length === before, 'a failed restore into a new id leaves no phantom workspace registered');
    ok(!fs.existsSync(wsm.workspaceDir(dataDir, 'brandnew')), 'the phantom workspace directory is removed');
    console.log('✓ backup: a failed restore into a new workspace leaves no phantom');

    // 5) Key-derivation hardening. A freshly written encrypted archive must advertise the
    //    strengthened scrypt parameters in its header (N well above the old 2^14), and the reader
    //    must keep a legacy fallback so archives written before the header carried kdf still open.
    const { header: hdr } = await B.readHeader(bk);
    ok(hdr && hdr.kdf && hdr.kdf.N >= 131072 && hdr.kdf.r === 8 && hdr.kdf.p === 1,
      'a new encrypted backup records the strengthened scrypt parameters in its header');
    const src = fs.readFileSync(path.join(PROJECT, 'lib', 'backup.js'), 'utf8');
    ok(/deriveKey\(passphrase, salt, header\.kdf \|\| LEGACY_KDF\)/.test(src),
      'the reader falls back to the legacy scrypt parameters for archives written before the header carried kdf');
    ok(/const LEGACY_KDF = \{ N: 16384,/.test(src),
      'the legacy scrypt parameters match what pre-change archives were written with');
    console.log('✓ backup: new archives use strengthened key derivation with a legacy read fallback');

    // ── Restore-integrity guards (on the UNENCRYPTED path, so the header can be surgically tampered
    //    without re-sealing a GCM tag — the guards being tested are independent of encryption). ──
    // Reset the workspace to a known state and take a clean unencrypted backup.
    fs.writeFileSync(path.join(wsDir, 'documents', 'orig.txt'), 'CLEAN v3');
    const plain = path.join(root, 'plain.lkb');
    await writeToFile(dataDir, 'default', plain, {});   // no passphrase → unencrypted archive
    ok(fs.existsSync(plain) && fs.statSync(plain).size > 0, 'an unencrypted backup is produced');

    // 6) Unencrypted round-trip: a correct restore replaces contents (the whole non-encrypted path).
    fs.writeFileSync(path.join(wsDir, 'documents', 'orig.txt'), 'MUTATED v4');
    await B.restoreBackup(dataDir, plain, { overwrite: true });
    ok(fs.readFileSync(path.join(wsDir, 'documents', 'orig.txt'), 'utf8') === 'CLEAN v3', 'an unencrypted backup restores its content');
    console.log('✓ backup: the unencrypted archive path round-trips');

    // Surgically patch the plaintext, length-prefixed header of an unencrypted archive.
    // Layout: MAGIC(8) + version(1) + flag(1) + headerLen:UInt32BE(4) + headerJSON + gzip payload.
    const patchHeader = (buf, mutate) => {
      const headerLen = buf.readUInt32BE(10);
      const header = JSON.parse(buf.subarray(14, 14 + headerLen).toString('utf8'));
      const payload = buf.subarray(14 + headerLen);
      mutate(header);
      const hb = Buffer.from(JSON.stringify(header), 'utf8');
      const len = Buffer.alloc(4); len.writeUInt32BE(hb.length, 0);
      return Buffer.concat([buf.subarray(0, 10), len, hb, payload]);
    };
    const plainBuf = fs.readFileSync(plain);

    // 7) A checksum mismatch (payload intact, header's sha256 wrong) is caught and preserves live data.
    fs.writeFileSync(path.join(wsDir, 'documents', 'orig.txt'), 'SURVIVOR v5');
    const badSum = path.join(root, 'badsum.lkb');
    fs.writeFileSync(badSum, patchHeader(plainBuf, (h) => {
      const e = h.entries.find(x => x.path.endsWith('orig.txt')); e.sha256 = '0'.repeat(64);
    }));
    let threwSum = false;
    try { await B.restoreBackup(dataDir, badSum, { overwrite: true }); }
    catch (e) { threwSum = /checksum mismatch/i.test(e.message); }
    ok(threwSum, 'a per-file checksum mismatch is detected and rejected');
    ok(fs.readFileSync(path.join(wsDir, 'documents', 'orig.txt'), 'utf8') === 'SURVIVOR v5', 'live data survives a checksum-mismatch restore');
    ok(fs.readdirSync(path.dirname(wsDir)).filter(n => /\.restoring/.test(n)).length === 0, 'a checksum-failed restore leaves no staging dir');
    console.log('✓ backup: a per-file checksum mismatch is rejected without touching live data');

    // 8) A path-traversal entry is refused BEFORE anything is written outside the workspace.
    const escapeTarget = path.join(root, 'escape.txt');
    try { fs.unlinkSync(escapeTarget); } catch {}
    const traversal = path.join(root, 'traversal.lkb');
    fs.writeFileSync(traversal, patchHeader(plainBuf, (h) => {
      h.entries[0].path = '../../../escape.txt';   // climbs out of the staging dir
    }));
    let threwTrav = false;
    try { await B.restoreBackup(dataDir, traversal, { overwrite: true }); }
    catch (e) { threwTrav = /outside the workspace/i.test(e.message); }
    ok(threwTrav, 'an archive entry that escapes the workspace is refused');
    ok(!fs.existsSync(escapeTarget), 'no file is written outside the workspace by a traversal entry');
    console.log('✓ backup: a path-traversal archive entry is refused and writes nothing outside the workspace');

    // 8b) A header that is valid JSON but the WRONG SHAPE (missing entries[]) is refused up front in
    // readHeader — before any staging dir or workspace registration — so a crafted .lokb can't throw a raw
    // TypeError mid-restore and strand an orphaned staging dir or a phantom workspace.
    fs.writeFileSync(path.join(wsDir, 'documents', 'orig.txt'), 'SURVIVOR v5b');
    const badShape = path.join(root, 'badshape.lkb');
    fs.writeFileSync(badShape, patchHeader(plainBuf, (h) => { delete h.entries; }));
    let threwShape = false;
    try { await B.restoreBackup(dataDir, badShape, { overwrite: true }); }
    catch (e) { threwShape = /header is corrupt/i.test(e.message); }
    ok(threwShape, 'a header missing entries[] is rejected as corrupt');
    ok(fs.readFileSync(path.join(wsDir, 'documents', 'orig.txt'), 'utf8') === 'SURVIVOR v5b', 'live data survives a shape-corrupt header');
    ok(fs.readdirSync(path.dirname(wsDir)).filter(n => /\.restoring/.test(n)).length === 0, 'a shape-corrupt header leaves no staging dir');
    console.log('✓ backup: a shape-corrupt header is refused before any staging dir or workspace is created');

    // 9) A truncated payload (declared entries not all delivered) is caught, live data preserved.
    fs.writeFileSync(path.join(wsDir, 'documents', 'orig.txt'), 'SURVIVOR v6');
    const cut = path.join(root, 'cut.lkb');
    fs.writeFileSync(cut, plainBuf.subarray(0, plainBuf.length - 20));   // lop off the tail of the gzip payload
    let threwCut = false;
    try { await B.restoreBackup(dataDir, cut, { overwrite: true }); }
    catch (e) { threwCut = /truncated|corrupt/i.test(e.message); }
    ok(threwCut, 'a truncated payload is rejected');
    ok(fs.readFileSync(path.join(wsDir, 'documents', 'orig.txt'), 'utf8') === 'SURVIVOR v6', 'live data survives a truncated-archive restore');
    console.log('✓ backup: a truncated payload is rejected without touching live data');

    // 9b) A non-integer entry size is rejected as corrupt in readHeader — BEFORE the restore loop, which would
    // otherwise spin forever (remaining=NaN) holding the lifecycle lock. Must fail fast, not hang.
    fs.writeFileSync(path.join(wsDir, 'documents', 'orig.txt'), 'SURVIVOR v7');
    const badSize = path.join(root, 'badsize.lkb');
    fs.writeFileSync(badSize, patchHeader(plainBuf, (h) => { h.entries[0].size = 'abc'; }));
    let threwSize = false;
    try { await B.restoreBackup(dataDir, badSize, { overwrite: true }); } catch (e) { threwSize = /header is corrupt/i.test(e.message); }
    ok(threwSize, 'a non-integer entry size is rejected as corrupt (no infinite loop)');
    ok(fs.readFileSync(path.join(wsDir, 'documents', 'orig.txt'), 'utf8') === 'SURVIVOR v7', 'live data survives a bad-size header');

    // 9c) A hostile scrypt kdf in the header (would otherwise drive maxmem to a ~TB allocation) is rejected.
    const badKdf = path.join(root, 'badkdf.lkb');
    fs.writeFileSync(badKdf, patchHeader(plainBuf, (h) => { h.kdf = { N: 2 ** 30, r: 8, p: 1 }; }));
    let threwKdf = false;
    try { await B.restoreBackup(dataDir, badKdf, { overwrite: true }); } catch (e) { threwKdf = /header is corrupt/i.test(e.message); }
    ok(threwKdf, 'an out-of-range scrypt kdf in the header is rejected (no attacker-controlled maxmem)');

    // 9d) Two entries differing only in letter case are refused up front (silent-data-loss guard on a
    // case-insensitive volume), before any payload is written.
    const dupCase = path.join(root, 'dupcase.lkb');
    fs.writeFileSync(dupCase, patchHeader(plainBuf, (h) => { h.entries.push({ ...h.entries[0], path: h.entries[0].path.toUpperCase() }); }));
    let threwCase = false;
    try { await B.restoreBackup(dataDir, dupCase, { overwrite: true }); } catch (e) { threwCase = /letter case/i.test(e.message); }
    ok(threwCase, 'two entries differing only in case are refused (no silent overwrite on a case-insensitive FS)');
    console.log('✓ backup: hostile header fields (bad size, oversized kdf, case-collision) are rejected up front');

    // Source guards: key derivation is async (never scryptSync on the event loop) with a FIXED maxmem, and the
    // untrusted header kdf is validated/clamped.
    const kdfSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'backup.js'), 'utf8');
    ok(/crypto\.scrypt\(/.test(kdfSrc) && !/scryptSync\(/.test(kdfSrc), 'key derivation uses async crypto.scrypt, not scryptSync (no event-loop block)');
    ok(/const KDF_MAXMEM =/.test(kdfSrc) && /maxmem: KDF_MAXMEM/.test(kdfSrc), 'maxmem is a fixed ceiling, independent of the untrusted header');
    ok(/const validKdf =/.test(kdfSrc), 'header scrypt params are validated/clamped');
    ok(/const MAX_RESTORE_BYTES =/.test(kdfSrc) && /freeBytes\(path\.dirname\(wsRoot\)\)/.test(kdfSrc), 'restore caps the declared total and pre-checks free disk space');
    const serverSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'server.js'), 'utf8');
    ok(/app\.post\('\/api\/backup\/verify'[\s\S]{0,700}?verify: true/.test(serverSrc),
      'the verify route runs a drill (not a restore)');
    ok(/_backupVerifying/.test(serverSrc) && /cleanupUpload\(req\)/.test(serverSrc.slice(serverSrc.indexOf("'/api/backup/verify'"), serverSrc.indexOf("'/api/backup/restore'"))),
      'one drill at a time, and the upload is always cleaned up');
    const chatSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'public', 'js', 'chat.js'), 'utf8');
    ok(/restoreVerify\?\.addEventListener\('click'/.test(chatSrc) && /\/api\/backup\/verify/.test(chatSrc),
      'the document panel exposes the drill');
    console.log('✓ backup: async key derivation, fixed maxmem, clamped kdf, size + free-space guards, verify route');

    // ── sweepStaleTemp removes crashed backup temp artifacts (never-orphan), but only age-gated ones ──
    const tmpDir = path.join(dataDir, 'tmp');
    const uplDir = path.join(tmpDir, 'uploads');
    fs.mkdirSync(uplDir, { recursive: true });
    const oldMs = (Date.now() - 2 * 3600 * 1000) / 1000;   // 2 hours ago (older than the 1h gate)
    const oldStage = path.join(tmpDir, 'lokyni-bk-oldstage.tmp');
    const freshStage = path.join(tmpDir, 'lokyni-bk-freshstage.tmp');
    const oldUpload = path.join(uplDir, 'old-upload');
    const freshUpload = path.join(uplDir, 'fresh-upload');
    const keepFile = path.join(tmpDir, 'keep-me.dat');   // not a backup temp — must be left alone
    for (const p of [oldStage, freshStage, oldUpload, freshUpload, keepFile]) fs.writeFileSync(p, 'x');
    fs.utimesSync(oldStage, oldMs, oldMs);
    fs.utimesSync(oldUpload, oldMs, oldMs);
    // A crashed restore drill leaves data/.backup-verify-*; a fresh one may be in use and must survive.
    const oldDrill = path.join(dataDir, '.backup-verify-old');
    const freshDrill = path.join(dataDir, '.backup-verify-fresh');
    fs.mkdirSync(oldDrill); fs.writeFileSync(path.join(oldDrill, 'x'), 'x');
    fs.mkdirSync(freshDrill); fs.writeFileSync(path.join(freshDrill, 'x'), 'x');
    fs.utimesSync(oldDrill, oldMs, oldMs);
    const removed = B.sweepStaleTemp(dataDir);
    ok(!fs.existsSync(oldStage), 'an old crashed create-staging temp is swept');
    ok(!fs.existsSync(oldUpload), 'an old crashed upload is swept');
    ok(!fs.existsSync(oldDrill), 'an abandoned restore-drill copy is swept');
    ok(fs.existsSync(freshStage) && fs.existsSync(freshUpload), 'fresh temps (a possible in-flight backup) are NOT swept');
    ok(fs.existsSync(freshDrill), 'a fresh drill (possibly running) is left alone');
    ok(fs.existsSync(keepFile), 'an unrelated file in tmp is left alone');
    ok(removed === 3, `sweepStaleTemp reports the count it removed (got ${removed})`);
    console.log('✓ backup: sweepStaleTemp clears crashed temp artifacts age-gated (no orphan, no in-flight loss)');

    // ── the multi-entry swap rolls back ALL completed entries on a mid-swap failure (not just the failing one) ──
    // A rename failure after some entries swapped must leave the existing workspace intact, never half-applied
    // (e.g. new documents + stale index). This is verified by source inspection: injecting a mid-swap rename
    // failure deterministically is impractical, but the cross-entry rollback contract must not silently regress.
    const bkSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'backup.js'), 'utf8');
    ok(/const done = \[\];/.test(bkSrc) && /done\.push\(\{ staged, target, aside, movedAside \}\)/.test(bkSrc),
      'the swap tracks every completed entry for a cross-entry rollback');
    ok(/for \(let i = done\.length - 1; i >= 0; i--\)/.test(bkSrc) && /renameSyncWithRetry\(d\.target, d\.staged\)/.test(bkSrc) && /renameSyncWithRetry\(d\.aside, d\.target\)/.test(bkSrc),
      'a mid-swap failure rolls back every completed entry in reverse (existing workspace restored intact)');
    console.log('✓ backup: a mid-swap failure rolls back all completed entries (no half-applied restore)');

    // ── Crash DURING the swap is recovered at boot: orphaned "<name>.old-<tag>" is put back (no data loss) ──
    // Simulate the fatal window: the live "documents" was moved aside but the staged copy was never renamed in.
    fs.writeFileSync(path.join(wsDir, 'documents', 'orig.txt'), 'LIVE DATA');
    fs.renameSync(path.join(wsDir, 'documents'), path.join(wsDir, 'documents.old-abc123def456'));
    ok(!fs.existsSync(path.join(wsDir, 'documents')), 'precondition: the live documents dir is orphaned (missing)');
    const rec = B.recoverInterruptedRestores(dataDir);
    ok(rec >= 1, 'recovery reports it put a directory back');
    ok(fs.existsSync(path.join(wsDir, 'documents', 'orig.txt')) && fs.readFileSync(path.join(wsDir, 'documents', 'orig.txt'), 'utf8') === 'LIVE DATA',
      'the orphaned live data is recovered to its place (no data loss)');
    ok(!fs.existsSync(path.join(wsDir, 'documents.old-abc123def456')), 'the .old- aside is gone after recovery');
    // A leftover aside when the target already exists (swap completed, crashed before cleanup) is just removed.
    fs.mkdirSync(path.join(wsDir, 'documents.old-feedface9999'), { recursive: true });
    B.recoverInterruptedRestores(dataDir);
    ok(!fs.existsSync(path.join(wsDir, 'documents.old-feedface9999')), 'a leftover .old- aside (target present) is removed');
    ok(fs.readFileSync(path.join(wsDir, 'documents', 'orig.txt'), 'utf8') === 'LIVE DATA', 'leftover cleanup does not touch the live dir');
    // An abandoned ".restoring-*" staging dir beside a workspace is cleared.
    const abandoned = path.join(path.dirname(wsDir), `${path.basename(wsDir)}.restoring-deadbeef0000`);
    fs.mkdirSync(abandoned, { recursive: true });
    B.recoverInterruptedRestores(dataDir);
    ok(!fs.existsSync(abandoned), 'an abandoned .restoring- staging dir is cleared at recovery');
    console.log('✓ backup: an interrupted restore swap is recovered at boot (no orphaned/lost workspace data)');

    // ── A beforeSwap (quiesce) failure aborts the restore BEFORE the destructive swap — existing data survives ──
    fs.writeFileSync(path.join(wsDir, 'documents', 'orig.txt'), 'KEEP ME v8');
    let threwQuiesce = false;
    try { await B.restoreBackup(dataDir, plain, { overwrite: true, beforeSwap: () => { throw new Error('quiesce failed'); } }); }
    catch (e) { threwQuiesce = /prepare the workspace|aborted/i.test(e.message); }
    ok(threwQuiesce, 'a beforeSwap (quiesce) failure aborts the restore');
    ok(fs.readFileSync(path.join(wsDir, 'documents', 'orig.txt'), 'utf8') === 'KEEP ME v8', 'existing data survives a quiesce-failure abort (the swap never ran)');

    // ── OS junk files are excluded from the archive ──
    fs.writeFileSync(path.join(wsDir, 'documents', 'Thumbs.db'), 'junk');
    const junkBk = path.join(root, 'junk.lkb');
    await writeToFile(dataDir, 'default', junkBk, {});
    const jh = await B.readHeader(junkBk);
    ok(!jh.header.entries.some(e => /(^|\/)(Thumbs\.db|desktop\.ini|\.DS_Store)$/.test(e.path)), 'OS junk files (Thumbs.db/desktop.ini/.DS_Store) are excluded from the backup');
    try { fs.unlinkSync(path.join(wsDir, 'documents', 'Thumbs.db')); } catch {}

    // Source guards: an OS-illegal restore filename gets a specific message, and oversized uploads a clean error.
    const cdSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'backup.js'), 'utf8');
    ok(/not allowed here/.test(cdSrc), 'an OS-illegal restore filename surfaces a specific message, not generic "corrupt"');
    const srvSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'server.js'), 'utf8');
    ok(/const uploadBackupFile =/.test(srvSrc) && /LIMIT_FILE_SIZE/.test(srvSrc), 'oversized backup uploads get a clean JSON error (not a 500)');
    console.log('✓ backup: quiesce-failure aborts safely, OS junk excluded, illegal-filename + oversized-upload handled');

    // ── v3: the cleartext header is GCM-authenticated (AAD), so tampering it fails decryption — not just a
    //    tamper of the payload. (bk is the encrypted archive created at the top with passphrase 'correct-horse'.) ──
    const encBuf = fs.readFileSync(bk);
    const tamperedHdr = path.join(root, 'tampered-hdr.lokb');
    fs.writeFileSync(tamperedHdr, patchHeader(encBuf, (h) => { const e = h.entries.find(x => x.path.endsWith('orig.txt')); if (e) e.sha256 = '0'.repeat(64); }));
    let threwAad = false;
    try { await B.restoreBackup(dataDir, tamperedHdr, { passphrase: 'correct-horse', overwrite: true }); }
    catch (e) { threwAad = /passphrase|damaged|corrupt/i.test(e.message); }
    ok(threwAad, 'tampering an encrypted archive\'s header fails decryption (the header is authenticated as AAD)');

    // A header naming an unsupported cipher is refused up front (self-describing crypto).
    const badCipher = path.join(root, 'badcipher.lokb');
    fs.writeFileSync(badCipher, patchHeader(encBuf, (h) => { h.cipher = 'aes-128-gcm'; }));
    let threwCipher = false;
    try { await B.restoreBackup(dataDir, badCipher, { passphrase: 'correct-horse', overwrite: true }); }
    catch (e) { threwCipher = /unsupported backup cipher/i.test(e.message); }
    ok(threwCipher, 'a header naming an unsupported cipher is refused');

    // A file truncated inside the header is diagnosed (bytesRead check), not mis-parsed.
    const cutHdr = path.join(root, 'cuthdr.lokb');
    fs.writeFileSync(cutHdr, encBuf.subarray(0, 20));
    let threwCutHdr = false;
    try { await B.readHeader(cutHdr); } catch (e) { threwCutHdr = /truncated|not a lokyni|corrupt/i.test(e.message); }
    ok(threwCutHdr, 'a file truncated inside the header is rejected');

    // Source guards for the v3 format (AAD on both sides, version-gated for v2 back-compat).
    const v3src = fs.readFileSync(path.join(PROJECT, 'lib', 'backup.js'), 'utf8');
    ok(/const VERSION = 3;/.test(v3src), 'the backup format version is 3');
    ok(/cipher\.setAAD\(headerBuf\)/.test(v3src) && /decipher\.setAAD\(headerBuf\)/.test(v3src), 'the header is authenticated as GCM AAD on write and restore');
    ok(/\(header\.version \|\| 0\) >= 3\) decipher\.setAAD/.test(v3src), 'the AAD check is version-gated so existing v2 encrypted backups still decrypt');
    console.log('✓ backup: v3 authenticates the header (AAD), is self-describing about the cipher, detects truncation');

    console.log(`\nALL BACKUP UNIT TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ BACKUP UNIT TEST FAILED:', e && e.message);
    process.exit(1);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
})();
