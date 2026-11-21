<script setup lang="ts">
withDefaults(defineProps<{ size?: number | string }>(), { size: 28 })
</script>

<template>
  <span
    class="brand-mark-svg"
    :style="{ width: `${size}px`, height: `${size}px`, fontSize: `calc(${size}px * 0.56)` }"
    aria-hidden="true"
  >
    <span class="i-carbon-sprout" />
  </span>
</template>

<style scoped>
.brand-mark-svg {
  display: inline-grid;
  flex: none;
  place-items: center;
  border-radius: 28%;
  color: var(--ui-primary-on-fill, #fff);
  background: linear-gradient(
    145deg,
    color-mix(in srgb, var(--ui-primary) 82%, #fff) 0%,
    var(--ui-primary) 62%,
    var(--ui-primary-pressed) 100%
  );
  box-shadow:
    0 6px 16px color-mix(in srgb, var(--ui-primary) 26%, transparent),
    inset 0 1px 0 rgba(255, 255, 255, 0.24);
}
</style>
