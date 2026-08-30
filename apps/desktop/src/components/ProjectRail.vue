<script setup lang="ts">
import { computed } from 'vue'
import { Plus, SlidersHorizontal, Sun, Moon, MonitorCog } from '@lucide/vue'
import Mark from './brand/Mark.vue'
import { activityFor, cycleTheme, newProject, openHome, selectProject, state } from '../core/store.js'

/**
 * The far-left rail: the mark, then one square per project, then add.
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
    <!-- The mark reads as the zeroth project: same tile, same vertical axis,
         and it selects the start page the way the others select a project.
         Not `.brand` — that is Mark's own root class, and this component's
         scope id lands on it too. -->
    <button class="tile mark" title="Start page" @click="openHome">
      <Mark :height="27" crisp />
    </button>

    <div class="rule" />

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
  padding: var(--col-top) 0 12px;
  background: var(--bg-sunken);
  border-right: 1px solid var(--line);
  overflow: hidden;
}
.grow { flex: 1; }

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
  background: var(--hover);
  border: 1px solid transparent;
  transition:
    background var(--dur-2) var(--ease),
    color var(--dur-2) var(--ease),
    border-color var(--dur-2) var(--ease),
    transform var(--dur-1) var(--ease);
}
.tile:hover { background: var(--active); color: var(--text); }
.tile:active { transform: scale(0.94); }

/* Same tile as a project, one step quieter in ink: it belongs to the column
   but it is the way out, not one of the things in it. */
.tile.mark { color: var(--text-dim); }
.tile.mark:hover { color: var(--text); }

.tiles {
  display: flex;
  flex-direction: column;
  align-items: center;
  /* 12px, not 8: the status badges hang 2px below each tile, and a tighter
     column makes them read as belonging to the tile underneath. */
  gap: 12px;
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

.rule {
  flex: none;
  width: 28px;
  height: 1px;
  margin: 10px 0 12px;
  background: var(--line);
}

/* tokens.css: "one restrained accent, and colour reserved for meaning rather
   than decoration". A hue per project was decoration — the monogram already
   tells them apart, and the rail's only coloured thing should be the answer to
   "where am I". */
.tile.active {
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
  border: 1px dashed var(--line-strong);
  color: var(--text-dim);
}
.tile.add:hover { background: var(--hover); color: var(--text-muted); border-style: solid; }

.badges {
  position: absolute;
  bottom: -2px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 3px;
  padding: 2px;
  border-radius: 999px;
  background: var(--bg-sunken);
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
