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
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M4 7h16M4 12h16M4 17h16"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          />
        </svg>
      </button>
      <span class="brand-wordmark">Constellation</span>
      <button
        class="recenter-button"
        type="button"
        aria-label="Center on my location"
        @click="centerOnOwnLocation"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" stroke-width="1.4" />
          <path
            d="M12 1.7v2.1M12 20.2v2.1M1.7 12h2.1m16.4 0h2.1"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
          <path
            d="m12 6.8 1.2 4 4 1.2-4 1.2-1.2 4-1.2-4-4-1.2 4-1.2 1.2-4Z"
            fill="var(--accent)"
            stroke="currentColor"
            stroke-width="0.55"
            stroke-linejoin="round"
          />
          <circle cx="12" cy="12" r="1.1" fill="var(--surface-strong)" />
        </svg>
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
      <button type="button" @click="openAbout">Privacy and licenses</button>
      <button type="button" @click="copyLogs">Copy logs</button>
      <button type="button" @click="openDiagnostics">P2P diagnostics</button>
      <button type="button" @click="openFollowInput">Follow a link</button>
      <button type="button" @click="openFollowing">
        Following ({{ runtimeState.following.length }})
      </button>
    </section>

    <AboutSheet v-if="aboutOpen" @close="aboutOpen = false" />
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

    <section v-if="previewFollow" class="accept-card" aria-label="Location preview">
      <p class="eyebrow">Private preview</p>
      <strong>{{ previewFollow.localName }}</strong>
      <p>This location is visible now. Keep following to save it on this device.</p>
      <div class="preview-actions">
        <button
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
        Choose your own duration and precision. Your private return link goes only to the original
        sender over the encrypted connection. Nothing is shared until you create it.
      </p>
      <div class="preview-actions">
        <button class="primary-action" type="button" @click="openReturnShare">
          Share mine back
        </button>
        <button class="secondary-action" type="button" @click="shareBackPrompt = undefined">
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
      <strong>A connected viewer offered a private location link</strong>
      <p>
        Open it only if you expect this return share. The link does not prove who owns the location;
        other viewers cannot see it.
      </p>
      <div class="preview-actions">
        <button class="primary-action" type="button" @click="acceptReturnOffer">
          View return location
        </button>
        <button class="secondary-action" type="button" @click="dismissReturnOffer">Dismiss</button>
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
        <button class="dock-side" type="button" @click="sharesOpen = true">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 3v12m0 0-4-4m4 4 4-4M4 18h16"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <span>Sharing {{ activeShares.length }}</span>
        </button>
        <button
          class="dock-add"
          type="button"
          aria-label="Show sharing actions"
          :aria-expanded="actionsExpanded"
          @click="toggleActions"
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 4v16M4 12h16"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
        </button>
        <button class="dock-side" type="button" @click="openFollowing">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 21V9m0 0-4 4m4-4 4 4M4 6h16"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <span>Seeing {{ runtimeState.following.length }}</span>
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
    />

    <ShareListSheet
      v-if="sharesOpen"
      :shares="activeShares"
      @close="sharesOpen = false"
      @show="showExistingShare"
      @stop="revokeShare"
      @viewer-name="setViewerName"
      @viewer-block="blockViewer"
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
        <button class="primary-action" type="button" @click="acceptPastedLink">
          View location
        </button>
      </section>
    </div>

    <FollowingSheet
      v-if="followingOpen"
      :following="runtimeState.following"
      :viewable-ids="viewableIds"
      :selected-id="selectedFollowId"
      @close="followingOpen = false"
      @name="runtime.setFollowName"
      @color="runtime.setFollowColor"
      @focus="focusFollowing"
      @focus-all="focusAllFollowing"
      @stop="stopFollowing"
      @keep="keepFollowing"
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
      @close="readyShare = undefined"
      @stop="stopReadyShare"
    />

    <p v-if="statusMessage" class="toast" role="status">{{ statusMessage }}</p>
  </main>
</template>

