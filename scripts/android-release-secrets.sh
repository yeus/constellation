constellation_android_secret_lookup() {
  local key="$1"
  local value

  if value="$(secret-tool lookup \
    app constellation \
    scope android-release-signing \
    key "$key" 2>&1)"; then
    printf '%s' "$value"
    return 0
  fi
  if [[ -n "$value" ]]; then
    echo "Secret Service could not read android signing entry $key. Unlock KeePassXC, allow access, and retry." >&2
    return 2
  fi
}

constellation_wait_for_android_secret_service() {
  local interactive="$1"
  local answer

  while ! command -v secret-tool >/dev/null 2>&1 ||
    ! secret-tool search --all --unlock \
      app constellation scope android-release-signing \
      >/dev/null 2>&1; do
    echo "Linux Secret Service is required but unavailable or locked." >&2
    if [[ "$interactive" != 1 ]]; then
      echo "Unlock/start the Secret Service and retry the Android release command." >&2
      return 1
    fi
    printf 'Unlock/start Secret Service, then press Enter to retry (q to cancel): ' >&2
    if ! IFS= read -r answer || [[ "$answer" == [qQ] ]]; then
      return 1
    fi
  done
}

constellation_android_signing_identity_absent() {
  local default_path="${XDG_CONFIG_HOME:-$HOME/.config}/constellation/android-release.jks"
  local key
  local value

  if [[ -e "$default_path" || -L "$default_path" ||
    -n "${ANDROID_KEYSTORE_PATH:-}${ANDROID_KEYSTORE_BASE64:-}${ANDROID_KEYSTORE_PASSWORD:-}${ANDROID_KEY_ALIAS:-}${ANDROID_KEY_PASSWORD:-}" ]]; then
    return 1
  fi
  for key in android_keystore_path android_keystore_base64 android_keystore_password android_key_alias android_key_password; do
    if ! value="$(constellation_android_secret_lookup "$key")"; then
      return 2
    fi
    [[ -z "$value" ]] || return 1
  done
}

