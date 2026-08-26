<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import ProjectRail from './components/ProjectRail.vue'
import WorkspaceList from './components/WorkspaceList.vue'
import ContextPanel from './components/ContextPanel.vue'
import CommandPalette from './components/CommandPalette.vue'
import PlanDialog from './components/PlanDialog.vue'
import Toast from './components/Toast.vue'
import ConnectionBanner from './components/ConnectionBanner.vue'
import HomeView from './components/HomeView.vue'
import Mark from './components/brand/Mark.vue'
import { activeWorkspace, canLeaveHome, client, openHome, state, guard, requestPlan } from './core/store.js'

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
      <span class="lights" />
      <button class="markbtn" title="Start page" @click="openHome">
        <Mark :height="27" crisp />
      </button>
    </header>

    <ProjectRail />
    <WorkspaceList />
    <ContextPanel />

    <CommandPalette v-if="state.paletteOpen" />
    <PlanDialog v-if="state.pendingPlan" />
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
  gap: 12px;
  padding-left: 10px;
  /* Continuous with the rail below it, so the two read as one chrome surface. */
  background: var(--bg-sunken);
  border-bottom: 1px solid var(--line);
  -webkit-app-region: drag;
}

/* macOS paints its three lights over this; the span only reserves the room. */
.lights {
  width: 52px;
  flex: none;
}

/* Named `markbtn`, not `home` or `brand`: Vue stamps this component's scope id
   onto a child component's root node as well, so a rule here matching a child's
   root class silently restyles that whole component. `.home` is HomeView's root
   and `.brand` is Mark's — either name would have collapsed them into a 40px
   button. */
.markbtn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 30px;
  flex: none;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  -webkit-app-region: no-drag;
  transition:
    background var(--dur-1) var(--ease-soft),
    color var(--dur-1) var(--ease-soft),
    transform var(--dur-1) var(--ease);
}
.markbtn:hover { background: var(--hover); color: var(--text); }
.markbtn:active { transform: scale(0.92); }
</style>
