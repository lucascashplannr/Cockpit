<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { BranchRef, Workspace } from '@cockpit/shared'
import BaseSelect from './BaseSelect.vue'
import { client, guard, replanBase, state } from '../core/store.js'

/**
 * §4 — where a Catch up lands, and from which branch.
 *
 * The project's default branch is the answer nearly always, and it is a
 * setting because it is a standing fact about the project. This is the other
 * case: once, on purpose, from somewhere else — chosen in the question you are
 * already being asked, on the row of the repository it is about.
 *
 * A row per repository because a topic spans several and they need not agree:
 * not on the branch, and not on whether there is anything to catch up on.
 *
 * Only a Catch up. Send to is the branch the work *belongs* to, and changing
 * that on the way past is a different decision.
 */

const from = computed(() => state.pendingPlanFrom)

/**
 * The repositories the question is about. One, for a checkout; for a topic,
 * every repository it spans — and then each gets a row of its own, because
 * "from main" is one sentence about several repositories that need not agree.
 */
const repos = computed(() => {
  const f = from.value
  if (!f) return []
  return f.scope.kind === 'topic'
    ? state.workspaces.filter((w) => w.topicId === f.scope.id && w.repo)
    : state.workspaces.filter((w) => w.id === f.workspaceId)
})

const loading = ref(false)
const branches = ref<Record<string, BranchRef[]>>({})

/**
 * A base is a plain branch name — the steps say `git fetch origin <base>` and
 * rebase onto `origin/<base>` — so `origin/dev` and a local `dev` are one
 * entry here, not two, and a branch that exists only here is not one at all:
 * offering it would be offering a step that fails. The same rule as the bases
 * of a new topic.
 */
function basesIn(id: string): string[] {
  const seen = new Set<string>()
  for (const b of branches.value[id] ?? []) {
    if (b.remoteOnly) seen.add(b.name.replace(/^[^/]+\//, ''))
    else if (b.upstream) seen.add(b.name)
  }
  return [...seen]
}

/**
 * §3.4 — read every time the question is asked, never remembered: a branch
 * pushed a minute ago is a legitimate thing to catch up from. Not again on a
 * re-plan, though: the repositories are the same ones.
 */
watch(
  () => repos.value.map((w) => w.id).join(' '),
  async (key) => {
    branches.value = {}
    if (!key) return
    loading.value = true
    const ids = key.split(' ')
    const got = await Promise.all(
      ids.map((id) => guard(() => client.call('git.branches', { workspaceId: id }))),
    )
    if (repos.value.map((w) => w.id).join(' ') === key) {
      branches.value = Object.fromEntries(ids.map((id, i) => [id, got[i] ?? []]))
    }
    loading.value = false
  },
  { immediate: true },
)

/**
 * One checkout has one choice, kept as the plan's own; a topic keeps one per
 * repository. Either way it is read and written through the row.
 */
function chosenFor(w: Workspace): string {
  const f = from.value
  if (!f) return ''
  return f.scope.kind === 'topic' ? (f.bases[w.id] ?? '') : f.chosen
}
/** What a repository's row resolves to when it has no choice of its own. */
function inherited(w: Workspace): string {
  const f = from.value
  return (f?.scope.kind === 'topic' && f.chosen) || w.git?.base || 'default branch'
}
/** A base named for all of them that this repository's origin does not have. */
function problem(w: Workspace): string {
  const f = from.value
  if (!f || loading.value) return ''
  const named = chosenFor(w) || (f.scope.kind === 'topic' ? f.chosen : '')
  return named && !basesIn(w.id).includes(named) ? 'origin has no ' + named + ' in ' + w.name : ''
}
/** Empty is the list's "Default" row: back to what it would use anyway. */
async function pickFor(w: Workspace, name: string) {
  const f = from.value
  if (!f || name === chosenFor(w)) return
  if (f.scope.kind !== 'topic') return replanBase(name)
  const bases = { ...f.bases }
  if (name) bases[w.id] = name
  else delete bases[w.id]
  await replanBase(f.chosen, bases)
}

/**
 * How far behind its base a repository is — which is whether this does
 * anything there. From the plan, since the base may be one chosen a moment
 * ago; from the probe when an older core's plan does not say.
 */
function behind(w: Workspace): number | null {
  const t = state.pendingConfirm?.plan?.targets?.find((x) => x.workspaceId === w.id)
  if (t) return t.behind
  const onto = chosenFor(w) || inherited(w)
  return onto === w.git?.base ? (w.git?.behindBase ?? null) : null
}
</script>

<template>
  <!-- One row per repository, a checkout on its own included: the same line
       says where this catches up, from what, and whether there is anything to. -->
  <div v-if="from?.base && repos.length" class="rows">
    <div v-for="w in repos" :key="w.id" class="row" :class="{ idle: behind(w) === 0 }">
      <span class="rname">{{ w.name }}</span>
      <span
        v-if="behind(w) !== null"
        class="state"
        :title="behind(w) ? '' : 'As of the last fetch — this fetches again, and replays only if something came in'"
      >
        {{ behind(w) ? behind(w) + ' behind' : 'up to date with' }}
      </span>
      <BaseSelect
        variant="word"
        floating
        title="Catch up from another branch, this once"
        :model-value="chosenFor(w)"
        :options="basesIn(w.id).map((name) => ({ name }))"
        :loading="loading"
        :fallback="inherited(w)"
        :problem="problem(w)"
        @update:model-value="pickFor(w, $event)"
      />
    </div>
  </div>
</template>

<style scoped>
/* On a raised surface, so the overlay hairline and no fill of its own: the
   same box as the option row a question can carry. */
.rows {
  flex: none;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line-overlay);
  border-radius: var(--radius-sm);
}
.row { display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 0 11px; font-size: var(--fs-sm); }
.row + .row { border-top: 1px solid var(--line-overlay); }
.rname { flex: 1; min-width: 0; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The count is the news; a repository with nothing to replay steps back. */
.state { flex: none; font-size: var(--fs-xs); color: var(--warn); font-variant-numeric: tabular-nums; }
.row.idle .state, .row.idle .rname { color: var(--text-dim); }
</style>
