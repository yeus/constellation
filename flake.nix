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
        yarnShim = pkgs.writeShellScriptBin "yarn" ''
          exec ${pkgs.nodejs_22}/bin/corepack yarn "$@"
        '';
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

        appimageFhs = pkgs.buildFHSEnv {
          name = "constellation-appimage-fhs";
          targetPkgs = pkgs: with pkgs; [
            nodejs_22
            rustToolchain
            yarnShim
            pkg-config
            openssl
            zlib
            gtk3
            webkitgtk_4_1
            libsoup_3
            (pkgs.lib.getOutput "out" glib)
            (pkgs.lib.getOutput "bin" glib)
            gsettings-desktop-schemas
            adwaita-icon-theme
            hicolor-icon-theme
            cairo
            pango
            gdk-pixbuf
            librsvg
            atk
            libdecor
            xdg-utils
            git
            libtiff
            fribidi
            harfbuzz
            fontconfig
            freetype
            libxft
            libx11
            libxext
            libxrender
            libxrandr
            libxinerama
            libxcursor
            libxdamage
            libxfixes
            libxcomposite
            libxi
            libxau
            libxdmcp
            libxcb
            libxkbcommon
            libglvnd
            libdrm
            mesa
            libgbm
            expat
            libgpg-error
            squashfsTools
          ];
          runScript = "bash";
        };
        buildAppImageScript = pkgs.writeShellScriptBin "constellation-build-appimage" ''
          set -euo pipefail
          umask 022
          repo_root="$PWD"
          shim_dir="$repo_root/.tmp/appimage-shim"
          run_id="$(date +%s)"
          tmp_dir="$(mktemp -d /tmp/constellation-appimage-tmp.XXXXXX)"
          cache_dir="$repo_root/.tmp/appimage-cache"
          home_dir="/tmp/constellation-appimage-home"
          cargo_target_dir="$tmp_dir/cargo-target"
          schemas_dir="$tmp_dir/glib-2.0/schemas"
          tools_dir="$cache_dir/tauri"
          appimage_plugin="$tools_dir/linuxdeploy-plugin-appimage.AppImage"
          appimage_plugin_extract="$cache_dir/linuxdeploy-plugin-appimage"
          gtk_stage_dir="$tmp_dir/gtk"
          gdk_stage_dir="$tmp_dir/gdk-pixbuf"
          rustup_home="''${RUSTUP_HOME:-$HOME/.rustup}"
          cargo_home="''${CARGO_HOME:-$HOME/.cargo}"
          mkdir -p "$tmp_dir" "$tools_dir" "$home_dir"
          cleanup() {
            status="$?"
            chmod -R u+rwX "$tmp_dir" 2>/dev/null || true
            rm -rf -- "$tmp_dir"
            exit "$status"
          }
          trap cleanup EXIT
          # Older runs used a shell wrapper at this path. Restore the real
          # linuxdeploy binary so the cache remains usable after upgrading.
          if [ -x "$tools_dir/linuxdeploy-real.AppImage" ]; then
            cp "$tools_dir/linuxdeploy-real.AppImage" \
              "$tools_dir/linuxdeploy-x86_64.AppImage"
            chmod +x "$tools_dir/linuxdeploy-x86_64.AppImage"
          fi
          if [ ! -x "$appimage_plugin" ]; then
            ${pkgs.curl}/bin/curl --fail --location --silent --show-error \
              --output "$appimage_plugin" \
              https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/continuous/linuxdeploy-plugin-appimage-x86_64.AppImage
            chmod +x "$appimage_plugin"
          fi
          if [ ! -x "$appimage_plugin_extract/usr/bin/linuxdeploy-plugin-appimage" ]; then
            plugin_offset="$(${pkgs.gnugrep}/bin/grep -abo 'hsqs' "$appimage_plugin" | cut -d: -f1 | while read -r offset; do
              if ${pkgs.squashfsTools}/bin/unsquashfs -offset "$offset" -s "$appimage_plugin" >/dev/null 2>&1; then
                printf '%s\n' "$offset"
                break
              fi
            done)"
            test -n "$plugin_offset"
            ${pkgs.squashfsTools}/bin/unsquashfs -f -d "$appimage_plugin_extract" \
              -offset "$plugin_offset" "$appimage_plugin" >/dev/null
            mv "$appimage_plugin" "$cache_dir/linuxdeploy-plugin-appimage-original.AppImage"
          fi
          cat > "$appimage_plugin" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

