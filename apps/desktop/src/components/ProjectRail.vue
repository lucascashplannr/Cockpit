<script setup lang="ts">
import { computed, ref } from 'vue'
import { Activity, Asterisk, Hand, Hourglass, Plus, RefreshCw, Search, SlidersHorizontal } from '@lucide/vue'
import {
  activityFor, client, guard, layout, newProject, openContextMenu, refreshEverything, onProject, pressProject, projectMark, serviceStale, state,
} from '../core/store.js'

/**
 * The far-left rail: one square per project, then add.
 * Deliberately iconless for the projects themselves — a two-letter monogram
 * reads faster than a generic folder glyph and never needs an icon set.
 */

const projects = computed(() => state.projects)

/**
 * A tile takes you to its project, where you last stood in it; the tile of the
 * project you are already in takes you up to the project itself (pressProject).
 */
function pick(projectId: string): void {
  pressProject(projectId)
}

/**
 * The tile is the whole of what this column can say about a project, and it
 * says two things: an agent at work there, and an agent waiting on you. Servers
 * up and uncommitted changes were dots here too, and they were nearly always
 * lit — every project has something uncommitted — so they said nothing about
 * where to go next. They live on the list's strip, one column over, and in the
 * tile's hover.
 *
 * The agent half comes from the conversations, not from `w.agentSessions`:
 * that array holds only what is running, and a project you should go back to
 * because an agent finished there and is waiting is exactly the case this
 * column exists for.
 */
function counts(projectId: string) {
  const ws = state.workspaces.filter((w) => w.projectId === projectId && w.kind !== 'group')
  const dirty = ws.filter((w) => w.git && w.git.staged + w.git.unstaged + w.git.untracked > 0).length
  const running = ws.filter((w) => w.runtime?.status === 'up').length
  const agent = activityFor('project', projectId)
  return { dirty, running, agents: agent.running, attention: agent.attention, asking: agent.asking, background: agent.background, waiting: agent.waiting - agent.asking }
}

/**
 * `core.reconcile` takes no project: it re-reads every repository this machine
 * knows about. It spent a version in the workspace list's header, which said
 * the opposite — a project act, beside the three that really are — and made
 * that header a row of four. It belongs with the acts that are the window's
 * rather than any project's, next to the one that watches the service.
 *
 * A toast a second later is not feedback for a button you just pressed, so the
 * answer comes from the control: the glyph turns while the call is in flight
 * and the button stops taking clicks.
 */
const refreshing = ref(false)

async function refresh(): Promise<void> {
  if (refreshing.value) return
  refreshing.value = true
  const started = Date.now()
  try {
    await refreshEverything()
  } finally {
    // A reconcile that comes back in 40ms would otherwise flick the icon a
    // quarter-turn and stop, which reads as a glitch rather than as a pass.
    const left = 450 - (Date.now() - started)
    if (left > 0) await new Promise((r) => setTimeout(r, left))
    refreshing.value = false
  }
}

const ATTENTION_TEXT: Record<string, string> = {
  approval: 'an agent here is waiting for you to allow a tool call',
  reply: 'an agent answered here — waiting for you',
  blocked: 'an agent stopped here: it was refused a tool it needed',
  failed: 'an agent failed here',
}

/** What the tile's tooltip adds to the name: why it is marked at all. */
function tileTitle(name: string, root: string, projectId: string): string {
  const c = counts(projectId)
  const lines = [name + ' — ' + root]
  if (c.running) lines.push('● ' + c.running + ' server(s) up')
  if (c.agents) lines.push('● ' + c.agents + ' agent conversation(s) running')
  if (c.dirty) lines.push('● ' + c.dirty + ' checkout(s) with uncommitted changes')
  if (c.attention !== 'none') lines.push(ATTENTION_TEXT[c.attention] ?? '')
  if (projectId === state.activeProjectId) {
    if (!onProject.value) lines.push('Click to stand on the whole project')
  }
  lines.push('Right-click for more')
  return lines.filter(Boolean).join('\n')
}
</script>

