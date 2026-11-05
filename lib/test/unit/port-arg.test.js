'use strict';
// Regression test for the `--port` command-line override (lib/config.js). The desktop shell
// and quick manual runs rely on it to place the server on a specific or free port without
// editing config.json, so this locks in both spellings and the default fallback. Each case
// runs in its own child process because the port is resolved once from argv at import time.
// No network. Run: `npm run test:unit`.

const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert'), { execFileSync } = require('child_process');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const CFG = path.join(PROJECT, 'lib', 'config');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

// Read a resolved config value from a fresh process with the given extra argv (the value is
// resolved once from argv at import time). The `--` stops Node from parsing our flags as its own;
// everything after it lands in process.argv for the script, which is what config.js inspects. cwd
// selects where config.json is read from — a temp dir has none, so the built-in defaults show.
const readVal = (expr, extraArgs, cwd) => execFileSync(process.execPath,
  ['-e', `process.stdout.write(String(require(${JSON.stringify(CFG)}).${expr}))`, '--', ...extraArgs],
  { cwd: cwd || PROJECT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const portWith = (extraArgs) => parseInt(readVal('PORT', extraArgs), 10);

try {
  ok(portWith(['--port', '12345']) === 12345, '`--port N` sets the port');
  ok(portWith(['--port=23456']) === 23456, '`--port=N` sets the port');
  ok(portWith(['--port', '0']) !== 0 && portWith(['--port', 'abc']) !== 0,
     'an invalid port is ignored and falls back rather than binding port 0');
  const dflt = portWith([]);
  ok(Number.isInteger(dflt) && dflt > 0, 'without the flag a sane default port is used');
  console.log(`✓ port-arg: --port overrides config, invalid values fall back (default ${dflt})`);

  // --bind and --ollama-host: the container relies on these to bind all interfaces and point at a
  // bundled Ollama without a config file. The argument must win over config.json (override case,
  // deterministic in any cwd), and the defaults must be loopback / localhost (in an empty cwd).
  ok(readVal('BIND_ADDRESS', ['--bind', '0.0.0.0']) === '0.0.0.0', '`--bind` sets the bind address');
  ok(readVal('OLLAMA_HOST', ['--ollama-host', 'http://ollama:11434']) === 'http://ollama:11434', '`--ollama-host` sets the Ollama host');
  ok(readVal('OLLAMA_HOST', ['--ollama-host=http://x:1']) === 'http://x:1', '`--ollama-host=` form works');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-cfg-'));
  try {
    ok(readVal('BIND_ADDRESS', [], tmp) === '127.0.0.1', 'bind address defaults to loopback');
    ok(readVal('OLLAMA_HOST', [], tmp) === 'http://localhost:11434', 'Ollama host defaults to localhost');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log('✓ port-arg: --bind and --ollama-host override config and default safely');

  console.log(`\nALL PORT-ARG UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ PORT-ARG UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
