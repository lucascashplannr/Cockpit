<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import ProjectRail from './components/ProjectRail.vue'
import WorkspaceList from './components/WorkspaceList.vue'
import ContextPanel from './components/ContextPanel.vue'
import CommandPalette from './components/CommandPalette.vue'
import PlanDialog from './components/PlanDialog.vue'
import ProjectDialog from './components/ProjectDialog.vue'
import NewProjectDialog from './components/NewProjectDialog.vue'
import AddRepoDialog from './components/AddRepoDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import TopicDialog from './components/TopicDialog.vue'
import Toast from './components/Toast.vue'
import ConnectionBanner from './components/ConnectionBanner.vue'
import HomeView from './components/HomeView.vue'
import ReviewTools from './components/ReviewTools.vue'
import WorkspaceActions from './components/WorkspaceActions.vue'
import TopicActions from './components/TopicActions.vue'
import WorkspaceTitle from './components/WorkspaceTitle.vue'
import GlobalSearch from './components/GlobalSearch.vue'
import TrafficLights from './components/TrafficLights.vue'
import ColumnSplitter from './components/ColumnSplitter.vue'
import {
  LAYOUT_LIMITS, activeWorkspace, canLeaveHome, client, state, goTo, guard, keyTargets, layout,
  requestPlan, resetColumnWidth, saveLayout, selectedTopicGroup, setColumnWidth,
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
    if (state.newProjectOpen) state.newProjectOpen = false
    else if (state.addRepoProjectId) state.addRepoProjectId = null
    else if (state.settingsOpen) state.settingsOpen = false
    else if (state.editingProjectId) state.editingProjectId = null
    else if (state.pendingPlan) state.pendingPlan = null
    else if (state.paletteOpen) state.paletteOpen = false
    // Layer by layer back to the conversation, which is the ground state.
    else if (state.historyOpen) state.historyOpen = false
    else if (state.memoryOpen) state.memoryOpen = false
    else if (state.reviewOpen) state.reviewOpen = false
    else if (state.homeOpen && canLeaveHome.value) state.homeOpen = false
    return
  }
  if (typing) return

  // The start page covers the shell, so the shell's shortcuts would act on
  // something nobody can see. Only ⌘K and Escape, handled above, cross it.
  if (state.homeOpen) return

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
    <!-- One band across the top, the way macOS apps carry their chrome: the
         traffic lights and the mark on a single row rather than stacked in a
         60px-wide rail. The lights grey out when the window loses focus, and
         the mark beside them keeps the corner from reading as empty. -->
    <header class="titlebar">
      <span class="lead" />
      <div class="title"><WorkspaceTitle /></div>
      <span class="grow" />
      <!-- ⌘K is not about the selected workspace, so it is not in its column:
           it searches everything, and it sits in the window's own chrome. -->
      <GlobalSearch />
      <span class="grow" />
      <!-- The verbs of whatever is selected. A topic is selectable too, and
           when it is the one selected, these are its verbs (§4). -->
      <TopicActions v-if="selectedTopicGroup" :group="selectedTopicGroup" />
      <WorkspaceActions v-else />
    </header>

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
    <ColumnSplitter
      class="sp"
      :style="{ left: `calc(var(--rail-w) + ${layout.list}px - 3px)` }"
      :width="layout.list"
      :min="LAYOUT_LIMITS.list.min"
      :max="LAYOUT_LIMITS.list.max"
      grows="right"
      label="Width of the workspace list"
      @resize="setColumnWidth('list', $event)"
      @done="saveLayout"
      @reset="resetColumnWidth('list')"
    />
    <ColumnSplitter
      v-if="state.reviewOpen && activeWorkspace"
      class="sp"
      :style="{ right: `${layout.review - 3}px` }"
      :width="layout.review"
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
    <ProjectDialog />
    <NewProjectDialog />
    <AddRepoDialog />
    <SettingsDialog />
    <TopicDialog />
    <ConnectionBanner />
    <Toast />

    <!-- Last, and over everything: the start page is the whole window. -->
    <HomeView v-if="state.homeOpen" />


    <!-- Over even that: the native buttons floated above the start page, and
         these stand in for them (see TrafficLights). -->
    <TrafficLights />
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-rows: var(--titlebar-h) minmax(0, 1fr);
  height: 100vh;
  background: var(--bg);
  position: relative;
}

/* Layer 3 as a fourth column. The conversation gives up the width, not the
   list: the list is how you got here, and it is also how a chat is opened.
   The columns themselves come from `shellStyle` — the tokens are the defaults
   a fresh install starts from, not the running values. */
.reviewcol { border-left: 1px solid var(--line); background: var(--bg); }

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
/* Two of them, so the search field lands in the middle of the band rather
   than against whichever side has less in it. */
.grow { flex: 1; min-width: 12px; }

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

/* Between the title and the verbs the band is one flex row, and every part of
   it has to be able to give width back. */
.titlebar > * { min-width: 0; }
</style>
