<template>
  <span class="own-position-marker" aria-hidden="true">
    <span class="own-position-marker__dot"><span /></span>
    <span class="own-position-marker__label">me</span>
  </span>
</template>

<style scoped>
.own-position-marker {
  position: relative;
  display: inline-grid;
  place-items: center;
  width: 2.25rem;
  height: 2.25rem;
  overflow: visible;
}
.own-position-marker__dot {
  display: grid;
  width: 2.05rem;
  height: 2.05rem;
  place-items: center;
  box-sizing: border-box;
  border: 3px solid #fff;
  border-radius: 50%;
  background: var(--own-position-color);
  background: color-mix(in srgb, var(--own-position-color) 88%, transparent);
  box-shadow: 0 1px 5px rgba(15, 35, 65, 0.35);
  box-shadow:
    0 0 0 0.4rem color-mix(in srgb, var(--own-position-color) 17%, transparent),
    0 1px 5px rgba(15, 35, 65, 0.35);
}
.own-position-marker__dot > span {
  width: 0.7rem;
  height: 0.7rem;
  border-radius: 50%;
  background: var(--own-position-ink);
}
.own-position-marker__label {
  position: absolute;
  top: calc(100% + 0.16rem);
  left: 50%;
  transform: translateX(-50%);
  padding: 0.13rem 0.55rem;
  border: 2px solid #fff;
  border-radius: 1rem;
  background: var(--own-position-color);
  background: color-mix(in srgb, var(--own-position-color) 92%, transparent);
  color: var(--own-position-ink);
  font-size: 0.78rem;
  font-weight: 700;
  line-height: 1.25;
  white-space: nowrap;
  box-shadow: 0 1px 4px rgba(15, 35, 65, 0.2);
}
</style>
