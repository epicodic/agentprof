#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
#
# Install everything needed to develop agentprof: uv, Node (via nvm), pnpm (via corepack),
# the Python and frontend dependencies, and Playwright's Chromium. Safe to run repeatedly.
set -euo pipefail

ASSUME_YES=false
INSTALL_BROWSERS=true
for arg in "$@"; do
  case "$arg" in
    -y | --yes) ASSUME_YES=true ;;
    --no-browsers) INSTALL_BROWSERS=false ;;
    -h | --help)
      echo "usage: ./bootstrap.sh [--yes] [--no-browsers]"
      exit 0
      ;;
    *)
      echo "unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NVM_VERSION="v0.40.3"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

say() { printf '\n==> %s\n' "$*"; }
confirm() {
  if $ASSUME_YES; then return 0; fi
  local reply
  read -r -p "$1 [Y/n] " reply
  [[ -z "$reply" || "$reply" =~ ^[Yy] ]]
}
fail() {
  echo "error: $*" >&2
  exit 1
}

say "uv"
if ! command -v uv >/dev/null 2>&1; then
  confirm "uv is missing. Install it with the official installer from astral.sh?" || fail "uv is required"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi
uv --version

say "Node $(cat "$ROOT/.nvmrc") via nvm"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
  confirm "nvm is missing. Install nvm $NVM_VERSION into $NVM_DIR?" || fail "Node is required"
  curl -o- "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | bash
fi
cd "$ROOT"
# nvm is not compatible with `set -eu`; relax it while nvm runs and check results explicitly.
set +eu
# shellcheck source=/dev/null
. "$NVM_DIR/nvm.sh"
nvm install || fail "nvm install failed"
nvm use >/dev/null || fail "nvm use failed"
wanted="$(nvm version "$(cat .nvmrc)")"
default="$(nvm version default 2>/dev/null)"
set -eu
node --version
if [[ "$default" != "$wanted" ]] && confirm "Make Node $wanted your default, so node and pnpm are on PATH in new shells?"; then
  set +eu
  nvm alias default "$(cat .nvmrc)" >/dev/null
  set -eu
fi

say "pnpm via corepack"
corepack enable pnpm
pnpm --version

say "Python dependencies"
uv sync

if [[ -f "$ROOT/frontend/package.json" ]]; then
  say "Frontend dependencies"
  if [[ -f "$ROOT/frontend/pnpm-lock.yaml" ]]; then
    pnpm --dir frontend install --frozen-lockfile
  else
    pnpm --dir frontend install
  fi
  if $INSTALL_BROWSERS; then
    say "Playwright Chromium"
    pnpm --dir frontend exec playwright install chromium
  fi
fi

say "Done."
echo "Check everything: uv run qa"
echo "Start the app:    uv run agentprof"
