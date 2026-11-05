'use strict';
// Guards the shared JSON-list store (lib/jsonstore.js) that backs the users / members / api-keys auth stores.
// The behavior that matters: an mtime-keyed cache, fail-closed on missing/corrupt files, a corrupt file parsed
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
