constellation_android_secret_lookup() {
  local key="$1"
  secret-tool lookup \
    app constellation \
    scope android-release-signing \
    key "$key" 2>/dev/null || true
}

constellation_android_secret_store() {
  local key="$1"
  local label="$2"
  local value="$3"

  if ! printf '%s' "$value" | secret-tool store \
    --label "$label" \
    app constellation \
    scope android-release-signing \
    key "$key" >/dev/null; then
    echo "Could not store Android signing metadata in Linux Secret Service." >&2
    return 1
  fi
}

constellation_generate_android_secret() {
  head -c 48 /dev/urandom | base64 | tr -d '=+/' | cut -c1-32
}

constellation_encode_android_keystore() {
  local path="$1"
  local encoded

  if encoded="$(base64 -w 0 "$path" 2>/dev/null)"; then
    printf '%s' "$encoded"
  else
    base64 "$path" | tr -d '\n'
  fi
}

constellation_decode_android_keystore() {
  local value="$1"
  local destination="$2"

  if printf '%s' "$value" | base64 -d >"$destination" 2>/dev/null; then
    return 0
  fi
  if printf '%s' "$value" | base64 --decode >"$destination" 2>/dev/null; then
    return 0
  fi
  if printf '%s' "$value" | base64 -D >"$destination" 2>/dev/null; then
    return 0
  fi
  return 1
}

constellation_validate_android_keystore() {
  local path="$1"
  local store_password="$2"
  local key_alias="$3"
  local key_password="$4"

  if [[ ! -f "$path" ]] || ! keytool -list \
    -keystore "$path" \
    -storepass "$store_password" \
    -alias "$key_alias" >/dev/null 2>&1; then
    echo "Android release keystore does not match the configured password and alias; refusing to replace it." >&2
    return 1
  fi
  if ! keytool -certreq \
    -keystore "$path" \
    -storepass "$store_password" \
    -alias "$key_alias" \
    -keypass "$key_password" \
    -file /dev/null >/dev/null 2>&1; then
    echo "Android release key password does not unlock the configured alias; refusing to replace the keystore." >&2
    return 1
  fi
}

constellation_link_staged_android_keystore() {
  local staged_keystore="$1"
  local staging_dir="$2"
  local destination="$3"

  if ! chmod 600 "$staged_keystore"; then
    rm -f "$staged_keystore"
    rmdir "$staging_dir"
    echo "Could not secure the temporary Android release keystore." >&2
    return 1
  fi
  if ! ln "$staged_keystore" "$destination" 2>/dev/null; then
    rm -f "$staged_keystore"
    rmdir "$staging_dir"
    echo "Could not create the Android release keystore at the configured path." >&2
    return 1
  fi
  rm -f "$staged_keystore"
  rmdir "$staging_dir"
}

constellation_generate_android_keystore() {
  local path="$1"
  local store_password="$2"
  local key_alias="$3"
  local key_password="$4"
  local parent="$(dirname "$path")"
  local staging_dir
  local staged_keystore

  mkdir -p "$parent"
  staging_dir="$(mktemp -d "$parent/.constellation-release.XXXXXX")"
  staged_keystore="$staging_dir/android-release.jks"
  if ! keytool -genkeypair \
    -keystore "$staged_keystore" \
    -storetype JKS \
    -alias "$key_alias" \
    -keyalg RSA \
    -keysize 2048 \
    -validity 10000 \
    -storepass "$store_password" \
    -keypass "$key_password" \
    -dname "CN=Constellation, OU=Constellation, O=Constellation, L=Unknown, ST=Unknown, C=US" \
    >/dev/null; then
    rm -f "$staged_keystore"
    rmdir "$staging_dir"
    echo "Could not generate the Android release keystore." >&2
    return 1
  fi

  constellation_link_staged_android_keystore "$staged_keystore" "$staging_dir" "$path"
}

constellation_restore_android_keystore() {
  local path="$1"
  local encoded="$2"
  local parent="$(dirname "$path")"
  local staging_dir
  local staged_keystore

  mkdir -p "$parent"
  staging_dir="$(mktemp -d "$parent/.constellation-release.XXXXXX")"
  staged_keystore="$staging_dir/android-release.jks"
  if ! constellation_decode_android_keystore "$encoded" "$staged_keystore"; then
    rm -f "$staged_keystore"
    rmdir "$staging_dir"
    echo "Stored Android release keystore is not valid base64." >&2
    return 1
  fi

  constellation_link_staged_android_keystore "$staged_keystore" "$staging_dir" "$path"
}

constellation_materialize_android_keystore() {
  local path="$1"
  local encoded="$2"
  local store_password="$3"
  local key_alias="$4"
  local key_password="$5"
  local action="existing"

  if [[ ! -e "$path" && ! -L "$path" ]]; then
    if [[ -n "$encoded" ]]; then
      if ! constellation_restore_android_keystore "$path" "$encoded"; then
        return 1
      fi
      action="restored"
    else
      if ! constellation_generate_android_keystore \
        "$path" "$store_password" "$key_alias" "$key_password"; then
        return 1
      fi
      action="generated"
    fi
  fi

  if ! constellation_validate_android_keystore "$path" "$store_password" "$key_alias" "$key_password"; then
    return 1
  fi
  printf '%s' "$action"
}

