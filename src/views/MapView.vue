<template>
  <main
    class="map-screen"
    :class="{ 'map-screen--actions-open': actionsExpanded }"
    @click.capture="closeMenuOnOutsideClick"
  >
    <div class="map-surface" aria-label="Location map">
      <LocationMap
        ref="locationMap"
        :locations="locations"
        :decluttering="mapDecluttering"
        :map-family="mapFamily"
        @select="openFollowDetails"
        @diagnostic="sessionLog.record"
      />
    </div>

    <header class="top-bar">
      <button
        class="brand-button"
        type="button"
        aria-label="Open menu"
        @click="menuOpen = !menuOpen"
      >
        <Menu aria-hidden="true" />
      </button>
      <span class="brand-wordmark">Constellation</span>
      <button
        class="recenter-button"
        type="button"
        aria-label="Center on my location"
        @click="centerOnOwnLocation"
      >
        <LocateFixed aria-hidden="true" />
      </button>
    </header>

    <section v-if="menuOpen" class="app-menu" aria-label="App menu">
      <p class="eyebrow">Map style</p>
      <button
        type="button"
        :aria-pressed="mapFamily === 'default'"
        @click="selectMapFamily('default')"
      >
        Default map
      </button>
      <button
        type="button"
        :aria-pressed="mapFamily === 'minimalist'"
        @click="selectMapFamily('minimalist')"
      >
        Minimalist map
      </button>
      <details class="map-decluttering-settings">
        <summary>Map decluttering</summary>
        <label>
          <input v-model="mapDecluttering.enabled" type="checkbox" />
          Group nearby peers
        </label>
        <label>
          <input
            v-model="mapDecluttering.groupMarkerCollisions"
            type="checkbox"
            :disabled="!mapDecluttering.enabled"
          />
          Group colliding markers
        </label>
        <label>
          <input
            v-model="mapDecluttering.groupUncertaintyOverlap"
            type="checkbox"
            :disabled="!mapDecluttering.enabled"
          />
          Group overlapping areas
        </label>
        <label class="map-decluttering-settings__range">
          <span
            >Area overlap:
            {{ Math.round(mapDecluttering.uncertaintyOverlapThreshold * 100) }}%</span
          >
          <input
            v-model.number="mapDecluttering.uncertaintyOverlapThreshold"
            type="range"
            min="0.5"
            max="1"
            step="0.05"
            :disabled="!mapDecluttering.enabled || !mapDecluttering.groupUncertaintyOverlap"
          />
        </label>
        <label class="map-decluttering-settings__range">
          <span>Marker spacing: {{ mapDecluttering.markerCollisionDistancePx }} px</span>
          <input
            v-model.number="mapDecluttering.markerCollisionDistancePx"
            type="range"
            min="12"
            max="48"
            step="2"
            :disabled="!mapDecluttering.enabled || !mapDecluttering.groupMarkerCollisions"
          />
        </label>
      </details>
      <button type="button" @click="openAbout">Privacy and licenses</button>
      <button type="button" @click="copyLogs">Copy logs</button>
      <button type="button" @click="openBrowserDiagnostics">Diagnostics</button>
      <button type="button" @click="openDiagnostics">P2P diagnostics</button>
      <button type="button" @click="openFollowInput">Follow a link</button>
      <button type="button" @click="openFollowing">Following ({{ activeFollowing.length }})</button>
      <a
        v-if="!isNative"
        href="https://github.com/yeus/constellation/releases/latest"
        target="_blank"
        rel="noopener noreferrer"
      >
        Latest release
      </a>
      <a
        v-if="!isNative"
        href="https://github.com/yeus/constellation"
        target="_blank"
        rel="noopener noreferrer"
      >
        GitHub project
      </a>
    </section>

    <AboutSheet v-if="aboutOpen" @close="aboutOpen = false" />
    <DiagnosticsSheet
      v-if="browserDiagnosticsOpen"
      @close="browserDiagnosticsOpen = false"
      @run="openSharingDiagnostics"
    />
    <SharingDiagnosticsSheet
      v-if="sharingDiagnosticsOpen"
      :native="backgroundSharing"
      :share-base-url="shareBaseUrl"
      @close="returnToBrowserDiagnostics"
    />
    <NetworkDiagnosticsSheet
      v-if="diagnosticsOpen"
      :foreground="networkDiagnostics"
      :location="runtimeState.location"
      :background="backgroundStatus"
      @close="diagnosticsOpen = false"
    />

    <section v-if="introOpen" class="intro-note" role="region" aria-label="Privacy introduction">
      <p class="eyebrow">Private location sharing</p>
      <strong>Direct when possible. Encrypted between peers.</strong>
      <p>
        Constellation uses end-to-end encrypted P2P connections, sometimes through a relay. There is
        no central location history.
      </p>
      <div v-if="showNativeAppHint" class="intro-note__downloads">
        <p>
          On Android or Linux? The native apps add features. The Android app can keep sharing in the
          background.
        </p>
        <a
          href="https://github.com/yeus/constellation/releases/latest"
          target="_blank"
          rel="noopener noreferrer"
        >
          Get Android and Linux apps
        </a>
      </div>
      <div class="intro-note__actions">
        <button type="button" @click="openAbout">How it works</button>
        <button type="button" @click="dismissIntro">Got it</button>
      </div>
    </section>

    <section v-if="invitationPending" class="accept-card" aria-label="Location invitation">
      <p class="eyebrow">Private location</p>
      <strong>Someone shared their location with you</strong>
      <p>The sender will see you as an active viewer. Nothing is accepted until you continue.</p>
      <button class="primary-action" type="button" :disabled="accepting" @click="acceptInvitation">
        {{ accepting ? 'Connecting…' : 'View location' }}
      </button>
    </section>

    <section
      v-if="pendingViewerApproval"
      class="accept-card"
      role="region"
      aria-label="Viewer access request"
    >
      <p class="eyebrow">Single-recipient link</p>
      <strong>A device wants to view your location</strong>
      <p>
        Approve this peer before any location is sent. The link will stay bound to this peer after
        approval.
      </p>
      <span class="field-help">Device fingerprint: {{ pendingViewerApproval.fingerprint }}</span>
      <div class="preview-actions">
        <button
          class="primary-action"
          type="button"
          :disabled="changingViewerApproval"
          @click="approvePendingViewer"
        >
          Approve this device
        </button>
        <button
          class="secondary-action"
          type="button"
          :disabled="changingViewerApproval"
          @click="rejectPendingViewer"
        >
          Reject
        </button>
      </div>
    </section>

    <section v-if="previewFollow" class="accept-card" aria-label="Location preview">
      <p class="eyebrow">Private preview</p>
      <strong>{{ previewFollow.localName }}</strong>
      <p v-if="previewFollow.status === 'approval-pending'">
        No location is shared yet. The sender must approve this device first.
      </p>
      <p v-else-if="previewFollow.status === 'denied'">
        The sender did not approve this device. No location is being received.
      </p>
      <p v-else>This location is visible now. Keep following to save it on this device.</p>
      <div class="preview-actions">
        <button
          v-if="previewFollow.status !== 'denied'"
          class="primary-action"
          type="button"
          :disabled="!runtimeState.canSave"
          @click="keepFollowing(previewFollow.shareId)"
        >
          Keep following
        </button>
        <button
          class="secondary-action"
          type="button"
          @click="stopFollowing(previewFollow.shareId)"
        >
          Stop preview
        </button>
      </div>
      <p v-if="!runtimeState.canSave">
        Protected storage is unavailable on this device; preview only.
      </p>
    </section>

    <section
      v-if="shareBackPrompt"
      class="accept-card"
      role="region"
      aria-label="Share back invitation"
    >
      <p class="eyebrow">Optional return share</p>
      <strong>Share yours back with {{ shareBackPrompt.name }}?</strong>
      <p>
        This creates an approximate location link for one hour and sends it only to the original
        sender over the encrypted connection.
      </p>
      <div class="preview-actions">
        <button
          class="primary-action"
          type="button"
          :disabled="creatingShare"
          @click="openReturnShare"
        >
          Share approximate location for 1 hour
        </button>
        <button class="secondary-action" type="button" @click="dismissShareBackPrompt">
          Not now
        </button>
      </div>
    </section>

    <section
      v-if="pendingReturnOffer"
      class="accept-card"
      role="region"
      aria-label="Return location offered"
    >
      <p class="eyebrow">Private return share</p>
      <strong>A viewer wants to share their location back</strong>
      <p>
        Accept this location and remember your choice for this link. Other viewers using the same
        link will be accepted automatically.
      </p>
      <div class="preview-actions">
        <button
          class="primary-action"
          type="button"
          :disabled="changingReturnOffer"
          @click="acceptReturnOffer"
        >
          Accept viewers from this link
        </button>
        <button
          class="secondary-action"
          type="button"
          :disabled="changingReturnOffer"
          @click="dismissReturnOffer"
        >
          Dismiss
        </button>
      </div>
    </section>

    <footer class="connection-dock" aria-label="Connections">
      <div v-if="actionsExpanded" class="quick-action-row">
        <button type="button" aria-label="Add location" @click="openFollowInput">
          Add location <small>Private link</small>
        </button>
        <button type="button" aria-label="Share location" @click="shareSheetOpen = true">
          Share location <small>Encrypted P2P</small>
        </button>
      </div>
      <div class="dock-status" role="status">
        <span
          class="connection-state__dot"
          :class="{ 'connection-state__dot--online': effectivePeerStatus === 'online' }"
          aria-hidden="true"
        />
        {{ connectionLabel }} <span aria-hidden="true">·</span> {{ ownLocationLabel }}
      </div>
      <div class="dock-buttons">
        <button class="dock-side" type="button" @click="openSharing">
          <Share2 aria-hidden="true" />
          <span>{{ sharingLabel }}</span>
        </button>
        <button
          class="dock-add"
          type="button"
          aria-label="Show sharing actions"
          :aria-expanded="actionsExpanded"
          @click="toggleActions"
        >
          <Plus aria-hidden="true" />
        </button>
        <button class="dock-side" type="button" @click="openFollowing">
          <Eye aria-hidden="true" />
          <span>Seeing {{ activeFollowing.length }}</span>
        </button>
      </div>
    </footer>

    <ShareSheet
      v-if="shareSheetOpen"
      :draft="shareDraft"
      :can-submit="canCreateShare(shareDraft) && !creatingShare"
      :background-available="Boolean(backgroundSharing)"
      :runtime-note="
        shareDraft.publication === 'background'
          ? 'Android keeps this link active in a protected foreground service and requires all-the-time location permission.'
          : isAndroid
            ? 'This link pauses while Constellation is hidden and resumes when you reopen it.'
            : 'Sharing pauses when this app is hidden and stops when it is closed.'
      "
      @close="closeShareSheet"
      @submit="createShare"
      @precision="updatePrecision"
      @duration="updateDuration"
      @viewers="updateViewerCapacity"
      @acknowledge="updateAcknowledgement"
      @name="updateName"
      @publication="updatePublication"
      @battery="updateBatteryPolicy"
      @network="updateNetworkPolicy"
    />

    <div v-if="followInputOpen" class="sheet-backdrop" @click.self="followInputOpen = false">
      <section class="share-sheet" role="dialog" aria-modal="true" aria-labelledby="follow-title">
        <header class="sheet-header">
          <div>
            <p class="eyebrow">Private link</p>
            <h2 id="follow-title">Follow a location</h2>
          </div>
          <button
            class="icon-button"
            type="button"
            aria-label="Close"
            @click="followInputOpen = false"
          >
            <CloseIcon />
          </button>
        </header>
        <input
          v-model="pastedLink"
          class="share-ready__link"
          aria-label="Paste location link"
          placeholder="Paste a location link"
        />
        <button
          v-if="canScanQr"
          class="secondary-action"
          type="button"
          @click="qrScannerOpen = true"
        >
          <QrCode aria-hidden="true" /> Scan QR code
        </button>
        <button class="primary-action" type="button" @click="acceptPastedLink">
          View location
        </button>
      </section>
    </div>
    <QrScannerSheet v-if="qrScannerOpen" @close="qrScannerOpen = false" @scan="acceptScannedLink" />

    <PeerListSheet
      v-if="peerListOpen"
      :shares="activeShares"
      :following="activeFollowing"
      :filter="peerListFilter"
      :old-shares="oldSharing"
      :old-following="runtimeState.oldSeeing"
      :viewable-ids="viewableIds"
      :selected-id="selectedFollowId"
      :share-back-busy="creatingShare"
      :peer-name-preferences="peerNamePreferences"
      @profile="setPeerNamePreferences"
      @close="peerListOpen = false"
      @filter="peerListFilter = $event"
      @show="showExistingShare"
      @revoke="revokeShare"
      @viewer-name="setViewerName"
      @viewer-block="blockViewer"
      @name="runtime.setFollowName"
      @color="runtime.setFollowColor"
      @focus="focusFollowing"
      @focus-all="focusAllFollowing"
      @unfollow="stopFollowing"
      @keep="keepFollowing"
      @share-back="shareBackFromFollowing"
    />

    <div v-if="nicknamePrompt" class="sheet-backdrop" @click.self="nicknamePrompt = undefined">
      <section class="share-sheet" role="dialog" aria-modal="true" aria-label="Keep following">
        <header class="sheet-header"><h2>Keep following</h2></header>
        <p class="field-help">Choose a nickname for this location. Only you see this name.</p>
        <input
          v-model="nicknamePrompt.name"
          aria-label="Nickname"
          maxlength="32"
          class="share-ready__link"
        />
        <button class="primary-action" type="button" @click="saveNickname">Save location</button>
      </section>
    </div>

    <ShareReadySheet
      v-if="readyShare"
      :url="readyShare.url"
      :show-qr="!readyShareIsReturn"
      :return-share="readyShareIsReturn"
      @close="closeShareReady"
    />

    <p v-if="statusNoticeVisible && statusMessage" class="toast" role="status">
      {{ statusMessage }}
    </p>
  </main>
