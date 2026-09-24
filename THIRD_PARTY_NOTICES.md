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
PMTiles, libp2p, Vue, Tauri, and their transitive dependencies retain their own licenses. The
release dependency inventory for each binary artifact must be completed before publication.
The Linux Secret Service client crate `secret-service` is licensed MIT OR Apache-2.0 and retains
its upstream notices.
