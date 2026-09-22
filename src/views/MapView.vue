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
        <span class="connection-state__dot" :class="{ 'connection-state__dot--online': runtimeState.peerStatus === 'online' }" aria-hidden="true" />
        {{ connectionLabel }}
      </div>
    </header>

    <section v-if="invitationPending" class="accept-card" aria-label="Location invitation">
      <p class="eyebrow">Private location</p>
      <strong>Someone shared their location with you</strong>
      <p>The sender will see you as an active viewer. Nothing is accepted until you continue.</p>
      <button class="primary-action" type="button" :disabled="accepting" @click="acceptInvitation">
        {{ accepting ? "Connecting…" : "View location" }}
      </button>
    </section>

    <section v-else class="status-card" aria-label="Sharing status">
      <div>
        <p class="eyebrow">Your location</p>
        <strong>{{ sharingLabel }}</strong>
      </div>
      <div class="status-card__details">
        <span v-if="activePrecision">{{ activePrecision }}</span>
        <span v-if="viewerCount > 0">{{ viewerCount }} connected</span>
        <span class="status-card__privacy">Private</span>
        <button v-if="runtimeState.shares.length > 0" class="status-card__stop" type="button" @click="stopAllShares">Stop</button>
      </div>
    </section>

    <button v-if="!invitationPending" class="share-button" type="button" @click="shareSheetOpen = true">
      <span aria-hidden="true">⌁</span>
      Share location
    </button>

    <ShareSheet
      v-if="shareSheetOpen"
      :draft="shareDraft"
      :can-submit="canCreateShare(shareDraft) && !creatingShare"
      @close="shareSheetOpen = false"
      @submit="createShare"
      @precision="updatePrecision"
      @duration="updateDuration"
      @viewers="updateViewerCapacity"
      @acknowledge="updateAcknowledgement"
    />

    <ShareReadySheet
      v-if="readyShare"
      :url="readyShare.url"
      @close="readyShare = undefined"
      @stop="stopReadyShare"
    />

    <p v-if="statusMessage" class="toast" role="status">{{ statusMessage }}</p>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";

import LocationMap from "../components/LocationMap.vue";
import ShareReadySheet from "../components/ShareReadySheet.vue";
import ShareSheet from "../components/ShareSheet.vue";
import { createBrowserLocationSource } from "../location/browser.ts";
import { locationObservationToMapLocation } from "../location/mapModel.ts";
import { createPlatformGeolocation } from "../location/platform.ts";
import { subscribeTauriDeepLinks } from "../platform/deepLinks.ts";
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
import { bytesToBase64Url } from "../sharing/encoding.ts";
import { resolveShareBaseUrl } from "../sharing/shareBaseUrl.ts";
import { parseShareInvitation } from "../sharing/shareLink.ts";
import {
  createSharingRuntime,
  type ShareSummary,
  type SharingRuntimeState,
} from "../sharing/sharingRuntime.ts";

const locationSource = createBrowserLocationSource({
  sourceId: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16))),
  geolocation: createPlatformGeolocation(navigator.geolocation),
});
const shareBaseUrl = resolveShareBaseUrl(
  import.meta.env.VITE_CONSTELLATION_PUBLIC_URL,
  new URL(window.location.href),
);
const runtime = createSharingRuntime(locationSource, shareBaseUrl);
const runtimeState = ref<SharingRuntimeState>({
  peerStatus: "offline",
  location: locationSource.getState(),
  shares: [],
  received: [],
  message: "",
});
const shareSheetOpen = ref(false);
const shareDraft = ref(createShareDraft());
const creatingShare = ref(false);
const accepting = ref(false);
const readyShare = ref<ShareSummary>();
const invitationPending = ref(false);
const invitationUrl = ref<string>();
const localError = ref("");

const offerInvitation = (url: string): void => {
  try {
    parseShareInvitation(url);
    invitationUrl.value = url;
    invitationPending.value = true;
  } catch {
    // Unrelated navigation and malformed external links are ignored.
  }
};
offerInvitation(window.location.href);
let stopDeepLinks = (): void => undefined;
let unmounted = false;
void subscribeTauriDeepLinks(shareBaseUrl, offerInvitation)
  .then((stop) => {
    if (unmounted) stop();
    else stopDeepLinks = stop;
  })
  .catch(() => {
    localError.value = "Could not listen for shared links.";
  });

const unsubscribe = runtime.subscribe((next) => {
  runtimeState.value = next;
});

const locations = computed(() => {
  const own = runtimeState.value.location;
  const ownLocations =
    own.status === "live" || own.status === "delayed" || own.status === "stale"
      ? [locationObservationToMapLocation(own.observation, own.status)]
      : [];
  return [
    ...ownLocations,
    ...runtimeState.value.received.map(({ observation, state }) =>
      locationObservationToMapLocation(observation, state),
    ),
  ];
});

const viewerCount = computed(() =>
  runtimeState.value.shares.reduce((sum, share) => sum + share.viewerCount, 0),
);
const activePrecision = computed(() => {
  const choices = new Set(runtimeState.value.shares.map((share) => share.precision));
  if (choices.size === 0) return "";
  if (choices.size > 1) return "Mixed precision";
  return choices.has("approximate") ? "Approximate" : "Exact";
});
const sharingLabel = computed(() => {
  if (runtimeState.value.shares.length > 0) {
    if (runtimeState.value.location.status === "acquiring") return "Acquiring location…";
    if (runtimeState.value.location.status === "denied") return "Location permission denied";
    if (runtimeState.value.location.status === "error") return "Location unavailable";
    return `${runtimeState.value.shares.length} active ${runtimeState.value.shares.length === 1 ? "share" : "shares"}`;
  }
  if (runtimeState.value.received.length > 0) return "Viewing a shared location";
  if (runtimeState.value.location.status === "denied") return "Location permission denied";
  return "Not sharing";
});
const connectionLabel = computed(() => ({
  offline: "Offline",
  connecting: "Connecting",
  online: "P2P online",
  error: "Connection error",
})[runtimeState.value.peerStatus]);
const statusMessage = computed(() => localError.value || runtimeState.value.message);

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

const createShare = async (): Promise<void> => {
  creatingShare.value = true;
  localError.value = "";
  try {
    readyShare.value = await runtime.createShare(shareDraft.value);
    shareSheetOpen.value = false;
    shareDraft.value = createShareDraft();
  } catch (error) {
    localError.value = error instanceof Error ? error.message : "Could not create the share.";
  } finally {
    creatingShare.value = false;
  }
};

const acceptInvitation = async (): Promise<void> => {
  accepting.value = true;
  localError.value = "";
  try {
    if (!invitationUrl.value) throw new Error("The share link is unavailable.");
    await runtime.acceptShare(invitationUrl.value);
    invitationPending.value = false;
    invitationUrl.value = undefined;
    window.history.replaceState({}, "", window.location.pathname);
  } catch (error) {
    localError.value = error instanceof Error ? error.message : "Could not open the share.";
  } finally {
    accepting.value = false;
  }
};

const stopReadyShare = async (): Promise<void> => {
  if (!readyShare.value) return;
  await runtime.stopShare(readyShare.value.shareId);
  readyShare.value = undefined;
};

const stopAllShares = async (): Promise<void> => {
  await Promise.all(
    runtimeState.value.shares.map((share) => runtime.stopShare(share.shareId)),
  );
  readyShare.value = undefined;
};

onBeforeUnmount(() => {
  unmounted = true;
  stopDeepLinks();
  unsubscribe();
  void runtime.stop();
});
</script>
