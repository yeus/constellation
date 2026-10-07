<template>
  <div class="sheet-backdrop" @click.self="emit('close')">
    <section class="share-sheet share-ready" role="dialog" aria-modal="true" :aria-label="title">
      <header class="sheet-header">
        <div>
          <p class="eyebrow">{{ returnShare ? 'Private return share' : 'Private link ready' }}</p>
          <h2>{{ title }}</h2>
        </div>
        <button class="icon-button" type="button" aria-label="Close" @click="emit('close')">
          <CloseIcon />
        </button>
      </header>
      <button
        v-if="showQr && qrCode"
        class="share-ready__qr-button"
        type="button"
        :aria-label="enlarged ? 'Reduce QR code' : 'Enlarge QR code'"
        :aria-pressed="enlarged"
        @click="enlarged = !enlarged"
      >
        <img
          class="share-ready__qr"
          :class="{ 'share-ready__qr--enlarged': enlarged }"
          :src="qrCode"
          alt="Location share QR code"
        />
      </button>
      <p class="field-help">
        {{
          returnShare
            ? 'The return link could not be sent directly. Share it with the original sender.'
            : 'Anyone with this link can view the shared location until it expires or you stop it.'
        }}
      </p>
      <input class="share-ready__link" aria-label="Share link" :value="url" readonly />
      <div class="share-ready__actions">
        <button
          class="icon-button"
          type="button"
          aria-label="Share via system menu"
          title="Share link"
          @click="shareLink"
        >
          <ShareIcon aria-hidden="true" />
        </button>
        <button
          class="icon-button"
          type="button"
          aria-label="Copy link"
          title="Copy link"
          @click="copyLink"
        >
          <CopyIcon aria-hidden="true" />
        </button>
      </div>
      <p v-if="feedback" class="field-help" role="status">{{ feedback }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { LucideCopy as CopyIcon, LucideShare2 as ShareIcon } from '@lucide/vue'
import { createShareQr } from '../sharing/shareQr.ts'
import { computed, onMounted, ref } from 'vue'

import CloseIcon from './icons/CloseIcon.vue'

const props = withDefaults(
  defineProps<{ url: string; showQr?: boolean; returnShare?: boolean }>(),
  { showQr: true, returnShare: false },
)
const emit = defineEmits<{ close: [] }>()
const qrCode = ref('')
const feedback = ref('')
const enlarged = ref(false)
const title = computed(() =>
  props.returnShare ? 'Share location back' : props.showQr ? 'Share this QR code' : 'Share link',
)

const copyLink = async (): Promise<void> => {
  try {
    await navigator.clipboard.writeText(props.url)
    feedback.value = 'Link copied.'
  } catch {
    feedback.value = 'Could not copy the link. Select and copy it from the field above.'
  }
}

const shareLink = async (): Promise<void> => {
  if (typeof navigator.share !== 'function') {
    await copyLink()
    return
  }
  try {
    await navigator.share({ title: 'View my location', url: props.url })
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      feedback.value = 'Could not open the system share menu.'
    }
  }
}

onMounted(async () => {
  if (!props.showQr) return
  try {
    qrCode.value = await createShareQr(props.url)
  } catch {
    feedback.value = 'The QR code could not be created. You can still share or copy the link.'
  }
})
</script>
