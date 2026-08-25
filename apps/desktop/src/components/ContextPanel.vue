<script setup lang="ts">
import { computed } from 'vue'
import CodeTab from './tabs/CodeTab.vue'
import DiffTab from './tabs/DiffTab.vue'
import AgentTab from './tabs/AgentTab.vue'
import MemoryTab from './tabs/MemoryTab.vue'
import JournalTab from './tabs/JournalTab.vue'
import TerminalTab from './tabs/TerminalTab.vue'
import { activeWorkspace, client, guard, has, requestPlan, state } from '../core/store.js'
import type { TabId } from '../core/store.js'

const w = computed(() => activeWorkspace.value)

/** §3.9 / §5 — a tab whose capability is absent is not rendered at all. */
const tabs = computed<{ id: TabId; label: string; badge?: number | string }[]>(() => {
  const ws = w.value
  if (!ws) return []
  const list: { id: TabId; label: string; badge?: number | string }[] = [{ id: 'code', label: 'Code' }]

  if (ws.git) {
    const changed = ws.git.staged + ws.git.unstaged + ws.git.untracked
    list.push({ id: 'diff', label: 'Diff', badge: changed || undefined })
  }
  if (has(ws, 'agents') || state.agents.length || true) {
    // Agents are available wherever a path is, including a repo-less folder (§7).
    list.push({ id: 'agent', label: 'Agent', badge: ws.agentSessions.length || undefined })
  }
  list.push({ id: 'memory', label: 'Memory', badge: ws.hasMemory ? '·' : undefined })
  list.push({ id: 'journal', label: 'Journal' })
  list.push({ id: 'terminal', label: 'Terminal' })
  return list
})

const preview = computed(() => w.value?.runtime?.preview ?? null)

async function toggleRuntime() {
  const ws = w.value
  if (!ws?.runtime) return
  const method = ws.runtime.status === 'up' ? 'runtime.down' : 'runtime.up'
  await guard(() => client.call(method, { workspaceId: ws.id }))
}

async function openIde() {
  const ws = w.value
  if (!ws) return
  await guard(() => client.call('workspace.openIn', { workspaceId: ws.id, target: 'ide' }))
}

async function openPreview() {
  const ws = w.value
  if (!ws) return
  await guard(() => client.call('workspace.openIn', { workspaceId: ws.id, target: 'browser' }))
}

async function undo() {
  const ws = w.value
  if (!ws) return
  await guard(() => client.call('git.undo', { workspaceId: ws.id }))
}
</script>

