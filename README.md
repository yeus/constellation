# Constellation

Constellation is a small, decentralized, end-to-end encrypted peer-to-peer
live-location sharing app. A source
creates a private link or QR code, chooses exact, approximate (1 km radius), or
very coarse (20 km radius) disclosure and
an expiry, and can see how many viewers are connected. A recipient opens the
link without creating an account or managing a Space.

Version 0.1 is under active development. The browser flow passes against a
local libp2p circuit relay. Managed Android API 29 and 36 tests passed
background sharing, private return links, locked-screen updates, process
recovery, and shared-text intake. A local-relay test with two Android peers and
a desktop browser passed all three Star links, with two viewers on each Android
source; the desktop peer was a browser, not the packaged Tauri app. Hosted-relay
Android/browser sharing and a Tauri desktop development-app preview also passed
in the sandbox. Hosted web deployment, signed releases, packaged desktop sharing,
direct-path NAT coverage and physical-device acceptance are not yet release-verified.
The 0.1 feature freeze keeps usable live sharing and the online map in scope;
generic Taskyon sensor advertisements/grants and offline PMTiles caching are
deferred to a later release.
The current x86_64 AppImage and Flatpak were rebuilt from the locked Nix flake
in the sandbox. The AppImage passed a virtual-display launch smoke with the
WebKit HTTPS/TLS dependencies bundled. Packaged live-sharing, protected-storage
recovery on a normal host session, artifact signing, and publication remain
release-hardening work.

The map normally shows your current position even before you share. Opening an
incoming link in a browser previews that location immediately without
requesting your own GPS; the source can see your connected session. The preview
is not saved unless you choose **Keep following** and a nickname. After saving,
you may create a separate return share; send its link to the original sender
yourself. Native apps ask before opening an incoming link. You can create
separate timed links, reopen their URLs or QR codes, label connected viewer
devices locally, see connected-session counts, and revoke links individually.
A viewer can follow multiple links and set private labels and marker colors.
The Following list shows last update, session update count, and time until the
link expires. The menu offers Default and Minimalist
map styles that follow the system light/dark theme. The map frames the first
acquired location area, shows approximate regions without a center dot, and
switches your own area to a point when it becomes smaller than the marker at
low zoom. It can frame one or all received locations from Following. The first-run
note, sharing dialog, and About sheet explain how the network works.

Android background sharing requests movement-triggered fixes with a five-second
and five-metre minimum. When an authorized viewer joins after the last fix has
aged, the source asks for one fresh fix, at most once per minute. An existing
last position can appear as stale while waiting; locked-device power policy,
GPS availability, or network conditions may delay or prevent a new fix.

Live location updates are not uploaded to a central location-history service.
Peers use encrypted libp2p connections; the current browser version needs a
configured relay for reachability, and a relay may forward ciphertext when a
direct route is unavailable. If the configured relay is unavailable, browser
sharing may fail. Relays can still see connection metadata, and the map host
sees map requests that may reveal the area being viewed, especially after the
map centers on your position. Your device may store encrypted share settings,
and viewers can save what they receive. Browser users also trust the site to
serve the intended app code; see Privacy and licenses in the app for details.

Map failures show their error text in a red alert, with resource URLs and
location-like values redacted. During `yarn dev`, structured app diagnostics
appear in the browser DevTools console, not in the Vite terminal. Open the
top-left menu and choose **Copy logs** to export the latest 2,000
in-memory entries. The log has no viewer and resets when the UI reloads;
Android service events while the UI is closed are not collected.
The **P2P diagnostics** menu item shows foreground and Android-background
connections, transport types, viewer counts, and last-fix age. Peer IDs and
addresses are hidden unless you explicitly reveal them; they are never copied
into session logs. Treat revealed details and screenshots as sensitive.

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

## Hosted web deployment

The standalone repository's `main` GitHub Actions workflow builds the web app
and publishes `dist/` through GitHub Pages, with `404.html` for client-side
routes. In GitHub repository settings, select **Pages → Source → GitHub Actions**
once, configure `constellation.taskyon.space` as the custom domain, and point its
DNS record at GitHub Pages. Share links keep their capability in the URL
fragment, which the web server never receives.

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

On 2026-09-29, the public hostname still presented a TLS certificate valid only for
`assets.taskyon.space`, not `constellation.taskyon.space`. Fix the domain's
DNS/Pages certificate before testing hosted links or Android App Links.

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
python3 flatpak-node-generator yarn -o packaging/flatpak/generated-sources.json yarn.lock
python3 flatpak-cargo-generator.py src-tauri/Cargo.lock \
  -o packaging/flatpak/cargo-sources.json
```

Validate the manifest, MetaInfo, and generated sources with:

```sh
yarn lint:flatpak
```

For release review, generate a pinned **review draft** from the local manifest:

```sh
node scripts/flatpak-submission-manifest.mjs --tag v0.1.0 --commit <40-char-sha>
```

The generated file is deliberately marked `REVIEW DRAFT ONLY`. Flathub's current
submission policy forbids AI-generated or AI-assisted manifest content, so a
human maintainer must independently author the final Flathub manifest rather
than submitting this draft. The remaining submission work is external: cut and
push the v0.1.0 tag, author the final manifest against that commit, and build and
lint the bundle on a Flatpak-capable host.

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

`.github/workflows/ci.yml` owns the regular quality, browser-regression, and
GitHub Pages jobs. `.github/workflows/release.yml` follows the same tagged
release pattern as Syncpeer: a tag builds the AppImage, Flatpak, and signed
arm64 APK in separate jobs, creates `SHA256SUMS`, and publishes all artifacts
to one GitHub Release.

The tag must use the application version from `package.json` and
`src-tauri/tauri.conf.json`. A final tag can be `v0.1.0`; test releases may
use a suffix such as `v0.1.0-test.1` without changing the application version.
Tags with a suffix are published as GitHub prereleases.

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
