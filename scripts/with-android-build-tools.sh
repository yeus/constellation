#!/usr/bin/env bash
set -euo pipefail

sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -n "$sdk" && -d "$sdk/build-tools" ]]; then
  build_tools="$(find "$sdk/build-tools" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' \
    | sort -V \
    | tail -n 1)"
  if [[ -n "$build_tools" && -x "$sdk/build-tools/$build_tools/apksigner" ]]; then
    export PATH="$sdk/build-tools/$build_tools:$PATH"
  fi
fi

exec "$@"
