#!/usr/bin/env bash
set -euo pipefail
umask 022

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo "The AppImage builder currently supports x86_64 Linux only." >&2
  exit 1
fi

mkdir -p -- "$repo_root/.tmp"
build_root="$(mktemp -d "$repo_root/.tmp/appimage-build.XXXXXX")"

cleanup() {
  status="$?"
  chmod -R u+rwX "$build_root" 2>/dev/null || true
  rm -rf -- "$build_root"
  exit "$status"
}
trap cleanup EXIT

export CARGO_TARGET_DIR="$build_root/cargo-target"
yarn build:desktop:appimage:internal "$@"
node scripts/copy-desktop-artifact.mjs
