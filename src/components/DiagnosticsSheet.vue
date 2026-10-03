<template>
  <div class="sheet-backdrop" @click.self="emit('close')">
    <section
      class="share-sheet diagnostics-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="diagnostics-title"
    >
      <header class="sheet-header">
        <div>
          <p class="eyebrow">Build and browser</p>
          <h2 id="diagnostics-title">Diagnostics</h2>
        </div>
        <button class="icon-button" type="button" aria-label="Close" @click="emit('close')">
          <CloseIcon />
        </button>
      </header>

      <p class="field-help">
        Copy this report when reporting a bug. It contains app build and browser details. It does
        not include locations, share links, peer IDs, or network addresses. The user agent can
        identify your browser and device type, so review the report before posting it publicly.
      </p>

      <section v-for="section in sections" :key="section.title" class="diagnostics-section">
        <h3>{{ section.title }}</h3>
        <dl>
          <div v-for="item in section.items" :key="item.label" class="diagnostics-row">
            <dt>{{ item.label }}</dt>
            <dd>{{ item.value }}</dd>
          </div>
        </dl>
      </section>

      <button class="primary-action diagnostics-copy" type="button" @click="copyDiagnostics">
        Copy diagnostics
      </button>
      <p class="diagnostics-copy-status" role="status" aria-live="polite">{{ copyStatus }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

import CloseIcon from './icons/CloseIcon.vue'
import { createDiagnosticSections, formatDiagnosticReport } from '../diagnostics/buildInfo.ts'

const emit = defineEmits<{ close: [] }>()
const yesNo = (supported: boolean): string => (supported ? 'Yes' : 'No')
const browser = {
  runtime: '__TAURI_INTERNALS__' in window ? 'Tauri native app' : 'Web browser',
  userAgent: navigator.userAgent || 'Unavailable',
  appVersion: navigator.appVersion || 'Unavailable',
  platform: navigator.platform || 'Unavailable',
  mobile: yesNo(/Mobi|Android/i.test(navigator.userAgent)),
  language: navigator.language || 'Unavailable',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Unavailable',
  screen: `${screen.width} × ${screen.height} (${screen.colorDepth}-bit)`,
  viewport: `${window.innerWidth} × ${window.innerHeight} at ${window.devicePixelRatio}×`,
  online: navigator.onLine ? 'Online' : 'Offline',
  secureContext: yesNo(window.isSecureContext),
  capabilities: [
    `WebAssembly: ${yesNo('WebAssembly' in window)}`,
    `BigInt: ${yesNo('BigInt' in window)}`,
    `WebRTC: ${yesNo('RTCPeerConnection' in window)}`,
    `WebCrypto: ${yesNo(Boolean(window.crypto?.subtle))}`,
    `Fetch: ${yesNo('fetch' in window)}`,
    `Service worker: ${yesNo('serviceWorker' in navigator)}`,
    `Geolocation: ${yesNo('geolocation' in navigator)}`,
  ].join('; '),
}
const sections = createDiagnosticSections(__CONSTELLATION_BUILD_METADATA__, browser)
const copyStatus = ref('')

const copyDiagnostics = async (): Promise<void> => {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable.')
    await navigator.clipboard.writeText(formatDiagnosticReport(sections))
    copyStatus.value = 'Copied diagnostics to clipboard.'
  } catch {
    copyStatus.value = 'Could not copy diagnostics to the clipboard.'
  }
}
</script>

<style scoped>
.diagnostics-sheet {
  width: min(32rem, 100%);
}

.diagnostics-section h3 {
  margin: 1.1rem 0 0.35rem;
  font-size: 0.94rem;
}

.diagnostics-section dl {
  display: grid;
  gap: 0.45rem;
  margin: 0;
}

.diagnostics-row {
  display: grid;
  grid-template-columns: minmax(6.5rem, 0.35fr) minmax(0, 1fr);
  gap: 0.7rem;
  font-size: 0.78rem;
}

.diagnostics-row dt {
  color: var(--muted);
}

.diagnostics-row dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.diagnostics-copy {
  width: 100%;
  margin-top: 1.25rem;
}

.diagnostics-copy-status {
  min-height: 1.2rem;
  margin: 0.4rem 0 0;
  color: var(--muted);
  font-size: 0.78rem;
}
</style>
