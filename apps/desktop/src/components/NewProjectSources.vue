<script setup lang="ts">
import { CloudDownload, FolderOpen, FolderPlus } from '@lucide/vue'
import type { NewProjectSource } from '@cockpit/shared'

/**
 * §7 — the three ways a project comes into existence, defined once.
 *
 * The start page offers them as the first move and the sheet keeps them as the
 * segmented control at its top, so the card you click is the card that stays
 * lit. Two copies of this list would drift, and the wording is the only place
 * the difference between the three is explained.
 */

type Kind = NewProjectSource['kind']

defineProps<{
  /** The lit card. Null on the start page: nothing has been chosen yet. */
  selected?: Kind | null
}>()
const emit = defineEmits<{ (e: 'pick', kind: Kind): void }>()

const SOURCES: { kind: Kind; icon: typeof FolderPlus; title: string; blurb: string }[] = [
  {
    kind: 'scratch',
    icon: FolderPlus,
    title: 'From scratch',
    blurb: 'an empty project, ready for its first repository',
  },
  {
    kind: 'folder',
    icon: FolderOpen,
    title: 'A folder',
    blurb: 'something already on this machine',
  },
  {
    kind: 'clone',
    icon: CloudDownload,
    title: 'From a repository',
    blurb: 'clone from GitHub or any git remote',
  },
]
</script>

<template>
  <div class="sources">
    <button
      v-for="s in SOURCES"
      :key="s.kind"
      class="src"
      :class="{ on: selected === s.kind }"
      @click="emit('pick', s.kind)"
    >
      <component :is="s.icon" class="sm" />
      <strong>{{ s.title }}</strong>
      <span>{{ s.blurb }}</span>
    </button>
  </div>
</template>

<style scoped>
.sources { display: flex; gap: 8px; width: 100%; }
.src {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  padding: 10px 11px 11px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--bg-sunken);
  text-align: left;
  transition:
    border-color var(--dur-1) var(--ease-soft),
    background var(--dur-1) var(--ease-soft);
}
.src .lucide { color: var(--text-dim); margin-bottom: 2px; }
.src strong { font-size: var(--fs-sm); color: var(--text); font-weight: 620; }
.src > span { font-size: 10px; color: var(--text-dim); line-height: 1.4; }
.src:hover { border-color: var(--line-strong); background: var(--hover); }
.src.on,
.src.on:hover { border-color: var(--accent); background: var(--accent-soft); }
.src.on strong,
.src.on .lucide { color: var(--accent); }
</style>
