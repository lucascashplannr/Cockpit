<script setup lang="ts">
import { computed } from 'vue'
import { ArrowDownToLine, ArrowUp, GitCommitHorizontal, LoaderCircle } from '@lucide/vue'
import type { Workspace } from '@cockpit/shared'
import OverflowMenu from './OverflowMenu.vue'
import ServerSwitch from './ServerSwitch.vue'
import {
  busyAmong, busyVerb, changeCount, openCommit, projectScopeWorkspaces, pullProject, pushCount, pushProject, state,
} from '../core/store.js'

/**
 * §4 — a group stands where the project does, over fewer repositories: its
 * own, with its folder in place of the project's.
 */
const props = defineProps<{ group?: Workspace | null; groupRepos?: Workspace[] }>()

/**
 * §7 — the verbs of the project, for the repositories it is on: all of them,
 * or the ones it was narrowed to. Commit, Push and Pull across them, and the
 * servers, as on a topic; Send and Catch up are a topic's, since a main
 * checkout has no base to go onto. On the bar while there is something to do,
 * and always in the menu beside them, as a repository's are.
 */

const repos = computed(() => (props.group ? (props.groupRepos ?? []) : projectScopeWorkspaces.value))
const ids = computed(() => repos.value.map((w) => w.id))

const busyOp = computed(() => busyAmong(ids.value))
const op = computed(() => busyVerb(busyOp.value ?? undefined))

const ahead = computed(() => repos.value.reduce((n, w) => n + pushCount(w.git), 0))

/** A merge or a rebase stopped in one of them: git refuses the rest until it ends. */
const stopped = computed(() => repos.value.some((w) => !!w.git?.operation))

/** Uncommitted, summed: Commit opens the Diff's box, which picks the repository. */
const uncommitted = computed(() => repos.value.reduce((n, w) => n + changeCount(w), 0))

/** A branch with a branch of its own on origin: the only kind there is to pull into. */
const tracked = computed(() =>
  repos.value.filter((w) => !!w.git?.branch && w.git.upstream === 'origin/' + w.git.branch),
)
/** What the last background fetch saw arrive (every two minutes); Pull fetches again before it plans. */
const incoming = computed(() => tracked.value.reduce((n, w) => n + (w.git?.incoming ?? 0), 0))
const pullTitle = computed(
  () =>
    'Pull ' + (repos.value.length > 1 ? 'every repository here' : 'this repository') + ' from origin' +
    (incoming.value ? ', ' + incoming.value + ' commit(s) waiting' : ''),
)

/** The rule `topic.push` follows: ahead of its remote, or never pushed. */
const canPush = computed(() =>
  repos.value.some(
    (w) =>
      !!w.repo && !!w.git && !!w.git.branch && w.git.hasRemote !== false &&
      (w.git.ahead > 0 || !w.git.upstream || w.git.published === false),
  ),
)

const pushTitle = computed(
  () =>
    'Push ' + (repos.value.length > 1 ? 'every repository here' : 'this repository') + ' to origin' +
    (ahead.value ? ' — ' + ahead.value + ' commit(s)' : ' — one has never been pushed'),
)

/** Nothing in scope runs anything: no switch to offer. */
const runs = computed(() => !!folder.value?.runtime || repos.value.some((w) => w.runtime))

/**
 * The project's own folder, where repository-less declarations run — found by
 * its path, since a group of repositories is a folder with no topic too.
 */
const folder = computed(() => {
  if (props.group) return props.group
  const root = state.projects.find((p) => p.id === state.activeProjectId)?.root
  return state.workspaces.find((w) => w.kind === 'group' && w.projectId === state.activeProjectId && w.path === root) ?? null
})
</script>

<template>
  <div class="verbs">
    <template v-if="!stopped">
      <button
        v-if="uncommitted"
        class="btn ghost nudge"
        :disabled="!!busyOp"
        :title="'Commit, ' + uncommitted + ' uncommitted change(s)'"
        @click="openCommit()"
      >
        <GitCommitHorizontal /><span class="vl">Commit</span>
        <span class="cnt">{{ uncommitted }}</span>
      </button>
      <button
        v-if="canPush || op === 'push'"
        class="btn ghost nudge"
        :class="{ working: op === 'push' }"
        :disabled="!!busyOp"
        :title="op === 'push' ? 'Pushing…' : pushTitle"
        @click="pushProject(ids)"
      >
        <template v-if="op === 'push'"><LoaderCircle class="spin" /><span class="vl">Pushing…</span></template>
        <template v-else>
          <ArrowUp /><span class="vl">Push</span>
          <span v-if="ahead" class="cnt">{{ ahead }}</span>
        </template>
      </button>
      <button
        v-if="incoming || op === 'pull'"
        class="btn ghost nudge"
        :class="{ working: op === 'pull' }"
        :disabled="!!busyOp"
        :title="op === 'pull' ? 'Pulling…' : pullTitle"
        @click="pullProject(ids)"
      >
        <template v-if="op === 'pull'"><LoaderCircle class="spin" /><span class="vl">Pulling…</span></template>
        <template v-else>
          <ArrowDownToLine /><span class="vl">Pull</span>
          <span class="cnt">{{ incoming }}</span>
        </template>
      </button>
      <!-- Every verb, always and in one order, off while it has nothing to act
           on. Pull reads the background fetch's count, as the bar does. -->
      <OverflowMenu label="Everything you can do on this project" :disabled="!!busyOp">
        <button :disabled="!uncommitted" @click="openCommit()">
          <GitCommitHorizontal /> Commit
        </button>
        <button :disabled="!canPush" @click="pushProject(ids)">
          <ArrowUp /> Push all
        </button>
        <button :disabled="!incoming" @click="pullProject(ids)">
          <ArrowDownToLine /> Pull all
        </button>
      </OverflowMenu>
    </template>
    <i v-if="!stopped && runs" class="sep" />
    <ServerSwitch v-if="runs" :folder="folder" :repos="repos" />
  </div>
</template>

<style scoped>
.verbs { display: flex; align-items: center; gap: 2px; flex: none; }
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
.verbs .cnt { font-variant-numeric: tabular-nums; font-size: var(--fs-xs); color: var(--warn); }
.nudge { color: var(--warn); }
.sep { flex: none; width: 1px; height: 16px; margin: 0 6px; background: var(--line); }
@container (max-width: 620px) {
  .verbs .btn { padding: 0 6px; }
}
.verbs .btn.working:disabled { opacity: 1; cursor: progress; }
.verbs .btn .spin { color: var(--accent); }
</style>
