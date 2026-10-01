<script setup lang="ts">
import { attentionIcon } from './agent/attention.js'
import { computed, nextTick, ref, watch } from 'vue'
import type { Component } from 'vue'
import {
  ArrowUp, Asterisk, ChevronRight, FolderPlus, Layers, Plus, Sparkles,
} from '@lucide/vue'
import WorkspaceRow from './WorkspaceRow.vue'
import ListToggle from './ListToggle.vue'
import {
  activeProject, activityFor, collapsedTopics, listWide, openAgentOn, openContextMenu,
  selectedTopicId, state, toggleTopicCollapsed, workspaceGroups,
} from '../core/store.js'

/**
 * §12 — "La liste centrale liste des workspaces, groupés par topic quand un
 * topic existe. Un workspace nu et un groupe de trois cohabitent
 * naturellement." The topic header only appears when there is a topic.
 *
 * Two kinds of row, and the vocabulary is theirs: a repository on its default
 * branch, and a branch checked out in its own folder.
 */

const groups = computed(() => workspaceGroups.value)

const hasProjects = computed(() => state.projects.length > 0)

/**
 * §12 — the list folded down to its strip (⌘B). Same groups, same rows, same
 * order; each one stood on end, and the header and foot keep their acts as
 * glyphs. Nothing is a different component, so nothing can be on the strip
 * and missing from the list, or the other way round.
 */
const narrow = computed(() => !listWide.value)

/**
 * The strip is taller per row than the list, so where the scroll was means
 * nothing after the switch. What does mean something is the row you are on.
 */
const scroller = ref<HTMLElement | null>(null)
watch(narrow, () => {
  void nextTick(() => {
    scroller.value?.querySelector('.selected, .holding')?.scrollIntoView({ block: 'nearest' })
  })
})

/**
 * A topic's header on the strip is one tile, and a tile is one button — but
 * the header does two things, stand-on and fold. So: press it to stand on the
 * topic, press it again to fold or open it. The same rule the rail has for
 * the project you are already in, for the same reason: the lit thing has
 * nowhere left to take you.
 */
function pressTopic(topicId: string): void {
  if (topicId === selectedTopicId.value) toggleTopicCollapsed(topicId)
  else selectTopic(topicId)
}

/** What the strip's topic tile leads with: the most urgent true thing, as a row does. */
function topicLead(topicId: string): { icon: Component; cls: string } {
  const a = activityFor('topic', topicId)
  if (a.attention !== 'none') return { icon: attentionIcon(a.attention), cls: a.attention }
  if (a.running) return { icon: Asterisk, cls: 'working' }
  // The topic's own mark, the one it has in the palette, the dialog and the
  // bar. A chevron stood here first — it is what the wide header leads with —
  // but there it is a control beside a name, and here it was the only picture
  // the tile had: a column of dropdown arrows, saying "this opens" about a
  // thing whose first job is to say what it is.
  return { icon: Layers, cls: '' }
}

function topicTip(g: { title: string | null; topicId: string | null; workspaces: { git: { ahead: number } | null }[] }): string {
  const id = g.topicId!
  const a = activityFor('topic', id)
  const facts: string[] = []
  if (a.attention !== 'none') facts.push(ATTENTION_TEXT[a.attention] ?? '')
  else if (a.running) facts.push(a.running + ' conversation(s) running on this topic')
  if (unpushed(g.workspaces)) facts.push(unpushed(g.workspaces) + ' commit(s) not pushed')
  facts.push(id === selectedTopicId.value
    ? (collapsedTopics[id] ? 'Click to show its branches' : 'Click to fold it away')
    : 'Click to aim the agent at the whole topic')
  return [g.title + ' — topic', ...facts].filter(Boolean).join('\n')
}

/**
 * The one number a folded topic still owes you: how much of its work is not
 * pushed yet. `up` and `total` used to come back from here too — nobody was
 * reading the first, and the second was the count in the header that said
 * what the rows underneath already said.
 */
function unpushed(ws: { git: { ahead: number } | null }[]): number {
  return ws.reduce((n, w) => n + (w.git?.ahead ?? 0), 0)
}

/**
 * §4 — the topic is the unit of work, so it is something you select, exactly
 * as you select one of its rows. Selecting it aims the agent at the whole
 * topic; its verbs — merge, rebase, start — are then in the title band, where
 * the verbs of the selected thing belong (TopicActions).
 */
function selectTopic(topicId: string) {
  openAgentOn({ kind: 'topic', topicId }, { reveal: false })
}

