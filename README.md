# Constellation

Constellation is a small peer-to-peer live-location sharing app. A source
creates a private link or QR code, chooses exact or approximate disclosure and
an expiry, and can see how many viewers are connected. A recipient opens the
link without creating an account or managing a Space.

Version 0.1 is under active development. The browser flow and Android
foreground-service flow work through the configured libp2p circuit relay.
Linux desktop packaging, hosted deployment, signed releases, direct-path NAT
coverage and physical-device acceptance are not yet release-verified.

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
loading an incompatible Nix glibc.

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

The Flatpak manifest is in `packaging/flatpak`. With Flatpak Builder and the
Flathub remote installed, build a local bundle in `dist/`:

```sh
yarn build:desktop:release:flatpak
```

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

The Gradle build generates the background-service bundle automatically through
`build:android:background-runtime`; you can invoke that script directly for the
intermediate `dist-background/constellation-background.js` bundle, but it is
not an installable app. The managed test needs a working emulator and relay
connectivity. It uses only synthetic coordinates.

## Architecture and security

Constellation is a self-contained repository. Temporary Taskyon protocol and
libp2p snapshots live under `vendor/taskyon` and are imported by package name;
released Taskyon packages can replace them later without changing application
imports.

Share capabilities stay in the URL fragment. The relay transports encrypted,
capability-scoped streams and does not receive location history from the app.
The application keeps only current observations in memory. Approximate sharing
publishes a bounded area containing the real position rather than claiming a
displaced point is exact.

`SYSTEM_DEFINITION.csv` is the canonical record of requirements, current
evidence, release scope and known limitations. Keep it synchronized with every
behavioral change.

## License

MIT. See `LICENSE`.