<template>
  <section class="panel">
    <div v-if="!w" class="empty">
      <strong>Nothing selected</strong>
      <span>Pick a workspace, or press <span class="kbd">⌘K</span></span>
    </div>

    <template v-else>
      <header class="head">
        <div class="idline">
          <h1 class="wname">{{ w.name }}</h1>
          <span class="chip" v-if="w.kind !== 'main'">{{ w.kind }}</span>
          <span v-if="w.git?.headState !== 'attached' && w.git" class="chip danger">
            {{ w.git.headState }}
          </span>
          <span class="grow" />
          <span class="path mono" :title="w.path">{{ w.path }}</span>
        </div>

        <!-- One status strip: git, runtime, agent, cost. §12's summary row. -->
        <div class="status">
          <template v-if="w.git">
            <span class="stat">
              <span class="k">branch</span>
              <span class="v">{{ w.git.branch ?? 'detached' }}</span>
            </span>
            <span class="stat num">
              <span class="k">sync</span>
              <span class="v">
                <span :class="{ on: w.git.ahead }">↑{{ w.git.ahead }}</span>
                <span :class="{ warn: w.git.behind }">↓{{ w.git.behind }}</span>
              </span>
            </span>
            <span class="stat num">
              <span class="k">changed</span>
              <span class="v">{{ w.git.staged + w.git.unstaged + w.git.untracked }}</span>
            </span>
          </template>

          <span v-if="w.runtime" class="stat">
            <span class="k">{{ w.runtime.impl }}</span>
            <span class="v"><i class="dot" :class="w.runtime.status" /> {{ w.runtime.status }}</span>
          </span>

          <!-- §8 — a non-portable runtime says so, rather than failing later. -->
          <span v-if="w.runtime && !w.runtime.portable" class="chip" title="This runtime is machine-local (§8)">
            local only
          </span>

          <span v-for="p in w.runtime?.ports ?? []" :key="p.name" class="stat num">
            <span class="k">{{ p.name }}</span>
            <span class="v">:{{ p.port }}</span>
          </span>

          <span v-if="w.lease" class="chip warn" :title="w.lease.reason">leased</span>
        </div>
      </header>

      <nav class="tabs">
        <button
          v-for="t in tabs"
          :key="t.id"
          class="tab"
          :class="{ on: state.activeTab === t.id }"
          @click="state.activeTab = t.id"
        >
          {{ t.label }}
          <span v-if="t.badge !== undefined" class="tbadge num">{{ t.badge }}</span>
        </button>

        <span class="grow" />

        <div class="actions">
          <button v-if="w.runtime" class="btn ghost" @click="toggleRuntime">
            {{ w.runtime.status === 'up' ? 'Stop' : 'Start' }}
          </button>
          <button v-if="preview && preview.kind === 'url'" class="btn ghost" @click="openPreview">
            Preview
          </button>
          <button class="btn ghost" @click="openIde">IDE</button>
          <button v-if="w.git" class="btn ghost" @click="requestPlan(w.id, 'rebase')">Rebase</button>
          <button v-if="w.git" class="btn ghost" @click="requestPlan(w.id, 'push')">Push</button>
          <button v-if="w.git" class="btn ghost" title="Roll back to the last restore point" @click="undo">
            Undo
          </button>
        </div>
      </nav>

      <div class="body">
        <CodeTab v-if="state.activeTab === 'code'" :workspace="w" />
        <DiffTab v-else-if="state.activeTab === 'diff'" :workspace="w" />
        <AgentTab v-else-if="state.activeTab === 'agent'" :workspace="w" />
        <MemoryTab v-else-if="state.activeTab === 'memory'" :workspace="w" />
        <JournalTab v-else-if="state.activeTab === 'journal'" :workspace="w" />
        <TerminalTab v-else-if="state.activeTab === 'terminal'" :workspace="w" />
      </div>
    </template>
  </section>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--bg);
}

.head {
  flex: none;
  padding: 44px 18px 0;
}
.idline {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.wname {
  margin: 0;
  font-size: 17px;
  font-weight: 620;
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.grow { flex: 1; }
.path {
  color: var(--text-dim);
  font-size: var(--fs-xs);
  direction: rtl;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 18px;
  padding: 10px 0 12px;
}
.stat { display: inline-flex; align-items: baseline; gap: 6px; font-size: var(--fs-sm); }
.stat .k {
  font-size: 10px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.stat .v { color: var(--text); display: inline-flex; align-items: center; gap: 5px; }
.stat .v .on { color: var(--ok); }
.stat .v .warn { color: var(--warn); }
.stat .v span + span { margin-left: 5px; }

.tabs {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 14px;
  border-bottom: 1px solid var(--line);
}
.tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 32px;
  padding: 0 10px;
  font-size: var(--fs-sm);
  font-weight: 500;
  color: var(--text-dim);
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  transition: color 90ms ease;
}
.tab:hover { color: var(--text-muted); }
.tab.on { color: var(--text); }
.tab.on::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: -1px;
  height: 2px;
  border-radius: 1px 1px 0 0;
  background: var(--accent);
}
.tbadge {
  font-size: 10px;
  padding: 0 4px;
  height: 14px;
  min-width: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  background: var(--hover);
  color: var(--text-muted);
}

.actions { display: flex; gap: 2px; padding-bottom: 4px; }
.actions .btn { height: 24px; padding: 0 8px; font-size: var(--fs-xs); }

.body { flex: 1; min-height: 0; overflow: hidden; }
</style>