/**
 * §4 — a topic is where the work is put down and picked back up, so it is also
 * where "an agent is on this" has to be visible. A conversation opened on the
 * topic itself lights this, and so does one opened on any single row under it:
 * from the header, both are the same answer to "is something happening here".
 */
/**
 * A folded topic still has to answer "is my selection in there": the third
 * column goes on showing a branch whose row is now hidden, and a header that
 * said nothing would leave the window pointing at something with no trace of
 * it in the list.
 */
function holdsSelection(ws: { id: string }[]): boolean {
  return ws.some((x) => x.id === state.activeWorkspaceId)
}

const ATTENTION_TEXT: Record<string, string> = {
  approval: 'an agent on this topic is waiting for you to allow a tool call',
  reply: 'an agent answered on this topic — waiting for you',
  blocked: 'an agent stopped on this topic: it was refused a tool it needed',
  failed: 'an agent failed on this topic',
}
</script>

<template>
  <section class="list" :class="{ narrow }">
    <!-- The column's own header, on the height every other one uses. It names
         the project the column is of — the one thing the rail could only say
         with two letters — and the one control that is about the column
         itself: how wide it is (ListToggle). On the strip the name goes (the
         lit tile beside it is saying it) and the control stays, centred, so
         the top of the column is where you narrow it and where you widen it.

         Everything that *acts on the project* is at the foot. Three glyphs
         lived up here once, then two; a header that names a thing and a
         toolbar that does things to it are two jobs, and 68px has room for
         one. -->
    <header v-if="activeProject" class="top">
      <span v-if="!narrow" class="pname" :title="activeProject.name + '\n' + activeProject.root">
        {{ activeProject.name }}
      </span>
      <span v-if="!narrow" class="grow" />
      <ListToggle />
    </header>

    <div ref="scroller" class="scroll">
      <div v-if="!hasProjects" class="empty">
        <FolderPlus />
        <strong>No project yet</strong>
        <span>
          Add one with <span class="kbd">+</span> in the rail, or run
          <code class="mono">cockpit add .</code> in any repository.
        </span>
      </div>

      <template v-else>
        <div v-for="(g, i) in groups" :key="g.topicId ?? 'loose-' + i" class="group">
          <!-- A topic is a decoration (§4): no topic, no header. And a
               header you can stand on: selecting it is selecting its scope. -->
          <!-- On the strip the header is one tile: what it leads with, and
               its name under it. Its counters are in the hover. -->
          <button
            v-if="g.title && narrow && g.topicId"
            class="group-tile"
            :class="{
              selected: g.topicId === selectedTopicId,
              holding: collapsedTopics[g.topicId] && holdsSelection(g.workspaces),
              menued: state.contextMenu?.target.kind === 'topic' && state.contextMenu.target.id === g.topicId,
            }"
            :title="topicTip(g)"
            @click="pressTopic(g.topicId)"
            @contextmenu.prevent="openContextMenu($event, { kind: 'topic', id: g.topicId })"
          >
            <span class="lead" :class="topicLead(g.topicId).cls">
              <component :is="topicLead(g.topicId).icon" class="sm" />
            </span>
            <span class="title">{{ g.title }}</span>
          </button>
          <div
            v-else-if="g.title"
            class="group-head"
            :class="{
              running: g.topic?.state === 'running',
              selected: g.topicId === selectedTopicId,
              // Folded over the row you are standing on: the header stands in
              // for it, so it takes the tint the row would have had.
              holding: !!g.topicId && collapsedTopics[g.topicId] && holdsSelection(g.workspaces),
              menued: !!g.topicId && state.contextMenu?.target.kind === 'topic' && state.contextMenu.target.id === g.topicId,
            }"
            @contextmenu.prevent="g.topicId && openContextMenu($event, { kind: 'topic', id: g.topicId })"
          >
            <!-- Its own control, because folding is not selecting: the header
                 is a place to stand as much as a lid to close. -->
            <button
              v-if="g.topicId"
              class="twist"
              :title="collapsedTopics[g.topicId] ? 'Show its branches' : 'Fold this topic away'"
              @click="toggleTopicCollapsed(g.topicId)"
            >
              <ChevronRight class="sm" :class="{ turned: !collapsedTopics[g.topicId] }" />
            </button>
            <Layers v-else class="sm gi" />
            <button
              class="pick"
              :disabled="!g.topicId"
              @click="g.topicId && selectTopic(g.topicId)"
            >
              <span class="title">{{ g.title }}</span>
            </button>
            <span class="summary num">
              <!-- A 5px accent dot used to sit here to say the selection was
                   folded inside. Nobody could know that: it had a tooltip and
                   no legend. The header takes the list's own selected tint
                   instead — one vocabulary, already learned. -->
              <span
                v-if="g.topicId && activityFor('topic', g.topicId).running && activityFor('topic', g.topicId).attention !== 'approval'"
                class="agent"
                :title="activityFor('topic', g.topicId).running + ' conversation(s) running on this topic'"
              >
                <Asterisk class="sm agent-star" />
              </span>
              <span
                v-if="g.topicId && activityFor('topic', g.topicId).attention !== 'none'"
                class="needs"
                :class="activityFor('topic', g.topicId).attention"
                :title="ATTENTION_TEXT[activityFor('topic', g.topicId).attention]"
              >
                <component
                  :is="attentionIcon(activityFor('topic', g.topicId).attention)"
                  class="sm"
                />
              </span>
              <span v-if="unpushed(g.workspaces)" class="up">
                <ArrowUp class="sm" />{{ unpushed(g.workspaces) }}
              </span>
              <!-- §4 — an inferred topic looks exactly like an opened one here, and
                   then behaves like neither: half its verbs are missing from the
                   menu with nothing on the row to have warned you.

                   A word, not a glyph. The dashed outline this replaces was the
                   honest try at a mark for "provisional", and it read as noise:
                   nothing in that icon says which of the two kinds of topic it
                   means. The list already speaks in small dim capitals — "not in
                   a topic" one group down — so this is that vocabulary rather
                   than a new one, and it doubles as the way into the sheet that
                   explains it.

                   Last, so it is the thing against the edge: what a topic *is*
                   holds still, while the counters beside it come and go. -->
              <button
                v-if="g.topic?.derived"
                class="inferred"
                title="Inferred from branches sharing this name — not a topic opened here, so it cannot be renamed, started, closed or deleted. Click for what that means."
                @click.stop="state.detailsFor = { kind: 'topic', id: g.topicId! }"
              >
                inferred
              </button>
              <!-- How many branches are under it was here, folded or not. It
                   is the least interesting true thing about a topic: open, the
                   rows say it; folded, it is a number nobody acts on. -->
            </span>
          </div>
          <div v-else-if="groups.length > 1 && i > 0" class="divider">
            <span v-if="!narrow" class="section-label">not in a topic</span>
          </div>

          <WorkspaceRow
            v-for="w in (g.topicId && collapsedTopics[g.topicId] ? [] : g.workspaces)"
            :key="w.id"
            :workspace="w"
            :compact="!!g.title"
            :narrow="narrow"
          />
        </div>
      </template>
    </div>

    <!-- The foot: the two acts that are about the project as a whole, under
         everything the project holds. Always here, wide or narrow, so neither
         has to be looked for after ⌘B.

         §4 — a new topic: one named branch across every repository it
         touches. §7 — and the widest scope, from the thing it is scoped to:
         every repository in the project, at its main checkout. Last, because
         it is the one of the two you reach for most.

         Adding a repository was here too, and before that in the header. It
         is in the project's settings now (ProjectDialog): it changes what the
         project *is*, once a month, and this column is for moving around in
         what it holds, all day. -->
    <footer v-if="activeProject && hasProjects" class="foot">
      <button
        class="add"
        title="Open a topic — one named branch across every repository it touches"
        @click="state.topicDialogOpen = true"
      >
        <Plus class="sm" />
        <span v-if="!narrow" class="lbl">Open a topic</span>
      </button>
      <button
        class="add go"
        title="Ask the agent across the whole project — every repository, on its default branch"
        @click="openAgentOn({ kind: 'project', projectId: activeProject.id })"
      >
        <Sparkles class="sm" />
        <span v-if="!narrow" class="lbl">Ask across the project</span>
      </button>
    </footer>
  </section>
