<script setup lang="ts">
import { computed } from 'vue'
import type { Component } from 'vue'
import {
  AppWindow, ArrowDown, ArrowUp, ArrowUpFromLine, BookMarked, CirclePlay, CircleStop,
  FileCode, FileDiff, GitBranch, GitCompareArrows, MousePointerClick, Plug, ScrollText,
  Sparkles, SquareTerminal, Undo2,
} from '@lucide/vue'
import CodeTab from './tabs/CodeTab.vue'
import DiffTab from './tabs/DiffTab.vue'
import AgentTab from './tabs/AgentTab.vue'
import MemoryTab from './tabs/MemoryTab.vue'
import JournalTab from './tabs/JournalTab.vue'
import TerminalTab from './tabs/TerminalTab.vue'
import Wordmark from './brand/Wordmark.vue'
import { activeWorkspace, client, guard, has, requestPlan, state } from '../core/store.js'
import type { TabId } from '../core/store.js'

const w = computed(() => activeWorkspace.value)

interface Tab {
  id: TabId
  label: string
  icon: Component
  badge?: number | string
}

/** §3.9 / §5 — a tab whose capability is absent is not rendered at all. */
const tabs = computed<Tab[]>(() => {
  const ws = w.value
  if (!ws) return []
  const list: Tab[] = [{ id: 'code', label: 'Code', icon: FileCode }]

  if (ws.git) {
    const changed = ws.git.staged + ws.git.unstaged + ws.git.untracked
    list.push({ id: 'diff', label: 'Diff', icon: GitCompareArrows, badge: changed || undefined })
  }
  if (has(ws, 'agents') || state.agents.length || true) {
    // Agents are available wherever a path is, including a repo-less folder (§7).
    list.push({
      id: 'agent',
      label: 'Agent',
      icon: Sparkles,
      badge: ws.agentSessions.length || undefined,
    })
  }
  list.push({ id: 'memory', label: 'Memory', icon: BookMarked, badge: ws.hasMemory ? '·' : undefined })
  list.push({ id: 'journal', label: 'Journal', icon: ScrollText })
  list.push({ id: 'terminal', label: 'Terminal', icon: SquareTerminal })
  return list
})

const preview = computed(() => w.value?.runtime?.preview ?? null)

const changed = computed(() => {
  const g = w.value?.git
  return g ? g.staged + g.unstaged + g.untracked : 0
})

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
    <!-- Nothing selected is still a first impression: the app says its name. -->
    <div v-if="!w" class="welcome">
      <Wordmark :height="48" class="wm" />
      <p class="tag">Everything in flight, in one window.</p>
      <div class="hints">
        <span class="hint"><span class="kbd">⌘K</span> jump to a workspace or run anything</span>
        <span class="hint"><MousePointerClick class="sm" /> or pick one on the left</span>
      </div>
    </div>

    <template v-else>
      <header class="head">
        <!-- The title band is the only strip in this column with room to spare:
             the traffic lights stop well to the left of it. Putting the verbs
             there buys the tab row back and lifts everything up a row. -->
        <div class="idline">
          <h1 class="wname">{{ w.name }}</h1>
          <span class="chip" v-if="w.kind !== 'main'">
            <GitBranch />{{ w.kind }}
          </span>
          <span v-if="w.git && w.git.headState !== 'attached'" class="chip danger">
            {{ w.git.headState }}
          </span>
          <span class="grow" />

          <div class="actions">
            <button v-if="w.runtime" class="btn ghost" @click="toggleRuntime">
              <component :is="w.runtime.status === 'up' ? CircleStop : CirclePlay" />
              {{ w.runtime.status === 'up' ? 'Stop' : 'Start' }}
            </button>
            <button v-if="preview && preview.kind === 'url'" class="btn ghost" @click="openPreview">
              <AppWindow />Preview
            </button>
            <button class="btn ghost" @click="openIde"><FileCode />IDE</button>
            <span v-if="w.git" class="vrule" />
            <button v-if="w.git" class="btn ghost" @click="requestPlan(w.id, 'rebase')">
              <GitCompareArrows />Rebase
            </button>
            <button v-if="w.git" class="btn ghost" @click="requestPlan(w.id, 'push')">
              <ArrowUpFromLine />Push
            </button>
            <button
              v-if="w.git"
              class="icon-btn"
              title="Roll back to the last restore point"
              @click="undo"
            >
              <Undo2 class="sm" />
            </button>
          </div>
        </div>

        <!-- One status strip: git, runtime, agent, cost. §12's summary row. -->
        <div class="status">
          <template v-if="w.git">
            <span class="stat">
              <GitBranch class="sm si" />
              <span class="v">{{ w.git.branch ?? 'detached' }}</span>
            </span>
            <span class="stat num">
              <span class="v sync">
                <span :class="{ on: w.git.ahead }"><ArrowUp class="sm" />{{ w.git.ahead }}</span>
                <span :class="{ warn: w.git.behind }"><ArrowDown class="sm" />{{ w.git.behind }}</span>
              </span>
            </span>
            <span class="stat num" :title="changed + ' uncommitted change(s)'">
              <FileDiff class="sm si" />
              <span class="v" :class="{ warn: changed }">{{ changed }}</span>
            </span>
          </template>

          <span v-if="w.runtime" class="stat">
            <i class="dot" :class="w.runtime.status" />
            <span class="v">{{ w.runtime.impl }}</span>
            <span class="k">{{ w.runtime.status }}</span>
          </span>

          <!-- §8 — a non-portable runtime says so, rather than failing later. -->
          <span v-if="w.runtime && !w.runtime.portable" class="chip" title="This runtime is machine-local (§8)">
            local only
          </span>

          <span v-for="p in w.runtime?.ports ?? []" :key="p.name" class="stat num">
            <Plug class="sm si" />
            <span class="k">{{ p.name }}</span>
            <span class="v">:{{ p.port }}</span>
          </span>

          <span v-if="w.lease" class="chip warn" :title="w.lease.reason">leased</span>

          <span class="grow" />
          <span class="path mono" :title="w.path">{{ w.path }}</span>
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
          <component :is="t.icon" class="sm" />
          <span>{{ t.label }}</span>
          <span v-if="t.badge !== undefined" class="tbadge num">{{ t.badge }}</span>
        </button>
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

