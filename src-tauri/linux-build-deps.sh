#!/usr/bin/env bash
# Linux packages needed to build the desktop app and to smoke-test its installers. Shared by the desktop
# release build and the dispatch-only Linux pass so the two cannot drift. Run with bash on Ubuntu.
set -euo pipefail

sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential cmake git python3 \
  libopenblas-dev liblapack-dev curl wget file libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev rpm libgomp1
