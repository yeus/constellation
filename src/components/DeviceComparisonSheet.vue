<template>
  <div class="sheet-backdrop" @click.self="emit('close')">
    <section
      class="share-sheet device-verification"
      role="dialog"
      aria-modal="true"
      aria-label="Verify connection"
      @keydown.esc="emit('close')"
    >
      <header class="sheet-header">
        <div>
          <p class="eyebrow">Optional security check</p>
          <h2>Verify connection</h2>
        </div>
        <button
          class="icon-button"
          type="button"
          aria-label="Close verification"
          @click="emit('close')"
        >
          <CloseIcon />
        </button>
      </header>
      <strong class="device-verification__peer">{{ label }}</strong>
      <p class="field-help">
        Compare the four letters through a trusted call or in person. This checks device keys for
        this link, not the person's identity. It does not approve location access.
      </p>

      <div v-if="mismatch" class="device-verification__warning" role="alert">
        <strong>Letters do not match</strong>
        <p>
          Do not trust this connection. Contact the person independently, then stop following,
          reject or block the device, or revoke the link as appropriate.
        </p>
        <button v-if="viewer" class="secondary-action" type="button" @click="emit('stop')">
          Stop following
        </button>
        <button
          v-else-if="canReject"
          class="secondary-action"
          type="button"
          @click="emit('reject')"
        >
          Reject device
        </button>
        <button v-else-if="canBlock" class="secondary-action" type="button" @click="emit('block')">
          Block this device
        </button>
        <button v-else class="secondary-action" type="button" @click="emit('revoke')">
          Revoke link (all viewers)
        </button>
      </div>
      <template v-else-if="comparison">
        <div class="device-verification__letters">
          <span class="eyebrow">Letters on this device</span>
          <strong class="device-comparison-letters">{{ comparison.letters }}</strong>
        </div>
        <template v-if="comparison.confirmedAt">
          <p role="status">
            You confirmed matching letters on this device on
            {{ new Date(comparison.confirmedAt).toLocaleString() }}. The other device's confirmation
            is not known.
          </p>
          <button class="secondary-action" type="button" @click="emit('clear')">
            Clear local verification
          </button>
        </template>
        <template v-else-if="Date.now() >= comparison.expiresAt">
          <p role="status">This comparison has expired. Do not confirm these letters.</p>
          <button class="secondary-action" type="button" @click="emit('cancel')">
            Dismiss expired comparison
          </button>
        </template>
        <template v-else>
          <p class="field-help">
            Valid until {{ new Date(comparison.expiresAt).toLocaleTimeString() }}. Only confirm
            after comparing with the other device.
          </p>
          <div class="preview-actions">
            <button class="primary-action" type="button" @click="emit('confirm')">
              Letters match
            </button>
            <button class="secondary-action" type="button" @click="emit('mismatch')">
              Letters don't match
            </button>
            <button class="secondary-action" type="button" @click="emit('cancel')">Cancel</button>
          </div>
        </template>
      </template>
      <template v-else-if="viewer">
        <p v-if="pending" role="status">Connecting to the other device…</p>
        <p v-else>Start an authenticated comparison with this device.</p>
        <div class="preview-actions">
          <button class="primary-action" type="button" :disabled="pending" @click="emit('start')">
            {{ pending ? 'Comparing…' : 'Start verification' }}
          </button>
          <button v-if="pending" class="secondary-action" type="button" @click="emit('cancel')">
            Cancel
          </button>
        </div>
      </template>
      <p v-else role="status">
        Waiting for the viewer to start verification on their device. The letters will appear here
        when the exchange completes.
      </p>
      <p v-if="error" class="device-verification__error" role="alert">{{ error }}</p>
      <p class="field-help">
        Comparisons expire after two minutes. Three attempts per link; no automatic retries.
      </p>
    </section>
  </div>
</template>

<script setup lang="ts">
import type { DeviceComparison } from '../sharing/deviceComparison.ts'
import CloseIcon from './icons/CloseIcon.vue'

defineProps<{
  label: string
  viewer: boolean
  comparison?: DeviceComparison
  pending: boolean
  mismatch: boolean
  canReject: boolean
  canBlock: boolean
  error?: string
}>()
const emit = defineEmits<{
  close: []
  start: []
  cancel: []
  confirm: []
  mismatch: []
  block: []
  clear: []
  stop: []
  reject: []
  revoke: []
}>()
</script>

<style scoped>
.device-verification {
  display: grid;
  gap: 0.65rem;
}
.device-verification__peer {
  overflow-wrap: anywhere;
}
.device-verification__letters {
  display: grid;
  justify-items: center;
  gap: 0.5rem;
  padding: 1rem;
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  background: var(--control-fill);
}
.device-verification__warning {
  padding: 0.75rem;
  border: 1px solid var(--accent);
  border-radius: 0.65rem;
}
.device-verification__warning p {
  font-size: 0.85rem;
}
.device-verification__error {
  color: var(--danger, #b43d3d);
  font-size: 0.85rem;
}
</style>