</template>

<script setup lang="ts">
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys'
import {
  LucideEye as Eye,
  LucideLocateFixed as LocateFixed,
  LucideMenu as Menu,
  LucidePlus as Plus,
  LucideQrCode as QrCode,
  LucideShare2 as Share2,
} from '@lucide/vue'
import { invoke } from '@tauri-apps/api/core'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import {
  createAndroidBackgroundSharing,
  type AndroidBackgroundStatus,
} from '../android/backgroundSharing.ts'
import LocationMap from '../components/LocationMap.vue'
import QrScannerSheet from '../components/QrScannerSheet.vue'
import NetworkDiagnosticsSheet from '../components/NetworkDiagnosticsSheet.vue'
import DiagnosticsSheet from '../components/DiagnosticsSheet.vue'
import SharingDiagnosticsSheet from '../components/SharingDiagnosticsSheet.vue'
import CloseIcon from '../components/icons/CloseIcon.vue'
import AboutSheet from '../components/AboutSheet.vue'
import PeerListSheet from '../components/PeerListSheet.vue'
import ShareReadySheet from '../components/ShareReadySheet.vue'
import ShareSheet from '../components/ShareSheet.vue'
import { createSessionLog } from '../diagnostics/sessionLog.ts'
import { receiveApprovedBackgroundReturns } from '../android/backgroundReturnShares.ts'
import { createBrowserLocationSource } from '../location/browser.ts'
import { locationObservationToMapLocation } from '../location/mapModel.ts'
import {
  loadMapDeclutteringPreferences,
  saveMapDeclutteringPreferences,
} from '../location/mapPreferences.ts'
import type { MapDeclutteringPreferences } from '../location/mapPresentation.ts'
import type { MapFamily } from '../map/pmtiles.ts'
import { createPlatformGeolocation } from '../location/platform.ts'
import {
  createTauriAndroidLocationApi,
  ensureAndroidLocationPermission,
} from '../location/android.ts'
import { subscribeTauriDeepLinks } from '../platform/deepLinks.ts'
import { invitationFromSharedText } from '../platform/sharedText.ts'
import {
  acknowledgeUntilRevoked,
  canCreateShare,
  createShareDraft,
  setBatteryPolicy,
  setDuration,
  setName,
  setNetworkPolicy,
  setPrecision,
  setPublication,
  setViewerCapacity,
  type LocationPrecision,
  type ShareBatteryPolicy,
  type ShareDuration,
  type ShareNetworkPolicy,
  type SharePublication,
  type ViewerCapacity,
} from '../shareDraft.ts'
import { bytesToBase64Url } from '../sharing/encoding.ts'
import { resolveShareBaseUrl } from '../sharing/shareBaseUrl.ts'
import { parseShareInvitation } from '../sharing/shareLink.ts'
import { createBrowserPrivateStore, createNativePrivateStore } from '../sharing/privateStore.ts'
import {
  acceptReturnShare,
  createSharingRuntime,
  type ShareSummary,
  type SharingRuntimeState,
  type NetworkDiagnostics,
} from '../sharing/sharingRuntime.ts'