<script setup lang="ts">
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys'
import { invoke } from '@tauri-apps/api/core'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import {
  createAndroidBackgroundSharing,
  type AndroidBackgroundStatus,
} from '../android/backgroundSharing.ts'
import LocationMap from '../components/LocationMap.vue'
import NetworkDiagnosticsSheet from '../components/NetworkDiagnosticsSheet.vue'
import CloseIcon from '../components/icons/CloseIcon.vue'
import AboutSheet from '../components/AboutSheet.vue'
import FollowingSheet from '../components/FollowingSheet.vue'
import ShareReadySheet from '../components/ShareReadySheet.vue'
import ShareListSheet from '../components/ShareListSheet.vue'
import ShareSheet from '../components/ShareSheet.vue'
import { createSessionLog } from '../diagnostics/sessionLog.ts'
import { createBrowserLocationSource } from '../location/browser.ts'
import { locationObservationToMapLocation } from '../location/mapModel.ts'
import type { MapFamily } from '../map/pmtiles.ts'
import { createPlatformGeolocation, ensureTauriLocationPermission } from '../location/platform.ts'
import { subscribeTauriDeepLinks } from '../platform/deepLinks.ts'
import { invitationFromSharedText } from '../platform/sharedText.ts'
import {
  acknowledgeUntilRevoked,
  canCreateShare,
  createShareDraft,
  setDuration,
  setName,
  setPrecision,
  setPublication,
  setViewerCapacity,
  type LocationPrecision,
  type ShareDuration,
  type SharePublication,
  type ViewerCapacity,
} from '../shareDraft.ts'
import { bytesToBase64Url } from '../sharing/encoding.ts'
import { resolveShareBaseUrl } from '../sharing/shareBaseUrl.ts'
import { parseShareInvitation } from '../sharing/shareLink.ts'
import { createBrowserPrivateStore, createNativePrivateStore } from '../sharing/privateStore.ts'
import {
  createSharingRuntime,
  type ShareSummary,
  type SharingRuntimeState,
  type NetworkDiagnostics,
} from '../sharing/sharingRuntime.ts'

const transportSummary = (diagnostics: NetworkDiagnostics): string => {
  const transports = diagnostics.connections.map((connection) => connection.transport).sort()
  return `${diagnostics.connections.length} connections${transports.length ? `: ${transports.join(', ')}` : ''}`
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

const locationSource = createBrowserLocationSource({
  sourceId: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16))),
  geolocation: createPlatformGeolocation(navigator.geolocation),
})
const shareBaseUrl = resolveShareBaseUrl(
  import.meta.env.VITE_CONSTELLATION_PUBLIC_URL,
  new URL(window.location.href),
)
const isNative = '__TAURI_INTERNALS__' in window
const isAndroid = '__TAURI_INTERNALS__' in window && /Android/i.test(navigator.userAgent)
const privateStore = isNative
  ? createNativePrivateStore(isAndroid ? 'android' : 'desktop')
  : createBrowserPrivateStore()
