<script setup lang="ts">
import { Search } from '@lucide/vue'
import { state } from '../core/store.js'

/**
 * §12 — the real entry point, in the one place that is not about anything in
 * particular. It sat at the top of the workspace list, which read as "search
 * these rows"; it searches everything — projects, workspaces, commands — so it
 * belongs in the window's own chrome, beside what the window is about.
 */
</script>

<template>
  <button class="search" @click="state.paletteOpen = true">
    <Search class="sm" />
    <span class="ph">Search or run a command</span>
    <span class="kbd">⌘K</span>
  </button>
</template>

<style scoped>
.search {
  display: flex;
  align-items: center;
  gap: 9px;
  /* Room to breathe in the middle of the band, and the first thing to give it
     back when the verbs on the right need the width. */
  flex: 0 1 380px;
  min-width: 132px;
  height: 32px;
  padding: 0 8px 0 11px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--bg);
  color: var(--text-dim);
  font-size: var(--fs-sm);
  box-shadow: var(--shadow-xs);
  transition:
    border-color var(--dur-2) var(--ease-soft),
    background var(--dur-2) var(--ease-soft),
    box-shadow var(--dur-2) var(--ease-soft);
  -webkit-app-region: no-drag;
}
.search:hover {
  border-color: var(--line-strong);
  background: var(--panel-raised);
  box-shadow: var(--shadow-sm);
  color: var(--text-muted);
}
.ph {
  flex: 1;
  min-width: 0;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
