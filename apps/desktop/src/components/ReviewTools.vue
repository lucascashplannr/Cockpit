<script setup lang="ts">
import { computed } from 'vue'
import type { Component } from 'vue'
import type { Workspace } from '@cockpit/shared'
import { FileCode, GitCompareArrows, ScrollText, SquareTerminal, X } from '@lucide/vue'
import CodeTab from './tabs/CodeTab.vue'
import DiffTab from './tabs/DiffTab.vue'
import JournalTab from './tabs/JournalTab.vue'
import TerminalTab from './tabs/TerminalTab.vue'
import { reviewTools, state } from '../core/store.js'
import type { ReviewTool } from '../core/store.js'

/**
 * Layer 3 — reading what came out of the run: the diff, the code around it,
 * the journal, and the terminal you check it in. Secondary by definition, so
 * they share one implementation and the three candidate layouts only decide
 * where it is mounted (see ReviewBench).
 */

const props = defineProps<{ workspace: Workspace; closable?: boolean }>()

const META: Record<ReviewTool, { label: string; icon: Component }> = {
  diff: { label: 'Diff', icon: GitCompareArrows },
  code: { label: 'Code', icon: FileCode },
  journal: { label: 'Journal', icon: ScrollText },
  terminal: { label: 'Terminal', icon: SquareTerminal },
}

const changed = computed(() => {
  const g = props.workspace.git
  return g ? g.staged + g.unstaged + g.untracked : 0
})

const tools = computed(() =>
  reviewTools.value.map((id) => ({
    id,
    ...META[id],
    badge: id === 'diff' ? changed.value || undefined : undefined,
  })),
)
</script>

<template>
  <div class="review">
    <nav class="tools">
      <button
        v-for="t in tools"
        :key="t.id"
        class="tool"
        :class="{ on: state.reviewTool === t.id }"
        @click="state.reviewTool = t.id"
      >
        <component :is="t.icon" class="sm" />
        <span>{{ t.label }}</span>
        <span v-if="t.badge !== undefined" class="tbadge num">{{ t.badge }}</span>
      </button>
      <span class="grow" />
      <button v-if="closable" class="icon-btn" title="Close (Esc)" @click="state.reviewOpen = false">
        <X class="sm" />
      </button>
    </nav>

    <div class="body">
      <DiffTab v-if="state.reviewTool === 'diff'" :workspace="workspace" />
      <CodeTab v-else-if="state.reviewTool === 'code'" :workspace="workspace" />
      <JournalTab v-else-if="state.reviewTool === 'journal'" :workspace="workspace" />
      <TerminalTab v-else-if="state.reviewTool === 'terminal'" :workspace="workspace" />
    </div>
  </div>
</template>

<style scoped>
.review { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; }

.tools {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 10px 0 14px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-sunken);
}
.grow { flex: 1; }
.tool {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 36px;
  padding: 0 10px;
  font-size: var(--fs-sm);
  font-weight: 500;
  color: var(--text-dim);
  transition: color var(--dur-1) var(--ease-soft), background var(--dur-1) var(--ease-soft);
}
.tool:hover { color: var(--text-muted); background: var(--hover); }
.tool.on { color: var(--text); }
.tool.on::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: -1px;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: var(--accent);
}
.tbadge {
  font-size: 11px;
  padding: 0 5px;
  height: 17px;
  min-width: 17px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--hover);
  color: var(--text-muted);
}
.tool.on .tbadge { background: var(--accent-soft); color: var(--accent); }

.body { flex: 1; min-height: 0; overflow: hidden; background: var(--bg); }

/* The Diff and the Code tab are both a fixed list beside a viewer, sized for
   the full-width column they used to have. In the `panel` candidate the frame
   is 440px, where 320 + 272 of that is the list alone and the viewer has
   nothing left — so the frame, which is what knows how wide it is, stacks
   them. A container query rather than a media query: the window is wide, this
   box is not. */
.review { container-type: inline-size; }

@container (max-width: 620px) {
  .body :deep(.diff),
  .body :deep(.code) {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 40%) minmax(0, 1fr);
  }
}
</style>
