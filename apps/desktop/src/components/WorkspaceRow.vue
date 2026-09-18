<script setup lang="ts">
import { attentionIcon } from './agent/attention.js'
import { computed } from 'vue'
import {
  ArrowDownToLine, ArrowUp, Asterisk, GitBranch, GitCompareArrows,
  SquareDot, TriangleAlert,
} from '@lucide/vue'
import type { Workspace } from '@cockpit/shared'
import {
  activityFor, openContextMenu, selectedTopicId, selectWorkspace, state,
} from '../core/store.js'

const props = defineProps<{ workspace: Workspace; compact?: boolean }>()

const w = computed(() => props.workspace)
// Selecting a topic anchors the panel on one of its rows, so the row id
// alone would light two things at once. The narrower selection wins: while the
// topic is what is selected, none of its rows is.
const selected = computed(
  () => w.value.id === state.activeWorkspaceId && !selectedTopicId.value,
)

/** The right-click menu is open on this row: it keeps the hover tint, so you can see what it is about. */
const menued = computed(
  () => state.contextMenu?.target.kind === 'workspace' && state.contextMenu.target.id === w.value.id,
)

const dirty = computed(() => {
  const g = w.value.git
  return g ? g.staged + g.unstaged + g.untracked : 0
})

/**
 * §4 — the two distances a row can be behind, drawn separately because they
 * are closed by two different verbs.
 *
 *   the base moved     → Catch up, `behindBase`
 *   its own remote     → Pull, `behind`
 *
 * One counter tried to serve both and could not: `behindBase ?? behind` falls
 * back only on null, so a topic branch level with its base (`behindBase: 0`)
 * and one commit behind its own remote showed nothing at all — while the bar
 * beside it offered `Pull 1`. `||` would have fixed that case and lost the
 * other, hiding the base's count whenever both were live.
 *
 * So: the same two glyphs the bar uses for the same two verbs, each drawn only
 * when it has something to say. In the ordinary case that is still one number.
 */
const behindBase = computed(() => w.value.git?.behindBase ?? 0)

/**
 * Only against this branch's *own* remote. A topic branch tracks
 * `origin/<base>` until its first push, and `behind` there is the base's
 * distance wearing the wrong name — already counted to the left.
 */
const toPull = computed(() => {
  const g = w.value.git
  return g && g.branch && g.upstream === 'origin/' + g.branch ? g.behind : 0
})

/**
 * §12 — "où j'en suis", for the one thing that moves while you are looking
 * somewhere else. Read from the conversations rather than from
 * `w.agentSessions`: that array only ever holds running sessions, and a
 * conversation that finished and has not been read is exactly what this row
 * has to be able to say.
 */
const act = computed(() => activityFor('workspace', w.value.id))

const ATTENTION_TEXT: Record<string, string> = {
  approval: 'an agent here is waiting for you to allow a tool call',
  reply: 'an agent answered here — waiting for you',
  blocked: 'an agent stopped here: it was refused a tool it needed',
  failed: 'an agent failed here',
}

/**
 * Two things live in this list and the icon is what tells them apart: a
 * repository sitting on its default branch, and a branch checked out in a
 * folder of its own. "Worktree" is how git does the second one; it is not
 * what the row is.
 */
const kindLabel = computed(() =>
  w.value.kind === 'main'
    ? 'repository'
    : w.value.kind === 'worktree'
      ? 'branch'
      : w.value.kind === 'external'
        ? 'folder'
        : w.value.kind,
)

/** What the leading icon shows, in order of who has to do something next. */
const lead = computed(() => {
  const a = act.value
  if (a.attention === 'approval')
    return { icon: attentionIcon('approval'), cls: 'approval', title: kindLabel.value + ' · ' + ATTENTION_TEXT.approval }
  if (a.running)
    return { icon: Asterisk, cls: 'working', title: kindLabel.value + ' · an agent is working here' }
  if (a.attention !== 'none')
    return { icon: attentionIcon(a.attention), cls: a.attention, title: kindLabel.value + ' · ' + ATTENTION_TEXT[a.attention] }
  return { icon: w.value.kind === 'worktree' ? GitBranch : SquareDot, cls: '', title: kindLabel.value }
})
</script>

