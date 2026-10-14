<template>
  <div class="sheet-backdrop" @click.self="emit('close')">
    <section
      v-show="!pendingAdoption"
      class="share-sheet peer-list"
      role="dialog"
      aria-modal="true"
      :aria-label="dialogName"
      @scroll.passive="positionFilterOptions"
    >
      <header class="sheet-header peer-list__header">
        <h2>Peers</h2>
        <details
          ref="filterMenu"
          class="peer-list__filter-menu"
          @toggle="positionFilterOptions"
          @keydown.esc.prevent="closeFilterMenu"
        >
          <summary role="button" aria-label="Filter peers" :title="`Filter: ${filter}`">
            <FilterIcon aria-hidden="true" /><span>{{
              filters.find((option) => option.value === filter)?.label
            }}</span>
          </summary>
          <div ref="filterOptions" class="peer-list__filter-options" :style="filterOptionsStyle">
            <strong>Show peers</strong>
            <button
              v-for="option in filters"
              :key="option.value"
              type="button"
              :aria-pressed="filter === option.value"
              @click="selectFilter(option.value)"
            >
              {{ option.label }}
            </button>
            <label class="peer-list__ended-toggle">
              <input v-model="showEnded" type="checkbox" /> Show ended
            </label>
            <button
              type="button"
              :disabled="clearOldBusy || !hasClearableHistory"
              @click="requestClearOld"
            >
              {{ clearOldBusy ? 'Clearing…' : 'Clear old' }}
            </button>
            <small>Clear inactive history. Pending notices stay protected.</small>
          </div>
        </details>
        <button class="icon-button" type="button" aria-label="Close" @click="emit('close')">
          <CloseIcon />
        </button>
      </header>
      <div class="peer-list__create-actions">
        <button class="peer-list__share-action" type="button" @click="emit('shareLocation')">
          <ShareIcon aria-hidden="true" /> Share location
        </button>
        <button class="peer-list__add-action" type="button" @click="emit('addPeer')">
          <AddIcon aria-hidden="true" /> Add peer
        </button>
      </div>
      <p v-if="totalConnectedViewers" class="field-help peer-list__count">
        {{ totalConnectedViewers }} connected across your active links
      </p>

      <p v-if="peers.length === 0" class="field-help">No peers in this list yet.</p>
      <button
        v-if="viewableIds.length > 1 && filter !== 'sharing'"
        class="secondary-action"
        type="button"
        @click="emit('focusAll')"
      >
        Show all on map
      </button>

      <details
        v-for="peer in peers"
        :key="peer.key"
        class="peer-list__item"
        :open="isPeerExpanded(peer)"
        @toggle="setPeerExpanded(peer, $event)"
      >
        <summary class="peer-list__summary">
          <PeerAvatar :name="peer.name" :waiting="peer.waiting" />
          <span class="peer-list__summary-name">{{ peer.name }}</span>
          <small
            >{{ peer.direction }} · {{ peerStatus(peer) }}
            <template v-if="peer.stopped.some(({ dismissed }) => !dismissed)">
              ·
              {{
                new Date(
                  peer.stopped.find(({ dismissed }) => !dismissed)!.recordedAt,
                ).toLocaleString()
              }}
            </template>
          </small>
          <button
            v-if="peer.following.length"
            class="peer-list__map-action"
            type="button"
            :disabled="!peer.following.some((follow) => viewableIds.includes(follow.shareId))"
            :title="
              peer.following.some((follow) => viewableIds.includes(follow.shareId))
                ? 'Show this peer on map'
                : 'No location available to show'
            "
            :aria-label="`Show ${peer.name} on map`"
            @click.stop.prevent="
              emit(
                'focusPeer',
                peer.following.map((follow) => follow.shareId),
              )
            "
          >
            <MapPin aria-hidden="true" />
          </button>
        </summary>

        <div class="peer-list__details">
          <div v-for="stopped in peer.stopped" :key="stopped.eventId" class="peer-history-item">
            <strong>Stopped following</strong>
            <span>Reported {{ new Date(stopped.recordedAt).toLocaleString() }}</span>
            <button
              v-if="!stopped.dismissed"
              type="button"
              class="peer-text-action"
              @click="emit('dismissStopped', stopped.shareId, stopped.peerId)"
            >
              Dismiss
            </button>
          </div>
          <div v-for="ended in peer.ended" :key="ended.key" class="peer-history-item">
            <strong>{{ ended.name }}</strong>
            <span
              >{{ ended.kind === 'sharing' ? 'Shared' : 'Viewed' }} · {{ ended.reason }} ·
              {{ new Date(ended.endedAt).toLocaleString() }}</span
            >
          </div>
          <button
            v-if="peer.peerId && advertisedName(peer) && advertisedName(peer) !== peer.name"
            type="button"
            class="peer-text-action"
            :aria-label="`Review advertised name ${advertisedName(peer)}`"
            @click="pendingAdoption = { peerId: peer.peerId, name: advertisedName(peer)! }"
          >
            Advertised name: {{ advertisedName(peer) }}
          </button>
          <div
            v-for="connection in peer.shares"
            :key="`compact:${connection.share.shareId}`"
            class="peer-list__relationship"
          >
            <div>
              <strong>Sharing with {{ peer.waiting ? 'a new viewer' : peer.name }}</strong>
              <span
                >{{ connection.share.precision }} ·
                {{
                  connection.share.paused
                    ? 'Paused'
                    : connection.viewer
                      ? 'Connected'
                      : 'Waiting for a viewer'
                }}
                ·
                {{
                  connection.share.expiresAt === null
                    ? 'until stopped'
                    : remaining(connection.share.expiresAt) + ' left'
                }}</span
              >
            </div>
            <button class="peer-text-action" type="button" @click="openDetails($event)">
              Manage link
            </button>
          </div>
          <div
            v-for="follow in peer.following"
            :key="`compact:${follow.shareId}`"
            class="peer-list__relationship peer-list__relationship--viewing"
          >
            <div>
              <strong>Viewing {{ peer.name }}</strong>
              <span
                >{{ statusLabel(follow.status) }} ·
                {{
                  follow.lastLocationAt
                    ? elapsed(follow.lastLocationAt) + ' ago'
                    : 'No location yet'
                }}</span
              >
            </div>
            <button
              v-if="follow.status !== 'approval-pending' && follow.status !== 'denied'"
              class="peer-text-action"
              type="button"
              :disabled="shareBackBusy"
              :aria-label="`Share back to ${peer.name}`"
              @click="emit('shareBack', follow.shareId)"
            >
              Share back
            </button>
          </div>
          <details class="peer-list__advanced">
            <summary>Details</summary>
            <div class="peer-list__advanced-content">
              <div v-if="peer.peerId" class="peer-link-item">
                <button
                  v-if="editingProfile !== peer.peerId"
                  class="peer-text-action"
                  type="button"
                  @click="editProfile(peer.peerId)"
                >
                  Name sharing
                </button>
                <template v-else>
                  <label
                    ><input v-model="shareProfileName" type="checkbox" /> Share my name with this
                    peer</label
                  >
                  <input
                    v-if="shareProfileName"
                    v-model="profileNameDraft"
                    aria-label="Your name for this peer"
                    type="text"
                    maxlength="32"
                    placeholder="Your chosen name"
                  />
                  <label
                    ><input v-model="associateNames" type="checkbox" /> Reuse my private nickname
                    across reciprocal shares</label
                  >
                  <p class="field-help">
                    Your nickname for them stays private. Name sharing is independent in each
                    direction.
                  </p>
                  <div class="peer-link-item__actions">
                    <button
                      type="button"
                      :disabled="shareProfileName && !profileNameDraft.trim()"
                      @click="saveProfile(peer.peerId)"
                    >
                      Save name preferences
                    </button>
                    <button type="button" @click="editingProfile = undefined">Cancel</button>
                  </div>
                </template>
              </div>
              <article
                v-for="connection in peer.shares"
                :key="`${connection.share.shareId}:${connection.viewer?.fingerprint ?? 'waiting'}`"
                class="peer-link-item"
              >
                <strong>{{ connection.share.name || 'Private link' }}</strong>
                <span
                  >{{
                    connection.share.precision === 'very-coarse'
                      ? 'very coarse'
                      : connection.share.precision
                  }}
                  · {{ connection.share.publication || 'background' }}
                  <template v-if="connection.share.paused"> · paused</template>
                  ·
                  {{
                    connection.share.expiresAt === null
                      ? 'until stopped'
                      : `until ${new Date(connection.share.expiresAt).toLocaleString()}`
                  }}</span
                >
                <span v-if="!connection.viewer">
                  {{
                    connection.share.viewerCount
                      ? `${connection.share.viewerCount} connected · peer details unavailable`
                      : 'Waiting for a viewer · 0 connected'
                  }}
                </span>
                <details v-else class="peer-viewer-details">
                  <summary>Connected viewers ({{ connection.share.viewerCount }})</summary>
                  <div class="peer-viewer-details__content">
                    <span
                      >{{
                        connection.viewer.displayName ||
                        connection.viewer.localName ||
                        'Connected peer'
                      }}
                      · seen {{ new Date(connection.viewer.lastSeenAt).toLocaleTimeString() }}</span
                    >
                    <span class="peer-viewer-details__fingerprint"
                      >Connection {{ connection.viewer.fingerprint }}</span
                    >
                    <div
                      v-if="
                        editingViewer ===
                        `${connection.share.shareId}:${connection.viewer.fingerprint}`
                      "
                      class="peer-viewer-details__edit"
                    >
                      <input
                        v-model="nameDraft"
                        type="text"
                        maxlength="32"
                        aria-label="Device name"
                        @keyup.enter="
                          saveName(connection.share.shareId, connection.viewer.fingerprint)
                        "
                        @keyup.esc="editingViewer = undefined"
                      />
                      <button
                        type="button"
                        @click="saveName(connection.share.shareId, connection.viewer.fingerprint)"
                      >
                        Save
                      </button>
                    </div>
                    <button
                      v-else
                      class="peer-text-action"
                      type="button"
                      :aria-label="`Edit device name for connection ${connection.viewer.fingerprint}`"
                      @click="
                        editName(
                          connection.share.shareId,
                          connection.viewer.fingerprint,
                          connection.viewer.localName || '',
                        )
                      "
                    >
                      <PencilLine aria-hidden="true" /> Edit name
                    </button>
                    <button
                      class="peer-text-action"
                      type="button"
                      :aria-label="`Block device ${connection.viewer.localName || `Connection ${connection.viewer.fingerprint}`}`"
                      @click="
                        emit('viewerBlock', connection.share.shareId, connection.viewer.fingerprint)
                      "
                    >
                      Block device
                    </button>
                  </div>
                </details>
                <div class="peer-link-item__actions">
                  <button type="button" @click="emit('show', connection.share)">
                    Show link / QR
                  </button>
                  <button type="button" @click="emit('revoke', connection.share.shareId)">
                    Revoke link
                  </button>
                </div>
              </article>

              <article
                v-for="follow in peer.following"
                :key="follow.shareId"
                class="peer-link-item"
              >
                <strong>{{ follow.displayName || follow.localName || 'Shared location' }}</strong>
                <span
                  >{{ statusLabel(follow.status) }} · {{ follow.saved ? 'Saved' : 'Preview' }}</span
                >
                <span
                  >Last location:
                  {{
                    follow.lastLocationAt
                      ? `${new Date(follow.lastLocationAt).toLocaleString()} · ${elapsed(follow.lastLocationAt)} ago`
                      : 'not received'
                  }}
                  · Updates this session: {{ follow.updatesReceived }}</span
                >
                <span
                  >Following since:
                  {{
                    follow.followedAt
                      ? `${new Date(follow.followedAt).toLocaleString()} · ${elapsed(follow.followedAt)} ago`
                      : 'unknown'
                  }}
                  · Time left:
                  {{
                    follow.expiresAt === null ? 'until stopped' : remaining(follow.expiresAt)
                  }}</span
                >
                <div v-if="editingFollow === follow.shareId" class="peer-viewer-details__edit">
                  <input
                    v-model="nameDraft"
                    type="text"
                    maxlength="32"
                    aria-label="Your nickname"
                    @keyup.enter="saveFollowName(follow.shareId)"
                    @keyup.esc="editingFollow = undefined"
                  />
                  <button type="button" @click="saveFollowName(follow.shareId)">Save</button>
                  <button type="button" @click="editingFollow = undefined">Cancel</button>
                </div>
                <button
                  v-else
                  class="peer-text-action"
                  type="button"
                  :aria-label="`Edit nickname for ${peer.name}`"
                  @click="editFollowName(follow.shareId, follow.localName)"
                >
                  <PencilLine aria-hidden="true" /> Edit nickname
                </button>
                <div class="peer-link-item__colors" aria-label="Location color">
                  <button
                    v-for="color in FOLLOW_COLORS"
                    :key="color"
                    type="button"
                    :style="{ backgroundColor: color }"
                    :aria-label="`Use ${color} color`"
                    :aria-pressed="follow.color === color"
                    @click="emit('color', follow.shareId, color)"
                  />
                </div>
                <div class="peer-link-item__actions">
                  <button
                    v-if="viewableIds.includes(follow.shareId)"
                    type="button"
                    @click="emit('focus', follow.shareId)"
                  >
                    Show on map
                  </button>
                  <button type="button" @click="emit('unfollow', follow.shareId)">
                    Stop following
                  </button>
                  <button v-if="!follow.saved" type="button" @click="emit('keep', follow.shareId)">
                    Keep following
                  </button>
                </div>
              </article>
            </div>
          </details>
        </div>
      </details>
    </section>
    <section
      v-if="pendingAdoption"
      class="share-sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Adopt advertised name"
      @keydown.esc="pendingAdoption = undefined"
    >
      <header class="sheet-header">
        <h2>Use {{ pendingAdoption.name }}?</h2>
        <button
          type="button"
          class="icon-button"
          aria-label="Close name confirmation"
          @click="pendingAdoption = undefined"
        >
          <CloseIcon />
        </button>
      </header>
      <p>
        This peer advertises this name. Adopting it changes your local display name and initials.
      </p>
      <button type="button" class="primary-action" @click="adoptAdvertisedName">Adopt name</button>
      <button type="button" class="secondary-action" @click="pendingAdoption = undefined">
        Keep current name
      </button>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  LucideMapPin as MapPin,
  LucidePencilLine as PencilLine,
  LucideFunnel as FilterIcon,
  LucideShare2 as ShareIcon,
  LucideUserPlus as AddIcon,
} from '@lucide/vue'
import CloseIcon from './icons/CloseIcon.vue'
import PeerAvatar from './PeerAvatar.vue'
import { advertisedPeerName, type PeerNamePreference } from '../sharing/peerNames.ts'
import { canClearPeerRecord, protectActivePeerHistory } from '../sharing/peerHistory.ts'
import type { StoppedViewerRecord } from '../sharing/privateStore.ts'
import { FOLLOW_COLORS, type FollowSummary, type ShareSummary } from '../sharing/sharingRuntime.ts'

