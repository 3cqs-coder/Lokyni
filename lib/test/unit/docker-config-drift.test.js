'use strict';
// Guards against drift in the Docker deployment, where the same values are spelled out in several files
// that cannot import each other. Two ways they rot silently:
//   • the port: lib/constants.js DEFAULT_PORT is the single source the healthcheck derives from, but the
//     Dockerfile (EXPOSE, CMD --port) and compose (command --port, ports mapping) repeat it as literals.
//     If DEFAULT_PORT changes and a literal doesn't, the healthcheck probes a port nothing listens on and
//     the container restart-loops as "unhealthy". Dockerfile/compose syntax can't reference the constant,
//     so this test is the backstop.
//   • the security flags: compose's `command` fully overrides the Dockerfile CMD, so --bind and
//     --enforce-host-guard are declared independently in both. A hardening flag added to only one would
//     silently not reach the other (compose is the documented entry path). Assert both carry both flags.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const dockerfile = fs.readFileSync(path.join(PROJECT, 'docker', 'Dockerfile'), 'utf-8');
const compose = fs.readFileSync(path.join(PROJECT, 'docker', 'docker-compose.yml'), 'utf-8');
const { DEFAULT_PORT } = require(path.join(PROJECT, 'lib', 'constants'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const P = String(DEFAULT_PORT);

try {
  // ── every Docker port literal equals DEFAULT_PORT ──
  const expose = (dockerfile.match(/^EXPOSE\s+(\d+)/m) || [])[1];
  ok(expose === P, `Dockerfile EXPOSE (${expose}) matches DEFAULT_PORT (${P})`);
  const cmdPort = (dockerfile.match(/--port"?,?\s*"?(\d+)/) || [])[1];
  ok(cmdPort === P, `Dockerfile CMD --port (${cmdPort}) matches DEFAULT_PORT (${P})`);
  const composeCmdPort = (compose.match(/--port"?,\s*"?(\d+)/) || [])[1];
  ok(composeCmdPort === P, `compose command --port (${composeCmdPort}) matches DEFAULT_PORT (${P})`);
  // The published mapping is "127.0.0.1:<host>:<container>"; both sides must be DEFAULT_PORT.
  const mapping = (compose.match(/"127\.0\.0\.1:(\d+):(\d+)"/) || []);
  ok(mapping[1] === P && mapping[2] === P, `compose ports mapping (${mapping[1]}:${mapping[2]}) is DEFAULT_PORT on both sides`);

  // ── the DNS-rebinding / bind security flags are present in BOTH launch commands ──
  const dockerCmd = (dockerfile.match(/^CMD\s+\[.*\]/m) || [''])[0];
  const composeCmd = (compose.match(/command:\s*\[.*\]/) || [''])[0];
  for (const [label, cmd] of [['Dockerfile CMD', dockerCmd], ['compose command', composeCmd]]) {
    ok(/--bind"?,?\s*"?0\.0\.0\.0/.test(cmd), `${label} binds 0.0.0.0 (required for the published port)`);
    ok(/--enforce-host-guard/.test(cmd), `${label} keeps the DNS-rebinding host guard active despite the 0.0.0.0 bind`);
  }

  console.log('✓ docker-config-drift: port literals track DEFAULT_PORT and both launch commands carry the security flags');
  console.log(`\nALL DOCKER-CONFIG-DRIFT UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ DOCKER-CONFIG-DRIFT UNIT TEST FAILED:', e.message);
  process.exit(1);
}
