<template>
  <div class="sheet-backdrop">
    <section
      class="share-sheet sharing-diagnostics"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sharing-diagnostics-title"
    >
      <header class="sheet-header">
        <div>
          <p class="eyebrow">Executable checks</p>
          <h2 id="sharing-diagnostics-title">Sharing diagnostics</h2>
        </div>
        <button class="icon-button" type="button" aria-label="Close" @click="leave">
          <CloseIcon />
        </button>
      </header>
      <button class="secondary-action" type="button" @click="leave">Back to diagnostics</button>
      <p class="field-help">
        Run one check, a category, or the suite. Paired checks use fictional locations over your
        actual network. They create temporary test links and leave your ordinary shares alone.
      </p>
      <label
        >Category<select v-model="category" :disabled="running" aria-label="Category">
          <option v-for="entry in categories" :key="entry.id" :value="entry.id">
            {{ entry.name }}
          </option>
        </select></label
      >
      <label>Find a test<input v-model="filter" aria-label="Find a test" type="search" /></label>
      <label
        >Pairing role<select v-model="role" :disabled="running" aria-label="Pairing role">
          <option value="none">Local checks only</option>
          <option value="host">Start a test pair</option>
          <option value="join">Join a test pair</option>
        </select></label
      >
      <p v-if="role !== 'none'" class="field-help">
        Run the same named check on both devices. Start on the host, then copy or scan its temporary
        link on the joining device. Every check needs a new link. Category/all runs pause so the
        joining device can enter the next link. You have three minutes to pair and complete each
        check; cancel at any time.
      </p>
      <template v-if="role === 'join'">
        <label
          >Diagnostic partner link<input
            v-model="partnerUrl"
            aria-label="Diagnostic partner link"
            autocomplete="off"
            spellcheck="false"
        /></label>
        <button v-if="canScan" class="secondary-action" type="button" @click="scannerOpen = true">
          Scan diagnostic QR code
        </button>
      </template>
      <label class="check-option"
        ><input v-model="includeGuided" type="checkbox" :disabled="running" /> Include guided
        expiry, network and Android checks in category/all runs</label
      >
      <label v-if="native && role === 'host'" class="check-option"
        ><input v-model="nativeConsent" type="checkbox" :disabled="running" /> Allow the temporary
        Android check to share my real location with the paired device</label
      >
      <p v-if="native && role === 'host'" class="field-help">
        Android background checks need location and notification permissions. Lock and unlock the
        phone and move a short distance where safe so a fresh fix can be checked.
      </p>
      <div class="diagnostic-actions">
        <button class="primary-action" type="button" :disabled="running" @click="run(category)">
          Run selected category
        </button>
        <button class="primary-action" type="button" :disabled="running" @click="run('all')">
          Run all diagnostics
        </button>
        <button
          v-if="running"
          class="secondary-action"
          type="button"
          :disabled="cancelling"
          @click="cancel"
        >
          {{ cancelling ? 'Cancelling…' : 'Cancel run' }}
        </button>
        <button class="secondary-action" type="button" :disabled="!results.length" @click="copy">
          Copy results
        </button>
      </div>
      <p class="field-help" role="status" aria-live="polite">{{ stage }}</p>
      <div v-if="invitation" class="diagnostic-invitation">
        <img v-if="qrCode" :src="qrCode" alt="Diagnostic pairing QR code" />
        <label
          >Diagnostic pairing link<input
            :value="invitation"
            aria-label="Diagnostic pairing link"
            readonly
        /></label>
        <button class="secondary-action" type="button" @click="copyInvitation">
          Copy pairing link
        </button>
      </div>
      <ul class="diagnostic-tests">
        <li v-for="entry in visibleTests" :key="entry.id" role="group" :aria-label="entry.name">
          <strong>{{ entry.name }}</strong>
          <p class="field-help">{{ entry.description }}</p>
          <button class="secondary-action" type="button" :disabled="running" @click="run(entry.id)">
            Run test
          </button>
          <span
            v-if="results.find((result) => result.id === entry.id)"
            class="diagnostic-outcome"
            >{{ results.find((result) => result.id === entry.id)?.status }}</span
          >
        </li>
      </ul>
      <label
        >Diagnostic results<textarea
          aria-label="Diagnostic results"
          :value="report"
          readonly
          rows="8"
        />
      </label>
      <p class="field-help">
        Results contain build information, check outcomes, timings and transport types. Locations,
        share links, peer IDs and network addresses are excluded. Skipped checks are not passes.
      </p>
    </section>
    <QrScannerSheet v-if="scannerOpen" @close="scannerOpen = false" @scan="acceptScan" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { createShareQr } from '../sharing/shareQr.ts'
import CloseIcon from './icons/CloseIcon.vue'
import QrScannerSheet from './QrScannerSheet.vue'
import type { createAndroidBackgroundSharing } from '../android/backgroundSharing.ts'
import { createDiagnosticSession } from '../diagnostics/diagnosticSession.ts'
import {
  createSharingDiagnostics,
  summarizeDiagnostics,
  type SharingDiagnosticResult,
} from '../diagnostics/sharingDiagnostics.ts'
import { parseShareInvitation } from '../sharing/shareLink.ts'

