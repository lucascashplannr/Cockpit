<script setup lang="ts">
import { computed } from 'vue'
import { fileLook } from '../core/fileIcons.js'

/**
 * A file's icon, wherever a file is listed: the language's own mark when it
 * has one, otherwise a glyph for its kind. `plain` drops the colour — the row
 * it sits on is saying something louder (selected, open).
 */
const props = defineProps<{ name: string; plain?: boolean; tint?: 'brand' | 'ink' | 'mono' }>()
const look = computed(() => fileLook(props.name))

/** A brand drawn in black (JSON, Markdown, Rust…) vanishes on a dark ground: those take the row's ink. */
function visible(hex: string): string | undefined {
  const n = parseInt(hex.slice(1), 16)
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255
  return lum < 0.2 ? 'var(--text-muted)' : hex
}
const color = computed(() => {
  if (props.plain) return undefined
  const l = look.value
  const t = props.tint ?? 'brand'
  if (t === 'mono') return undefined
  if (t === 'brand' && l.brand) return visible(l.brand.hex)
  return l.ink ?? undefined
})
</script>

<template>
  <svg
    v-if="look.brand"
    class="lucide sm brand"
    viewBox="0 0 24 24"
    aria-hidden="true"
    :style="color ? { color } : undefined"
  >
    <path :d="look.brand.path" fill="currentColor" />
  </svg>
  <component :is="look.icon" v-else class="sm" :style="color ? { color } : undefined" />
</template>

<style scoped>
/* A filled mark weighs more than an outline of the same box; a step smaller
   and the two sit as equals in a column. */
.brand { padding: 1.5px; }
</style>
