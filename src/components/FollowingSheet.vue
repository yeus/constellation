<template>
  <div class="sheet-backdrop" @click.self="emit('close')">
    <section class="share-sheet" role="dialog" aria-modal="true" aria-labelledby="following-title">
      <header class="sheet-header">
        <div>
          <p class="eyebrow">Locations you view</p>
          <h2 id="following-title">Following</h2>
        </div>
        <button class="icon-button" type="button" aria-label="Close" @click="emit('close')">
          <CloseIcon />
        </button>
      </header>
      <p v-if="visible.length === 0" class="field-help">No shared locations yet.</p>
      <button
        v-if="visible.length > 1"
        class="secondary-action"
        type="button"
        :disabled="viewableIds.length === 0"
        @click="emit('focusAll')"
      >
        Show all on map
      </button>
      <article v-for="follow in visible" :key="follow.shareId" class="follow-item">
        <strong>{{ follow.localName || follow.sourceName || 'Shared location' }}</strong>
        <span
          >{{ follow.connected ? 'Connected' : 'Stale / disconnected' }} ·
          {{ follow.saved ? 'Saved' : 'Preview' }}</span
        >
        <span v-if="follow.sourceName && follow.sourceName !== follow.localName"
          >Sender: {{ follow.sourceName }}</span
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
          {{ follow.expiresAt === null ? 'until stopped' : remaining(follow.expiresAt) }}</span
        >
        <div v-if="editingId === follow.shareId" class="nickname-edit">
          <input
            v-model="nameDraft"
            type="text"
            maxlength="32"
            aria-label="Your nickname"
            @keyup.enter="saveName(follow.shareId)"
            @keyup.esc="editingId = undefined"
          />
          <button class="secondary-action" type="button" @click="saveName(follow.shareId)">
            Save
          </button>
          <button class="secondary-action" type="button" @click="editingId = undefined">
            Cancel
          </button>
        </div>
        <button
          v-else
          class="nickname-button"
          type="button"
          :aria-label="`Edit nickname for ${follow.localName}`"
          @click="editName(follow.shareId, follow.localName)"
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="m4 20 4.2-.8L19 8.4 15.6 5 4.8 15.8 4 20ZM14.4 6.2l3.4 3.4"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          Edit nickname
        </button>
        <div class="follow-item__colors" aria-label="Location color">
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
        <button
          v-if="viewableIds.includes(follow.shareId)"
          class="secondary-action"
          type="button"
          @click="emit('focus', follow.shareId)"
        >
          Show on map
        </button>
        <button class="secondary-action" type="button" @click="emit('stop', follow.shareId)">
          Stop following
        </button>
        <button
          v-if="!follow.saved"
          class="primary-action"
          type="button"
          @click="emit('keep', follow.shareId)"
        >
          Keep following
        </button>
      </article>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import CloseIcon from './icons/CloseIcon.vue'

import { FOLLOW_COLORS, type FollowSummary } from '../sharing/sharingRuntime.ts'

const props = defineProps<{
  following: readonly FollowSummary[]
  viewableIds: readonly string[]
  selectedId?: string
}>()
const emit = defineEmits<{
  close: []
  name: [shareId: string, name: string]
  color: [shareId: string, color: string]
  focus: [shareId: string]
  focusAll: []
  stop: [shareId: string]
  keep: [shareId: string]
}>()
const editingId = ref<string>()
const nameDraft = ref('')
const editName = (shareId: string, name: string): void => {
  editingId.value = shareId
  nameDraft.value = name
}
const saveName = (shareId: string): void => {
  emit('name', shareId, nameDraft.value)
  editingId.value = undefined
}
const visible = computed(() =>
  props.selectedId
    ? props.following.filter((entry) => entry.shareId === props.selectedId)
    : props.following,
)

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
.follow-item {
  display: grid;
  gap: 0.55rem;
  padding: 0.9rem 0;
  border-top: 1px solid var(--border);
}

.follow-item span {
  color: var(--muted);
  font-size: 0.78rem;
}

.nickname-edit {
  display: flex;
  gap: 0.4rem;
}

.nickname-edit input {
  min-width: 0;
  flex: 1;
  min-height: 2.5rem;
  padding: 0 0.7rem;
  border: 1px solid var(--border);
  border-radius: 0.55rem;
  background: var(--control-fill);
  color: var(--text);
}

.nickname-button {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  width: fit-content;
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 0.78rem;
}

.nickname-button svg {
  width: 1rem;
  height: 1rem;
}

.follow-item__colors {
  display: flex;
  gap: 0.55rem;
}

.follow-item__colors button {
  width: 2rem;
  height: 2rem;
  border: 2px solid transparent;
  border-radius: 50%;
  cursor: pointer;
}

.follow-item__colors button[aria-pressed='true'] {
  border-color: var(--text);
}
</style>
