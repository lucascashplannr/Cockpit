<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import ProjectRail from './components/ProjectRail.vue'
import WorkspaceList from './components/WorkspaceList.vue'
import ContextPanel from './components/ContextPanel.vue'
import CommandPalette from './components/CommandPalette.vue'
import PlanDialog from './components/PlanDialog.vue'
import ProjectDialog from './components/ProjectDialog.vue'
import NewProjectDialog from './components/NewProjectDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import FeatureDialog from './components/FeatureDialog.vue'
import Toast from './components/Toast.vue'
import ConnectionBanner from './components/ConnectionBanner.vue'
import HomeView from './components/HomeView.vue'
import WorkspaceActions from './components/WorkspaceActions.vue'
import WorkspaceTitle from './components/WorkspaceTitle.vue'
import { activeWorkspace, canLeaveHome, client, state, guard, requestPlan } from './core/store.js'

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
    if (state.newProjectOpen) state.newProjectOpen = false
    else if (state.settingsOpen) state.settingsOpen = false
    else if (state.editingProjectId) state.editingProjectId = null
    else if (state.pendingPlan) state.pendingPlan = null
    else if (state.paletteOpen) state.paletteOpen = false
    else if (state.homeOpen && canLeaveHome.value) state.homeOpen = false
    return
  }
  if (typing) return

  // The start page covers the shell, so the shell's shortcuts would act on
  // something nobody can see. Only ⌘K and Escape, handled above, cross it.
  if (state.homeOpen) return

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
    <!-- One band across the top, the way macOS apps carry their chrome: the
         traffic lights and the mark on a single row rather than stacked in a
         60px-wide rail. The lights grey out when the window loses focus, and
         the mark beside them keeps the corner from reading as empty. -->
    <header class="titlebar">
      <span class="lead" />
      <div class="title"><WorkspaceTitle /></div>
      <span class="grow" />
      <WorkspaceActions />
    </header>

    <ProjectRail />
    <WorkspaceList />
    <ContextPanel />

    <CommandPalette v-if="state.paletteOpen" />
    <PlanDialog v-if="state.pendingPlan" />
    <ProjectDialog />
    <NewProjectDialog />
    <SettingsDialog />
    <FeatureDialog />
    <ConnectionBanner />
    <Toast />

    <!-- Last, and over everything: the start page is the whole window. -->
    <HomeView v-if="state.homeOpen" />
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-rows: var(--titlebar-h) minmax(0, 1fr);
  grid-template-columns: var(--rail-w) var(--list-w) minmax(0, 1fr);
  height: 100vh;
  background: var(--bg);
  position: relative;
}

.titlebar {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  padding-right: 18px;
  /* Continuous with the rail below it, so the two read as one chrome surface. */
  background: var(--bg-sunken);
  border-bottom: 1px solid var(--line);
  -webkit-app-region: drag;
}
.grow { flex: 1; }

/* The rail's own width, holding nothing: macOS paints its three lights here.
   Carrying the rail's right border up through the band means the divider the
   eye sees beside the lights is the same line the rail draws below. */
.lead {
  width: var(--rail-w);
  height: 100%;
  flex: none;
  border-right: 1px solid var(--line);
}

/* The title starts at x = rail + 12: the exact left edge of the search field
   in the column below it. Beware naming rules here after a child's root class —
   Vue stamps this component's scope id onto a child component's root node too,
   so `.home` (HomeView) or `.brand` (Mark) would silently restyle them. */
/* x = rail + 12: the exact left edge of the search field in the column below.
   Beware naming a rule here after a child component's root class — Vue stamps
   this component's scope id onto that root too, so `.home` (HomeView) or
   `.brand` (Mark) would silently restyle the whole child. */
.title {
  margin-left: 12px;
  min-width: 0;
}
</style>
