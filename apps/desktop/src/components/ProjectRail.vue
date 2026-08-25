<script setup lang="ts">
import { computed } from 'vue'
import { Plus, Sun, Moon, MonitorCog } from '@lucide/vue'
import Mark from './brand/Mark.vue'
import { client, cycleTheme, guard, state } from '../core/store.js'

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

/** Stable hue per project so the rail becomes muscle memory. */
function hue(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360
  return h
}

function counts(projectId: string) {
  const ws = state.workspaces.filter((w) => w.projectId === projectId && w.kind !== 'group')
  const dirty = ws.filter((w) => w.git && w.git.staged + w.git.unstaged + w.git.untracked > 0).length
  const running = ws.filter((w) => w.runtime?.status === 'up').length
  const agents = ws.filter((w) => w.agentSessions.length > 0).length
  return { dirty, running, agents }
}

const themeLabel = computed(() =>
  state.theme === 'dark' ? 'Dark' : state.theme === 'light' ? 'Light' : 'System',
)

async function addProject() {
  // §13 rule 1 — the renderer cannot open a file dialog onto the filesystem
  // itself; it asks for a path and the core resolves it.
  const root = window.prompt('Path of the project folder to add')
  if (!root) return
  await guard(() => client.call('project.add', { root }), 'project added')
}
</script>

<template>
  <nav class="rail">
    <div class="spacer" />

    <div class="brand" title="Cockpit">
      <Mark :height="16" />
    </div>

    <div class="rule" />

    <div class="tiles">
      <button
        v-for="p in projects"
        :key="p.id"
        class="tile"
        :class="{ active: p.id === state.activeProjectId }"
        :style="{ '--h': hue(p.id) }"
        :title="p.name + ' — ' + p.root"
        @click="state.activeProjectId = p.id"
      >
        <span class="gram">{{ monogram(p.name) }}</span>
        <span class="badges">
          <i v-if="counts(p.id).running" class="b run" />
          <i v-if="counts(p.id).agents" class="b agent" />
          <i v-if="counts(p.id).dirty" class="b dirty" />
        </span>
      </button>

      <button class="tile add" title="Add a project" @click="addProject">
        <Plus />
      </button>
    </div>

    <div class="grow" />

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
  padding-bottom: 12px;
  background: var(--bg-sunken);
  border-right: 1px solid var(--line);
  overflow: hidden;
}
.spacer { height: var(--titlebar-h); flex: none; }
.grow { flex: 1; }

.brand {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 30px;
  color: var(--text-muted);
  opacity: 0.9;
}

.rule {
  flex: none;
  width: 22px;
  height: 1px;
  margin: 10px 0 12px;
  background: var(--line);
}

.tiles {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding-bottom: 4px;
  /* The rail never shows a scrollbar; it is 40px wide. */
  scrollbar-width: none;
}
.tiles::-webkit-scrollbar { display: none; }

.tile {
  position: relative;
  width: 38px;
  height: 38px;
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

.tile.active {
  background: hsl(var(--h) 70% 55% / 0.16);
  border-color: hsl(var(--h) 70% 55% / 0.4);
  /* One lightness that stays legible on both the light and the dark ground. */
  color: hsl(var(--h) 62% 58%);
}
/* The selected project also gets the rail's only vertical marker, so the
   answer to "where am I" survives a colour-blind eye. */
.tile.active::before {
  content: '';
  position: absolute;
  left: -11px;
  top: 9px;
  bottom: 9px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: hsl(var(--h) 62% 58%);
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

.theme { width: 34px; height: 34px; }
</style>