const props = defineProps<{
  native?: NonNullable<ReturnType<typeof createAndroidBackgroundSharing>>
  shareBaseUrl: string
}>()
const emit = defineEmits<{ close: [] }>()
const categories = [
  { id: 'local', name: 'Local checks' },
  { id: 'network', name: 'Network' },
  { id: 'paired', name: 'Paired sharing' },
  { id: 'android', name: 'Android background' },
]
const category = ref('local')
const filter = ref('')
const role = ref<'none' | 'host' | 'join'>('none')
const partnerUrl = ref('')
const includeGuided = ref(false)
const nativeConsent = ref(false)
const scannerOpen = ref(false)
const canScan = Boolean(window.isSecureContext && navigator.mediaDevices)
const invitation = ref('')
const qrCode = ref('')
const results = ref<SharingDiagnosticResult[]>([])
const stage = ref('Choose a check to begin.')
const runAt = ref('')
const running = ref(false)
const cancelling = ref(false)
let controller: AbortController | undefined
let activeRun: Promise<void> | undefined
const suite = createSharingDiagnostics({
  shareBaseUrl: props.shareBaseUrl,
  createSession: () => createDiagnosticSession(props.shareBaseUrl),
  capabilities: () => ({
    secureContext: window.isSecureContext,
    crypto: Boolean(crypto.subtle),
    webRTC: 'RTCPeerConnection' in window,
  }),
  pairing: () => ({ role: role.value, url: partnerUrl.value }),
  invitation: (url) => {
    invitation.value = url
    qrCode.value = ''
    if (url)
      void createShareQr(url)
        .then((value) => {
          if (invitation.value === url) qrCode.value = value
        })
        .catch(() => undefined)
  },
  stage: (message) => {
    stage.value = message
  },
  native: props.native,
  visibility: {
    isHidden: () => document.hidden,
    subscribe: (listener) => {
      const update = () => listener(document.hidden)
      document.addEventListener('visibilitychange', update)
      return () => document.removeEventListener('visibilitychange', update)
    },
  },
  nativeConsent: () => nativeConsent.value,
  includeGuided: () => includeGuided.value,
})
const visibleTests = computed(() =>
  suite.catalog.filter(
    (entry) =>
      entry.category === category.value &&
      `${entry.name} ${entry.description}`.toLowerCase().includes(filter.value.toLowerCase()),
  ),
)
const report = computed(() =>
  JSON.stringify(
    {
      build: __CONSTELLATION_BUILD_METADATA__,
      runAt: runAt.value,
      summary: summarizeDiagnostics(results.value),
      results: results.value,
    },
    null,
    2,
  ),
)
const cancel = () => {
  cancelling.value = true
  stage.value = 'Cancelling and closing temporary sessions…'
  controller?.abort()
}
const leave = async () => {
  if (running.value) {
    cancel()
    await activeRun
  }
  emit('close')
}
const acceptScan = (url: string) => {
  partnerUrl.value = url
  scannerOpen.value = false
}
const run = (selection: string) => {
  if (running.value) return
  if (
    role.value === 'join' &&
    (selection === 'all' ||
      selection === 'paired' ||
      selection === 'android' ||
      selection.startsWith('paired.') ||
      selection.startsWith('android.'))
  ) {
    try {
      parseShareInvitation(partnerUrl.value)
    } catch {
      stage.value = 'Enter a valid diagnostic partner link.'
      return
    }
  }
  running.value = true
  cancelling.value = false
  results.value = []
  runAt.value = new Date().toISOString()
  controller = new AbortController()
  const signal = controller.signal
  activeRun = (async () => {
    try {
      await suite.run(selection, signal, (result) => {
        results.value = [...results.value, result]
      })
      const summary = summarizeDiagnostics(results.value)
      stage.value = `${signal.aborted ? 'Cancelled' : 'Finished'}: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped, ${summary.cancelled} cancelled.`
    } catch {
      stage.value = 'The diagnostic run could not finish.'
    } finally {
      running.value = false
      cancelling.value = false
      controller = undefined
    }
  })()
}
const copy = async () => {
  try {
    await navigator.clipboard.writeText(report.value)
    stage.value = 'Copied diagnostic results.'
  } catch {
    stage.value = 'Could not copy results.'
  }
}
const copyInvitation = async () => {
  try {
    await navigator.clipboard.writeText(invitation.value)
  } catch {
    stage.value = 'Could not copy the pairing link.'
  }
}
onBeforeUnmount(() => {
  controller?.abort()
})
</script>

<style scoped>
.sharing-diagnostics {
  width: min(38rem, 100%);
}
.sharing-diagnostics label {
  display: grid;
  gap: 0.35rem;
  margin: 0.8rem 0;
}
.sharing-diagnostics select,
.sharing-diagnostics textarea {
  width: 100%;
  padding: 0.55rem;
  color: var(--text);
  background: var(--surface-strong);
  border: 1px solid var(--border);
  border-radius: 0.6rem;
}
.sharing-diagnostics .check-option {
  display: flex;
  align-items: center;
  font-size: 0.8rem;
}
.check-option input {
  width: auto;
}
.diagnostic-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.diagnostic-tests {
  list-style: none;
  padding: 0;
}
.diagnostic-tests li {
  margin: 0.8rem 0;
  padding: 0.6rem 0;
  border-bottom: 1px solid var(--border);
}
.diagnostic-outcome {
  margin-left: 0.6rem;
}
.diagnostic-invitation img {
  display: block;
  max-width: 100%;
  margin: auto;
}
</style>
