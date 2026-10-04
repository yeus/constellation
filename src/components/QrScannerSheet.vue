<template>
  <div class="sheet-backdrop" @click.self="emit('close')">
    <section
      class="share-sheet qr-scanner"
      role="dialog"
      aria-modal="true"
      aria-label="Scan QR code"
    >
      <header class="sheet-header">
        <div>
          <p class="eyebrow">Add location</p>
          <h2>Scan QR code</h2>
        </div>
        <button class="icon-button" type="button" aria-label="Close" @click="emit('close')">
          <CloseIcon />
        </button>
      </header>
      <video ref="video" autoplay muted playsinline aria-label="QR camera preview" />
      <p class="field-help" role="status">
        {{ error || 'Point the camera at a Constellation share QR code.' }}
      </p>
    </section>
  </div>
</template>

<script setup lang="ts">
import jsQR from 'jsqr'
import { onBeforeUnmount, onMounted, ref } from 'vue'

import CloseIcon from './icons/CloseIcon.vue'

const emit = defineEmits<{ close: []; scan: [url: string] }>()
const video = ref<HTMLVideoElement>()
const error = ref('')
let stream: MediaStream | undefined
let frame = 0
let scanning = true
let lastScanAt = 0

const scanFrame = (now: number): void => {
  frame = requestAnimationFrame(scanFrame)
  const element = video.value
  if (
    !element ||
    element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
    now - lastScanAt < 180
  ) {
    return
  }
  lastScanAt = now
  const scale = Math.min(1, 640 / element.videoWidth)
  const width = Math.round(element.videoWidth * scale)
  const height = Math.round(element.videoHeight * scale)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return
  context.drawImage(element, 0, 0, width, height)
  const result = jsQR(context.getImageData(0, 0, width, height).data, width, height)
  if (result?.data) {
    scanning = false
    emit('scan', result.data)
    emit('close')
  }
}

onMounted(async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' } },
    })
    if (!scanning || !video.value) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }
    video.value.srcObject = stream
    frame = requestAnimationFrame(scanFrame)
  } catch {
    error.value = 'Camera access is unavailable. Paste the share link instead.'
  }
})

onBeforeUnmount(() => {
  scanning = false
  cancelAnimationFrame(frame)
  stream?.getTracks().forEach((track) => track.stop())
})
</script>

<style scoped>
.qr-scanner video {
  width: 100%;
  max-height: min(55vh, 28rem);
  aspect-ratio: 4 / 3;
  border-radius: 0.75rem;
  background: #10151c;
  object-fit: cover;
}
</style>
