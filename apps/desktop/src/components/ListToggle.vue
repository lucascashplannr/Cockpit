<script setup lang="ts">
import { PanelLeftClose, PanelLeftOpen } from '@lucide/vue'
import { layout, toggleList } from '../core/store.js'

/**
 * §12 — the list, put away and brought back, as one button in one place: the
 * head of the bar, before the word that says what you are standing on.
 *
 * It was drawn in the list's own header while the list was there, and by the
 * bar once it was not — the same pixel on screen, and two different places to
 * anyone reading the window: a control that belongs to the column it removes
 * leaves with it. The bar is there in both states, so the button is too, and
 * "before REPO" is where it is whether the list is beside it or not.
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
    :title="(layout.listOpen ? 'Hide the list' : 'Show the list') + '   ⌘B'"
    :aria-label="layout.listOpen ? 'Hide the list' : 'Show the list'"
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
