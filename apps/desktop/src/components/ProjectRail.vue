<script setup lang="ts">
import { computed } from 'vue'
import { client, cycleTheme, guard, state } from '../core/store.js'

/**
 * The far-left rail: one square per project, plus add. Deliberately iconless —
 * a two-letter monogram reads faster than a generic folder glyph and never
 * needs an icon set.
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

    <button
      v-for="p in projects"
      :key="p.id"
      class="tile"
      :class="{ active: p.id === state.activeProjectId }"
      :style="{ '--h': hue(p.id) }"
      :title="p.name + ' — ' + p.root"
      @click="state.activeProjectId = p.id"
    >
      <span class="mono-gram">{{ monogram(p.name) }}</span>
      <span class="badges">
        <i v-if="counts(p.id).running" class="b run" />
        <i v-if="counts(p.id).agents" class="b agent" />
        <i v-if="counts(p.id).dirty" class="b dirty" />
      </span>
    </button>

    <button class="tile add" title="Add a project" @click="addProject">＋</button>

    <div class="grow" />

    <button class="tile ghost" :title="'Theme: ' + state.theme" @click="cycleTheme">
      {{ state.theme === 'dark' ? '◐' : state.theme === 'light' ? '◑' : '◒' }}
    </button>
  </nav>
</template>

<style scoped>
.rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 0 0 10px;
  background: var(--bg-sunken);
  border-right: 1px solid var(--line);
  overflow: hidden;
}
.spacer { height: 38px; flex: none; }
.grow { flex: 1; }

.tile {
  position: relative;
  width: 34px;
  height: 34px;
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
  transition: background 100ms ease, color 100ms ease, border-color 100ms ease;
}
.tile:hover { background: var(--active); color: var(--text); }

.tile.active {
  background: hsl(var(--h) 70% 55% / 0.16);
  border-color: hsl(var(--h) 70% 55% / 0.45);
  /* One lightness that stays legible on both the light and the dark ground. */
  color: hsl(var(--h) 62% 58%);
}

.tile.add { font-size: 15px; font-weight: 400; color: var(--text-dim); }
.tile.ghost { background: transparent; font-size: 14px; }
.tile.ghost:hover { background: var(--hover); }

.badges {
  position: absolute;
  bottom: -3px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 2px;
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
</style>