<template>
  <button
    class="row"
    :class="{ selected, compact, menued }"
    @click="selectWorkspace(w.id)"
    @contextmenu.prevent="openContextMenu($event, { kind: 'workspace', id: w.id })"
  >
    <!-- The row's one icon, and it says the most urgent true thing: a hand
         while an agent waits on you, the turning mark while one works, why it
         wants you once it has stopped — and only then what kind of row this
         is. The kind is on hover and in the tree; it is never news. -->
    <span class="kind" :class="lead.cls" :title="lead.title">
      <component :is="lead.icon" class="sm" :class="{ 'agent-star': lead.cls === 'working' }" />
    </span>

    <!-- §12 — the branch is the identity; the repository name is context. -->
    <span class="name">{{ w.name }}</span>

    <span class="meta num">
      <!-- Absent capability, absent indicator (§3.9): no git means no counters. -->
      <template v-if="w.git">
        <span v-if="w.git.ahead" class="c ahead" :title="w.git.ahead + ' commit(s) ahead'">
          <ArrowUp class="sm" />{{ w.git.ahead }}
        </span>
        <!-- One ↓, and it counts whichever distance this row can actually act
             on: the base while there is a base to catch up from, and otherwise
             its own remote, which is what a row sitting on the base is behind.
             Two arrows for the two would say the row has twice as much wrong
             with it as it does; the verb that closes each is on the bar, with
             its own number. -->
        <span
          v-if="behindBase"
          class="c behind"
          :title="behindBase + ' commit(s) behind ' + (w.git.base ?? 'the base') + ' — Catch up brings them in'"
        >
          <GitCompareArrows class="sm" />{{ behindBase }}
        </span>
        <span
          v-if="toPull"
          class="c behind"
          :title="toPull + ' commit(s) on ' + w.git.upstream + ' you do not have — Pull brings them in'"
        >
          <ArrowDownToLine class="sm" />{{ toPull }}
        </span>
        <span v-if="dirty" class="c dirty" :title="dirty + ' uncommitted change(s)'">
          <i class="pip" />{{ dirty }}
        </span>
        <span v-if="w.git.conflicted" class="c conflict" :title="'conflicted'">
          <TriangleAlert class="sm" />{{ w.git.conflicted }}
        </span>
        <span v-if="w.git.headState !== 'attached'" class="chip danger">{{ w.git.headState }}</span>
      </template>

    </span>
  </button>
</template>

<style scoped>
.row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  height: var(--row-h);
  padding: 0 10px 0 11px;
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--text-muted);
  transition:
    background var(--dur-1) var(--ease-soft),
    color var(--dur-1) var(--ease-soft);
}
/* Under a topic header, stepped in by the width of that header's chevron.
   The `compact` flag has been passed down since the list first grouped rows
   and never did anything; the gap between groups was carrying the hierarchy
   on its own. Now that the gap is a fifth of what it was, the indent is what
   says these rows belong to the line above them. */
.row.compact { padding-left: 29px; }

.row:hover, .row.menued { background: var(--hover); }
/* The tint is the whole signal. There was an accent bar down the left edge as
   well, which is the convention for a rail whose items are otherwise
   undecorated — here it sat against a filled row, an icon that already turns
   accent, and a name that already gains weight, so it was a fourth voice
   saying a thing three others had said. */
.row.selected { background: var(--selected); color: var(--text); }

.kind { color: var(--text-dim); display: flex; flex: none; }
/* One width whatever it holds, so the name does not step sideways when an
   agent starts or stops. */
.kind { width: 16px; justify-content: center; }
/* The turning mark a size up from the other icons: it is small for its box,
   and it is the one thing on the row that moves. */
.kind.working .lucide { width: 16px; height: 16px; stroke-width: 2.4; }
.row.selected .kind { color: var(--accent); }
/* An agent's state keeps its own colour on the selected row too: the
   selection tint says where you are, this says what needs you. */
.row .kind.working { color: var(--agent); }
.row .kind.approval, .row .kind.blocked { color: var(--warn); }
.row .kind.reply { color: var(--agent); }
.row .kind.failed { color: var(--danger); }
/* The hand at the default weight reads as bold beside the row's name. */
.kind.approval .lucide { stroke-width: 1.75; }

.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-md);
  font-weight: 450;
  letter-spacing: -0.005em;
}
.row.selected .name { font-weight: 550; }

.meta {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: var(--fs-xs);
  flex: none;
}
.c {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.c .lucide { width: 11px; height: 11px; stroke-width: 2.4; }
.ahead { color: var(--ok); }
.behind { color: var(--warn); }
.dirty { color: var(--warn); }
.conflict { color: var(--danger); font-weight: 600; }
.pip {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  margin-right: 2px;
}
</style>
