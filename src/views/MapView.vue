<template>
  <main
    class="map-screen"
    :class="{ 'map-screen--menu-open': menuOpen }"
    @click.capture="closeMenuOnOutsideClick"
  >
    <div class="map-surface" aria-label="Location map">
      <LocationMap
        v-if="runtimeState.privateStateReady"
        ref="locationMap"
        :initial-camera="runtimeState.mapCamera"
        :locations="locations"
        :decluttering="mapDecluttering"
        :map-family="mapFamily"
        :cache-max-bytes="mapCacheMaxBytes"
        @select="openFollowDetails"
        @area-overflow="openAreaPeers"
        @select-own="openSettings"
        @select-group="openGroupPeers"
        @own-area-hidden="ownAreaHidden = $event"
        @diagnostic="sessionLog.record"
        @camera-change="runtime.setMapCamera"
        @user-pan="selectedFollowId = undefined"
      />
    </div>

    <header class="top-bar">
      <button
        class="brand-button"
        type="button"
        :aria-label="menuOpen ? 'Close menu' : 'Open menu'"
        :aria-expanded="menuOpen"
        @click="menuOpen = !menuOpen"
      >
        <Menu aria-hidden="true" />
      </button>
      <span class="brand-wordmark">Constellation</span>
      <button
        class="recenter-button"
        type="button"
        :class="{
          'recenter-button--live': ownLocationState.status === 'live',
          'recenter-button--muted':
            ownLocationState.status === 'delayed' || ownLocationState.status === 'stale',
        }"
        :aria-label="recenterLabel"
        :title="recenterLabel"
        @click="centerOnOwnLocation"
      >
        <LocateFixed aria-hidden="true" />
        <span v-if="ownAreaHidden" class="recenter-button__area-badge" aria-hidden="true" />
      </button>
    </header>

    <section
      v-if="deviceLocationOff"
      class="device-location-notice"
      role="status"
      aria-label="Device location is off"
    >
      <p><strong>Device location is off.</strong> {{ deviceLocationWarning }}</p>
      <button type="button" @click="openAndroidSystemSettings('device-location')">
        Open Android location settings
      </button>
    </section>

    <Transition name="menu-morph">
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
        <details class="map-cache-settings" @toggle="refreshMapCacheStats">
          <summary>Offline map cache</summary>
          <p class="field-help">
            Caches requested public basemap tiles on this device. Peer locations, links and history
            are never stored here.
          </p>
          <div class="map-cache-settings__sizes" role="group" aria-label="Maximum map cache size">
            <button
              v-for="size in mapCacheSizes"
              :key="size"
              type="button"
              :aria-pressed="mapCacheMaxBytes === size * 1024 * 1024"
              @click="setMapCacheMaxBytes(size * 1024 * 1024)"
            >
              {{ size < 1024 ? `${size} MB` : `${size / 1024} GB` }}
            </button>
          </div>
          <p class="field-help">
            This is a maximum, not a download size. Larger limits require free device storage; the
            browser or operating system can enforce a lower quota.
          </p>
          <p class="field-help">{{ mapCacheLabel }}</p>
          <button type="button" @click="clearMapCache">Clear map cache</button>
        </details>
        <details class="map-decluttering-settings">
          <summary>Map decluttering</summary>
          <label>
            <input v-model="mapDecluttering.enabled" type="checkbox" />
            Group nearby peers
          </label>
          <label>
            <input v-model="mapDecluttering.groupMarkerCollisions" type="checkbox" />
            Group colliding markers
          </label>
          <label>
            <input v-model="mapDecluttering.groupUncertaintyOverlap" type="checkbox" />
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
            />
          </label>
          <p v-if="!mapDecluttering.enabled" class="field-help" role="status">
            Grouping is off. These settings remain saved; effective fallback: individual markers.
          </p>
          <p
            v-else-if="
              !mapDecluttering.groupMarkerCollisions || !mapDecluttering.groupUncertaintyOverlap
            "
            class="field-help"
          >
            Inactive grouping options still retain their thresholds.
          </p>
        </details>
        <p v-if="mapSettingsWarning" class="field-help" role="alert">{{ mapSettingsWarning }}</p>
        <button type="button" @click="openSettings">Settings</button>
        <button type="button" @click="openAbout">Privacy and licenses</button>
        <button type="button" @click="shareLogs">Share logs as file</button>
        <button v-if="!isAndroid" type="button" @click="copyLogs">Copy logs</button>
        <button type="button" @click="openBrowserDiagnostics">Diagnostics</button>
        <button type="button" @click="openDiagnostics">P2P diagnostics</button>
        <button type="button" @click="openFollowInput">Follow a link</button>
        <button type="button" @click="openFollowing">
          Following ({{ activeFollowing.length }})
        </button>
        <button type="button" @click="openProjectLink('release')">Latest release</button>
        <button type="button" @click="openProjectLink('project')">GitHub project</button>
      </section>
    </Transition>

    <SettingsSheet
      v-if="settingsOpen"
      :behavior="sharingBehavior"
      :is-android="isAndroid"
      :permissions="sharingSetup?.permissions"
      :device-policies="sharingSetup?.devicePolicies"
      :review="behaviorReviewRequired"
      :has-shares="activeShares.length > 0"
      :background-following="backgroundFollowingPreference"
      :background-receiver-active="receiverOwner === 'service'"
      :saved-follow-count="
        runtimeState.following.filter(
          (entry) => entry.saved && !['expired', 'revoked'].includes(entry.status),
        ).length
      "
      :busy="settingsBusy || followingPreferencePending"
      :error="settingsError"
      @close="settingsOpen = false"
      @save="saveSharingBehavior"
      @set-background-following="setBackgroundFollowingPreference"
      @enable-permissions="enableSharingPermissions"
      @open-system-settings="openAndroidSystemSettings"
    />
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
        <a
          href="https://github.com/yeus/constellation#how-constellation-protects-your-privacy"
          target="_blank"
          rel="noopener noreferrer"
          @click="isAndroid && ($event.preventDefault(), openProjectLink('project'))"
          >More information</a
        >
        <button type="button" @click="dismissIntro">Got it</button>
      </div>
    </section>

    <div v-if="invitationPending" class="incoming-invitation-backdrop">
      <section
        class="incoming-invitation"
        role="dialog"
        aria-modal="true"
        aria-label="Location link introduction"
      >
        <p class="eyebrow">Constellation · Private location</p>
        <div class="incoming-invitation__body">
          <h1>Someone shared a location with you</h1>
          <p>
            You can see their location on the map after connecting. For links requiring approval,
            the sender must approve your device first.
          </p>
          <p>
            The sender can learn your device identity, that you are online, and possibly your IP
            address when connected directly. <strong>Your location will not be shared.</strong>
          </p>
          <p class="field-help">
            If approval is needed, both devices will show four letters to compare through a separate
            trusted channel before the sender approves.
          </p>
          <p v-if="localError" role="alert" class="field-help">{{ localError }}</p>
        </div>
        <div class="incoming-invitation__actions">
          <button
            class="primary-action"
            type="button"
            :disabled="accepting"
            @click="acceptInvitation"
          >
            {{ accepting ? 'Connecting…' : 'See location' }}
          </button>
          <button
            class="secondary-action"
            type="button"
            :disabled="accepting"
            @click="cancelInvitation"
          >
            Cancel
          </button>
        </div>
      </section>
    </div>

    <DeviceComparisonSheet
      v-if="comparisonOpen && comparisonShareId"
      :label="comparisonLabel(comparisonShareId)"
      :viewer="Boolean(selectedComparisonFollow)"
      :comparison="selectedDeviceComparison"
      :pending="comparingDevice === comparisonShareId"
      :mismatch="comparisonMismatch"
      :can-block="canBlockComparedDevice"
      :can-reject="canRejectComparedDevice"
      :error="comparisonError"
      @close="closeDeviceComparison"
      @start="startDeviceComparison(comparisonShareId)"
      @cancel="cancelActiveDeviceComparison"
      @confirm="
        selectedDeviceComparison && changeDeviceComparison(selectedDeviceComparison, 'confirm')
      "
      @mismatch="markDeviceComparisonMismatch"
      @stop="endMismatchedConnection"
      @reject="endMismatchedConnection"
      @block="endMismatchedConnection"
      @clear="clearSelectedComparison"
      @revoke="endMismatchedConnection"
    />

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
      <template v-if="approvalComparisonReady">
        <p>Compare these letters with the viewer through a trusted call or in person:</p>
        <strong class="device-comparison-letters">{{ pendingDeviceComparison?.letters }}</strong>
        <p class="field-help">Approve only if they match. The comparison expires in two minutes.</p>
      </template>
      <p
        v-else-if="pendingDeviceComparison && comparisonNow >= pendingDeviceComparison.expiresAt"
        class="field-help"
        role="alert"
      >
        This comparison expired. Ask the viewer to retry before approving.
      </p>
      <p v-else class="field-help" role="status">
        Waiting for the viewer's secure four-letter comparison. Do not approve before checking.
      </p>
      <div class="preview-actions">
        <button
          class="primary-action"
          type="button"
          :disabled="changingViewerApproval || !approvalComparisonReady"
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

    <section
      v-if="
        senderComparisonAttention &&
        !pendingViewerApproval &&
        !comparisonOpen &&
        !peerListOpen &&
        !previewFollow &&
        !invitationPending &&
        !readyShare
      "
      class="accept-card"
      role="region"
      aria-label="Device verification ready"
    >
      <p class="eyebrow">Optional security check</p>
      <strong>A device is ready to compare letters</strong>
      <p>Compare these letters with the viewer through a trusted independent channel.</p>
      <button
        type="button"
        class="secondary-action"
        @click="
          openDeviceComparison(senderComparisonAttention.shareId, senderComparisonAttention.peerId)
        "
      >
        View verification
      </button>
    </section>

    <section
      v-if="connectingInvitation && !previewFollow"
      class="accept-card incoming-status-card"
      role="status"
    >
      <strong>Connecting securely…</strong>
      <p>Waiting for a response from the sender. Your location is not shared.</p>
    </section>

    <section
      v-if="previewFollow && !dismissedPreviewIds.includes(previewFollow.shareId)"
      class="accept-card incoming-status-card"
      aria-label="Location preview"
      role="region"
    >
      <strong>{{ previewFollow.sourceName || previewFollow.localName }}</strong>
      <template v-if="previewFollow.status === 'approval-pending'">
        <p role="status">Waiting for sender approval</p>
        <template
          v-if="viewerPendingComparison && comparisonNow < viewerPendingComparison.expiresAt"
        >
          <strong class="device-comparison-letters">{{ viewerPendingComparison.letters }}</strong>
          <p>Make sure these letters match the sender's screen. Your location is not shared.</p>
        </template>
        <p v-else-if="comparingDevice === previewFollow.shareId">Establishing secure comparison…</p>
        <p
          v-else-if="viewerPendingComparison && comparisonNow >= viewerPendingComparison.expiresAt"
          role="alert"
        >
          The four-letter comparison expired. Retry to request a fresh code.
        </p>
        <p v-else-if="comparisonError" role="alert">{{ comparisonError }}</p>
        <p v-else>Connecting securely to compare device letters…</p>
        <div class="preview-actions">
          <button
            v-if="
              comparisonError ||
              (viewerPendingComparison && comparisonNow >= viewerPendingComparison.expiresAt)
            "
            class="secondary-action"
            type="button"
            @click="startDeviceComparison(previewFollow.shareId)"
          >
            Retry comparison
          </button>
          <button
            class="secondary-action"
            type="button"
            @click="stopFollowing(previewFollow.shareId)"
          >
            Cancel request
          </button>
        </div>
      </template>
      <template v-else-if="previewFollow.status === 'denied'">
        <p role="status">The sender declined this device.</p>
        <button
          class="secondary-action"
          type="button"
          @click="stopFollowing(previewFollow.shareId)"
        >
          Dismiss
        </button>
      </template>
      <template v-else>
        <p v-if="!previewFollow.lastLocationAt" role="status">
          Connected securely… Waiting for the first location.
        </p>
        <p v-else>This location is visible on the map. Your own location is not shared.</p>
        <div class="preview-actions">
          <button
            class="primary-action"
            type="button"
            :disabled="!runtimeState.canSave"
            @click="keepFollowing(previewFollow.shareId)"
          >
            Add peer
          </button>
          <button
            class="secondary-action"
            type="button"
            @click="dismissPreview(previewFollow.shareId)"
          >
            Not now
          </button>
        </div>
        <p v-if="!runtimeState.canSave">Protected storage is unavailable; preview only.</p>
      </template>
    </section>

    <section
      v-if="recentlyAddedPeer"
      class="accept-card incoming-status-card"
      aria-label="Peer added"
    >
      <strong>{{ recentlyAddedPeer.sourceName || recentlyAddedPeer.localName }} saved</strong>
      <p>You can keep viewing the map without sharing your own location.</p>
      <div class="preview-actions">
        <button
          class="secondary-action"
          type="button"
          @click="shareBackFromFollowing(recentlyAddedPeer.shareId)"
        >
          Share back
        </button>
        <button class="secondary-action" type="button" @click="recentlyAddedPeerId = undefined">
          Not now
        </button>
      </div>
    </section>

    <section
      v-if="pendingShareBack"
      class="accept-card incoming-status-card"
      role="status"
      aria-label="Waiting for share-back acceptance"
    >
      <p class="eyebrow">Private return share</p>
      <strong>{{
        pendingShareBack.phase === 'creating' ? 'Preparing return share…' : 'Waiting for acceptance'
      }}</strong>
      <p>
        Sharing
        {{
          pendingShareBack.precision === 'exact'
            ? 'exact'
            : pendingShareBack.precision === 'very-coarse'
              ? 'city-level'
              : 'neighbourhood-level'
        }}
        location with {{ pendingShareBack.peerName }}
        {{
          pendingShareBack.duration === 'until-revoked'
            ? 'until stopped'
            : `for up to ${pendingShareBack.duration === '8h' ? 'eight hours' : 'one hour'}`
        }}.
        {{
          pendingShareBack.phase === 'waiting'
            ? 'This closes when the recipient connects securely.'
            : 'Sending a private offer…'
        }}
      </p>
      <div class="preview-actions">
        <button class="secondary-action" type="button" @click="pendingShareBack = undefined">
          Dismiss
        </button>
      </div>
      <small class="field-help"
        >Dismiss hides this message; it does not revoke a created share.</small
      >
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
        Save permission now. This location and future authenticated share-backs from the same link
        will be received when available.
      </p>
      <div class="preview-actions">
        <button
          class="primary-action"
          type="button"
          :disabled="changingReturnOffer"
          @click="acceptReturnOffer"
        >
          {{ changingReturnOffer ? 'Saving…' : 'Accept share-backs' }}
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
      <div class="dock-status" role="status">
        <span
          class="connection-state__dot"
          :class="{ 'connection-state__dot--online': effectivePeerStatus === 'online' }"
          aria-hidden="true"
        />
        {{ connectionLabel }} <span aria-hidden="true">·</span> {{ ownLocationLabel }}
      </div>
      <button class="dock-peers" type="button" @click="openPeerList">
        <Share2 aria-hidden="true" />
        {{ sharingPaused && activeShares.length ? 'Paused' : 'Sharing' }}
        {{ activeShares.length }} · Seeing {{ activeFollowing.length }}
      </button>
    </footer>

    <ShareSheet
      v-if="shareSheetOpen"
      :draft="shareDraft"
      :return-recipient-name="
        returnTarget
          ? activeFollowing.find((follow) => follow.shareId === returnTarget)?.localName ||
            'the sender'
          : undefined
      "
      :can-submit="
        canCreateShare(shareDraft) &&
        !creatingShare &&
        !settingsBusy &&
        !behaviorReviewRequired &&
        !deviceLocationOff
      "
      :runtime-note="
        deviceLocationOff
          ? 'Device location is off. Turn on Location in Android Settings to create a new share; your other settings are still available.'
          : sharingBehavior.publication === 'background'
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
      @require-viewer-approval="shareDraft = setRequireViewerApproval(shareDraft, $event)"
      @acknowledge="updateAcknowledgement"
      @name="updateName"
      @regenerate-name="regenerateShareName"
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
        <div class="follow-link-actions">
          <button
            class="primary-action"
            type="button"
            :disabled="pastingLink"
            @click="pasteLocationLink"
          >
            <ClipboardPaste aria-hidden="true" />
            {{ pastingLink ? 'Reading clipboard…' : 'Paste link' }}
          </button>
          <button
            v-if="canScanQr"
            class="secondary-action"
            type="button"
            @click="qrScannerOpen = true"
          >
            <QrCode aria-hidden="true" /> Scan QR code
          </button>
        </div>
        <p v-if="followLinkError" class="field-help follow-link-error" role="alert">
          {{ followLinkError }}
        </p>
      </section>
    </div>
    <QrScannerSheet v-if="qrScannerOpen" @close="qrScannerOpen = false" @scan="acceptScannedLink" />

    <PeerListSheet
      v-if="peerListOpen"
      v-show="!comparisonOpen"
      :shares="activeShares"
      :locations="locations"
      :following="activeFollowing"
      :comparisons="deviceComparisons"
      :filter="peerListFilter"
      :old-shares="oldSharing"
      :old-following="runtimeState.oldSeeing"
      :stopped-viewers="[
        ...runtimeState.stoppedViewers,
        ...(backgroundStatus?.stoppedViewers ?? []),
      ]"
      :viewable-ids="viewableIds"
      :selected-id="selectedFollowId"
      :limited-ids="areaPeerIds"
      :group-scope="groupScope"
      :clear-old-busy="clearingOldPeers"
      :share-back-busy="creatingShare"
      :revoke-peer-busy="revokingPeer"
      :paused="sharingPaused"
      :pause-busy="changingSharingPause"
      :revoke-all-busy="revokingAllShares"
      :peer-name-preferences="peerNamePreferences"
      :trace-error="traceError"
      @compare-device="openDeviceComparison"
      @clear-old="clearOldPeers"
      @open-local-settings="openSettings"
      @profile="setPeerNamePreferences"
      @adopt-name="adoptPeerName"
      @close="peerListOpen = false"
      @add-peer="openFollowInput"
      @share-location="openNewShare"
      @focus-peer="focusPeer"
      @filter="peerListFilter = $event"
      @show="showExistingShare"
      @revoke="revokeShare"
      @revoke-peer="revokePeer"
      @toggle-pause="toggleSharingPause"
      @revoke-all="revokeAllShares"
      @viewer-name="setViewerName"
      @viewer-block="blockViewer"
      @name="setFollowName"
      @color="setFollowColor"
      @focus="focusFollowing"
      @focus-all="focusAllFollowing"
      @unfollow="stopFollowing"
      @trace-opened="refreshReceivedHistory"
      @trace-enabled="setFollowTraceEnabled"
      @trace-clear="clearFollowTrace"
      @keep="keepFollowing"
      @dismiss-stopped="dismissStoppedViewer"
      @share-back="shareBackFromFollowing"
    />

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
import { protectActivePeerHistory } from '../sharing/peerHistory.ts'
import type { DeviceComparison } from '../sharing/deviceComparison.ts'
import {
  LucideLocateFixed as LocateFixed,
  LucideMenu as Menu,
  LucideClipboardPaste as ClipboardPaste,
  LucideQrCode as QrCode,
  LucideShare2 as Share2,
} from '@lucide/vue'
import { invoke } from '@tauri-apps/api/core'
import SettingsSheet from '../components/SettingsSheet.vue'
import { defaultSharingBehavior, type SharingBehavior } from '../sharing/sharingBehavior.ts'
import { deviceLocationNotice, effectiveSharingBehavior } from '../android/locationReadiness.ts'
import {
  loadLocalSharingPreference,
  saveLocalSharingPreference,
} from '../sharing/sharingPreference.ts'
import type {
  AndroidSharingSetup,
  AndroidSystemSettingsTarget,
} from '../android/backgroundSharing.ts'
import type { PmtilesCacheStats } from '../map/pmtiles.ts'
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
import DeviceComparisonSheet from '../components/DeviceComparisonSheet.vue'
import ShareReadySheet from '../components/ShareReadySheet.vue'
import ShareSheet from '../components/ShareSheet.vue'
import {
  createSessionLog,
  describeDiagnosticError,
  deviceComparisonFailureReason,
  nativeSessionEventName,
} from '../diagnostics/sessionLog.ts'
import { createAndroidBackgroundReceiver } from '../android/backgroundReceiver.ts'
import {
  readBackgroundFollowingPreference,
  resolveNativeFollowingPreference,
} from '../android/backgroundFollowingPreference.ts'
import { projectFollowOwnerState } from '../android/followOwnerProjection.ts'
import type { BackgroundViewerSnapshot } from '../android/backgroundViewer.ts'
import { createFollowOwnership, type FollowOwner } from '../sharing/followOwnership.ts'
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
  setDuration,
  setName,
  setPrecision,
  setRequireViewerApproval,
  setViewerCapacity,
  type LocationPrecision,
  type ShareDraft,
  type ShareDuration,
  type ViewerCapacity,
} from '../shareDraft.ts'
import { advertisedPeerName } from '../sharing/peerNames.ts'
import { suggestedPeerName } from '../identity/peerName.ts'
import {
  hasNewShareRecipient,
  mergeShareSummaries,
  type ShareContactState,
} from '../sharing/sharePresentation.ts'
import { bytesToBase64Url } from '../sharing/encoding.ts'
import { resolveShareBaseUrl } from '../sharing/shareBaseUrl.ts'
import { parseShareInvitation, verifyReturnOwner } from '../sharing/shareLink.ts'
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