type PeerFilter = 'all' | 'sharing' | 'viewing' | 'both'
type PeerLink = { share: ShareSummary; viewer?: NonNullable<ShareSummary['viewers']>[number] }
type PeerEntry = {
  key: string
  peerId?: string
  shares: PeerLink[]
  following: FollowSummary[]
  name: string
  color: string
  direction: string
  waiting: boolean
  stopped: StoppedViewerRecord[]
  ended: {
    key: string
    kind: 'sharing' | 'viewing'
    name: string
    endedAt: number
    reason: string
  }[]
}

const props = defineProps<{
  peerNamePreferences?: readonly PeerNamePreference[]
  shares: readonly ShareSummary[]
  following: readonly FollowSummary[]
  filter: PeerFilter
  viewableIds: readonly string[]
  limitedIds?: readonly string[]
  selectedId?: string
  clearOldBusy?: boolean
  shareBackBusy: boolean
  stoppedViewers: readonly StoppedViewerRecord[]
  oldShares: readonly {
    shareId: string
    peerId?: string
    name?: string
    endedAt: number
    reason: 'revoked' | 'expired'
  }[]
  oldFollowing: readonly {
    shareId: string
    peerId?: string
    name?: string
    endedAt: number
    reason: 'revoked' | 'expired'
  }[]
}>()
const emit = defineEmits<{
  clearOld: []
  close: []
  addPeer: []
  shareLocation: []
  focusPeer: [shareIds: string[]]
  filter: [filter: PeerFilter]
  dismissStopped: [shareId: string, peerId: string]
  show: [share: ShareSummary]
  revoke: [shareId: string]
  viewerName: [shareId: string, fingerprint: string, name: string]
  viewerBlock: [shareId: string, fingerprint: string]
  name: [shareId: string, name: string]
  color: [shareId: string, color: string]
  focus: [shareId: string]
  focusAll: []
  unfollow: [shareId: string]
  keep: [shareId: string]
  shareBack: [shareId: string]
  adoptName: [peerId: string, name: string]
  profile: [peerId: string, associateNames: boolean, sharedName: string | null]
}>()
const filters: readonly { value: PeerFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'sharing', label: 'Sharing' },
  { value: 'viewing', label: 'Viewing' },
  { value: 'both', label: 'Both' },
]
const dialogName = computed(() =>
  props.filter === 'sharing' ? 'Active shares' : props.filter === 'viewing' ? 'Following' : 'Peers',
)
const filterMenu = ref<HTMLDetailsElement>()
const filterOptions = ref<HTMLElement>()
const filterOptionsStyle = ref<Record<string, string>>({})
const positionFilterOptions = (): void => {
  const menu = filterMenu.value
  const summary = menu?.querySelector('summary')
  const options = filterOptions.value
  if (!menu?.open || !summary || !options) return
  const button = summary.getBoundingClientRect()
  const margin = 8
  const width =
    options.getBoundingClientRect().width || Math.min(240, window.innerWidth - margin * 2)
  const height = options.scrollHeight
  const left = Math.min(
    Math.max(margin, button.right - width),
    Math.max(margin, window.innerWidth - width - margin),
  )
  const spaceBelow = window.innerHeight - button.bottom - margin
  const spaceAbove = button.top - margin
  const openAbove = spaceBelow < height && spaceAbove > spaceBelow
  filterOptionsStyle.value = openAbove
    ? {
        left: `${left}px`,
        top: 'auto',
        bottom: `${window.innerHeight - button.top + margin}px`,
        maxHeight: `${Math.max(0, spaceAbove)}px`,
      }
    : {
        left: `${left}px`,
        top: `${button.bottom + margin}px`,
        bottom: 'auto',
        maxHeight: `${Math.max(0, spaceBelow)}px`,
      }
}
let filterAnchorObserver: ResizeObserver | undefined
const observeFilterAnchor = (): void => {
  const dialog = filterMenu.value?.closest('.peer-list')
  if (!dialog || filterAnchorObserver || typeof ResizeObserver === 'undefined') return
  filterAnchorObserver = new ResizeObserver(positionFilterOptions)
  filterAnchorObserver.observe(dialog)
}
onMounted(() => {
  window.addEventListener('resize', positionFilterOptions)
  observeFilterAnchor()
})
onUnmounted(() => {
  window.removeEventListener('resize', positionFilterOptions)
  filterAnchorObserver?.disconnect()
})
const closeFilterMenu = (): void => {
  if (!filterMenu.value) return
  filterMenu.value.open = false
  filterMenu.value.querySelector('summary')?.focus()
}
const requestClearOld = (): void => {
  emit('clearOld')
  closeFilterMenu()
}
const selectFilter = (filter: PeerFilter): void => {
  emit('filter', filter)
  closeFilterMenu()
}
const hasClearableHistory = computed(() => {
  const protection = protectActivePeerHistory(props.shares, props.following)
  return [...props.oldShares, ...props.oldFollowing, ...props.stoppedViewers].some((record) =>
    canClearPeerRecord(record, protection),
  )
})
const openDetails = (event: Event): void => {
  const target = event.currentTarget
  if (!(target instanceof HTMLElement)) return
  const details = target
    .closest('.peer-list__item')
    ?.querySelector<HTMLDetailsElement>('.peer-list__advanced')
  if (details) {
    details.open = true
    details.querySelector('summary')?.focus()
  }
}
const showEnded = ref(false)
const totalConnectedViewers = computed(() =>
  props.shares.reduce((count, share) => count + share.viewerCount, 0),
)
const peers = computed(() => {
  const entries = new Map<string, PeerEntry>()
  const getEntry = (key: string, peerId?: string): PeerEntry => {
    const existing = entries.get(key)
    if (existing) return existing
    const created: PeerEntry = {
      key,
      peerId,
      shares: [],
      following: [],
      name: 'Unknown peer',
      color: '#438ec9',
      direction: '',
      waiting: false,
      stopped: [],
      ended: [],
    }
    entries.set(key, created)
    return created
  }

  for (const share of props.shares) {
    const viewers = share.viewers ?? []
    if (viewers.length === 0) {
      getEntry(
        share.recipientPeerId ? `peer:${share.recipientPeerId}` : `share:${share.shareId}`,
        share.recipientPeerId,
      ).shares.push({ share })
      continue
    }
    for (const viewer of viewers) {
      const key = viewer.peerId
        ? `peer:${viewer.peerId}`
        : `connection:${share.shareId}:${viewer.fingerprint}`
      getEntry(key, viewer.peerId).shares.push({ share, viewer })
    }
  }
  for (const follow of props.following) {
    const key = follow.peerId ? `peer:${follow.peerId}` : `follow:${follow.shareId}`
    getEntry(key, follow.peerId).following.push(follow)
  }

  for (const ended of props.oldShares) {
    getEntry(
      ended.peerId ? `peer:${ended.peerId}` : `share:${ended.shareId}`,
      ended.peerId,
    ).ended.push({
      key: `share:${ended.shareId}:${ended.peerId ?? 'link'}`,
      kind: 'sharing',
      name: ended.name || 'Private link',
      endedAt: ended.endedAt,
      reason: ended.reason,
    })
  }
  for (const ended of props.oldFollowing) {
    getEntry(
      ended.peerId ? `peer:${ended.peerId}` : `follow:${ended.shareId}`,
      ended.peerId,
    ).ended.push({
      key: `follow:${ended.shareId}`,
      kind: 'viewing',
      name: ended.name || 'Shared location',
      endedAt: ended.endedAt,
      reason: ended.reason,
    })
  }

  for (const record of props.stoppedViewers) {
    getEntry(`peer:${record.peerId}`, record.peerId).stopped.push(record)
  }

  return [...entries.values()]
    .map((entry) => {
      const peerPreference = props.peerNamePreferences?.find(
        ({ peerId }) => peerId === entry.peerId,
      )
      entry.name =
        entry.following[0]?.displayName ||
        entry.following[0]?.localName ||
        entry.shares.find((connection) => connection.viewer?.displayName)?.viewer?.displayName ||
        entry.shares.find((connection) => connection.viewer?.localName)?.viewer?.localName ||
        peerPreference?.nickname ||
        peerPreference?.acceptedName ||
        entry.shares.find((connection) => connection.viewer?.sourceName)?.viewer?.sourceName ||
        (entry.shares.some((connection) => connection.viewer)
          ? 'Connected peer'
          : entry.peerId
            ? entry.stopped.length
              ? 'Stopped sharing'
              : entry.shares.length
                ? 'Known peer'
                : 'Former peer'
            : entry.ended[0]?.name || 'Waiting for a viewer')
      entry.waiting =
        entry.shares.length > 0 &&
        entry.shares.every(({ viewer }) => !viewer) &&
        !entry.following.length
      entry.color = entry.following[0]?.color ?? '#438ec9'
      const sharing = entry.shares.length > 0
      const viewing = entry.following.length > 0
      entry.direction =
        sharing && viewing
          ? 'Sharing and viewing'
          : sharing
            ? 'Sharing'
            : viewing
              ? 'Viewing'
              : entry.stopped.length
                ? 'Stopped following'
                : 'Ended'
      return entry
    })
    .filter((entry) => {
      if (
        props.limitedIds &&
        !entry.following.some(({ shareId }) => props.limitedIds?.includes(shareId))
      )
        return false
      if (
        !showEnded.value &&
        !entry.shares.length &&
        !entry.following.length &&
        !entry.stopped.some(({ dismissed }) => !dismissed)
      )
        return false
      if (props.filter === 'sharing')
        return (
          entry.stopped.some(({ dismissed }) => !dismissed) ||
          (showEnded.value && entry.stopped.length > 0) ||
          entry.shares.length > 0 ||
          (showEnded.value && entry.ended.some(({ kind }) => kind === 'sharing'))
        )
      if (props.filter === 'viewing')
        return (
          entry.following.length > 0 ||
          (showEnded.value && entry.ended.some(({ kind }) => kind === 'viewing'))
        )
      if (props.filter === 'both') {
        const sharing =
          entry.shares.length > 0 ||
          (showEnded.value && entry.ended.some(({ kind }) => kind === 'sharing'))
        const viewing =
          entry.following.length > 0 ||
          (showEnded.value && entry.ended.some(({ kind }) => kind === 'viewing'))
        return sharing && viewing
      }
      return true
    })
    .sort((left, right) => left.name.localeCompare(right.name))
})

