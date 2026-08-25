<script setup lang="ts">
import { computed } from 'vue'
import type { Workspace } from '@cockpit/shared'
import { state } from '../core/store.js'

const props = defineProps<{ workspace: Workspace; compact?: boolean }>()

const w = computed(() => props.workspace)
const selected = computed(() => w.value.id === state.activeWorkspaceId)

const dirty = computed(() => {
  const g = w.value.git
  return g ? g.staged + g.unstaged + g.untracked : 0
})

const kindLabel = computed(() =>
  w.value.kind === 'main' ? 'main' : w.value.kind === 'worktree' ? 'tree' : w.value.kind,
)
</script>

<template>
  <button class="row" :class="{ selected, compact }" @click="state.activeWorkspaceId = w.id">
    <!-- §12 — the branch is the identity; the repo name is context. -->
    <span class="name">{{ w.name }}</span>

    <span class="meta num">
      <!-- Absent capability, absent indicator (§3.9): no git means no counters. -->
      <template v-if="w.git">
        <span v-if="w.git.ahead" class="ahead">↑{{ w.git.ahead }}</span>
        <span v-if="w.git.behind" class="behind">↓{{ w.git.behind }}</span>
        <span v-if="dirty" class="dirty">●{{ dirty }}</span>
        <span v-if="w.git.conflicted" class="conflict">!{{ w.git.conflicted }}</span>
        <span v-if="w.git.headState !== 'attached'" class="chip danger">{{ w.git.headState }}</span>
      </template>

      <span v-if="w.runtime" class="dot" :class="w.runtime.status" :title="'runtime ' + w.runtime.status" />
      <span v-if="w.agentSessions.length" class="chip agent" title="agent session active">
        {{ w.agentSessions.length }}◆
      </span>
      <span v-if="w.lease" class="lease" title="path lease held">⦿</span>
    </span>

    <span class="kind">{{ kindLabel }}</span>
  </button>
</template>

<style scoped>
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: var(--row-h);
  padding: 0 10px 0 12px;
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--text-muted);
  position: relative;
  transition: background 80ms ease;
}
.row:hover { background: var(--hover); }
.row.selected { background: var(--selected); color: var(--text); }
.row.selected::before {
  content: '';
  position: absolute;
  left: 3px;
  top: 7px;
  bottom: 7px;
  width: 2px;
  border-radius: 1px;
  background: var(--accent);
}

.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-md);
  font-weight: 450;
}
.row.selected .name { font-weight: 550; }

.meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-xs);
  flex: none;
}
.ahead { color: var(--ok); }
.behind { color: var(--warn); }
.dirty { color: var(--warn); }
.conflict { color: var(--danger); font-weight: 600; }
.lease { color: var(--warn); font-size: 9px; }

.kind {
  flex: none;
  width: 30px;
  text-align: right;
  font-size: 10px;
  letter-spacing: 0.03em;
  color: var(--text-dim);
  opacity: 0.75;
}
.compact .kind { display: none; }
</style>
