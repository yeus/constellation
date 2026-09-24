<template>
  <div class="sheet-backdrop share-backdrop" @click.self="emit('close')">
    <section
      class="share-sheet share-sheet--create"
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-title"
    >
      <header class="sheet-header">
        <div>
          <p class="eyebrow">New share</p>
          <h2 id="share-title">Share your location</h2>
        </div>
        <button class="icon-button" type="button" aria-label="Close" @click="emit('close')">
          <CloseIcon />
        </button>
      </header>

      <p class="field-help">
        End-to-end encrypted P2P. No central location history; relays cannot read your location.
      </p>

      <label class="share-name">
        Share a name (optional)
        <input
          aria-label="Share a name"
          type="text"
          maxlength="32"
          :value="draft.name"
          placeholder="What should viewers call you?"
          @input="emit('name', ($event.target as HTMLInputElement).value)"
        />
      </label>

      <fieldset>
        <legend>When to share</legend>
        <div class="choice-grid choice-grid--two">
          <button
            type="button"
            class="choice"
            :class="{ 'choice--selected': draft.publication === 'foreground' }"
            :aria-pressed="draft.publication === 'foreground'"
            @click="emit('publication', 'foreground')"
          >
            <strong>While app is open</strong>
            <span>Pause when hidden</span>
          </button>
          <button
            v-if="backgroundAvailable"
            type="button"
            class="choice"
            :class="{ 'choice--selected': draft.publication === 'background' }"
            :aria-pressed="draft.publication === 'background'"
            @click="emit('publication', 'background')"
          >
            <strong>In background</strong>
            <span>Android notification</span>
          </button>
        </div>
      </fieldset>

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
        <p class="field-help">Anyone with the link can view it. Revoke it any time.</p>
      </fieldset>

      <p class="runtime-note">{{ runtimeNote }}</p>
      <button class="primary-action" type="button" :disabled="!canSubmit" @click="emit('submit')">
        Create private link
      </button>
    </section>
  </div>
</template>

<script setup lang="ts">
import CloseIcon from './icons/CloseIcon.vue'
import type {
  LocationPrecision,
  ShareDraft,
  ShareDuration,
  SharePublication,
  ViewerCapacity,
} from '../shareDraft.ts'

defineProps<{
  draft: ShareDraft
  canSubmit: boolean
  runtimeNote?: string
  backgroundAvailable: boolean
}>()

const emit = defineEmits<{
  close: []
  submit: []
  precision: [value: LocationPrecision]
  duration: [value: ShareDuration]
  viewers: [value: ViewerCapacity]
  acknowledge: [value: boolean]
  name: [value: string]
  publication: [value: SharePublication]
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

<style scoped>
.share-name {
  display: grid;
  gap: 0.45rem;
  margin-bottom: 1.3rem;
  font-size: 0.84rem;
  font-weight: 680;
}

.share-name input {
  min-height: 2.8rem;
  padding: 0 0.8rem;
  border: 1px solid var(--border);
  border-radius: 0.65rem;
  background: var(--control-fill);
  color: var(--text);
}
</style>