appdir="''${APPDIR:-}"
hook="$appdir/apprun-hooks/linuxdeploy-plugin-gtk.sh"
tmp_root="$appdir/tmp"

if [ -d "$appdir" ] && [ -d "$tmp_root" ]; then
  for staged_run in "$tmp_root"/*; do
    [ -d "$staged_run" ] || continue
    case "$staged_run" in
      "$tmp_root"/*) ;;
      *) continue ;;
    esac

    gtk_root="$staged_run/gtk"
    gdk_root="$staged_run/gdk-pixbuf"
    schemas_root="$staged_run/glib-2.0/schemas"

    if [ -d "$gtk_root/lib/gtk-3.0" ]; then
      mkdir -p "$appdir/usr/lib/gtk-3.0"
      cp -a "$gtk_root/lib/gtk-3.0/." "$appdir/usr/lib/gtk-3.0/"
      gtk_path="''${gtk_root#"$appdir"}"
      sed -i "s|''${gtk_path}|/usr|g" "$hook"
    fi

    if [ -d "$gdk_root/lib" ]; then
      mkdir -p "$appdir/usr/lib"
      cp -a "$gdk_root/lib/." "$appdir/usr/lib/"
      gdk_path="''${gdk_root#"$appdir"}"
      sed -i "s|''${gdk_path}|/usr|g" "$hook"
    fi

    if [ -d "$schemas_root" ]; then
      mkdir -p "$appdir/usr/share/glib-2.0/schemas"
      cp -a "$schemas_root/." "$appdir/usr/share/glib-2.0/schemas/"
      schemas_path="''${schemas_root#"$appdir"}"
      sed -i "s|''${schemas_path}|/usr/share/glib-2.0/schemas|g" "$hook"
    fi

    while IFS= read -r -d "" link; do
      target="$(readlink "$link")"
      destination=
      gtk_path="''${gtk_root#"$appdir"}"
      gdk_path="''${gdk_root#"$appdir"}"
      case "$target" in
        "$gtk_path"/*) destination="$appdir/usr''${target#"$gtk_path"}" ;;
        "$gdk_path"/*) destination="$appdir/usr''${target#"$gdk_path"}" ;;
      esac
      if [ -n "$destination" ] && [ -e "$destination" ]; then
        ln -sfn "$(realpath --relative-to="$(dirname "$link")" "$destination")" "$link"
      fi
    done < <(find "$appdir/usr" -type l -print0)

    rm -rf -- "$staged_run"
  done
  find "$tmp_root" -depth -type d -empty -delete
fi

if [ -L "$appdir/.DirIcon" ]; then
  diricon="$(readlink "$appdir/.DirIcon")"
  case "$diricon" in
    "$appdir"/*)
      ln -sfn "''${diricon#"$appdir/"}" "$appdir/.DirIcon"
      ;;
  esac
fi

wrapper_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
          exec "$wrapper_dir/../linuxdeploy-plugin-appimage/usr/bin/linuxdeploy-plugin-appimage" "$@"
EOF
          chmod +x "$appimage_plugin"
          appimagetool="$appimage_plugin_extract/usr/bin/appimagetool"
          appimagetool_real="$appimage_plugin_extract/usr/bin/appimagetool-real"
          if [ ! -x "$appimagetool_real" ]; then
            mv "$appimagetool" "$appimagetool_real"
          fi
          cat > "$appimagetool" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

appdir="''${1:-}"
if [ -d "$appdir" ]; then
  gdk_stage="''${CONSTELLATION_APPIMAGE_GDK_STAGE_DIR:-}"
  if [ -d "$gdk_stage/lib" ]; then
    mkdir -p "$appdir/usr/lib"
    while IFS= read -r -d "" library; do
      cp -L "$library" "$appdir/usr/lib/"
    done < <(find "$gdk_stage/lib" -maxdepth 1 -type f -print0)
  fi

  while IFS= read -r -d "" link; do
    target="$(readlink "$link")"
    destination=
    case "$target" in
      /tmp/*/gtk/*) destination="$appdir/usr''${target#*/gtk}" ;;
      /tmp/*/gdk-pixbuf/*) destination="$appdir/usr''${target#*/gdk-pixbuf}" ;;
    esac
    if [ -n "$destination" ] && [ -e "$destination" ]; then
      ln -sfn "$(realpath --relative-to="$(dirname "$link")" "$destination")" "$link"
    fi
  done < <(find "$appdir/usr" -type l -print0)
fi

