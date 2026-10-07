<template>
  <span
    class="peer-avatar"
    :style="color ? { '--peer-avatar-color': color } : undefined"
    aria-hidden="true"
  >
    {{ peerInitials(name) }}
  </span>
</template>

<script setup lang="ts">
import { peerInitials } from '../identity/peerAvatar.ts'

defineProps<{ name: string; color?: string }>()
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
</style>
