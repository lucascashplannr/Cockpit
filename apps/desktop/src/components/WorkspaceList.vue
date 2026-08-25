<script setup lang="ts">
import { computed } from 'vue'
import WorkspaceRow from './WorkspaceRow.vue'
import { activeProject, client, guard, state, workspaceGroups } from '../core/store.js'

/**
 * §12 — "La liste centrale liste des workspaces, groupés par feature quand une
 * feature existe. Un workspace nu et un groupe de trois cohabitent
 * naturellement." The feature header only appears when there is a feature.
 */

const groups = computed(() => workspaceGroups.value)

const hasProjects = computed(() => state.projects.length > 0)

function featureSummary(ws: { git: { ahead: number } | null; runtime: { status: string } | null }[]) {
  const ahead = ws.reduce((n, w) => n + (w.git?.ahead ?? 0), 0)
  const up = ws.filter((w) => w.runtime?.status === 'up').length
  return { ahead, up, total: ws.length }
}

async function rescan() {
  await guard(() => client.call('core.reconcile', {}), 'rescanned')
}
</script>

<template>
  <section class="list">
    <header class="head">
      <button class="search" @click="state.paletteOpen = true">
        <span class="mag">⌕</span>
        <span class="ph">Search or run a command</span>
        <span class="kbd">⌘K</span>
      </button>
    </header>

    <div class="scroll">
      <div v-if="!hasProjects" class="empty">
        <strong>No project yet</strong>
        <span>Add a folder with ＋ in the rail, or run <code class="mono">cockpit add .</code></span>
      </div>

      <template v-else>
        <div v-for="(g, i) in groups" :key="g.featureId ?? 'loose-' + i" class="group">
          <!-- A feature is a decoration (§4): no feature, no header. -->
          <div v-if="g.title" class="group-head">
            <span class="title">{{ g.title }}</span>
            <span class="summary num">
              <span v-if="featureSummary(g.workspaces).ahead" class="up">
                ↑{{ featureSummary(g.workspaces).ahead }}
              </span>
              <span class="dim">{{ featureSummary(g.workspaces).total }} ws</span>
            </span>
          </div>
          <div v-else-if="groups.length > 1 && i > 0" class="divider">
            <span class="section-label">other workspaces</span>
          </div>

          <WorkspaceRow v-for="w in g.workspaces" :key="w.id" :workspace="w" :compact="!!g.title" />
        </div>
      </template>
    </div>

    <footer v-if="activeProject" class="foot">
      <span class="root" :title="activeProject.root">{{ activeProject.root }}</span>
      <button class="btn ghost tiny" title="Re-probe everything" @click="rescan">⟳</button>
    </footer>
  </section>
</template>

<style scoped>
.list {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--panel);
  border-right: 1px solid var(--line);
}

.head {
  padding: 44px 10px 8px;
  flex: none;
}

/* The palette trigger doubles as the column header — §12 makes it the real
   entry point, so it sits where the eye lands first. */
.search {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 30px;
  padding: 0 8px 0 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--bg-sunken);
  color: var(--text-dim);
  font-size: var(--fs-sm);
  transition: border-color 100ms ease, background 100ms ease;
  -webkit-app-region: no-drag;
}
.search:hover { border-color: var(--line-strong); background: var(--hover); }
.mag { font-size: 13px; }
.ph { flex: 1; text-align: left; }

.scroll {
  flex: 1;
  overflow-y: auto;
  padding: 2px 8px 10px;
}

.group + .group { margin-top: 10px; }

.group-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 12px 4px;
}
.title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text);
}
.summary { display: flex; gap: 7px; font-size: var(--fs-xs); }
.summary .up { color: var(--ok); }
.summary .dim { color: var(--text-dim); }

.divider { padding: 14px 12px 4px; }

.foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 6px 0 12px;
  border-top: 1px solid var(--line);
}
.root {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
  font-size: var(--fs-xs);
  color: var(--text-dim);
  font-family: var(--mono);
}
.btn.tiny { height: 22px; width: 24px; padding: 0; font-size: 12px; }
code { font-size: var(--fs-xs); }
</style>
