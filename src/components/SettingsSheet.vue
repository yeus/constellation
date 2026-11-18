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
            ? 'Review once to apply your global preferences to existing links.'
            : isAndroid
              ? 'Choose your preferred mode, even without Android permissions; the fallback is shown below.'
              : 'Choose your preferred mode. Background sharing will fall back to foreground-only.'
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
            @click="changeDraft({ ...draft, publication: 'foreground' })"
          >
            <AppIcon aria-hidden="true" /><strong>While app is open</strong
            ><span>Pause when hidden</span>
          </button>
          <button
            class="choice"
            type="button"
            :class="{ 'choice--selected': draft.publication === 'background' }"
            :aria-pressed="draft.publication === 'background'"
            @click="changeDraft({ ...draft, publication: 'background' })"
          >
            <BackgroundIcon aria-hidden="true" /><strong>In background</strong
            ><span>Android notification</span>
          </button>
        </div>
      </fieldset>
      <p v-if="fallbackNotice" class="settings-permissions" role="status">
        <strong>Requested mode (save to keep it); execution restricted.</strong>
        {{ fallbackNotice }}
      </p>
      <div v-if="isAndroid && !backgroundAllowed" class="settings-permissions">
        <p>
          Missing permissions do not prevent editing settings. Grant Android location, background
          location, and notifications to use background sharing.
        </p>
        <button
          :class="review ? 'primary-action' : 'secondary-action'"
          type="button"
          :disabled="busy"
          @click="emit('enablePermissions')"
        >
          {{ review ? 'Enable background sharing' : 'Enable permissions' }}
        </button>
      </div>
      <p
        v-if="isAndroid && permissions && !permissions.servicesEnabled"
        class="settings-location-off"
        role="status"
      >
        {{ deviceLocationNotice(false, hasShares ? 1 : 0) }}
        Changing settings still works while Location is off.
      </p>
      <fieldset :disabled="busy">
        <legend>Update frequency</legend>
        <div class="choice-grid choice-grid--two">
          <button
            class="choice"
            type="button"
            :aria-pressed="draft.battery === 'balanced'"
            :class="{ 'choice--selected': draft.battery === 'balanced' }"
            @click="changeDraft({ ...draft, battery: 'balanced' })"
          >
            <BalancedIcon aria-hidden="true" /><strong>Balanced</strong
            ><span>About every 15 s while visible</span>
          </button>
          <button
            class="choice"
            type="button"
            :aria-pressed="draft.battery === 'saver'"
            :class="{ 'choice--selected': draft.battery === 'saver' }"
            @click="changeDraft({ ...draft, battery: 'saver' })"
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
              changeDraft({
                ...draft,
                network: ($event.target as HTMLInputElement).checked
                  ? 'pause-when-metered'
                  : 'always',
              })
            "
          />Pause updates on metered networks and Data Saver</label
        >
      </fieldset>
      <p v-if="isAndroid" class="field-help">
        Background sharing always uses the lower-power rate (about every 30 s), even if Balanced is
        selected.
      </p>
      <fieldset v-if="isAndroid" :disabled="busy">
        <legend>Background location source</legend>
        <label class="settings-network">
          <input
            type="checkbox"
            :checked="draft.locationProvider === 'network-only'"
            @change="
              changeDraft({
                ...draft,
                locationProvider: ($event.target as HTMLInputElement).checked
                  ? 'network-only'
                  : 'automatic',
              })
            "
          />Use network positioning only (never turn on GPS for background sharing)</label
        >
        <p class="field-help">
          May use less battery, but location can become unavailable. This does not change your
          per-link disclosed precision; network positioning can still be accurate.
        </p>
        <label v-if="isAndroid" class="settings-network">
          <input
            type="checkbox"
            :checked="draft.activeViewingBoost !== false"
            @change="
              changeDraft({
                ...draft,
                activeViewingBoost: ($event.target as HTMLInputElement).checked,
              })
            "
          />Allow brief faster tracking when an authorized recipient is actively viewing
        </label>
        <p v-if="isAndroid" class="field-help">
          Authenticated viewing requests expire automatically. Faster tracking is capped at one
          minute per ten minutes and never overrides network-only mode or the shared precision.
        </p>
      </fieldset>
      <p class="field-help">
        Update frequency and network preferences remain saved even if background mode is unavailable
        or unselected. Effective fallback: these controls are inactive in foreground-only mode. Doze
        and network restrictions can still delay updates. Updates paused by the saved network policy
        resume automatically when the restriction ends, subject to Android process availability.
      </p>
      <section
        v-if="isAndroid"
        class="android-readiness android-readiness--following"
        aria-label="Background following"
      >
        <h3>Background following</h3>
        <label class="settings-network settings-following-switch">
          <input
            type="checkbox"
            :checked="backgroundFollowing"
            :disabled="busy"
            @change="emit('setBackgroundFollowing', ($event.target as HTMLInputElement).checked)"
          />
          <strong>Keep receiving saved peers' locations in the background</strong>
        </label>
        <p class="field-help">
          On by default. {{ savedFollowCount }} saved peer(s). The preference does not change when
          Android disconnects or restarts the receiver. If background reception is restricted, the
          fallback is receiving while this app is open; subscriptions remain saved.
        </p>
        <p class="field-help" role="status">
          Android receiver: {{ backgroundReceiverActive ? 'running' : 'not running' }}.
          {{
            backgroundFollowing && !backgroundReceiverActive && savedFollowCount > 0
              ? 'The preference is enabled, but the receiver is not active. Check permissions or reopen the app.'
              : ''
          }}
        </p>
        <p v-if="!backgroundFollowing && backgroundReceiverActive" class="field-help" role="alert">
          Background following is turned off, but the Android receiver is still running. Use the
          notification's Stop action if stopping it here failed.
        </p>
      </section>
      <section
        v-if="isAndroid"
        class="android-readiness"
        aria-label="Android permissions and restrictions"
      >
        <h3>Android permissions &amp; restrictions</h3>
        <p class="field-help">
          Android controls these settings. Select Change to open the corresponding system page;
          return to Constellation to refresh the results. Battery optimization is optional, but may
          delay locations while the phone sleeps.
        </p>
        <div v-for="item in policyRows" :key="item.label" class="android-policy-row">
          <div>
            <strong>{{ item.label }}</strong>
            <p :class="{ 'policy-warning': item.warning }" class="field-help">{{ item.status }}</p>
          </div>
          <button
            class="secondary-action"
            type="button"
            :aria-label="`Change ${item.label}`"
            :disabled="busy"
            @click="emit('openSystemSettings', item.target)"
          >
            Change
          </button>
        </div>
        <p class="field-help">
          Doze, a force-stop, device-specific power restrictions and loss of network access can
          still interrupt peer updates. Active outgoing sharing uses a notification; receiving peers
          while this app sleeps is not yet guaranteed.
        </p>
      </section>
      <p v-if="error" role="alert" class="settings-error">{{ error }}</p>
      <button class="primary-action" type="button" :disabled="busy" @click="emit('save', draft)">
        {{ busy ? 'Please wait…' : 'Save settings' }}
      </button>
    </section>
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { trapDialogFocus } from './dialogFocus.ts'
import {
  LucideSmartphone as AppIcon,
  LucideBell as BackgroundIcon,
  LucideActivity as BalancedIcon,
  LucideBattery as BatteryIcon,
} from '@lucide/vue'
import CloseIcon from './icons/CloseIcon.vue'
import type { SharingBehavior } from '../sharing/sharingBehavior.ts'
import {
  canConfigureBackgroundSharing,
  sharingFallbackNotice,
  deviceLocationNotice,
} from '../android/locationReadiness.ts'
import type {
  AndroidSharingSetup,
  AndroidSystemSettingsTarget,
} from '../android/backgroundSharing.ts'
const props = defineProps<{
  behavior: SharingBehavior
  isAndroid: boolean
  permissions?: AndroidSharingSetup['permissions']
  backgroundFollowing: boolean
  backgroundReceiverActive: boolean
  savedFollowCount: number
  devicePolicies?: AndroidSharingSetup['devicePolicies']
  review: boolean
  hasShares: boolean
  busy: boolean
  error?: string
}>()
const emit = defineEmits<{
  close: []
  save: [behavior: SharingBehavior]
  enablePermissions: []
  setBackgroundFollowing: [enabled: boolean]
  openSystemSettings: [target: AndroidSystemSettingsTarget]
}>()
const dialog = ref<HTMLElement>()
const previousFocus =
  document.activeElement instanceof HTMLElement ? document.activeElement : undefined