const runtime = createSharingRuntime(locationSource, shareBaseUrl, privateStore)
const backgroundSharing = createAndroidBackgroundSharing({
  isAndroid,
  now: Date.now,
  invoke,
  preparePermissions: async () =>
    ensureTauriLocationPermission(await import('@tauri-apps/plugin-geolocation')),
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
  message: '',
  canSave: true,
})
const pendingReturnOffer = computed(() => {
  const foreground = runtimeState.value.returnOffers[0]
  if (foreground) return foreground
  return backgroundStatus.value?.returnOffers?.find(
    ({ shareId, viewerFingerprint, url }) =>
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
const introSeenKey = 'constellation.privacy-intro-seen'
const actionsExpanded = ref(window.localStorage.getItem('constellation.actions-expanded') !== '0')
const introOpen = ref(window.localStorage.getItem(introSeenKey) !== '1')
const menuOpen = ref(false)
const closeMenuOnOutsideClick = (event: MouseEvent): void => {
  if (event.target instanceof Element && event.target.closest('.brand-button, .app-menu')) return
  menuOpen.value = false
}
const aboutOpen = ref(false)
const diagnosticsOpen = ref(false)
const sharesOpen = ref(false)
const followInputOpen = ref(false)
const followingOpen = ref(false)
const selectedFollowId = ref<string>()
const pastedLink = ref('')
const locationMap = ref<InstanceType<typeof LocationMap>>()
const shareDraft = ref(createShareDraft())
const creatingShare = ref(false)
const accepting = ref(false)
const readyShare = ref<ShareSummary>()
const invitationPending = ref(false)
const invitationUrl = ref<string>()
const browserLocationDeferred = ref(!isNative && window.location.hash.startsWith('#share='))
const nicknamePrompt = ref<{ shareId: string; name: string }>()
const shareBackPrompt = ref<{ shareId: string; name: string }>()
const returnTarget = ref<string>()
const localError = ref('')
const copyNotice = ref('')
let copyNoticeTimeout: number | undefined

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
  const latestNetwork = runtime.networkDiagnostics()
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
  backgroundStatus.value = next
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
const previewFollow = computed(() => runtimeState.value.following.find((entry) => !entry.saved))

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
    ...runtimeState.value.received.map(({ shareId, observation, state }) => {
      const follow = runtimeState.value.following.find((entry) => entry.shareId === shareId)
      return locationObservationToMapLocation(observation, state, {
        id: shareId,
        label: follow?.localName || follow?.sourceName || 'Shared location',
        color: follow?.color,
      })
    }),
  ]
})
const viewableIds = computed(() => runtimeState.value.received.map(({ shareId }) => shareId))

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
const statusMessage = computed(
  () =>
    localError.value ||
    copyNotice.value ||
    backgroundStatus.value?.message ||
    runtimeState.value.message,
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
  followingOpen.value = true
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
  followingOpen.value = true
}
const focusFollowing = (shareId: string): void => {
  if (!viewableIds.value.includes(shareId)) return
  const location = locations.value.find(({ id }) => id === shareId)
  if (!location) return
  locationMap.value?.centerOn(location)
  followingOpen.value = false
}
const focusAllFollowing = (): void => {
  const peerLocations = locations.value.filter(({ id }) => viewableIds.value.includes(id))
  if (peerLocations.length === 0) return
  locationMap.value?.focusLocations(peerLocations)
  followingOpen.value = false
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

const createShare = async (): Promise<void> => {
  browserLocationDeferred.value = false
  creatingShare.value = true
  localError.value = ''
  sessionLog.record({ level: 'info', event: 'sharing.share.create.started' })
  try {
    if (backgroundSharing) {
      await refreshBackgroundStatus()
      let deadline = Date.now() + 30_000
      while (backgroundStatus.value?.state === 'starting' && Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 250))
        await refreshBackgroundStatus()
      }
      const existingShareIds = new Set(backgroundStatus.value?.shares.map(({ shareId }) => shareId))
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
    if (returnTarget.value && readyShare.value) {
      try {
        await runtime.offerReturnShare(returnTarget.value, readyShare.value.url)
      } catch (error) {
        localError.value =
          error instanceof Error ? error.message : 'Send this return link to the sender manually.'
      }
      returnTarget.value = undefined
    }
    shareSheetOpen.value = false
    shareDraft.value = createShareDraft()
    collapseActions()
    sessionLog.record({ level: 'info', event: 'sharing.share.create.succeeded' })
  } catch (error) {
    sessionLog.record({ level: 'error', event: 'sharing.share.create.failed' })
    localError.value = error instanceof Error ? error.message : 'Could not create the share.'
  } finally {
    creatingShare.value = false
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
    if (follow && runtimeState.value.canSave) {
      try {
        await runtime.saveFollowing(shareId, follow.localName)
        nicknamePrompt.value = { shareId, name: follow.localName }
      } catch {
        localError.value = 'Protected storage is unavailable; preview only.'
      }
    } else if (!runtimeState.value.canSave) {
      localError.value = 'Protected storage is unavailable; preview only.'
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
    shareBackPrompt.value = {
      shareId,
      name:
        runtimeState.value.following.find((entry) => entry.shareId === shareId)?.localName ||
        'this person',
    }
    nicknamePrompt.value = undefined
    browserLocationDeferred.value = false
    updateVisibility()
  } catch (error) {
    localError.value = error instanceof Error ? error.message : 'Could not save this location.'
  }
}

const openReturnShare = (): void => {
  returnTarget.value = shareBackPrompt.value?.shareId
  shareBackPrompt.value = undefined
  shareDraft.value = createShareDraft()
  shareSheetOpen.value = true
}

const closeShareSheet = (): void => {
  shareSheetOpen.value = false
  returnTarget.value = undefined
}

const dismissReturnOffer = (): void => {
  const offer = pendingReturnOffer.value
  if (!offer) return
  if (runtimeState.value.returnOffers.includes(offer)) {
    runtime.dismissReturnOffer(offer.shareId, offer.viewerFingerprint)
  } else {
    dismissedBackgroundOffers.value.set(`${offer.shareId}:${offer.viewerFingerprint}`, offer.url)
  }
}

const acceptReturnOffer = (): void => {
  const offer = pendingReturnOffer.value
  if (!offer) return
  dismissReturnOffer()
  offerInvitation(offer.url)
}

const stopReadyShare = async (): Promise<void> => {
  if (!readyShare.value) return
  if (backgroundStatus.value?.shares.some(({ shareId }) => shareId === readyShare.value?.shareId)) {
    backgroundStatus.value = await backgroundSharing?.stop(readyShare.value.shareId)
  } else {
    await runtime.stopShare(readyShare.value.shareId)
  }
  readyShare.value = undefined
}

const showExistingShare = (share: ShareSummary): void => {
  readyShare.value = share
  sharesOpen.value = false
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
const revokeShare = async (shareId: string): Promise<void> => {
  if (backgroundStatus.value?.shares.some((share) => share.shareId === shareId)) {
    backgroundStatus.value = await backgroundSharing?.stop(shareId)
  } else {
    await runtime.stopShare(shareId)
  }
  if (readyShare.value?.shareId === shareId) readyShare.value = undefined
}
const stopFollowing = async (shareId: string): Promise<void> => {
  await runtime.stopFollowing(shareId)
  if (selectedFollowId.value === shareId) followingOpen.value = false
}

const updateVisibility = (): void => {
  const visible = document.visibilityState === 'visible'
  runtime.setVisible(visible, !browserLocationDeferred.value)
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
  void runtime.stop()
})
</script>
