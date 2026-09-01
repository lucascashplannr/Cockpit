<script setup lang="ts">
import { computed } from 'vue'
import {
  AppWindow, ArrowUpFromLine, CirclePlay, CircleStop, FileCode, GitCompareArrows, Undo2,
} from '@lucide/vue'
import OverflowMenu from './OverflowMenu.vue'
import {
  activeWorkspace, client, gitBusy, guard, requestPlan, toggleWorkspaceRuntime,
} from '../core/store.js'

/**
 * The verbs for the selected repository, on the bar of the column it is about.
 *
 * All five of them used to be drawn at once, as bare icons on a bar that was
 * already carrying the name, the branch, the counters, the servers and the
 * conversation's own instruments — eleven controls of one shape, and the bar
 * wrapped onto a second line to fit them. Nothing there was wrong; there was
 * simply no ranking, so the eye had to hover the row to read it.
 *
 * The ranking is the state itself (§3.9, one step further): the servers'
 * switch is always the one act you came for, Push appears while there is
 * something to push, Rebase while the branch is behind. Everything this
 * repository can do is in the menu beside them, named, in a fixed order — so
 * the bar gets quieter as the work gets calmer, and nothing is ever gone.
 */

const w = computed(() => activeWorkspace.value)

/**
 * A plan is running on this repository, so none of these are verbs it has
 * right now — including Start, because a server booting out of a working tree
 * that is mid-switch reads whichever half of the branch it happens to catch.
 */
const busy = computed(() => !!(w.value && gitBusy[w.value.id]))
const preview = computed(() => w.value?.runtime?.preview ?? null)

/**
 * §3.9 — while a rebase is stopped, Rebase and Push are not verbs this
 * repository has: git refuses both, and the three that do apply are in the
 * conflict panel. Absent, not greyed out.
 */
const git = computed(() => (w.value?.git?.operation ? null : (w.value?.git ?? null)))

/**
 * `starting` counts as running: a server still coming up is one you stop, not
 * one you start again. Offering Start there is how two of the same server end
 * up fighting over one port.
 */
const running = computed(
  () => w.value?.runtime?.status === 'up' || w.value?.runtime?.status === 'starting',
)

/** One path for the bar and the row alike, so they cannot come to disagree
 *  about what starting a server means or what to say when it fails. */
async function toggleRuntime() {
  const ws = w.value
  if (ws) await toggleWorkspaceRuntime(ws)
}

async function openIde() {
  const ws = w.value
  if (!ws) return
  await guard(() => client.call('workspace.openIn', { workspaceId: ws.id, target: 'ide' }))
}

async function openPreview() {
  const ws = w.value
  if (!ws) return
  await guard(() => client.call('workspace.openIn', { workspaceId: ws.id, target: 'browser' }))
}

async function undo() {
  const ws = w.value
  if (!ws) return
  await guard(() => client.call('git.undo', { workspaceId: ws.id }))
}
</script>

<template>
  <div v-if="w" class="verbs">
    <!-- Always: it is the switch, and it is what the window is open for. -->
    <button
      v-if="w.runtime"
      class="btn ghost sw"
      :class="{ on: running }"
      :disabled="busy"
      :title="running ? 'Stop the servers' : 'Start the servers'"
      @click="toggleRuntime"
    >
      <component :is="running ? CircleStop : CirclePlay" />
      <span class="vl">{{ w.runtime.status === 'starting' ? 'Starting' : running ? 'Stop' : 'Start' }}</span>
    </button>

    <!-- Only while it is the next thing to do. Both stay in the menu, so this
         is a promotion rather than the only way to reach them. -->
    <button
      v-if="git?.ahead"
      class="btn ghost ready"
      :disabled="busy"
      :title="'Push this branch — ' + git.ahead + ' commit(s) ahead'"
      @click="requestPlan(w.id, 'push')"
    >
      <ArrowUpFromLine /><span class="vl">Push</span>
    </button>
    <button
      v-if="git?.behind"
      class="btn ghost nudge"
      :disabled="busy"
      :title="'Rebase onto the base branch — ' + git.behind + ' commit(s) behind'"
      @click="requestPlan(w.id, 'rebase')"
    >
      <GitCompareArrows /><span class="vl">Rebase</span>
    </button>

    <OverflowMenu label="Everything else you can do here" :disabled="busy">
      <button v-if="preview && preview.kind === 'url'" @click="openPreview">
        <AppWindow /> Open the preview
      </button>
      <button @click="openIde">
        <FileCode /> Open in the editor <span class="kb">O</span>
      </button>
      <template v-if="git">
        <span class="rule" />
        <button @click="requestPlan(w.id, 'rebase')">
          <GitCompareArrows /> Rebase onto the base <span class="kb">R</span>
        </button>
        <button @click="requestPlan(w.id, 'push')">
          <ArrowUpFromLine /> Push this branch <span class="kb">P</span>
        </button>
        <span class="rule" />
        <button @click="undo">
          <Undo2 /> Undo to the last restore point
        </button>
      </template>
    </OverflowMenu>
  </div>
</template>

<style scoped>
.verbs {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
}
/* Sized for the column bar rather than for a 50px band: the same height as the
   instruments beside them, so the row reads as one strip of controls and not
   as verbs visiting from somewhere else. */
.verbs .btn {
  height: 26px;
  padding: 0 9px;
  font-size: var(--fs-xs);
  gap: 6px;
  border-color: transparent;
  background: transparent;
  box-shadow: none;
  color: var(--text-muted);
}
.verbs .btn:hover:not(:disabled) { background: var(--hover); color: var(--text); }
.verbs .btn .lucide { width: 14px; height: 14px; }

/* Behind its base is the one state where rebasing is the next thing to do,
   and committed-and-ahead is the one where pushing is. Same two colours the
   list's counters use for the same two facts. */
.nudge { color: var(--warn); }
.ready { color: var(--ok); }
.verbs .btn.on { color: var(--ok); }

/* Narrow column: the promoted verbs keep their labels — they are one or two,
   and a word is the whole reason they were promoted. The label the bar drops
   first is Start's, because its icon is a play triangle and nothing else here
   is. */
@container (max-width: 620px) {
  .verbs .btn.sw .vl { display: none; }
  .verbs .btn { padding: 0 6px; }
}
</style>
