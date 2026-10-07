<template>
  <div class="sheet-backdrop" @click.self="emit('close')">
    <section class="share-sheet peer-list" role="dialog" aria-modal="true" :aria-label="dialogName">
      <header class="sheet-header">
        <div>
          <p class="eyebrow">People and location links</p>
          <h2>Peers</h2>
        </div>
        <button class="icon-button" type="button" aria-label="Close" @click="emit('close')">
          <CloseIcon />
        </button>
      </header>

      <div class="peer-list__filters" role="group" aria-label="Filter peers">
        <button
          v-for="option in filters"
          :key="option.value"
          type="button"
          :aria-pressed="filter === option.value"
          @click="emit('filter', option.value)"
        >
          {{ option.label }}
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

      <details v-if="oldShares.length" class="old-shares">
        <summary>Old sharing links ({{ oldShares.length }})</summary>
        <div v-for="share in oldShares" :key="share.shareId" class="peer-history-item">
          <strong>{{ share.name || 'Private link' }}</strong>
          <span
            >{{ share.reason === 'revoked' ? 'Revoked by you' : 'Share expired' }} ·
            {{ new Date(share.endedAt).toLocaleString() }}</span
          >
        </div>
      </details>
      <details v-if="oldFollowing.length" class="old-shares">
        <summary>Old seeing shares ({{ oldFollowing.length }})</summary>
        <div v-for="share in oldFollowing" :key="share.shareId" class="peer-history-item">
          <strong>{{ share.name || 'Shared location' }}</strong>
          <span
            >{{ share.reason === 'revoked' ? 'Revoked by sender' : 'Share expired' }} ·
            {{ new Date(share.endedAt).toLocaleString() }}</span
          >
        </div>
      </details>

      <details
        v-for="peer in peers"
        :key="peer.key"
        class="peer-list__item"
        :open="isPeerExpanded(peer)"
        @toggle="setPeerExpanded(peer, $event)"
      >
        <summary class="peer-list__summary">
          <PeerAvatar :name="peer.name" />
          <span class="peer-list__summary-name">{{ peer.name }}</span>
          <small>
            {{ peer.direction }}
            <template v-if="peer.shares.length"> · {{ peer.shares.length }} connected</template>
          </small>
        </summary>

        <div class="peer-list__details">
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
                ><input v-model="associateNames" type="checkbox" /> Reuse my private nickname across
                reciprocal shares</label
              >
              <p class="field-help">
                Your nickname for them stays private. Name sharing is independent in each direction.
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
                  >{{ connection.viewer.localName || 'Connected peer' }} · seen
                  {{ new Date(connection.viewer.lastSeenAt).toLocaleTimeString() }}</span
                >
                <span class="peer-viewer-details__fingerprint"
                  >Connection {{ connection.viewer.fingerprint }}</span
                >
                <div
                  v-if="
                    editingViewer === `${connection.share.shareId}:${connection.viewer.fingerprint}`
                  "
                  class="peer-viewer-details__edit"
                >
                  <input
                    v-model="nameDraft"
                    type="text"
                    maxlength="32"
                    aria-label="Device name"
                    @keyup.enter="saveName(connection.share.shareId, connection.viewer.fingerprint)"
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
              <button type="button" @click="emit('show', connection.share)">Show link / QR</button>
              <button type="button" @click="emit('revoke', connection.share.shareId)">
                Revoke link
              </button>
            </div>
          </article>

          <article v-for="follow in peer.following" :key="follow.shareId" class="peer-link-item">
            <strong>{{ follow.sourceName || follow.localName || 'Shared location' }}</strong>
            <span>{{ statusLabel(follow.status) }} · {{ follow.saved ? 'Saved' : 'Preview' }}</span>
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
              {{ follow.expiresAt === null ? 'until stopped' : remaining(follow.expiresAt) }}</span
            >
            <button
              v-if="
                !follow.returnPromptSeen &&
                follow.status !== 'approval-pending' &&
                follow.status !== 'denied'
              "
              class="secondary-action"
              type="button"
              :disabled="shareBackBusy"
              :aria-label="`Share approximate location for 1 hour back to ${peer.name}`"
              @click="emit('shareBack', follow.shareId)"
            >
              Share location back
            </button>
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
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { LucidePencilLine as PencilLine } from '@lucide/vue'
import CloseIcon from './icons/CloseIcon.vue'
import PeerAvatar from './PeerAvatar.vue'
import type { PeerNamePreference } from '../sharing/peerNames.ts'
import {
  FOLLOW_COLORS,
  generatedFollowName,
  type FollowSummary,
  type ShareSummary,
} from '../sharing/sharingRuntime.ts'

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
}

const props = defineProps<{
  peerNamePreferences?: readonly PeerNamePreference[]
  shares: readonly ShareSummary[]
  following: readonly FollowSummary[]
  filter: PeerFilter
  viewableIds: readonly string[]
  selectedId?: string
  shareBackBusy: boolean
  oldShares: readonly {
    shareId: string
    name?: string
    endedAt: number
    reason: 'revoked' | 'expired'
  }[]
  oldFollowing: readonly {
    shareId: string
    name?: string
    endedAt: number
    reason: 'revoked' | 'expired'
  }[]
}>()
const emit = defineEmits<{
  close: []
  filter: [filter: PeerFilter]
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
    }
    entries.set(key, created)
    return created
  }

  for (const share of props.shares) {
    const viewers = share.viewers ?? []
    if (viewers.length === 0) {
      getEntry(`share:${share.shareId}`).shares.push({ share })
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

  return [...entries.values()]
    .map((entry) => {
      const localFollowName = entry.following.find(
        (follow) => follow.localName && follow.localName !== generatedFollowName(follow.shareId),
      )?.localName
      entry.name =
        localFollowName ||
        entry.following.find((follow) => follow.sourceName)?.sourceName ||
        entry.shares.find((connection) => connection.viewer?.localName)?.viewer?.localName ||
        entry.shares.find((connection) => connection.viewer?.sourceName)?.viewer?.sourceName ||
        entry.following[0]?.localName ||
        (entry.shares.some((connection) => connection.viewer)
          ? 'Connected peer'
          : 'Waiting for a viewer')
      entry.color = entry.following[0]?.color ?? '#438ec9'
      const sharing = entry.shares.length > 0
      const viewing = entry.following.length > 0
      entry.direction = sharing && viewing ? 'Sharing and viewing' : sharing ? 'Sharing' : 'Viewing'
      return entry
    })
    .filter((entry) => {
      if (props.filter === 'sharing') return entry.shares.length > 0
      if (props.filter === 'viewing') return entry.following.length > 0
      if (props.filter === 'both') return entry.shares.length > 0 && entry.following.length > 0
      return true
    })
    .sort((left, right) => left.name.localeCompare(right.name))
})

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
.peer-list__filters,
.peer-link-item__actions,
.peer-viewer-details__edit {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
}

.peer-list__filters button,
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

.peer-list__filters button[aria-pressed='true'] {
  border-color: var(--accent);
  color: var(--accent);
}

.peer-list__item,
.peer-history-item,
.peer-link-item {
  display: grid;
  gap: 0.45rem;
  padding: 0.8rem 0;
  border-top: 1px solid var(--border);
}

.peer-list__summary {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  min-height: 2.7rem;
  cursor: pointer;
  list-style-position: outside;
}

.peer-list__summary-name {
  flex: 1;
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
  gap: 0.5rem;
  padding-left: 0.9rem;
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
