<script setup lang="ts">
import { attentionIcon } from './agent/attention.js'
import { markIcon } from './agent/mark.js'
import { computed } from 'vue'
import {
  ArrowDownToLine, ArrowUp, Asterisk, FileDiff, GitBranch, GitCompareArrows, Hourglass,
  SquareDot, StickyNote, TriangleAlert,
} from '@lucide/vue'
import type { Workspace } from '@cockpit/shared'
import StripDots, { type StripSlot } from './StripDots.vue'
import {
  activeProject, activityFor, busyVerb, busyWord, gitBusy, hoverTopicMarkMenu, leaveMarkMenu, MARK_WORDS, onProject, openContextMenu, openTopicMarkMenu, pickRepo,
  projectNarrowing, selectedGroupId, selectedTopicId, selectWorkspace, pushCount, repoMark, shortName, state,
} from '../core/store.js'

/**
 * `narrow` is the list folded down to its strip (§12, ⌘B): the same row, as a
 * tile — its glyph over its name, and three dots where the counters were.
 */
const props = defineProps<{ workspace: Workspace; compact?: boolean; narrow?: boolean }>()

const w = computed(() => props.workspace)
// Selecting a topic anchors the panel on one of its rows, so the row id
// alone would light two things at once. The narrower selection wins: while the
// topic is what is selected, none of its rows is — and the same on the project.
const selected = computed(
  () => w.value.id === state.activeWorkspaceId && !selectedTopicId.value && !selectedGroupId.value && !onProject.value,
)

/* ── §7 — the project, narrowed ───────────────────────────────────────────
 * Standing on the project, this row is one of the repositories a conversation
 * there runs in — or one that was left out. A ⌘-click puts this one in or
 * takes it out, as it does in any list that holds more than one selection.
 *
 * Lit only once narrowed: the whole project is every row, and every row lit
 * said nothing but put a selection on the list that nobody had made.
 */
const lit = computed(() => {
  const n = projectNarrowing.value
  return !!n && n.narrowed && n.picked.includes(w.value.id)
})

function press(e: MouseEvent): void {
  if (e.metaKey) pickRepo(w.value.id)
  else selectWorkspace(w.value.id)
}

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
const up = computed(() => w.value.runtime?.status === 'up')

/**
 * The slot an act is running on, for the strip to turn: a server coming up on
 * the left, a commit on the changes it takes, anything that talks to the
 * remote (push, pull, catch up…) on the middle one.
 */
const COMMITTING = new Set(['commit', 'amend', 'undo commit', 'stash', 'stash pop', 'stash apply', 'stash drop'])
const busySlot = computed<StripSlot | null>(() => {
  const op = busyVerb(gitBusy[w.value.id])
  if (op) return COMMITTING.has(op) ? 'dirty' : 'push'
  if (w.value.runtime?.status === 'starting') return 'run'
  return null
})

const behindBase = computed(() => w.value.git?.behindBase ?? 0)

/**
 * Only against this branch's *own* remote. A topic branch tracks
 * `origin/<base>` until its first push, and `behind` there is the base's
 * distance wearing the wrong name — already counted to the left.
 */