onMounted(() => dialog.value?.focus())
onUnmounted(() => {
  if (previousFocus?.isConnected) previousFocus.focus()
  else document.querySelector<HTMLButtonElement>('button[aria-label="Open menu"]')?.focus()
})
const draft = ref({ ...props.behavior })
const dirty = ref(false)
watch(
  () => props.behavior,
  (behavior) => {
    if (!dirty.value) draft.value = { ...behavior }
  },
  { deep: true },
)
const changeDraft = (behavior: SharingBehavior): void => {
  dirty.value = true
  draft.value = behavior
}
const fallbackNotice = computed(() =>
  sharingFallbackNotice(draft.value, props.isAndroid, props.permissions),
)
const backgroundAllowed = computed(
  () => props.isAndroid && canConfigureBackgroundSharing(props.permissions),
)
const policyRows = computed(() => {
  const permissions = props.permissions
  const policies = props.devicePolicies
  const rows: {
    label: string
    target: AndroidSystemSettingsTarget
    status: string
    warning: boolean
  }[] = [
    {
      label: 'Location permission',
      target: 'location',
      status: permissions?.location ? 'Allowed' : 'Not allowed',
      warning: !permissions?.location,
    },
    {
      label: 'Background location',
      target: 'location',
      status: permissions?.background ? 'Allowed all the time' : 'Not allowed all the time',
      warning: !permissions?.background,
    },
    {
      label: 'Device location',
      target: 'device-location',
      status: permissions?.servicesEnabled ? 'Enabled' : 'Disabled',
      warning: !permissions?.servicesEnabled,
    },
    {
      label: 'Notifications',
      target: 'notifications',
      status: permissions?.notifications ? 'Enabled' : 'Disabled',
      warning: !permissions?.notifications,
    },
    ...(policies
      ? [
          {
            label: 'Background app restriction',
            target: 'app' as const,
            status: policies.backgroundRestricted
              ? 'Restricted — may stop updates'
              : 'Not restricted',
            warning: policies.backgroundRestricted,
          },
          {
            label: 'Battery optimization',
            target: 'battery' as const,
            status: policies.batteryOptimizationExempt
              ? 'Unrestricted'
              : 'Optimized — may delay updates',
            warning: false,
          },
          {
            label: 'Battery saver',
            target: 'power-saver' as const,
            status: policies.powerSaverEnabled ? 'On — may delay updates' : 'Off',
            warning: policies.powerSaverEnabled,
          },
          {
            label: 'Data Saver',
            target: 'data-saver' as const,
            status: policies.dataSaverEnabled ? 'On — may restrict traffic' : 'Off',
            warning: policies.dataSaverEnabled,
          },
        ]
      : []),
  ]
  return rows
})
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
.android-readiness {
  margin-top: 1rem;
  border-top: 1px solid var(--border);
  padding-top: 0.75rem;
}
.android-readiness h3 {
  font-size: 1rem;
  margin: 0 0 0.5rem;
}
.android-readiness--following {
  border: 2px solid var(--border);
  border-radius: 0.85rem;
  padding: 1rem;
}
.settings-following-switch {
  align-items: center;
  padding: 0.6rem 0;
  font-size: 0.95rem;
}
.settings-following-switch input {
  width: 1.35rem;
  height: 1.35rem;
  flex: 0 0 auto;
}
.android-policy-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.8rem;
  padding: 0.45rem 0;
}
.android-policy-row strong {
  font-size: 0.85rem;
}
.android-policy-row p {
  margin: 0.1rem 0 0;
}
.android-policy-row button {
  flex-shrink: 0;
}
.policy-warning {
  color: var(--danger, var(--text));
}
</style>
