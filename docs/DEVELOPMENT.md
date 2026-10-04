# Development and release guide

For app downloads and usage, see the [README](../README.md).

## Development

The locked Nix shell includes Node 22, Yarn 4, Rust, Java 17, Tauri's Linux
dependencies and the Android SDK/NDK:

```sh
nix develop
yarn install --immutable
yarn dev
```

Without Nix, use Node 22 and Corepack:

```sh
corepack yarn install --immutable
corepack yarn dev
```

Run the lightweight quality checks with:

```sh
yarn lint
yarn test
yarn build
yarn test:e2e
```

The end-to-end browser launcher removes a Nix-only library override before
starting Playwright's downloaded Chromium. This prevents host Chromium from
loading an incompatible Nix glibc. Browser P2P tests start a disposable
localhost Taskyon circuit relay, so they do not depend on the hosted relay;
Android interoperability tests exercise the configured hosted relay separately.
A managed API 36 Android/browser hosted-relay flow passed on 2026-09-29 after
one earlier run lost its WebView debugger connection following screen wake.
This does not establish reliability across arbitrary networks.

## Runtime diagnostics

Map failures show a redacted error alert. During `yarn dev`, structured app
diagnostics appear in the browser DevTools console, rather than the Vite
terminal. Choose **Copy logs** in the upper-left menu to export the latest 2,000
in-memory entries. They reset on reload; Android service events while the UI is
closed are not collected.

**P2P diagnostics** shows foreground and Android-background connections,
transport types, viewer counts, and last-fix age. Peer IDs and addresses stay
hidden unless explicitly revealed and are never copied into session logs.
Treat revealed details and screenshots as sensitive.

The map worker uses MapLibre GL JS 6's ESM worker through Vite's `?worker&url`
pipeline. A module bootstrap imports the Android compatibility layer before the
bundled worker, so the Pages and Tauri builds use the same worker setup.
Screenshot capture waits for the map's rendered state after its sources and
tiles finish loading.

## Hosted web deployment

The standalone repository's `main` GitHub Actions workflow builds the web app
and publishes `dist/` through GitHub Pages, with `404.html` for client-side
routes. The custom domain `constellation.taskyon.space` is configured and the
hosted app is available. Share links keep their capability in the URL fragment,
which the web server never receives.

Reproduce the whole Pages path locally before deploying:

```sh
yarn test:pages
```

`yarn build:pages` runs the production build with
`VITE_CONSTELLATION_PUBLIC_URL=https://constellation.taskyon.space/` and then
`prepare-pages.mjs`; `yarn test:pages` adds a preflight that asserts the SPA
fallback, root-host asset paths, baked public URL, map assets, and Android App
Links consistency, then serves the built `dist/` with Pages-like 404 fallback
through a dumb static server and checks boot, the synthetic fragment flow, and
that the fragment never reaches the server. The GitHub Pages build and browser
regression jobs invoke the same commands.

For verified Android App Links, set the GitHub Actions repository secret
`ANDROID_APP_LINK_SHA256` to the uppercase colon-separated SHA-256 fingerprint
of the release signing certificate. If Play App Signing is used, use the Play
app-signing certificate, not merely the upload key. The pipeline then writes
`.well-known/assetlinks.json` for `space.taskyon.constellation`. Without this
variable the web app still deploys, but the pipeline warns and Android App
Links remain unverified. Confirm the hosted file and real release APK on a
device before claiming that HTTPS links open the app automatically.

## Tauri desktop

Run the Linux desktop shell during development:

```sh
yarn tauri dev
```

The Nix shell exposes GLib's TLS module so the desktop WebKit can fetch HTTPS
map tiles and reach the relay. A virtual-display development-app check received
a browser share over the hosted relay on 2026-09-29; packaged desktop sharing
and protected-storage recovery remain to be checked on a normal host session.

Build a release AppImage and copy it to `dist/`:

```sh
yarn build:desktop:release:appimage
```

Inside the Nix development shell, the command runs the Tauri build in a Nix
FHS environment with the Linux libraries required by AppImage. It uses a fresh
temporary Cargo target and copies the artifact to
`dist/constellation-desktop-<version>-x86_64.AppImage`. You can also run the
same builder directly with `nix run .#build-desktop-release-appimage`.

The Flatpak manifest is in `packaging/flatpak`. Build the `stable` branch as a
local bundle in `dist/` using the Nix development shell or its dedicated app:

```sh
yarn build:desktop:release:flatpak
```

`nix run .#build-flatpak` provides the build tools directly. Both commands
add the Flathub user remote if needed. Flatpak Builder needs permission to
create its own build sandbox, which may be unavailable inside an outer
container.

