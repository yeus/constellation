<template>
  <div class="sheet-backdrop" @click.self="emit('close')" @keydown.esc.stop.prevent="emit('close')">
    <section
      ref="dialog"
      class="share-sheet privacy-popup precision-popup"
      role="dialog"
      aria-modal="true"
      aria-labelledby="precision-help-title"
      tabindex="-1"
      @keydown.tab="dialog && trapDialogFocus($event, dialog)"
    >
      <header class="sheet-header">
        <h2 id="precision-help-title">Precision choices</h2>
        <button
          class="icon-button"
          type="button"
          aria-label="Close precision help"
          @click="emit('close')"
        >
          <CloseIcon />
        </button>
      </header>
      <p>
        <strong>Exact</strong> shares the device-reported position and its uncertainty without added
        blurring. Device and permission accuracy still apply.
      </p>
      <p>
        <strong>Neighbourhood</strong> shares a stable approximate area with a default 1 km radius.
        It is a size label, not a named neighbourhood.
      </p>
      <p>
        <strong>City</strong> shares a stable city-sized approximate area with a minimum 20 km
        radius. It is a size label, not a named city.
      </p>
      <p class="field-help">
        Poor device accuracy can enlarge the disclosed uncertainty. Neither Neighbourhood nor City
        promises anonymity.
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
.precision-popup {
  max-width: 28rem;
}
.precision-popup h2 {
  font-size: 1.1rem;
}
.precision-popup p {
  font-size: 0.9rem;
  line-height: 1.5;
}
</style>
