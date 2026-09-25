<template>
  <div class="sheet-backdrop" @click.self="emit('close')">
    <section class="share-sheet" role="dialog" aria-modal="true" aria-labelledby="shares-title">
      <header class="sheet-header">
        <div>
          <p class="eyebrow">Your location</p>
          <h2 id="shares-title">Active shares</h2>
        </div>
        <button class="icon-button" type="button" aria-label="Close" @click="emit('close')">
          <CloseIcon />
        </button>
      </header>
      <p v-if="shares.length === 0" class="field-help">You are not sharing with anyone.</p>
      <article v-for="share in shares" :key="share.shareId" class="share-list-item">
        <strong>{{ share.name || 'Private link' }}</strong>
        <span
          >{{ share.precision === 'very-coarse' ? 'very coarse' : share.precision }} ·
          {{ share.viewerCount }} connected · {{ share.publication || 'background' }} ·
          {{
            share.expiresAt === null
              ? 'until stopped'
              : `until ${new Date(share.expiresAt).toLocaleString()}`
          }}</span
        >
        <details v-if="share.viewers?.length" class="share-list-item__viewers">
          <summary>Connected viewers ({{ share.viewers.length }})</summary>
          <div v-for="viewer in share.viewers" :key="viewer.fingerprint" class="viewer-row">
            <span
              >{{ viewer.localName || `Connection ${viewer.fingerprint}` }} · seen
              {{ new Date(viewer.lastSeenAt).toLocaleTimeString() }}</span
            >
            <span v-if="viewer.localName" class="viewer-row__fingerprint"
              >Connection {{ viewer.fingerprint }}</span
            >
            <div
              v-if="editingViewer === `${share.shareId}:${viewer.fingerprint}`"
              class="viewer-row__edit"
            >
              <input
                v-model="nameDraft"
                type="text"
                maxlength="32"
                aria-label="Device name"
                @keyup.enter="saveName(share.shareId, viewer.fingerprint)"
                @keyup.esc="editingViewer = undefined"
              />
              <button type="button" @click="saveName(share.shareId, viewer.fingerprint)">
                Save
              </button>
            </div>
            <button
              v-else
              class="viewer-row__button"
              type="button"
              :aria-label="`Edit device name for connection ${viewer.fingerprint}`"
              @click="editName(share.shareId, viewer.fingerprint, viewer.localName || '')"
            >
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="m4 20 4.2-.8L19 8.4 15.6 5 4.8 15.8 4 20ZM14.4 6.2l3.4 3.4"
                  stroke="currentColor"
                  stroke-width="1.7"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              Edit name
            </button>
          </div>
          <small>These fingerprints identify connections on this link, not people.</small>
        </details>
        <div class="share-list-item__actions">
          <button type="button" @click="emit('show', share)">Show link / QR</button>
          <button type="button" @click="emit('stop', share.shareId)">Revoke link</button>
        </div>
      </article>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import CloseIcon from './icons/CloseIcon.vue'
import type { ShareSummary } from '../sharing/sharingRuntime.ts'

defineProps<{ shares: readonly ShareSummary[] }>()
const emit = defineEmits<{
  close: []
  show: [share: ShareSummary]
  stop: [shareId: string]
  viewerName: [shareId: string, fingerprint: string, name: string]
}>()
const editingViewer = ref<string>()
const nameDraft = ref('')
const editName = (shareId: string, fingerprint: string, name: string): void => {
  editingViewer.value = `${shareId}:${fingerprint}`
  nameDraft.value = name
}
const saveName = (shareId: string, fingerprint: string): void => {
  emit('viewerName', shareId, fingerprint, nameDraft.value)
  editingViewer.value = undefined
}
</script>

<style scoped>
.share-list-item {
  display: grid;
  gap: 0.35rem;
  padding: 0.9rem 0;
  border-top: 1px solid var(--border);
}

.share-list-item span {
  color: var(--muted);
  font-size: 0.78rem;
}

.share-list-item__viewers {
  color: var(--muted);
  font-size: 0.78rem;
}

.viewer-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem;
  margin: 0.4rem 0;
}

.viewer-row__fingerprint {
  opacity: 0.7;
}

.viewer-row__edit {
  display: flex;
  gap: 0.3rem;
}

.viewer-row__edit input {
  min-width: 0;
  max-width: 10rem;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  background: var(--control-fill);
  color: var(--text);
}

.viewer-row__button {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 0.75rem;
  cursor: pointer;
}

.viewer-row__button svg {
  width: 0.9rem;
  height: 0.9rem;
}

.share-list-item__actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.4rem;
}

.share-list-item__actions button {
  min-height: 2.3rem;
  padding: 0 0.7rem;
  border: 1px solid var(--border);
  border-radius: 0.55rem;
  background: var(--control-fill);
  cursor: pointer;
}
</style>