const transportSummary = (diagnostics: NetworkDiagnostics): string => {
  const transports = diagnostics.connections.map((connection) => connection.transport).sort()
  return `${diagnostics.connections.length} connections${transports.length ? `: ${transports.join(', ')}` : ''}`
}

const recordSessionEvents = (
  previous: NetworkDiagnostics | undefined,
  next: NetworkDiagnostics,
): void => {
  const lastSequence = previous?.sessionEvents?.at(-1)?.sequence ?? 0
  for (const event of next.sessionEvents ?? []) {
    if (event.sequence <= lastSequence) continue
    sessionLog.record({
      level:
        event.event === 'heartbeat-timeout' || event.event === 'heartbeat-failed'
          ? 'warning'
          : 'info',
      event: 'sharing.session.lifecycle',
      message: `${event.event}; ${event.activeSessions} active sessions`,
    })
  }
}

const sessionLog = createSessionLog(
  Date.now,
  import.meta.env.DEV
    ? (entry) => {
        const method =
          entry.level === 'warning' ? 'warn' : entry.level === 'error' ? 'error' : 'info'
        console[method]('[constellation]', entry)
      }
    : undefined,
)
sessionLog.record({ level: 'info', event: 'app.started' })

const isNative = '__TAURI_INTERNALS__' in window
const showNativeAppHint = !isNative && /Android|Linux/i.test(navigator.userAgent)
const isAndroid = isNative && /Android/i.test(navigator.userAgent)
const androidLocationApi = isAndroid ? createTauriAndroidLocationApi() : undefined
const locationSource = createBrowserLocationSource({
  sourceId: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16))),
  geolocation: createPlatformGeolocation({
    browserGeolocation: navigator.geolocation,
    androidApi: androidLocationApi,
    onFallback: (reason) =>
      sessionLog.record({
        level: 'warning',
        event: 'location.provider.fallback',
        message: `Native Android location ${reason}; trying WebView location.`,
      }),
  }),
})
const shareBaseUrl = resolveShareBaseUrl(
  import.meta.env.VITE_CONSTELLATION_PUBLIC_URL,
  new URL(window.location.href),
)
const privateStore = isNative
  ? createNativePrivateStore(isAndroid ? 'android' : 'desktop')
  : createBrowserPrivateStore()
