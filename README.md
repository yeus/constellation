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

Build an AppImage and copy it to `dist/`:

```sh
yarn build:desktop:appimage
```

Inside the Nix development shell, the command runs the Tauri build in a Nix
FHS environment with the Linux libraries required by AppImage. It uses a fresh
temporary Cargo target and copies the artifact to
`dist/constellation-desktop-<version>-x86_64.AppImage`. You can also run the
same builder directly with `nix run .#build-appimage`.

The Flatpak manifest is in `packaging/flatpak`. With Flatpak Builder and the
Flathub remote installed, build a local bundle in `dist/`:

```sh
yarn build:desktop:flatpak
```

The current manifest uses network access to resolve Yarn and Cargo dependencies
during a local build. A source-pinned, offline manifest is still required
before submission to Flathub.

## Android

Initialize generated Android project files once if they are absent:

```sh
yarn android:init
```

Build an x86_64 debug APK for an emulator:

```sh
yarn build:android:dev
```

Build an arm64 debug APK for a device:

```sh
yarn build:android:device
```

Both commands copy their APK to `dist/`. Android configuration and managed
emulator checks are available separately:

```sh
yarn test:android:config
yarn test:android:managed
```

For a signed arm64 release, export `ANDROID_KEYSTORE_PATH`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`,
then run:

```sh
yarn build:android:release
```

Signing values and the temporary Gradle properties file remain outside Git.
The resulting artifact is
`dist/constellation-android-release-arm64-v8a.apk`.

The managed test needs a working emulator and relay connectivity. It uses only
synthetic coordinates.

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