<template>
  <nav class="rail">
    <div class="tiles">
      <button
        v-for="p in projects"
        :key="p.id"
        class="tile"
        :class="{ active: p.id === state.activeProjectId, menued: state.contextMenu?.target.kind === 'project' && state.contextMenu.target.id === p.id }"
        :title="tileTitle(p.name, p.root, p.id)"
        @click="pick(p.id)"
        @contextmenu.prevent="openContextMenu($event, { kind: 'project', id: p.id })"
      >
        <!-- Its logo or its initials, as set in its settings; two letters of its name otherwise. -->
        <img v-if="p.settings.logo" class="logo" :src="p.settings.logo" alt="" />
        <span v-else class="gram">{{ projectMark(p) }}</span>
        <!-- The corner says what the agents there are doing, in the one colour
             nothing else in the rail uses: the star turning while one works
             (the list rows' own mark), and how many wait on you — a reply to
             read, a tool to allow. Both at once sit side by side in one pill.
             A border said "working" too, and nobody saw it, least of all on
             the selected tile. -->
        <span
          v-if="counts(p.id).agents || counts(p.id).asking || counts(p.id).background || counts(p.id).waiting"
          class="count num"
          :class="{ solo: !counts(p.id).waiting }"
        >
          <!-- An agent stopped on a question or a tool to allow is not
               working: the hand takes the star's place, and the number counts
               only what else waits (an answer to read elsewhere). -->
          <Hand v-if="counts(p.id).asking" class="agent-hand" />
          <Asterisk v-else-if="counts(p.id).agents" class="agent-star" />
          <!-- Between turns with something left running: it will pick up on its own. -->
          <Hourglass v-else-if="counts(p.id).background" class="agent-wait" />
          <template v-if="counts(p.id).waiting">{{ counts(p.id).waiting }}</template>
        </span>
      </button>

      <button class="tile add" title="New project" @click="newProject('scratch')">
        <Plus />
      </button>
    </div>

    <div class="grow" />

    <!-- The acts of the whole window, as one group on one rhythm. They were
         four before, each its own child of the rail with no gap between them
         and the theme button a size larger than the rest — which left three
         different distances down a column of identical-looking glyphs. The
         theme is now in Settings, where a thing you choose once belongs. -->
    <div class="acts">
      <!-- ⇧⇧ reaches every project, so it belongs to the one column that does
           too. It spent a moment at the head of the workspace list, which was
           wrong for the same reason the title band was wrong for the
           workspace's name: that column is one project's, and this search is
           not. It spent another at the head of *this* column, alone above the
           projects, where it read as a group of one. It is an act and not a
           destination, and every other act in this rail is down here. -->
      <button class="icon-btn find" title="Search or run a command  ⇧⇧" @click="state.paletteOpen = true">
        <Search />
      </button>

      <!-- A pair: what this window knows about the disk, and what it knows
           about the service behind it. -->
      <button
        class="icon-btn"
        :class="{ spinning: refreshing }"
        :disabled="refreshing"
        :title="refreshing ? 'Re-reading…' : 'Re-read every repository from disk'"
        @click="refresh"
      >
        <RefreshCw />
      </button>

      <!-- The only mark here that is not an act: a dot when the service is out
           of step with this window, since the fix is on the other side of it. -->
      <button
        class="icon-btn service"
        :title="serviceStale ? 'Service — running an older version' : 'Service'"
        @click="state.serviceOpen = true"
      >
        <Activity />
        <i v-if="serviceStale || (state.booted && state.connection === 'disconnected')" class="flag" />
      </button>

      <button class="icon-btn" title="Settings" @click="state.settingsSection = 'general'; state.settingsOpen = true">
        <SlidersHorizontal />
      </button>
    </div>
  </nav>
</template>

<style scoped>
.rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  /* The window's three buttons are drawn at (10, 19) and float over whatever
     is under them (TrafficLights). Nothing else in this column may start above
     them, so the rail begins where they end rather than at --col-top, and
     then a gap again so the first tile is not flush against them. */
  padding: calc(var(--lights-h) + 6px) 0 12px;
  /* The strip the lights sit in is the window's own, so dragging it moves the
     window; every tile below opts back out. */
  -webkit-app-region: drag;
  background: var(--surface-rail);
  border-right: 1px solid var(--line);
  overflow: hidden;
}
.grow { flex: 1; }

.rail > *, .acts > *, .tile { -webkit-app-region: no-drag; }

/* One group, one rhythm — and the rhythm is the button itself: 28px squares
   touching, so nothing sits between two glyphs but their own padding. The
   6px gap on top of 32px squares put 22px between glyphs, which is more air
   than the workspace header gives its three acts and made four controls that
   act as one group read as four separate ones. */
