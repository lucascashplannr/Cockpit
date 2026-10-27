<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Component } from 'vue'
import type { Workspace } from '@cockpit/shared'
import { BookMarked, BookOpen, FileCode, GitCompareArrows, Logs, SquareTerminal } from '@lucide/vue'
import CodeTab from './tabs/CodeTab.vue'
import MemoryTab from './tabs/MemoryTab.vue'
import DocsTab from './tabs/DocsTab.vue'
import DiffTab from './tabs/DiffTab.vue'
import CommitsTab from './tabs/CommitsTab.vue'
import OutputTab from './tabs/OutputTab.vue'
import TerminalTab from './tabs/TerminalTab.vue'
import ProjectRepoMenu from './ProjectRepoMenu.vue'
import { changeCount, goTo, onProject, reviewSpan, reviewTools, shownReviewTool, spanDiffAll, spanDiffRepo, spanRepo, spanTerminal, state } from '../core/store.js'
import type { ReviewTool } from '../core/store.js'

/**
 * Layer 3 — reading what came out of the run: the diff, the code around it,
 * what the servers wrote, and the terminal you check it in. Secondary by definition, and
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
  output: { label: 'Output', icon: Logs },
  terminal: { label: 'Terminal', icon: SquareTerminal },
  memory: { label: 'Memory', icon: BookMarked },
  docs: { label: 'Docs', icon: BookOpen },
}

// On the project, or a topic across repositories, every one it stands on: the Diff there is any of them.
const changed = computed(() =>
  reviewSpan.value
    ? reviewSpan.value.repos.reduce((n, w) => n + changeCount(w), 0)
    : changeCount(props.workspace),
)

/**
 * §7 — what the Diff, the Code and the Terminal are on. A checkout is itself;
 * the project, or a topic across repositories, is one of them, named at the
 * end of the strip above the tool (`reviewSpan`).
 */
const repo = computed(() => spanRepo.value ?? props.workspace)
const diffRepo = computed(() => spanDiffRepo.value ?? props.workspace)
// The Terminal alone can also stand at the span's folder, in every repository at once.
const termRepo = computed(() => spanTerminal.value ?? props.workspace)


const docsWaiting = computed(() =>
  (state.docsPending[props.workspace.projectId] ?? []).reduce(
    (n, s) => n + s.files.filter((f) => f.state === 'pending').length,
    0,
  ),
)

const tools = computed(() =>
  reviewTools.value.map((id) => ({
    id,
    ...META[id],
    // §9 — pages waiting on a decision: the one number that asks for you.
    badge: id === 'diff' ? changed.value || undefined : id === 'docs' ? docsWaiting.value || undefined : undefined,
    // The memory has no number worth printing — either something is written
    // down for this scope or nothing is. One dot says that.
    pip: id === 'memory' && props.workspace.hasMemory,
  })),
)

/**
 * Names while they fit, icons when they do not. This was a container query at
 * 470px, a number taken when there were five tools and no repository menu —
 * with six and the menu the strip ran off the column's edge well above it.
 * So it is measured instead: lay the strip out with every name, and if that is
 * wider than the strip, only the tool you are in keeps its name; at the
 * column's floor, with the repository menu beside them, not even that one —
 * and past that, the menu is its icon too, never a name cut to "All repo…".
 * Every layout tried happens before the frame is painted, so nothing is seen
 * flipping.
 *
 * The class is set on the element by hand, not bound: Vue has no static class
 * to re-patch here, and a reactive one would paint the wrong layout once.
 */
const strip = ref<HTMLElement>()
/**
 * Whether the last thing in the strip ends inside its padding. Not
 * `scrollWidth`: a flex row's overflow does not count its end padding, so a
 * menu four pixels too wide read as fitting and then shrank — into "All repo…".
 */
function fits(el: HTMLElement): boolean {
  const last = el.lastElementChild
  if (!last) return true
  const edge = el.getBoundingClientRect().right - parseFloat(getComputedStyle(el).paddingRight)
  return last.getBoundingClientRect().right <= edge + 0.5
}
function fit() {
  const el = strip.value
  if (!el) return
  el.classList.remove('icons', 'tight', 'bare')
  el.classList.add('measure')
  for (const step of ['icons', 'tight', 'bare']) {
    if (fits(el)) break
    el.classList.add(step)
  }
  el.classList.remove('measure')
}
let ro: ResizeObserver | undefined
let mo: MutationObserver | undefined
onMounted(() => {
  if (!strip.value) return
  ro = new ResizeObserver(fit)
  ro.observe(strip.value)
  // A badge arriving, the repository's name changing: the content's width, not the strip's.
  mo = new MutationObserver(fit)
  mo.observe(strip.value, { childList: true, characterData: true, subtree: true })
  fit()
})
onBeforeUnmount(() => {
  ro?.disconnect()
  mo?.disconnect()
})
// Which tool keeps its name is a class on a button, which the observers above do not see.
watch(shownReviewTool, () => nextTick(fit))
</script>

