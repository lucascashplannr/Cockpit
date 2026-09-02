<script setup lang="ts">
import { computed } from 'vue'
import { MonitorCog, Moon, Plus, Search, SlidersHorizontal, Sun } from '@lucide/vue'
import { activityFor, cycleTheme, newProject, selectProject, state } from '../core/store.js'

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

const ATTENTION_TEXT: Record<string, string> = {
  reply: 'an agent answered here — waiting for you',
  blocked: 'an agent stopped here: it was refused a tool it needed',
  failed: 'an agent failed here',
}

/** What the tile's tooltip adds to the name: why it is marked at all. */
function tileTitle(name: string, root: string, projectId: string): string {
  const c = counts(projectId)
  const lines = [name + ' — ' + root]
  if (c.agents) lines.push(c.agents + ' agent conversation(s) running')
  if (c.attention !== 'none') lines.push(ATTENTION_TEXT[c.attention] ?? '')
  lines.push('Right-click for settings')
  return lines.filter(Boolean).join('\n')
}

const themeLabel = computed(() =>
  state.theme === 'dark' ? 'Dark' : state.theme === 'light' ? 'Light' : 'System',
)
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
        <!-- A request, not a state: it sits on the corner rather than in the
             row of dots, because it is the one thing here that is addressed
             to you and the eye has to find it without counting. -->
        <span
          v-if="counts(p.id).attention !== 'none'"
          class="ping"
          :class="counts(p.id).attention"
        />
        <span class="badges">
          <i v-if="counts(p.id).running" class="b run" />
          <i v-if="counts(p.id).agents" class="b agent live" />
          <i v-if="counts(p.id).dirty" class="b dirty" />
        </span>
      </button>

      <button class="tile add" title="New project" @click="newProject('scratch')">
        <Plus />
      </button>
    </div>

    <div class="grow" />

    <!-- ⌘K reaches every project, so it belongs to the one column that does
         too. It spent a moment at the head of the workspace list, which was
         wrong for the same reason the title band was wrong for the workspace's
         name: that column is one project's, and this search is not. It spent
         another at the head of *this* column, alone above the projects, where
         it read as a group of one. It is an act and not a destination, and
         every other act in this rail is down here. -->
    <button class="icon-btn find" title="Search or run a command  ⌘K" @click="state.paletteOpen = true">
      <Search />
    </button>

    <button class="icon-btn" title="Settings" @click="state.settingsOpen = true">
      <SlidersHorizontal />
    </button>

    <button class="icon-btn theme" :title="'Theme: ' + themeLabel" @click="cycleTheme">
      <Moon v-if="state.theme === 'dark'" />
      <Sun v-else-if="state.theme === 'light'" />
      <MonitorCog v-else />
    </button>
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
  padding: calc(var(--lights-h) + 12px) 0 12px;
  /* The strip the lights sit in is the window's own, so dragging it moves the
     window; every tile below opts back out. */
  -webkit-app-region: drag;
  background: var(--bg-sunken);
  border-right: 1px solid var(--line);
  overflow: hidden;
}
.grow { flex: 1; }

.rail > *, .tile { -webkit-app-region: no-drag; }

/* An icon, not a field: the rail is 72px wide, and what this opens is the
   palette — the field it used to be was an affordance for a keystroke, never
   the search itself.
   And an `icon-btn` rather than a `tile`, which is the whole of the polish: a
   tile is a *destination* — the projects are places you go, and they are
   filled and 44px square to say so. Search is an act. Given a tile it read as
   one more project. It is the same family as the settings and theme buttons,
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
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
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

/* Inside the tile, not hanging off it. The pill wore the rail's own ground so
   it could sit across the tile's bottom edge without the dots landing half on
   one surface and half on the other — which worked while the tile was a wash
   of that same ground, and became a notch bitten out of the card the moment
   the tile became a surface of its own. On a card the dots have a ground
   already: the card's. */
.badges {
  position: absolute;
  bottom: 5px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 3px;
}
.b {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  display: block;
}
.b.run { background: var(--ok); }
.b.agent { background: var(--agent); }
.b.dirty { background: var(--warn); }
/* The rail's only motion. It means one thing and it is the thing worth
   catching out of the corner of the eye: an agent is working in there. */
.b.live { animation: pulse 1.6s var(--ease-soft) infinite; }

.ping {
  position: absolute;
  top: -2px;
  right: -2px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  /* Ringed in the rail's own ground so it reads as sitting on the tile rather
     than as part of the monogram. */
  border: 2px solid var(--bg-sunken);
  box-sizing: content-box;
}
.ping.reply { background: var(--agent); }
.ping.blocked { background: var(--warn); }
.ping.failed { background: var(--danger); }

.theme { width: 38px; height: 38px; }

</style>