</template>

<style scoped>
.list {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--surface-nav);
  border-right: 1px solid var(--line);
}

/* The same height as the conversation's bar, so the two columns are headed
   on one line; the column's own surface, like every header. Also a place to pick the window up. */
.top {
  -webkit-app-region: drag;
  flex: none;
  display: flex;
  align-items: center;
  gap: 0;
  /* Fixed, not a minimum: nothing in this header wraps, so a height it can
     only meet exactly is one less thing that can quietly grow. */
  height: 52px;
  padding: 0 8px 0 14px;
  background: var(--surface-nav);
  border-bottom: 1px solid var(--line);
}
.top button { -webkit-app-region: no-drag; }
.pname {
  min-width: 0;
  line-height: 1;
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.top .grow { flex: 1; }
/* An act on the project, the size of its hit area — as it was when there were
   three and they had to read as one cluster: the buttons are the size of
   their hit area and nothing is added between them. The glyphs sit 10px apart,
   which is close enough to group them and far enough to aim at. */
.top .icon-btn { width: 26px; height: 26px; }

.scroll {
  flex: 1;
  overflow-y: auto;
  padding: 8px 10px 12px;
}

/* Under the rows, not ruled off from them: the list's own last lines, in the
   row's box and the row's inset, a step dimmer because they are offers rather
   than places. */
.foot { flex: none; padding: 4px 10px 10px; }
.add {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  height: var(--row-h);
  padding: 0 10px 0 11px;
  border-radius: var(--radius-sm);
  text-align: left;
  font-size: var(--fs-sm);
  color: var(--text-dim);
  transition:
    background var(--dur-1) var(--ease-soft),
    color var(--dur-1) var(--ease-soft);
}
.add:hover { background: var(--hover); color: var(--text); }
/* The one verb here that is not git: it gets the accent that means agent. */
.add.go:hover { color: var(--agent); background: var(--agent-soft); }
.add .lucide { flex: none; margin: 0 1px; }

/* ── the strip (§12, ⌘B) ─────────────────────────────────────────────── */
/* The numbers every tile on it is built from, here because the rows are
   another component and have to agree with the topic tiles to the pixel
   (WorkspaceRow reads the same five).

   It was 64 wide with 44px tiles and a name reaching both walls of its tile:
   everything fitted and nothing had room. 72 and 54 were tried and were too
   much the other way — a strip is there to give width back. This is the step
   between: a little air on every side of what a tile holds, and no more. */
.list.narrow {
  --tile-h: 48px;
  --tile-gap: 0px;
  --tile-stack: 5px;
  --tile-lbl: 10px;
  --tile-ic: 15px;
}
.list.narrow .top { justify-content: center; padding: 0; }
.list.narrow .scroll { padding: 10px 8px 12px; scrollbar-width: none; }
.list.narrow .scroll::-webkit-scrollbar { display: none; }
.list.narrow .group { display: flex; flex-direction: column; gap: var(--tile-gap); }
.list.narrow .foot { padding: 4px 8px 12px; }
.list.narrow .add { justify-content: center; padding: 0; height: 36px; }
.list.narrow .add .lucide { width: var(--tile-ic); height: var(--tile-ic); }
/* What the indent and the header's weight say in the list, a rule says here:
   there is no width left to step anything in by. Short of the walls, so it
   separates two groups without boxing either. */
.list.narrow .group + .group {
  margin-top: 10px;
  padding-top: 10px;
  position: relative;
}
.list.narrow .group + .group::before {
  content: '';
  position: absolute;
  top: 0;
  left: 12px;
  right: 12px;
  border-top: 1px solid var(--line);
}
.list.narrow .divider { display: none; }

/* The topic's header as a tile: the row's own box on end, in the header's
   weight, so a topic and the branches under it are told apart by the same
   thing that tells them apart in the list. */
.group-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--tile-stack);
  width: 100%;
  height: var(--tile-h);
  padding: 0 4px;
  border-radius: var(--radius-sm);
  color: var(--text);
  transition: background var(--dur-1) var(--ease-soft);
}
.group-tile:hover, .group-tile.menued { background: var(--hover); }
.group-tile.selected, .group-tile.holding { background: var(--selected); }
.group-tile .title {
  flex: none;
  max-width: 100%;
  font-size: var(--tile-lbl);
  line-height: 1.15;
  letter-spacing: 0;
  text-align: center;
}
.group-tile .lead { display: flex; color: var(--text-muted); }
.group-tile .lead .lucide { width: var(--tile-ic); height: var(--tile-ic); }
.group-tile.selected .lead, .group-tile.holding .lead { color: var(--accent); }
.group-tile .lead.working, .group-tile .lead.reply { color: var(--agent); }
.group-tile .lead.approval, .group-tile .lead.blocked { color: var(--warn); }
.group-tile .lead.failed { color: var(--danger); }