const pendingAdoption = ref<{ peerId: string; name: string }>()
const advertisedName = (peer: PeerEntry): string | undefined =>
  advertisedPeerName(
    props.peerNamePreferences?.find((preference) => preference.peerId === peer.peerId),
    peer.following.find((follow) => follow.sourceName)?.sourceName,
  )
const adoptAdvertisedName = (): void => {
  const adoption = pendingAdoption.value
  if (!adoption) return
  emit('adoptName', adoption.peerId, adoption.name)
  pendingAdoption.value = undefined
}

const peerStatus = (peer: PeerEntry): string => {
  if (peer.waiting) return 'Waiting'
  if (peer.following.some(({ status }) => status === 'live')) return 'Live'
  if (peer.following.some(({ status }) => status === 'delayed')) return 'Delayed'
  if (peer.following.some(({ status }) => status === 'stale')) return 'Stale'
  if (peer.shares.some(({ viewer }) => viewer)) return 'Connected'
  return peer.stopped.some(({ dismissed }) => !dismissed)
    ? 'Stopped following'
    : (peer.following[0]?.status ?? 'Ended')
}
const expandedRelationshipIds = ref<ReadonlySet<string>>(new Set())
const collapsedSelectedFollowIds = ref<ReadonlySet<string>>(new Set())
const relationshipIds = (peer: PeerEntry): readonly string[] => [
  ...peer.shares.map(({ share }) => `share:${share.shareId}`),
  ...peer.following.map((follow) => `follow:${follow.shareId}`),
]
const isSelectedPeer = (peer: PeerEntry): boolean =>
  peer.following.some((follow) => follow.shareId === props.selectedId)
