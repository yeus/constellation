#!/usr/bin/env bash
set -euo pipefail

assets_dir="${1:?usage: $0 ASSETS_DIR TAG}"
tag="${2:?usage: $0 ASSETS_DIR TAG}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
[[ -d "$assets_dir" ]] || {
  echo "Assets directory does not exist: $assets_dir" >&2
  exit 1
}

api_root="https://api.github.com/repos/$GITHUB_REPOSITORY"
api_headers=(
  --header 'Accept: application/vnd.github+json'
  --header "Authorization: Bearer $GITHUB_TOKEN"
  --header 'X-GitHub-Api-Version: 2022-11-28'
)

github_api() {
  curl --fail-with-body --silent --show-error "${api_headers[@]}" "$@"
}

if release_json="$(github_api "$api_root/releases/tags/$tag" 2>/dev/null)"; then
  echo "Using existing GitHub release for $tag."
else
  prerelease=false
  if [[ "$tag" == *-* ]]; then
    prerelease=true
  fi
  release_payload="$(jq -n \
    --arg tag "$tag" \
    --arg name "Constellation $tag" \
    --argjson prerelease "$prerelease" \
    '{tag_name: $tag, name: $name, draft: true, prerelease: $prerelease, generate_release_notes: true}')"
  release_json="$(github_api \
    --request POST \
    --header 'Content-Type: application/json' \
    --data "$release_payload" \
    "$api_root/releases")"
  echo "Created draft GitHub release for $tag."
fi

release_id="$(jq -er '.id' <<<"$release_json")"
upload_url="$(jq -er '.upload_url' <<<"$release_json" | sed 's/{?name,label}$//')"

while IFS= read -r -d '' asset; do
  asset_name="$(basename "$asset")"
  encoded_name="$(jq -rn --arg name "$asset_name" '$name | @uri')"
  existing_asset_id="$(github_api \
    "$api_root/releases/$release_id/assets?per_page=100" \
    | jq -r --arg name "$asset_name" \
      '.[] | select(.name == $name) | .id' \
    | head -n 1)"

  if [[ -n "$existing_asset_id" ]]; then
    github_api \
      --request DELETE \
      "$api_root/releases/$release_id/assets/$existing_asset_id" \
      >/dev/null
  fi

  github_api \
    --request POST \
    --header 'Content-Type: application/octet-stream' \
    --data-binary "@$asset" \
    "$upload_url?name=$encoded_name" \
    >/dev/null
  echo "Uploaded $asset_name."
done < <(find "$assets_dir" -maxdepth 1 -type f -print0 | sort -z)

prerelease=false
if [[ "$tag" == *-* ]]; then
  prerelease=true
fi
publish_payload="$(jq -n --argjson prerelease "$prerelease" \
  '{draft: false, prerelease: $prerelease}')"
published_json="$(github_api \
  --request PATCH \
  --header 'Content-Type: application/json' \
  --data "$publish_payload" \
  "$api_root/releases/$release_id")"
echo "Published release: $(jq -er '.html_url' <<<"$published_json")"

