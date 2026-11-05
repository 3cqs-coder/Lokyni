'use strict';
// Static guards for the Docker setup, so its security posture and key wiring cannot silently
// regress. These are text checks on the committed files (no Docker daemon needed): the container
// must stay non-root with a read-only root filesystem, publish only to host loopback, and never
// publish the bundled Ollama's port; the Ollama image must stay pinned. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const DOCKER = path.resolve(__dirname, '..', '..', '..', 'docker');
const ROOT = path.resolve(__dirname, '..', '..', '..');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

try {
  const dockerfile = fs.readFileSync(path.join(DOCKER, 'Dockerfile'), 'utf-8');
  const compose = fs.readFileSync(path.join(DOCKER, 'docker-compose.yml'), 'utf-8');
  ok(fs.existsSync(path.join(DOCKER, 'healthcheck.js')), 'healthcheck.js exists');
  const dockerignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf-8');
  ok(/^config\/config\.json$/m.test(dockerignore), '.dockerignore excludes config/config.json (no secrets in the image)');
  ok(/^package-lock\.json$/m.test(dockerignore), '.dockerignore excludes the lockfile');

  // ── writable-state contract ──
  // The named volume is owned by the image user. A host bind mount must be made writable by uid 1000,
  // and startup must say so instead of failing with a generic mkdir error.
  const lokyni = fs.readFileSync(path.join(ROOT, 'lokyni.js'), 'utf-8');
  const readme = fs.readFileSync(path.join(ROOT, 'docs', 'README.md'), 'utf-8');
  ok(/probeWritable/.test(lokyni), 'startup probes the data and configuration directories for writability');
  ok(/cannot write to its \$\{label\}/.test(lokyni), 'an unwritable directory produces an actionable startup message');
  ok(/chown -R 1000:1000/.test(compose), 'the compose file documents the host-folder ownership fix');
  ok(/chown -R 1000:1000/.test(readme), 'the README documents the host-folder ownership fix');
  ok(/Using a host folder for state/.test(readme), 'the README explains using a host folder for state');
  ok(/What happens when the disk fills\?/.test(readme), 'the FAQ covers a full disk');
  ok(/lokyni-state:\/state/.test(compose), 'the named state volume is mounted at /state');
  ok(/^WORKDIR \/state$/m.test(dockerfile) && /HOME=\/state/.test(dockerfile), 'the app runs from the persisted /state directory');

  // ── Dockerfile ──
  ok(/^USER node$/m.test(dockerfile), 'the image runs as the non-root node user');
  // The Docker base image must use the exact Node the desktop app bundles and CI tests against, so all three
  // packaging modes run on one runtime rather than drifting apart (native addons are N-API, but exercising one
  // build everywhere is the point). Ties the Dockerfile FROM to desktop.yml.
  {
    const desktopYml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'desktop.yml'), 'utf-8');
    const desktopPin = (desktopYml.match(/NODE_VERSION:\s*['"]?(\d+\.\d+\.\d+)/) || [])[1];
    const dockerPins = [...dockerfile.matchAll(/FROM node:(\d+\.\d+\.\d+)-/g)].map((m) => m[1]);
    ok(desktopPin && dockerPins.length >= 2, 'both the desktop Node version and the Docker base versions are declared');
    ok(dockerPins.every((v) => v === desktopPin), `every Docker stage uses Node ${desktopPin} (the desktop/CI runtime) — no cross-mode drift`);
  }
  ok(/PUPPETEER_EXECUTABLE_PATH=\/usr\/bin\/chromium/.test(dockerfile), 'Puppeteer uses the system Chromium');
  ok(/PUPPETEER_SKIP_DOWNLOAD=1/.test(dockerfile), 'Puppeteer does not download its own Chromium');
  // The slim runtime stage must ship the OpenMP runtime the native vector/ML modules link against, or
  // faiss-node / onnxruntime can fail to load and search silently dies (the builder got it via g++).
  ok(/libgomp1/.test(dockerfile), 'the runtime stage installs libgomp1 for the native vector/ML modules');
  // tini as PID 1 reaps re-parented processes (Chromium helpers) and forwards signals on `docker run`.
  ok(/\btini\b/.test(dockerfile) && /ENTRYPOINT \["\/usr\/bin\/tini", "--"\]/.test(dockerfile), 'the image runs under tini as PID 1');
  // The config template ships for parity with the other two distributions.
  ok(/config\/config\.json\.default/.test(dockerfile), 'the config template is shipped for parity');
  ok(/HEALTHCHECK/.test(dockerfile), 'the image declares a HEALTHCHECK');
  ok(/--bind["\s,]+0\.0\.0\.0/.test(dockerfile), 'the server binds all interfaces inside the container');
  // Binding 0.0.0.0 must be paired with the enforced Host guard, or the rebinding defense would be
  // off despite the loopback-only publish.
  ok(/--enforce-host-guard/.test(dockerfile), 'the image enforces the Host guard despite the 0.0.0.0 bind');
  ok(/--enforce-host-guard/.test(compose), 'the compose command enforces the Host guard');

  // ── compose: hardening ──
  ok(/read_only:\s*true/.test(compose), 'the container root filesystem is read-only');
  ok(/no-new-privileges:true/.test(compose), 'no-new-privileges is set');
  ok(/cap_drop:\s*\[ALL\]/.test(compose), 'all Linux capabilities are dropped');
  // PID-1 init for clean shutdown is provided by the image's tini ENTRYPOINT (asserted above), so compose must
  // NOT add a second, redundant `init:` on top of it.
  ok(!/^\s*init:\s*true/m.test(compose), 'compose does not add a redundant init (the image ENTRYPOINT already runs tini as PID 1)');

  // ── compose: network exposure ──
  ok(/127\.0\.0\.1:7887:7887/.test(compose), 'Lokyni publishes to host loopback only');
  ok(!/\n\s*-\s*"?7887:7887"?/.test(compose), 'Lokyni is not published on all interfaces (0.0.0.0)');

  // ── port drift guard ──
  // The Dockerfile EXPOSE, both container start commands, and the compose publish mapping all hardcode
  // the port; the healthcheck derives its probe port from constants.DEFAULT_PORT. If DEFAULT_PORT ever
  // changed, the server would bind the new port while the healthcheck probed it (or the publish mapping
  // no longer reached it) — a healthy container marked unhealthy, looping restarts. Tie every literal to
  // DEFAULT_PORT so a change is caught here, not in production.
  const { DEFAULT_PORT } = require(path.join(ROOT, 'lib', 'constants'));
  const P = String(DEFAULT_PORT);
  ok(new RegExp(`EXPOSE ${P}\\b`).test(dockerfile), 'the Dockerfile EXPOSE matches constants.DEFAULT_PORT');
  ok(new RegExp(`"--port", "${P}"`).test(dockerfile), 'the Dockerfile start command port matches constants.DEFAULT_PORT');
  ok(new RegExp(`"--port", "${P}"`).test(compose), 'the compose start command port matches constants.DEFAULT_PORT');
  ok(new RegExp(`127\\.0\\.0\\.1:${P}:${P}`).test(compose), 'the compose publish mapping matches constants.DEFAULT_PORT');

  // The bundled Ollama has no authentication, so its port must never be published to the host. The
  // ollama service is the last one in the file, so nothing after its declaration may map a port.
  const ollamaIdx = compose.indexOf('\n  ollama:');
  ok(ollamaIdx !== -1, 'the compose file defines a bundled ollama service');
  const afterOllama = compose.slice(ollamaIdx);
  ok(!/\n\s+ports:/.test(afterOllama), 'the bundled Ollama publishes no host port');

  // ── compose: Ollama image is pinned (an unpinned :latest can strand the model volume) ──
  ok(/image:\s*ollama\/ollama:\d+\.\d+\.\d+/.test(compose), 'the Ollama image is pinned to an exact version');
  ok(!/ollama\/ollama:latest/.test(compose), 'the Ollama image is not :latest');

  // ── Dead-toolchain prune stays in sync with the desktop bundle ──
  // The never-instantiated cloud-model TypeScript toolchain is a production-transitive dependency, so
  // it rides into both the desktop bundle and the Docker image unless explicitly pruned. The desktop
  // bundle prunes it (src-tauri/prepare-sidecar.js PRUNE); the Docker image must prune the same
  // runtime-relevant packages, or one distribution silently ships ~30 MB the other dropped.
  const sidecar = fs.readFileSync(path.join(ROOT, 'src-tauri', 'prepare-sidecar.js'), 'utf-8');
  // The build-only @tauri-apps entry is a devDependency (never in a --omit=dev install), so only the
  // runtime-present packages are required in the Docker prune.
  for (const pkg of ['@ibm-cloud', 'ts-node', 'typescript']) {
    ok(sidecar.includes(`'${pkg}'`), `prepare-sidecar prunes ${pkg} from the desktop bundle`);
    ok(new RegExp(`rm -rf[^\\n]*node_modules/${pkg.replace('/', '\\/')}(\\s|$)`).test(dockerfile),
      `the Dockerfile prunes ${pkg} from the runtime image (parity with the desktop bundle)`);
  }

  // ── cluster compose: a primary + a read replica over one shared volume ──
  // The replica listens on its own port, so its health probe MUST target that port (the shared healthcheck
  // defaults to constants.DEFAULT_PORT); without HEALTHCHECK_PORT the replica is reported unhealthy forever.
  const cluster = fs.readFileSync(path.join(DOCKER, 'docker-compose.cluster.yml'), 'utf-8');
  const replicaPort = (cluster.match(/--replica",\s*"--port",\s*"(\d+)"/) || [])[1];
  ok(replicaPort && replicaPort !== P, 'the cluster replica runs on its own port, distinct from the primary');
  ok(new RegExp(`HEALTHCHECK_PORT=${replicaPort}`).test(cluster),
    'the cluster replica sets HEALTHCHECK_PORT to its own port (so it is not unhealthy forever)');
  ok(new RegExp(`"--primary",\\s*"--port",\\s*"${P}"`).test(cluster), 'the cluster primary runs on constants.DEFAULT_PORT');
  ok(new RegExp(`127\\.0\\.0\\.1:${P}:${P}`).test(cluster) && new RegExp(`127\\.0\\.0\\.1:${replicaPort}:${replicaPort}`).test(cluster),
    'both cluster instances publish to host loopback only, each on its own port');
  ok(/--enforce-host-guard/.test(cluster) && (cluster.match(/--enforce-host-guard/g) || []).length >= 2,
    'both cluster instances keep the host guard on (they bind 0.0.0.0 in the container)');
  ok(/image: lokyni/.test(cluster) && /ollama\/ollama:\d/.test(cluster), 'the cluster file reuses the lokyni image and a pinned Ollama');
  console.log('✓ docker: the cluster compose runs a primary + replica on distinct ports with a correct per-node health probe');

  console.log(`\nALL DOCKER UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ DOCKER UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
