'use strict';
// Guards the shared JSON-list store (lib/jsonstore.js) that backs the users / members / api-keys auth stores.
// The behavior that matters: a stat-keyed cache (mtime+size+inode, so a same-mtime change is still seen),
// fail-closed on missing/corrupt files, a corrupt file parsed
// ONCE per change (not per call — the hot-path hazard the api-key store previously had), atomic owner-only
// writes, and opt-in presence tracking for the implicit-owner "absent vs corrupt" distinction. Functional, in a
// temp dir. Run: `npm run test:unit`.

const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { createJsonStore } = require(path.join(PROJECT, 'lib', 'jsonstore'));

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lok-jsonstore-')));
const cleanup = (code) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(code); };
let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  const fileFor = (dir) => path.join(dir, 'thing.json');

  // ── Basic round-trip + absent = empty ──
  const s = createJsonStore({ file: fileFor, key: 'rows' });
  ok(Array.isArray(s.load(tmp)) && s.load(tmp).length === 0, 'an absent file loads as empty');
  s.save(tmp, [{ a: 1 }, { a: 2 }]);
  ok(s.load(tmp).length === 2 && s.load(tmp)[1].a === 2, 'save + load round-trips');
  if (process.platform !== 'win32') ok((fs.statSync(fileFor(tmp)).mode & 0o777) === 0o600, 'the file is written owner-only (0600)');

  // ── An external write (new mtime) is picked up on the next load (no stat throttling) ──
  fs.writeFileSync(fileFor(tmp), JSON.stringify({ rows: [{ a: 9 }] }));
  ok(s.load(tmp).length === 1 && s.load(tmp)[0].a === 9, 'an external change is picked up immediately (mtime cache invalidated)');

  // ── A change that lands within the mtime's resolution is STILL picked up. fs.statSync().mtimeMs is only
  //    millisecond-resolution and some filesystems (notably some CI disks) advance it coarsely, so two quick
  //    writes can share an mtime — a cache keyed on mtime ALONE would then serve the stale prior content, which
  //    for the auth stores would mean missing a revocation (a removed/disabled user). We force the collision by
  //    pinning the mtime back, so this is deterministic on EVERY filesystem (not only coarse-mtime ones). The
  //    cache must notice via size/inode. ──
  {
    const scol = createJsonStore({ file: fileFor, key: 'rows' });
    // Pin the mtime to a fixed WHOLE-SECOND value for both writes. A Date carries only millisecond precision, so
    // re-stamping with the same whole-second Date yields a bit-identical mtimeMs — truly colliding mtimes. (Using
    // the file's own Date mtime would instead drop the on-disk nanoseconds and change mtimeMs, masking the bug.)
    const pin = new Date(Math.floor(Date.now() / 1000) * 1000);
    fs.writeFileSync(fileFor(tmp), JSON.stringify({ rows: [{ a: 1 }, { a: 2 }, { a: 3 }] }));
    fs.utimesSync(fileFor(tmp), pin, pin);
    scol.invalidate();
    ok(scol.load(tmp).length === 3, 'precondition: three rows are loaded and cached (mtime pinned)');
    fs.writeFileSync(fileFor(tmp), JSON.stringify({ rows: [{ a: 1 }] }));   // fewer rows → a different byte size
    fs.utimesSync(fileFor(tmp), pin, pin);                                  // re-pin: mtimeMs is now identical
    ok(scol.load(tmp).length === 1, 'a same-mtime change (different size) is still picked up, never served stale');
  }

  // ── Corrupt file: fail-closed to empty, and NOT re-parsed every call (cached by mtime) ──
  // Spy on JSON.parse to count how many times a corrupt file is parsed across many loads.
  fs.writeFileSync(fileFor(tmp), '{ this is not json');
  s.invalidate();
  const realParse = JSON.parse;
  let parses = 0;
  JSON.parse = (txt) => { parses++; return realParse(txt); };
  try {
    for (let i = 0; i < 10; i++) ok(s.load(tmp).length === 0, 'a corrupt file loads as empty (fail-closed)');
  } finally { JSON.parse = realParse; }
  ok(parses === 1, `a corrupt file is parsed once per change, not per call (saw ${parses} parses over 10 loads)`);

  // ── sanitize() filters invalid rows ──
  const sv = createJsonStore({ file: fileFor, key: 'rows', sanitize: (rows) => (Array.isArray(rows) ? rows.filter(r => r && r.ok === true) : []) });
  fs.writeFileSync(fileFor(tmp), JSON.stringify({ rows: [{ ok: true }, { ok: false }, { nope: 1 }] }));
  sv.invalidate();
  ok(sv.load(tmp).length === 1 && sv.load(tmp)[0].ok === true, 'sanitize filters invalid rows on load');

  // ── Presence tracking: absent vs valid-empty vs corrupt ──
  const tmp2 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lok-jsonstore2-')));
  const pf = (dir) => path.join(dir, 'users.json');
  const ps = createJsonStore({ file: pf, key: 'users', trackPresence: true });
  // Absent → not present (→ an implicit-owner gate would open).
  ok(!ps.isPresent(tmp2), 'an absent file is not present');
  // Valid but empty → present + parsed + zero rows (accounts "exist" as an empty set after a write).
  ps.save(tmp2, []);
  ok(ps.isPresent(tmp2) && ps.isParsed(tmp2) && ps.load(tmp2).length === 0, 'a valid empty file is present + parsed');
  // Corrupt → present but NOT parsed (the gate must stay shut: present-but-corrupt is "accounts exist").
  fs.writeFileSync(pf(tmp2), 'garbage');
  ps.invalidate();
  ok(ps.isPresent(tmp2) && !ps.isParsed(tmp2), 'a present-but-corrupt file is present but not parsed (fail-closed)');
  fs.rmSync(tmp2, { recursive: true, force: true });

  console.log('✓ jsonstore: mtime cache, fail-closed, corrupt-parsed-once-per-change, sanitize, presence tracking');
  console.log(`\nALL JSONSTORE UNIT TESTS PASSED (${checks} checks)`);
  cleanup(0);
} catch (e) {
  console.error('\n✗ JSONSTORE UNIT TEST FAILED:', e && e.message);
  cleanup(1);
}
