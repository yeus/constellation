<template>
  <div class="sheet-backdrop" @click.self="emit('close')">
    <section
      class="share-sheet about-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="about-title"
    >
      <header class="sheet-header">
        <div>
          <p class="eyebrow">About</p>
          <h2 id="about-title">Constellation</h2>
        </div>
        <button class="icon-button" type="button" aria-label="Close" @click="emit('close')">
          <CloseIcon />
        </button>
      </header>
      <p>
        Constellation is designed for decentralized peer-to-peer location sharing. The app is
        licensed under MIT.
      </p>
      <h3>Privacy and network</h3>
      <p>
        Live location updates stay on your device and the devices of viewers you authorize. They
        travel over end-to-end encrypted peer connections; Constellation does not upload or keep a
        central location history. A viewer can still save or disclose what they receive.
      </p>
      <p>
        Opening a valid location link in a browser starts a temporary encrypted viewing session
        immediately; the source can see that a connection is active. Keep following saves the link
        only on your device. Native apps ask before opening a received link.
      </p>
      <p>
        The current browser version needs a configured relay for reachability and may be unable to
        share if it is unavailable. If a direct connection cannot be made, a libp2p circuit relay
        may also forward encrypted traffic. These relays cannot read location content, but can see
        connection metadata such as peer IDs, IP addresses, timing, and traffic volume. A map host
        can also see map requests and the requesting IP address; requests may reveal the area you
        view, especially after centering on your position.
      </p>
      <p>
        On your device, private share settings and followed links may be stored encrypted for
        recovery; live location history is not kept by the app. In the browser, the site serving the
        app controls which code runs. End-to-end encryption does not protect against compromised
        devices, untrusted app code, or recipients who copy their view.
      </p>
      <p>
        Approximate sharing uses a neighborhood-sized area; Very coarse uses a city-sized area. Both
        reduce precision, but that does not make you anonymous. Long trajectories, known places,
        screenshots, copied observations, or colluding recipients can still reveal sensitive
        patterns.
      </p>
      <p>
        Revocation stops future authorized access, but it cannot erase coordinates a recipient has
        already viewed, copied, photographed, or otherwise retained.
      </p>
      <p>
        Connectivity is best-effort. Constellation cannot keep a live connection through total
        network loss, a captive portal that blocks access, or a network that blocks every available
        outbound transport.
      </p>
      <p>
        Learn more about
        <a href="https://libp2p.io/docs/circuit-relay/" target="_blank" rel="noopener noreferrer"
          >libp2p circuit relays</a
        >.
      </p>
      <h3>Map data and design</h3>
      <p>
        Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>
        under the Open Database License. Basemap design and code by
        <a href="https://github.com/protomaps/basemaps">Protomaps</a>. Landcover includes
        <a href="https://esa-worldcover.org/en">ESA WorldCover</a> data under CC BY 4.0, distributed
        through <a href="https://docs.overturemaps.org/attribution/">Overture Maps</a>.
      </p>
      <h3>Bundled assets</h3>
      <p>
        Map labels use fonts available on your device and may look different across devices. Basemap
        sprites include MIT-licensed Mapzen/Tangram icons. Third-party software retains its own
        licenses.
      </p>
      <p>
        <a href="https://github.com/protomaps/basemaps/blob/main/LICENSE.md">Protomaps license</a>
        ·
        <a href="https://github.com/tangrams/icons/blob/master/LICENSE.md">Tangram icon license</a>
      </p>
      <details>
        <summary>Full bundled map notices</summary>
        <pre>{{ notices }}</pre>
      </details>
      <details>
        <summary>Constellation MIT license</summary>
        <pre>{{ appLicense }}</pre>
      </details>
      <details>
        <summary>Vendored Taskyon MIT license</summary>
        <pre>{{ taskyonLicense }}</pre>
      </details>
    </section>
  </div>
</template>

<script setup lang="ts">
import CloseIcon from './icons/CloseIcon.vue'
import notices from '../../THIRD_PARTY_NOTICES.md?raw'
import appLicense from '../../LICENSE?raw'
import taskyonLicense from '../../vendor/taskyon/LICENSE?raw'

const emit = defineEmits<{ close: [] }>()
</script>

<style scoped>
.about-sheet {
  line-height: 1.5;
}

.about-sheet h3 {
  margin: 1.2rem 0 0.3rem;
  font-size: 0.94rem;
}

.about-sheet p {
  margin: 0.4rem 0 0.7rem;
  color: var(--muted);
  font-size: 0.84rem;
}

.about-sheet a {
  color: var(--accent);
}

.about-sheet pre {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  font-size: 0.72rem;
}
</style>