/* One rhythm down the whole column. This was 14px, which is a paragraph
   break — right between two paragraphs, wrong between two rows of the same
   list, and worst of all when both topics are folded and the gap is the only
   thing between two headers. */
.group + .group { margin-top: 5px; }

/* Same shape as a row, one step up in weight: it is selected the same way,
   and the rows beneath it are what it holds. The *same height* as one, too —
   padding rather than a height let it drift two pixels off the rows below it,
   and a list whose headers and rows keep different rhythms reads as loose
   however tight either one is. */
.group-head {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  height: var(--row-h);
  padding: 0 11px;
  margin-bottom: 1px;
  border-radius: var(--radius-sm);
  text-align: left;
  transition: background var(--dur-1) var(--ease-soft);
}
.group-head:hover, .group-head.menued { background: var(--hover); }
/* Standing on the topic, and standing on a branch folded inside it, are the
   same sentence from this list's point of view: your place is on this row.
   Which of the two it is, is what the scope line at the top of the panel says
   — `TOPIC x` or `REPOSITORY y` — and it does not need saying twice. */
.group-head.selected,
.group-head.holding { background: var(--selected); }

/* The lid. Wider than the glyph so it is hittable, and it turns rather than
   swapping icon: the same mark pointing somewhere else reads as one control
   in two states, where two marks read as two controls. */