constellation_confirm_new_android_signing_identity() {
  local answer
  echo "No Constellation Android signing identity was found." >&2
  echo "A new key cannot update APKs signed with any previous key." >&2
  printf 'Type CREATE to generate and store a new signing identity, or press Enter to cancel: ' >&2
  IFS= read -r answer && [[ "$answer" == CREATE ]]
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

constellation_require_android_keytool() {
  if command -v keytool >/dev/null 2>&1; then
    return 0
  fi
  echo "Android release signing needs keytool (JDK 17), but it is not on PATH." >&2
  echo "Enter Constellation's own Nix shell with 'nix develop', then retry." >&2
  return 1
}

constellation_validate_android_keystore() {
  local path="$1"
  local store_password="$2"
  local key_alias="$3"
  local key_password="$4"
  local listing
  local aliases
  local matched_alias=""
  local candidate_alias
  local entry_type
  local alias_list

  if [[ ! -f "$path" ]]; then
    echo "The file configured by android_keystore_path is missing." >&2
    return 1
  fi
  if [[ ! -r "$path" ]]; then
    echo "The file configured by android_keystore_path is not readable." >&2
    return 1
  fi
  constellation_require_android_keytool || return 1

  if ! listing="$(KEYTOOL_STORE_PASSWORD="$store_password" LC_ALL=C keytool -list -v \
    -keystore "$path" \
    -storepass:env KEYTOOL_STORE_PASSWORD 2>&1)"; then
    echo "android_keystore_password could not open the selected keystore." >&2
    echo "The password may not match this file, or the file may be damaged or unsupported." >&2
    return 1
  fi

  aliases="$(printf '%s\n' "$listing" | sed -n 's/^Alias name: //p')"
  while IFS= read -r candidate_alias; do
    if [[ "${candidate_alias,,}" == "${key_alias,,}" ]]; then
      matched_alias="$candidate_alias"
      break
    fi
  done <<<"$aliases"
  if [[ -z "$matched_alias" ]]; then
    alias_list="$(printf '%s\n' "$aliases" | awk 'NF { printf "%s%s", separator, $0; separator = ", " }')"
    if [[ -n "$alias_list" ]]; then
      echo "android_key_alias value '$key_alias' was not found in the selected keystore." >&2
      echo "Aliases present in the keystore: $alias_list" >&2
    else
      echo "android_key_alias was not found; keytool returned no alias names." >&2
    fi
    return 1
  fi

  entry_type="$(printf '%s\n' "$listing" | awk -v alias="$matched_alias" '
    /^Alias name: / { current = substr($0, 13) }
    current == alias && /^Entry type: / { print substr($0, 13); exit }
  ')"
  if [[ "$entry_type" != "PrivateKeyEntry" ]]; then
    echo "android_key_alias '$matched_alias' is not a private-key entry." >&2
    [[ -n "$entry_type" ]] && echo "Entry type: $entry_type" >&2
    return 1
  fi

  if ! KEYTOOL_STORE_PASSWORD="$store_password" \
    KEYTOOL_KEY_PASSWORD="$key_password" LC_ALL=C keytool -certreq \
    -keystore "$path" \
    -storepass:env KEYTOOL_STORE_PASSWORD \
    -alias "$matched_alias" \
    -keypass:env KEYTOOL_KEY_PASSWORD \
    -file /dev/null >/dev/null 2>&1; then
    echo "android_key_password could not unlock private-key alias '$matched_alias'." >&2
    return 1
  fi
}

constellation_diagnose_android_keystore_backup() {
  local encoded="$1"
  local store_password="$2"
  local key_alias="$3"
  local key_password="$4"
  local local_path="$5"
  local staging_dir
  local staged_keystore
  local diagnostics

  staging_dir="$(mktemp -d "${TMPDIR:-/tmp}/constellation-keystore-check.XXXXXX")" || {
    echo "Could not prepare a temporary check of android_keystore_base64." >&2
    return 1
  }
  staged_keystore="$staging_dir/backup.jks"
  if ! constellation_decode_android_keystore "$encoded" "$staged_keystore"; then
    rm -f -- "$staged_keystore"
    rmdir -- "$staging_dir"
    echo "Configured backup android_keystore_base64 is not valid base64." >&2
    return 1
  fi
  chmod 600 "$staged_keystore"

  if cmp -s -- "$local_path" "$staged_keystore"; then
    echo "Local file and backup are byte-for-byte identical." >&2
  else
    echo "Local file and backup contain different bytes." >&2
  fi

  if diagnostics="$(constellation_validate_android_keystore \
    "$staged_keystore" "$store_password" "$key_alias" "$key_password" 2>&1)"; then
    echo "Configured backup android_keystore_base64 validates with the configured password and alias." >&2
    echo "The selected local keystore at android_keystore_path is the mismatched item; it was left untouched." >&2
    rm -f -- "$staged_keystore"
    rmdir -- "$staging_dir"
    return 0
  fi

  echo "Configured backup android_keystore_base64 also failed validation:" >&2
  printf '%s\n' "$diagnostics" >&2
  case "$diagnostics" in
    *android_keystore_password*)
      echo "Inputs to inspect: android_keystore_password and android_keystore_base64 (or their ANDROID_* environment overrides, if reported above). This check cannot distinguish a wrong password from a damaged/wrong backup file." >&2
      ;;
    *android_key_alias*)
      echo "Input to inspect: android_key_alias (or ANDROID_KEY_ALIAS override); compare it with the aliases reported above." >&2
      ;;
    *android_key_password*)
      echo "Input to inspect: android_key_password (or ANDROID_KEY_PASSWORD override) for this alias." >&2
      ;;
  esac
  echo "Keep the existing keystore and Secret Service values unchanged until the matching signing key is confirmed." >&2
  rm -f -- "$staged_keystore"
  rmdir -- "$staging_dir"
  return 1
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
  if ! KEYTOOL_STORE_PASSWORD="$store_password" \
    KEYTOOL_KEY_PASSWORD="$key_password" keytool -genkeypair \
    -keystore "$staged_keystore" \
    -storetype JKS \
    -alias "$key_alias" \
    -keyalg RSA \
    -keysize 2048 \
    -validity 10000 \
    -storepass:env KEYTOOL_STORE_PASSWORD \
    -keypass:env KEYTOOL_KEY_PASSWORD \
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
  local store_password="$3"
  local key_alias="$4"
  local key_password="$5"
  local parent="$(dirname "$path")"
  local staging_dir
  local staged_keystore
  local original_keystore

  mkdir -p "$parent"
  staging_dir="$(mktemp -d "$parent/.constellation-release.XXXXXX")"
  staged_keystore="$staging_dir/android-release.jks"
  if ! constellation_decode_android_keystore "$encoded" "$staged_keystore"; then
    rm -f "$staged_keystore"
    rmdir "$staging_dir"
    echo "Stored Android release keystore is not valid base64." >&2
    return 1
  fi

  chmod 600 "$staged_keystore"
  if ! constellation_validate_android_keystore \
    "$staged_keystore" "$store_password" "$key_alias" "$key_password"; then
    rm -f -- "$staged_keystore"
    rmdir -- "$staging_dir"
    echo "The configured backup failed validation; local keystore was not changed." >&2
    return 1
  fi

  if [[ -L "$path" || ( -e "$path" && ! -f "$path" ) ]]; then
    rm -f -- "$staged_keystore"
    rmdir -- "$staging_dir"
    echo "Refusing to replace a symlink or non-file Android keystore path." >&2
    return 1
  fi

  if [[ -e "$path" ]]; then
    original_keystore="$staging_dir/original.jks"
    if ! cp -- "$path" "$original_keystore"; then
      rm -f -- "$staged_keystore" "$original_keystore"
      rmdir -- "$staging_dir"
      echo "Could not preserve the existing Android keystore; no replacement was made." >&2
      return 1
    fi
    chmod 600 "$original_keystore"
    if ! mv -- "$staged_keystore" "$path"; then
      rm -f -- "$staged_keystore" "$original_keystore"
      rmdir -- "$staging_dir"
      echo "Could not restore the Android keystore; existing file was preserved." >&2
      return 1
    fi
    echo "Previous local keystore saved at: $original_keystore" >&2
    return 0
  fi

  constellation_link_staged_android_keystore "$staged_keystore" "$staging_dir" "$path"
}