const isPeerExpanded = (peer: PeerEntry): boolean => {
  const ids = relationshipIds(peer)
  return (
    ids.some((id) => expandedRelationshipIds.value.has(id)) ||
    peer.stopped.some(({ dismissed }) => !dismissed) ||
    (isSelectedPeer(peer) && !collapsedSelectedFollowIds.value.has(`follow:${props.selectedId}`))
  )
}
const setPeerExpanded = (peer: PeerEntry, event: Event): void => {
  const element = event.currentTarget
  if (!(element instanceof HTMLDetailsElement)) return

  const ids = relationshipIds(peer)
  const expanded = new Set(expandedRelationshipIds.value)
  const collapsedSelected = new Set(collapsedSelectedFollowIds.value)
  const selectedId = props.selectedId ? `follow:${props.selectedId}` : undefined
  if (element.open) {
    ids.forEach((id) => expanded.add(id))
    if (selectedId) collapsedSelected.delete(selectedId)
  } else {
    ids.forEach((id) => expanded.delete(id))
    if (isSelectedPeer(peer) && selectedId) collapsedSelected.add(selectedId)
  }
  expandedRelationshipIds.value = expanded
  collapsedSelectedFollowIds.value = collapsedSelected
}

const editingViewer = ref<string>()
const editingProfile = ref<string>()
const profileNameDraft = ref('')
const shareProfileName = ref(false)
const associateNames = ref(false)
const editProfile = (peerId: string): void => {
  const preference = props.peerNamePreferences?.find((record) => record.peerId === peerId)
  profileNameDraft.value = preference?.sharedName ?? ''
  shareProfileName.value = Boolean(preference?.sharedName)
  associateNames.value = preference?.associateNames ?? false
  editingProfile.value = peerId
}
const saveProfile = (peerId: string): void => {
  emit(
    'profile',
    peerId,
    associateNames.value,
    shareProfileName.value ? profileNameDraft.value.trim() : null,
  )
  editingProfile.value = undefined
}
const editingFollow = ref<string>()
const nameDraft = ref('')
const editName = (shareId: string, fingerprint: string, name: string): void => {
  editingViewer.value = `${shareId}:${fingerprint}`
  nameDraft.value = name
}
const saveName = (shareId: string, fingerprint: string): void => {
  emit('viewerName', shareId, fingerprint, nameDraft.value)
  editingViewer.value = undefined
}
const editFollowName = (shareId: string, name: string): void => {
  editingFollow.value = shareId
  nameDraft.value = name
}
const saveFollowName = (shareId: string): void => {
  emit('name', shareId, nameDraft.value)
  editingFollow.value = undefined
}
const statusLabel = (status: FollowSummary['status']): string =>
  ({
    live: 'Live',
    delayed: 'Delayed',
    stale: 'Stale',
    expired: 'Expired',
    revoked: 'Revoked',
    unavailable: 'Unavailable',
    'approval-pending': 'Waiting for sender approval',
    denied: 'Access not approved',
  })[status]
