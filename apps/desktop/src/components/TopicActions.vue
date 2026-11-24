<script setup lang="ts">
import { computed, onUnmounted, watch } from 'vue'
import { ArrowUp, GitCompareArrows, GitMerge, GitPullRequest, GitPullRequestCreate, LoaderCircle, TriangleAlert } from '@lucide/vue'
import OverflowMenu from './OverflowMenu.vue'
import ServerSwitch from './ServerSwitch.vue'
import type { ListGroup } from '../core/store.js'
import {
  busyAmong, busyVerb, busyWord, mergeTopic, pushCount, pushTopic, rebaseTopic, rerunTopicSetup, showSetupLog, state,
  askMergePr, askOpenPr, landingOf, openPrPage, prBusy, prStatus, refreshReview, topicStops,
} from '../core/store.js'

/**
 * §4 — the verbs of the selected topic, on the bar of the column it is about.
 *
 * §3.9 — Push and Send are on the bar only while there is something to push
 * or to send, the rule a repository's bar follows. They stood here greyed for
 * a while, so that nothing would move; two inert verbs on a topic with nothing
 * committed turned out to be most of what the bar said. Catch up stays, as the
 * one you press to find out.
 *
 * The agent is not among them: selecting the topic already aimed the
 * conversation at it.
 */

const props = defineProps<{ group: ListGroup }>()

const f = computed(() => props.group.topic)
const ws = computed(() => props.group.workspaces)

/**
 * A plan running aside in any of the topic's repositories — a commit in one of
 * them, or the topic's own push. Its verbs are off for as long as it takes,
 * and the one that is running says so on its own button.
 */
const busyOp = computed(() => busyAmong(ws.value.map((w) => w.id)))
const op = computed(() => busyVerb(busyOp.value ?? undefined))

const ahead = computed(() => ws.value.reduce((n, w) => n + pushCount(w.git), 0))

/**
 * §3.7 — a merge or a rebase stopped in one of the topic's repositories, or in
 * the main checkout Send merges in. Until it ends, Push, Send and Catch up are
 * verbs git refuses, so they are not on the bar at all: the conflict panel
 * under it has the ones that apply.
 */
const stopped = computed(() => (f.value ? topicStops(f.value.id).length > 0 : false))

/* ── §5 — where the project lands by pull request ─────────────────────────
 *
 * Send to gives way to the request: Open PR while there is none, then the
 * request itself — its number, and the one thing about it that wants you
 * (conflicts, failing checks, changes asked for, approved). Resolve brings
 * the base in by merge when it conflicts; Merge is there only on a project
 * that merges its own requests.
 */
const landing = computed(() => landingOf(f.value?.projectId))
const repoIds = computed(() => ws.value.filter((w) => !!w.repo).map((w) => w.id))
/** A repository on neither host has nothing to open a request on: Send to stays. */
const hostless = computed(() => {
  const rs = repoIds.value.map((id) => prStatus[id]).filter((r) => !!r)
  return rs.length > 0 && rs.every((r) => !r.host)
})
const asksPr = computed(() => landing.value.landing === 'pr')
const byPr = computed(() => asksPr.value && !hostless.value)

let timer: ReturnType<typeof setInterval> | null = null
watch(
  () => (asksPr.value ? repoIds.value.join(',') : ''),
  (ids) => {
    if (timer) clearInterval(timer)
    timer = null
    if (!ids) return
    void refreshReview(repoIds.value)
    timer = setInterval(() => void refreshReview(repoIds.value), 60_000)
  },
  { immediate: true },
)
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

const reviews = computed(() => ws.value.map((w) => prStatus[w.id]).filter((r) => !!r))
const live = computed(() => reviews.value.filter((r) => r.pr && (r.pr.state === 'open' || r.pr.state === 'draft')).map((r) => r.pr!))
const merged = computed(() => (live.value.length ? [] : reviews.value.filter((r) => r.pr?.state === 'merged').map((r) => r.pr!)))
const reviewError = computed(() => reviews.value.find((r) => r.error)?.error ?? null)
const prConflicts = computed(() => live.value.some((p) => p.conflicts))

