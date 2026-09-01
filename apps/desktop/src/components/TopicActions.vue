<script setup lang="ts">
import { computed } from 'vue'
import { GitCompareArrows, GitMerge, Pause, Play } from '@lucide/vue'
import type { ListGroup } from '../core/store.js'
import { startTopic, mergeTopic, stopTopic, rebaseTopic } from '../core/store.js'

/**
 * §4 — the verbs of the selected topic, on the bar of the column it is about.
 *
 * All three are permanent, and that is the point: on a topic you reach for
 * Catch up and Send to as often as you reach for Start, and a verb you use
 * that often must not move. Drawing them only when the window judged them
 * "the next thing to do" meant the bar changed shape under you — the button
 * you were going for was in the menu this time, because a probe had decided
 * you were level with the base.
 *
 * They are never disabled, only quiet: the count and the colour say whether
 * there is anything to do, and clicking with nothing to do produces a plan
 * that says so, which is the honest answer and costs one dialog (§3.7).
 *
 * The agent is not among them: selecting the topic already aimed the
 * conversation at it.
 */

const props = defineProps<{ group: ListGroup }>()

const f = computed(() => props.group.topic)
const ws = computed(() => props.group.workspaces)

const ahead = computed(() => ws.value.reduce((n, w) => n + (w.git?.ahead ?? 0), 0))
const behind = computed(() => ws.value.reduce((n, w) => n + (w.git?.behind ?? 0), 0))
/** Uncommitted work: merging refuses over it, so the button says so up front. */
const dirty = computed(() =>
  ws.value.reduce((n, w) => n + (w.git?.staged ?? 0) + (w.git?.unstaged ?? 0), 0),
)

/**
 * §8 + §11 — the switch, and it is the same switch a repository has: stopped
 * means the branches are on disk and agents may still run in them, started
 * means the servers are up and the ports are bound. Only a topic Cockpit
 * actually opened has somewhere to keep that state, so an inferred one gets no
 * toggle (§3.9 — absent, not disabled).
 */
const togglable = computed(() => !!f.value && !f.value.derived && f.value.state !== 'closed')

/**
 * §4 — the base this topic goes back onto, named rather than implied.
 *
 * Read off the first repository that knows one: a topic's repositories are
 * forked from the same base in every case Cockpit creates, and a label saying
 * "Send to dev" is the whole point of the rename — "Merge" and "Rebase" never
 * said which way the code was moving, which is the complaint they were
 * renamed for.
 */
const base = computed(() => ws.value.find((w) => w.git?.base)?.git?.base ?? null)

/** Falls back to the generic noun rather than inventing a branch name. */
const sendLabel = computed(() => (base.value ? 'Send to ' + base.value : 'Send to the base'))
const catchUpFrom = computed(() => (base.value ? 'from ' + base.value : 'from the base'))

const mergeTitle = computed(() => {
  if (dirty.value) return 'Commit first — sending refuses over uncommitted changes'
  if (!ahead.value) return sendLabel.value + ' — nothing committed to send yet'
  return sendLabel.value + ' — ' + ahead.value + ' commit(s), one --no-ff merge per repository'
})

const catchUpTitle = computed(() =>
  behind.value
    ? 'Catch up every repository ' + catchUpFrom.value + ' — ' + behind.value + ' commit(s) behind'
    : 'Catch up every repository ' + catchUpFrom.value + ' — already up to date',
)

async function toggle() {
  const topic = f.value
  if (!topic) return
  if (topic.state === 'running') await stopTopic(topic.id)
  else await startTopic(topic.id)
}
</script>

<template>
  <div v-if="togglable" class="verbs">
    <!-- Always: it is the switch. -->
    <button
      class="btn ghost sw"
      :class="{ on: f!.state === 'running' }"
      :title="f!.state === 'running'
        ? 'Stop the servers — the branches stay where they are'
        : 'Start the servers for every repository in this topic'"
      @click="toggle"
    >
      <component :is="f!.state === 'running' ? Pause : Play" />
      <span class="vl">{{ f!.state === 'running' ? 'Stop' : 'Start' }}</span>
    </button>

    <!-- §4 — the step the lifecycle was missing: the branch goes onto the
         base, in every repository the topic spans. Green once there is
         something committed to send and nothing in the way of sending it. -->
    <button
      class="btn ghost"
      :class="{ ready: ahead && !dirty }"
      :title="mergeTitle"
      @click="mergeTopic(f!.id, false)"
    >
      <GitMerge /><span class="vl">{{ sendLabel }}</span>
      <span v-if="ahead" class="cnt">{{ ahead }}</span>
    </button>
    <!-- One plan across every repository it spans, stopping at the first
         conflict and keeping what already replayed. -->
    <button
      class="btn ghost"
      :class="{ nudge: behind > 0 }"
      :title="catchUpTitle"
      @click="rebaseTopic(f!.id)"
    >
      <GitCompareArrows /><span class="vl">Catch up</span>
      <span v-if="behind" class="cnt">{{ behind }}</span>
    </button>
  </div>
</template>

<style scoped>
/* Sized for the column bar rather than for the window's title band: the same
   height as the instruments beside them, so the row reads as one strip of
   controls and not as verbs visiting from somewhere else. */
.verbs {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
}
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
/* What used to be the reason the button appeared at all. The button is always
   there now, so the number is what carries the signal. */
.verbs .cnt {
  font-variant-numeric: tabular-nums;
  font-size: var(--fs-xs);
  color: var(--ok);
}
.verbs .nudge .cnt { color: var(--warn); }

/* Behind its base is the one state where rebasing is the next thing to do.
   Committed and ahead is the one where merging is. */
.nudge { color: var(--warn); }
.ready { color: var(--ok); }
.verbs .btn.on { color: var(--ok); }

/* Narrow column: the switch drops its word — its icon is a play triangle and
   nothing else here is. The promoted git verbs keep theirs, which is the whole
   reason they were promoted. */
@container (max-width: 620px) {
  .verbs .btn.sw .vl { display: none; }
  .verbs .btn { padding: 0 6px; }
}
</style>
