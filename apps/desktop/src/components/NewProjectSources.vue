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
 *
 * A repository joining a project that already exists arrives the same three
 * ways, which is why they are listed here too rather than in a second copy
 * that says the same thing about a smaller thing. Only the wording differs:
 * what lands is a repository rather than a project around one.
 */

type Kind = NewProjectSource['kind']

withDefaults(
  defineProps<{
    /** The lit card. Null on the start page: nothing has been chosen yet. */
    selected?: Kind | null
    /** What is being created. The three sources are the same; what each means is not. */
    of?: 'project' | 'repo'
  }>(),
  { selected: null, of: 'project' },
)
const emit = defineEmits<{ (e: 'pick', kind: Kind): void }>()

interface Source {
  kind: Kind
  icon: typeof FolderPlus
  title: string
  blurb: Record<'project' | 'repo', string>
}

const SOURCES: Source[] = [
  {
    kind: 'scratch',
    icon: FolderPlus,
    title: 'From scratch',
    blurb: {
      project: 'an empty project, ready for its first repository',
      repo: 'a new folder, git init, one commit',
    },
  },
  {
    kind: 'folder',
    icon: FolderOpen,
    title: 'A folder',
    blurb: {
      project: 'something already on this machine',
      repo: 'move one already on this machine in',
    },
  },
  {
    kind: 'clone',
    icon: CloudDownload,
    title: 'From a repository',
    blurb: {
      project: 'clone from GitHub or any git remote',
      repo: 'clone it in beside the others',
    },
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
      <span>{{ s.blurb[of] }}</span>
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
