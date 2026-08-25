<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Workspace } from '@cockpit/shared'
import { GitBranch, ScrollText, Server, Sparkles } from '@lucide/vue'
import { state } from '../../core/store.js'

/**
 * §6 — the third layer: what happened, written automatically. Reading it is
 * how you rebuild context after three days away (§18, "moins de 60 secondes").
 */

const props = defineProps<{ workspace: Workspace }>()

const scope = ref<'workspace' | 'all'>('workspace')
const kind = ref<'all' | 'git' | 'agent' | 'runtime'>('all')

/** The filter icons are the same ones the rest of the app uses for those
 *  three subjects, so the bar needs no labels beyond its own. */
const KINDS = [
  { id: 'all', label: 'all', icon: ScrollText },
  { id: 'git', label: 'git', icon: GitBranch },
  { id: 'agent', label: 'agent', icon: Sparkles },
  { id: 'runtime', label: 'runtime', icon: Server },
] as const

const rows = computed(() => {
  let list = state.events
  if (scope.value === 'workspace') {
    list = list.filter((e) => e.workspaceId === props.workspace.id || e.workspaceId === null)
  }
  if (kind.value !== 'all') list = list.filter((e) => e.type.startsWith(kind.value))
  return [...list].reverse().slice(0, 400)
})

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function actorLabel(a: { kind: string; engine?: string }): string {
  return a.kind === 'agent' ? (a.engine ?? 'agent') : a.kind
}

function summarize(p: unknown): string {
  if (p === null || p === undefined) return ''
  if (typeof p !== 'object') return String(p)
  const o = p as Record<string, unknown>
  const keys = ['detail', 'text', 'operation', 'path', 'label', 'reason', 'tool', 'impl', 'branch']
  for (const k of keys) if (typeof o[k] === 'string') return o[k] as string
  return Object.entries(o)
    .slice(0, 4)
    .map(([k, v]) => k + '=' + JSON.stringify(v))
    .join(' ')
    .slice(0, 160)
}
</script>

<template>
  <div class="journal">
    <div class="bar">
      <div class="seg">
        <button :class="{ on: scope === 'workspace' }" @click="scope = 'workspace'">this workspace</button>
        <button :class="{ on: scope === 'all' }" @click="scope = 'all'">everything</button>
      </div>
      <div class="seg">
        <button v-for="k in KINDS" :key="k.id" :class="{ on: kind === k.id }" @click="kind = k.id">
          <component :is="k.icon" class="sm" />{{ k.label }}
        </button>
      </div>
      <span class="grow" />
      <span class="count num">{{ rows.length }}</span>
    </div>

    <div class="rows">
      <div v-for="e in rows" :key="e.id" class="r" :class="e.level">
        <span class="t num">{{ time(e.ts) }}</span>
        <span class="a" :class="e.actor.kind">{{ actorLabel(e.actor) }}</span>
        <span class="ty">{{ e.type }}</span>
        <span class="p selectable">{{ summarize(e.payload) }}</span>
      </div>
      <div v-if="!rows.length" class="empty">
        <ScrollText />
        <span>Nothing logged yet.</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.journal { display: flex; flex-direction: column; height: 100%; }

.bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 46px;
  padding: 0 16px;
  border-bottom: 1px solid var(--line);
}
.seg .lucide { width: 12px; height: 12px; }
.grow { flex: 1; }
.count { font-size: var(--fs-xs); color: var(--text-dim); }

.rows { flex: 1; overflow-y: auto; padding: 4px 0 20px; }
.r {
  display: flex;
  gap: 12px;
  padding: 5px 18px;
  font-size: var(--fs-xs);
  line-height: 1.55;
  border-left: 2px solid transparent;
}
.r:hover { background: var(--hover); }
.r.warn { border-left-color: var(--warn); }
.r.error { border-left-color: var(--danger); }

.t { flex: none; width: 72px; color: var(--text-dim); font-family: var(--mono); }
.a { flex: none; width: 58px; font-weight: 600; }
.a.human { color: var(--human); }
.a.agent { color: var(--agent); }
.a.system { color: var(--text-dim); }
.ty { flex: none; width: 178px; color: var(--text); font-family: var(--mono); }
.p {
  flex: 1;
  min-width: 0;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
