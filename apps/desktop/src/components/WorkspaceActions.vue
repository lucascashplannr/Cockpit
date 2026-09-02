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
 * something to push, Catch up while the branch is behind. Everything this
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
 * §3.9 — while a rebase is stopped, Catch up and Push are not verbs this
 * repository has: git refuses both, and the three that do apply are in the
 * conflict panel. Absent, not greyed out.
 */
const git = computed(() => (w.value?.git?.operation ? null : (w.value?.git ?? null)))

/**
 * `starting` counts as running: a server still coming up is one you stop, not
 * one you start again. Offering Start there is how two of the same server end
 * up fighting over one port.
 */
/**
 * The base named rather than implied — "Catch up from dev" says which way the
 * code moves, which "Rebase" never did. Falls back to the generic noun rather
 * than inventing a branch name when the probe has not answered yet.
 */
/**
 * §3.9 — the same rule the topic bar got: nothing to push, nothing to press.
 *
 * A branch with no upstream is not "nothing to push" even at zero commits
 * ahead — it has never been sent anywhere, and `git push -u` is what sends it.
 * That is the one case where the counter reads 0 and the verb still means
 * something.
 */
const canPush = computed(() => {
  const g = git.value
  return !!g && (g.ahead > 0 || !g.upstream)
})

/** Honest in both states, and when it is off it says why. */
const pushTitle = computed(() => {
  const g = w.value?.git
  if (!g) return 'Push this branch'
  if (g.ahead) return 'Push this branch — ' + g.ahead + ' commit(s) ahead'
  return g.upstream
    ? 'Nothing to push: ' + g.upstream + ' already has this branch'
    : 'Push this branch — no upstream yet, this would set one'
})

/**
 * `behindBase`, not `behind`: the second is this branch against its own remote,
 * which is a different question and stops being the base's distance the moment
 * the branch is pushed. Catch up replays onto the base, so it counts the base.
 */
const behindBase = computed(() => git.value?.behindBase ?? 0)

const catchUpTitle = computed(() => {
  const g = w.value?.git
  const from = g?.base ? 'Catch up from ' + g.base : 'Catch up with the base'
  if (!g) return from
  const n = g.behindBase ?? 0
  return n ? from + ' — ' + n + ' commit(s) behind' : from + ' — already up to date'
})

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

    <!-- Always, wherever there is a branch to push.
         Push is the one git verb that is never a surprise and never contextual
         — you reach for it because you decided to, not because the window
         noticed something. Hiding it until the app agreed there was something
         to send made it the only verb you had to go looking for, in a menu
         labelled "everything else". It is present either way — and inert when
         there is nothing to send, because a verb that is always live is one
         whose only answer half the time is a dialog saying "no".

         The tooltip is on the wrapper: a disabled button fires no mouse
         events, so a `title` on it is a reason nobody can read. -->
    <span v-if="git" class="verb" :title="pushTitle">
      <button
        class="btn ghost"
        :class="{ ready: canPush }"
        :disabled="busy || !canPush"
        @click="requestPlan(w.id, 'push')"
      >
        <ArrowUpFromLine /><span class="vl">Push</span>
        <span v-if="git.ahead" class="cnt">{{ git.ahead }}</span>
      </button>
    </span>
    <!-- Permanent, like Push and for the same reason: a verb reached for this
         often must not move, and a bar that changes shape as probes come back
         is one you cannot aim at without looking. -->
    <button
      v-if="git"
      class="btn ghost"
      :class="{ nudge: behindBase > 0 }"
      :disabled="busy"
      :title="catchUpTitle"
      @click="requestPlan(w.id, 'rebase')"
    >
      <GitCompareArrows /><span class="vl">Catch up</span>
      <span v-if="behindBase" class="cnt">{{ behindBase }}</span>
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
/* Carries the tooltip for the button inside it, which may be disabled and
   would then never be hovered at all. */
.verb { display: inline-flex; }
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
/* The number that used to be the reason the button appeared at all. It now
   rides on a button that is always there, so it carries the signal instead. */
.verbs .cnt {
  font-variant-numeric: tabular-nums;
  font-size: var(--fs-xs);
  color: var(--ok);
}
.verbs .nudge .cnt { color: var(--warn); }

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
