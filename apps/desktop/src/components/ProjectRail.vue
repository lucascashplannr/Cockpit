<script setup lang="ts">
import { computed, ref } from 'vue'
import { Activity, Plus, RefreshCw, Search, SlidersHorizontal } from '@lucide/vue'
import {
  activityFor, client, guard, newProject, selectProject, serviceStale, state,
} from '../core/store.js'

/**
 * The far-left rail: one square per project, then add.
 * Deliberately iconless for the projects themselves — a two-letter monogram
 * reads faster than a generic folder glyph and never needs an icon set.
 */

const projects = computed(() => state.projects)

function monogram(name: string): string {
  const parts = name.split(/[\s\-_.]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

/**
 * The tile is the whole of what this column can say about a project, so the
 * three things worth interrupting for are the three it says: servers up, an
 * agent at work, uncommitted changes — plus the one that is a request rather
 * than a state, which gets its own mark rather than a fourth dot.
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
  return { dirty, running, agents: agent.running, attention: agent.attention, waiting: agent.waiting }
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
    await guard(() => client.call('core.reconcile', {}), 'refreshed')
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
  lines.push('Right-click for settings')
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
        :class="{ active: p.id === state.activeProjectId }"
        :title="tileTitle(p.name, p.root, p.id)"
        @click="selectProject(p.id)"
        @contextmenu.prevent="state.editingProjectId = p.id"
      >
        <span class="gram">{{ monogram(p.name) }}</span>
        <!-- A request, not a state: a count on the corner, in the one colour
             nothing else in the rail uses, because it is the only thing here
             addressed to you — whatever the agent wants (a reply read, a tool
             allowed), the answer is the same: go there. -->
        <span v-if="counts(p.id).waiting" class="count num">{{ counts(p.id).waiting }}</span>
        <!-- Three slots that never move: servers left, agent middle, changes
             right. Centred dots slid around with whatever else was lit, so a
             lone dot's place said nothing and only its hue was left to read.
             An empty slot stays drawn as a faint grey dot, so the three places
             are always there to read a lit one against. -->
        <span class="slots">
          <i class="b run" :class="{ on: counts(p.id).running }" />
          <i class="b agent live" :class="{ on: counts(p.id).agents }" />
          <i class="b dirty" :class="{ on: counts(p.id).dirty }" />
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

      <button class="icon-btn" title="Settings — theme, dev folder, editor" @click="state.settingsOpen = true">
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
  font-size: var(--fs-sm);
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
.tile:hover { background: var(--panel-raised); border-color: var(--line-strong); color: var(--text); }
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

/* Inside the tile, not hanging off it: on a card the dots have a ground
   already, the card's. Three fixed places, so a dot is read by where it sits
   before its hue is needed — left servers, middle agent, right changes.
   The monogram and the row are one block, centred in the tile as a whole, so
   the space above the letters and below the dots is the same. Pinned to the
   bottom edge instead, the dots sat on the border and pushed the letters up,
   and the tile read as lopsided. */
.tile {
  --dot: 6px;
  --stack: 6px;
  --ghost: 0.22;
  flex-direction: column;
  gap: var(--stack);
}
.tile .gram { line-height: 1; }
.slots {
  display: flex;
  gap: 4px;
}
.b {
  width: var(--dot);
  height: var(--dot);
  border-radius: 50%;
  display: block;
  /* Off: one grey for all three, so an empty slot never reads as a state —
     faint enough that three of them read as a place, not as three things. */
  background: var(--text-dim);
  opacity: var(--ghost);
}
.b.on { opacity: 1; }
.b.run.on { background: var(--ok); }
.b.agent.on { background: var(--agent); }
.b.dirty.on { background: var(--warn); }
/* The rail's only motion. It means one thing and it is the thing worth
   catching out of the corner of the eye: an agent is working in there. */
.b.live.on { animation: pulse 1.6s var(--ease-soft) infinite; }

/* Cockpit's own colour, the one thing in the rail that is addressed to you.
   Not amber or violet — those are dots here, and a corner in either read as
   one more of them. */
.count {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  box-sizing: border-box;
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
