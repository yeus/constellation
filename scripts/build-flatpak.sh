#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
manifest="$repo_root/packaging/flatpak/space.taskyon.constellation.yml"
build_root="$repo_root/.tmp/flatpak"
version="$(node -p "require('./package.json').version")"

command -v flatpak >/dev/null || {
  echo "Missing required command: flatpak" >&2
  exit 1
}
command -v flatpak-builder >/dev/null || {
  echo "Missing required command: flatpak-builder" >&2
  exit 1
}

mkdir -p "$build_root/state" "$build_root/repo" "$repo_root/dist"
flatpak-builder \
  --force-clean \
  --disable-rofiles-fuse \
  --user \
  --install-deps-from=flathub \
  --repo="$build_root/repo" \
  --state-dir="$build_root/state" \
  "$build_root/build" \
  "$manifest"

architecture="$(flatpak --default-arch)"
artifact="$repo_root/dist/constellation-desktop-${version}-${architecture}.flatpak"
flatpak build-bundle \
  "$build_root/repo" \
  "$artifact" \
  space.taskyon.constellation \
  master \
  --runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo

echo "Flatpak bundle created: $artifact"
