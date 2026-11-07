'use strict';
// Single source of truth for the RELEASE TAG SET: the desktop-installer workflow and the container-image workflow
// must fire on exactly the same version tags, so one `git tag` publishes BOTH the installers and the image. GitHub
// Actions can't share an `on:` trigger across workflows, so the tag list is unavoidably repeated — this guard makes
// the repetition safe by failing the build if the two lists ever drift apart. Pure text check, no YAML dependency.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const WF = path.join(PROJECT, '.github', 'workflows');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

// The distinctive version-tag globs (a release tag starts with a digit class or a literal v + digit class), as the
// set of quoted patterns under each workflow's `tags:`. Order-independent.
const tagSet = (file) => {
  const src = fs.readFileSync(path.join(WF, file), 'utf-8');
  const globs = [...src.matchAll(/^\s*-\s*'((?:\[0-9\]|v\[0-9\])[^']*)'/gm)].map((m) => m[1]);
  return new Set(globs);
};

try {
  const desktop = tagSet('desktop.yml');
  const docker  = tagSet('docker.yml');

  ok(desktop.size >= 2, `the desktop workflow declares release tag globs (${desktop.size})`);
  ok(docker.size >= 2, `the container-image workflow declares release tag globs (${docker.size})`);

  const missingInDocker  = [...desktop].filter((t) => !docker.has(t));
  const missingInDesktop = [...docker].filter((t) => !desktop.has(t));
  ok(missingInDocker.length === 0 && missingInDesktop.length === 0,
    `the desktop and container-image workflows fire on the SAME release tags — no drift ` +
    `(only in desktop: ${missingInDocker.join(', ') || 'none'}; only in image: ${missingInDesktop.join(', ') || 'none'})`);

  console.log('✓ workflow-tag-drift: desktop and container-image workflows share one release-tag set');
  console.log(`\nALL WORKFLOW-TAG-DRIFT UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ WORKFLOW-TAG-DRIFT UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
