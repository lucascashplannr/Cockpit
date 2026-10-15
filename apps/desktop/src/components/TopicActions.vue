<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  ArrowUp, Check, ChevronDown, ExternalLink, GitCompareArrows, GitMerge, LoaderCircle, Play, TriangleAlert,
} from '@lucide/vue'
import type { DeclaredServer, Workspace } from '@cockpit/shared'
import OverflowMenu from './OverflowMenu.vue'
import type { ListGroup } from '../core/store.js'
import {
  busyAmong, busyVerb, busyWord, client, guard, mergeTopic, pushTopic, rebaseTopic, refreshCommands, rerunTopicSetup, runningServers, runtimeBusy, showSetupLog, startTopic, state, stopTopic, toast, toggleWorkspaceRuntime,
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

/* ── what the topic runs (§8) ──────────────────────────────────────────
 *
 * The switch is the topic's and nothing else: one press starts every server
 * on `start:` in every repository the topic spans, and the project's own in
 * the topic's folder. The menu beside it is that same stack by name — each
 * row starts or stops one server, and says whether Start includes it. That
 * last part is written to the manifest, so it holds for every topic, the
 * ones not opened yet included.
 *
 * Servers only. The project's commands are not on this bar: a command is
 * pressed where it runs, on a repository or on the project.
 */

/** The topic's folder, which is the checkout the project's declarations run in. */
const folder = computed(
  () => state.workspaces.find((w) => w.kind === 'group' && w.topicId === f.value?.id) ?? null,
)

/** Every checkout of the topic that runs something: its folder, then its repositories. */
const hosts = computed(() =>
  [...(folder.value ? [folder.value] : []), ...ws.value].filter((w) => w.runtime),
)

/** A declared server and the checkout it runs in here. */
type Row = DeclaredServer & { ws: Workspace }

const servers = ref<Row[]>([])

async function load(): Promise<void> {
  const topicId = f.value?.id
  const s = await Promise.all(
    hosts.value.map(async (h) =>
      (await client.call('runtime.servers', { workspaceId: h.id }).catch(() => [])).map(
        (x): Row => ({ ...x, ws: h }),
      ),
    ),
  )
  // An answer for a topic nobody is looking at any more is not an answer.
  if (f.value?.id !== topicId) return
  servers.value = s.flat()
}

// A checkout's runtime appears once the core has read a server for it, and the
// lists change whenever the manifest is written from the window.
watch(
  [
    () => folder.value?.id,
    () => hosts.value.map((h) => h.id + ':' + h.runtime?.impl).join(),
    () => state.declarations,
    () => state.commands,
  ],
  () => void load(),
  { immediate: true },
)

/** Read off the checkout the store holds now, not the one the row was built with. */
const isAlive = (s: Row) =>
  runningServers(state.workspaces.find((w) => w.id === s.ws.id) ?? s.ws).has(s.name)

/**
 * A server started by name leaves the topic's own state alone, so the switch
 * asks the checkouts as well: something up is something Stop has to stop.
 */
const running = computed(
  () =>
    f.value?.state === 'running' ||
    hosts.value.some((w) => w.runtime?.status === 'up' || w.runtime?.status === 'starting'),
)
/**
 * Pressed and not answered yet — the topic's own switch, or one of its
 * servers by name, which holds its checkout (see `runtimeBusy`).
 */
const pending = computed(
  () => (f.value && runtimeBusy[f.value.id]) || hosts.value.map((h) => runtimeBusy[h.id]).find(Boolean) || null,
)
const switchLabel = computed(() =>
  pending.value ? (pending.value === 'start' ? 'Starting…' : 'Stopping…') : running.value ? 'Stop' : 'Start',
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

const switchTitle = computed(() => {
  if (running.value) return 'Stop the servers — the branches stay where they are'
  if (prep.value?.state === 'running') return 'Start waits for the setup to finish'
  const names = servers.value.filter((s) => s.inStart).map((s) => s.name)
  return names.length ? 'Start ' + names.join(', ') : 'Start the servers for every repository in this topic'
})

/** Where the topic's servers answer, while they do — see WorkspaceActions. */
const openable = computed(() => {
  const p = folder.value?.runtime?.preview
  return (p?.kind === 'url' && p.value) || null
})

async function openPreview() {
  const w = folder.value
  if (w) await guard(() => client.call('workspace.openIn', { workspaceId: w.id, target: 'browser' }))
}

async function toggle() {
  const topic = f.value
  if (!topic) return
  if (running.value) await stopTopic(topic.id)
  else await startTopic(topic.id)
}

async function toggleServer(s: Row) {
  await toggleWorkspaceRuntime(state.workspaces.find((w) => w.id === s.ws.id) ?? s.ws, s.name)
}

/** On or off `start:` — the project's list, so every topic's. */
async function setOnStart(s: Row) {
  const res = await guard(() =>
    client.call('declare.setStart', { projectId: s.ws.projectId, name: s.name, inStart: !s.inStart }),
  )
  if (!res) return
  if (!res.ok) {
    toast('error', res.detail)
    return
  }
  await Promise.all([load(), refreshCommands()])
}

function noteOf(s: Row): string {
  if (s.unresolved.length) return 'nothing named ' + s.unresolved.map((u) => '{{' + u + '}}').join(', ')
  if (isAlive(s)) return s.port ? ':' + s.port : 'running'
  return ''
}

const startTitle = (s: Row) =>
  s.inStart
    ? 'Start includes ' + s.name + ', in every topic — click to leave it out'
    : 'Start skips ' + s.name + ' — click to include it'

</script>

<template>
  <div v-if="togglable" class="verbs">
    <!-- The counterpart of a per-repository commit: nothing about a push is
         specific to one repository's diff, so it is one act across all of
         them. -->
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

    <!-- §4 — the step the lifecycle was missing: the branch goes onto the
         base, in every repository the topic spans. Green once there is
         something committed to send and nothing in the way of sending it. -->
    <button
      v-if="canMerge || op === 'merge'"
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
      <button :disabled="!canMerge" @click="mergeTopic(f!.id, false)">
        <GitMerge /> {{ sendLabel }}
      </button>
      <button @click="rebaseTopic(f!.id)">
        <GitCompareArrows /> Catch up
      </button>
    </OverflowMenu>
    <!-- The things this checkout runs, after the git verbs, parted from them
         by a hairline. Each sits on a chip — the branch chip's ground — so a
         label and its chevron read as one control and not as a word with a
         stray arrow beside it. -->
    <i class="sep" />
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
    <!-- Always: it is the switch, and always the whole topic's. Split once
         there are servers to name: the menu is the stack, one row each. -->
    <button
      v-if="!servers.length && !openable"
      class="btn ghost sw solo"
      :class="{ on: running, working: pending }"
      :disabled="!!pending"
      :title="switchTitle"
      @click="toggle"
    >
      <LoaderCircle v-if="pending" class="spin" />
      <i v-else-if="running" class="live" />
      <Play v-else />
      <span class="vl">{{ switchLabel }}</span>
    </button>
    <!-- While the servers answer somewhere, the way there is a half of the
         switch's own chip — see WorkspaceActions. -->
    <div v-else-if="!servers.length" class="split" :class="{ working: pending }">
      <button class="btn ghost run sw" :disabled="!!pending" :title="switchTitle" @click="toggle">
        <LoaderCircle v-if="pending" class="spin" />
        <i v-else-if="running" class="live" />
        <Play v-else />
        <span class="vl">{{ switchLabel }}</span>
      </button>
      <span class="div" />
      <button
        class="btn ghost half"
        :title="'Open ' + openable"
        :aria-label="'Open ' + openable"
        @click="openPreview"
      >
        <ExternalLink />
      </button>
    </div>
    <div v-else class="split" :class="{ working: pending }">
      <button class="btn ghost run sw" :class="{ on: running }" :disabled="!!pending" :title="switchTitle" @click="toggle">
        <LoaderCircle v-if="pending" class="spin" />
        <i v-else-if="running" class="live" />
        <Play v-else />
        <span class="vl">{{ switchLabel }}</span>
      </button>
      <template v-if="openable">
        <span class="div" />
        <button
          class="btn ghost half"
          :title="'Open ' + openable"
          :aria-label="'Open ' + openable"
          @click="openPreview"
        >
          <ExternalLink />
        </button>
      </template>
      <span class="div" />
      <OverflowMenu class="pick" label="The servers of this topic" :disabled="!!pending">
        <template #trigger><ChevronDown /></template>
        <div v-for="s in servers" :key="s.ws.id + s.name" class="srow">
          <button
            class="one"
            :title="(isAlive(s) ? 'Stop ' : 'Start ') + s.name + ' in ' + s.ws.name"
            @click="toggleServer(s)"
          >
            <i class="sd" :class="{ on: isAlive(s), bad: s.unresolved.length }" />
            {{ s.name }}
            <span v-if="noteOf(s)" class="sc">{{ noteOf(s) }}</span>
          </button>
          <!-- Stopped here, so the menu stays open: ticking three of these in
               a row is the ordinary case, and it switches nothing. -->
          <button class="st" :class="{ on: s.inStart }" :title="startTitle(s)" @click.stop="setOnStart(s)">
            <Check v-if="s.inStart" />{{ s.inStart ? 'on Start' : 'not on Start' }}
          </button>
        </div>
      </OverflowMenu>
    </div>

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

/* Running is one dot in the glyph's slot, not a green switch — the repository
   bar's reasoning, drawn the same. */
.live { flex: none; display: inline-grid; place-items: center; width: 14px; height: 14px; }
.live::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--ok); }
.verbs .split .btn.half { padding: 0 6px; }
.verbs .split .btn.half:last-child { border-radius: 0 var(--radius-sm) var(--radius-sm) 0; }

