'use strict';
// Guards the --data-dir override (lib/config.js DATA_DIR). The data location defaults to ./data relative to
// the working directory (which every supported launch mode anchors), but a manual launch from an unrelated
// directory should be able to point Lokyni at a fixed data location instead of silently creating a fresh
// one wherever it happened to start. config.js reads argv at import, so this exercises it in child
// processes rather than mutating this process's cached module. Run: `npm run test:unit`.

const os = require('os'), path = require('path'), assert = require('assert');
const { execFileSync } = require('child_process');
const PROJECT = path.resolve(__dirname, '..', '..', '..');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

// Read config.DATA_DIR from a child node started with the given extra args, from the project dir so
// config.json resolves. Returns the printed DATA_DIR.
const dataDirWith = (args) => execFileSync(process.execPath,
  // `--` separates node's own options from the script args, so --data-dir reaches process.argv (as it does
  // when a real launcher runs `node lokyni.js --data-dir <path>`) instead of being parsed as a node flag.
  ['-e', `console.log(require(${JSON.stringify(path.join(PROJECT, 'lib', 'config'))}).DATA_DIR)`, '--', ...args],
  { cwd: PROJECT, encoding: 'utf-8' }).trim().split('\n').pop().trim();

try {
  ok(dataDirWith([]) === './data', 'DATA_DIR defaults to ./data when no override is given');
  // Use a platform-absolute path (a POSIX "/tmp/…" string is NOT absolute on Windows, where path.resolve
  // would prepend a drive). An already-absolute path resolves to itself on every platform.
  const absCustom = path.join(os.tmpdir(), 'lokyni-custom-data');
  const absEq = path.join(os.tmpdir(), 'lokyni-eq-data');
  ok(dataDirWith(['--data-dir', absCustom]) === path.resolve(absCustom), 'an absolute --data-dir is used verbatim');
  ok(dataDirWith(['--data-dir=' + absEq]) === path.resolve(absEq), 'the --data-dir=<path> form works too');
  // A relative override is resolved to an absolute path so it is stable regardless of a later cwd change.
  const rel = dataDirWith(['--data-dir', 'custom/here']);
  ok(path.isAbsolute(rel) && rel.endsWith(path.join('custom', 'here')), 'a relative --data-dir is resolved to an absolute path');
  console.log('✓ data-dir: --data-dir overrides the data location; default stays ./data; relative is resolved absolute');

  console.log(`\nALL DATA-DIR UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ DATA-DIR UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
