'use strict';
// Keeps the Safari pass, its npm command, and its documentation from drifting apart. The pass needs a
// one-time macOS setting that cannot be enabled from this repository, so the most likely future breakage
// is a renamed command or a doc that stops mentioning the setting. This test is intentionally narrow: it
// checks the wiring and the operator-facing instructions, not the browser steps themselves.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(PROJECT, p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

try {
  const pkg = JSON.parse(read('package.json'));
  ok(pkg.scripts && pkg.scripts['e2e:safari'] === 'node lib/test/e2e/safari.js',
    'package.json exposes `npm run e2e:safari` for the Safari pass');
  ok(fs.existsSync(path.join(PROJECT, 'lib', 'test', 'e2e', 'safari.js')),
    'the Safari runner file exists');
  ok(!/e2e:safari/.test(pkg.scripts['test:e2e'] || ''),
    'the Safari pass stays out of the cross-platform e2e command');
  ok(pkg.scripts['e2e:safari:probe'] === 'node lib/test/e2e/safari.js --probe',
    'the probe has one npm command');

  const runner = read('lib/test/e2e/safari.js');
  const docs = read('docs/README.md');

  // The runner starts the shared harness rather than a second copy of the fixture server.
  ok(/require\('\.\/harness'\)/.test(runner), 'the Safari pass reuses the shared e2e harness');
  ok(/startHarness/.test(runner), 'the Safari pass starts the shared harness');

  // Both halves of the macOS permission are named in the runner and in the docs, so an operator who sees
  // either message can follow it without guessing.
  for (const phrase of ['Show features for web developers', 'Allow Remote Automation']) {
    ok(runner.includes(phrase), `the runner names the Safari setting: ${phrase}`);
    ok(docs.includes(phrase), `the docs name the Safari setting: ${phrase}`);
  }
  ok(/return 2/.test(runner), 'the runner exits with a distinct code when the permission is missing');
  ok(/test-results/.test(runner) && docs.includes('test-results/'),
    'the runner and the docs agree on where screenshots land');
  ok(docs.includes('npm run e2e:safari'), 'the docs name the Safari command');
  ok(docs.includes('npm run e2e:safari:probe'), 'the docs name the probe command');

  // The dispatch-only workflow must call the same script, upload the same screenshots, and treat a missing
  // Safari permission as a warning rather than a false failure.
  const workflowPath = '.github/workflows/safari.yml';
  ok(fs.existsSync(path.join(PROJECT, workflowPath)), 'the dispatch-only Safari workflow exists');
  const workflow = read(workflowPath);
  ok(/workflow_dispatch:/.test(workflow), 'the Safari workflow is dispatch-only');
  ok(/runs-on:\s*macos/.test(workflow), 'the Safari workflow runs on macOS');
  ok(/npm run e2e:safari/.test(workflow), 'the workflow uses the same npm command as the docs');
  ok(/test-results\//.test(workflow), 'the workflow uploads the same screenshots');
  ok(/timeout-minutes:/.test(workflow), 'the job is bounded by a timeout');
  ok(/-eq 2/.test(workflow) && /::warning::/.test(workflow),
    'a missing Safari permission is a warning, not a false failure');
  ok(/--probe/.test(runner) && /module\.exports = \{ main, probe \}/.test(runner),
    'the runner exposes a reusable capability probe');
  ok(/id: probe/.test(workflow) && /npm run e2e:safari:probe/.test(workflow),
    'the workflow uses the shared probe command before running the pass');
  ok(/steps\.probe\.outputs\.available/.test(workflow) && /if: steps\.probe\.outputs\.available == 'true'/.test(workflow),
    'the pass runs only after a successful probe');
  ok((workflow.match(/continue-on-error: true/g) || []).length >= 2,
    'the setup and probe steps cannot fail the job for a runner limitation');
  ok(/environment limitation, not a build failure/.test(workflow),
    'the skip path says a hosted-runner limitation is not a build failure');
  ok(/safari-probe\.log/.test(workflow) && /sed -n/.test(workflow),
    'the skip summary reuses the probe output instead of duplicating the manual steps');
  ok(/SPANISH_QUESTION/.test(runner) && /SPANISH_ANSWER/.test(runner),
    'the Safari pass covers a non-English answer');
  ok(/Safari pass/.test(docs) || /safari\.yml/.test(docs), 'the docs mention the Safari workflow');

  // Importing the module must not launch Safari or a server; only the CLI entry point runs the pass.
  const mod = require(path.join(PROJECT, 'lib', 'test', 'e2e', 'safari.js'));
  ok(typeof mod.main === 'function', 'the runner exports main without starting anything on import');

  // The command the docs promise must be the one the runner implements.
  ok(/safaridriver/.test(runner), 'the runner drives the built-in Safari WebDriver');
  ok(/axe/.test(runner), 'the Safari pass includes an accessibility audit');

  console.log(`\nALL SAFARI-PASS UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\nSAFARI-PASS UNIT TESTS FAILED');
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
}