The Flatpak build is offline. Yarn and Cargo dependency sources are pinned with
checksums in `packaging/flatpak/generated-sources.json` and
`packaging/flatpak/cargo-sources.json`, and the Yarn CLI is pinned as a source
file. Regenerate both with the flatpak-builder-tools generators after a lockfile
change:

```sh
python3 flatpak-node-generator yarn \
  -o packaging/flatpak/generated-sources.json \
  yarn.lock
python3 flatpak-cargo-generator.py \
  src-tauri/Cargo.lock \
  -o packaging/flatpak/cargo-sources.json
```

The repository keeps a small adjustment in the generated `flatpak-node` Yarn
plugin: its Yarn Classic CLI argument stays optional and fails explicitly only
if a Yarn Classic Git dependency is added. Preserve that adjustment when
regenerating the file; `yarn lint:flatpak` checks it along with source coverage.

Validate the manifest, MetaInfo, and generated sources with:

```sh
yarn lint:flatpak
```

This check also confirms that every registry package in `yarn.lock` has a generated offline
source, so a dependency update cannot silently leave the Flatpak cache stale.

For release review, generate a pinned **review draft** from the local manifest:

```sh
node scripts/flatpak-submission-manifest.mjs \
  --tag v0.1.0 --commit YOUR_COMMIT_SHA
```

The generated file is deliberately marked `REVIEW DRAFT ONLY`. Flathub's current
submission policy forbids AI-generated or AI-assisted manifest content, so a
human maintainer must independently author the final Flathub manifest rather
than submitting this draft. The remaining submission work is external: prepare
and push a release with `yarn release <version>`, author the final manifest
against that commit, and build and lint the bundle on a Flatpak-capable host.

## Android

Initialize generated Android project files once if they are absent:

```sh
yarn android:init
```

Build a debug APK for an x86_64 emulator:

```sh
yarn build:android:debug:x86_64-emulator
```

Build a debug APK for an arm64 physical device:

```sh
yarn build:android:debug:arm64-device
```

Both commands copy their APK to `dist/`. Android configuration and managed
emulator checks are available separately:

```sh
yarn test:android:config
yarn test:android:managed
```

On Linux, the release command uses Secret Service (`secret-tool`) for Android
signing. The desktop session must provide a working, unlocked Secret Service;
the Nix shell provides its `secret-tool` client. Run `nix develop` from
Constellation itself before building: the Taskyon root shell may not provide
the JDK 17 `keytool`. The release command checks for it before looking up
signing secrets and reports a missing tool separately from an incorrect
password. A normal release build reads existing signing values and validates
a temporary copy of the stored keystore backup (or of the local file when no
backup exists). It does not replace the
local file or stored values. If Secret Service is unavailable or locked, an
interactive build asks you to unlock/start it and retry; a noninteractive build
stops. When the store is reachable and no Constellation signing entries or
local keystore exist, the CLI asks you to type `CREATE` before generating a new
signing identity. A new key cannot update APKs signed with an earlier key.
Keep that keyring backed up: losing the keystore means this signing identity
cannot produce updates for
already-installed copies of the app.

The five Secret Service entries are `android_keystore_path` (local file path),
`android_keystore_base64` (file backup), `android_key_alias` (key name),
`android_keystore_password` (opens the file), and `android_key_password`
(unlocks the private key). KeePassXC may ask permission for each lookup; those
prompts only authorize reading entries, not the key itself.

Run either the short command or its explicit arm64-target equivalent:

```sh
yarn build:android:release
# Explicit arm64 target:
yarn build:android:release:arm64-device
```

Signing values and the temporary Gradle properties file remain outside Git.
The resulting artifacts are
`dist/constellation-android-release-arm64-v8a.apk` and its SHA-256 sidecar
`dist/constellation-android-release-arm64-v8a.apk.sha256`.
Before copying them there, the release command uses Android build tools to verify
the APK signature and fails if verification fails or the verifier is missing.
The checksum is generated only after that signature verification succeeds.

## GitHub Actions releases

| Workflow                      | Purpose                                                                                              | When it runs                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Checks and Deploy Website** | Quality and browser checks; screenshot previews; deploys the website to GitHub Pages                 | Pull requests and pushes to `main`; Pages deployment runs only on pushes to `main`   |
| **Build and Publish Apps**    | Builds Android APK, Linux AppImage and Flatpak, captures screenshots, and publishes a GitHub release | Tags matching `v*`                                                                   |
| **CodeQL**                    | GitHub security analysis                                                                             | Configured separately in GitHub; no CodeQL workflow file is present in this checkout |

