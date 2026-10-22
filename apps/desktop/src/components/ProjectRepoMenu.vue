<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Check, ChevronDown, FolderTree, SquareDot } from '@lucide/vue'
import {
  activeProject, changeCount, pickSpanRepo, repoMark, reviewSpan, shortName, spanDiffRepo, spanDiffRepos, spanFolder, spanRepo, spanTerminal,
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
 * in every repository at once.
 */
const props = defineProps<{ diff?: boolean; terminal?: boolean }>()

const current = computed(() =>
  props.diff ? spanDiffRepo.value : props.terminal ? spanTerminal.value : spanRepo.value,
)
const folder = computed(() => (props.terminal ? spanFolder.value : null))
const atFolder = computed(() => !!folder.value && current.value?.id === folder.value.id)
// A topic's worktrees are named for the topic — the same name on every row —
// so there the repository is what tells them apart.
const name = (w: { name: string; repoName: string }) =>
  reviewSpan.value?.topicId ? w.repoName : shortName(w.name, activeProject.value?.name)
/**
 * What the trigger can say, and what it says. Every label is laid in the same
 * cell and only the current one is visible, so the trigger is always as wide
 * as the longest: picking "cashplannr-v2" after "cashplannr-projects" used to
 * free just enough room for the strip to put the name back, and the menu
 * flipped between letters and a name depending on which repository it was on.
 *
 * `marks` are the letters shown in the name's place when the strip has no room
 * for it (`bare` in ReviewTools) — set per repository in the project's
 * settings (`repoMark`), "All" for the folder.
 */
const label = computed(() => (atFolder.value ? 'All repositories' : current.value ? name(current.value) : ''))
const labels = computed(() => [
  ...(folder.value ? ['All repositories'] : []),
  ...(reviewSpan.value?.repos ?? []).map(name),
])
const markOf = (w: Workspace) => (w.id === folder.value?.id ? 'All' : repoMark(w, reviewSpan.value?.repos ?? []))
const mark = computed(() => (current.value ? markOf(current.value) : ''))
const marks = computed(() => [
  ...(folder.value ? ['All'] : []),
  ...(reviewSpan.value?.repos ?? []).map(markOf),
])
const repos = computed(() =>
  (props.diff ? spanDiffRepos.value : (reviewSpan.value?.repos ?? [])).map((w) => ({
    w,
    name: name(w),
    mark: markOf(w),
    changed: changeCount(w),
  })),
)

const open = ref(false)
const root = ref<HTMLElement | null>(null)

function pick(id: string): void {
  pickSpanRepo(id, props.terminal)
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
      :title="atFolder ? 'All repositories — from the folder they sit in' : name(current) + (changeCount(current) ? ' — ' + changeCount(current) + ' uncommitted' : '')"
      :disabled="repos.length + (folder ? 1 : 0) < 2"
      @click="open = !open"
    >
      <FolderTree v-if="atFolder" class="sm lead" />
      <SquareDot v-else class="sm lead" />
      <span class="nm"><span v-for="l in new Set(labels)" :key="l" :class="{ ghost: l !== label }">{{ l }}</span></span>
      <span class="ini"><span v-for="m in new Set(marks)" :key="m" :class="{ ghost: m !== mark }">{{ m }}</span></span>
      <span v-if="changeCount(current)" class="n num">{{ changeCount(current) }}</span>
      <ChevronDown v-if="repos.length + (folder ? 1 : 0) > 1" class="sm chev" />
    </button>
    <div v-if="open" class="menu">
      <template v-if="folder">
        <button :title="folder.path" @click="pick(folder.id)">
          <Check class="tick" :class="{ hidden: !atFolder }" />
          <FolderTree />
          <span class="mn">All repositories</span>
        </button>
        <div class="rule" />
      </template>
      <button v-for="r in repos" :key="r.w.id" :title="r.w.path" @click="pick(r.w.id)">
        <Check class="tick" :class="{ hidden: r.w.id !== current.id }" />
        <SquareDot />
        <span class="mn">{{ r.name }}</span>
        <span v-if="r.changed" class="n num">{{ r.changed }}</span>
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
/* One cell, every label in it, one visible — see `labels`. */
.nm, .ini { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); }
.nm > span, .ini > span { grid-area: 1 / 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.nm > .ghost, .ini > .ghost { visibility: hidden; }
/* Shown in the name's place when the strip is out of room — see `marks`. */
.ini { display: none; font-weight: 600; letter-spacing: 0.02em; }
.chev { color: var(--text-dim); }
.n {
  flex: none;
  font-size: 11px;
  padding: 0 5px;
  height: 16px;
  min-width: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--warn-soft);
  color: var(--warn);
}
/* Under its trigger, held to the strip's right edge like the trigger is. */
.menu { top: calc(100% + 4px); right: 0; max-height: 60vh; overflow-y: auto; }
.menu .tick { color: var(--accent); }
.menu .tick.hidden { visibility: hidden; }
.mn { flex: 1; }
/* The initials the trigger shows when the strip is narrow, so the two can be matched. */
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