constellation_materialize_android_keystore() {
  local path="$1"
  local encoded="$2"
  local store_password="$3"
  local key_alias="$4"
  local key_password="$5"
  local mode="${6:-build}"
  local allow_create="${7:-0}"
  local action="existing"
  local display_path="$path"

  if [[ "$display_path" == "$HOME/"* ]]; then
    display_path="~${display_path#"$HOME"}"
  fi
  echo "Configured Android keystore file: $display_path" >&2

  if [[ "$mode" == restore ]]; then
    if [[ -z "$encoded" ]]; then
      echo "Secret Service entry android_keystore_base64 is missing; nothing to restore." >&2
      return 1
    fi
    echo "Keystore source: explicitly restoring configured backup android_keystore_base64." >&2
    if ! constellation_restore_android_keystore \
      "$path" "$encoded" "$store_password" "$key_alias" "$key_password"; then
      return 1
    fi
    action="restored"
  elif [[ -n "$encoded" ]]; then
    local staged_keystore
    staged_keystore="$(mktemp "${TMPDIR:-/tmp}/constellation-keystore-check.XXXXXX.jks")" || return 1
    if ! constellation_decode_android_keystore "$encoded" "$staged_keystore"; then
      rm -f -- "$staged_keystore"
      echo "Configured backup android_keystore_base64 is not valid base64." >&2
      return 1
    fi
    chmod 600 "$staged_keystore"
    echo "Keystore source: configured backup android_keystore_base64 (temporary copy)." >&2
    local diagnostics
    if ! diagnostics="$(constellation_validate_android_keystore "$staged_keystore" "$store_password" "$key_alias" "$key_password" 2>&1)"; then
      if [[ -f "$path" ]]; then
        constellation_diagnose_android_keystore_backup \
          "$encoded" "$store_password" "$key_alias" "$key_password" "$path" || true
      else
        printf '%s\n' "$diagnostics" >&2
        echo "Check android_keystore_base64 and the matching signing credentials; no local file was changed." >&2
      fi
      rm -f -- "$staged_keystore"
      return 1
    fi
    if [[ -f "$path" ]] && ! cmp -s -- "$path" "$staged_keystore"; then
      if constellation_validate_android_keystore "$path" "$store_password" "$key_alias" "$key_password" >/dev/null 2>&1; then
        echo "Two valid but byte-different Android signing keystores were found; refusing to choose an identity. Compare their signing certificates before building." >&2
        rm -f -- "$staged_keystore"
        return 1
      fi
      echo "Configured backup android_keystore_base64 validates; local keystore at android_keystore_path differs and was left untouched." >&2
    fi
    rm -f -- "$staged_keystore"
    action="backup"
  elif [[ ! -e "$path" && ! -L "$path" ]]; then
    if [[ -n "$encoded" ]]; then
      echo "The local Android keystore is missing. Run yarn android:signing:restore to validate and restore the stored backup." >&2
      return 1
    elif [[ "$allow_create" != 1 ]]; then
      echo "The local Android keystore is missing; normal release builds do not create one." >&2
      return 1
    else
      echo "Keystore source: creating a new keystore after explicit setup opt-in." >&2
      if ! constellation_generate_android_keystore \
        "$path" "$store_password" "$key_alias" "$key_password"; then
        return 1
      fi
      action="generated"
    fi
  else
    echo "Keystore source: existing local file." >&2
  fi

  if [[ "$action" != backup ]] && ! constellation_validate_android_keystore "$path" "$store_password" "$key_alias" "$key_password"; then
    if [[ "$action" == "existing" && -n "$encoded" ]]; then
      constellation_diagnose_android_keystore_backup \
        "$encoded" "$store_password" "$key_alias" "$key_password" "$path" || true
    fi
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
  local allow_create="${6:-0}"
  local value="${!env_name:-}"

  if [[ -z "$value" ]]; then
    if ! value="$(constellation_android_secret_lookup "$key")"; then
      return 1
    fi
  fi
  if [[ -z "$value" ]]; then
    if [[ "$key" == android_keystore_path && ( -e "$default_value" || -L "$default_value" ) ]]; then
      echo "Existing local Android keystore found, but android_keystore_path is missing; restore the original Secret Service entry." >&2
      return 1
    fi
    if [[ "$existing_keystore" == 1 ]]; then
      echo "$label is missing for an existing keystore; restore the original Secret Service entry." >&2
      return 1
    fi
    if [[ "$allow_create" != 1 ]]; then
      echo "$label was not found; refusing to create or store signing values during a release build." >&2
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
  local mode="${1:-build}"
  local interactive="${2:-0}"
  local keystore_path="${ANDROID_KEYSTORE_PATH:-}"
  local keystore_base64="${ANDROID_KEYSTORE_BASE64:-}"
  local existing_keystore=0
  local allow_create=0
  local identity_status
  local action

  if [[ "$mode" == build ]]; then
    if constellation_android_signing_identity_absent; then
      if [[ "$interactive" != 1 ]]; then
        echo "A new signing identity requires interactive confirmation in a terminal." >&2
        return 1
      fi
      if ! constellation_confirm_new_android_signing_identity; then
        echo "New Android signing identity creation cancelled." >&2
        return 1
      fi
      allow_create=1
    else
      identity_status=$?
      [[ "$identity_status" == 1 ]] || return 1
    fi
  fi

  if [[ -z "$keystore_base64" ]]; then
    if ! keystore_base64="$(constellation_android_secret_lookup android_keystore_base64)"; then
      return 1
    fi
  fi
  if [[ -n "${ANDROID_KEYSTORE_BASE64:-}" ]]; then
    echo "Keystore backup source: ANDROID_KEYSTORE_BASE64 environment variable." >&2
  else
    echo "Keystore backup source: Secret Service android_keystore_base64." >&2
  fi
  if [[ -n "${ANDROID_KEYSTORE_PASSWORD:-}" ]]; then
    echo "Store password source: ANDROID_KEYSTORE_PASSWORD environment variable." >&2
  else
    echo "Store password source: Secret Service android_keystore_password." >&2
  fi
  if [[ -n "$keystore_base64" && "$mode" == build ]]; then
    if [[ -z "$keystore_path" ]]; then
      keystore_path="$(constellation_android_secret_lookup android_keystore_path)" || return 1
    fi
    keystore_path="${keystore_path:-${XDG_CONFIG_HOME:-$HOME/.config}/constellation/android-release.jks}"
  else
    keystore_path="$(constellation_get_or_create_android_secret \
      ANDROID_KEYSTORE_PATH \
      android_keystore_path \
      "Constellation Android keystore path" \
      "${XDG_CONFIG_HOME:-$HOME/.config}/constellation/android-release.jks" \
      0 \
      "$allow_create")" || return 1
  fi
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
    "$existing_keystore" \
    "$allow_create")" || return 1
  export ANDROID_KEYSTORE_PASSWORD
  ANDROID_KEY_ALIAS="$(constellation_get_or_create_android_secret \
    ANDROID_KEY_ALIAS \
    android_key_alias \
    "Constellation Android key alias" \
    "constellation-release-key" \
    "$existing_keystore" \
    "$allow_create")" || return 1
  export ANDROID_KEY_ALIAS

  ANDROID_KEY_PASSWORD="$(constellation_get_or_create_android_secret \
    ANDROID_KEY_PASSWORD \
    android_key_password \
    "Constellation Android key password" \
    "" \
    "$existing_keystore" \
    "$allow_create")" || return 1
  export ANDROID_KEY_PASSWORD

  action="$(constellation_materialize_android_keystore \
    "$keystore_path" \
    "$keystore_base64" \
    "$ANDROID_KEYSTORE_PASSWORD" \
    "$ANDROID_KEY_ALIAS" \
    "$ANDROID_KEY_PASSWORD" \
    "$mode" \
    "$allow_create")"
  if [[ "$action" == "generated" && -z "$keystore_base64" ]]; then
    keystore_base64="$(constellation_encode_android_keystore "$keystore_path")"
    if ! constellation_android_secret_store \
      android_keystore_base64 \
      "Constellation Android keystore backup" \
      "$keystore_base64"; then
      return 1
    fi
  fi
  export ANDROID_KEYSTORE_BASE64="$keystore_base64"
  echo "Android release signing values are ready from Linux Secret Service."
}

