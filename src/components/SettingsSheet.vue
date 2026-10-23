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
      <section v-if="isAndroid" class="android-readiness" aria-label="Background following">
        <h3>Keep following in background</h3>
        <label class="settings-network">
          <input
            type="checkbox"
            :checked="backgroundFollowing"
            :disabled="busy || (!backgroundFollowing && savedFollowCount === 0)"
            @change="emit('setBackgroundFollowing', ($event.target as HTMLInputElement).checked)"
          />
          Keep following saved peers while this app is in the background
        </label>
        <p class="field-help">
          Off by default. {{ savedFollowCount }} saved peer(s). When enabled, Android shows an
          ongoing notification with Stop background following. Updates can still be delayed by Doze,
          lack of network access or device policy; this is not guaranteed continuous delivery. Only
          saved, authorized, non-expired subscriptions are restored.
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
import type {
  AndroidSharingSetup,
  AndroidSystemSettingsTarget,
} from '../android/backgroundSharing.ts'
const props = defineProps<{
  behavior: SharingBehavior
  isAndroid: boolean
  permissions?: AndroidSharingSetup['permissions']
  backgroundFollowing: boolean
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
const backgroundAllowed = computed(
  () => props.isAndroid && !!props.permissions && Object.values(props.permissions).every(Boolean),
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
