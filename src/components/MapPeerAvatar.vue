<template>
  <span
    class="map-peer-avatar"
    :title="presentation.ageLabel"
    :data-last-known="
      presentation.clockBadge ? 'historical' : presentation.ageLabel ? 'fading' : undefined
    "
  >
    <span class="map-peer-avatar__portrait" :style="{ opacity: presentation.opacity }">
      <OwnPositionMarker v-if="location.isOwn" />
      <PeerAvatar v-else :name="location.label || 'Shared location'" :color="location.color" />
    </span>
    <Clock v-if="presentation.clockBadge" class="map-peer-avatar__clock" aria-hidden="true" />
  </span>
</template>

<script setup lang="ts">
import { LucideClock3 as Clock } from '@lucide/vue'
import { computed } from 'vue'
import type { MapLocation } from '../location/mapModel.ts'
import { markerAgePresentation } from '../location/lastKnownMarker.ts'
import OwnPositionMarker from './OwnPositionMarker.vue'
import PeerAvatar from './PeerAvatar.vue'

const props = defineProps<{ location: MapLocation; now: number }>()
const presentation = computed(() => markerAgePresentation(props.location, props.now))
</script>

<style scoped>
.map-peer-avatar {
  position: relative;
  display: inline-grid;
  place-items: center;
  width: 100%;
  height: 100%;
}
.map-peer-avatar__portrait {
  display: inline-grid;
  place-items: center;
}
.map-peer-avatar__clock {
  position: absolute;
  right: -0.24rem;
  bottom: -0.12rem;
  box-sizing: content-box;
  width: 0.82rem;
  height: 0.82rem;
  padding: 0.12rem;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--surface);
  color: var(--text);
}
</style>