const toPull = computed(() => {
  const g = w.value.git
  return g && g.branch && g.upstream === 'origin/' + g.branch ? g.incoming : 0
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
 * On the strip there is room for one word, so it had better be the one that
 * tells this row from the next. A repository says its initials — the same ones
 * the repository menu shows (`repoMark`). A branch keeps its name, which in a
 * project whose repositories are all `cashplannr-something` is the something.
 */
// Three letters on the strip: a cut-off name with an ellipsis said less than a
// clean prefix, and the full name is in the hover.
const short = computed(() =>
  w.value.kind === 'main'
    ? repoMark(w.value, state.workspaces.filter((x) => x.projectId === w.value.projectId))
    : shortName(w.value.name, activeProject.value?.name).slice(0, 3),
)

/**
 * The counters, in words: the strip has a dot where the wide row has numbers,
 * and what the dot stands for should be one hover away rather than one ⌘B.
 */
const tip = computed(() => {
  const g = w.value.git
  const facts: string[] = []
  if (g) {
    if (pushCount(g)) facts.push(pushCount(g) + ' to push')
    if (behindBase.value) facts.push(behindBase.value + ' behind ' + (g.base ?? 'the base'))
    if (toPull.value) facts.push(toPull.value + ' to pull')
    if (dirty.value) facts.push(dirty.value + ' uncommitted')
    if (g.conflicted) facts.push(g.conflicted + ' conflicted')
    if (g.headState !== 'attached') facts.push(g.headState)
  }
  if (up.value) facts.unshift('server up')
  if (gitBusy[w.value.id]) facts.unshift(busyWord(gitBusy[w.value.id]) + '…')
  else if (busySlot.value === 'run') facts.unshift('Starting the server…')
  return [w.value.name + ' — ' + lead.value.title, facts.join(' · '), ownTip.value].filter(Boolean).join('\n')
})

/** Where you said this repository stands: kept until changed, like a topic's. */
const own = computed(() => (w.value.kind === 'main' ? (w.value.mark ?? null) : null))
const ownTip = computed(() => {
  const m = own.value
  return m ? [m.kind ? MARK_WORDS[m.kind] : 'Note', m.note].filter(Boolean).join('\n') : ''
})

/** Under the note glyph, its right edge on the glyph's, as on a topic's header. */
function underOwn(e: MouseEvent): { x: number; y: number } {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  return { x: r.right + 4 - 300, y: r.bottom + 6 }
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
  if (a.background)
    return { icon: Hourglass, cls: 'waiting', title: kindLabel.value + ' · an agent is waiting on what it left running' }
  // With nothing live to say, what you said about it yourself, as a topic does.
  const m = own.value
  if (m?.kind) return { icon: markIcon(m.kind), cls: 'own k-' + m.kind, title: kindLabel.value + ' · ' + MARK_WORDS[m.kind] }
  return { icon: w.value.kind === 'worktree' ? GitBranch : SquareDot, cls: '', title: kindLabel.value }
})
</script>

<template>
  <button
    class="row"
    :class="{ selected, compact, menued, narrow, lit }"
    :title="narrow ? tip : undefined"
    @click="press"
    @contextmenu.prevent="openContextMenu($event, { kind: 'workspace', id: w.id })"
  >
    <!-- The row's one icon, and it says the most urgent true thing: a hand
         while an agent waits on you, the agent's mark while one works, why it
         wants you once it has stopped — and only then what kind of row this
         is. The kind is on hover and in the tree; it is never news.

         The mark turns only when the agent was started on this row. One
         started on the topic above reaches here too, and the row says so
         with the same mark held still: the one that moves is where to look. -->
    <span class="kind" :class="lead.cls" :title="narrow ? undefined : lead.title">
      <component :is="lead.icon" class="sm" :class="{ 'agent-star': lead.cls === 'working' && act.own }" />
    </span>

    <!-- §12 — the branch is the identity; the repository name is context. -->
    <span class="name">{{ narrow ? short : w.name }}</span>

    <!-- The strip's counters: the project tile's three places, one column
         to the left — a server up, commits to push, something uncommitted.
         How much of each is in the hover. -->
    <StripDots
      v-if="narrow"
      :run="up"
      :push="!!w.git?.ahead"
      :dirty="!!dirty"
      :conflict="!!w.git?.conflicted"
      :busy="busySlot"
    />

    <span v-if="!narrow" class="meta num">
      <!-- Absent capability, absent indicator (§3.9): no git means no counters. -->
      <template v-if="w.git">
        <span v-if="pushCount(w.git)" class="c ahead" :title="pushCount(w.git) + ' commit(s) to push'">
          <ArrowUp class="sm" />{{ pushCount(w.git) }}
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
          <FileDiff class="sm" />{{ dirty }}
        </span>
        <span v-if="w.git.conflicted" class="c conflict" :title="'conflicted'">
          <TriangleAlert class="sm" />{{ w.git.conflicted }}
        </span>
        <span v-if="w.git.headState !== 'attached'" class="chip danger">{{ w.git.headState }}</span>
      </template>
      <!-- Your note on it, at the end; its status leads the row. Hover or
           click for the popup that reads it. -->
      <span
        v-if="own?.note"
        class="own"
        role="button"
        aria-label="Note"
        @mouseenter="hoverTopicMarkMenu(underOwn($event), w.id, 'repo')"
        @mouseleave="leaveMarkMenu"
        @click.stop="openTopicMarkMenu(underOwn($event), w.id, 'repo')"
      >
        <StickyNote class="sm" />
      </span>

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

/* In the project's scope: the list's own selected tint, on every row that is
   in rather than on the one you stand on. */
.row.lit { background: var(--selected); color: var(--text); }
.row.lit .kind { color: var(--accent); }

.kind { color: var(--text-dim); display: flex; flex: none; }
/* One width whatever it holds, so the name does not step sideways when an
   agent starts or stops. */
.kind { width: 16px; justify-content: center; margin: 0 -1px; }
/* The turning mark a size up from the other icons: it is small for its box,
   and it is the one thing on the row that moves. */
.kind.working .lucide { width: 16px; height: 16px; stroke-width: 2.4; }
.row.selected .kind { color: var(--accent); }
/* An agent's state keeps its own colour on the selected row too: the
   selection tint says where you are, this says what needs you. */
.row .kind.working, .row .kind.waiting { color: var(--agent); }
.row .kind.approval, .row .kind.blocked { color: var(--warn); }
.row .kind.reply { color: var(--agent); }
.row .kind.failed { color: var(--danger); }
/* The hand at the default weight reads as bold beside the row's name. */
.kind.approval .lucide { stroke-width: 1.75; }
/* Your status, in its own ink, as on a topic's lid: hold and a note stay dim. */
.row .kind.own { color: var(--text-muted); }
.row .kind.own.k-review { color: var(--accent); }
.row .kind.own.k-done { color: var(--ok); }
.row .kind.own.k-brainstorm { color: var(--info); }
/* The note glyph: the topic header's, to the pixel. */
.meta .own {
  flex: none;
  display: inline-flex;
  align-items: center;
  padding: 3px;
  margin: -3px;
  border-radius: 4px;
  color: var(--text-dim);
}
.meta .own .lucide { width: 12px; height: 12px; stroke-width: 2.1; }
.meta .own:hover { color: var(--text); background: var(--line-soft); }

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
/* ── the strip ────────────────────────────────────────────────────────── */
/* The row stood on end: glyph over name. The name is what makes it a tile
   you can read rather than one you have to hover — a column of identical
   squares would say "five repositories" and nothing about which is which. */
/* The numbers are the list's (`.list.narrow` in WorkspaceList), so a row and
   a topic's tile cannot drift apart; the fallbacks are those same values, for
   a row drawn anywhere else. */
.row.narrow {
  position: relative;
  flex-direction: column;
  justify-content: center;
  gap: var(--tile-stack, 5px);
  height: var(--tile-h, 58px);
  padding: 0 4px;
}
.row.narrow .kind .lucide { width: var(--tile-ic, 15px); height: var(--tile-ic, 15px); }
.row.narrow .name {
  flex: none;
  max-width: 100%;
  text-align: center;
  font-size: var(--tile-lbl, 10px);
  line-height: 1.15;
  letter-spacing: 0;
}
.ahead { color: var(--ok); }
.behind { color: var(--warn); }
.dirty { color: var(--warn); }
.conflict { color: var(--danger); font-weight: 600; }
</style>
