'use strict';
// Guards the project license and the slim command-line entry point. The entry script (lokyni.js) must carry
// the AGPL header and keep its user-facing copy OUT of the code, in data files under lib/cli/, loaded by a
// thin, crash-proof loader. The LICENSE file must exist, be declared, and ship with the package. Run:
// `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(PROJECT, ...p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

try {
  // ── LICENSE file present and is the AGPL ──
  const license = read('LICENSE');
  ok(/GNU AFFERO GENERAL PUBLIC LICENSE/.test(license) && /Version 3/.test(license), 'LICENSE is the GNU AGPL v3');

  // ── package.json declares it and ships it ──
  const pkg = JSON.parse(read('package.json'));
  eq(pkg.license, 'AGPL-3.0-or-later', 'package.json declares the AGPL license');
  ok(Array.isArray(pkg.files) && pkg.files.includes('LICENSE'), 'the package ships the LICENSE file');

  // ── the entry script carries the AGPL header and the 3CQS copyright ──
  const entry = read('lokyni.js');
  ok(/Copyright \(C\) 2026 3CQS/.test(entry), 'lokyni.js carries the 3CQS copyright');
  ok(/GNU Affero General Public License/.test(entry) && /the LICENSE file/.test(entry), 'lokyni.js carries the AGPL notice');

  // ── CLI copy is externalized to data files, not hardcoded in the entry script ──
  ok(!/const HELP = `/.test(entry), 'the help text is no longer a hardcoded block in lokyni.js');
  ok(/require\('\.\/lib\/cli'\)\.helpText\(\)/.test(entry), '--help loads the text from lib/cli');
  ok(/require\('\.\/lib\/cli'\)\.reindexConfirm\(\)/.test(entry), '--reindex loads its prompt from lib/cli');
  ok(fs.existsSync(path.join(PROJECT, 'lib', 'cli', 'help.txt')), 'lib/cli/help.txt exists (data file)');
  ok(fs.existsSync(path.join(PROJECT, 'lib', 'cli', 'reindex-confirm.txt')), 'lib/cli/reindex-confirm.txt exists (data file)');

  // ── the loader works: port single-sourced, no leftover placeholder, prompt well-formed ──
  const cli = require(path.join(PROJECT, 'lib', 'cli'));
  const help = cli.helpText();
  const { DEFAULT_PORT } = require(path.join(PROJECT, 'lib', 'constants'));
  ok(help.length > 500, 'helpText returns the full help');
  ok(!/\{\{/.test(help), 'no unresolved {{placeholder}} remains in the help');
  ok(help.includes(`default ${DEFAULT_PORT}`), 'the port default is substituted from the single source');
  ok(/LICENSE file/.test(help), 'the help points the user to the LICENSE');
  ok(/continue: $/.test(cli.reindexConfirm()), 'the reindex prompt ends with a trailing space for the cursor');

  // ── crash-proof loader: a missing data file degrades to a built-in message, never throws ──
  ok(/catch \{ return ''; \}/.test(read('lib', 'cli', 'index.js')) && /\|\| '/.test(read('lib', 'cli', 'index.js')),
    'the loader falls back to a built-in message when a data file is unreadable');

  // ── the LICENSE travels in the Docker image too (AGPL compliance for distributed artifacts) ──
  ok(/COPY[^\n]*\bLICENSE\b/.test(read('docker', 'Dockerfile')), 'the Docker image copies the LICENSE');

  console.log(`\nALL LICENSE-AND-CLI TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ LICENSE-AND-CLI UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