prepare_constellation_android_signing() {
  local mode="${1:-build}"
  local interactive="${2:-0}"
  local keystore_path="${ANDROID_KEYSTORE_PATH:-}"

  if [[ $# -lt 2 && -t 0 ]]; then
    interactive=1
  fi
  constellation_require_android_keytool || return 1

  if [[ "$mode" == build && -n "${ANDROID_KEYSTORE_PASSWORD:-}" && -n "${ANDROID_KEY_ALIAS:-}" && -n "${ANDROID_KEY_PASSWORD:-}" && ( -n "${ANDROID_KEYSTORE_BASE64:-}" || ( -n "$keystore_path" && -f "$keystore_path" ) ) ]]; then
    constellation_materialize_android_keystore \
      "${keystore_path:-${XDG_CONFIG_HOME:-$HOME/.config}/constellation/android-release.jks}" \
      "${ANDROID_KEYSTORE_BASE64:-}" \
      "$ANDROID_KEYSTORE_PASSWORD" \
      "$ANDROID_KEY_ALIAS" \
      "$ANDROID_KEY_PASSWORD" >/dev/null || return 1
    export ANDROID_KEYSTORE_PATH ANDROID_KEYSTORE_BASE64 ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD
    return 0
  fi

  if ! constellation_wait_for_android_secret_service "$interactive"; then
    echo "Provide the three ANDROID_* credentials plus ANDROID_KEYSTORE_BASE64 or ANDROID_KEYSTORE_PATH if Secret Service is unavailable." >&2
    return 1
  fi
  constellation_prepare_android_signing_from_secret_service "$mode" "$interactive"
}
