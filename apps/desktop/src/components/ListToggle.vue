<script setup lang="ts">
import { PanelLeftClose, PanelLeftOpen } from '@lucide/vue'
import { layout, toggleList } from '../core/store.js'

/**
 * §12 — the list, narrowed to its strip and widened again, as one button in
 * one place: the list's own header, at its end when the list is wide and
 * alone in it on the strip.
 *
 * It led the bar for a while, before the word that says what you are standing
 * on. That was the right answer while narrowing *hid* the list — a control in
 * a column that disappears has to live somewhere that does not. The strip
 * never goes away, so the control can sit on the thing it changes, and the
 * bar is back to being about the checkout and nothing else.
 *
 * The chevron is not decoration. The plain panel glyph — a box cut near its
 * left wall — is the picture the view control at the other end of the bar
 * already uses for "review only", and one drawing meaning two things on one
 * bar is a thing to get wrong. The arrow says which way the column is about
 * to go, and nothing else on the bar has one.
 */
</script>

<template>
  <button
    class="icon-btn list-toggle"
    :title="(layout.listOpen ? 'Narrow the list to a strip' : 'Widen the list') + '   ⌘B'"
    :aria-label="layout.listOpen ? 'Narrow the list' : 'Widen the list'"
    :aria-pressed="layout.listOpen"
    @click="toggleList"
  >
    <component :is="layout.listOpen ? PanelLeftClose : PanelLeftOpen" class="sm" />
  </button>
</template>

<style scoped>
.list-toggle {
  -webkit-app-region: no-drag;
  width: 26px;
  height: 26px;
}
</style>
