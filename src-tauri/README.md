# Desktop app

This directory holds Lokyni's native desktop app. It is a thin launcher: it starts the normal
local server as a child process, waits for it to listen, then points a native window at it.
The server is unchanged and unaware it is running inside a window, so all application logic
stays in one place.

It builds and runs on macOS, Windows, and Linux. A GitHub Actions workflow
(`.github/workflows/desktop.yml`) builds the installers for all three on a version tag.
The macOS bundle is ad-hoc signed during the build. No Apple Developer ID or Windows
code-signing certificate is available, so notarization and Authenticode are not part of the
build; a downloaded macOS app may need right-click Open on first launch.

## How it works

- The bundle is staged automatically before every compile: `tauri.conf.json` sets
  `build.beforeBuildCommand` to `npm run tauri:prepare`, so Tauri runs the staging step itself
  right before it builds. This means a plain `tauri build` (or `cargo tauri build`) produces a
  correct bundle too — not only `npm run tauri:build` — and the staged `app/` can never be stale
  relative to the compile. `app/` is a bundled resource, so if staging were ever skipped the
  build fails loudly rather than shipping an empty bundle.
- The app version is single-sourced from the root `package.json`; `tauri.conf.json` reads it
  directly. The Rust crate carries a fixed `0.0.0` placeholder because Cargo cannot read JSON,
  so there is no second release literal to sync or drift. `lib/test/unit/version-drift.test.js`
  guards that arrangement.
- `prepare-sidecar.js` stages the app into `app/`: the exact published file set (resolved from
  the `files` allowlist in the root `package.json`, the same list the background-service
  installer uses) plus the production dependencies, and a copy of the runtime under
  `app/runtime/`. On macOS CI, `LOKYNI_RUNTIME_NODE` supplies a pre-combined universal Node so
  the bundled runtime runs natively on both Apple Silicon and Intel. It pre-flights the build
  (runtime Node version, key dependencies present, and the macOS floor against the bundled
  runtime) and verifies the staged pieces afterward, so an incomplete or unlaunchable bundle
  fails loudly rather than shipping broken. The bundle carries everything
  needed to run with nothing else installed; `app/` is generated and git-ignored, so it can
  never drift from the top-level `lib/`.
- `src/main.rs` picks a free loopback port, launches `app/lokyni.js` through the bundled
  runtime with `--port`, waits for the port, and navigates the window to it. Closing the
  window stops the server child. Configuration and the document index are written to the
  per-user data directory, not the read-only bundle.
- `ui/index.html` is a small placeholder shown for the moment before the server is ready.

## Prerequisites

- A Rust toolchain (`rustc` and `cargo`).
- Project dependencies installed (`npm install`).
- Node.js 22.22 or later. The release workflow pins the exact runtime it bundles
  (`NODE_VERSION` in `.github/workflows/desktop.yml`), and the Docker bases use the same pin.
- macOS builds require macOS 13.5 or later. That is the floor of the bundled Node runtime, and
  the staging step refuses to build if `tauri.conf.json` advertises an older version.
- On Linux, install the build packages with `bash src-tauri/linux-build-deps.sh`. The release
  workflow and the Linux installer pass use the same script.

## Build a bundle

```
npm run tauri:build
```

This compiles the installer for the current platform (a `.dmg` on macOS, an `.msi`/`.exe` on
Windows, a `.deb`/`.rpm` on Linux); the bundle is staged automatically first via the
`beforeBuildCommand` hook. The result is written under `target/`.

On macOS, verify the built artifact with:

```
npm run verify:dmg
```

It mounts the newest DMG read-only and checks the ad-hoc signature, bundle version, macOS floor,
and packaged sidecar and runtime, then unmounts it. It never launches the app or reads user data.


Local macOS builds use the plain CI DMG layout by default, so they complete in one pass and
match the release artifacts. Tauri's Finder-styled window is opt-in:

```
LOKYNI_DMG_STYLE=1 npm run tauri:build
```

If Finder cannot lay out the volume, that build fails without rebuilding. Rerun without the
variable for the one-pass layout.

To only stage the bundled files without compiling:

```
npm run tauri:prepare
```

## Current limits

- Bundles are large, because the dependencies include a full browser engine and native
  modules. The staged bundle prunes dev-only/unused packages; trimming the browser engine
  further remains for a leaner release.
- macOS builds as a single UNIVERSAL (arm64 + x86_64) installer from one host: CI sets
  `LOKYNI_TAURI_TARGET=universal-apple-darwin` and `universal-mac-natives.js` folds a second-arch
  (x64) dependency install into the arm64 tree (lipo'ing the native `.node`/`.dylib` modules, and
  failing the build if any bundled native stays single-arch). Windows and Linux installers are
  still built on their own OS.
- The local model runtime is a separate installation and is not bundled here.
- The macOS bundle is ad-hoc signed; Windows installers are unsigned. No distribution
  certificates are available, so notarization and Authenticode are intentionally not part of
  the build. A downloaded macOS app may need right-click Open on first launch.

## Regenerated artifacts

`app/` (the staged bundle) and `target/` (the build output) are generated and not tracked in
git. The icons under `icons/` are generated from `lib/public/icons/icon-512.png`; regenerate
them with `npx tauri icon lib/public/icons/icon-512.png --output src-tauri/icons`.