const runtime = createSharingRuntime(locationSource, shareBaseUrl, privateStore)
const backgroundSharing = createAndroidBackgroundSharing({
  isAndroid,
  now: Date.now,
  invoke,
  preparePermissions: async () => {
    if (androidLocationApi) await ensureAndroidLocationPermission(androidLocationApi)
  },
})
const migrateAndroidSourceShares = async (): Promise<void> => {
  if (!isAndroid || !backgroundSharing) return
  const saved = await privateStore.load()
  if (!saved?.shares.length) return
  await backgroundSharing.importSourceState({
    ...saved,
    followed: [],
    viewerLabels: saved.viewerLabels ?? [],
  })
  const viewerKey = await generateKeyPair('Ed25519')
  await privateStore.save({
    ...saved,
    privateKey: bytesToBase64Url(privateKeyToProtobuf(viewerKey)),
    shares: [],
    viewerLabels: [],
  })
}
const backgroundStatus = ref<AndroidBackgroundStatus>()
const dismissedBackgroundOffers = ref(new Map<string, string>())
const runtimeState = ref<SharingRuntimeState>({
  peerStatus: 'offline',
  location: locationSource.getState(),
  shares: [],
  received: [],
  following: [],
  returnOffers: [],
  approvedReturnLinks: [],
  pendingViewerApprovals: [],
  oldSharing: [],
  oldSeeing: [],
  endNotifications: [],
  message: '',
  canSave: true,
})
const pendingReturnOffer = computed(() => {
  const foreground = runtimeState.value.returnOffers[0]
  if (foreground) return foreground
  return backgroundStatus.value?.returnOffers?.find(
    ({ shareId, viewerFingerprint, url }) =>
      !backgroundStatus.value?.approvedReturnLinks?.includes(shareId) &&
      dismissedBackgroundOffers.value.get(`${shareId}:${viewerFingerprint}`) !== url,
  )
})
const networkDiagnostics = ref(runtime.networkDiagnostics())
const shareSheetOpen = ref(false)
const mapFamily = ref<MapFamily>(
  window.localStorage.getItem('constellation.map-family') === 'minimalist'
    ? 'minimalist'
    : 'default',
)
const mapDecluttering = ref<MapDeclutteringPreferences>(
  loadMapDeclutteringPreferences(window.localStorage),
)
watch(
  mapDecluttering,
  (preferences) => saveMapDeclutteringPreferences(window.localStorage, preferences),
  { deep: true },
)
const introSeenKey = 'constellation.privacy-intro-seen'
const actionsExpanded = ref(window.localStorage.getItem('constellation.actions-expanded') !== '0')
const introOpen = ref(window.localStorage.getItem(introSeenKey) !== '1')
const menuOpen = ref(false)
const closeMenuOnOutsideClick = (event: MouseEvent): void => {
  if (event.target instanceof Element && event.target.closest('.brand-button, .app-menu')) return
  menuOpen.value = false
}
const aboutOpen = ref(false)
const browserDiagnosticsOpen = ref(false)
const sharingDiagnosticsOpen = ref(false)
const openSharingDiagnostics = () => {
  browserDiagnosticsOpen.value = false
  sharingDiagnosticsOpen.value = true
}
const returnToBrowserDiagnostics = () => {
  sharingDiagnosticsOpen.value = false
  browserDiagnosticsOpen.value = true
}
const diagnosticsOpen = ref(false)
const peerListOpen = ref(false)
const peerListFilter = ref<'all' | 'sharing' | 'viewing' | 'both'>('all')
const followInputOpen = ref(false)
const qrScannerOpen = ref(false)
const canScanQr = Boolean(window.isSecureContext && navigator.mediaDevices)
const selectedFollowId = ref<string>()
const pastedLink = ref('')
const locationMap = ref<InstanceType<typeof LocationMap>>()
const shareDraft = ref(createShareDraft())
const creatingShare = ref(false)
const accepting = ref(false)
const readyShare = ref<ShareSummary>()
const readyShareIsReturn = ref(false)
const invitationPending = ref(false)
const invitationUrl = ref<string>()
const browserLocationDeferred = ref(!isNative && window.location.hash.startsWith('#share='))
const nicknamePrompt = ref<{ shareId: string; name: string }>()
const shareBackPrompt = ref<{ shareId: string; name: string }>()
const returnTarget = ref<string>()
const localError = ref('')
const copyNotice = ref('')
let copyNoticeTimeout: number | undefined
let statusNoticeTimeout: number | undefined
const statusNoticeVisible = ref(true)
let markingReturnPrompt = false
const offerConnectedReturnShare = (state: SharingRuntimeState): void => {
  if (
    markingReturnPrompt ||
    shareBackPrompt.value ||
    nicknamePrompt.value ||
    readyShare.value ||
    shareSheetOpen.value ||
    creatingShare.value
  ) {
    return
  }
  const follow = state.following.find(
    (entry) => entry.saved && entry.connected && !entry.returnPromptSeen,
  )
  if (!follow) return
  markingReturnPrompt = true
  void runtime
    .markReturnPromptSeen(follow.shareId)
    .then(() => {
      const current = runtimeState.value.following.find((entry) => entry.shareId === follow.shareId)
      if (current?.returnPromptSeen) {
        shareBackPrompt.value = {
          shareId: current.shareId,
          name: current.localName || current.sourceName || 'this person',
        }
      }
    })
    .catch((error) => {
      localError.value = error instanceof Error ? error.message : 'Could not save this choice.'
    })
    .finally(() => {
      markingReturnPrompt = false
    })
}

const offerInvitation = (url: string): void => {
  try {
    parseShareInvitation(url)
    introOpen.value = false
    invitationUrl.value = url
    if (isNative) invitationPending.value = true
    else void previewInvitation(url)
  } catch {
    if (url.split('#')[1]?.startsWith('share=')) {
      localError.value = 'This location link is invalid or expired.'
      if (url === window.location.href) {
        window.history.replaceState({}, '', window.location.pathname + window.location.search)
      }
    }
  }
}
let stopDeepLinks = (): void => undefined
let unmounted = false
void subscribeTauriDeepLinks(shareBaseUrl, offerInvitation)
  .then((stop) => {
    if (unmounted) stop()
    else stopDeepLinks = stop
  })
  .catch(() => {
    localError.value = 'Could not listen for shared links.'
  })

