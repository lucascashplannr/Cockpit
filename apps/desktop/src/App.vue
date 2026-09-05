<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import ProjectRail from './components/ProjectRail.vue'
import WorkspaceList from './components/WorkspaceList.vue'
import ContextPanel from './components/ContextPanel.vue'
import ScopeBar from './components/ScopeBar.vue'
import ConflictPanel from './components/ConflictPanel.vue'
import CommandPalette from './components/CommandPalette.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import ImageViewer from './components/ImageViewer.vue'
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
  requestPlan, resetColumnWidth, saveLayout, setColumnWidth, showsAgent, showsReview, stepImage,
  stepView,
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
    // First, because it is on top of everything: a picture opened over a
    // dialog closes back to the dialog, not past it.
    if (state.pendingImage) state.pendingImage = null
    else if (state.pendingRevert) {
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
    // The ground state is the conversation with the whole width, so this is
    // one step and not two: Escape out of a diff you are done reading and the
    // thread is there, not a narrower diff.
    else if (state.view !== 'agent') state.view = 'agent'
    return
  }
  // ← and → step between one turn's pictures. Above the `typing` guard on
  // purpose: the composer may still hold focus behind the scrim, and there is
  // nothing to move a caret in while a picture covers the window.
  if (state.pendingImage && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault()
    stepImage(e.key === 'ArrowRight' ? 1 : -1)
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

  // §12 — the ladder, walked. ⌥ rather than ⇧ because ⌘⇧← is a text selection
  // everywhere in this window, and `code` for the same AZERTY reason the
  // digits are read that way: the arrows are named by position, not by glyph.
  if (meta && e.altKey && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
    e.preventDefault()
    stepView(e.code === 'ArrowRight' ? 1 : -1)
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
  gridTemplateColumns: `var(--rail-w) ${layout.list}px minmax(0, 1fr)`,
}))

/** And the split inside it, which is the only part the ladder moves. */
const panesStyle = computed(() => ({
  gridTemplateColumns: `minmax(0, 1fr)` + (splitReview.value ? ` ${splitReview.value}px` : ''),
}))

const RAIL_W = 72
/** What the conversation keeps in `split`, whatever the review asks for. */
const AGENT_MIN = 360
/** And what the review keeps when even that cannot be paid in full. */
const REVIEW_FLOOR = 240

/** The window's width: the clamp below is a fact about the window. */
const winW = ref(window.innerWidth)
const onResize = () => { winW.value = window.innerWidth }

/** What is left for the review once the rail, the list and the floor are paid. */
const room = computed(() => winW.value - RAIL_W - layout.list - AGENT_MIN)

/** The same ceiling, for the divider — it must not be draggable past it. */
const reviewMax = computed(() =>
  Math.min(LAYOUT_LIMITS.review.max, Math.max(LAYOUT_LIMITS.review.min, room.value)),
)

/**
 * The review column's width in the one view that has to share it — 0 when it
 * has the window to itself, or is not on screen at all.
 *
 * Clamped against the window rather than read straight off the saved layout,
 * and clamped *here* rather than in the grid because the divider has to agree
 * with it. A `1fr` beside a fixed track loses that argument outright: the
 * minimum window is 960 wide, the list goes to 620, and at that pair the two
 * fixed tracks came to more than the window — the conversation was sized to
 * zero and the review drawn off the right-hand edge. The secondary column is
 * the one that should give way, so it is the one that does.
 */
const splitReview = computed(() => {
  if (state.view !== 'split' || !activeWorkspace.value) return 0
  return Math.max(REVIEW_FLOOR, Math.min(layout.review, room.value))
})

onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', onResize)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', onResize)
})
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

    <!-- The right of the window: one bar, then whatever the ladder says is
         under it. The bar is outside the split on purpose — what it carries
         (the checkout's name, its branch, Start, Push, Catch up, Open in IDE)
         is true of the checkout, not of whichever of the two columns happens
         to be on screen, and when it lived inside the conversation's column
         it went off screen with it. -->
    <div class="right">
      <ScopeBar />

      <!-- §3.7 — above both columns, for the same reason: while a rebase is
           stopped, none of what is below is the next thing to do, and that is
           as true of a diff as it is of a thread. Absent otherwise (§3.9). -->
      <ConflictPanel />

      <!-- §12 — the two things the right of the window can be, and the three
           ways to divide it between them. In `split` both are here and the
           divider is real; at either end of the ladder one of them simply is
           not mounted, so the other gets the `1fr` and there is nothing to
           drag. Unmounted rather than hidden: a terminal and a diff behind a
           `display:none` are still a subscription and still a scroll position
           pretending to be a layout. -->
      <div class="panes" :style="panesStyle">
        <ContextPanel v-if="showsAgent" />
        <ReviewTools
          v-if="showsReview"
          :workspace="activeWorkspace!"
          :class="{ reviewcol: state.view === 'split' }"
        />

        <Splitter
          v-if="splitReview"
          class="sp"
          :style="{ right: `${splitReview - 3}px` }"
          :size="splitReview"
          :min="LAYOUT_LIMITS.review.min"
          :max="reviewMax"
          grows="left"
          label="Width of the review column"
          @resize="setColumnWidth('review', $event)"
          @done="saveLayout"
          @reset="resetColumnWidth('review')"
        />
      </div>
    </div>

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
    <CommandPalette v-if="state.paletteOpen" />
    <ImageViewer />
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

/* The right of the window: the bar, then the panes under it. A column rather
   than a grid row, because the bar is as tall as its contents and the panes
   take everything that is left. */
.right { display: flex; flex-direction: column; min-width: 0; min-height: 0; }

/* Where the ladder actually happens. `position: relative` for the drawer that
   hangs from the underside of the bar, and for the divider between the two. */
.panes {
  position: relative;
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-rows: minmax(0, 1fr);
}

/* Layer 3 beside the conversation. The conversation gives up the width, not
   the list: the list is how you got here, and it is also how a chat is
   opened. The widths themselves come from `panesStyle` — the tokens are the
   defaults a fresh install starts from, not the running values. */
.reviewcol { border-left: 1px solid var(--line); background: var(--bg); }
</style>
