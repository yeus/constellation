<template>
  <details class="peer-color-picker">
    <summary :aria-label="`Change color for ${label}`" title="Choose location color">
      <span class="peer-color-picker__swatch" :style="{ backgroundColor: color }" />
      <span>Color</span>
    </summary>
    <div class="peer-color-picker__controls">
      <div
        class="peer-color-picker__wheel"
        role="slider"
        tabindex="0"
        aria-label="Hue and saturation"
        aria-valuemin="0"
        aria-valuemax="360"
        :aria-valuenow="Math.round(hue)"
        aria-valuetext="Use arrow keys for hue; Shift with arrows changes saturation"
        @pointerdown="startPointer"
        @pointermove="movePointer"
        @pointerup="finishPointer"
        @pointercancel="cancelPointer"
        @keydown="adjustWithKeyboard"
      >
        <span
          class="peer-color-picker__thumb"
          :style="{
            left: `${50 + Math.sin((hue * Math.PI) / 180) * saturation * 50}%`,
            top: `${50 - Math.cos((hue * Math.PI) / 180) * saturation * 50}%`,
            backgroundColor: preview,
          }"
        />
      </div>
      <label class="peer-color-picker__value">
        Brightness
        <input
          v-model.number="brightness"
          type="range"
          min="0"
          max="100"
          step="1"
          aria-label="Color brightness"
          :style="{ accentColor: preview }"
          @change="commit"
        />
      </label>
      <label class="peer-color-picker__value">
        Hex
        <input
          class="peer-color-picker__hex"
          type="text"
          :value="preview"
          aria-label="Location color hex"
          maxlength="7"
          spellcheck="false"
          @change="applyHex"
        />
      </label>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = defineProps<{ color: string; label: string }>()
const emit = defineEmits<{ change: [color: string] }>()
const clamp = (value: number): number => Math.max(0, Math.min(1, value))
const hue = ref(0)
const saturation = ref(1)
const brightness = ref(100)
const parseColor = (color: string): void => {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255)
  const max = Math.max(r!, g!, b!)
  const min = Math.min(r!, g!, b!)
  const delta = max - min
  let nextHue = 0
  if (delta && max === r) nextHue = ((g! - b!) / delta) % 6
  else if (delta && max === g) nextHue = (b! - r!) / delta + 2
  else if (delta) nextHue = (r! - g!) / delta + 4
  hue.value = (nextHue * 60 + 360) % 360
  saturation.value = max === 0 ? 0 : delta / max
  brightness.value = Math.round(max * 100)
}
watch(() => props.color, parseColor, { immediate: true })
const preview = computed(() => {
  const chroma = (brightness.value / 100) * saturation.value
  const sector = hue.value / 60
  const component = chroma * (1 - Math.abs((sector % 2) - 1))
  const values =
    sector < 1
      ? [chroma, component, 0]
      : sector < 2
        ? [component, chroma, 0]
        : sector < 3
          ? [0, chroma, component]
          : sector < 4
            ? [0, component, chroma]
            : sector < 5
              ? [component, 0, chroma]
              : [chroma, 0, component]
  const offset = brightness.value / 100 - chroma
  return (
    '#' +
    values
      .map((v) =>
        Math.round((v + offset) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  )
})
const commit = (): void => {
  if (preview.value !== props.color.toLowerCase()) emit('change', preview.value)
}
const updatePointer = (event: PointerEvent): void => {
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const x = event.clientX - bounds.left - bounds.width / 2
  const y = event.clientY - bounds.top - bounds.height / 2
  saturation.value = clamp(Math.hypot(x, y) / (Math.min(bounds.width, bounds.height) / 2))
  if (Math.hypot(x, y) > 1) hue.value = ((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360
}
let pointerId: number | undefined
const startPointer = (event: PointerEvent): void => {
  if (pointerId !== undefined) return
  pointerId = event.pointerId
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  updatePointer(event)
}
const movePointer = (event: PointerEvent): void => {
  if (event.pointerId === pointerId) updatePointer(event)
}
const finishPointer = (event: PointerEvent): void => {
  if (event.pointerId !== pointerId) return
  updatePointer(event)
  pointerId = undefined
  commit()
}
const cancelPointer = (): void => {
  pointerId = undefined
  parseColor(props.color)
}
const adjustWithKeyboard = (event: KeyboardEvent): void => {
  const delta =
    event.key === 'ArrowUp' || event.key === 'ArrowRight'
      ? 1
      : event.key === 'ArrowDown' || event.key === 'ArrowLeft'
        ? -1
        : 0
  if (!delta) return
  event.preventDefault()
  if (event.shiftKey) saturation.value = clamp(saturation.value + delta * 0.05)
  else hue.value = (hue.value + delta * 5 + 360) % 360
  commit()
}
const applyHex = (event: Event): void => {
  const value = (event.target as HTMLInputElement).value.trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(value)) {
    parseColor(value)
    emit('change', value)
  } else {
    ;(event.target as HTMLInputElement).value = preview.value
  }
}
</script>

<style scoped>
.peer-color-picker {
  position: relative;
}
.peer-color-picker > summary {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  cursor: pointer;
  font-size: 0.82rem;
}
.peer-color-picker__swatch {
  display: inline-block;
  width: 1.45rem;
  height: 1.45rem;
  border-radius: 50%;
  border: 2px solid var(--surface);
  outline: 1px solid var(--border);
}
.peer-color-picker__controls {
  display: grid;
  justify-items: center;
  gap: 0.65rem;
  padding: 0.65rem 0;
}
.peer-color-picker__wheel {
  position: relative;
  width: 10rem;
  height: 10rem;
  border-radius: 50%;
  background: radial-gradient(circle, white 0%, transparent 100%),
    conic-gradient(red, #ff0, #0f0, #0ff, #00f, #f0f, red);
  box-shadow: 0 0 0 1px var(--border);
  touch-action: none;
  cursor: crosshair;
}
.peer-color-picker__wheel:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 3px;
}
.peer-color-picker__thumb {
  position: absolute;
  width: 0.8rem;
  height: 0.8rem;
  border: 2px solid white;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  box-shadow: 0 0 0 1px #263449;
  pointer-events: none;
}
.peer-color-picker__value {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  width: 11rem;
  font-size: 0.78rem;
}
.peer-color-picker__value input[type='range'] {
  width: 6.4rem;
}
.peer-color-picker__hex {
  width: 6.4rem;
  padding: 0.25rem 0.4rem;
  border: 1px solid var(--border);
  border-radius: 0.35rem;
  background: var(--surface);
  color: var(--text);
  font: inherit;
}
</style>