const sessionLog = createSessionLog(Date.now, (entry) => {
  if ('__TAURI_INTERNALS__' in window && /Android/i.test(navigator.userAgent)) {
    void invoke('android_record_session_event', {
      event: nativeSessionEventName(entry),
      state: entry.state ?? '',
      level: entry.level,
    }).catch(() => undefined)
  }
  if (import.meta.env.DEV) {
    const method = entry.level === 'warning' ? 'warn' : entry.level === 'error' ? 'error' : 'info'
    console[method]('[constellation]', entry)
  }
})
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
const backgroundReceiver = createAndroidBackgroundReceiver({ isAndroid, invoke })
const migrateAndroidSourceShares = async (): Promise<void> => {
  if (!isAndroid || !backgroundSharing) return
  const saved = await privateStore.load()
  if (!saved || (!saved.shares.length && !saved.endedShares?.length)) return
  await backgroundSharing.importSourceState({
    ...saved,
    followed: [],
    viewerLabels: saved.viewerLabels ?? [],
  })
  await privateStore.save({
    ...saved,
    shares: [],
    endedShares: [],
    viewerLabels: [],
  })
}
const backgroundStatus = ref<AndroidBackgroundStatus>()
const dismissedBackgroundOffers = ref(new Map<string, string>())
const runtimeState = ref<SharingRuntimeState>({
  peerStatus: 'offline',
  paused: false,
  location: locationSource.getState(),
  shares: [],
  received: [],
  following: [],
  returnOffers: [],
  approvedReturnLinks: [],
  pendingViewerApprovals: [],
  oldSharing: [],
  oldSeeing: [],
  stoppedViewers: [],
  endNotifications: [],
  message: '',
  canSave: true,
})
const pendingReturnOffer = computed(() => {
  const foreground = runtimeState.value.returnOffers.find(
    ({ shareId }) => !runtimeState.value.approvedReturnLinks.includes(shareId),
  )
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
  (() => {
    try {
      return window.localStorage.getItem('constellation.map-family') === 'minimalist'
        ? 'minimalist'
        : 'default'
    } catch {
      return 'default'
    }
  })(),
)
const mapSettingsWarning = ref('')
const MAP_CACHE_BYTES_KEY = 'constellation.map-cache-bytes'
const MAP_CACHE_DEFAULT_BYTES = 64 * 1024 * 1024
const readMapCacheBytes = (): number => {
  let stored: string | null
  try {
    stored = window.localStorage.getItem(MAP_CACHE_BYTES_KEY)
  } catch {
    return MAP_CACHE_DEFAULT_BYTES
  }
  if (stored === null) return MAP_CACHE_DEFAULT_BYTES
  const bytes = Number(stored)
  return Number.isFinite(bytes) && bytes >= 0 ? bytes : MAP_CACHE_DEFAULT_BYTES
}
const mapCacheMaxBytes = ref(readMapCacheBytes())
const mapCacheStats = ref<PmtilesCacheStats>()
const mapCacheSizes = [64, 128, 256, 512, 1024, 2048, 4096, 8192] as const
const refreshMapCacheStats = async (): Promise<void> => {
  mapCacheStats.value = await locationMap.value?.cacheStats().catch(() => undefined)
}
const setMapCacheMaxBytes = (bytes: number): void => {
  mapCacheMaxBytes.value = bytes
  try {
    window.localStorage.setItem(MAP_CACHE_BYTES_KEY, String(bytes))
  } catch {
    mapSettingsWarning.value =
      'Map cache limit applies for this session, but storage is unavailable and the choice may reset.'
  }
}
const clearMapCache = async (): Promise<void> => {
  await locationMap.value?.clearCache().catch(() => undefined)
  await refreshMapCacheStats()
  sessionLog.record({ level: 'info', event: 'map.cache.cleared' })
}
const mapCacheLabel = computed(() => {
  const stats = mapCacheStats.value
  if (!stats) return 'Cache usage unavailable.'
  const megabytes = (stats.bytes / (1024 * 1024)).toFixed(1)
  return `${megabytes} MB · ${stats.packs} packs${stats.backend ? ` · ${stats.backend}` : ''}`
})
const mapDecluttering = ref<MapDeclutteringPreferences>(
  loadMapDeclutteringPreferences(window.localStorage),
)
watch(
  mapDecluttering,
  (preferences) => {
    try {
      saveMapDeclutteringPreferences(window.localStorage, preferences)
    } catch {
      mapSettingsWarning.value =
        'Map grouping settings apply for this session only; storage could not save them.'
    }
  },
  { deep: true },
)
const introSeenKey = 'constellation.privacy-intro-seen'
const actionsExpanded = ref(false)
const introOpen = ref(window.localStorage.getItem(introSeenKey) !== '1')
const menuOpen = ref(false)
watch(menuOpen, (open) => {
  if (open) void refreshMapCacheStats()
})
const onMenuKeyDown = (event: KeyboardEvent): void => {
  if (event.key !== 'Escape' || !menuOpen.value) return
  menuOpen.value = false
  document.querySelector<HTMLButtonElement>('.brand-button')?.focus()
}
const closeMenuOnOutsideClick = (event: MouseEvent): void => {
  if (event.target instanceof Element && event.target.closest('.brand-button, .app-menu')) return
  menuOpen.value = false
}
const openProjectLink = async (target: 'project' | 'release'): Promise<void> => {
  menuOpen.value = false
  try {
    if (isAndroid) {
      await invoke('android_open_project_link', { target })
      return
    }
    const url =
      target === 'project'
        ? 'https://github.com/yeus/constellation'
        : 'https://github.com/yeus/constellation/releases/latest'
    const opened = window.open(url, '_blank', 'noopener,noreferrer')
    if (!opened && !isNative) throw new Error('Your browser blocked the project link.')
  } catch (error) {
    localError.value = error instanceof Error ? error.message : 'Could not open external browser.'
  }
}
const sharingBehavior = ref<SharingBehavior>(defaultSharingBehavior(isAndroid))
const sharingSetup = ref<AndroidSharingSetup>()
const behaviorReviewRequired = ref(isAndroid)
const settingsOpen = ref(false)
const settingsBusy = ref(false)
const settingsError = ref('')
const backgroundFollowingPreference = ref(
  isAndroid && readBackgroundFollowingPreference(window.localStorage),
)
const followingPreferencePending = ref(false)
const loadNativeFollowingPreference = async (): Promise<void> => {
  if (!backgroundSharing) return
  const initial = await backgroundSharing.setup()
  sharingSetup.value = initial
  const enabled = await resolveNativeFollowingPreference(
    initial.backgroundFollowing,
    () => readBackgroundFollowingPreference(window.localStorage),
    async (legacy) => {
      const saved = await backgroundSharing.setBackgroundFollowingPreference(legacy)
      sharingSetup.value = saved
      return saved.backgroundFollowing
    },
  )
  backgroundFollowingPreference.value = enabled
  sessionLog.record({
    level: 'info',
    event: 'sharing.background.following.preference.loaded',
    state: enabled ? 'enabled' : 'disabled',
    message: 'native-encrypted-store',
  })
}
const hasSavedFollow = (): boolean =>
  runtimeState.value.following.some(
    (follow) => follow.saved && !['revoked', 'expired', 'denied'].includes(follow.status),
  )
const receiverOwner = ref<FollowOwner>('activity')
const receiverSnapshot = ref<BackgroundViewerSnapshot>()
let followOwnerController: ReturnType<typeof createFollowOwnership> | undefined

const receiverEffects = {
  suspendActivity: () => runtime.setFollowingSuspended(true),
  resumeActivity: () => runtime.setFollowingSuspended(false),
  startService: async (generation: number) => {
    if (!backgroundReceiver) throw new Error('Native background following is unavailable.')
    await backgroundReceiver.start(generation)
    const confirmed = await backgroundReceiver.ownership()
    if (confirmed.owner !== 'service' || confirmed.generation !== generation) {
      throw new Error('Background following ownership was not confirmed.')
    }
  },
  stopService: async (generation: number) => {
    if (!backgroundReceiver) throw new Error('Native background following is unavailable.')
    const current = await backgroundReceiver.ownership()
    if (current.owner === 'activity') return // Stopped through Android's notification
    if (current.generation !== generation) throw new Error('Background receiver ownership changed.')
    await backgroundReceiver.stop(generation)
    if ((await backgroundReceiver.ownership()).owner !== 'activity') {
      throw new Error('Background receiver still owns its subscriptions.')
    }
  },
}

let receiverStatusRequest = 0
let lastReceiverHistoryDiagnostic = ''
const applyReceiverState = (
  native: Awaited<ReturnType<NonNullable<typeof backgroundReceiver>['ownership']>>,
): void => {
  receiverOwner.value = native.owner
  receiverSnapshot.value = native.owner === 'service' ? (native.status ?? undefined) : undefined
  const following = receiverSnapshot.value?.following ?? []
  const diagnostic = `${native.owner}:${native.generation}:${following.length}:${following.reduce((total, entry) => total + (entry.trace?.length ?? 0), 0)}:${following.reduce((total, entry) => total + entry.updatesReceived, 0)}`
  if (diagnostic !== lastReceiverHistoryDiagnostic) {
    sessionLog.record({
      level: native.owner === 'service' && !native.status ? 'warning' : 'info',
      event: 'sharing.background.history',
      state: native.owner === 'service' && !native.status ? 'disconnected' : 'connected',
      message: `owner=${native.owner}; generation=${native.generation}; saved=${following.length}; recorded=${following.reduce((total, entry) => total + (entry.trace?.length ?? 0), 0)}; updates=${following.reduce((total, entry) => total + entry.updatesReceived, 0)}`,
    })
    lastReceiverHistoryDiagnostic = diagnostic
  }
}
const setBackgroundFollowing = async (enabled: boolean): Promise<void> => {
  if (!followOwnerController || settingsBusy.value || !backgroundReceiver) return
  ++receiverStatusRequest // Invalidate in-flight polls before changing ownership.
  settingsBusy.value = true
  settingsError.value = ''
  try {
    await followOwnerController.transition(enabled ? 'service' : 'activity')
    applyReceiverState(await backgroundReceiver.ownership())
    sessionLog.record({
      level: 'info',
      event: 'sharing.background.following',
      state: receiverOwner.value === 'service' ? 'enabled' : 'disabled',
    })
  } catch (error) {
    const current = await backgroundReceiver.ownership().catch(() => undefined)
    if (current) applyReceiverState(current)
    settingsError.value =
      error instanceof Error ? error.message : 'Background following could not be changed.'
  } finally {
    settingsBusy.value = false
  }
}

const setBackgroundFollowingPreference = async (enabled: boolean): Promise<void> => {
  if (!backgroundSharing || settingsBusy.value || followingPreferencePending.value) return
  followingPreferencePending.value = true
  settingsError.value = ''
  let persisted = false
  try {
    const setup = await backgroundSharing.setBackgroundFollowingPreference(enabled)
    if (setup.backgroundFollowing !== enabled)
      throw new Error('Native preference verification failed.')
    sharingSetup.value = setup
    backgroundFollowingPreference.value = enabled
    sessionLog.record({
      level: 'info',
      event: 'sharing.background.following.preference',
      state: enabled ? 'enabled' : 'disabled',
      message: 'native-encrypted-store',
    })
    persisted = true
  } catch (error) {
    settingsError.value =
      error instanceof Error
        ? error.message
        : 'Could not save native background following preference.'
  } finally {
    followingPreferencePending.value = false
  }
  if (!persisted) return
  // The native preference is committed before the async owner handoff.
  // If the handoff fails, boot restore must still honor the saved opt-out.
  if (!enabled && receiverOwner.value === 'service') {
    await setBackgroundFollowing(false)
  } else if (enabled && hasSavedFollow() && receiverOwner.value !== 'service') {
    await setBackgroundFollowing(true)
  }
}
const restorePreferredBackgroundFollowing = async (): Promise<void> => {
  if (!backgroundReceiver || !followOwnerController || settingsBusy.value) return
  if (!backgroundFollowingPreference.value && receiverOwner.value === 'service') {
    await setBackgroundFollowing(false)
  } else if (
    backgroundFollowingPreference.value &&
    receiverOwner.value !== 'service' &&
    hasSavedFollow()
  ) {
    await setBackgroundFollowing(true)
  }
}
const reconcileReceiverOwnership = async (): Promise<void> => {
  if (!backgroundReceiver || !followOwnerController || settingsBusy.value) return
  const request = ++receiverStatusRequest
  const native = await backgroundReceiver.ownership()
  if (request !== receiverStatusRequest || settingsBusy.value) return
  if (native.owner === 'activity' && followOwnerController.snapshot().owner === 'service') {
    await followOwnerController.transition('activity')
  } else if (native.owner === 'service' && followOwnerController.snapshot().owner === 'activity') {
    await runtime.setFollowingSuspended(true)
    followOwnerController = createFollowOwnership(receiverEffects, {
      owner: native.owner,
      generation: native.generation,
    })
  }
  if (request !== receiverStatusRequest || settingsBusy.value) return
  applyReceiverState(native)
}
const requireActivityFollowing = async (): Promise<void> => {
  if (receiverOwner.value === 'service') await setBackgroundFollowing(false)
  if (receiverOwner.value === 'service') {
    throw new Error('Background following must be disabled before editing subscriptions.')
  }
}
const setFollowName = async (shareId: string, name: string): Promise<void> => {
  try {
    await requireActivityFollowing()
    runtime.setFollowName(shareId, name)
  } catch (error) {
    localError.value = error instanceof Error ? error.message : 'Could not rename the peer.'
  }
}
const setFollowColor = async (shareId: string, color: string): Promise<void> => {
  try {
    await requireActivityFollowing()
    runtime.setFollowColor(shareId, color)
  } catch (error) {
    localError.value = error instanceof Error ? error.message : 'Could not update the peer color.'
  }
}
const openAndroidSystemSettings = async (target: AndroidSystemSettingsTarget): Promise<void> => {
  if (!backgroundSharing) return
  try {
    await backgroundSharing.openSystemSettings(target)
  } catch {
    settingsError.value =
      'Could not open Android settings. Open Constellation in Android App info instead.'
  }
}
const openSettings = (): void => {
  menuOpen.value = false
  settingsError.value = ''
  settingsOpen.value = true
  if (backgroundSharing) {
    void backgroundSharing
      .setup()
      .then((setup) => {
        sharingSetup.value = setup
      })
      .catch(() => {
        settingsError.value = 'Could not refresh Android permissions and restrictions.'
      })
  }
}
const loadSharingSettings = async (): Promise<void> => {
  if (backgroundSharing) {
    const setup = await backgroundSharing.setup()
    sharingSetup.value = setup
    sharingBehavior.value = setup.behavior ?? defaultSharingBehavior(true)
    behaviorReviewRequired.value = !setup.behavior
    if (behaviorReviewRequired.value) settingsOpen.value = true
  } else {
    const saved = await privateStore.load()
    sharingBehavior.value =
      loadLocalSharingPreference(window.localStorage) ??
      saved?.sharingBehavior ??
      defaultSharingBehavior(false)
    if (!saved?.sharingBehavior && saved?.shares.length) {
      behaviorReviewRequired.value = true
      settingsOpen.value = true
    }
    const effective = effectiveSharingBehavior(sharingBehavior.value, false, undefined)
    if (
      !saved?.sharingBehavior ||
      JSON.stringify(saved.sharingBehavior) !== JSON.stringify(effective)
    ) {
      await runtime.setSharingBehavior(effective)
    }
  }
}
const saveSharingBehavior = async (behavior: SharingBehavior): Promise<void> => {
  if (settingsBusy.value) return
  settingsBusy.value = true
  settingsError.value = ''
  try {
    if (backgroundSharing) {
      try {
        backgroundStatus.value = await backgroundSharing.setSharingBehavior(behavior)
      } catch (error) {
        // Android may commit the requested preference before a runtime handoff
        // times out. Read the durable preference rather than losing the choice.
        const saved = await backgroundSharing.setup().catch(() => undefined)
        if (!saved?.behavior || JSON.stringify(saved.behavior) !== JSON.stringify(behavior))
          throw error
        settingsError.value =
          'Preference saved, but the Android service could not confirm applying it. The foreground-only fallback is used until available; check permissions and retry.'
      }
      const setup = await backgroundSharing.setup()
      sharingSetup.value = setup
      if (!setup.behavior || JSON.stringify(setup.behavior) !== JSON.stringify(behavior)) {
        throw new Error('Android did not confirm the saved preference.')
      }
      sharingBehavior.value = setup.behavior
    } else {
      await runtime.setSharingBehavior(effectiveSharingBehavior(behavior, false, undefined))
      sharingBehavior.value = { ...behavior }
      if (!saveLocalSharingPreference(window.localStorage, behavior)) {
        settingsError.value =
          'Preference is active but local storage failed. It may reset after restarting this app.'
      }
    }
    behaviorReviewRequired.value = false
    settingsOpen.value = Boolean(settingsError.value)
    updateLocationOwnership()
  } catch {
    if (backgroundSharing) {
      const current = await backgroundSharing.setup().catch(() => undefined)
      if (current) {
        sharingSetup.value = current
        if (current.behavior) sharingBehavior.value = current.behavior
      }
    }
    settingsError.value =
      'Could not confirm the requested setting was saved. No fallback will bypass Android permissions. Retry.'
  } finally {
    settingsBusy.value = false
  }
}
const enableSharingPermissions = async (): Promise<void> => {
  if (!backgroundSharing || settingsBusy.value) return
  settingsBusy.value = true
  settingsError.value = ''
  try {
    sharingSetup.value = await backgroundSharing.enablePermissions()
    if (sharingBehavior.value.publication === 'background') {
      await backgroundSharing.setSharingBehavior(sharingBehavior.value)
    }
  } catch {
    settingsError.value =
      'Permissions could not be enabled. You can use sharing while the app is open, or retry.'
  } finally {
    settingsBusy.value = false
  }
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
const areaPeerIds = ref<readonly string[]>()
const groupScope = ref(false)
const peerListFilter = ref<'all' | 'sharing' | 'viewing' | 'both' | 'group'>('all')
const followInputOpen = ref(false)
const qrScannerOpen = ref(false)
const canScanQr = Boolean(window.isSecureContext && navigator.mediaDevices)
const selectedFollowId = ref<string>()
const pastingLink = ref(false)
const followLinkError = ref('')
const locationMap = ref<InstanceType<typeof LocationMap>>()
// Never recycle a generated share nickname during this session, including
// when opening multiple links to the same device. Existing links are also reserved.
const generatedShareNicknames = new Set<string>()
const freshShareNickname = (): string => {
  const reserved = new Set([
    ...generatedShareNicknames,
    ...runtimeState.value.shares.flatMap(({ name }) => (name ? [name] : [])),
    ...(backgroundStatus.value?.shares ?? []).flatMap(({ name }) => (name ? [name] : [])),
    ...runtimeState.value.oldSharing.flatMap(({ name }) => (name ? [name] : [])),
    ...(backgroundStatus.value?.oldSharing ?? []).flatMap(({ name }) => (name ? [name] : [])),
  ])
  let nickname = suggestedPeerName(crypto.randomUUID())
  for (let tries = 0; tries < 128 && reserved.has(nickname); tries++) {
    nickname = suggestedPeerName(crypto.randomUUID())
  }
  // The legacy two-word generator has only 64 combinations. Keep names fresh
  // even when a device creates more links than that in a single session.
  while (reserved.has(nickname)) {
    nickname = `${suggestedPeerName(crypto.randomUUID())} ${crypto.randomUUID().slice(0, 4)}`
  }
  generatedShareNicknames.add(nickname)
  return nickname
}
const shareDraft = ref(createShareDraft(freshShareNickname()))
const creatingShare = ref(false)
const accepting = ref(false)
const readyShare = ref<ShareSummary>()
const readyShareIsReturn = ref(false)
const invitationPending = ref(false)
const invitationUrl = ref<string>()
const connectingInvitation = ref(false)
const incomingShareId = ref<string>()
const pendingMapFocusId = ref<string>()
const attemptedAutoComparisons = new Set<string>()
const dismissedPreviewIds = ref<readonly string[]>([])
const recentlyAddedPeerId = ref<string>()
const pendingShareBack = ref<{
  sourceShareId: string
  peerName: string
  precision: LocationPrecision
  duration: ShareDuration
  phase: 'creating' | 'waiting'
  returnShareId?: string
}>()
const INCOMING_VIEWER_SENSOR_KEY = 'constellation.incoming-no-auto-gps'
const readIncomingSensorDeferral = (): boolean => {
  try {
    return sessionStorage.getItem(INCOMING_VIEWER_SENSOR_KEY) === '1'
  } catch {
    return false
  }
}
const browserLocationDeferred = ref(
  window.location.hash.startsWith('#share=') || readIncomingSensorDeferral(),
)
const setIncomingSensorDeferral = (deferred: boolean): void => {
  browserLocationDeferred.value = deferred
  try {
    if (deferred) sessionStorage.setItem(INCOMING_VIEWER_SENSOR_KEY, '1')
    else sessionStorage.removeItem(INCOMING_VIEWER_SENSOR_KEY)
  } catch {
    // Storage is optional; the in-memory flag remains authoritative.
  }
}
const returnTarget = ref<string>()
const localError = ref('')
const copyNotice = ref('')
let copyNoticeTimeout: number | undefined
let statusNoticeTimeout: number | undefined
const statusNoticeVisible = ref(true)
const closeShareReady = (): void => {
  readyShare.value = undefined
  readyShareIsReturn.value = false
}

const dismissReadyShareOnNewRecipient = (
  previous: ShareContactState,
  next: ShareContactState,
): void => {
  const shareId = readyShare.value?.shareId
  if (shareId && hasNewShareRecipient(shareId, previous, next)) closeShareReady()
}

// Distinguish repeated openings of the same bearer URL from an older async acceptance.
let invitationOpeningId = 0
const offerInvitation = (url: string): void => {
  try {
    const { shareId } = parseShareInvitation(url)
    invitationOpeningId += 1
    localError.value = ''
    introOpen.value = false
    invitationUrl.value = url
    incomingShareId.value = shareId
    invitationPending.value = true
    // Opening a link must not request the recipient's GPS location.
    if (!activeShares.value.length) {
      setIncomingSensorDeferral(true)
      updateLocationOwnership()
    }
    dismissedPreviewIds.value = dismissedPreviewIds.value.filter((id) => id !== shareId)
    attemptedAutoComparisons.delete(shareId)
    recentlyAddedPeerId.value = undefined
    // An incoming link never initiates a P2P connection before explicit consent.
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

// Log the transition from protocol result to visible state, for both Activity
// and Android service ownership. Challenges and letters are never exported.
const logComparisonStateChanges = (
  previous: readonly DeviceComparison[] | undefined,
  next: readonly DeviceComparison[],
  owner: 'activity' | 'service',
): void => {
  const prior = new Map((previous ?? []).map((entry) => [entry.challenge, entry]))
  for (const entry of next) {
    const old = prior.get(entry.challenge)
    if (!old) {
      sessionLog.record({
        level: 'info',
        event: 'sharing.comparison.ready',
        message: `role=${entry.role}; owner=${owner}`,
      })
    } else if (!old.confirmedAt && entry.confirmedAt) {
      sessionLog.record({
        level: 'info',
        event: 'sharing.comparison.confirmed',
        message: `role=${entry.role}; owner=${owner}`,
      })
    }
  }
}

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
  const previous = runtimeState.value
  logComparisonStateChanges(previous.deviceComparisons, next.deviceComparisons ?? [], 'activity')
  runtimeState.value = next
  dismissReadyShareOnNewRecipient(previous, next)
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
let locationReadinessPoll: number | undefined
let comparisonClock: number | undefined
let receiverPoll: number | undefined
let sharedTextPoll: number | undefined
let checkingSharedText = false
const receiveSharedText = async (): Promise<void> => {
  if (!isAndroid || checkingSharedText) return
  checkingSharedText = true
  try {
    const settings = await invoke<{ open: boolean }>('android_take_settings_request')
    if (settings.open) openSettings()
    const { text } = await invoke<{ text: string }>('android_take_shared_text')
    if (!text) return
    const invitation = invitationFromSharedText(text)
    if (invitation) offerInvitation(invitation)
    else localError.value = 'Shared text did not contain a valid location link.'
  } finally {
    checkingSharedText = false
  }
}
const logBackgroundStatusChanges = (
  previous: AndroidBackgroundStatus | undefined,
  next: AndroidBackgroundStatus,
): void => {
  if (previous?.state !== next.state) {
    sessionLog.record({ level: 'info', event: 'sharing.background.status', state: next.state })
  }
  if (next.peerStatus && previous?.peerStatus !== next.peerStatus) {
    sessionLog.record({ level: 'info', event: 'sharing.background.peer', state: next.peerStatus })
  }
  const previousViewers =
    previous?.shares.reduce((count, share) => count + share.viewerCount, 0) ?? 0
  const nextViewers = next.shares.reduce((count, share) => count + share.viewerCount, 0)
  if (previousViewers !== nextViewers) {
    sessionLog.record({
      level: 'info',
      event: 'sharing.background.viewers',
      message: `${nextViewers} connected sessions across ${next.shares.length} links`,
    })
  }
  if (previous?.location.status !== next.location.status) {
    sessionLog.record({
      level: 'info',
      event: 'sharing.background.location',
      message: next.location.status,
    })
  }
  if (
    next.diagnostics &&
    (!previous?.diagnostics ||
      transportSummary(previous.diagnostics) !== transportSummary(next.diagnostics))
  ) {
    sessionLog.record({
      level: 'info',
      event: 'sharing.background.connections',
      message: transportSummary(next.diagnostics),
    })
  }
  logComparisonStateChanges(previous?.deviceComparisons, next.deviceComparisons ?? [], 'service')
  if (next.diagnostics) recordSessionEvents(previous?.diagnostics, next.diagnostics)
}

let receivingApprovedReturns = false
const receiveApprovedBackgroundReturnsForStatus = async (
  next: AndroidBackgroundStatus,
): Promise<void> => {
  if (!backgroundSharing || receivingApprovedReturns || changingReturnOffer.value) return
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

const refreshBackgroundStatus = async (): Promise<void> => {
  if (!backgroundSharing) return
  const next = await backgroundSharing.status()
  logBackgroundStatusChanges(backgroundStatus.value, next)
  const previousServiceOwnsLocation = Boolean(backgroundStatus.value?.shares.length)
  const previous = backgroundStatus.value ?? { shares: [] }
  backgroundStatus.value = next
  dismissReadyShareOnNewRecipient(previous, next)
  if (previousServiceOwnsLocation !== Boolean(next.shares.length)) updateLocationOwnership()
  await receiveApprovedBackgroundReturnsForStatus(next)
}

const activeShares = computed(() =>
  mergeShareSummaries(runtimeState.value.shares, backgroundStatus.value?.shares ?? []).map(
    (share) => ({
      ...share,
      viewers: share.viewers?.map((viewer) => ({
        ...viewer,
        localName: runtime.getViewerLabel(share.shareId, viewer.fingerprint) ?? viewer.localName,
        displayName:
          runtime.getViewerLabel(share.shareId, viewer.fingerprint) ?? viewer.displayName,
      })),
    }),
  ),
)
watch([activeShares, pendingShareBack], ([shares, pending]) => {
  if (pending?.phase !== 'waiting' || !pending.returnShareId) return
  const share = shares.find(({ shareId }) => shareId === pending.returnShareId)
  // A session only appears here after the authenticated, recipient-bound
  // return link is redeemed; creating the link alone does not close the card.
  if (share && share.viewerCount > 0) pendingShareBack.value = undefined
})
const peerNamePreferences = computed(() => [
  ...(backgroundStatus.value?.peerNamePreferences ?? []),
  ...(runtimeState.value.peerNamePreferences ?? []),
])
const sharingPaused = computed(() =>
  backgroundStatus.value?.shares.length ? backgroundStatus.value.paused : runtimeState.value.paused,
)
const adoptPeerName = async (peerId: string, name: string): Promise<void> => {
  try {
    const foreground =
      advertisedPeerName(
        runtimeState.value.peerNamePreferences?.find((record) => record.peerId === peerId),
        runtimeState.value.following.find((entry) => entry.peerId === peerId && entry.sourceName)
          ?.sourceName,
      ) === name
    const background = backgroundStatus.value?.peerNamePreferences?.some(
      (record) => record.peerId === peerId && record.receivedName === name,
    )
    if (!foreground && !background)
      throw new Error('The advertised name changed. Review it and retry.')
    if (foreground) await runtime.adoptPeerName(peerId, name)
    if (background && backgroundSharing)
      backgroundStatus.value = await backgroundSharing.adoptPeerName(peerId, name)
  } catch (error) {
    localError.value =
      error instanceof Error ? error.message : 'Name could not be adopted. Please retry.'
  }
}
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
  return [
    ...new Map(
      records.map((record) => [JSON.stringify([record.shareId, record.peerId ?? null]), record]),
    ).values(),
  ].sort((left, right) => right.endedAt - left.endedAt)
})
const activeFollowing = computed(() =>
  projectFollowOwnerState(
    runtimeState.value.following,
    receiverOwner.value,
    receiverSnapshot.value,
  ).filter((entry) => entry.status !== 'expired' && entry.status !== 'revoked'),
)
const activelyViewedShareId = computed<string | null>(() => {
  const shareId = selectedFollowId.value
  return activeFollowing.value.some((entry) => entry.shareId === shareId && entry.connected)
    ? (shareId ?? null)
    : null
})
const synchronizeActiveViewing = (): void => {
  const shareId = document.visibilityState === 'visible' ? activelyViewedShareId.value : null
  runtime.setActiveViewing(shareId)
  void backgroundSharing?.setActiveViewing(shareId).catch(() => undefined)
}
watch(activelyViewedShareId, synchronizeActiveViewing)

const previewFollow = computed(
  () =>
    activeFollowing.value.find(
      (entry) => !entry.saved && entry.shareId === incomingShareId.value,
    ) ?? activeFollowing.value.find((entry) => !entry.saved),
)
const recentlyAddedPeer = computed(() =>
  activeFollowing.value.find((entry) => entry.saved && entry.shareId === recentlyAddedPeerId.value),
)
const comparisonOpen = ref(false)
const comparisonShareId = ref<string>()
const comparisonPeerId = ref<string>()
const comparisonMismatch = ref(false)
const comparisonError = ref<string>()
const comparingDevice = ref<string>()
const comparisonNow = ref(Date.now())
const deviceComparisons = computed(() => [
  ...(runtimeState.value.deviceComparisons ?? []),
  ...(backgroundStatus.value?.deviceComparisons ?? []),
])
const selectedComparisonFollow = computed(() =>
  runtimeState.value.following.find((entry) => entry.shareId === comparisonShareId.value),
)
const selectedDeviceComparison = computed(() =>
  deviceComparisons.value.find(
    (entry) =>
      entry.shareId === comparisonShareId.value &&
      (selectedComparisonFollow.value
        ? entry.role === 'viewer'
        : entry.role === 'sender' && entry.peerId === comparisonPeerId.value),
  ),
)
const comparisonLabel = (shareId: string): string =>
  runtimeState.value.following.find((entry) => entry.shareId === shareId)?.localName ||
  activeShares.value.find((entry) => entry.shareId === shareId)?.name ||
  'Single-recipient link'
const canRejectComparedDevice = computed(
  () =>
    pendingViewerApproval.value?.shareId === comparisonShareId.value &&
    (!comparisonPeerId.value || pendingViewerApproval.value?.peerId === comparisonPeerId.value),
)
const comparedViewerFingerprint = computed(
  () =>
    activeShares.value
      .filter(({ shareId }) => shareId === comparisonShareId.value)
      .flatMap(({ viewers }) => viewers ?? [])
      .find(({ peerId }) => peerId === comparisonPeerId.value)?.fingerprint,
)
const canBlockComparedDevice = computed(
  () =>
    !selectedComparisonFollow.value &&
    !canRejectComparedDevice.value &&
    Boolean(comparedViewerFingerprint.value),
)
const openDeviceComparison = (shareId: string, peerId?: string): void => {
  menuOpen.value = false
  comparisonShareId.value = shareId
  comparisonPeerId.value = peerId
  comparisonMismatch.value = false
  comparisonError.value = undefined
  comparisonOpen.value = true
}
const closeDeviceComparison = (): void => {
  // Closing an in-flight viewer comparison cancels its stream, not just the dialog.
  if (comparingDevice.value === comparisonShareId.value) void clearSelectedComparison()
  comparisonOpen.value = false
}
const startDeviceComparison = async (
  shareId: string,
  trigger: 'automatic' | 'manual' = 'manual',
): Promise<void> => {
  if (comparingDevice.value === shareId) return
  comparingDevice.value = shareId
  comparisonError.value = undefined
  let stage = 'preparing'
  sessionLog.record({
    level: 'info',
    event: 'sharing.comparison.started',
    message: `role=viewer; trigger=${trigger}`,
  })
  try {
    await runtime.startDeviceComparison(shareId, (phase) => {
      stage = phase
      sessionLog.record({
        level: 'info',
        event: 'sharing.comparison.progress',
        message: `role=viewer; stage=${phase}`,
      })
    })
  } catch (error) {
    sessionLog.record({
      level: 'warning',
      event: 'sharing.comparison.failed',
      message: `role=viewer; stage=${stage}; reason=${deviceComparisonFailureReason(error)}`,
    })
    comparisonError.value =
      error instanceof Error ? error.message : 'Device comparison unavailable.'
  } finally {
    comparingDevice.value = undefined
  }
}
const clearSelectedComparison = async (): Promise<boolean> => {
  const shareId = comparisonShareId.value
  if (!shareId) return false
  try {
    const current = selectedDeviceComparison.value
    if (
      current &&
      backgroundStatus.value?.deviceComparisons?.some(
        (entry) => entry.challenge === current.challenge,
      )
    ) {
      if (!backgroundSharing) throw new Error('Background comparison unavailable.')
      backgroundStatus.value = await backgroundSharing.deviceComparison(
        shareId,
        current.challenge,
        'cancel',
      )
    } else {
      await runtime.cancelDeviceComparison(shareId, current?.challenge ?? '')
    }
    sessionLog.record({
      level: 'info',
      event: 'sharing.comparison.cancelled',
      message: `role=${current?.role ?? 'viewer'}; action=user`,
    })
    return true
  } catch (error) {
    comparisonError.value = error instanceof Error ? error.message : 'Could not cancel comparison.'
    return false
  }
}
const cancelActiveDeviceComparison = async (): Promise<void> => {
  if (await clearSelectedComparison()) comparisonOpen.value = false
}
const markDeviceComparisonMismatch = async (): Promise<void> => {
  comparisonMismatch.value = true
  await clearSelectedComparison()
}
const endMismatchedConnection = async (): Promise<void> => {
  const shareId = comparisonShareId.value
  if (!shareId) return
  try {
    if (selectedComparisonFollow.value) await stopFollowing(shareId)
    else if (canRejectComparedDevice.value) {
      const request = pendingViewerApproval.value
      if (!request) throw new Error('The pending device is no longer available.')
      await blockViewerChecked(request.shareId, request.fingerprint)
    } else if (comparedViewerFingerprint.value) {
      await blockViewerChecked(shareId, comparedViewerFingerprint.value)
    } else {
      // With no authenticated per-viewer fingerprint, revocation is link-wide.
      await revokeShare(shareId)
    }
    closeDeviceComparison()
  } catch (error) {
    comparisonError.value =
      error instanceof Error ? error.message : 'Could not stop this connection.'
  }
}
const changeDeviceComparison = async (
  comparison: DeviceComparison,
  action: 'confirm' | 'cancel',
): Promise<void> => {
  try {
    if (
      backgroundStatus.value?.deviceComparisons?.some(
        (entry) => entry.challenge === comparison.challenge,
      ) &&
      backgroundSharing
    ) {
      backgroundStatus.value = await backgroundSharing.deviceComparison(
        comparison.shareId,
        comparison.challenge,
        action,
      )
    } else if (action === 'confirm') {
      await runtime.confirmDeviceComparison(comparison.shareId, comparison.challenge)
    } else {
      await runtime.cancelDeviceComparison(comparison.shareId, comparison.challenge)
    }
    sessionLog.record({
      level: 'info',
      event: action === 'confirm' ? 'sharing.comparison.confirmed' : 'sharing.comparison.cancelled',
      message: `role=${comparison.role}; action=${action}`,
    })
  } catch (error) {
    sessionLog.record({
      level: 'warning',
      event: 'sharing.comparison.failed',
      message: `role=${comparison.role}; operation=${action}; reason=${deviceComparisonFailureReason(error)}`,
    })
    comparisonError.value =
      error instanceof Error ? error.message : 'Could not save device comparison.'
  }
}

const pendingViewerApproval = computed(
  () =>
    runtimeState.value.pendingViewerApprovals[0] ??
    backgroundStatus.value?.pendingViewerApprovals?.[0],
)

const pendingDeviceComparison = computed(() =>
  deviceComparisons.value.find(
    (entry) =>
      entry.role === 'sender' &&
      entry.shareId === pendingViewerApproval.value?.shareId &&
      entry.peerId === pendingViewerApproval.value?.peerId,
  ),
)
const approvalComparisonReady = computed(() =>
  Boolean(
    pendingDeviceComparison.value && pendingDeviceComparison.value.expiresAt > comparisonNow.value,
  ),
)
const viewerPendingComparison = computed(() =>
  deviceComparisons.value.find(
    (entry) => entry.role === 'viewer' && entry.shareId === previewFollow.value?.shareId,
  ),
)
// A single automatic comparison per consented link; retries require a deliberate tap.
watch(
  () => [previewFollow.value?.shareId, previewFollow.value?.status] as const,
  ([shareId, status]) => {
    if (!shareId || status !== 'approval-pending' || attemptedAutoComparisons.has(shareId)) return
    attemptedAutoComparisons.add(shareId)
    void startDeviceComparison(shareId, 'automatic')
  },
)
const senderComparisonAttention = computed(() =>
  deviceComparisons.value.find(
    (entry) =>
      entry.role === 'sender' &&
      entry.confirmedAt === undefined &&
      Date.now() < entry.expiresAt &&
      activeShares.value.some((share) => share.shareId === entry.shareId),
  ),
)
// Distinguish a completed exchange from a code actually made visible by the UI.
const presentedComparisons = new Set<string>()
const recordPresentedComparison = (
  comparison: DeviceComparison | undefined,
  surface: 'dialog' | 'approval' | 'preview',
): void => {
  if (!comparison) return
  const key = `${comparison.challenge}:${surface}`
  if (presentedComparisons.has(key)) return
  if (presentedComparisons.size >= 256)
    presentedComparisons.delete(presentedComparisons.values().next().value!)
  presentedComparisons.add(key)
  sessionLog.record({
    level: 'info',
    event: 'sharing.comparison.presented',
    message: `role=${comparison.role}; surface=${surface}`,
  })
}
watch(
  [
    comparisonOpen,
    selectedDeviceComparison,
    comparisonMismatch,
    pendingViewerApproval,
    pendingDeviceComparison,
    approvalComparisonReady,
    previewFollow,
    viewerPendingComparison,
    dismissedPreviewIds,
  ],
  () => {
    if (comparisonOpen.value && !comparisonMismatch.value) {
      recordPresentedComparison(selectedDeviceComparison.value, 'dialog')
      return
    }
    if (pendingViewerApproval.value && approvalComparisonReady.value)
      recordPresentedComparison(pendingDeviceComparison.value, 'approval')
    if (
      previewFollow.value?.status === 'approval-pending' &&
      !dismissedPreviewIds.value.includes(previewFollow.value.shareId) &&
      viewerPendingComparison.value &&
      comparisonNow.value < viewerPendingComparison.value.expiresAt
    )
      recordPresentedComparison(viewerPendingComparison.value, 'preview')
  },
  { flush: 'post' },
)

const ownAreaHidden = ref(false)
const ownLocationState = computed(() =>
  backgroundStatus.value?.shares.length
    ? backgroundStatus.value.location
    : runtimeState.value.location,
)
const recenterLabel = computed(() => {
  const status = ownLocationState.value.status
  const freshness = {
    live: 'Live location',
    delayed: 'Delayed location',
    stale: 'Last known location',
    acquiring: 'Finding your location',
    denied: 'Location denied',
    'services-disabled': 'Device location off',
    'permission-required': 'Location off',
    unavailable: 'Location unavailable',
    error: 'Location error',
  }[status]
  return ownAreaHidden.value
    ? `${freshness}. Your location area is hidden at this zoom; show your area`
    : `Center on my location. ${freshness}`
})
const receivedLocations = computed(() =>
  receiverOwner.value === 'service' && receiverSnapshot.value
    ? receiverSnapshot.value.received
    : runtimeState.value.received,
)
const locations = computed(() => {
  const own = ownLocationState.value
  const ownLocations =
    own.status === 'live' || own.status === 'delayed' || own.status === 'stale'
      ? [locationObservationToMapLocation(own.observation, own.status)]
      : []
  return [
    ...ownLocations.map((location) => ({ ...location, isOwn: true, color: '#2563eb' })),
    ...receivedLocations.value
      .filter((entry) =>
        activeFollowing.value.some(
          (follow) => follow.shareId === entry.shareId && follow.status !== 'denied',
        ),
      )
      .map(({ shareId, observation, state }) => {
        const follow = activeFollowing.value.find((entry) => entry.shareId === shareId)
        return locationObservationToMapLocation(observation, state, {
          id: shareId,
          label: follow?.displayName || follow?.localName || 'Shared location',
          color: follow?.color,
        })
      }),
  ]
})
const viewableIds = computed(() =>
  receivedLocations.value
    .filter((entry) => activeFollowing.value.some((follow) => follow.shareId === entry.shareId))
    .map(({ shareId }) => shareId),
)
// The first authenticated fix from a newly opened link becomes the initial map focus.
watch(
  [locations, locationMap],
  ([visible, map]) => {
    if (!map || !pendingMapFocusId.value) return
    const location = visible.find((entry) => entry.id === pendingMapFocusId.value)
    if (!location) return
    map.centerOn(location)
    pendingMapFocusId.value = undefined
  },
  { flush: 'post' },
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
const deviceLocationOff = computed(
  () => isAndroid && sharingSetup.value?.permissions.servicesEnabled === false,
)
const deviceLocationWarning = computed(() =>
  deviceLocationNotice(!deviceLocationOff.value, activeShares.value.length),
)
const ownLocationLabel = computed(() => {
  if (deviceLocationOff.value) return 'Device location off'
  if (ownObservation.value) return 'Your position ready'
  if (ownLocationState.value.status === 'denied') return 'Location denied'
  if (ownLocationState.value.status === 'acquiring') return 'Finding your location'
  return 'Your location off'
})

const collapseActions = (): void => {
  actionsExpanded.value = false
  window.localStorage.setItem('constellation.actions-expanded', '0')
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

const exportedSessionLogs = (): string =>
  sessionLog.format(isAndroid ? 'android' : isNative ? 'desktop' : 'browser')

const shareLogs = async (): Promise<void> => {
  menuOpen.value = false
  localError.value = ''
  try {
    const text = exportedSessionLogs()
    if (isAndroid) {
      await invoke('android_share_session_logs', { text })
      return
    }
    const file = new File(
      [text],
      `constellation-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`,
      {
        type: 'text/plain',
      },
    )
    if (navigator.canShare?.({ files: [file] }) && navigator.share) {
      await navigator.share({ files: [file], title: 'Constellation session logs' })
      return
    }
    const url = URL.createObjectURL(file)
    try {
      const download = document.createElement('a')
      download.href = url
      download.download = file.name
      download.click()
    } finally {
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return
    localError.value = 'Could not share logs as a file.'
  }
}

const copyLogs = async (): Promise<void> => {
  menuOpen.value = false
  localError.value = ''
  copyNotice.value = ''
  if (copyNoticeTimeout !== undefined) window.clearTimeout(copyNoticeTimeout)
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable.')
    await navigator.clipboard.writeText(exportedSessionLogs())
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
  try {
    window.localStorage.setItem('constellation.map-family', family)
    menuOpen.value = false
  } catch {
    mapSettingsWarning.value = 'Map style applies for this session only; storage could not save it.'
    // Keep the menu visible so the user sees the warning.
  }
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
  followLinkError.value = ''
  peerListOpen.value = false
  followInputOpen.value = true
  menuOpen.value = false
}
const openFollowing = (): void => {
  areaPeerIds.value = undefined
  groupScope.value = false
  selectedFollowId.value = undefined
  peerListFilter.value = 'viewing'
  peerListOpen.value = true
  menuOpen.value = false
}
const openPeerList = (): void => {
  areaPeerIds.value = undefined
  groupScope.value = false
  selectedFollowId.value = undefined
  peerListFilter.value = 'all'
  peerListOpen.value = true
  menuOpen.value = false
}
const openAreaPeers = (ids: string[]): void => {
  areaPeerIds.value = ids
  groupScope.value = true
  peerListFilter.value = 'all'
  selectedFollowId.value = undefined
  peerListOpen.value = true
}
const openGroupPeers = (ids: string[]): void => {
  areaPeerIds.value = ids
  groupScope.value = true
  peerListFilter.value = 'group'
  selectedFollowId.value = undefined
  peerListOpen.value = true
  menuOpen.value = false
}
const openNewShare = (): void => {
  if (behaviorReviewRequired.value) {
    openSettings()
    return
  }
  peerListOpen.value = false
  shareDraft.value = createShareDraft(freshShareNickname())
  returnTarget.value = undefined
  shareSheetOpen.value = true
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
const regenerateShareName = (): void => {
  const name = freshShareNickname()
  shareDraft.value = setName(shareDraft.value, name)
}
const updateName = (name: string) => {
  shareDraft.value = setName(shareDraft.value, name)
}

const ownObservation = computed(() => {
  const location = ownLocationState.value
  return location.status === 'live' || location.status === 'delayed' || location.status === 'stale'
    ? location.observation
    : undefined
})
let initiallyCentered = false
watch(
  [ownObservation, () => runtimeState.value.privateStateReady],
  ([observation, ready]) => {
    if (observation && localError.value === 'Waiting for your location…') localError.value = ''
    if (!ready || !locationMap.value || initiallyCentered) return
    if (runtimeState.value.mapCamera) {
      initiallyCentered = true
      return
    }
    if (!observation) return
    locationMap.value.centerOn(locationObservationToMapLocation(observation))
    initiallyCentered = true
  },
  { immediate: true, flush: 'post' },
)
const centerOnOwnLocation = (): void => {
  selectedFollowId.value = undefined
  setIncomingSensorDeferral(false)
  if (!ownObservation.value) {
    locationSource.start()
    localError.value = 'Waiting for your location…'
    return
  }
  locationMap.value?.centerOn(locationObservationToMapLocation(ownObservation.value))
}
const openFollowDetails = (shareId: string): void => {
  if (!runtimeState.value.following.some((entry) => entry.shareId === shareId)) return
  groupScope.value = false
  areaPeerIds.value = undefined
  selectedFollowId.value = shareId
  peerListFilter.value = 'viewing'
  peerListOpen.value = true
}
const focusFollowing = (shareId: string): void => {
  if (!viewableIds.value.includes(shareId)) return
  const location = locations.value.find(({ id }) => id === shareId)
  if (!location) return
  locationMap.value?.centerOn(location)
  selectedFollowId.value = shareId
  peerListOpen.value = false
}
const focusPeer = (shareIds: readonly string[]): void => {
  const ids = new Set(shareIds)
  const peerLocations = locations.value.filter(
    ({ id }) => id && ids.has(id) && viewableIds.value.includes(id),
  )
  if (peerLocations.length === 0) return
  selectedFollowId.value =
    peerLocations.length === 1 &&
    activeFollowing.value.some((entry) => entry.shareId === peerLocations[0]?.id)
      ? peerLocations[0]?.id
      : undefined
  locationMap.value?.focusLocations(peerLocations)
  peerListOpen.value = false
}
const focusAllFollowing = (): void => {
  const peerLocations = locations.value.filter(({ id }) => viewableIds.value.includes(id))
  if (peerLocations.length === 0) return
  selectedFollowId.value = undefined
  locationMap.value?.focusLocations(peerLocations)
  peerListOpen.value = false
}
const openIncomingLink = (rawLink: string, origin: 'clipboard' | 'qr'): void => {
  const link = rawLink.trim()
  try {
    parseShareInvitation(link)
  } catch (error) {
    followLinkError.value =
      error instanceof Error && /expired/i.test(error.message)
        ? 'This location link has expired.'
        : origin === 'clipboard'
          ? 'Clipboard does not contain a valid location link.'
          : 'The scanned QR code does not contain a valid location link.'
    return
  }
  followLinkError.value = ''
  followInputOpen.value = false
  offerInvitation(link)
}

const pasteLocationLink = async (): Promise<void> => {
  if (pastingLink.value) return
  pastingLink.value = true
  followLinkError.value = ''
  try {
    if (!navigator.clipboard?.readText) throw new Error('Clipboard API unavailable.')
    const link = (await navigator.clipboard.readText()).trim()
    if (!followInputOpen.value) return
    if (!link) {
      followLinkError.value = 'Your clipboard is empty.'
      return
    }
    openIncomingLink(link, 'clipboard')
  } catch {
    if (followInputOpen.value)
      followLinkError.value =
        'Clipboard access unavailable. Allow clipboard access or scan a QR code.'
  } finally {
    pastingLink.value = false
  }
}

const acceptScannedLink = (url: string): void => {
  openIncomingLink(url, 'qr')
}

type ShareCreationContext = {
  readonly shareBackTarget: string | undefined
  readonly returnFollow: SharingRuntimeState['following'][number] | undefined
  readonly useBackground: boolean
  readonly draft: ShareDraft
}

const beginShareCreation = (): ShareCreationContext => {
  const shareBackTarget = returnTarget.value
  const returnFollow = shareBackTarget
    ? runtimeState.value.following.find(({ shareId }) => shareId === shareBackTarget)
    : undefined
  const useBackground = Boolean(backgroundSharing)
  // A return share always has exactly one recipient regardless of form state.
  const draft = {
    ...shareDraft.value,
    ...sharingBehavior.value,
    ...(shareBackTarget ? { viewerCapacity: 1 as const, requireViewerApproval: true } : {}),
  }
  readyShareIsReturn.value = Boolean(shareBackTarget)
  setIncomingSensorDeferral(false)
  creatingShare.value = true
  localError.value = ''
  sessionLog.record({ level: 'info', event: 'sharing.share.create.started' })
  return { shareBackTarget, returnFollow, useBackground, draft }
}

const validateReturnShareTarget = (context: ShareCreationContext): void => {
  if (
    context.shareBackTarget &&
    (!context.returnFollow ||
      ['approval-pending', 'denied', 'revoked', 'expired'].includes(context.returnFollow.status))
  ) {
    throw new Error('This location is no longer available for sharing back.')
  }
  if (context.shareBackTarget && !context.returnFollow?.peerId) {
    throw new Error('The original sender has no verified device identity.')
  }
}

const waitForBackgroundCondition = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 30_000
  while (!condition() && Date.now() < deadline) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 250))
    await refreshBackgroundStatus()
  }
}

const startBackgroundShare = async (
  context: ShareCreationContext,
  sharing: NonNullable<typeof backgroundSharing>,
): Promise<ShareSummary> => {
  await refreshBackgroundStatus()
  await waitForBackgroundCondition(() => backgroundStatus.value?.state !== 'starting')
  const existingShareIds = new Set(backgroundStatus.value?.shares.map(({ shareId }) => shareId))
  locationSource.stop()
  backgroundStatus.value = await sharing.start(
    context.draft,
    shareBaseUrl,
    document.visibilityState === 'visible',
  )
  await waitForBackgroundCondition(
    () =>
      Boolean(
        backgroundStatus.value?.shares.some(({ shareId }) => !existingShareIds.has(shareId)),
      ) || backgroundStatus.value?.state === 'error',
  )
  const created = backgroundStatus.value?.shares.find(
    ({ shareId }) => !existingShareIds.has(shareId),
  )
  if (!created) {
    throw new Error(backgroundStatus.value?.message || 'Could not create the location link.')
  }
  return created
}

const verifyBackgroundOwnership = async (
  updated: ShareSummary,
  source: ReturnType<typeof parseShareInvitation>,
  owner: { ownerPeerId: string },
): Promise<void> => {
  const updatedCapability = parseShareInvitation(updated.url)
  if (
    updatedCapability.sourcePeerId !== source.sourcePeerId ||
    updatedCapability.secret !== source.secret ||
    !(await verifyReturnOwner(updatedCapability, owner.ownerPeerId))
  ) {
    throw new Error('The background link failed ownership verification.')
  }
}

const adoptBackgroundOwnership = async (
  created: ShareSummary,
  context: ShareCreationContext,
  sharing: NonNullable<typeof backgroundSharing>,
): Promise<ShareSummary> => {
  // Adopt the foreground owner proof before the link is presented so a
  // return offer can never be bound to the unattended native identity.
  const binding =
    context.shareBackTarget && context.returnFollow?.peerId
      ? ({ mode: 'recipient', recipientPeerId: context.returnFollow.peerId } as const)
      : ({ mode: 'source' } as const)
  try {
    const source = parseShareInvitation(created.url)
    const owner = await runtime.signReturnOwnership(source.shareId, source.sourcePeerId)
    const adopted = await sharing.replaceBackgroundOwner(
      source.shareId,
      source.sourcePeerId,
      owner.ownerPeerId,
      owner.ownerProof,
      binding,
    )
    const updated = adopted.shares.find(({ shareId }) => shareId === source.shareId)
    if (!updated) throw new Error('Background ownership change was not confirmed.')
    await verifyBackgroundOwnership(updated, source, owner)
    backgroundStatus.value = adopted
    return updated
  } catch (error) {
    // Never serve or offer a native-owned link whose returns cannot reach
    // the foreground owner.
    await sharing.stop(created.shareId).catch(() => undefined)
    throw error
  }
}

const createBackgroundShare = async (
  context: ShareCreationContext,
  sharing: NonNullable<typeof backgroundSharing>,
): Promise<ShareSummary> => {
  const created = await startBackgroundShare(context, sharing)
  return adoptBackgroundOwnership(created, context, sharing)
}

const sendReturnShare = async (context: ShareCreationContext): Promise<boolean> => {
  if (!context.shareBackTarget || !readyShare.value) return false
  try {
    await runtime.offerReturnShare(
      context.shareBackTarget,
      readyShare.value.url,
      context.useBackground
        ? { externalBoundRecipientPeerId: context.returnFollow?.peerId }
        : undefined,
    )
    await runtime.markReturnPromptSeen(context.shareBackTarget)
    readyShare.value = undefined
    return true
  } catch (error) {
    localError.value =
      error instanceof Error ? error.message : 'Send this return link to the sender manually.'
    return false
  }
}

const completeShareCreation = (context: ShareCreationContext): void => {
  shareSheetOpen.value = false
  if (returnTarget.value === context.shareBackTarget) returnTarget.value = undefined
  shareDraft.value = createShareDraft(freshShareNickname())
  collapseActions()
  sessionLog.record({ level: 'info', event: 'sharing.share.create.succeeded' })
}

const createShare = async (): Promise<void> => {
  if (deviceLocationOff.value) {
    localError.value = 'Device location is off. Turn it on in Android Settings to start sharing.'
    return
  }
  if (behaviorReviewRequired.value || settingsBusy.value) {
    openSettings()
    return
  }
  if (creatingShare.value) return
  let context = beginShareCreation()
  try {
    if (context.shareBackTarget) {
      await requireActivityFollowing()
      // Resolve the recipient after reclaiming the native viewer identity.
      context = {
        ...context,
        returnFollow: runtimeState.value.following.find(
          ({ shareId }) => shareId === context.shareBackTarget,
        ),
      }
    }
    validateReturnShareTarget(context)
    readyShare.value =
      context.useBackground && backgroundSharing
        ? await createBackgroundShare(context, backgroundSharing)
        : await runtime.createShare(context.draft)
    if (
      context.shareBackTarget &&
      pendingShareBack.value?.sourceShareId !== context.shareBackTarget
    ) {
      pendingShareBack.value = {
        sourceShareId: context.shareBackTarget,
        peerName:
          context.returnFollow?.displayName || context.returnFollow?.localName || 'the sender',
        precision: context.draft.precision,
        duration: context.draft.duration,
        phase: 'creating',
      }
    }
    const returnShareId = readyShare.value?.shareId
    const sent = await sendReturnShare(context)
    if (
      context.shareBackTarget &&
      pendingShareBack.value?.sourceShareId === context.shareBackTarget
    ) {
      pendingShareBack.value =
        sent && returnShareId
          ? { ...pendingShareBack.value, phase: 'waiting', returnShareId }
          : undefined
    }
    completeShareCreation(context)
  } catch (error) {
    if (context.shareBackTarget) pendingShareBack.value = undefined
    sessionLog.record({ level: 'error', event: 'sharing.share.create.failed' })
    localError.value = error instanceof Error ? error.message : 'Could not create the share.'
  } finally {
    creatingShare.value = false
    if (context.shareBackTarget && backgroundFollowingPreference.value)
      void restorePreferredBackgroundFollowing()
    if (backgroundSharing) updateLocationOwnership()
  }
}

const cancelInvitation = (): void => {
  invitationOpeningId += 1
  invitationPending.value = false
  invitationUrl.value = undefined
  incomingShareId.value = undefined
  if (window.location.hash.startsWith('#share=')) {
    window.history.replaceState({}, '', window.location.pathname + window.location.search)
  }
}

const acceptInvitation = async (): Promise<void> => {
  if (accepting.value) return
  const url = invitationUrl.value
  const openingId = invitationOpeningId
  if (!url) return
  accepting.value = true
  connectingInvitation.value = true
  invitationPending.value = false
  localError.value = ''
  sessionLog.record({ level: 'info', event: 'sharing.follow.accept.started' })
  try {
    const { shareId } = parseShareInvitation(url)
    await requireActivityFollowing()
    const previous = runtimeState.value.following.find((entry) => entry.shareId === shareId)
    pendingMapFocusId.value = shareId
    if (!previous) await runtime.acceptShare(url, { saved: false })
    collapseActions()
    if (invitationOpeningId === openingId && invitationUrl.value === url) {
      invitationUrl.value = undefined
      window.history.replaceState({}, '', window.location.pathname + window.location.search)
    }
    if (previous?.saved) recentlyAddedPeerId.value = shareId
    sessionLog.record({ level: 'info', event: 'sharing.follow.accept.succeeded' })
  } catch (error) {
    if (invitationOpeningId === openingId) {
      invitationPending.value = true
      const failure = describeDiagnosticError(error)
      sessionLog.record({
        level: 'error',
        event: 'sharing.follow.accept.failed',
        category: failure.category,
        message: failure.message,
      })
      localError.value = failure.message
    }
  } finally {
    connectingInvitation.value = false
    accepting.value = false
  }
}

const dismissPreview = (shareId: string): void => {
  dismissedPreviewIds.value = [...new Set([...dismissedPreviewIds.value, shareId])]
}

const keepFollowing = async (shareId: string): Promise<void> => {
  const follow = runtimeState.value.following.find((entry) => entry.shareId === shareId)
  if (!follow || follow.status === 'denied' || follow.status === 'approval-pending') return
  try {
    await requireActivityFollowing()
    await runtime.saveFollowing(shareId, follow.localName)
    await runtime.markReturnPromptSeen(shareId)
    if (backgroundFollowingPreference.value && isAndroid) {
      void restorePreferredBackgroundFollowing()
    }
    recentlyAddedPeerId.value = shareId
    // Saving an incoming peer must not start the viewer's GPS or a location permission prompt.
    updateVisibility()
  } catch (error) {
    localError.value = error instanceof Error ? error.message : 'Could not save this peer.'
  }
}

const traceError = ref('')
const refreshReceivedHistory = (): void => {
  traceError.value = ''
  if (receiverOwner.value !== 'service') return
  void (async () => {
    if (document.visibilityState === 'visible') await backgroundSharing?.setVisible(true)
    await reconcileReceiverOwnership()
  })().catch(() => {
    traceError.value = 'Could not refresh background receiver history. Retry after reconnecting.'
  })
}
const editFollowTrace = async (action: () => Promise<void>, message: string): Promise<void> => {
  traceError.value = ''
  // The service owns the encrypted follow records in background mode. Return
  // ownership to the Activity for this edit, then restore it even on failure.
  // Previously this operation silently disabled background receiving entirely.
  const restoreBackground = receiverOwner.value === 'service'
  try {
    await requireActivityFollowing()
    await action()
  } catch (error) {
    traceError.value = error instanceof Error ? error.message : message
  } finally {
    if (restoreBackground && receiverOwner.value === 'activity') {
      await setBackgroundFollowing(true)
      const resumed = await backgroundReceiver?.ownership().catch(() => undefined)
      if (resumed?.owner !== 'service' && !traceError.value) {
        traceError.value = settingsError.value || 'Could not resume background following.'
      }
    }
  }
}
const setFollowTraceEnabled = (shareId: string, enabled: boolean): Promise<void> =>
  editFollowTrace(
    () => runtime.setFollowTraceEnabled(shareId, enabled),
    'Could not update recording.',
  )
const clearFollowTrace = (shareId: string): Promise<void> =>
  editFollowTrace(() => runtime.clearFollowTrace(shareId), 'Could not clear history.')

const shareBackFromFollowing = (shareId: string): void => {
  const follow = activeFollowing.value.find((entry) => entry.shareId === shareId)
  if (
    !follow ||
    ['approval-pending', 'denied', 'expired', 'revoked'].includes(follow.status) ||
    creatingShare.value
  )
    return
  if (behaviorReviewRequired.value || settingsBusy.value) {
    openSettings()
    return
  }
  if (deviceLocationOff.value) {
    localError.value = 'Enable device location before sharing back.'
    return
  }
  peerListOpen.value = false
  recentlyAddedPeerId.value = undefined
  returnTarget.value = shareId
  shareDraft.value = createShareDraft(freshShareNickname())
  shareSheetOpen.value = true
}
const closeShareSheet = (): void => {
  shareSheetOpen.value = false
  returnTarget.value = undefined
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

const acceptReturnOffer = async (): Promise<void> => {
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
  try {
    if (backgroundOffer) {
      if (!backgroundSharing) throw new Error('Background sharing is unavailable.')
      await backgroundSharing.approveReturnLink(offer.shareId)
    } else {
      await runtime.approveReturnLink(offer.shareId)
    }
    copyNotice.value = 'Share-back permission saved. Waiting for the location.'
  } catch (error) {
    localError.value = error instanceof Error ? error.message : 'Could not save permission.'
  } finally {
    changingReturnOffer.value = false
    if (backgroundOffer) void refreshBackgroundStatus().catch(() => undefined)
  }
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
const blockViewerChecked = async (shareId: string, fingerprint: string): Promise<void> => {
  if (backgroundStatus.value?.shares.some((share) => share.shareId === shareId)) {
    if (!backgroundSharing) throw new Error('Background sharing is unavailable.')
    backgroundStatus.value = await backgroundSharing.blockViewer(shareId, fingerprint)
  } else {
    await runtime.blockViewer(shareId, fingerprint)
  }
}
const blockViewer = async (shareId: string, fingerprint: string): Promise<void> => {
  try {
    await blockViewerChecked(shareId, fingerprint)
  } catch (error) {
    localError.value = error instanceof Error ? error.message : 'Could not block this device.'
  }
}
const changingViewerApproval = ref(false)
const approvePendingViewer = async (): Promise<void> => {
  const request = pendingViewerApproval.value
  const comparison = pendingDeviceComparison.value
  if (!request || changingViewerApproval.value) return
  // Never grant location access for an unverified or expired approval request.
  if (!comparison || !approvalComparisonReady.value || comparison.peerId !== request.peerId) {
    localError.value = 'Compare the four letters with the viewer before approving.'
    return
  }
  changingViewerApproval.value = true
  try {
    if (backgroundStatus.value?.shares.some((share) => share.shareId === request.shareId)) {
      if (!backgroundSharing) throw new Error('Background sharing is unavailable.')
      backgroundStatus.value = await backgroundSharing.deviceComparison(
        request.shareId,
        comparison.challenge,
        'confirm',
      )
      if (Date.now() >= comparison.expiresAt)
        throw new Error('Verification expired. Request a new comparison.')
      backgroundStatus.value = await backgroundSharing.approveViewer(
        request.shareId,
        request.peerId,
      )
    } else {
      await runtime.confirmDeviceComparison(request.shareId, comparison.challenge)
      if (Date.now() >= comparison.expiresAt)
        throw new Error('Verification expired. Request a new comparison.')
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
const changingSharingPause = ref(false)
const toggleSharingPause = async (): Promise<void> => {
  if (changingSharingPause.value) return
  changingSharingPause.value = true
  try {
    if (backgroundStatus.value?.shares.length) {
      if (!backgroundSharing) throw new Error('Background sharing is unavailable.')
      backgroundStatus.value = await backgroundSharing.setPaused(!backgroundStatus.value.paused)
    } else {
      await runtime.setPaused(!runtimeState.value.paused)
    }
  } catch (error) {
    localError.value =
      error instanceof Error ? error.message : 'Could not change the sharing pause.'
  } finally {
    changingSharingPause.value = false
  }
}
const revokingAllShares = ref(false)
const revokeAllShares = async (): Promise<void> => {
  if (revokingAllShares.value) return
  revokingAllShares.value = true
  try {
    const nativeShareIds = (backgroundStatus.value?.shares ?? []).map(({ shareId }) => shareId)
    const localShareIds = runtimeState.value.shares.map(({ shareId }) => shareId)
    if (nativeShareIds.length && backgroundSharing) {
      for (const shareId of nativeShareIds) {
        backgroundStatus.value = await backgroundSharing.stop(shareId)
      }
      updateLocationOwnership()
    }
    for (const shareId of localShareIds) await runtime.stopShare(shareId)
    if (readyShare.value) closeShareReady()
  } catch (error) {
    localError.value =
      error instanceof Error ? error.message : 'Could not revoke all location links.'
  } finally {
    revokingAllShares.value = false
  }
}
const stopFollowing = async (shareId: string): Promise<void> => {
  try {
    await requireActivityFollowing()
    await runtime.stopFollowing(shareId)
    if (selectedFollowId.value === shareId) peerListOpen.value = false
  } finally {
    if (backgroundFollowingPreference.value) void restorePreferredBackgroundFollowing()
  }
}

const revokingPeer = ref(false)
const revokePeer = async (targets: {
  followingShareIds: string[]
  dedicatedShareIds: string[]
  viewerConnections: { shareId: string; fingerprint: string }[]
}): Promise<void> => {
  if (revokingPeer.value) return
  revokingPeer.value = true
  try {
    // Block only this peer on shared links; revoking their whole link would
    // disconnect unrelated viewers holding the same bearer capability.
    for (const shareId of targets.dedicatedShareIds) await revokeShare(shareId)
    for (const connection of targets.viewerConnections)
      await blockViewerChecked(connection.shareId, connection.fingerprint)
    if (targets.followingShareIds.length) {
      await requireActivityFollowing()
      for (const shareId of targets.followingShareIds) await runtime.stopFollowing(shareId)
    }
  } catch (error) {
    localError.value = error instanceof Error ? error.message : 'Could not revoke this peer.'
  } finally {
    if (targets.followingShareIds.length && backgroundFollowingPreference.value)
      void restorePreferredBackgroundFollowing()
    revokingPeer.value = false
  }
}

const clearingOldPeers = ref(false)
const clearOldPeers = async (): Promise<void> => {
  if (clearingOldPeers.value) return
  clearingOldPeers.value = true
  try {
    const protection = protectActivePeerHistory(activeShares.value, activeFollowing.value)
    await runtime.clearOldPeers(protection)
    if (backgroundSharing)
      backgroundStatus.value = await backgroundSharing.clearOldPeers(protection)
  } catch {
    localError.value = 'Could not clear all old peers. Please retry.'
  } finally {
    clearingOldPeers.value = false
  }
}

const dismissStoppedViewer = async (shareId: string, peerId: string): Promise<void> => {
  try {
    if (
      backgroundStatus.value?.stoppedViewers?.some(
        (record) => record.shareId === shareId && record.peerId === peerId,
      )
    ) {
      if (!backgroundSharing) throw new Error('Background sharing is unavailable.')
      await backgroundSharing.dismissStoppedViewer(shareId, peerId)
      await refreshBackgroundStatus()
    } else {
      await runtime.dismissStoppedViewer(shareId, peerId)
    }
  } catch (error) {
    localError.value = error instanceof Error ? error.message : 'Could not dismiss the stop notice.'
  }
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
const refreshDeviceLocationReadiness = async (): Promise<void> => {
  if (!backgroundSharing || document.visibilityState !== 'visible' || settingsBusy.value) return
  try {
    const setup = await backgroundSharing.setup()
    const previousPermissions = sharingSetup.value?.permissions
    const previous = previousPermissions?.servicesEnabled
    const policySignals = [
      ['android.power.optimization', 'batteryOptimizationExempt'],
      ['android.power.saver', 'powerSaverEnabled'],
      ['android.power.restricted', 'backgroundRestricted'],
      ['android.network.data-saver', 'dataSaverEnabled'],
    ] as const
    for (const [event, key] of policySignals) {
      const value = setup.devicePolicies?.[key]
      if (value === undefined || value === sharingSetup.value?.devicePolicies?.[key]) continue
      sessionLog.record({ level: 'info', event, state: value ? 'enabled' : 'disabled' })
    }
    sharingSetup.value = setup
    if (previous !== undefined && previous !== setup.permissions.servicesEnabled) {
      sessionLog.record({
        level: setup.permissions.servicesEnabled ? 'info' : 'warning',
        event: 'location.device.services',
        message: setup.permissions.servicesEnabled ? 'enabled' : 'disabled',
      })
      updateLocationOwnership()
    }
    if (
      previousPermissions &&
      sharingBehavior.value.publication === 'background' &&
      JSON.stringify(previousPermissions) !== JSON.stringify(setup.permissions)
    ) {
      // Permission recovery applies the persisted request, not a stale runtime fallback.
      await backgroundSharing.setSharingBehavior(sharingBehavior.value)
    }
  } catch {
    if (settingsOpen.value) settingsError.value = 'Could not check permissions. Please retry.'
  }
}
type SameDocumentNavigationEvent = Event & {
  navigationType?: string
  destination?: { url?: string; sameDocument?: boolean }
}
const handleLocationNavigation = (event: Event): void => {
  const navigation = event as SameDocumentNavigationEvent
  if (navigation.navigationType !== 'push' || !navigation.destination?.sameDocument) return
  const url = navigation.destination.url
  // hashchange alone misses a repeated navigation to the identical link URL.
  if (url && new URL(url).hash.startsWith('#share=')) offerInvitation(url)
}
const navigationTarget = (window as Window & { navigation?: EventTarget }).navigation
const handleLocationHashChange = (): void => {
  if (
    window.location.hash.startsWith('#share=') &&
    !(invitationPending.value && invitationUrl.value === window.location.href)
  )
    offerInvitation(window.location.href)
}
let lastVisibility: boolean | undefined
const recordConnectivity = (): void => {
  sessionLog.record({
    level: navigator.onLine ? 'info' : 'warning',
    event: 'app.connectivity',
    state: navigator.onLine ? 'online' : 'offline',
  })
}
const updateVisibility = (): void => {
  if (document.visibilityState === 'visible') void refreshDeviceLocationReadiness()
  const visible = document.visibilityState === 'visible'
  if (lastVisibility !== visible) {
    sessionLog.record({
      level: 'info',
      event: 'app.visibility',
      state: visible ? 'visible' : 'hidden',
    })
    lastVisibility = visible
  }
  if (visible) void reconcileReceiverOwnership().catch(() => undefined)
  updateLocationOwnership()
  void backgroundSharing
    ?.setVisible(visible)
    .then(synchronizeActiveViewing)
    .catch(() => undefined)
  if (!backgroundSharing) synchronizeActiveViewing()
}
onMounted(() => {
  // Link consent must appear immediately, even if protected-store or native startup is slow.
  if (window.location.hash.startsWith('#share=')) offerInvitation(window.location.href)
  comparisonClock = window.setInterval(() => {
    comparisonNow.value = Date.now()
  }, 1_000)
  document.addEventListener('visibilitychange', updateVisibility)
  window.addEventListener('keydown', onMenuKeyDown)
  window.addEventListener('online', recordConnectivity)
  window.addEventListener('offline', recordConnectivity)
  recordConnectivity()
  navigationTarget?.addEventListener('navigate', handleLocationNavigation)
  window.addEventListener('hashchange', handleLocationHashChange)
  if (isAndroid) {
    void receiveSharedText().catch(() => undefined)
    sharedTextPoll = window.setInterval(
      () => void receiveSharedText().catch(() => undefined),
      1_000,
    )
  }
  void (async () => {
    if (isAndroid) await loadNativeFollowingPreference()
    updateVisibility()
    const native = await backgroundReceiver?.ownership()
    if (native?.owner !== 'service') await migrateAndroidSourceShares()
    if (native?.owner === 'service') await runtime.setFollowingSuspended(true)
    if (native) {
      applyReceiverState(native)
      followOwnerController = createFollowOwnership(receiverEffects, {
        owner: native.owner,
        generation: native.generation,
      })
    }
    await runtime.initialize()
    await loadSharingSettings()
    await restorePreferredBackgroundFollowing()
    synchronizeActiveViewing()
    if (backgroundSharing) {
      await refreshBackgroundStatus().catch(() => undefined)
      updateVisibility()
      backgroundPoll = window.setInterval(
        () => void refreshBackgroundStatus().catch(() => undefined),
        1_000,
      )
      locationReadinessPoll = window.setInterval(() => void refreshDeviceLocationReadiness(), 5_000)
      receiverPoll = window.setInterval(
        () => void reconcileReceiverOwnership().catch(() => undefined),
        5_000,
      )
    }
  })().catch((error) => {
    localError.value =
      error instanceof Error ? error.message : 'Protected shares could not be opened.'
  })
})
onBeforeUnmount(() => {
  runtime.setActiveViewing(null)
  void backgroundSharing?.setActiveViewing(null).catch(() => undefined)
  document.removeEventListener('visibilitychange', updateVisibility)
  window.removeEventListener('online', recordConnectivity)
  window.removeEventListener('offline', recordConnectivity)
  window.removeEventListener('keydown', onMenuKeyDown)
  window.removeEventListener('hashchange', handleLocationHashChange)
  navigationTarget?.removeEventListener('navigate', handleLocationNavigation)
  unmounted = true
  stopDeepLinks()
  unsubscribe()
  if (backgroundPoll !== undefined) window.clearInterval(backgroundPoll)
  if (locationReadinessPoll !== undefined) window.clearInterval(locationReadinessPoll)
  if (comparisonClock !== undefined) window.clearInterval(comparisonClock)
  if (receiverPoll !== undefined) window.clearInterval(receiverPoll)
  if (sharedTextPoll !== undefined) window.clearInterval(sharedTextPoll)
  if (copyNoticeTimeout !== undefined) window.clearTimeout(copyNoticeTimeout)
  if (statusNoticeTimeout !== undefined) window.clearTimeout(statusNoticeTimeout)
  void runtime.stop()
})
</script>