const unsubscribe = runtime.subscribe((next) => {
  if (runtimeState.value.peerStatus !== next.peerStatus) {
    sessionLog.record({ level: 'info', event: 'sharing.peer.status', state: next.peerStatus })
  }
  for (const follow of next.following) {
    const previous = runtimeState.value.following.find((entry) => entry.shareId === follow.shareId)
    if (previous?.connected === follow.connected) continue
    sessionLog.record({
      level: follow.connected ? 'info' : 'warning',
      event: 'sharing.follow.status',
      state: follow.connected ? 'connected' : 'disconnected',
    })
  }
  runtimeState.value = next
  offerConnectedReturnShare(next)
  const latestNetwork = runtime.networkDiagnostics()
  recordSessionEvents(networkDiagnostics.value, latestNetwork)
  if (transportSummary(networkDiagnostics.value) !== transportSummary(latestNetwork)) {
    sessionLog.record({
      level: 'info',
      event: 'sharing.network.connections',
      message: transportSummary(latestNetwork),
    })
  }
  networkDiagnostics.value = latestNetwork
})
let backgroundPoll: number | undefined
let sharedTextPoll: number | undefined
let checkingSharedText = false
const receiveSharedText = async (): Promise<void> => {
  if (!isAndroid || checkingSharedText) return
  checkingSharedText = true
  try {
    const { text } = await invoke<{ text: string }>('android_take_shared_text')
    if (!text) return
    const invitation = invitationFromSharedText(text)
    if (invitation) offerInvitation(invitation)
    else localError.value = 'Shared text did not contain a valid location link.'
  } finally {
    checkingSharedText = false
  }
}
let receivingApprovedReturns = false
const refreshBackgroundStatus = async (): Promise<void> => {
  if (!backgroundSharing) return
  const next = await backgroundSharing.status()
  if (backgroundStatus.value?.state !== next.state) {
    sessionLog.record({ level: 'info', event: 'sharing.background.status', state: next.state })
  }
  if (next.peerStatus && backgroundStatus.value?.peerStatus !== next.peerStatus) {
    sessionLog.record({ level: 'info', event: 'sharing.background.peer', state: next.peerStatus })
  }
  const previousViewers =
    backgroundStatus.value?.shares.reduce((count, share) => count + share.viewerCount, 0) ?? 0
  const nextViewers = next.shares.reduce((count, share) => count + share.viewerCount, 0)
  if (previousViewers !== nextViewers) {
    sessionLog.record({
      level: 'info',
      event: 'sharing.background.viewers',
      message: `${nextViewers} connected sessions across ${next.shares.length} links`,
    })
  }
  if (backgroundStatus.value?.location.status !== next.location.status) {
    sessionLog.record({
      level: 'info',
      event: 'sharing.background.location',
      message: next.location.status,
    })
  }
  if (
    next.diagnostics &&
    (!backgroundStatus.value?.diagnostics ||
      transportSummary(backgroundStatus.value.diagnostics) !== transportSummary(next.diagnostics))
  ) {
    sessionLog.record({
      level: 'info',
      event: 'sharing.background.connections',
      message: transportSummary(next.diagnostics),
    })
  }
  if (next.diagnostics) recordSessionEvents(backgroundStatus.value?.diagnostics, next.diagnostics)
  const previousServiceOwnsLocation = Boolean(backgroundStatus.value?.shares.length)
  backgroundStatus.value = next
  if (previousServiceOwnsLocation !== Boolean(next.shares.length)) updateLocationOwnership()
  if (receivingApprovedReturns || changingReturnOffer.value) return
  receivingApprovedReturns = true
  try {
    const result = await receiveApprovedBackgroundReturns(
      next,
      (offer) =>
        acceptReturnShare(runtime, offer, (shareId) =>
          runtimeState.value.following.some(
            (entry) => entry.shareId === shareId && entry.connected,
          ),
        ),
      (offer) => backgroundSharing.dismissReturnOffer(offer.shareId, offer.viewerFingerprint),
    )
    if (result.failed)
      localError.value = 'Some approved return locations could not be received yet.'
  } finally {
    receivingApprovedReturns = false
  }
}

const activeShares = computed(() =>
  [...runtimeState.value.shares, ...(backgroundStatus.value?.shares ?? [])].map((share) => ({
    ...share,
    viewers: share.viewers?.map((viewer) => ({
      ...viewer,
      localName: runtime.getViewerLabel(share.shareId, viewer.fingerprint) ?? viewer.localName,
    })),
  })),
)
const peerNamePreferences = computed(() => [
  ...(backgroundStatus.value?.peerNamePreferences ?? []),
  ...(runtimeState.value.peerNamePreferences ?? []),
])
const setPeerNamePreferences = async (
  peerId: string,
  associateNames: boolean,
  sharedName: string | null,
): Promise<void> => {
  try {
    const foreground =
      runtimeState.value.following.some((entry) => entry.peerId === peerId) ||
      runtimeState.value.shares.some((share) =>
        share.viewers?.some((viewer) => viewer.peerId === peerId),
      )
    if (foreground) await runtime.setPeerNamePreferences(peerId, associateNames, sharedName)
    if (
      backgroundSharing &&
      backgroundStatus.value?.shares.some((share) =>
        share.viewers?.some((viewer) => viewer.peerId === peerId),
      )
    ) {
      backgroundStatus.value = await backgroundSharing.setPeerNamePreferences(
        peerId,
        associateNames,
        sharedName,
      )
    }
  } catch {
    localError.value = 'Name preferences could not be delivered. Please retry.'
  }
}
const oldSharing = computed(() => {
  const records = [...runtimeState.value.oldSharing, ...(backgroundStatus.value?.oldSharing ?? [])]
  return [...new Map(records.map((record) => [record.shareId, record])).values()].sort(
    (left, right) => right.endedAt - left.endedAt,
  )
})
const activeFollowing = computed(() =>
  runtimeState.value.following.filter(
    (entry) => entry.status !== 'expired' && entry.status !== 'revoked',
  ),
)
const sharingLabel = computed(() => {
  const shares = activeShares.value
  if (shares.length === 0) return 'Sharing 0'
  const expiries = shares
    .map(({ expiresAt }) => expiresAt)
    .filter((expiresAt): expiresAt is number => expiresAt !== null)
  if (expiries.length === 0) return `Sharing ${shares.length} · until stopped`
  const nextExpiry = new Date(Math.min(...expiries)).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })
  return `Sharing ${shares.length} · next ends ${nextExpiry}`
})
const previewFollow = computed(() => activeFollowing.value.find((entry) => !entry.saved))
const pendingViewerApproval = computed(
  () =>
    runtimeState.value.pendingViewerApprovals[0] ??
    backgroundStatus.value?.pendingViewerApprovals?.[0],
)

const locations = computed(() => {
  const own = backgroundStatus.value?.shares.length
    ? backgroundStatus.value.location
    : runtimeState.value.location
  const ownLocations =
    own.status === 'live' || own.status === 'delayed' || own.status === 'stale'
      ? [locationObservationToMapLocation(own.observation, own.status)]
      : []
  return [
    ...ownLocations.map((location) => ({ ...location, isOwn: true, color: '#f78f3b' })),
    ...runtimeState.value.received
      .filter((entry) =>
        activeFollowing.value.some(
          (follow) => follow.shareId === entry.shareId && follow.status !== 'denied',
        ),
      )
      .map(({ shareId, observation, state }) => {
        const follow = runtimeState.value.following.find((entry) => entry.shareId === shareId)
        return locationObservationToMapLocation(observation, state, {
          id: shareId,
          label: follow?.localName || follow?.sourceName || 'Shared location',
          color: follow?.color,
        })
      }),
  ]
})
const viewableIds = computed(() =>
  runtimeState.value.received
    .filter((entry) => activeFollowing.value.some((follow) => follow.shareId === entry.shareId))
    .map(({ shareId }) => shareId),
)

const effectivePeerStatus = computed(() => {
  if (backgroundStatus.value?.state === 'sharing') return 'online'
  if (backgroundStatus.value?.state === 'starting') return 'connecting'
  if (backgroundStatus.value?.state === 'error') return 'error'
  return runtimeState.value.peerStatus
})
const connectionLabel = computed(
  () =>
    ({
      offline: 'P2P idle',
      connecting: 'Connecting',
      online: 'P2P online',
      error: 'Connection error',
    })[effectivePeerStatus.value],
)
const ownLocationLabel = computed(() => {
  if (ownObservation.value) return 'Your position ready'
  if (runtimeState.value.location.status === 'denied') return 'Location denied'
  if (runtimeState.value.location.status === 'acquiring') return 'Finding your location'
  return 'Your location off'
})

