<template>
  <div
    class="sheet-backdrop"
    @click.self="!busy && emit('close')"
    @keydown.esc.stop="!busy && emit('close')"
  >
    <section
      ref="dialog"
      tabindex="-1"
      class="share-sheet settings-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      @keydown.tab="dialog && trapDialogFocus($event, dialog)"
    >
      <header class="sheet-header">
        <h2 id="settings-title">{{ review ? 'Set up sharing' : 'Settings' }}</h2>
        <button
          class="icon-button"
          type="button"
          aria-label="Close settings"
          :disabled="busy"
          @click="emit('close')"
        >
          <CloseIcon />
        </button>
      </header>
      <p class="field-help">
        Sharing behavior applies to every active and future link on this device. Your precision,
        duration and recipient choices stay the same.
      </p>
      <p v-if="review" class="settings-review">
        {{
          hasShares
            ? 'Review once to replace your existing per-link behavior with these global settings.'
            : isAndroid
              ? 'Background sharing is the Android default. Enable permissions to set it up, or choose sharing only while the app is open.'
              : 'Choose how this device shares your location.'
        }}
      </p>
      <fieldset :disabled="busy">
        <legend>When to share</legend>
        <div class="choice-grid choice-grid--two">
          <button
            class="choice"
            type="button"
            :class="{ 'choice--selected': draft.publication === 'foreground' }"
            :aria-pressed="draft.publication === 'foreground'"
            @click="draft = { ...draft, publication: 'foreground' }"
          >
            <AppIcon aria-hidden="true" /><strong>While app is open</strong
            ><span>Pause when hidden</span>
          </button>
          <button
            class="choice"
            type="button"
            :class="{ 'choice--selected': draft.publication === 'background' }"
            :aria-pressed="draft.publication === 'background'"
            :disabled="!backgroundAllowed"
            @click="draft = { ...draft, publication: 'background' }"
          >
            <BackgroundIcon aria-hidden="true" /><strong>In background</strong
            ><span>Android notification</span>
          </button>
        </div>
      </fieldset>
      <p v-if="!isAndroid" class="field-help">
        Background sharing requires the native Android app. It is unavailable in this browser or
        desktop app.
      </p>
      <div v-else-if="!backgroundAllowed" class="settings-permissions">
        <p>
          To enable background sharing, allow device location, all-the-time location and
          notifications. Device location services must also be enabled.
        </p>
        <p class="field-help">
          On newer Android versions, choose Permissions → Location → Allow all the time in the app’s
          system settings, then return here.
        </p>
        <button
          :class="review ? 'primary-action' : 'secondary-action'"
          type="button"
          :disabled="busy"
          @click="emit('enablePermissions')"
        >
          {{ review ? 'Enable background sharing' : 'Enable permissions' }}
        </button>
        <button
          class="secondary-action"
          type="button"
          :disabled="busy"
          @click="emit('save', { ...draft, publication: 'foreground' })"
        >
          Use while app is open
        </button>
      </div>
      <fieldset :disabled="busy || draft.publication !== 'background' || !backgroundAllowed">
        <legend>Update frequency</legend>
        <div class="choice-grid choice-grid--two">
          <button
            class="choice"
            type="button"
            :aria-pressed="draft.battery === 'balanced'"
            :class="{ 'choice--selected': draft.battery === 'balanced' }"
            @click="draft = { ...draft, battery: 'balanced' }"
          >
            <BalancedIcon aria-hidden="true" /><strong>Balanced</strong><span>About every 5 s</span>
          </button>
          <button
            class="choice"
            type="button"
            :aria-pressed="draft.battery === 'saver'"
            :class="{ 'choice--selected': draft.battery === 'saver' }"
            @click="draft = { ...draft, battery: 'saver' }"
          >
            <BatteryIcon aria-hidden="true" /><strong>Battery saver</strong
            ><span>About every 30 s</span>
          </button>
        </div>
        <label class="settings-network"
          ><input
            type="checkbox"
            :checked="draft.network === 'pause-when-metered'"
            @change="
              draft = {
                ...draft,
                network: ($event.target as HTMLInputElement).checked
                  ? 'pause-when-metered'
                  : 'always',
              }
            "
          />Pause updates on metered networks and Data Saver</label
        >
      </fieldset>
      <p class="field-help">
        Background battery and network settings take effect only in background mode. Metered
        networks, Data Saver and Doze can delay updates. Pausing updates keeps the link active;
        updates resume automatically when the restriction ends.
      </p>
      <p v-if="error" role="alert" class="settings-error">{{ error }}</p>
      <button
        class="primary-action"
        type="button"
        :disabled="busy || (draft.publication === 'background' && !backgroundAllowed)"
        @click="emit('save', draft)"
      >
        {{ busy ? 'Please wait…' : 'Save settings' }}
      </button>
    </section>
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { trapDialogFocus } from './dialogFocus.ts'
import {
  LucideSmartphone as AppIcon,
  LucideBell as BackgroundIcon,
  LucideActivity as BalancedIcon,
  LucideBattery as BatteryIcon,
} from '@lucide/vue'
import CloseIcon from './icons/CloseIcon.vue'
import type { SharingBehavior } from '../sharing/sharingBehavior.ts'
import type { AndroidSharingSetup } from '../android/backgroundSharing.ts'
const props = defineProps<{
  behavior: SharingBehavior
  isAndroid: boolean
  permissions?: AndroidSharingSetup['permissions']
  review: boolean
  hasShares: boolean
  busy: boolean
  error?: string
}>()
const emit = defineEmits<{ close: []; save: [behavior: SharingBehavior]; enablePermissions: [] }>()
const dialog = ref<HTMLElement>()
const previousFocus =
  document.activeElement instanceof HTMLElement ? document.activeElement : undefined
onMounted(() => dialog.value?.focus())
onUnmounted(() => {
  if (previousFocus?.isConnected) previousFocus.focus()
  else document.querySelector<HTMLButtonElement>('button[aria-label="Open menu"]')?.focus()
})
const draft = ref({ ...props.behavior })
const backgroundAllowed = computed(
  () => props.isAndroid && !!props.permissions && Object.values(props.permissions).every(Boolean),
)
</script>
<style scoped>
.settings-sheet {
  max-width: 30rem;
}
.settings-sheet h2 {
  font-size: 1.2rem;
}
.choice svg {
  width: 1.2rem;
  height: 1.2rem;
  color: var(--muted);
}
.choice--selected svg {
  color: var(--accent);
}
.choice:disabled,
fieldset:disabled {
  opacity: 0.55;
}
.settings-review {
  padding: 0.75rem;
  border-radius: 0.65rem;
  background: var(--accent-soft);
  font-size: 0.85rem;
}
.settings-permissions {
  font-size: 0.85rem;
}
.settings-network {
  display: flex;
  align-items: start;
  gap: 0.4rem;
  font-size: 0.85rem;
  margin-top: 0.75rem;
}
.settings-error {
  color: var(--text);
  font-size: 0.85rem;
}
</style>