.acts {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.acts .icon-btn { width: 28px; height: 28px; }
/* Turning is the feedback; dimming on top of it would read as unavailable. */
.acts .icon-btn:disabled { opacity: 1; color: var(--text-muted); }
.acts .spinning :deep(svg) { animation: spin 0.9s linear infinite; }
@media (prefers-reduced-motion: reduce) {
  .acts .spinning :deep(svg) { animation-duration: 2.6s; }
}

/* An icon, not a field: the rail is 72px wide, and what this opens is the
   palette — the field it used to be was an affordance for a keystroke, never
   the search itself.
   And an `icon-btn` rather than a `tile`, which is the whole of the polish: a
   tile is a *destination* — the projects are places you go, and they are
   filled and 44px square to say so. Search is an act. Given a tile it read as
   one more project. It is the same family as the service and settings buttons,
   unfilled until touched, and it stands with them. */
.find { color: var(--text-dim); }
.find:hover { color: var(--text); background: var(--hover); }

.tile {
  position: relative;
  width: 44px;
  height: 44px;
  flex: none;
  border-radius: var(--radius);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  font-weight: 650;
  letter-spacing: 0.02em;
  color: var(--text-muted);
  background: var(--panel);
  border: 1px solid var(--line);
  transition:
    background var(--dur-2) var(--ease),
    color var(--dur-2) var(--ease),
    border-color var(--dur-2) var(--ease),
    transform var(--dur-1) var(--ease);
}
.tile:hover,
.tile.menued { background: var(--panel-raised); border-color: var(--line-strong); color: var(--text); }
.tile:active { transform: scale(0.94); }

.tiles {
  display: flex;
  flex-direction: column;
  align-items: center;
  /* The badges live inside the tiles now, so this no longer has to buy room
     for them below each one — but 10px still beats 8: the tiles are filled
     surfaces against a sunken rail, and packed tighter they start to read as
     one segmented strip rather than a stack of separate cards. */
  gap: 10px;
  /* The rail's full width, not the tiles': centred in the rail, this column
     shrank to 44px, and its overflow clip then cut whatever a tile wears
     outside its own box — the corner count and the selected tile's bar. */
  align-self: stretch;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  /* The first tile's corner count stands 5px above it, inside this scroll
     box's clip — so the box starts that much higher and the rail's own top
     padding gives the difference back. */
  padding-top: 6px;
  padding-bottom: 4px;
  /* The rail never shows a scrollbar; it is too narrow to spare the width. */
  scrollbar-width: none;
}
.tiles::-webkit-scrollbar { display: none; }

/* Adding a project is a different kind of act from switching to one. */
.tile.add { margin-top: 4px; }


/* tokens.css: "one restrained accent, and colour reserved for meaning rather
   than decoration". A hue per project was decoration — the monogram already
   tells them apart, and the rail's only coloured thing should be the answer to
   "where am I". */
.tile.active,
.tile.active:hover {
  background: var(--accent-soft);
  border-color: transparent;
  color: var(--accent);
}
/* The selected project also gets the rail's only vertical marker, so the
   answer to "where am I" survives a colour-blind eye. */
.tile.active::before {
  content: '';
  position: absolute;
  left: -14px;
  top: 11px;
  bottom: 11px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--accent);
}

.tile.add {
  background: transparent;
  /* Dashed on `--line-strong` all but vanished against the rail. It should
     stay quieter than a project — empty rather than filled — but a control
     you cannot see is not restraint. */
  border: 1px dashed var(--text-dim);
  color: var(--text-muted);
}
.tile.add:hover {
  background: var(--panel);
  border-color: var(--text-muted);
  border-style: solid;
  color: var(--text);
}

/* The middle of the tile is the project: its logo, or its letters. */
.tile .gram { line-height: 1; }
.tile .logo { width: 24px; height: 24px; border-radius: 6px; object-fit: cover; display: block; }

/* Cockpit's own colour, the one thing in the rail that is addressed to you.
   One badge for every agent state, so one colour. */
.count {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border-radius: 8px;
  background: var(--accent);
  color: var(--accent-text);
  font-size: 9.5px;
  font-weight: 700;
  line-height: 15px;
  text-align: center;
  letter-spacing: 0;
  /* Ringed in the rail's own ground so it sits on the tile's corner rather
     than inside the monogram. */
  box-shadow: 0 0 0 2px var(--surface-rail);
}
.count .agent-star { width: 10px; height: 10px; flex: none; stroke-width: 3; }
.count .agent-hand, .count .agent-wait { width: 10px; height: 10px; flex: none; stroke-width: 2.5; }
/* The star alone: a round badge, not a pill with nothing after the star. */
.count.solo { padding: 0; }

.icon-btn.service { position: relative; }
.icon-btn.service .flag {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warn);
  box-shadow: 0 0 0 2px var(--surface-rail);
}
</style>
