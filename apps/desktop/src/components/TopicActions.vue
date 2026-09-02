<script setup lang="ts">
import { computed } from 'vue'
import { ArrowUp, GitCompareArrows, GitMerge, Pause, Play } from '@lucide/vue'
import type { ListGroup } from '../core/store.js'
import { startTopic, mergeTopic, pushTopic, stopTopic, rebaseTopic } from '../core/store.js'

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
 * Send and Push go quiet *and* stop taking clicks when there is nothing to
 * send or push. They used to stay live on the argument that a plan saying
 * "nothing to do" is the honest answer and costs one dialog — true, and it
 * turned out to be one dialog too many: these two sit next to Start, they are
 * pressed on reflex, and a modal that exists only to say "no" trains people to
 * dismiss modals. The count and the colour already said it; the button now
 * agrees with them.
 *
 * The tooltip is on the wrapper rather than the button: a disabled button
 * fires no mouse events, so a `title` on it is a reason nobody can read.
 *
 * The agent is not among them: selecting the topic already aimed the
 * conversation at it.
 */

const props = defineProps<{ group: ListGroup }>()

const f = computed(() => props.group.topic)
const ws = computed(() => props.group.workspaces)

const ahead = computed(() => ws.value.reduce((n, w) => n + (w.git?.ahead ?? 0), 0))
/**
 * §4 — what Send would land, summed. `ahead` is against each branch's own
 * remote and says nothing about the base: push the topic and it reads zero
 * while every commit in it is still unmerged.
 */
const toLand = computed(() =>
  ws.value.reduce((n, w) => n + (w.git?.aheadOfBase ?? 0), 0),
)
/** A repository that cannot tell keeps the button live — see `aheadOfBase`. */
const landUnknown = computed(() =>
  ws.value.some((w) => !!w.repo && !!w.git && w.git.aheadOfBase === null),
)
/**
 * §4 — what Catch up would replay onto, summed, and `behindBase` rather than
 * `behind` for the same reason Send counts `aheadOfBase`: `behind` is measured
 * against whatever `upstream` happens to be, and a topic branch tracks
 * `origin/<base>` only until the first push. After it this read zero while the
 * base had moved on — the one button whose job is to notice.
 */
const behind = computed(() => ws.value.reduce((n, w) => n + (w.git?.behindBase ?? 0), 0))
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
  if (!canMerge.value) return 'Nothing to send: ' + (base.value ?? 'the base') + ' already has it all'
  if (dirty.value) return 'Commit first — sending refuses over uncommitted changes'
  return sendLabel.value + ' — ' + toLand.value + ' commit(s), one --no-ff merge per repository'
})

/**
 * §16 — `topic.push` skips a repository that is level with its remote, and
 * pushes one that has no upstream yet whatever its count says: a branch nobody
 * has ever pushed is not "nothing to push", it is the first push. This has to
 * agree with that or the button lies about what the plan would do.
 */
const canPush = computed(() =>
  ws.value.some((w) => !!w.repo && !!w.git && (w.git.ahead > 0 || !w.git.upstream)),
)

/** Nothing committed yet is nothing to land. Uncommitted work is a different
 *  answer — there *is* something to send, and the plan says what is in the way,
 *  which is worth a dialog in a way that "no" is not. */
const canMerge = computed(() => toLand.value > 0 || landUnknown.value)

const catchUpTitle = computed(() =>
  behind.value
    ? 'Catch up every repository ' + catchUpFrom.value + ' — ' + behind.value + ' commit(s) behind'
    : 'Catch up every repository ' + catchUpFrom.value + ' — already up to date',
)

/**
 * §16 — the one verb that leaves the machine, so it says how far it reaches.
 *
 * Committing is per repository now: one message cannot honestly describe two
 * different diffs. A push carries no message, which is exactly why it can be
 * the topic-wide verb the commit box stopped being.
 */
const pushTitle = computed(() =>
  canPush.value
    ? 'Push every branch of this topic to origin' +
      (ahead.value ? ' — ' + ahead.value + ' commit(s)' : ' — one has never been pushed')
    : 'Nothing to push: every branch is level with its remote',
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

    <!-- The counterpart of a per-repository commit: nothing about a push is
         specific to one repository's diff, so it is one act across all of
         them. -->
    <span class="verb" :title="pushTitle">
      <button
        class="btn ghost"
        :class="{ nudge: canPush }"
        :disabled="!canPush"
        @click="pushTopic(f!.id)"
      >
        <ArrowUp /><span class="vl">Push</span>
        <span v-if="ahead" class="cnt">{{ ahead }}</span>
      </button>
    </span>

    <!-- §4 — the step the lifecycle was missing: the branch goes onto the
         base, in every repository the topic spans. Green once there is
         something committed to send and nothing in the way of sending it. -->
    <span class="verb" :title="mergeTitle">
      <button
        class="btn ghost"
        :class="{ ready: canMerge && !dirty }"
        :disabled="!canMerge"
        @click="mergeTopic(f!.id, false)"
      >
        <GitMerge /><span class="vl">{{ sendLabel }}</span>
        <span v-if="toLand" class="cnt">{{ toLand }}</span>
      </button>
    </span>
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
/* Carries the tooltip for the button inside it, which may be disabled and
   would then never be hovered at all. */
.verb { display: inline-flex; }
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
