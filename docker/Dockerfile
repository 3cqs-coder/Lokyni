# syntax=docker/dockerfile:1
# Lokyni server image — for self-hosting on a server, NAS, or homelab. (On a laptop, the desktop app
# or the installable web app is the simpler path.) Build context is the repository root:
#   docker build -f docker/Dockerfile -t lokyni ..
# or, more usually, through docker/docker-compose.yml.

# ── builder: install production dependencies ──────────────────────────────────
FROM node:24.11.1-bookworm-slim AS builder
# Build tools so any dependency without a prebuilt binary for this platform can still compile. faiss-node
# installs a prebuilt binary when one exists for the arch and Node ABI, and otherwise falls back to a
# source build that clones faiss and drives cmake-js — which needs git, cmake, and BLAS/LAPACK headers.
# Prebuilts cover linux amd64 and arm64 today, so this fallback is a safety net, not the usual path; it is
# included so a future release that skips an arch's prebuild degrades to a working compile instead of a
# hard build failure. All of it lives only in this builder stage and is discarded from the final image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates cmake git libopenblas-dev liblapack-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Skip Puppeteer's Chromium download: the runtime stage installs the distro Chromium instead, so the
# browser is never baked twice or fetched at runtime.
ENV PUPPETEER_SKIP_DOWNLOAD=1
# No lockfile is committed (dependencies resolve from package.json ranges); install production deps.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
# Drop the never-instantiated cloud-model TypeScript toolchain (a transitive dependency of the
# LangChain community package). The app never constructs that integration, so removing it only trims
# image size (~30 MB) with no behavior change. This is the same idea as the PRUNE list in
# src-tauri/prepare-sidecar.js, but the lists differ on purpose: that one also drops @tauri-apps, which
# this image never has because it installs with --omit=dev (@tauri-apps/cli is a devDependency). Both
# lists are pure size optimizations — a divergence can only affect image size, never behavior.
RUN rm -rf node_modules/@ibm-cloud node_modules/ts-node node_modules/typescript

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:24.11.1-bookworm-slim AS runtime
LABEL org.opencontainers.image.title="Lokyni" \
      org.opencontainers.image.description="Local, private document AI — grounded, cited answers over your own files." \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"

# The distro Chromium (plus the fonts it needs) powers the optional web-page ingestion feature.
# Installing the system browser avoids a runtime download and works without Puppeteer's own copy.
# libgomp1 is the OpenMP runtime that the native vector/ML modules (faiss-node, onnxruntime-node behind
# the reranker) link against; the builder stage got it transitively via g++, but this slim runtime stage
# does not, so without it those modules can fail to load and search would silently die. tini is a tiny
# init used as PID 1 (see ENTRYPOINT) so re-parented browser helper processes are reaped and signals are
# forwarded on every launch — `docker run` and compose alike — so no compose-level init is needed on top.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation fonts-freefont-ttf \
      ca-certificates \
      libgomp1 \
      tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    HOME=/state

WORKDIR /app
# App code and production dependencies, owned by the base image's non-root `node` user (uid 1000).
# --chown during COPY sets ownership without a second, full-size layer from a later chown -R.
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node package.json lokyni.js LICENSE ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node docker/healthcheck.js ./docker/healthcheck.js
# The README powers the in-app Guide (served at /readme.md), so it must be present at runtime.
COPY --chown=node:node docs/README.md ./docs/README.md
# Ship the config template for parity with the standalone and desktop distributions. The runtime working
# directory is /state (see below), so the live config is /state/config/config.json; an operator who execs in
# can seed it from this template with `cp /app/config/config.json.default /state/config/config.json`. The app
# falls back to built-in defaults when config.json is absent, so this is for the operator, not required at runtime.
COPY --chown=node:node config/config.json.default /app/config/config.json.default

# All writable state lives under /state, a single mounted volume: config/config.json, the document
# index, workspaces, and the reranker model (all under ./data), plus the logs and browser dotfiles
# under ~/.lokyni (HOME=/state). Running from /state means config/config.json and ./data resolve there
# and the Settings save's atomic rename stays within the volume. Created and owned here so a fresh
# named volume inherits `node` ownership.
RUN mkdir -p /state && chown node:node /state
USER node
WORKDIR /state

EXPOSE 7887

# Run under tini as PID 1 so re-parented processes (e.g. Chromium helpers left by URL ingestion) are
# reaped and signals reach the server on both `docker run` and compose. Graceful SIGTERM shutdown is
# handled by the app; tini covers zombie reaping and signal forwarding.
ENTRYPOINT ["/usr/bin/tini", "--"]

# Liveness probe: the lightweight /status endpoint, checked with a dependency-free Node script (no
# curl in the image by design).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "/app/docker/healthcheck.js"]

# Bind to all interfaces INSIDE the container so a published port can reach the server; the compose
# file publishes only to host loopback by default. --enforce-host-guard keeps the DNS-rebinding Host
# guard active despite the 0.0.0.0 bind, so only loopback and configured trustedHosts are accepted.
# Run lokyni.js from /app while cwd stays /state so config/config.json and ./data land in the volume.
# NOTE: the port 7887 here (and in EXPOSE above and the compose publish mapping) must match
# lib/constants.js DEFAULT_PORT, which the healthcheck derives from. Dockerfile syntax can't reference
# that constant, so keep these literals in step if the default ever changes.
CMD ["node", "/app/lokyni.js", "--port", "7887", "--bind", "0.0.0.0", "--enforce-host-guard"]
