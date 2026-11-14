<script setup lang="ts">
import { computed } from 'vue'
import { ArrowUp, LoaderCircle } from '@lucide/vue'
import type { Workspace } from '@cockpit/shared'
import ServerSwitch from './ServerSwitch.vue'
import { busyAmong, busyVerb, projectScopeWorkspaces, pushProject, state } from '../core/store.js'

/**
 * §4 — a group stands where the project does, over fewer repositories: its
 * own, with its folder in place of the project's.
 */
const props = defineProps<{ group?: Workspace | null; groupRepos?: Workspace[] }>()

/**
 * §7 — the verbs of the project, for the repositories it is on: all of them,
 * or the ones it was narrowed to. Push and the servers, as on a topic; Send
 * and Catch up are a topic's, since a main checkout has no base to go onto.
 */

const repos = computed(() => (props.group ? (props.groupRepos ?? []) : projectScopeWorkspaces.value))
const ids = computed(() => repos.value.map((w) => w.id))

const busyOp = computed(() => busyAmong(ids.value))
const op = computed(() => busyVerb(busyOp.value ?? undefined))

const ahead = computed(() => repos.value.reduce((n, w) => n + (w.git?.ahead ?? 0), 0))

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
    <i v-if="(canPush || op === 'push') && runs" class="sep" />
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
