# Third-party notices

Constellation's own source is MIT-licensed. The following map assets and data retain their
separate licenses and attribution requirements. This file is included in the app's About screen.

## Map data

- © OpenStreetMap contributors. OpenStreetMap data is under the Open Database License (ODbL):
  https://www.openstreetmap.org/copyright
- Protomaps basemap tiles and styles: https://github.com/protomaps/basemaps
- Landcover shown by the basemap derives from ESA WorldCover (CC BY 4.0), distributed through
  Overture Maps. © ESA WorldCover project 2020 / Contains modified Copernicus Sentinel data
  (2020) processed by ESA WorldCover consortium.
  https://docs.overturemaps.org/attribution/
- Natural Earth data is public domain: https://www.naturalearthdata.com/about/terms-of-use/

## Protomaps basemap code and design

Protomaps basemap code is BSD-3-Clause; its map visual design is CC0.
https://github.com/protomaps/basemaps/blob/main/LICENSE.md

Copyright 2019-2023 Protomaps LLC, Kelso Cartography

Redistribution and use in source and binary forms, with or without modification, are permitted
provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions
   and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions
   and the following disclaimer in the documentation and/or other materials provided with the
   distribution.
3. Neither the name of the copyright holder nor the names of its contributors may be used to
   endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR
IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER
IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT
OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## Protomaps v4 sprite sheets and MIT-licensed upstream material

The locally bundled Protomaps v4 sprite sheets derive from MIT-licensed Tangram icons. Their
original copyright notice is below. The Protomaps basemap license also retains the separate
Mapzen/Linux Foundation MIT notice for upstream material used in its styles.
https://github.com/protomaps/basemaps-assets
https://github.com/tangrams/icons/blob/master/LICENSE.md

Copyright (c) 2017 Mapzen

Copyright (c) 2015-2018 Mapzen. Copyright (c) 2019 Linux Foundation.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Fonts

MapLibre renders map labels using fonts available on the device. Constellation does not bundle map
font files or glyph ranges; label appearance and script coverage depend on the device's fonts.

## Bundled software

Taskyon protocol and P2P source snapshots retain their upstream MIT notices. MapLibre GL JS,
PMTiles, libp2p, Vue, Tauri, and their transitive dependencies retain their own licenses.

Run the dependency inventory before publication:

```sh
yarn licenses:inventory
```

On 2026-10-01 the x86_64 inventory reported 245 installed JavaScript production packages: 243 under
permissive licenses and two MPL-2.0 packages, `node-datachannel` and its installed
`@node-datachannel/linux-x64-gnu` optional binary package. Both are Node-only dependencies and are
not bundled in the web, background, or desktop application bundles. The architecture-specific
optional package can differ on another build host. The Cargo inventory reported 504 packages:
499 permissive and five MPL-2.0 crates (`cssparser`, `cssparser-macros`, `dtoa-short`, `option-ext`,
`selectors`). `r-efi` is offered under MIT OR Apache-2.0 OR LGPL-2.1-or-later and can be used under
the permissive alternatives. No inventoried package lacked a license field.

Run the artifact-level triage for the Android APK and an extracted AppImage payload:

```sh
yarn licenses:artifacts --strict \
  --apk dist/constellation-android-release-arm64-v8a.apk \
  --appimage-root <extracted-AppImage-root>
```

## Android APK

The APK contains one `classes.dex` (Constellation/Tauri plus AndroidX and Kotlin, Apache-2.0), one
native library (`libconstellation_lib.so`, Constellation's own MIT-licensed Rust code), and the
background-sharing JavaScript bundle (Constellation/Taskyon MIT plus the JavaScript dependency
inventory above). Bundled Gradle dependencies ship their own notices under `META-INF/` (for example
FastDoubleParser, AndroidX annotation, AndroidX lifecycle, and bigint). No other third-party native
libraries are packaged.

## AppImage bundled platform libraries

The AppImage bundles the GTK/WebKitGTK desktop stack (191 libraries): GTK, GDK, ATK, Pango,
GdkPixbuf, GLib/GIO, WebKitGTK/JavaScriptCore, libsoup, GnuTLS/glib-networking, libsecret, GStreamer,
FFmpeg, Mesa, X11, image codecs, ICU, FreeType, HarfBuzz, and their support libraries. These retain
their upstream licenses, predominantly LGPL-2.1-or-later, MIT, BSD-like, Apache-2.0, MPL-2.0, the
Unicode license, and the GCC runtime exception. `yarn licenses:artifacts` classifies every bundled
library into these families and currently reports no unclassified library. The AppImage does not
bundle the full upstream license texts for these libraries; a human publication review must confirm
that the required LGPL notices, source-offer, and relinking conditions are satisfied before release.

## Flatpak

The Flatpak manifest builds only the Constellation binary; GTK, WebKitGTK, and the rest of the
desktop stack are provided by the `org.gnome.Platform` runtime, whose notices are maintained by the
Flathub runtime. The manifest does not bundle additional libraries.

The dependency and artifact inventories are triage aids, not a legal opinion. Final publication
review of embedded binaries and bundled license texts remains a human gate.
