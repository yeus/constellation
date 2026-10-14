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
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader'
import zxingReaderWasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'

import CloseIcon from './icons/CloseIcon.vue'

interface NativeBarcodeDetector {
  detect(source: CanvasImageSource): Promise<readonly { rawValue: string }[]>
}

interface NativeBarcodeDetectorConstructor {
  new (options: { formats: readonly string[] }): NativeBarcodeDetector
  getSupportedFormats?: () => Promise<readonly string[]>
}

const NATIVE_SCAN_INTERVAL_MS = 100
const FALLBACK_SCAN_INTERVAL_MS = 180
const FALLBACK_SCAN_WIDTH = 1280
const MAX_NATIVE_FAILURES = 3

const emit = defineEmits<{ close: []; scan: [url: string] }>()
const video = ref<HTMLVideoElement>()
const error = ref('')
let stream: MediaStream | undefined
let frame = 0
let scanning = true
let reading = false
let lastScanAt = 0
let canvas: HTMLCanvasElement | undefined
let nativeDetector: NativeBarcodeDetector | undefined
let nativeFailures = 0
let wasmReady: Promise<unknown> | undefined

const nativeBarcodeDetector = (): NativeBarcodeDetectorConstructor | undefined =>
  (globalThis as typeof globalThis & { BarcodeDetector?: NativeBarcodeDetectorConstructor })
    .BarcodeDetector

const createNativeDetector = async (): Promise<NativeBarcodeDetector | undefined> => {
  const Detector = nativeBarcodeDetector()
  if (!Detector) return undefined
  try {
    const formats =
      typeof Detector.getSupportedFormats === 'function'
        ? await Detector.getSupportedFormats()
        : undefined
    if (formats && !formats.includes('qr_code')) return undefined
    return new Detector({ formats: ['qr_code'] })
  } catch {
    return undefined
  }
}

const ensureZXing = (): Promise<unknown> => {
  wasmReady ??= prepareZXingModule({
    overrides: { locateFile: () => zxingReaderWasmUrl },
    fireImmediately: true,
  })
  return wasmReady
}

const finish = (url: string): void => {
  if (!url || !scanning) return
  scanning = false
  emit('scan', url)
  emit('close')
}

const scanNative = (element: HTMLVideoElement, now: number): void => {
  if (!nativeDetector || reading || now - lastScanAt < NATIVE_SCAN_INTERVAL_MS) return
  lastScanAt = now
  reading = true
  nativeDetector
    .detect(element)
    .then((results) => {
      const result = results.find((candidate) => candidate.rawValue)
      if (result) finish(result.rawValue)
      nativeFailures = 0
    })
    .catch(() => {
      nativeFailures += 1
      if (nativeFailures >= MAX_NATIVE_FAILURES) nativeDetector = undefined
    })
    .finally(() => {
      reading = false
    })
}

const scanFallback = (element: HTMLVideoElement, now: number): void => {
  if (reading || now - lastScanAt < FALLBACK_SCAN_INTERVAL_MS) return
  const scale = Math.min(1, FALLBACK_SCAN_WIDTH / element.videoWidth)
  const width = Math.round(element.videoWidth * scale)
  const height = Math.round(element.videoHeight * scale)
  canvas ??= document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return
  lastScanAt = now
  reading = true
  context.drawImage(element, 0, 0, width, height)
  const imageData = context.getImageData(0, 0, width, height)
  void ensureZXing()
    .then(() =>
      readBarcodes(imageData, {
        formats: ['QRCode'],
        maxNumberOfSymbols: 1,
        tryHarder: true,
        tryRotate: true,
        tryInvert: true,
        tryDownscale: true,
      }),
    )
    .then((results) => {
      const result = results.find((candidate) => candidate.text)
      if (result) finish(result.text)
    })
    .catch(() => {
      // A failed frame is retried on the next tick.
    })
    .finally(() => {
      reading = false
    })
}

const scanFrame = (now: number): void => {
  if (!scanning) return
  frame = requestAnimationFrame(scanFrame)
  const element = video.value
  if (
    !element ||
    element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
    element.videoWidth === 0 ||
    element.videoHeight === 0
  ) {
    return
  }
  if (nativeDetector) scanNative(element, now)
  else scanFallback(element, now)
}

onMounted(async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    })
    if (!scanning || !video.value) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }
    video.value.srcObject = stream
    nativeDetector = await createNativeDetector()
    if (!nativeDetector) void ensureZXing()
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
  object-fit: contain;
}
</style>