const collapseActions = (): void => {
  actionsExpanded.value = false
  window.localStorage.setItem('constellation.actions-expanded', '0')
}
const toggleActions = (): void => {
  actionsExpanded.value = !actionsExpanded.value
  window.localStorage.setItem('constellation.actions-expanded', actionsExpanded.value ? '1' : '0')
}
const policyPauseMessage = computed(() => {
  const status = backgroundStatus.value
  if (!status) return ''
  const paused = status.shares.filter((share) => share.paused).length
  if (paused === 0) return ''
  const reasonText =
    status.pauseReason === 'metered'
      ? 'a metered network'
      : status.pauseReason === 'data-saver'
        ? 'Data Saver'
        : 'network policy'
  if (paused === status.shares.length) {
    return `Updates are paused on ${reasonText} and resume automatically.`
  }
  return `${paused} of ${status.shares.length} links paused on ${reasonText}; other links keep updating.`
})
const statusMessage = computed(
  () =>
    localError.value ||
    copyNotice.value ||
    policyPauseMessage.value ||
    backgroundStatus.value?.message ||
    runtimeState.value.message,
)
watch(
  statusMessage,
  (message) => {
    statusNoticeVisible.value = Boolean(message)
    if (statusNoticeTimeout !== undefined) window.clearTimeout(statusNoticeTimeout)
    if (!message) return
    statusNoticeTimeout = window.setTimeout(() => {
      statusNoticeVisible.value = false
      statusNoticeTimeout = undefined
    }, 6_000)
  },
  { immediate: true },
)

const copyLogs = async (): Promise<void> => {
  menuOpen.value = false
  localError.value = ''
  copyNotice.value = ''
  if (copyNoticeTimeout !== undefined) window.clearTimeout(copyNoticeTimeout)
  const runtime =
    '__TAURI_INTERNALS__' in window
      ? /Android/i.test(navigator.userAgent)
        ? 'android'
        : 'desktop'
      : 'browser'
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable.')
    await navigator.clipboard.writeText(sessionLog.format(runtime))
    copyNotice.value = 'Copied logs to clipboard.'
    copyNoticeTimeout = window.setTimeout(() => {
      copyNotice.value = ''
      copyNoticeTimeout = undefined
    }, 4_000)
  } catch {
    localError.value = 'Could not copy logs to the clipboard.'
  }
}

const selectMapFamily = (family: MapFamily): void => {
  mapFamily.value = family
  window.localStorage.setItem('constellation.map-family', family)
  menuOpen.value = false
}
const openAbout = (): void => {
  aboutOpen.value = true
  menuOpen.value = false
}
const openBrowserDiagnostics = (): void => {
  browserDiagnosticsOpen.value = true
  menuOpen.value = false
}
const openDiagnostics = (): void => {
  diagnosticsOpen.value = true
  menuOpen.value = false
}
const dismissIntro = (): void => {
  introOpen.value = false
  window.localStorage.setItem(introSeenKey, '1')
}
const openFollowInput = (): void => {
  followInputOpen.value = true
  menuOpen.value = false
}
const openFollowing = (): void => {
  selectedFollowId.value = undefined
  peerListFilter.value = 'viewing'
  peerListOpen.value = true
  menuOpen.value = false
}
const openSharing = (): void => {
  selectedFollowId.value = undefined
  peerListFilter.value = 'sharing'
  peerListOpen.value = true
  menuOpen.value = false
}

const updatePrecision = (precision: LocationPrecision) => {
  shareDraft.value = setPrecision(shareDraft.value, precision)
}
const updateDuration = (duration: ShareDuration) => {
  shareDraft.value = setDuration(shareDraft.value, duration)
}
const updateViewerCapacity = (viewerCapacity: ViewerCapacity) => {
  shareDraft.value = setViewerCapacity(shareDraft.value, viewerCapacity)
}
const updateAcknowledgement = (acknowledged: boolean) => {
  shareDraft.value = acknowledgeUntilRevoked(shareDraft.value, acknowledged)
}
const updateName = (name: string) => {
  shareDraft.value = setName(shareDraft.value, name)
}
const updatePublication = (publication: SharePublication) => {
  shareDraft.value = setPublication(shareDraft.value, publication)
}
const updateBatteryPolicy = (battery: ShareBatteryPolicy) => {
  shareDraft.value = setBatteryPolicy(shareDraft.value, battery)
}
const updateNetworkPolicy = (network: ShareNetworkPolicy) => {
  shareDraft.value = setNetworkPolicy(shareDraft.value, network)
}

const ownObservation = computed(() => {
  const location = backgroundStatus.value?.shares.length
    ? backgroundStatus.value.location
    : runtimeState.value.location
  return location.status === 'live' || location.status === 'delayed' || location.status === 'stale'
    ? location.observation
    : undefined
})
let initiallyCentered = false
watch(
  ownObservation,
  (observation) => {
    if (observation && localError.value === 'Waiting for your location…') localError.value = ''
    if (!observation || initiallyCentered || !locationMap.value) return
    locationMap.value.centerOn(locationObservationToMapLocation(observation))
    initiallyCentered = true
  },
  { immediate: true, flush: 'post' },
)
const centerOnOwnLocation = (): void => {
  browserLocationDeferred.value = false
  if (!ownObservation.value) {
    locationSource.start()
    localError.value = 'Waiting for your location…'
    return
  }
  locationMap.value?.centerOn(locationObservationToMapLocation(ownObservation.value))
}
const openFollowDetails = (shareId: string): void => {
  if (!runtimeState.value.following.some((entry) => entry.shareId === shareId)) return
  selectedFollowId.value = shareId
  peerListFilter.value = 'viewing'
  peerListOpen.value = true
}
const focusFollowing = (shareId: string): void => {
  if (!viewableIds.value.includes(shareId)) return
  const location = locations.value.find(({ id }) => id === shareId)
  if (!location) return
  locationMap.value?.centerOn(location)
  peerListOpen.value = false
}
const focusAllFollowing = (): void => {
  const peerLocations = locations.value.filter(({ id }) => viewableIds.value.includes(id))
  if (peerLocations.length === 0) return
  locationMap.value?.focusLocations(peerLocations)
  peerListOpen.value = false
}
const acceptPastedLink = (): void => {
  try {
    const link = pastedLink.value.trim()
    parseShareInvitation(link)
    introOpen.value = false
    invitationUrl.value = link
    if (isNative) invitationPending.value = true
    else void previewInvitation(link)
    followInputOpen.value = false
    pastedLink.value = ''
  } catch {
    localError.value = 'That is not a valid location link.'
  }
}

const acceptScannedLink = (url: string): void => {
  followInputOpen.value = false
  pastedLink.value = ''
  offerInvitation(url)
}