The website workflow lives in `.github/workflows/ci.yml`; the application release
workflow lives in `.github/workflows/release.yml`. Screenshot previews run in a
separate job and do not gate the existing Pages deployment. Release publication
requires all three screenshots as well as the install packages.

### Download CI logs locally

Use Node.js 22 and your own authenticated GitHub CLI (`gh`). This script targets
`yeus/constellation` explicitly, even if your default Git remote is GitLab:

```sh
scripts/download-ci-logs.sh
scripts/download-ci-logs.sh RUN_ID
```

Without an argument it discovers workflows through GitHub, including managed
workflows when returned by the API, and downloads the **latest completed run of
each workflow**, on any branch or tag, whether it succeeded or failed. Discovery
and job listing follow every API page. A newer queued or running run is reported;
its complete logs are not ready yet. A workflow with no completed run is reported
without producing an empty log.

You can also pass a Constellation Actions run URL. Explicit runs must be completed.
Every job log is fetched with `gh run view --job --attempt --log`, so job IDs and reruns remain distinct. Each capture pins the run attempt and writes:

- `.ci-logs/<workflow-id>/<run-id>/attempt-<number>/run.json`: run and job metadata,
  plus the download result for every job.
- One `<job-id>-<job-name>.log` per executed job, containing its full raw log,
  including successful steps. Skipped jobs are recorded without a log.
- `.ci-logs/latest.json`: an inventory of this invocation, including active runs,
  skipped jobs, and failures.

Rerunning refreshes the selected logs atomically and preserves older captures.
Unavailable or expired logs are reported, previous files are preserved, and other
workflows still download. Partial failures return a nonzero exit status. If a
workflow you expect is absent from the inventory, check GitHub's Actions settings
and your account's Actions read access. GitHub controls log retention.

The folder is ignored by Git; generated files are private to the local user.
Review raw logs for private paths, identifiers, or credentials before sharing.
The script never publishes them or needs a token committed to the repository.

### Release screenshots

```sh
yarn screenshots
```

Playwright starts the local app and disposable relay and captures three browser
screens at 430 × 860, with light theme, English labels, UTC, and reduced motion:
welcome, share settings before a private link exists, and Following with the
fictional River and Forest locations. It grants only synthetic geolocation and
waits for the map and interface. Map failures fail capture. No production peers,
share URLs, QR codes, videos, or traces are published.

Outputs are ignored in `.screenshots/`:

- `constellation-welcome.png`
- `constellation-share.png`
- `constellation-following.png`

CI uploads a `screenshot-previews` artifact. Tagged releases capture the tagged
source and publish all three PNGs as release assets. Inspect them visually before
adding a README gallery. Pin all three image URLs to the reviewed tag using
`https://github.com/yeus/constellation/releases/download/<tag>/<filename>`.
Caption the gallery as the browser interface, and update the pinned tag only
after reviewing new images. Do not commit these generated screenshot binaries.

`package.json` is the canonical application version. Prepare a release from a
clean checkout with:

```sh
yarn release 0.1.1
```

The command checks metadata, updates Tauri and Cargo versions and Cargo.lock,
adds a dated Flatpak AppStream release while preserving prior entries, then
creates a release commit and annotated local tag after confirmation. Use
`yarn release --dry-run 0.1.1` to preview or `yarn release --check` to validate
the current metadata. It prints the command to push the branch and tag, but does
not push them. Browser build metadata and AppImage/Flatpak artifact names derive
from `package.json`. During Android builds, the Tauri CLI regenerates the ignored
`tauri.properties` with the configured application version and its derived version
code; the release command does not edit that generated file directly.

If the tag does not exist yet, the current version can be tagged as-is. For
example, `yarn release 0.1.0` creates `v0.1.0` at the clean current commit
without rewriting its already-consistent metadata. A higher version such as
`0.1.1` updates the version files and creates a release commit before tagging.

The pushed tag must use the application version, such as `v0.1.1`; test
releases may use a suffix such as `v0.1.1-test.1` without changing the
application version. Tags with a suffix are published as GitHub prereleases.

Configure these protected GitHub Actions repository secrets before pushing a
release tag:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

The release workflow passes those values only to the tag-triggered Android job.
Pull-request and ordinary branch CI never receive the signing key. The separate
`ANDROID_APP_LINK_SHA256` secret is used only while building GitHub Pages.

