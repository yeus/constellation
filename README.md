# Constellation

Constellation is a small, decentralized, end-to-end encrypted peer-to-peer
live-location sharing app. A source
creates a private link or QR code, chooses exact, approximate (1 km radius), or
very coarse (20 km radius) disclosure and
an expiry, and can see how many viewers are connected. A recipient opens the
link without creating an account or managing a Space.

Version 0.1 is under active development. The browser flow passes against a
local libp2p circuit relay. A fresh Chromium probe also obtained a reservation
from the hosted relay, but cross-device sharing through that relay still needs
acceptance testing. The current Android debug APK compiles; its new share-target
and protected-store paths have not yet passed an emulator runtime test.
Hosted deployment, signed releases, direct-path NAT coverage and physical-device
acceptance are not yet release-verified.

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
A Chromium reservation probe succeeded on 2026-09-24; this does not establish
that Android-to-browser sharing is reliable across arbitrary networks.

## Hosted web deployment

The standalone repository's `main` pipeline builds the web app and publishes
`dist/` through GitLab Pages, with `404.html` for client-side routes. Configure
`constellation.taskyon.space` as a public GitLab Pages custom domain with HTTPS
and the required DNS record; the repository cannot configure those external
settings itself. Share links keep their capability in the URL fragment, which
the web server never receives.

For verified Android App Links, set the GitLab CI variable
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

The current manifest uses network access to resolve Yarn and Cargo dependencies
during a local build. A source-pinned, offline manifest is still required
before submission to Flathub.

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
the Nix shell provides its `secret-tool` client. If no signing entries exist
yet, the build creates random passwords and a keystore, then stores the signing
values and a keystore backup in Secret Service. Keep that keyring backed up:
losing the keystore means this signing identity cannot produce updates for
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
The resulting artifact is
`dist/constellation-android-release-arm64-v8a.apk`.
On systems without Linux Secret Service, provide all four `ANDROID_*` signing
variables and an existing keystore file instead.
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

The Gradle build generates the background-service bundle automatically through
`build:android:background-runtime`; you can invoke that script directly for the
intermediate `dist-background/constellation-background.js` bundle, but it is
not an installable app. The managed test needs a working emulator and relay
connectivity. It uses only synthetic coordinates.

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
temporary and saving is refused; native recovery is not yet device-tested.
Android's native foreground
service currently owns one background link; extra foreground-only UI links
use a separate peer and stop when the app closes. Delegated resharing and
group share-back modes are still design requirements, not available features.

`SYSTEM_DEFINITION.csv` is the canonical record of requirements, current
evidence, release scope and known limitations. Keep it synchronized with every
behavioral change.

## License

MIT. See `LICENSE`. The map visibly credits OpenStreetMap contributors,
Protomaps, and ESA WorldCover. Bundled map asset notices are in
`THIRD_PARTY_NOTICES.md` and the app's About screen. A complete final-artifact
dependency license inventory is still required before publication.
