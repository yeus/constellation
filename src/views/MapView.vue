<template>
  <main class="map-screen">
    <div class="map-surface" aria-label="Location map">
      <LocationMap :locations="locations" />
    </div>

    <header class="top-bar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">✦</span>
        <span>Constellation</span>
      </div>
      <div class="connection-state">
        <span class="connection-state__dot" aria-hidden="true"></span>
        Offline
      </div>
    </header>

    <section class="status-card" aria-label="Sharing status">
      <div>
        <p class="eyebrow">Your location</p>
        <strong>Not sharing</strong>
      </div>
      <span class="status-card__privacy">Private</span>
    </section>

    <button class="share-button" type="button" @click="shareSheetOpen = true">
      <span aria-hidden="true">⌁</span>
      Share location
    </button>

    <ShareSheet
      v-if="shareSheetOpen"
      :draft="shareDraft"
      :can-submit="canCreateShare(shareDraft)"
      @close="shareSheetOpen = false"
      @submit="showRuntimeNotice"
      @precision="updatePrecision"
      @duration="updateDuration"
      @viewers="updateViewerCapacity"
      @acknowledge="updateAcknowledgement"
    />

    <p v-if="runtimeNotice" class="toast" role="status">
      {{ runtimeNotice }}
    </p>
  </main>
</template>

<script setup lang="ts">
import { ref } from "vue";

import LocationMap from "../components/LocationMap.vue";
import ShareSheet from "../components/ShareSheet.vue";
import type { MapLocation } from "../location/mapModel.ts";
import {
  acknowledgeUntilRevoked,
  canCreateShare,
  createShareDraft,
  setDuration,
  setPrecision,
  setViewerCapacity,
  type LocationPrecision,
  type ShareDuration,
  type ViewerCapacity,
} from "../shareDraft.ts";

const shareSheetOpen = ref(false);
const shareDraft = ref(createShareDraft());
const runtimeNotice = ref("");
const locations = ref<readonly MapLocation[]>([]);

const updatePrecision = (precision: LocationPrecision) => {
  shareDraft.value = setPrecision(shareDraft.value, precision);
};

const updateDuration = (duration: ShareDuration) => {
  shareDraft.value = setDuration(shareDraft.value, duration);
};

const updateViewerCapacity = (viewerCapacity: ViewerCapacity) => {
  shareDraft.value = setViewerCapacity(shareDraft.value, viewerCapacity);
};

const updateAcknowledgement = (acknowledged: boolean) => {
  shareDraft.value = acknowledgeUntilRevoked(shareDraft.value, acknowledged);
};

const showRuntimeNotice = () => {
  runtimeNotice.value = "The P2P sharing runtime is not connected yet.";
  shareSheetOpen.value = false;
};
</script>
