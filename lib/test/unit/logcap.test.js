'use strict';
// Regression tests for the supervisor-log cap (lib/logcap.js). A file over the cap is copied
// aside as one generation and truncated in place (so an append-mode supervisor keeps writing
// with no lost handle), and a file under the cap — or a missing one — is left untouched. Uses
// a temp dir — no network. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const { capFile } = require(path.join(PROJECT, 'lib', 'logcap'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-logcap-'));
  try {
    const f = path.join(dir, 'lokyni.log');

    // ── over the cap → rotated in place, one generation kept ──
    fs.writeFileSync(f, 'X'.repeat(5000));
    const rotated = await capFile(f, 1000);
    ok(rotated === true, 'a file over the cap is rotated');
    ok(fs.statSync(f).size === 0, 'the live file is truncated to zero in place (not renamed)');
    ok(fs.existsSync(f + '.1') && fs.readFileSync(f + '.1', 'utf-8').length === 5000, 'the prior contents are kept as .1');
    // an append after truncation lands at the start — no sparse gap
    fs.appendFileSync(f, 'new');
    ok(fs.statSync(f).size === 3, 'an append after the cap starts a fresh, small file');
    console.log('✓ logcap: an oversized file is copied aside and truncated in place');

    // ── under the cap → untouched ──
    fs.writeFileSync(f, 'small');
    ok(await capFile(f, 1000) === false, 'a file under the cap is left alone');
    ok(fs.readFileSync(f, 'utf-8') === 'small', 'its contents are unchanged');
    console.log('✓ logcap: a file under the cap is left untouched');

    // ── missing file → no-op, never throws ──
    ok(await capFile(path.join(dir, 'nope.log'), 1000) === false, 'a missing file is a safe no-op');
    console.log('✓ logcap: a missing file is a safe no-op');

    console.log(`\nALL LOGCAP UNIT TESTS PASSED (${checks} checks)`);
    process.exitCode = 0;
  } catch (e) {
    console.error('\n✗ LOGCAP UNIT TEST FAILED:', e && e.message);
    process.exitCode = 1;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
})();