/* ── welcome ─────────────────────────────────────────────────────────── */
.welcome {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 40px;
}
.wm { color: var(--text); opacity: 0.9; }
.tag {
  margin: -4px 0 0;
  font-size: var(--fs-md);
  color: var(--text-dim);
}
.hints {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}
.hint {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-sm);
  color: var(--text-dim);
}

/* ── header ──────────────────────────────────────────────────────────── */
.head {
  flex: none;
  padding: var(--col-top) 18px 0;
}
.idline {
  display: flex;
  align-items: center;
  gap: 10px;
  /* 34px is the height of the search field in the column to the left, so the
     title and the field share a centre line. */
  min-height: 34px;
  min-width: 0;
}
.wname {
  margin: 0;
  font-size: var(--fs-xl);
  font-weight: 640;
  letter-spacing: -0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.grow { flex: 1; }
.path {
  flex: none;
  margin-left: 4px;
  color: var(--text-dim);
  font-size: var(--fs-xs);
  /* Truncate from the left; `plaintext` keeps the string itself in reading
     order, which bare `rtl` does not — it moves the leading slash to the end. */
  direction: rtl;
  unicode-bidi: plaintext;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status {
  display: flex;
  align-items: center;
  gap: 8px 10px;
  padding: 11px 0 12px;
  min-width: 0;
}
.stat {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 9px;
  border-radius: 999px;
  background: var(--hover);
  font-size: var(--fs-xs);
}
.si { color: var(--text-dim); }
.stat .k { color: var(--text-dim); }
.stat .v { color: var(--text); font-weight: 500; display: inline-flex; align-items: center; gap: 4px; }
.stat .v.warn { color: var(--warn); }
.sync { gap: 9px; }
.sync span { display: inline-flex; align-items: center; gap: 2px; color: var(--text-dim); font-weight: 500; }
.sync .lucide { width: 11px; height: 11px; stroke-width: 2.4; }
.sync span.on { color: var(--ok); }
.sync span.warn { color: var(--warn); }

/* ── tabs ────────────────────────────────────────────────────────────── */
.tabs {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 18px;
  border-bottom: 1px solid var(--line);
}
.tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 38px;
  padding: 0 11px;
  font-size: var(--fs-sm);
  font-weight: 500;
  color: var(--text-dim);
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  transition: color var(--dur-1) var(--ease-soft), background var(--dur-1) var(--ease-soft);
}
.tab:hover { color: var(--text-muted); background: var(--hover); }
.tab.on { color: var(--text); background: transparent; }
.tab.on::after {
  content: '';
  position: absolute;
  left: 9px;
  right: 9px;
  bottom: -1px;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: var(--accent);
}
.tbadge {
  font-size: 11px;
  padding: 0 5px;
  height: 17px;
  min-width: 17px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--hover);
  color: var(--text-muted);
}
.tab.on .tbadge { background: var(--accent-soft); color: var(--accent); }

.actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
}
.actions .btn {
  height: 28px;
  padding: 0 10px;
  font-size: var(--fs-xs);
  border-color: transparent;
}
.actions .btn:hover:not(:disabled) { border-color: var(--line); }
.actions .btn .lucide { width: 13px; height: 13px; }
.actions .icon-btn { width: 28px; height: 28px; }
.vrule {
  width: 1px;
  height: 16px;
  margin: 0 7px;
  background: var(--line);
}

.body { flex: 1; min-height: 0; overflow: hidden; }
</style>
