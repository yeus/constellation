{
  description = "Constellation web, Tauri, and Android development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    fenix = {
      url = "github:nix-community/fenix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    { nixpkgs, flake-utils, fenix, ... }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config = {
            allowUnfree = true;
            android_sdk.accept_license = true;
          };
        };

        android = {
          platformVersions = [ "29" "36" ];
          buildToolsVersion = "35.0.0";
          ndkVersion = "28.2.13676358";
          cmakeVersion = "3.22.1";
          cmdLineToolsVersion = "13.0";
        };

        androidComposition = pkgs.androidenv.composeAndroidPackages {
          cmdLineToolsVersion = android.cmdLineToolsVersion;
          buildToolsVersions = [ android.buildToolsVersion ];
          platformVersions = android.platformVersions;
          includeSystemImages = true;
          systemImageTypes = [ "google_apis_playstore" ];
          abiVersions = [ "x86_64" ];
          includeEmulator = "if-supported";
          includeNDK = true;
          ndkVersions = [ android.ndkVersion ];
          cmakeVersions = [ android.cmakeVersion ];
        };

        androidSdkRoot = "${androidComposition.androidsdk}/libexec/android-sdk";
        jdk = pkgs.jdk17;
        rustToolchain = with fenix.packages.${system}; combine [
          stable.cargo
          stable.clippy
          stable.rust-src
          stable.rustc
          stable.rustfmt
          targets.aarch64-linux-android.stable.rust-std
          targets.x86_64-linux-android.stable.rust-std
        ];

        desktopLibraries = with pkgs; [
          atk
          cairo
          gdk-pixbuf
          glib
          glib-networking
          gtk3
          libsoup_3
          pango
          webkitgtk_4_1
        ];

        browserLibraries = with pkgs; [
          alsa-lib
          cups
          dbus
          expat
          libdrm
          libgbm
          libxkbcommon
          mesa
          nspr
          nss
          libx11
          libxcomposite
          libxdamage
          libxext
          libxfixes
          libxrandr
          libxcb
        ];
      in
      {
        devShells.default = pkgs.mkShell {
          packages =
            (with pkgs; [
              git
              nodejs_22
              openssl
              pkg-config
              ripgrep
              xvfb-run
              jdk
              rustToolchain
              androidComposition.androidsdk
              androidComposition.platform-tools
            ])
            ++ desktopLibraries
            ++ browserLibraries
            ++ pkgs.lib.optional
              (pkgs.stdenv.hostPlatform.isx86_64 || pkgs.stdenv.hostPlatform.isDarwin)
              androidComposition.emulator;

          ANDROID_HOME = androidSdkRoot;
          ANDROID_SDK_ROOT = androidSdkRoot;
          NDK_HOME = "${androidSdkRoot}/ndk/${android.ndkVersion}";
          JAVA_HOME = "${jdk}";
          RUST_BACKTRACE = "1";

          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath (
            desktopLibraries ++ browserLibraries
          );

          __EGL_VENDOR_LIBRARY_FILENAMES =
            "${pkgs.mesa}/share/glvnd/egl_vendor.d/50_mesa.json";
          LIBGL_DRIVERS_PATH = "${pkgs.mesa}/lib/dri";

          shellHook = ''
            export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
            export ANDROID_USER_HOME="''${ANDROID_USER_HOME:-''${XDG_STATE_HOME:-$HOME/.local/state}/constellation/android}"
            export ANDROID_AVD_HOME="''${ANDROID_AVD_HOME:-$ANDROID_USER_HOME/avd}"
            export ANDROID_EMULATOR_HOME="''${ANDROID_EMULATOR_HOME:-$ANDROID_USER_HOME/emulator}"
            export CARGO_TARGET_DIR="''${CARGO_TARGET_DIR:-''${XDG_CACHE_HOME:-$HOME/.cache}/constellation/cargo-target}"
            export GRADLE_USER_HOME="''${GRADLE_USER_HOME:-''${XDG_CACHE_HOME:-$HOME/.cache}/constellation/gradle}"
            export XDG_DATA_DIRS="${pkgs.gsettings-desktop-schemas}/share:${pkgs.gtk3}/share:${pkgs.glib}/share:''${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"

            if [ -n "''${WAYLAND_DISPLAY:-}" ] || [ "''${XDG_SESSION_TYPE:-}" = "wayland" ]; then
              export WEBKIT_DISABLE_DMABUF_RENDERER="1"
            fi

            echo "Constellation development shell"
            echo "Node $(node --version), Java $(${jdk}/bin/java -version 2>&1 | head -n 1)"
            echo "Rust $(rustc --version)"
          '';
        };
      }
    );
}
