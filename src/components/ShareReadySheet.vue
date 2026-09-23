<template>
  <div class="sheet-backdrop" @click.self="emit('close')">
    <section class="share-sheet share-ready" role="dialog" aria-modal="true">
      <header class="sheet-header">
        <div>
          <p class="eyebrow">Private link ready</p>
          <h2>Share this QR code</h2>
        </div>
        <button class="icon-button" type="button" aria-label="Close" @click="emit('close')">
          ×
        </button>
      </header>
      <img v-if="qrCode" class="share-ready__qr" :src="qrCode" alt="Location share QR code" />
      <p class="field-help">
        Anyone with this link can view the shared location until it expires or you stop it.
      </p>
      <input class="share-ready__link" aria-label="Share link" :value="url" readonly />
      <button class="primary-action" type="button" @click="shareLink">
        {{ canSystemShare ? 'Share link' : 'Copy link' }}
      </button>
      <button class="secondary-action" type="button" @click="emit('stop')">Stop sharing</button>
    </section>
  </div>
</template>

<script setup lang="ts">
import QRCode from 'qrcode'
import { computed, onMounted, ref } from 'vue'

const props = defineProps<{ url: string }>()
const emit = defineEmits<{ close: []; stop: [] }>()
const qrCode = ref('')
const canSystemShare = computed(() => typeof navigator.share === 'function')

const shareLink = async (): Promise<void> => {
  if (canSystemShare.value) {
    await navigator.share({ title: 'View my location', url: props.url })
    return
  }
  await navigator.clipboard.writeText(props.url)
}

onMounted(async () => {
  qrCode.value = await QRCode.toDataURL(props.url, {
    width: 280,
    margin: 2,
    errorCorrectionLevel: 'M',
  })
})
</script>
