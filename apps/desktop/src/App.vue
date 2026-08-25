<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import ProjectRail from './components/ProjectRail.vue'
import WorkspaceList from './components/WorkspaceList.vue'
import ContextPanel from './components/ContextPanel.vue'
import CommandPalette from './components/CommandPalette.vue'
import PlanDialog from './components/PlanDialog.vue'
import Toast from './components/Toast.vue'
import ConnectionBanner from './components/ConnectionBanner.vue'
import { activeWorkspace, client, state, guard, requestPlan } from './core/store.js'

/**
 * §12 — the three-column shell: projects, workspaces, context.
 * The keyboard owns it; the mouse is a fallback.
 */

function onKey(e: KeyboardEvent) {
  const meta = e.metaKey || e.ctrlKey
  const target = e.target as HTMLElement | null
  const typing =
    target &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

  // ⌘K is the real entry point and must work from anywhere, typing included.
  if (meta && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    state.paletteOpen = !state.paletteOpen
    return
  }
  if (e.key === 'Escape') {
    if (state.pendingPlan) state.pendingPlan = null
    else if (state.paletteOpen) state.paletteOpen = false
    return
  }
  if (typing) return

  // Tabs, in the order they appear (§12).
  const tabKeys: Record<string, typeof state.activeTab> = {
    '1': 'code',
    '2': 'diff',
    '3': 'agent',
    '4': 'memory',
    '5': 'journal',
    '6': 'terminal',
  }
  if (meta && tabKeys[e.key]) {
    e.preventDefault()
    state.activeTab = tabKeys[e.key]!
    return
  }

  const w = activeWorkspace.value
  if (!w) return

  // Single-key verbs, no modifier: the budget in §12 is one click, and a
  // keystroke is cheaper than a click.
  if (!meta && !e.altKey) {
    if (e.key === 'r') {
      e.preventDefault()
      void requestPlan(w.id, 'rebase')
    } else if (e.key === 'p') {
      e.preventDefault()
      void requestPlan(w.id, 'push')
    } else if (e.key === 'o') {
      e.preventDefault()
      void guard(() => client.call('workspace.openIn', { workspaceId: w.id, target: 'ide' }))
    } else if (e.key === 'g') {
      e.preventDefault()
      void guard(() => client.call('workspace.probe', { workspaceId: w.id }))
    }
  }
}

onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="shell">
    <div class="titlebar" />
    <ProjectRail />
    <WorkspaceList />
    <ContextPanel />

    <CommandPalette v-if="state.paletteOpen" />
    <PlanDialog v-if="state.pendingPlan" />
    <ConnectionBanner />
    <Toast />
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: var(--rail-w) var(--list-w) minmax(0, 1fr);
  height: 100vh;
  background: var(--bg);
  position: relative;
}

/* Draggable strip behind the traffic lights; the columns scroll under it. */
.titlebar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: var(--titlebar-h);
  -webkit-app-region: drag;
  pointer-events: none;
  z-index: 5;
}
</style>
