'use strict';
// Guards the per-connector npm package override (lib/mcp/connectors.js → connectorPackage).
// The default tracks the unpinned official server (caret-range dependency policy), but an
// operator can pin a version for supply-chain safety, or repoint at a replacement package.
// The spec MUST be validated to a safe npm package-spec shape so it can never smuggle an npx
// flag (a leading "-"), a local path, or shell metacharacters into the spawned command.
// Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const conn = require(path.join(PROJECT, 'lib', 'mcp', 'connectors'));
const { _connectorPackage, _SPEC_BUILDERS } = conn;

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const DEF = '@modelcontextprotocol/server-filesystem';

try {
  // ── default when no override ──
  ok(_connectorPackage({}, DEF) === DEF, 'no override returns the default package');
  ok(_connectorPackage({ package: '' }, DEF) === DEF, 'empty override returns the default');
  ok(_connectorPackage({ package: '   ' }, DEF) === DEF, 'whitespace-only override returns the default');

  // ── valid overrides pass through ──
  ok(_connectorPackage({ package: '@scope/pkg@1.2.3' }, DEF) === '@scope/pkg@1.2.3', 'pinned scoped spec passes through');
  ok(_connectorPackage({ package: '@modelcontextprotocol/server-filesystem@2025.1.0' }, DEF) === '@modelcontextprotocol/server-filesystem@2025.1.0', 'official pinned spec passes through');
  ok(_connectorPackage({ package: 'some-server' }, DEF) === 'some-server', 'unscoped name passes through');
  ok(_connectorPackage({ package: 'some-server@^2.0.0' }, DEF) === 'some-server@^2.0.0', 'caret range passes through');
  ok(_connectorPackage({ package: '@scope/pkg@latest' }, DEF) === '@scope/pkg@latest', 'dist-tag passes through');
  ok(_connectorPackage({ package: ' @scope/pkg@1.0.0 ' }, DEF) === '@scope/pkg@1.0.0', 'surrounding whitespace is trimmed');

  // ── malicious / malformed overrides are rejected ──
  const rejects = [
    '-rf',                         // bare flag
    '--version',                   // long flag
    '-y',                          // npx flag
    '../evil',                     // relative path (traversal)
    '/usr/bin/evil',               // absolute path
    './local-pkg',                 // local path
    'pkg; rm -rf /',               // shell metacharacters
    'pkg && curl evil',            // shell chaining
    'pkg | sh',                    // pipe
    'pkg $(whoami)',               // command substitution
    'pkg\nrm',                     // newline injection
    'pkg with space',              // spaces
    '@scope/',                     // scope without a name
    '@/pkg',                       // empty scope
    '.hidden',                     // name starting with a dot
  ];
  for (const bad of rejects) {
    let threw = false;
    try { _connectorPackage({ package: bad }, DEF); } catch { threw = true; }
    ok(threw, `rejects unsafe package spec: ${JSON.stringify(bad)}`);
  }

  // ── builder integration: the override flows into the spawned args, default otherwise ──
  const fsDefault = _SPEC_BUILDERS.filesystem({ path: path.resolve('/tmp/some-folder') });
  ok(fsDefault.args.includes(DEF), 'filesystem builder uses the default package by default');
  const fsPinned = _SPEC_BUILDERS.filesystem({ path: path.resolve('/tmp/some-folder'), package: '@scope/fs@1.0.0' });
  ok(fsPinned.args.includes('@scope/fs@1.0.0') && !fsPinned.args.includes(DEF), 'filesystem builder honors the package override');
  ok(fsPinned.args[0] === '-y' && fsPinned.args[1] === '@scope/fs@1.0.0', 'override lands in the package slot, not before the -y flag');

  const ghDefault = _SPEC_BUILDERS.github({ owner: 'octocat', repo: 'Hello-World' });
  ok(ghDefault.args.includes('@modelcontextprotocol/server-github'), 'github builder uses the default package by default');
  const ghPinned = _SPEC_BUILDERS.github({ owner: 'octocat', repo: 'Hello-World', package: 'gh-server@2.0.0' });
  ok(ghPinned.args.includes('gh-server@2.0.0'), 'github builder honors the package override');

  // A malformed override must make the builder throw (so it's caught at add-time, not at sync).
  let builderThrew = false;
  try { _SPEC_BUILDERS.filesystem({ path: path.resolve('/tmp/some-folder'), package: '-rf' }); } catch { builderThrew = true; }
  ok(builderThrew, 'a malformed override is rejected by the builder (validated at add-time)');

  // ── source guards: the regex and call sites stay in place ──
  const src = require('fs').readFileSync(path.join(PROJECT, 'lib', 'mcp', 'connectors.js'), 'utf-8');
  ok(/const connectorPackage = \(config, defaultPkg\)/.test(src), 'connectorPackage helper is defined');
  ok(/connectorPackage\(config, '@modelcontextprotocol\/server-filesystem'\)/.test(src), 'filesystem builder routes through connectorPackage');
  ok(/connectorPackage\(config, '@modelcontextprotocol\/server-github'\)/.test(src), 'github builder routes through connectorPackage');

  console.log(`✓ connector-package-spec: operator override validates and flows into the spawn (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('✗ connector-package-spec:', e && e.message);
  process.exit(1);
}
