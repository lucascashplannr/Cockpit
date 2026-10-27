<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Check, ChevronDown, FolderTree, Layers, SquareDot } from '@lucide/vue'
import {
  activeProject, pickSpanDiffAll, pickSpanRepo, repoMark, reviewSpan, shortName, spanDiffAll, spanDiffRepo, spanDiffRepos,
  spanFolder, spanRepo, spanTerminal,
} from '../core/store.js'
import type { Workspace } from '@cockpit/shared'

/**
 * §7 — on the project, or a topic across repositories, the Diff, the Code and
 * the Terminal are still about one repository: this says which, at the end of
 * the tool strip, and is where another is picked — without leaving the scope.
 * A row of its own under the strip made the column three bands deep before
 * anything in it could be read.
 *
 * `diff` offers what the Diff offers (`spanDiffRepos`); the others, any.
 * `terminal` adds the span's folder above them (`spanFolder`): a shell there is
 * in every repository at once. `diff` adds every repository at once too
 * (`spanDiffAll`): their changes listed together, grouped.
 */
const props = defineProps<{ diff?: boolean; terminal?: boolean }>()

const current = computed(() =>
  props.diff ? spanDiffRepo.value : props.terminal ? spanTerminal.value : spanRepo.value,
)
const folder = computed(() => (props.terminal ? spanFolder.value : null))
/** Whether this menu has an "All repositories" row: the folder for the Terminal, every one for the Diff. */
const hasAll = computed(() => (props.diff ? spanDiffRepos.value.length > 1 : !!folder.value))
const atAll = computed(() =>
  props.diff ? !!spanDiffAll.value : !!folder.value && current.value?.id === folder.value.id,
)
// A topic's worktrees are named for the topic — the same name on every row —
// so there the repository is what tells them apart.
const name = (w: { name: string; repoName: string }) =>
  reviewSpan.value?.topicId ? w.repoName : shortName(w.name, activeProject.value?.name)
/**
 * The trigger says the repository's letters, never its name — set per
 * repository in the project's settings (`repoMark`), "All" for every one at
 * once — the same letters as the menu's right-hand column, the whole name in
 * the tooltip. A name made the trigger as wide as "All repositories" whatever
 * it was on, and the strip had to run out of room before it got short.
 *
 * Every mark is laid in the same cell and only the current one is visible, so
 * the trigger keeps one width whichever repository it is on.
 */
const markOf = (w: Workspace) => (w.id === folder.value?.id ? 'All' : repoMark(w, reviewSpan.value?.repos ?? []))
const mark = computed(() => (atAll.value ? 'All' : current.value ? markOf(current.value) : ''))
const marks = computed(() => [
  ...(hasAll.value ? ['All'] : []),
  ...(reviewSpan.value?.repos ?? []).map(markOf),
])
const repos = computed(() =>
  (props.diff ? spanDiffRepos.value : (reviewSpan.value?.repos ?? [])).map((w) => ({
    w,
    name: name(w),
    mark: markOf(w),
  })),
)

const open = ref(false)
const root = ref<HTMLElement | null>(null)

function pick(id: string): void {
  pickSpanRepo(id, props.terminal ? 'terminal' : props.diff ? 'diff' : null)
  open.value = false
}
function pickAll(): void {
  if (props.diff) pickSpanDiffAll()
  else if (folder.value) pickSpanRepo(folder.value.id)
  open.value = false
}

function onDocDown(ev: MouseEvent): void {
  if (!root.value?.contains(ev.target as Node)) open.value = false
}
function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') open.value = false
}
watch(open, (isOpen) => {
  if (isOpen) {
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onKey)
  } else {
    document.removeEventListener('mousedown', onDocDown)
    document.removeEventListener('keydown', onKey)
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocDown)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div v-if="current" ref="root" class="repomenu">
    <button
      class="trigger"
      :class="{ open }"
      :title="atAll ? (diff ? 'All repositories — every change, grouped' : 'All repositories — from the folder they sit in') : name(current)"
      :disabled="repos.length + (hasAll ? 1 : 0) < 2"
      @click="open = !open"
    >
      <Layers v-if="atAll && diff" class="sm lead" />
      <FolderTree v-else-if="atAll" class="sm lead" />
      <SquareDot v-else class="sm lead" />
      <span class="ini"><span v-for="m in new Set(marks)" :key="m" :class="{ ghost: m !== mark }">{{ m }}</span></span>
      <ChevronDown v-if="repos.length + (hasAll ? 1 : 0) > 1" class="sm chev" />
    </button>
    <div v-if="open" class="menu">
      <template v-if="hasAll">
        <button :title="diff ? 'Every repository\'s changes, grouped' : folder?.path" @click="pickAll">
          <Check class="tick" :class="{ hidden: !atAll }" />
          <Layers v-if="diff" />
          <FolderTree v-else />
          <span class="mn">All repositories</span>
          <span class="mk">All</span>
        </button>
        <div class="rule" />
      </template>
      <button v-for="r in repos" :key="r.w.id" :title="r.w.path" @click="pick(r.w.id)">
        <Check class="tick" :class="{ hidden: atAll || r.w.id !== current.id }" />
        <SquareDot />
        <span class="mn">{{ r.name }}</span>
        <span class="mk">{{ r.mark }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.repomenu { position: relative; display: flex; flex: 0 1 auto; min-width: 0; }
.trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 220px;
  height: 26px;
  padding: 0 7px 0 8px;
  border-radius: var(--radius-sm);
  font-size: var(--fs-sm);
  color: var(--text);
  white-space: nowrap;
}
.trigger > svg { flex: none; }
.trigger:hover:not(:disabled), .trigger.open { background: var(--hover); }
.trigger:disabled { cursor: default; }
.lead { color: var(--accent); }
/* One cell, every mark in it, one visible — see `marks`. Start-aligned: a button centres its text. */
.ini { display: grid; justify-items: start; font-weight: 600; letter-spacing: 0.02em; }
.ini > span { grid-area: 1 / 1; }
.ini > .ghost { visibility: hidden; }
.chev { color: var(--text-dim); }
/* Under its trigger, held to the strip's right edge like the trigger is. */
.menu { top: calc(100% + 4px); right: 0; max-height: 60vh; overflow-y: auto; }
.menu .tick { color: var(--accent); }
.menu .tick.hidden { visibility: hidden; }
.mn { flex: 1; }
/* The letters the trigger shows, so the two can be matched. */
.mk {
  flex: none;
  min-width: 28px;
  margin-left: 12px;
  text-align: right;
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--text-dim);
}
</style>
