#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
cd "$repo_root"
manifest="$repo_root/packaging/flatpak/space.taskyon.constellation.yml"
build_root="$(mktemp -d /tmp/constellation-flatpak.XXXXXX)"
state_dir="$build_root/state"
build_dir="$build_root/build"
repo_dir="$build_root/repo"
cleanup() {
  case "$build_root" in
    /tmp/constellation-flatpak.*) rm -rf -- "$build_root" ;;
  esac
}
trap cleanup EXIT
version="$(node -p "require('./package.json').version")"
branch="stable"
if [[ -z "${CONSTELLATION_BUILD_COMMIT:-}" ]]; then
  CONSTELLATION_BUILD_COMMIT="${GITHUB_SHA:-}"
fi
if [[ -z "${CONSTELLATION_BUILD_COMMIT:-}" ]]; then
  CONSTELLATION_BUILD_COMMIT="$(git rev-parse --verify HEAD 2>/dev/null || printf 'unknown')"
fi
export CONSTELLATION_BUILD_COMMIT

command -v flatpak >/dev/null || {
  echo "Missing required command: flatpak" >&2
  exit 1
}
command -v flatpak-builder >/dev/null || {
  echo "Missing required command: flatpak-builder" >&2
  exit 1
}

if ! flatpak remotes --columns=name | grep -Fxq flathub; then
  echo "Adding the Flathub user remote..."
  flatpak remote-add --user --if-not-exists flathub \
    https://dl.flathub.org/repo/flathub.flatpakrepo
fi

mkdir -p "$build_root" "$state_dir" "$repo_dir" "$repo_root/dist"
flatpak-builder \
  --force-clean \
  --disable-rofiles-fuse \
  --default-branch="$branch" \
  --user \
  --install-deps-from=flathub \
  --repo="$repo_dir" \
  --state-dir="$state_dir" \
  "$build_dir" \
  "$manifest"

architecture="$(flatpak --default-arch)"
artifact="$repo_root/dist/constellation-desktop-${version}-${architecture}.flatpak"
flatpak build-bundle \
  "$repo_dir" \
  "$artifact" \
  space.taskyon.constellation \
  "$branch" \
  --runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo

echo "Flatpak bundle created: $artifact"