const elapsed = (timestamp: number): string => {
  const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60_000)
  if (minutes < 1) return 'less than a minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`
}
const remaining = (timestamp: number): string => {
  const minutes = Math.ceil((timestamp - Date.now()) / 60_000)
  if (minutes <= 0) return 'Expired'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return hours < 24
    ? `${hours} h ${minutes % 60} min`
    : `${Math.floor(hours / 24)} d ${hours % 24} h`
}
</script>

<style scoped>
.peer-list__header {
  position: relative;
  justify-content: flex-start;
  gap: 0.5rem;
}
.peer-list__header h2 {
  margin: 0;
  flex: 1;
  font-size: 1rem;
}
.peer-list__header .icon-button {
  position: static;
}
.peer-list__create-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}
.peer-list__create-actions button,
.peer-list__map-action {
  min-height: 2.5rem;
  border: 1px solid var(--border);
  border-radius: 0.65rem;
  background: var(--control-fill);
  color: var(--text);
  cursor: pointer;
}
.peer-list__create-actions button {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 0.4rem;
  font-weight: 650;
  font-size: 0.85rem;
  padding: 0.6rem 0.35rem;
}
.peer-list__create-actions .peer-list__share-action {
  background: var(--accent);
  color: #182231;
  border-color: var(--accent);
}
.peer-list__create-actions .peer-list__add-action {
  background: #2a3548;
  color: #f6f8fc;
  border-color: #58677f;
}
.peer-list__create-actions svg,
.peer-list__filter-menu svg {
  width: 1.1rem;
  height: 1.1rem;
}
.peer-list__filter-menu {
  position: relative;
}
.peer-list__filter-menu > summary {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.3rem;
  padding: 0 0.5rem;
  height: 2.5rem;
  cursor: pointer;
  list-style: none;
  border: 1px solid var(--border);
  border-radius: 0.65rem;
  background: var(--control-fill);
}
.peer-list__filter-menu > summary::-webkit-details-marker {
  display: none;
}
.peer-list__filter-options {
  position: fixed;
  z-index: 20;
  display: grid;
  gap: 0.4rem;
  width: min(15rem, 70vw);
  max-height: calc(100dvh - 1rem);
  overflow-y: auto;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  background: var(--surface-strong);
  box-shadow: 0 0.4rem 1.5rem #0003;
}
.peer-list__filter-options button {
  min-height: 2.5rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--control-fill);
  color: var(--text);
  cursor: pointer;
}
.peer-list__filter-options button[aria-pressed='true'] {
  border-color: var(--accent);
  color: var(--accent);
}
.peer-list__filter-options small {
  color: var(--muted);
  font-size: 0.75rem;
}
.peer-list__relationship {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.6rem 0.65rem;
  border-left: 2px solid var(--accent);
  background: var(--control-fill);
  border-radius: 0.35rem;
}
.peer-list__relationship--viewing {
  border-left-color: #438ec9;
}
.peer-list__relationship > div {
  display: grid;
  gap: 0.2rem;
}
.peer-list__relationship strong {
  font-size: 0.85rem;
}
.peer-list__relationship span {
  color: var(--muted);
  font-size: 0.75rem;
}
.peer-list__relationship button {
  flex-shrink: 0;
  color: var(--text);
}
.peer-list__advanced > summary {
  cursor: pointer;
  font-size: 0.85rem;
  padding: 0.6rem 0;
  color: var(--muted);
}
.peer-list__advanced-content {
  display: grid;
  gap: 0.3rem;
}
.peer-list__ended-toggle {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.8rem;
  color: var(--muted);
}
.peer-list__map-action {
  display: grid;
  width: 2.5rem;
  flex: 0 0 auto;
  place-items: center;
}
.peer-list__map-action svg {
  width: 1.1rem;
  height: 1.1rem;
}
.peer-list__map-action:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.peer-link-item__actions,
.peer-viewer-details__edit {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
}

