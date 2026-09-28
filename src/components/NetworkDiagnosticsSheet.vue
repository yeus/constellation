<template>
  <div class="sheet-backdrop" @click.self="emit('close')">
    <section class="share-sheet" role="dialog" aria-modal="true" aria-labelledby="network-title">
      <header class="sheet-header">
        <div>
          <p class="eyebrow">Private P2P network</p>
          <h2 id="network-title">P2P diagnostics</h2>
        </div>
        <button class="icon-button" type="button" aria-label="Close" @click="emit('close')">
          <CloseIcon />
        </button>
      </header>
      <p class="field-help">
        Connection roles and transports are shown without peer IDs, network addresses, or share
        links.
      </p>
      <button class="secondary-action" type="button" @click="revealed = !revealed">
        {{ revealed ? 'Hide peer IDs and addresses' : 'Reveal peer IDs and addresses' }}
      </button>
      <p v-if="revealed" class="field-help">
        Sensitive network metadata is visible on this screen. Do not share screenshots without
        reviewing it.
      </p>
      <h3>App peer · {{ foreground.peerStatus }}</h3>
      <p class="field-help">
        Local location: {{ location.status
        }}<span v-if="'observation' in location">
          · last fix {{ elapsed(location.observation.capturedAt) }} ago</span
        >
      </p>
      <p v-if="foreground.connections.length === 0" class="field-help">
        No active app-peer connections.
      </p>
      <ul v-else>
        <li v-for="(connection, index) in foreground.connections" :key="index">
          {{ connection.role }} · {{ connection.transport }} · {{ connection.direction }} ·
          {{ connection.status }}
          <span v-if="connection.connectedAt">
            · connected {{ elapsed(connection.connectedAt) }} ago</span
          >
          <span v-if="revealed" class="sensitive"
            >Peer ID: {{ connection.peerId }} · Address: {{ connection.remoteAddress }}</span
          >
        </li>
      </ul>
      <p v-if="foreground.sessionEvents?.length" class="field-help">
        Recent sessions:
        {{
          foreground.sessionEvents
            .slice(-5)
            .map((event) => `${event.event} (${event.activeSessions} active)`)
            .join(' · ')
        }}
      </p>
      <template v-if="background">
        <h3>Android background peer · {{ background.peerStatus || background.state }}</h3>
        <p class="field-help">
          {{ backgroundViewerCount }} connected sessions across {{ background.shares.length }} links
          · location
          {{ background.location.status }}
          <span v-if="'observation' in background.location">
            · last fix {{ elapsed(background.location.observation.capturedAt) }} ago</span
          >
        </p>
        <p v-if="!background.diagnostics" class="field-help">
          Detailed native connections are unavailable in this build.
        </p>
        <p v-else-if="background.diagnostics.connections.length === 0" class="field-help">
          No active background-peer connections.
        </p>
        <ul v-else>
          <li v-for="(connection, index) in background.diagnostics.connections" :key="index">
            {{ connection.role }} · {{ connection.transport }} · {{ connection.direction }} ·
            {{ connection.status }}
            <span v-if="connection.connectedAt">
              · connected {{ elapsed(connection.connectedAt) }} ago</span
            >
            <span v-if="revealed" class="sensitive"
              >Peer ID: {{ connection.peerId }} · Address: {{ connection.remoteAddress }}</span
            >
          </li>
        </ul>
        <p v-if="background.diagnostics?.sessionEvents?.length" class="field-help">
          Recent background sessions:
          {{
            background.diagnostics.sessionEvents
              .slice(-5)
              .map((event) => `${event.event} (${event.activeSessions} active)`)
              .join(' · ')
          }}
        </p>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AndroidBackgroundStatus } from '../android/backgroundSharing.ts'
import type { BrowserLocationState } from '../location/browser.ts'
import type { NetworkDiagnostics } from '../sharing/sharingRuntime.ts'
import CloseIcon from './icons/CloseIcon.vue'

const props = defineProps<{
  foreground: NetworkDiagnostics
  location: BrowserLocationState
  background?: AndroidBackgroundStatus
}>()
const backgroundViewerCount = computed(
  () => props.background?.shares.reduce((count, share) => count + share.viewerCount, 0) ?? 0,
)
const emit = defineEmits<{ close: [] }>()
const revealed = ref(false)

const elapsed = (timestamp: number): string => {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000))
  if (seconds < 60) return `${seconds} s`
  return seconds < 3_600 ? `${Math.floor(seconds / 60)} min` : `${Math.floor(seconds / 3_600)} h`
}
</script>

<style scoped>
h3 {
  margin: 1rem 0 0.4rem;
  font-size: 0.9rem;
}

ul {
  margin: 0.4rem 0;
  padding-left: 1.2rem;
  color: var(--muted);
  font-size: 0.78rem;
}

li {
  margin: 0.3rem 0;
}

.sensitive {
  display: block;
  overflow-wrap: anywhere;
}
</style>
