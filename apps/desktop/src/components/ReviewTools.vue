<script setup lang="ts">
import { computed } from 'vue'
import type { Component } from 'vue'
import type { Workspace } from '@cockpit/shared'
import { FileCode, GitCompareArrows, ScrollText, Server, SquareTerminal } from '@lucide/vue'
import CodeTab from './tabs/CodeTab.vue'
import DiffTab from './tabs/DiffTab.vue'
import JournalTab from './tabs/JournalTab.vue'
import ServersTab from './tabs/ServersTab.vue'
import TerminalTab from './tabs/TerminalTab.vue'
import { reviewTools, state } from '../core/store.js'
import type { ReviewTool } from '../core/store.js'

/**
 * Layer 3 — reading what came out of the run: the diff, the code around it,
 * the journal, and the terminal you check it in. Secondary by definition, and
 * closed by default: the chat gets the width until there is something to read.
 *
 * Open, it is either a column beside the conversation or the whole right of
 * the window — §12's ladder, held in `state.view`. Nothing in here knows which
 * of the two it is in; it is the same component at two widths, and the
 * container query below is what makes the wide one worth having.
 *
 * The strip at the top is the tools and only the tools. It used to be a 52px
 * header on the raised surface, matching the other two columns, because it
 * was one — the top of the window in its own right. It is not any more: the
 * bar that names the checkout and carries its verbs runs across both columns
 * above this (ScopeBar), and two raised bands stacked would have read as one
 * header drawn twice. So it is a tab strip on the column's own ground.
 */

const props = defineProps<{ workspace: Workspace }>()

const META: Record<ReviewTool, { label: string; icon: Component }> = {
  diff: { label: 'Diff', icon: GitCompareArrows },
  code: { label: 'Code', icon: FileCode },
  servers: { label: 'Servers', icon: Server },
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
        <span class="tl">{{ t.label }}</span>
        <span v-if="t.badge !== undefined" class="tbadge num">{{ t.badge }}</span>
      </button>
    </nav>

    <div class="body">
      <DiffTab v-if="state.reviewTool === 'diff'" :workspace="workspace" />
      <CodeTab v-else-if="state.reviewTool === 'code'" :workspace="workspace" />
      <ServersTab v-else-if="state.reviewTool === 'servers'" :workspace="workspace" />
      <JournalTab v-else-if="state.reviewTool === 'journal'" :workspace="workspace" />
      <TerminalTab v-else-if="state.reviewTool === 'terminal'" :workspace="workspace" />
    </div>
  </div>
</template>

<style scoped>
.review { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; }

/* A tab strip, not a header — see the note at the top. It was 52px on the
   raised surface for as long as it was the top of the window in its own
   right; with a bar above it that is no longer true, and a second raised band
   read as a header drawn twice. No drag region either: the window is moved
   from the bar, which now runs the whole way across. */
.tools {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  height: 44px;
  padding: 0 8px 0 10px;
  border-bottom: 1px solid var(--line);
  min-width: 0;
}
.grow { flex: 1; }
.tool {
  position: relative;
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  /* Full height, so the underline lands on the bar's own bottom edge rather
     than floating eight pixels above it. */
  height: 100%;
  padding: 0 10px;
  white-space: nowrap;
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

/* Five tools with five names need about 460px, and the column's floor is 320 —
   so at the widths it is actually dragged to, the last tab used to be cut in
   half by the window's edge. Only the tool you are in keeps its name; the rest
   are their icons, which is what a tab strip does when it runs out of room,
   and every one of them keeps its keystroke (⌘1..⌘n). */
@container (max-width: 470px) {
  .tool:not(.on) .tl { display: none; }
  .tool:not(.on) { padding: 0 9px; }
}

/* The Code tab still stacks its list over its viewer here. The Diff tab used
   to as well, and stopped: a hunk in the bottom two fifths of a narrow column
   was a few clipped lines under the two blocks you were actually reading. It
   measures itself now and opens a file over its list instead, which is why
   this rule no longer names it. */
@container (max-width: 620px) {
  .body :deep(.code) {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 40%) minmax(0, 1fr);
  }
}
</style>