.peer-link-item__actions button,
.peer-viewer-details__edit button {
  min-height: 2.2rem;
  padding: 0 0.65rem;
  border: 1px solid var(--border);
  border-radius: 0.55rem;
  background: var(--control-fill);
  color: var(--text);
  cursor: pointer;
}

.peer-list__item,
.peer-history-item,
.peer-link-item {
  display: grid;
  gap: 0.25rem;
  padding: 0.5rem 0;
  border-top: 1px solid var(--border);
}

.peer-list__summary {
  display: grid;
  grid-template-columns: 2.4rem minmax(0, 1fr) auto;
  grid-template-areas: 'avatar name map' 'avatar status map';
  align-items: center;
  column-gap: 0.7rem;
  row-gap: 0.15rem;
  min-height: 2.7rem;
  cursor: pointer;
  list-style-position: outside;
}

.peer-list__summary > .peer-avatar {
  grid-area: avatar;
}
.peer-list__summary > small {
  grid-area: status;
}
.peer-list__summary > .peer-list__map-action {
  grid-area: map;
}
.peer-list__summary-name {
  grid-area: name;
  overflow-wrap: anywhere;
  font-weight: 650;
}

.peer-list__summary small,
.peer-link-item span,
.peer-history-item span,
.peer-viewer-details {
  color: var(--muted);
  font-size: 0.78rem;
}

.peer-list__details,
.peer-viewer-details__content {
  display: grid;
  gap: 0.3rem;
  padding-left: 0.5rem;
}

.peer-viewer-details summary {
  cursor: pointer;
}

.peer-viewer-details__fingerprint {
  opacity: 0.75;
}

.peer-viewer-details__edit input {
  min-width: 0;
  max-width: 10rem;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  background: var(--control-fill);
  color: var(--text);
}

.peer-text-action {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  width: fit-content;
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.peer-text-action svg {
  width: 0.9rem;
  height: 0.9rem;
}

.peer-link-item__colors {
  display: flex;
  gap: 0.35rem;
}

.peer-link-item__colors button {
  width: 1.5rem;
  height: 1.5rem;
  border: 2px solid transparent;
  border-radius: 50%;
  cursor: pointer;
}

.peer-link-item__colors button[aria-pressed='true'] {
  border-color: var(--text);
}
</style>