const createShare = async (): Promise<void> => {
  if (creatingShare.value) return
  const shareBackTarget = returnTarget.value
  readyShareIsReturn.value = Boolean(shareBackTarget)
  browserLocationDeferred.value = false
  creatingShare.value = true
  localError.value = ''
  sessionLog.record({ level: 'info', event: 'sharing.share.create.started' })
  try {
    if (backgroundSharing && !shareBackTarget) {
      await refreshBackgroundStatus()
      let deadline = Date.now() + 30_000
      while (backgroundStatus.value?.state === 'starting' && Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 250))
        await refreshBackgroundStatus()
      }
      const existingShareIds = new Set(backgroundStatus.value?.shares.map(({ shareId }) => shareId))
      locationSource.stop()
      backgroundStatus.value = await backgroundSharing.start(
        shareDraft.value,
        shareBaseUrl,
        document.visibilityState === 'visible',
      )
      deadline = Date.now() + 30_000
      while (
        !backgroundStatus.value.shares.some(({ shareId }) => !existingShareIds.has(shareId)) &&
        backgroundStatus.value.state !== 'error' &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => window.setTimeout(resolve, 250))
        await refreshBackgroundStatus()
      }
      readyShare.value = backgroundStatus.value.shares.find(
        ({ shareId }) => !existingShareIds.has(shareId),
      )
      if (!readyShare.value) {
        throw new Error(backgroundStatus.value.message || 'Could not create the location link.')
      }
    } else {
      readyShare.value = await runtime.createShare(shareDraft.value)
    }
    if (shareBackTarget && readyShare.value) {
      try {
        await runtime.offerReturnShare(shareBackTarget, readyShare.value.url)
        await runtime.markReturnPromptSeen(shareBackTarget)
        readyShare.value = undefined
      } catch (error) {
        localError.value =
          error instanceof Error ? error.message : 'Send this return link to the sender manually.'
      }
    }
    shareSheetOpen.value = false
    shareDraft.value = createShareDraft()
    collapseActions()
    sessionLog.record({ level: 'info', event: 'sharing.share.create.succeeded' })
  } catch (error) {
    sessionLog.record({ level: 'error', event: 'sharing.share.create.failed' })
    localError.value = error instanceof Error ? error.message : 'Could not create the share.'
    if (shareBackTarget) {
      const follow = runtimeState.value.following.find((entry) => entry.shareId === shareBackTarget)
      if (follow) shareBackPrompt.value = { shareId: shareBackTarget, name: follow.localName }
    }
  } finally {
    if (returnTarget.value === shareBackTarget) returnTarget.value = undefined
    creatingShare.value = false
    if (backgroundSharing) updateLocationOwnership()
  }
}

const acceptInvitation = async (): Promise<void> => {
  if (accepting.value) return
  accepting.value = true
  localError.value = ''
  sessionLog.record({ level: 'info', event: 'sharing.follow.accept.started' })
  try {
    const url = invitationUrl.value
    if (!url) throw new Error('The share link is unavailable.')
    const { shareId } = parseShareInvitation(url)
    await runtime.acceptShare(url, { saved: false })
    collapseActions()
    if (invitationUrl.value === url) {
      invitationPending.value = false
      invitationUrl.value = undefined
      window.history.replaceState({}, '', window.location.pathname)
    }
    const follow = runtimeState.value.following.find((entry) => entry.shareId === shareId)
    if (
      follow &&
      follow.status !== 'approval-pending' &&
      follow.status !== 'denied' &&
      runtimeState.value.canSave
    ) {
      nicknamePrompt.value = { shareId, name: follow.localName }
    } else if (!runtimeState.value.canSave) {
      localError.value = 'Protected storage is unavailable; preview only.'
    } else if (follow?.status === 'denied') {
      localError.value = 'The sender did not approve this device for the location share.'
    }
    sessionLog.record({ level: 'info', event: 'sharing.follow.accept.succeeded' })
  } catch (error) {
    sessionLog.record({ level: 'error', event: 'sharing.follow.accept.failed' })
    localError.value = error instanceof Error ? error.message : 'Could not open the share.'
  } finally {
    accepting.value = false
  }
}

const previewInvitation = async (url: string): Promise<void> => {
  if (accepting.value) return
  accepting.value = true
  localError.value = ''
  try {
    await runtime.acceptShare(url, { saved: false })
    collapseActions()
    if (invitationUrl.value === url) {
      invitationUrl.value = undefined
      window.history.replaceState({}, '', window.location.pathname + window.location.search)
    }
  } catch (error) {
    localError.value = error instanceof Error ? error.message : 'Could not preview the location.'
  } finally {
    accepting.value = false
  }
}

const keepFollowing = (shareId: string): void => {
  const follow = runtimeState.value.following.find((entry) => entry.shareId === shareId)
  if (follow) nicknamePrompt.value = { shareId, name: follow.localName }
}

const saveNickname = async (): Promise<void> => {
  if (!nicknamePrompt.value) return
  try {
    const { shareId, name } = nicknamePrompt.value
    await runtime.saveFollowing(shareId, name)
    const follow = runtimeState.value.following.find((entry) => entry.shareId === shareId)
    if (
      follow &&
      follow.status !== 'approval-pending' &&
      follow.status !== 'denied' &&
      !follow.returnPromptSeen
    ) {
      await runtime.markReturnPromptSeen(shareId)
      shareBackPrompt.value = { shareId, name: follow.localName || 'this person' }
    }
    nicknamePrompt.value = undefined
    browserLocationDeferred.value = false
    offerConnectedReturnShare(runtimeState.value)
    updateVisibility()
  } catch (error) {
    localError.value = error instanceof Error ? error.message : 'Could not save this location.'
  }
}

const openReturnShare = (): void => {
  const target = shareBackPrompt.value?.shareId
  if (!target) return
  returnTarget.value = target
  shareBackPrompt.value = undefined
  shareDraft.value = createShareDraft()
  browserLocationDeferred.value = false
  void createShare()
}

const dismissShareBackPrompt = (): void => {
  shareBackPrompt.value = undefined
  offerConnectedReturnShare(runtimeState.value)
}

const shareBackFromFollowing = async (shareId: string): Promise<void> => {
  const follow = runtimeState.value.following.find((entry) => entry.shareId === shareId)
  if (
    !follow ||
    follow.returnPromptSeen ||
    follow.status === 'approval-pending' ||
    follow.status === 'denied' ||
    creatingShare.value
  )
    return
  try {
    await runtime.markReturnPromptSeen(shareId)
    returnTarget.value = shareId
    shareDraft.value = createShareDraft()
    browserLocationDeferred.value = false
    peerListOpen.value = false
    await createShare()
  } catch (error) {
    localError.value = error instanceof Error ? error.message : 'Could not start a return share.'
  }
}

const closeShareSheet = (): void => {
  shareSheetOpen.value = false
  returnTarget.value = undefined
  offerConnectedReturnShare(runtimeState.value)
}

const changingReturnOffer = ref(false)