tool_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
exec "$tool_dir/appimagetool-real" "$@"
EOF
          chmod +x "$appimagetool"
          mkdir -p "$schemas_dir"
          mkdir -p "$gtk_stage_dir/lib/gtk-3.0"
          cp -L -R ${pkgs.gtk3}/lib/gtk-3.0/. "$gtk_stage_dir/lib/gtk-3.0/"
          mkdir -p "$gdk_stage_dir/lib"
          cp -L ${pkgs.gdk-pixbuf}/lib/libgdk_pixbuf-2.0.so.0 \
            "$gdk_stage_dir/lib/"
          cp -L \
            ${pkgs.fribidi}/lib/libfribidi.so.0 \
            ${pkgs.harfbuzz}/lib/libharfbuzz.so.0 \
            ${pkgs.fontconfig.lib}/lib/libfontconfig.so.1 \
            ${pkgs.freetype}/lib/libfreetype.so.6 \
            ${pkgs.expat}/lib/libexpat.so.1 \
            ${pkgs.libgpg-error}/lib/libgpg-error.so.0 \
            ${pkgs.libx11}/lib/libX11.so.6 \
            ${pkgs.libx11}/lib/libX11-xcb.so.1 \
            ${pkgs.libxcb}/lib/libxcb.so.1 \
            ${pkgs.libgbm}/lib/libgbm.so.1 \
            ${pkgs.libdrm}/lib/libdrm.so.2 \
            ${pkgs.libglvnd}/lib/libEGL.so.1 \
            ${pkgs.libglvnd}/lib/libGLX.so.0 \
            ${pkgs.libglvnd}/lib/libGLdispatch.so.0 \
            ${pkgs.zlib}/lib/libz.so.1 \
            ${pkgs.stdenv.cc.cc.lib}/lib/libstdc++.so.6 \
            ${pkgs.stdenv.cc.cc.lib}/lib/libgcc_s.so.1 \
            "$gdk_stage_dir/lib/"
          cp -L ${pkgs.glib.out}/lib/libgobject-2.0.so.0 \
            ${pkgs.glib.out}/lib/libgio-2.0.so.0 \
            ${pkgs.librsvg}/lib/librsvg-2.so.2 \
            ${pkgs.pango.out}/lib/libpango-1.0.so.0 \
            ${pkgs.pango.out}/lib/libpangocairo-1.0.so.0 \
            ${pkgs.pango.out}/lib/libpangoft2-1.0.so.0 \
            "$gdk_stage_dir/lib/"
          mkdir -p "$gdk_stage_dir/lib/gdk-pixbuf-2.0/2.10.0/loaders"
          cp -L -R ${pkgs.gdk-pixbuf}/lib/gdk-pixbuf-2.0/2.10.0/. \
            "$gdk_stage_dir/lib/gdk-pixbuf-2.0/2.10.0/"
          cp -L -R ${pkgs.librsvg}/lib/gdk-pixbuf-2.0/2.10.0/loaders/. \
            "$gdk_stage_dir/lib/gdk-pixbuf-2.0/2.10.0/loaders/"
          chmod -R u+rwX "$gtk_stage_dir" "$gdk_stage_dir"
          cp -L -R ${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/*/glib-2.0/schemas/. "$schemas_dir/"
          chmod -R u+w "$schemas_dir"
          cp -L -R ${pkgs.gtk3}/share/gsettings-schemas/*/glib-2.0/schemas/. "$schemas_dir/"
          chmod -R u+w "$schemas_dir"
          rm -f "$schemas_dir/gschemas.compiled"
          mkdir -p "$shim_dir"
          cat > "$shim_dir/pkgconf" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "''${1:-}" == "--variable=schemasdir" && "''${2:-}" == "gio-2.0" ]]; then
  # On NixOS, returning a /nix/store schemas path makes linuxdeploy copy a read-only
  # tree into AppDir and then fail when glib-compile-schemas writes gschemas.compiled.
  # Use the FHS path so compilation happens in a writable AppDir/usr/share tree.
  echo "''${CONSTELLATION_APPIMAGE_SCHEMAS_DIR:-/usr/share/glib-2.0/schemas}"
  exit 0
fi
if [[ "''${1:-}" == "--variable=exec_prefix" && "''${2:-}" == "gtk+-3.0" ]]; then
  # Keep the GTK plugin inside the FHS view.  The Nix store prefix is
  # read-only and would make the plugin copy an unwritable tree into AppDir.
  echo "''${CONSTELLATION_APPIMAGE_GTK_STAGE_DIR:-/usr}"
  exit 0
