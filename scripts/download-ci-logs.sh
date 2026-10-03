#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  printf 'Node.js 22 is required. Enter the project development shell first.\n' >&2
  exit 127
fi
exec node "$script_dir/download-ci-logs.mjs" "$@"
