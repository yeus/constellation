<template>
  <div class="sheet-backdrop" @click.self="emit('close')" @keydown.esc.stop.prevent="emit('close')">
    <section
      ref="dialog"
      class="share-sheet privacy-popup"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sharing-privacy-title"
      tabindex="-1"
      @keydown.tab="dialog && trapDialogFocus($event, dialog)"
    >
      <header class="sheet-header">
        <h2 id="sharing-privacy-title">Your location stays between devices</h2>
        <button
          class="icon-button"
          type="button"
          aria-label="Close privacy information"
          @click="emit('close')"
        >
          <CloseIcon />
        </button>
      </header>
      <p>
        Constellation sends location updates with <strong>end-to-end encryption</strong>. Only your
        device and the receiving devices can read them. Constellation keeps no location history on
        its servers.
      </p>
      <p>
        <strong>You choose what viewers receive:</strong> an approximate area, a very coarse area,
        or your device’s location accuracy—and how long sharing lasts.
      </p>
      <p>
        Devices connect directly when possible. When a relay helps forward the connection, it cannot
        read your encrypted location.
      </p>
      <p class="field-help">
        A receiver can still save or share what they receive. Stopping sharing prevents future
        updates.
      </p>
      <button class="primary-action" type="button" @click="emit('close')">Got it</button>
    </section>
  </div>
</template>
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import CloseIcon from './icons/CloseIcon.vue'
import { trapDialogFocus } from './dialogFocus.ts'
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLElement>()
onMounted(() => dialog.value?.focus())
</script>
<style scoped>
.privacy-popup {
  max-width: 28rem;
}
.privacy-popup h2 {
  font-size: 1.1rem;
}
.privacy-popup p {
  font-size: 0.9rem;
  line-height: 1.5;
}
</style>
