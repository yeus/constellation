<template>
  <div class="sheet-backdrop share-backdrop" @click.self="emit('close')">
    <section
      v-show="!privacyOpen"
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

      <p v-if="returnRecipientName" class="field-help">
        Sharing back to {{ returnRecipientName }}. Only this sender receives the private offer.
      </p>
      <div class="share-name">
        <label for="share-name-input">Share a name (optional)</label>
        <div class="share-name__input">
          <input
            id="share-name-input"
            aria-label="Share a name"
            type="text"
            maxlength="32"
            :value="draft.name"
            placeholder="What should viewers call you?"
            @input="emit('name', ($event.target as HTMLInputElement).value)"
          />
          <button
            type="button"
            class="icon-button"
            aria-label="Generate another name"
            title="Generate another name"
            @click="emit('regenerateName')"
          >
            <Dices aria-hidden="true" />
          </button>
        </div>
      </div>
      <p class="field-help">
        Fresh suggestion for this share. Edit it, or clear it to share no name.
      </p>

      <fieldset>
        <legend>Precision</legend>
        <div class="choice-grid choice-grid--three">
          <button
            type="button"
            class="choice"
            :class="{ 'choice--selected': draft.precision === 'approximate' }"
            :aria-pressed="draft.precision === 'approximate'"
            @click="emit('precision', 'approximate')"
          >
            <RadiusIcon aria-hidden="true" /><strong>Approximate</strong>
            <span>1 km radius</span>
          </button>
          <button
            type="button"
            class="choice"
            :class="{ 'choice--selected': draft.precision === 'very-coarse' }"
            :aria-pressed="draft.precision === 'very-coarse'"
            @click="emit('precision', 'very-coarse')"
          >
            <AreaIcon aria-hidden="true" /><strong>Very coarse</strong>
            <span>{{ VERY_COARSE_RADIUS_METERS / 1_000 }} km radius</span>
          </button>
          <button
            type="button"
            class="choice"
            :class="{ 'choice--selected': draft.precision === 'exact' }"
            :aria-pressed="draft.precision === 'exact'"
            @click="emit('precision', 'exact')"
          >
            <LocateIcon aria-hidden="true" /><strong>Device accuracy</strong>
            <span>No added blurring</span>
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
            <component
              :is="option.value === 'until-revoked' ? InfinityIcon : ClockIcon"
              aria-hidden="true"
            /><strong>{{ option.label }}</strong>
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

      <fieldset v-if="!returnRecipientName">
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
            <component
              :is="
                option.value === 1
                  ? PersonIcon
                  : option.value === 'unlimited'
                    ? InfinityIcon
                    : GroupIcon
              "
              aria-hidden="true"
            />{{ option.label }}
          </button>
        </div>
        <p class="field-help">Viewers see you, not each other. Return shares come only to you.</p>
        <label v-if="draft.viewerCapacity === 1" class="warning">
          <input
            type="checkbox"
            :checked="draft.requireViewerApproval !== false"
            @change="emit('requireViewerApproval', ($event.target as HTMLInputElement).checked)"
          />
          <span
            >Approve the recipient device before sharing (recommended). Without approval, the first
            device using this link permanently claims it.</span
          >
        </label>
      </fieldset>

      <p class="runtime-note">{{ runtimeNote }}</p>
      <button class="primary-action" type="button" :disabled="!canSubmit" @click="emit('submit')">
        Create location link
      </button>
      <p class="share-privacy-caption">
        <LockIcon aria-hidden="true" /> End-to-end encrypted. No central location storage.
      </p>
      <button
        ref="privacyButton"
        class="share-privacy-info"
        type="button"
        @click="privacyOpen = true"
      >
        More info
      </button>
    </section>
    <SharingPrivacyDialog v-if="privacyOpen" @close="closePrivacy" />
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick } from 'vue'
import {
  LucideDices as Dices,
  LucideRadius as RadiusIcon,
  LucideCircleDashed as AreaIcon,
  LucideLocateFixed as LocateIcon,
  LucideClock as ClockIcon,
  LucideInfinity as InfinityIcon,
  LucideUserRound as PersonIcon,
  LucideUsersRound as GroupIcon,
  LucideLockKeyhole as LockIcon,
} from '@lucide/vue'
import SharingPrivacyDialog from './SharingPrivacyDialog.vue'
import CloseIcon from './icons/CloseIcon.vue'
import type { LocationPrecision, ShareDraft, ShareDuration, ViewerCapacity } from '../shareDraft.ts'
import { VERY_COARSE_RADIUS_METERS } from '../shareDraft.ts'

defineProps<{
  draft: ShareDraft
  canSubmit: boolean
  runtimeNote?: string
  returnRecipientName?: string
}>()

const emit = defineEmits<{
  close: []
  submit: []
  precision: [value: LocationPrecision]
  duration: [value: ShareDuration]
  viewers: [value: ViewerCapacity]
  requireViewerApproval: [value: boolean]
  acknowledge: [value: boolean]
  name: [value: string]
  regenerateName: []
}>()

const privacyOpen = ref(false)
const privacyButton = ref<HTMLButtonElement>()
const closePrivacy = async (): Promise<void> => {
  privacyOpen.value = false
  await nextTick()
  privacyButton.value?.focus()
}

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

.share-name__input {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.share-name input {
  flex: 1;
  min-width: 0;
  min-height: 2.8rem;
  padding: 0 0.8rem;
  border: 1px solid var(--border);
  border-radius: 0.65rem;
  background: var(--control-fill);
  color: var(--text);
}
</style>

<style scoped>
.choice svg {
  width: 1.2rem;
  height: 1.2rem;
  color: var(--muted);
  margin-bottom: 0.25rem;
}
.choice--selected svg {
  color: var(--accent);
}
.viewer-option {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.3rem;
}
.viewer-option svg {
  width: 1.1rem;
  height: 1.1rem;
}
.choice--compact {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.3rem;
}
.choice--compact svg {
  margin: 0;
}
.share-privacy-caption {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.3rem;
  font-size: 0.72rem;
  font-weight: 400;
  color: var(--muted);
  margin: 0.65rem 0 0.25rem;
  text-align: center;
}
.share-privacy-caption svg {
  width: 0.9rem;
  height: 0.9rem;
  flex-shrink: 0;
}
.share-privacy-info {
  display: block;
  margin: 0 auto;
  padding: 0.4rem;
  border: 0;
  background: transparent;
  color: var(--muted);
  text-decoration: underline;
  font-size: 0.75rem;
  cursor: pointer;
}
</style>