const dismissReturnOffer = (): void => {
  const offer = pendingReturnOffer.value
  if (!offer || changingReturnOffer.value) return
  changingReturnOffer.value = true
  localError.value = ''
  void (async () => {
    try {
      if (runtimeState.value.returnOffers.includes(offer)) {
        await runtime.dismissReturnOffer(offer.shareId, offer.viewerFingerprint)
      } else {
        if (!backgroundSharing) throw new Error('Background sharing is unavailable.')
        await backgroundSharing.dismissReturnOffer(offer.shareId, offer.viewerFingerprint)
        dismissedBackgroundOffers.value.set(
          `${offer.shareId}:${offer.viewerFingerprint}`,
          offer.url,
        )
        await refreshBackgroundStatus()
      }
    } catch (error) {
      localError.value =
        error instanceof Error ? error.message : 'Could not dismiss this return offer.'
    } finally {
      changingReturnOffer.value = false
    }
  })()
}

const acceptReturnOffer = (): void => {
  const offer = pendingReturnOffer.value
  if (!offer || changingReturnOffer.value) return
  changingReturnOffer.value = true
  localError.value = ''
  const backgroundOffer = Boolean(
    backgroundStatus.value?.returnOffers?.some(
      (candidate) =>
        candidate.shareId === offer.shareId &&
        candidate.viewerFingerprint === offer.viewerFingerprint &&
        candidate.url === offer.url,
    ),
  )
  void (async () => {
    try {
      await acceptReturnShare(runtime, offer, (shareId) =>
        runtimeState.value.following.some((entry) => entry.shareId === shareId && entry.connected),
      )
      if (backgroundOffer) {
        if (!backgroundSharing) throw new Error('Background sharing is unavailable.')
        await backgroundSharing.approveReturnLink(offer.shareId)
        await backgroundSharing.dismissReturnOffer(offer.shareId, offer.viewerFingerprint)
        dismissedBackgroundOffers.value.set(
          `${offer.shareId}:${offer.viewerFingerprint}`,
          offer.url,
        )
        await refreshBackgroundStatus()
      } else {
        await runtime.approveReturnLink(offer.shareId)
      }
      localError.value =
        'Return location accepted. Future shares from this link will be accepted automatically.'
    } catch (error) {
      localError.value =
        error instanceof Error ? error.message : 'Could not accept this return link.'
    } finally {
      changingReturnOffer.value = false
    }
  })()
}

const closeShareReady = (): void => {
  readyShare.value = undefined
  readyShareIsReturn.value = false
  offerConnectedReturnShare(runtimeState.value)
}

const showExistingShare = (share: ShareSummary): void => {
  readyShare.value = share
  readyShareIsReturn.value = false
  peerListOpen.value = false
}
const setViewerName = async (shareId: string, fingerprint: string, name: string): Promise<void> => {
  try {
    if (backgroundStatus.value?.shares.some((share) => share.shareId === shareId)) {
      backgroundStatus.value = await backgroundSharing?.setViewerName(shareId, fingerprint, name)
    } else {
      await runtime.setViewerLabel(shareId, fingerprint, name)
    }
  } catch {
    localError.value = 'Device name could not be saved in protected storage.'
  }
}
const blockViewer = async (shareId: string, fingerprint: string): Promise<void> => {
  try {
    if (backgroundStatus.value?.shares.some((share) => share.shareId === shareId)) {
      backgroundStatus.value = await backgroundSharing?.blockViewer(shareId, fingerprint)
    } else {
      await runtime.blockViewer(shareId, fingerprint)
    }
  } catch (error) {
    localError.value = error instanceof Error ? error.message : 'Could not block this device.'
  }
}
const changingViewerApproval = ref(false)
const approvePendingViewer = async (): Promise<void> => {
  const request = pendingViewerApproval.value
  if (!request || changingViewerApproval.value) return
  changingViewerApproval.value = true
  try {
    if (backgroundStatus.value?.shares.some((share) => share.shareId === request.shareId)) {
      if (!backgroundSharing) throw new Error('Background sharing is unavailable.')
      backgroundStatus.value = await backgroundSharing.approveViewer(
        request.shareId,
        request.peerId,
      )
    } else {
      await runtime.approveViewer(request.shareId, request.peerId)
    }
  } catch (error) {
    localError.value = error instanceof Error ? error.message : 'Could not approve this device.'
  } finally {
    changingViewerApproval.value = false
  }
}
const rejectPendingViewer = async (): Promise<void> => {
  const request = pendingViewerApproval.value
  if (!request || changingViewerApproval.value) return
  changingViewerApproval.value = true
  try {
    await blockViewer(request.shareId, request.fingerprint)
  } finally {
    changingViewerApproval.value = false
  }
}
const revokeShare = async (shareId: string): Promise<void> => {
  if (backgroundStatus.value?.shares.some((share) => share.shareId === shareId)) {
    backgroundStatus.value = await backgroundSharing?.stop(shareId)
    updateLocationOwnership()
  } else {
    await runtime.stopShare(shareId)
  }
  if (readyShare.value?.shareId === shareId) closeShareReady()
}
const stopFollowing = async (shareId: string): Promise<void> => {
  await runtime.stopFollowing(shareId)
  if (selectedFollowId.value === shareId) peerListOpen.value = false
}

const updateLocationOwnership = (): void => {
  const visible = document.visibilityState === 'visible'
  const serviceOwnsLocation = Boolean(backgroundStatus.value?.shares.length)
  runtime.setVisible(
    visible,
    !browserLocationDeferred.value && !serviceOwnsLocation && !creatingShare.value,
  )
  if (serviceOwnsLocation) locationSource.stop()
}
const updateVisibility = (): void => {
  const visible = document.visibilityState === 'visible'
  updateLocationOwnership()
  void backgroundSharing?.setVisible(visible).catch(() => undefined)
}
onMounted(() => {
  document.addEventListener('visibilitychange', updateVisibility)
  if (isAndroid) {
    void receiveSharedText().catch(() => undefined)
    sharedTextPoll = window.setInterval(
      () => void receiveSharedText().catch(() => undefined),
      1_000,
    )
  }
  void (async () => {
    updateVisibility()
    await migrateAndroidSourceShares()
    await runtime.initialize()
    if (backgroundSharing) {
      await refreshBackgroundStatus().catch(() => undefined)
      updateVisibility()
      backgroundPoll = window.setInterval(
        () => void refreshBackgroundStatus().catch(() => undefined),
        1_000,
      )
    }
    offerInvitation(window.location.href)
  })().catch((error) => {
    localError.value =
      error instanceof Error ? error.message : 'Protected shares could not be opened.'
  })
})
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', updateVisibility)
  unmounted = true
  stopDeepLinks()
  unsubscribe()
  if (backgroundPoll !== undefined) window.clearInterval(backgroundPoll)
  if (sharedTextPoll !== undefined) window.clearInterval(sharedTextPoll)
  if (copyNoticeTimeout !== undefined) window.clearTimeout(copyNoticeTimeout)
  if (statusNoticeTimeout !== undefined) window.clearTimeout(statusNoticeTimeout)
  void runtime.stop()
})
</script>
