#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
gradle_file="$repo_root/src-tauri/gen/android/app/build.gradle.kts"
properties_file="$repo_root/src-tauri/gen/android/app/keystore.properties"
temporary_keystore=""
gradle_backup=""

cleanup() {
  rm -f -- "$properties_file"
  if [[ -n "$temporary_keystore" ]]; then
    rm -f -- "$temporary_keystore"
  fi
  if [[ -n "$gradle_backup" ]]; then
    cp -- "$gradle_backup" "$gradle_file"
    rm -f -- "$gradle_backup"
  fi
}
trap cleanup EXIT

required=(
  ANDROID_KEYSTORE_PATH
  ANDROID_KEYSTORE_PASSWORD
  ANDROID_KEY_ALIAS
  ANDROID_KEY_PASSWORD
)
missing=()
for name in "${required[@]}"; do
  [[ -n "${!name:-}" ]] || missing+=("$name")
done
if (( ${#missing[@]} > 0 )); then
  echo "Missing Android release signing values: ${missing[*]}" >&2
  exit 1
fi
if [[ ! -f "$ANDROID_KEYSTORE_PATH" ]]; then
  echo "Android release keystore does not exist." >&2
  exit 1
fi
if [[ ! -f "$gradle_file" ]]; then
  echo "Run yarn android:init before building an Android release." >&2
  exit 1
fi

temporary_keystore="$(mktemp "${TMPDIR:-/tmp}/constellation-android-release.XXXXXX.jks")"
install -m 600 "$ANDROID_KEYSTORE_PATH" "$temporary_keystore"
umask 077
cat >"$properties_file" <<EOF
storeFile=$temporary_keystore
storePassword=$ANDROID_KEYSTORE_PASSWORD
keyAlias=$ANDROID_KEY_ALIAS
keyPassword=$ANDROID_KEY_PASSWORD
EOF

if ! grep -q 'constellation-release-signing' "$gradle_file"; then
  gradle_backup="$(mktemp "${TMPDIR:-/tmp}/constellation-android-gradle.XXXXXX.kts")"
  cp -- "$gradle_file" "$gradle_backup"
  cat >>"$gradle_file" <<'EOF'

// constellation-release-signing: generated Android release configuration
val constellationKeystoreProperties = Properties().apply {
    val source = file("keystore.properties")
    if (source.exists()) source.inputStream().use { load(it) }
}

if (constellationKeystoreProperties.isNotEmpty()) {
    android {
        signingConfigs {
            create("constellationRelease") {
                storeFile = file(constellationKeystoreProperties.getProperty("storeFile"))
                storePassword = constellationKeystoreProperties.getProperty("storePassword")
                keyAlias = constellationKeystoreProperties.getProperty("keyAlias")
                keyPassword = constellationKeystoreProperties.getProperty("keyPassword")
            }
        }
        buildTypes.getByName("release") {
            signingConfig = signingConfigs.getByName("constellationRelease")
        }
    }
}
EOF
fi

cd "$repo_root"
bash scripts/with-android-build-tools.sh \
  yarn tauri android build \
  --apk \
  --target aarch64
node scripts/copy-android-apk.mjs release aarch64
