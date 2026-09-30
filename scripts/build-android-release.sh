#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/android-release-secrets.sh"
gradle_file="$repo_root/src-tauri/gen/android/app/build.gradle.kts"
properties_file="$repo_root/src-tauri/gen/android/app/keystore.properties"
temporary_keystore=""
temporary_properties=""
properties_created=0
gradle_backup=""

cleanup() {
  if [[ -n "$temporary_properties" ]]; then
    rm -f -- "$temporary_properties"
  fi
  if (( properties_created )); then
    rm -f -- "$properties_file"
  fi
  if [[ -n "$temporary_keystore" ]]; then
    rm -f -- "$temporary_keystore"
  fi
  if [[ -n "$gradle_backup" ]]; then
    cp -- "$gradle_backup" "$gradle_file"
    rm -f -- "$gradle_backup"
  fi
}
trap cleanup EXIT

if [[ -e "$properties_file" || -L "$properties_file" ]]; then
  echo "Android keystore.properties already exists; refusing to overwrite it." >&2
  exit 1
fi

if [[ ! -f "$gradle_file" ]]; then
  echo "Run yarn android:init before building an Android release." >&2
  exit 1
fi
prepare_constellation_android_signing

temporary_keystore="$(mktemp "${TMPDIR:-/tmp}/constellation-android-release.XXXXXX.jks")"
if [[ -n "${ANDROID_KEYSTORE_BASE64:-}" ]]; then
  if ! constellation_decode_android_keystore "$ANDROID_KEYSTORE_BASE64" "$temporary_keystore"; then
    echo "Stored Android release keystore is not valid base64." >&2
    exit 1
  fi
  chmod 600 "$temporary_keystore"
else
  install -m 600 "$ANDROID_KEYSTORE_PATH" "$temporary_keystore"
fi
umask 077
temporary_properties="$(mktemp "$properties_file.XXXXXX")"
cat >"$temporary_properties" <<EOF
storeFile=$temporary_keystore
storePassword=$ANDROID_KEYSTORE_PASSWORD
keyAlias=$ANDROID_KEY_ALIAS
keyPassword=$ANDROID_KEY_PASSWORD
EOF
if ! ln -- "$temporary_properties" "$properties_file"; then
  echo "Android keystore.properties already exists; refusing to overwrite it." >&2
  exit 1
fi
properties_created=1
rm -f -- "$temporary_properties"
temporary_properties=""

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
bash scripts/with-android-build-tools.sh node scripts/copy-android-apk.mjs release aarch64
