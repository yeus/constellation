<template>
  <span
    class="peer-avatar"
    :style="color ? { '--peer-avatar-color': color } : undefined"
    aria-hidden="true"
  >
    <Hourglass v-if="waiting" aria-label="Waiting for a viewer" />
    <template v-else>{{ peerInitials(name) }}</template>
  </span>
</template>
<script setup lang="ts">
import { LucideHourglass as Hourglass } from '@lucide/vue'
import { peerInitials } from '../identity/peerAvatar.ts'

defineProps<{ name: string; color?: string; waiting?: boolean }>()
</script>

<style scoped>
.peer-avatar {
  display: inline-grid;
  width: 2.35rem;
  height: 2.35rem;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 50%;
  /* Taskyon AccountButton.vue: round, outline, secondary colour. */
  border: 1px solid var(--peer-avatar-color, var(--accent));
  color: var(--peer-avatar-color, var(--accent));
  font-size: 0.8rem;
  font-weight: 500;
  letter-spacing: 0.02em;
}
.peer-avatar svg {
  width: 1.2rem;
  height: 1.2rem;
}
</style>