/* ── the split buttons, drawn as the repository bar draws them ─────── */
.split {
  display: inline-flex;
  align-items: center;
  flex: none;
  height: 26px;
  border-radius: var(--radius-sm);
  background: var(--bg-sunken);
}
.verbs .btn.solo { background: var(--bg-sunken); }
.verbs .btn.solo:hover:not(:disabled) { background: var(--hover); }
.verbs .split :deep(.btn:hover:not(:disabled)) { border-color: transparent; }
.verbs .split :deep(.btn) { height: 26px; border-radius: 0; }
.verbs .split .btn.run { padding: 0 6px 0 8px; border-radius: var(--radius-sm) 0 0 var(--radius-sm); }
.split .div { flex: none; width: 1px; height: 12px; background: var(--line); }
.verbs .split :deep(.pick .btn) { padding: 0 4px; border-radius: 0 var(--radius-sm) var(--radius-sm) 0; }
.sep { flex: none; width: 1px; height: 16px; margin: 0 6px; background: var(--line); }
.verbs .split :deep(.pick .lucide) { width: 13px; height: 13px; }
.sd {
  flex: none;
  width: var(--ic-sm);
  height: var(--ic-sm);
  border-radius: 50%;
  box-shadow: inset 0 0 0 1.5px var(--text-dim);
  transform: scale(0.5);
}
.sd.on { background: var(--ok); box-shadow: none; }
.sd.bad { background: var(--warn); box-shadow: none; }

