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
          >{{ share.precision }} · {{ share.viewerCount }} connected ·
          {{ share.publication || 'background' }}</span
        >
        <span>{{
          share.expiresAt === null ? 'Until stopped' : new Date(share.expiresAt).toLocaleString()
        }}</span>
        <details v-if="share.viewers?.length" class="share-list-item__viewers">
          <summary>Connected viewers ({{ share.viewers.length }})</summary>
          <p v-for="viewer in share.viewers" :key="viewer.fingerprint">
            Connection {{ viewer.fingerprint }} · last seen
            {{ new Date(viewer.lastSeenAt).toLocaleTimeString() }}
          </p>
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
import CloseIcon from './icons/CloseIcon.vue'
import type { ShareSummary } from '../sharing/sharingRuntime.ts'

defineProps<{ shares: readonly ShareSummary[] }>()
const emit = defineEmits<{
  close: []
  show: [share: ShareSummary]
  stop: [shareId: string]
}>()
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

.share-list-item__viewers p {
  margin: 0.4rem 0;
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