fi
if [[ "''${1:-}" == "--variable=libdir" && "''${2:-}" == "gtk+-3.0" ]]; then
  echo "''${CONSTELLATION_APPIMAGE_GTK_STAGE_DIR:-/usr}/lib"
  exit 0
fi
if [[ "''${1:-}" == "--variable=libdir" && "''${2:-}" == "gdk-pixbuf-2.0" ]]; then
  echo "''${CONSTELLATION_APPIMAGE_GDK_STAGE_DIR:-/usr}/lib"
  exit 0
fi
if [[ "''${1:-}" == "--variable=libdir" ]]; then
  case "''${2:-}" in
    gobject-2.0|gio-2.0|librsvg-2.0|pango|pangocairo|pangoft2)
      echo "''${CONSTELLATION_APPIMAGE_GDK_STAGE_DIR:-/usr}/lib"
      exit 0
      ;;
  esac
fi
if [[ "''${2:-}" == "gdk-pixbuf-2.0" ]]; then
  case "''${1:-}" in
    --variable=gdk_pixbuf_binarydir)
      echo "''${CONSTELLATION_APPIMAGE_GDK_STAGE_DIR:-/usr}/lib/gdk-pixbuf-2.0/2.10.0"
      exit 0
      ;;
    --variable=gdk_pixbuf_cache_file)
      echo "''${CONSTELLATION_APPIMAGE_GDK_STAGE_DIR:-/usr}/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache"
      exit 0
      ;;
    --variable=gdk_pixbuf_moduledir)
      echo "''${CONSTELLATION_APPIMAGE_GDK_STAGE_DIR:-/usr}/lib/gdk-pixbuf-2.0/2.10.0/loaders"
      exit 0
      ;;
  esac
fi
exec /usr/bin/pkg-config "''$@"
EOF
          chmod +x "$shim_dir/pkgconf"
          ln -sf "$shim_dir/pkgconf" "$shim_dir/pkg-config"
          printf 'ID=nixos\n' > "$tmp_dir/os-release"
          env -u LD_LIBRARY_PATH -u PKG_CONFIG_PATH -u NIX_CFLAGS_COMPILE -u NIX_LDFLAGS \
            ${pkgs.nix}/bin/nix develop --no-write-lock-file "$repo_root" --command \
            ${appimageFhs}/bin/constellation-appimage-fhs -lc "cd \"$repo_root\" && ln -sfn \"$tmp_dir/os-release\" /etc/os-release && PATH=\"$shim_dir:\$PATH\" HOME=\"$home_dir\" RUSTUP_HOME=\"$rustup_home\" CARGO_HOME=\"$cargo_home\" CARGO_TARGET_DIR=\"$cargo_target_dir\" TMPDIR=\"$tmp_dir\" XDG_CACHE_HOME=\"$cache_dir\" CONSTELLATION_APPIMAGE_SCHEMAS_DIR=\"$schemas_dir\" CONSTELLATION_APPIMAGE_GTK_STAGE_DIR=\"$gtk_stage_dir\" CONSTELLATION_APPIMAGE_GDK_STAGE_DIR=\"$gdk_stage_dir\" XDG_DATA_DIRS=\"/usr/share:${pkgs.gsettings-desktop-schemas}/share:${pkgs.gtk3}/share:${pkgs.adwaita-icon-theme}/share\" WINIT_WAYLAND_CSD_THEME=light LIBDECOR_PLUGIN_DIR=\"${pkgs.libdecor}/lib/libdecor/plugins-1\" RUST_BACKTRACE=1 APPIMAGE_EXTRACT_AND_RUN=1 /bin/bash scripts/build-appimage.sh --verbose"
        '';
      in
      {
        devShells.default = pkgs.mkShell {
          packages =
            (with pkgs; [
              nodejs_22
              yarnShim
              openssl
              pkg-config
              ripgrep
              xvfb-run
              jdk
              rustToolchain
              androidComposition.androidsdk
              androidComposition.platform-tools
              flatpak
              flatpak-builder
            ])
            ++ pkgs.lib.optional (system == "x86_64-linux") buildAppImageScript
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
        packages = pkgs.lib.optionalAttrs (system == "x86_64-linux") {
          appimage-fhs = appimageFhs;
        };
        apps = pkgs.lib.optionalAttrs (system == "x86_64-linux") {
          build-appimage = flake-utils.lib.mkApp {
            drv = buildAppImageScript;
          };
        };
      }
    );
}
