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
          >{{ follow.connected ? 'Connected' : 'Disconnected / stale' }} ·
          {{ follow.saved ? 'Saved' : 'Preview only' }}</span
        >
        <span v-if="follow.sourceName">Shared name: {{ follow.sourceName }}</span>
        <label>
          Your nickname
          <input
            type="text"
            maxlength="32"
            :value="follow.localName"
            @input="emit('name', follow.shareId, ($event.target as HTMLInputElement).value)"
          />
        </label>
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
          class="secondary-action"
          type="button"
          :disabled="!viewableIds.includes(follow.shareId)"
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
import { computed } from 'vue'
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
const visible = computed(() =>
  props.selectedId
    ? props.following.filter((entry) => entry.shareId === props.selectedId)
    : props.following,
)
</script>

<style scoped>
.follow-item {
  display: grid;
  gap: 0.55rem;
  padding: 0.9rem 0;
  border-top: 1px solid var(--border);
}

.follow-item span,
.follow-item label {
  color: var(--muted);
  font-size: 0.78rem;
}

.follow-item label {
  display: grid;
  gap: 0.35rem;
}

.follow-item input {
  min-height: 2.5rem;
  padding: 0 0.7rem;
  border: 1px solid var(--border);
  border-radius: 0.55rem;
  background: var(--control-fill);
  color: var(--text);
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