<template>
  <div class="review">
    <nav ref="strip" class="tools">
      <button
        v-for="t in tools"
        :key="t.id"
        class="tool"
        :class="{ on: shownReviewTool === t.id }"
        @click="goTo(t.id)"
      >
        <component :is="t.icon" class="sm" />
        <span class="tl">{{ t.label }}</span>
        <span v-if="t.badge !== undefined" class="tbadge num">{{ t.badge }}</span>
        <span v-else-if="t.pip" class="tpip" />
      </button>
      <!-- §7 — on the project or a topic across repositories, which one these three are on. -->
      <template v-if="reviewSpan && (shownReviewTool === 'diff' || shownReviewTool === 'code' || shownReviewTool === 'terminal')">
        <span class="grow" />
        <ProjectRepoMenu :diff="shownReviewTool === 'diff'" :terminal="shownReviewTool === 'terminal'" />
      </template>
    </nav>


    <div class="body" data-tool>
      <!-- The Diff's other reading, in its place: see `diffMode`. -->
      <CommitsTab v-if="shownReviewTool === 'diff' && state.diffMode === 'commits'" :workspace="diffRepo" />
      <DiffTab v-else-if="shownReviewTool === 'diff'" :workspace="diffRepo" :repos="spanDiffAll" />
      <MemoryTab v-else-if="shownReviewTool === 'memory'" :workspace="workspace" />
      <DocsTab v-else-if="shownReviewTool === 'docs'" :workspace="workspace" />
      <CodeTab v-else-if="shownReviewTool === 'code'" :workspace="repo" />
      <OutputTab v-else-if="shownReviewTool === 'output'" :workspace="workspace" :whole-project="onProject" />
      <TerminalTab v-else-if="shownReviewTool === 'terminal'" :workspace="termRepo" />
    </div>
  </div>
</template>

<style scoped>
/* The column's own ground, and it carries it itself. This lived on `.reviewcol`
   in App.vue, a class the column is only given in `split` — so the same tools
   sat on white beside the conversation and on the window's grey when they had
   the right of the window to themselves. Nothing showed it but the tab strip,
   which is the one band here with no surface of its own; the panels below all
   set theirs. What is genuinely about standing beside another column — the
   rule down the left edge — stays on `.reviewcol`. */
.review {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: var(--surface-review);
}

/* A tab strip, not a header — see the note at the top. It was 52px on the
   raised surface for as long as it was the top of the window in its own
   right; with a bar above it that is no longer true, and a second raised band
   read as a header drawn twice. No drag region either: the window is moved
   from the bar, which now runs the whole way across.

   It keeps the flat ground, but not its own height: the conversation's bar is
   immediately to the left of it and 44 against 49 put two rules five pixels
   apart across one window. `--band-h` is the two of them agreeing. */
.tools {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  height: var(--band-h);
  padding: 0 8px 0 10px;
  /* `--line-soft`, as the conversation's bar has: in `split` the two are one
     band across the window and their rules meet in the middle of it. */
  border-bottom: 1px solid var(--line-soft);
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
.tools .grow { flex: 1; min-width: 8px; }
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
/* The same fact as a badge, minus the number there is none of. */
.tpip { width: 5px; height: 5px; border-radius: 50%; background: var(--agent); }

.body { flex: 1; min-height: 0; overflow: hidden; background: var(--surface-review); }

/* The Diff and the Code tab are both a fixed list beside a viewer, sized for
   the full-width column they used to have. In the `panel` candidate the frame
   is 440px, where 320 + 272 of that is the list alone and the viewer has
   nothing left — so the frame, which is what knows how wide it is, stacks
   them. A container query rather than a media query: the window is wide, this
   box is not. */
.review { container-type: inline-size; }

/* See `fit`. Measuring, nothing gives way — the repository menu would rather
   shrink its name than let the tabs lose theirs, so it is held at full width
   for the one read. Out of room, only the tool you are in keeps its name; the
   rest are their icons, and every one keeps its keystroke (⌘1..⌘n). Then that
   name too (the underline still says which), and last the repository menu's,
   down to its letters — set in the project's settings, or two taken from its
   name, and "All" for the folder — with the whole name in its tooltip. A name cut to "All repo…" looks broken; an icon alone says nothing
   about where you are. */
.tools.measure > * { flex-shrink: 0; }
.tools.icons .tool:not(.on) .tl { display: none; }
.tools.icons .tool:not(.on) { padding: 0 9px; }
.tools.tight .tool .tl { display: none; }
.tools.tight .tool, .tools.icons.tight .tool:not(.on) { padding: 0 7px; }
/* Under an icon alone, the 8px insets left a 14px nub; the icon's width reads as the tab. */
.tools.tight .tool.on::after { left: 5px; right: 5px; }
.tools.bare :deep(.repomenu .nm) { display: none; }
.tools.bare :deep(.repomenu .ini) { display: grid; }
</style>
