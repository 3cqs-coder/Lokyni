'use strict';
// Dependency-free container liveness probe (used by the Dockerfile HEALTHCHECK). Exits 0 when the
// server answers /status, 1 otherwise, so the image needs no curl. A 4xx still counts as alive
// (the process is up and serving) — this is a liveness check, not readiness.
const http = require('http');
// Default to the app's single-sourced default port (so the probe can't drift if that ever changes);
// HEALTHCHECK_PORT overrides it for an image built on a non-default port — this is a container probe
// with no CLI/config context, not app configuration.
const { DEFAULT_PORT } = require('../lib/constants');
const port = process.env.HEALTHCHECK_PORT || DEFAULT_PORT;
const req = http.get({ host: '127.0.0.1', port, path: '/status', timeout: 4000 }, (res) => {
  res.resume();
  process.exit(res.statusCode >= 200 && res.statusCode < 500 ? 0 : 1);
});
req.on('error', () => process.exit(1));
req.on('timeout', () => { req.destroy(); process.exit(1); });