constellation_get_or_create_android_secret() {
  local env_name="$1"
  local key="$2"
  local label="$3"
  local default_value="$4"
  local existing_keystore="${5:-0}"
  local value="${!env_name:-}"

  if [[ -z "$value" ]]; then
    value="$(constellation_android_secret_lookup "$key")"
  fi
  if [[ -z "$value" ]]; then
    if [[ "$existing_keystore" == 1 ]]; then
      echo "$label is missing for an existing keystore; restore the original Secret Service entry." >&2
      return 1
    fi
    value="$default_value"
    if [[ -z "$value" ]]; then
      value="$(constellation_generate_android_secret)"
    fi
    if ! constellation_android_secret_store "$key" "$label" "$value"; then
      return 1
    fi
  fi
  printf '%s' "$value"
}

constellation_prepare_android_signing_from_secret_service() {
  local keystore_path="${ANDROID_KEYSTORE_PATH:-}"
  local keystore_base64="${ANDROID_KEYSTORE_BASE64:-}"
  local existing_keystore=0
  local action

  [[ -n "$keystore_base64" ]] || keystore_base64="$(constellation_android_secret_lookup android_keystore_base64)"
  keystore_path="$(constellation_get_or_create_android_secret \
    ANDROID_KEYSTORE_PATH \
    android_keystore_path \
    "Constellation Android keystore path" \
    "${XDG_CONFIG_HOME:-$HOME/.config}/constellation/android-release.jks")" || return 1
  keystore_path="${keystore_path/#\~/$HOME}"
  keystore_path="${keystore_path//\$\{HOME\}/$HOME}"
  keystore_path="${keystore_path//\$HOME/$HOME}"
  [[ "$keystore_path" == /* ]] || keystore_path="$PWD/$keystore_path"
  export ANDROID_KEYSTORE_PATH="$keystore_path"
  if [[ -e "$keystore_path" || -L "$keystore_path" || -n "$keystore_base64" ]]; then
    existing_keystore=1
  fi

  ANDROID_KEYSTORE_PASSWORD="$(constellation_get_or_create_android_secret \
    ANDROID_KEYSTORE_PASSWORD \
    android_keystore_password \
    "Constellation Android keystore password" \
    "" \
    "$existing_keystore")" || return 1
  export ANDROID_KEYSTORE_PASSWORD
  ANDROID_KEY_ALIAS="$(constellation_get_or_create_android_secret \
    ANDROID_KEY_ALIAS \
    android_key_alias \
    "Constellation Android key alias" \
    "constellation-release-key")" || return 1
  export ANDROID_KEY_ALIAS

  ANDROID_KEY_PASSWORD="$(constellation_get_or_create_android_secret \
    ANDROID_KEY_PASSWORD \
    android_key_password \
    "Constellation Android key password" \
    "" \
    "$existing_keystore")" || return 1
  export ANDROID_KEY_PASSWORD

  action="$(constellation_materialize_android_keystore \
    "$keystore_path" \
    "$keystore_base64" \
    "$ANDROID_KEYSTORE_PASSWORD" \
    "$ANDROID_KEY_ALIAS" \
    "$ANDROID_KEY_PASSWORD")"
  if [[ "$action" == "generated" && -z "$keystore_base64" ]]; then
    keystore_base64="$(constellation_encode_android_keystore "$keystore_path")"
    if ! constellation_android_secret_store \
      android_keystore_base64 \
      "Constellation Android keystore backup" \
      "$keystore_base64"; then
      return 1
    fi
  fi
  echo "Android release signing values are ready from Linux Secret Service."
}

prepare_constellation_android_signing() {
  local keystore_path="${ANDROID_KEYSTORE_PATH:-}"

  if [[ -n "$keystore_path" && -n "${ANDROID_KEYSTORE_PASSWORD:-}" && -n "${ANDROID_KEY_ALIAS:-}" && -n "${ANDROID_KEY_PASSWORD:-}" && -f "$keystore_path" ]]; then
    if ! constellation_validate_android_keystore \
      "$keystore_path" \
      "$ANDROID_KEYSTORE_PASSWORD" \
      "$ANDROID_KEY_ALIAS" \
      "$ANDROID_KEY_PASSWORD"; then
      return 1
    fi
    export ANDROID_KEYSTORE_PATH ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD
    return 0
  fi

  if ! command -v secret-tool >/dev/null 2>&1; then
    echo "Linux Secret Service is required to load or create Android release signing values." >&2
    echo "Install secret-tool or provide all four ANDROID_* values and an existing keystore." >&2
    return 1
  fi
  constellation_prepare_android_signing_from_secret_service
}