.twist {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-left: -3px;
  border-radius: 4px;
  color: var(--text-dim);
}
.twist:hover { color: var(--text); background: var(--line-soft); }
.twist .lucide { transition: transform var(--dur-1) var(--ease-soft); }
.twist .turned { transform: rotate(90deg); }

/* The name is still the place to stand: selecting the topic aims the agent at
   it, and that must not become a second click away because folding arrived. */
.pick {
  flex: 1;
  min-width: 0;
  /* A flex box, so the title inside it is a block that can be cut short —
     an inline span ignores the ellipsis and runs under the counters. */
  display: flex;
  overflow: hidden;
  text-align: left;
}
.pick:disabled { cursor: default; }

/* Folded, with the selection inside. One dot, in the accent: it is the same
   statement the row's own bar makes, made in the only space left. */
.group-head.selected .gi,
.group-head.holding .gi { color: var(--accent); }
.gi { color: var(--text-dim); }
.title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-md);
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text);
}
/* Dim and unfilled, like the thing it marks. It sits after the name rather
   than among the counters on the right: those say what the work is doing, and
   this says what the row *is*. */
.summary .inferred {
  flex: none;
  padding: 1px 5px;
  /* The pill keeps its breathing room; the negative margin puts the *letters*
     where a counter's digits would be, so the column's right edge is one line
     rather than two. */
  margin-right: -5px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.summary .inferred:hover { color: var(--text); background: var(--line-soft); }

.summary { flex: none; display: flex; align-items: center; gap: 9px; font-size: var(--fs-xs); }
.summary .up { color: var(--ok); display: inline-flex; align-items: center; gap: 2px; }
.summary .up .lucide { width: 11px; height: 11px; stroke-width: 2.4; }
.summary .dim { color: var(--text-dim); }
.summary .agent { color: var(--agent); display: inline-flex; align-items: center; gap: 2px; }
.summary .agent .lucide { width: 11px; height: 11px; stroke-width: 2.4; }
.summary .agent .agent-star { width: 14px; height: 14px; }
/* Only ever on the thing that is actually running — the header inherits it
   from its rows, and two pulses side by side would say nothing extra. */
.summary .live { animation: pulse 1.6s var(--ease-soft) infinite; }
.summary .needs { display: inline-flex; align-items: center; }
.summary .needs .lucide { width: 12px; height: 12px; stroke-width: 2.4; }
.summary .needs.reply { color: var(--agent); }
.summary .needs.blocked { color: var(--warn); }
.summary .needs.approval { color: var(--warn); }
.summary .needs.failed { color: var(--danger); }

/* Live reads as a state of the header, not as a badge to hunt for. */
.group-head.running .gi { color: var(--ok); }

/* A label, not a section break: it names what follows and gets the air of one
   row, not of a chapter. */
.divider { padding: 9px 11px 3px; }

/* The path the foot used to print now lives in this header's tooltip. A
   monospace line of it across the bottom of the column was a caption the eye
   learned to skip in a week: nothing in the window is addressed by it, it was
   the dimmest text on screen, and it cost a 38px strip and a border to say
   where you already knew you were standing. */
.empty code { font-size: var(--fs-xs); color: var(--text-muted); }
.empty .kbd { height: 18px; min-width: 18px; }
</style>
