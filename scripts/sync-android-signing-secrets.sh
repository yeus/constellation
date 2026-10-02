#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/android-release-secrets.sh"

if [[ "${1:-}" == -h || "${1:-}" == --help ]]; then
  echo "Usage: scripts/sync-android-signing-secrets.sh [owner/repo]"
  echo "Validates Constellation's Android signing identity and uploads it to GitHub."
  echo "Defaults to yeus/constellation."
  exit 0
fi

target_repo="${1:-${GITHUB_REPOSITORY:-yeus/constellation}}"
if [[ ! "$target_repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "Pass the target GitHub repository as owner/repo." >&2
  exit 1
fi

for command in secret-tool gh base64 keytool; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing required command: $command" >&2
    exit 1
  fi
done

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated." >&2
  exit 1
fi

if ! prepare_constellation_android_signing build 0; then
  echo "No valid existing Constellation Android signing identity was loaded; nothing was changed." >&2
  exit 1
fi

keystore_base64="${ANDROID_KEYSTORE_BASE64:-}"
if [[ -z "$keystore_base64" ]]; then
  echo "The existing Constellation identity has no stored keystore backup; nothing was changed." >&2
  exit 1
fi

printf 'Upload validated Constellation Android signing values to %s? Type YES to continue: ' \
  "$target_repo" >&2
answer=""
if ! IFS= read -r answer || [[ "$answer" != YES ]]; then
  echo "Cancelled without changing GitHub secrets." >&2
  exit 0
fi

upload_secret() {
  local name="$1"
  local value="$2"
  printf '%s' "$value" | gh secret set "$name" --repo "$target_repo"
}

upload_secret ANDROID_KEYSTORE_BASE64 "$keystore_base64"
upload_secret ANDROID_KEYSTORE_PASSWORD "$ANDROID_KEYSTORE_PASSWORD"
upload_secret ANDROID_KEY_ALIAS "$ANDROID_KEY_ALIAS"
upload_secret ANDROID_KEY_PASSWORD "$ANDROID_KEY_PASSWORD"

printf 'Validated Constellation Android signing identity uploaded to %s.\n' "$target_repo"