/** The one word the chip says, in the order things want you. */
const prWord = computed(() => {
  const ps = live.value
  if (prConflicts.value) return { cls: 'bad', text: 'Conflicts' }
  if (ps.some((p) => p.checks === 'failing')) return { cls: 'bad', text: 'Checks failing' }
  if (ps.some((p) => p.review === 'changes')) return { cls: 'warn', text: 'Changes asked' }
  if (ps.length && ps.every((p) => p.review === 'approved')) return { cls: 'good', text: 'Approved' }
  if (ps.some((p) => p.checks === 'pending')) return { cls: '', text: 'Checks running' }
  if (ps.some((p) => p.state === 'draft')) return { cls: '', text: 'Draft' }
  return { cls: '', text: 'In review' }
})
const prLabel = computed(() => (live.value.length === 1 ? '#' + live.value[0]!.number : live.value.length + ' PRs'))
const prTitle = computed(() =>
  live.value
    .map((p) =>
      '#' + p.number + ' ' + p.title + '\n' + p.source + ' into ' + p.target +
      [p.review === 'approved' ? 'approved' : p.review === 'changes' ? 'changes requested' : p.review === 'waiting' ? 'waiting for review' : null,
       p.checks ? 'checks ' + p.checks : null,
       p.conflicts ? 'conflicts with ' + p.target : null].filter(Boolean).map((x) => '\n' + x).join(''),
    )
    .join('\n\n') + '\n\nOpen on ' + (live.value[0]?.host === 'bitbucket' ? 'Bitbucket' : 'GitHub'),
)
const canMergePr = computed(
  () => landing.value.mergeHere && live.value.length > 0 && !prConflicts.value && live.value.every((p) => p.state === 'open'),
)
function openPrs(): void {
  for (const p of live.value) openPrPage(p.url)
}
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
  ws.value.some(
    (w) =>
      !!w.repo && !!w.git && w.git.hasRemote !== false &&
      (w.git.ahead > 0 || !w.git.upstream || w.git.published === false),
  ),
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
const pushTitle = computed(
  () =>
    'Push every branch of this topic to origin' +
    (ahead.value ? ' — ' + ahead.value + ' commit(s)' : ' — one has never been pushed'),
)

/* ── what the topic runs (§8) — see ServerSwitch ──────────────────── */

/** The topic's folder, which is the checkout the project's declarations run in. */
const folder = computed(
  () => state.workspaces.find((w) => w.kind === 'group' && w.topicId === f.value?.id) ?? null,
)

/* ── the worktrees' setup (§7) ─────────────────────────────────────────
 *
 * `worktrees.setup` runs once the topic's folders exist. While it runs the
 * bar says so, and Start waits for it; when a line fails the topic stays, and
 * the chip is the way to run it again once the line is fixed.
 */
const prep = computed(() => f.value?.preparing ?? null)
const prepTitle = computed(() => {
  const p = prep.value
  if (!p) return ''
  // A repository can fail while another is still installing: both are said.
  const lines = [
    ...p.steps.filter((s) => s.state === 'running').map((s) => s.repo + ': ' + s.command),
    ...p.steps
      .filter((s) => s.state === 'failed')
      .map((s) => s.repo + ': ' + s.command + ' failed' + (s.detail ? '\n' + s.detail : '')),
  ]
  return lines.join('\n\n') + '\n\n' + (p.state === 'running' ? 'Click to see its output' : 'Click to run it again')
})

</script>