On systems without Linux Secret Service, provide the three signing credentials
and either `ANDROID_KEYSTORE_BASE64` or `ANDROID_KEYSTORE_PATH`.
Before Gradle starts, the release command checks that both the keystore
password and the key password unlock the configured alias. If the key password
check fails, restore the original `android_key_password` entry in Secret
Service (or supply the matching `ANDROID_KEY_PASSWORD`). Keep the existing
keystore: generating a new key would prevent updates to an app signed with
the old one. If either password entry is unavailable while a keystore or backup
already exists, the script stops instead of generating a replacement. A locked
or slow KeePassXC database can make a lookup appear missing; unlock it before
retrying, and check the key password entry's history if a previous build
updated it.

If the local keystore is missing or does not match, the release build leaves it
alone and signs from the validated backup. If both files validate but differ
in bytes, the build stops: identify which certificate signed the
published app before choosing either identity. To restore a matching backup
to the local path for other tools, explicitly run:

```sh
yarn android:signing:restore
```

The restore command validates the backup before writing the local keystore. If
it replaces an existing file, it reports the path of a preserved copy. A
failed validation leaves the local file unchanged. If both local and stored
backup fail with the same password, investigate the stored password and backup
first; copying that backup over the local file cannot fix the mismatch.

The Gradle build generates the background-service bundle automatically through
`build:android:background-runtime`; you can invoke that script directly for the
intermediate `dist-background/constellation-background.js` bundle, but it is
not an installable app. The managed test needs a working emulator and relay
connectivity. It uses only synthetic coordinates.

The managed harness also has three opt-in policy fixtures that use the local-relay
APK. Unless `--skip-build` is used, it builds that APK itself with
`VITE_CONSTELLATION_RELAY_ADDRS=/ip4/127.0.0.1/tcp/9111/ws`, which the emulator
reaches through `adb reverse`. `--direct-transport-smoke` asserts that Android
classifies a direct transport for a browser viewer, then stops the local relay
and requires location updates to continue over the surviving direct path.
`--captive-transport-smoke` answers the configured relay endpoint with an HTTP
302 captive response, requires a fail-closed result with no share or service,
then verifies sharing recovers with the real relay. `--metered-policy-smoke`
checks both the metered and Data Saver pauses, proves that a paused link stops
publishing, and verifies automatic resume with the same share identity.

Background links offer a Balanced or Battery saver sampling preset and an
optional "pause on metered networks and Data Saver" policy, off by default.
Pausing applies per link: a link that opted in stops publishing while the
restriction lasts, while other links keep updating at the strictest active
sampling preset. The paused link, grant, connected viewers, and absolute expiry
remain, and collection resumes automatically once the network is unmetered or
Data Saver is cleared. The pause reason appears in the map status, active-share
sheet, Android notification, and diagnostics.

Android also declares a `text/plain` share target: sharing a Constellation link
from a messenger opens a one-time in-app approval before the recipient connects.
An external camera app can handle QR codes through the same HTTPS link. Android
App Link verification requires the deployed `assetlinks.json` described above.

## Architecture and security

Constellation is a self-contained repository. Temporary Taskyon protocol and
libp2p snapshots live under `vendor/taskyon` and are imported by package name;
released Taskyon packages can replace them later without changing application
imports.

Share capabilities stay in the URL fragment. The relay transports encrypted,
capability-scoped streams and does not receive location history from the app.
The application keeps only current observations in memory. Approximate and very
coarse sharing publish a bounded area containing the reported uncertainty,
rather than claiming a displaced point is exact. They reduce precision but do
not make a viewer's observations anonymous; repeated areas can reveal movement.

Browser grants, saved followed links, peer identity, and approximate-region
control state are encrypted in IndexedDB and survive reload. Temporary previews
are not saved. The WebCrypto key lives
in the same browser profile; this does not protect against a malicious
same-origin script or someone who controls that profile. Android UI state now
uses a separate Keystore-encrypted record and Linux desktop state uses Secret
Service. If protected storage is unavailable, incoming previews remain
temporary and saving is refused. Two saved follows and their locations recovered
after force-stopping and relaunching the app on an API 36 emulator; Linux Secret Service recovery
still needs packaged-desktop verification. Android's native foreground service
owns active background links, while foreground-only links stop when the app
closes. Delegated resharing and group share-back modes are still design
requirements, not available features.

`SYSTEM_DEFINITION.csv` is the canonical record of requirements, current
evidence, release scope and known limitations. Keep it synchronized with every
behavioral change.

## License

MIT. See `LICENSE`. The map visibly credits OpenStreetMap contributors,
Protomaps, and ESA WorldCover. Bundled map asset notices are in
`THIRD_PARTY_NOTICES.md` and the app's About screen. A complete final-artifact
dependency license inventory is still required before publication.
