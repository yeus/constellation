<template>
  <div class="sheet-backdrop" @click.self="emit('close')">
    <section class="share-sheet" role="dialog" aria-modal="true" aria-labelledby="share-title">
      <header class="sheet-header">
        <div>
          <p class="eyebrow">New share</p>
          <h2 id="share-title">Share your location</h2>
        </div>
        <button class="icon-button" type="button" aria-label="Close" @click="emit('close')">
          ×
        </button>
      </header>

      <fieldset>
        <legend>Precision</legend>
        <div class="choice-grid choice-grid--two">
          <button
            type="button"
            class="choice"
            :class="{ 'choice--selected': draft.precision === 'approximate' }"
            :aria-pressed="draft.precision === 'approximate'"
            @click="emit('precision', 'approximate')"
          >
            <strong>Approximate</strong>
            <span>Neighborhood area</span>
          </button>
          <button
            type="button"
            class="choice"
            :class="{ 'choice--selected': draft.precision === 'exact' }"
            :aria-pressed="draft.precision === 'exact'"
            @click="emit('precision', 'exact')"
          >
            <strong>Exact</strong>
            <span>Precise position</span>
          </button>
        </div>
      </fieldset>

      <fieldset>
        <legend>Duration</legend>
        <div class="choice-grid choice-grid--three">
          <button
            v-for="option in durationOptions"
            :key="option.value"
            type="button"
            class="choice choice--compact"
            :class="{ 'choice--selected': draft.duration === option.value }"
            :aria-pressed="draft.duration === option.value"
            @click="emit('duration', option.value)"
          >
            <strong>{{ option.label }}</strong>
          </button>
        </div>
      </fieldset>

      <label v-if="draft.duration === 'until-revoked'" class="warning">
        <input
          type="checkbox"
          :checked="draft.untilRevokedAcknowledged"
          @change="emit('acknowledge', ($event.target as HTMLInputElement).checked)"
        />
        <span>I understand this link stays active until I stop it.</span>
      </label>

      <fieldset>
        <legend>Viewers</legend>
        <div class="viewer-options">
          <button
            v-for="option in viewerOptions"
            :key="option.label"
            type="button"
            class="viewer-option"
            :class="{
              'viewer-option--selected': draft.viewerCapacity === option.value,
            }"
            :aria-pressed="draft.viewerCapacity === option.value"
            @click="emit('viewers', option.value)"
          >
            {{ option.label }}
          </button>
        </div>
        <p class="field-help">The link can be revoked for everyone or for one active session.</p>
      </fieldset>

      <button class="primary-action" type="button" :disabled="!canSubmit" @click="emit('submit')">
        Create private link
      </button>
      <p class="runtime-note">{{ runtimeNote }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import type { LocationPrecision, ShareDraft, ShareDuration, ViewerCapacity } from '../shareDraft.ts'

defineProps<{
  draft: ShareDraft
  canSubmit: boolean
  runtimeNote?: string
}>()

const emit = defineEmits<{
  close: []
  submit: []
  precision: [value: LocationPrecision]
  duration: [value: ShareDuration]
  viewers: [value: ViewerCapacity]
  acknowledge: [value: boolean]
}>()

const durationOptions: readonly { label: string; value: ShareDuration }[] = [
  { label: '1 hour', value: '1h' },
  { label: '8 hours', value: '8h' },
  { label: 'Until stopped', value: 'until-revoked' },
]

const viewerOptions: readonly { label: string; value: ViewerCapacity }[] = [
  { label: '1', value: 1 },
  { label: '10', value: 10 },
  { label: '50', value: 50 },
  { label: 'No share cap', value: 'unlimited' },
]
</script>