/* A row is two acts: the server itself, and whether Start includes it. The
   second is a word rather than a checkbox because it is the word the sheet
   and the repository's menu already use for the same fact. */
.srow { display: flex; align-items: center; gap: 1px; }
.srow .one { flex: 1; min-width: 0; }
.menu .srow .st {
  flex: none;
  gap: 4px;
  margin-left: 10px;
  padding: 0 7px;
  font-size: 11px;
  color: var(--text-dim);
}
.menu .srow .st.on { color: var(--text); }
.menu .srow .st .lucide { width: 12px; height: 12px; color: var(--accent); }

.sc {
  margin-left: auto;
  padding-left: 14px;
  font-size: 11px;
  color: var(--text-dim);
}

/* Narrow column: the switch drops its word — its icon is a play triangle and
   nothing else here is. The promoted git verbs keep theirs, which is the whole
   reason they were promoted. */
@container (max-width: 620px) {
  .verbs .btn.sw .vl { display: none; }
  .verbs .btn { padding: 0 6px; }
}
/* Pressed and on its way (`runtimeBusy`): off, but not dimmed — a dimmed
   spinner reads as "not available", and this is the opposite. */
.verbs .split.working :deep(.btn:disabled),
.verbs .btn.working:disabled { opacity: 1; cursor: progress; }
.verbs .btn .spin { color: var(--accent); }
</style>
