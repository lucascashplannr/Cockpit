<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import ProjectRail from './components/ProjectRail.vue'
import WorkspaceList from './components/WorkspaceList.vue'
import ContextPanel from './components/ContextPanel.vue'
import CommandPalette from './components/CommandPalette.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import PlanDialog from './components/PlanDialog.vue'
import RevertDialog from './components/RevertDialog.vue'
import ProjectDialog from './components/ProjectDialog.vue'
import NewProjectDialog from './components/NewProjectDialog.vue'
import AddRepoDialog from './components/AddRepoDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import TopicDialog from './components/TopicDialog.vue'
import Toast from './components/Toast.vue'
import ConnectionBanner from './components/ConnectionBanner.vue'
import ReviewTools from './components/ReviewTools.vue'
import TrafficLights from './components/TrafficLights.vue'
import Splitter from './components/Splitter.vue'
import {
  LAYOUT_LIMITS, activeWorkspace, client, state, goTo, guard, keyTargets, layout,
  requestPlan, resetColumnWidth, saveLayout, setColumnWidth,
} from './core/store.js'

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
  if (meta && !e.shiftKey && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    state.paletteOpen = !state.paletteOpen
    return
  }
  if (e.key === 'Escape') {
    if (state.pendingRevert) {
      // Never while it is running: the work is already happening and closing
      // the dialog would only hide its outcome.
      if (!state.pendingRevert.busy) state.pendingRevert = null
    } else if (state.newProjectOpen) state.newProjectOpen = false
    else if (state.addRepoProjectId) state.addRepoProjectId = null
    else if (state.settingsOpen) state.settingsOpen = false
    else if (state.editingProjectId) state.editingProjectId = null
    else if (state.pendingPlan) state.pendingPlan = null
    else if (state.paletteOpen) state.paletteOpen = false
    // Layer by layer back to the conversation, which is the ground state.
    else if (state.historyOpen) state.historyOpen = false
    else if (state.memoryOpen) state.memoryOpen = false
    else if (state.reviewOpen) state.reviewOpen = false
    return
  }
  if (typing) return

  // ⌘1 is the Agent, because the Agent is what the window is for; the review
  // tools follow it. Read from the same list the strips draw, so a number can
  // never land on a tool this workspace does not have. `code` rather than
  // `key`: on an AZERTY keyboard the digit row is shifted and ⌘1 arrives as '&'.
  const digit = /^Digit([1-9])$/.exec(e.code)?.[1] ?? (/^[1-9]$/.test(e.key) ? e.key : null)
  if (meta && digit) {
    const id = keyTargets.value[Number(digit) - 1]
    if (id) {
      e.preventDefault()
      goTo(id)
    }
    return
  }

  const w = activeWorkspace.value
  if (!w) return

  // §3.7 — the same rule the verbs follow: mid-rebase, git refuses both of
  // these, so the keystroke must not fire a plan guaranteed to fail. The
  // conflict panel has the three that do apply.
  const midOperation = !!w.git?.operation

  // Single-key verbs, no modifier: the budget in §12 is one click, and a
  // keystroke is cheaper than a click.
  if (!meta && !e.altKey) {
    if (e.key === 'r' && !midOperation) {
      e.preventDefault()
      void requestPlan(w.id, 'rebase')
    } else if (e.key === 'p' && !midOperation) {
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

/**
 * The grid, from the widths the user chose. Written as an inline style rather
 * than by re-declaring `grid-template-columns` per state: the review column
 * appears and disappears, and one expression that knows both facts is easier
 * to keep true than two rules that must agree.
 */
const shellStyle = computed(() => ({
  gridTemplateColumns:
    `var(--rail-w) ${layout.list}px minmax(0, 1fr)` +
    (state.reviewOpen && activeWorkspace.value ? ` ${layout.review}px` : ''),
}))

onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="shell" :style="shellStyle">
    <!-- No title band. It held the selected thing's name and its verbs, and
         both went down to the column they are about (ContextPanel); what was
         left was fifty pixels of window carrying one search field. The
         traffic lights never needed it — they are drawn, and fixed, and float
         over whatever is beneath them (TrafficLights) — so the columns run to
         the top of the window and the rail simply keeps its head down. -->
    <ProjectRail />
    <WorkspaceList />
    <ContextPanel />
    <!-- Layer 3 as a fourth column, opened on demand. -->
    <ReviewTools
      v-if="state.reviewOpen && activeWorkspace"
      :workspace="activeWorkspace"
      closable
      class="reviewcol"
    />

    <!-- The lines between the columns, over the borders they thicken. Placed
         here rather than inside each column because a splitter belongs to the
         boundary, not to either side of it. -->
    <Splitter
      class="sp"
      :style="{ left: `calc(var(--rail-w) + ${layout.list}px - 3px)` }"
      :size="layout.list"
      :min="LAYOUT_LIMITS.list.min"
      :max="LAYOUT_LIMITS.list.max"
      grows="right"
      label="Width of the workspace list"
      @resize="setColumnWidth('list', $event)"
      @done="saveLayout"
      @reset="resetColumnWidth('list')"
    />
    <Splitter
      v-if="state.reviewOpen && activeWorkspace"
      class="sp"
      :style="{ right: `${layout.review - 3}px` }"
      :size="layout.review"
      :min="LAYOUT_LIMITS.review.min"
      :max="LAYOUT_LIMITS.review.max"
      grows="left"
      label="Width of the review column"
      @resize="setColumnWidth('review', $event)"
      @done="saveLayout"
      @reset="resetColumnWidth('review')"
    />

    <CommandPalette v-if="state.paletteOpen" />
    <PlanDialog v-if="state.pendingPlan" />
    <ConfirmDialog v-if="state.pendingConfirm" />
    <RevertDialog />
    <ProjectDialog />
    <NewProjectDialog />
    <AddRepoDialog />
    <SettingsDialog />
    <TopicDialog />
    <ConnectionBanner />
    <Toast />

    <!-- Over everything: the native buttons are drawn rather than laid out,
         so they float above whatever the window is showing (TrafficLights). -->
    <TrafficLights />
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  height: 100vh;
  background: var(--bg);
  position: relative;
}

/* Layer 3 as a fourth column. The conversation gives up the width, not the
   list: the list is how you got here, and it is also how a chat is opened.
   The columns themselves come from `shellStyle` — the tokens are the defaults
   a fresh install starts from, not the running values. */
.reviewcol { border-left: 1px solid var(--line); background: var(--bg); }

.reviewcol { border-left: 1px solid var(--line); background: var(--bg); }
</style>