<template>
  <div v-if="togglable" class="verbs">
    <!-- The counterpart of a per-repository commit: nothing about a push is
         specific to one repository's diff, so it is one act across all of
         them. -->
    <template v-if="!stopped">
    <button
      v-if="canPush || op === 'push'"
      class="btn ghost nudge"
      :class="{ working: op === 'push' }"
      :disabled="!!busyOp"
      :title="op === 'push' ? 'Pushing…' : pushTitle"
      @click="pushTopic(f!.id)"
    >
      <template v-if="op === 'push'"><LoaderCircle class="spin" /><span class="vl">Pushing…</span></template>
      <template v-else>
        <ArrowUp /><span class="vl">Push</span>
        <span v-if="ahead" class="cnt">{{ ahead }}</span>
      </template>
    </button>

    <!-- §5 — the pull request, on a project that lands through one. -->
    <template v-if="byPr">
      <template v-if="live.length">
        <button class="btn ghost prchip" :class="prWord.cls" :title="prTitle" @click="openPrs">
          <GitPullRequest /><span class="vl">{{ prLabel }}</span><span class="pw">{{ prWord.text }}</span>
        </button>
        <button
          v-if="prConflicts"
          class="btn ghost nudge"
          :disabled="!!busyOp"
          :title="'Merge ' + (base ?? 'the base') + ' into the branch and resolve here, then push. Nothing the reviewer read is rewritten.'"
          @click="rebaseTopic(f!.id)"
        >
          <GitCompareArrows /><span class="vl">Resolve</span>
        </button>
        <button
          v-else-if="canMergePr"
          class="btn ghost ready"
          :disabled="!!busyOp || !!prBusy"
          title="Merge on the host with a merge commit"
          @click="askMergePr(ws)"
        >
          <LoaderCircle v-if="prBusy === 'merge'" class="spin" /><GitMerge v-else /><span class="vl">Merge</span>
        </button>
      </template>
      <button
        v-else-if="canMerge"
        class="btn ghost"
        :class="{ ready: !dirty }"
        :disabled="!!busyOp || !!prBusy || dirty > 0"
        :title="dirty ? 'Commit first: a pull request carries commits, not uncommitted changes' : reviewError ?? 'Push and open a pull request into ' + (base ?? 'the base')"
        @click="askOpenPr(f!.name, ws)"
      >
        <LoaderCircle v-if="prBusy === 'open'" class="spin" /><GitPullRequestCreate v-else /><span class="vl">Open PR</span>
        <span v-if="toLand" class="cnt">{{ toLand }}</span>
      </button>
      <button
        v-else-if="merged.length"
        class="btn ghost prchip good"
        :title="'Merged into ' + merged[0]!.target + '. Open on the host'"
        @click="openPrPage(merged[0]!.url)"
      >
        <GitMerge /><span class="vl">#{{ merged[0]!.number }}</span><span class="pw">Merged</span>
      </button>
    </template>

    <!-- §4 — the step the lifecycle was missing: the branch goes onto the
         base, in every repository the topic spans. Green once there is
         something committed to send and nothing in the way of sending it. -->
    <button
      v-if="!byPr && (canMerge || op === 'merge')"
      class="btn ghost"
      :class="{ ready: !dirty, working: op === 'merge' }"
      :disabled="!!busyOp"
      :title="op === 'merge' ? 'Merging…' : mergeTitle"
      @click="mergeTopic(f!.id, false)"
    >
      <template v-if="op === 'merge'"><LoaderCircle class="spin" /><span class="vl">Merging…</span></template>
      <template v-else>
        <GitMerge /><span class="vl">{{ sendLabel }}</span>
        <span v-if="toLand" class="cnt">{{ toLand }}</span>
      </template>
    </button>
    <!-- One plan across every repository it spans, stopping at the first
         conflict and keeping what already replayed. -->
    <button
      v-if="!(byPr && prConflicts)"
      class="btn ghost"
      :class="{ nudge: behind > 0, working: op === 'rebase' }"
      :disabled="!!busyOp"
      :title="busyOp ? busyWord(busyOp) + '…' : catchUpTitle"
      @click="rebaseTopic(f!.id)"
    >
      <template v-if="op === 'rebase'"><LoaderCircle class="spin" /><span class="vl">Catching up…</span></template>
      <template v-else>
        <GitCompareArrows /><span class="vl">Catch up</span>
        <span v-if="behind" class="cnt">{{ behind }}</span>
      </template>
    </button>
    <!-- Every verb the topic has, always and in one order, off while it has
         nothing to act on — so a bar that hides Push and Send never leaves
         you wondering whether they exist. -->
    <OverflowMenu label="Everything you can do on this topic" :disabled="!!busyOp">
      <button :disabled="!canPush" @click="pushTopic(f!.id)">
        <ArrowUp /> Push
      </button>
      <button v-if="byPr" :disabled="!canMerge || live.length > 0" @click="askOpenPr(f!.name, ws)">
        <GitPullRequestCreate /> Open PR
      </button>
      <button :disabled="!canMerge" @click="mergeTopic(f!.id, false)">
        <GitMerge /> {{ sendLabel }}
      </button>
      <button v-if="byPr" @click="refreshReview(repoIds, true)">
        <GitPullRequest /> Refresh pull requests
      </button>
      <button @click="rebaseTopic(f!.id)">
        <GitCompareArrows /> Catch up
      </button>
    </OverflowMenu>
    </template>
    <!-- The things this checkout runs, after the git verbs, parted from them
         by a hairline. Each sits on a chip — the branch chip's ground — so a
         label and its chevron read as one control and not as a word with a
         stray arrow beside it. -->
    <i v-if="!stopped" class="sep" />
    <!-- §7 — present only while `worktrees.setup` runs, or after it failed. -->
    <button
      v-if="prep?.state === 'running'"
      class="btn ghost working"
      :title="prepTitle"
      @click="showSetupLog"
    >
      <LoaderCircle class="spin" /><span class="vl">Setting up…</span>
    </button>
    <button
      v-else-if="prep?.state === 'failed'"
      class="btn ghost failed"
      :title="prepTitle"
      @click="rerunTopicSetup(f!.id)"
    >
      <TriangleAlert /><span class="vl">Retry setup</span>
    </button>
    <!-- Always: it is the switch, and always the whole topic's. -->
    <ServerSwitch :folder="folder" :repos="ws" :topic="f" :waiting="prep?.state === 'running'" />
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
/* A setup that failed is in the way of Start, so it is the one amber word. */
.verbs .btn.failed { color: var(--warn); }

/* The request's one word, coloured by whether it wants you. */
.prchip .pw { color: var(--text-muted); }
.prchip.bad, .prchip.bad .pw { color: var(--danger); }
.prchip.warn, .prchip.warn .pw { color: var(--warn); }
.prchip.good, .prchip.good .pw { color: var(--ok); }
.verbs .btn .spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.sep { flex: none; width: 1px; height: 16px; margin: 0 6px; background: var(--line); }

/* Narrow column: the switch drops its word — its icon is a play triangle and
   nothing else here is. The promoted git verbs keep theirs, which is the whole
   reason they were promoted. */
@container (max-width: 620px) {
  .verbs .btn { padding: 0 6px; }
}
/* Pressed and on its way (`runtimeBusy`): off, but not dimmed — a dimmed
   spinner reads as "not available", and this is the opposite. */
.verbs .btn.working:disabled { opacity: 1; cursor: progress; }
.verbs .btn .spin { color: var(--accent); }
</style>
