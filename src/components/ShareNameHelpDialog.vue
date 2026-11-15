<template>
  <div class="sheet-backdrop" @click.self="emit('close')" @keydown.esc.stop.prevent="emit('close')">
    <section
      ref="dialog"
      class="share-sheet privacy-popup nickname-popup"
      role="dialog"
      aria-modal="true"
      aria-labelledby="nickname-help-title"
      tabindex="-1"
      @keydown.tab="dialog && trapDialogFocus($event, dialog)"
    >
      <header class="sheet-header">
        <h2 id="nickname-help-title">Private nicknames for sharing</h2>
        <button
          class="icon-button"
          type="button"
          aria-label="Close nickname help"
          @click="emit('close')"
        >
          <CloseIcon />
        </button>
      </header>
      <p>
        Every new location link gets a fresh random nickname, independent of your device name and
        other links. You can edit it or roll another before creating the link.
      </p>
      <p>
        Everyone using <strong>the same link</strong> sees the same nickname. Different links get
        independent names, even when you share with the same person.
      </p>
      <p>
        Anyone granted access to the link can see this name; the initial nickname is not your
        phone's identity and is not proof of ownership. Verify unfamiliar devices using the
        four-letter comparison.
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
.nickname-popup {
  max-width: 28rem;
}
.nickname-popup h2 {
  font-size: 1.1rem;
}
.nickname-popup p {
  font-size: 0.9rem;
  line-height: 1.5;
}
</style>
