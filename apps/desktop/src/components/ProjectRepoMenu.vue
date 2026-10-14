<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Check, ChevronDown, SquareDot } from '@lucide/vue'
import {
  activeProject, changeCount, pickProjectRepo, projectDiffRepo, projectDiffRepos, projectRepo, projectScopeWorkspaces, shortName,
} from '../core/store.js'

/**
 * §7 — on the project, the Diff, the Code and the Terminal are still about one
 * repository: this says which, at the end of the tool strip, and is where
 * another is picked. A row of its own under the strip made the column three
 * bands deep before anything in it could be read.
 *
 * `diff` offers what the Diff offers (`projectDiffRepos`); the others, any.
 */
const props = defineProps<{ diff?: boolean }>()

const current = computed(() => (props.diff ? projectDiffRepo.value : projectRepo.value))
const name = (w: { name: string }) => shortName(w.name, activeProject.value?.name)
const repos = computed(() =>
  (props.diff ? projectDiffRepos.value : projectScopeWorkspaces.value).map((w) => ({
    w,
    name: name(w),
    changed: changeCount(w),
  })),
)

const open = ref(false)
const root = ref<HTMLElement | null>(null)

function pick(id: string): void {
  pickProjectRepo(id)
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
      :title="current.name + (changeCount(current) ? ' — ' + changeCount(current) + ' uncommitted' : '')"
      :disabled="repos.length < 2"
      @click="open = !open"
    >
      <SquareDot class="sm lead" />
      <span class="nm">{{ name(current) }}</span>
      <span v-if="changeCount(current)" class="n num">{{ changeCount(current) }}</span>
      <ChevronDown v-if="repos.length > 1" class="sm chev" />
    </button>
    <div v-if="open" class="menu">
      <button v-for="r in repos" :key="r.w.id" :title="r.w.name" @click="pick(r.w.id)">
        <Check class="tick" :class="{ hidden: r.w.id !== current.id }" />
        <SquareDot />
        <span class="mn">{{ r.name }}</span>
        <span v-if="r.changed" class="n num">{{ r.changed }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.repomenu { position: relative; flex: none; min-width: 0; }
.trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  height: 26px;
  padding: 0 7px 0 8px;
  border-radius: var(--radius-sm);
  font-size: var(--fs-sm);
  color: var(--text);
  white-space: nowrap;
}
.trigger:hover:not(:disabled), .trigger.open { background: var(--hover); }
.trigger:disabled { cursor: default; }
.lead { color: var(--accent); }
.nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
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
</style>
