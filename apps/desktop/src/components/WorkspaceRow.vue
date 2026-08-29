<script setup lang="ts">
import { computed } from 'vue'
import { ArrowDown, ArrowUp, GitBranch, Lock, Sparkles, SquareDot, TriangleAlert } from '@lucide/vue'
import type { Workspace } from '@cockpit/shared'
import { openAgentOn, selectWorkspace, state } from '../core/store.js'

const props = defineProps<{ workspace: Workspace; compact?: boolean }>()

const w = computed(() => props.workspace)
const selected = computed(() => w.value.id === state.activeWorkspaceId)

const dirty = computed(() => {
  const g = w.value.git
  return g ? g.staged + g.unstaged + g.untracked : 0
})

const kindLabel = computed(() =>
  w.value.kind === 'main' ? 'main checkout' : w.value.kind === 'worktree' ? 'worktree' : w.value.kind,
)
</script>

<template>
  <button class="row" :class="{ selected, compact }" @click="selectWorkspace(w.id)">
    <!-- The kind is the one thing an icon says faster than a word. -->
    <span class="kind" :title="kindLabel">
      <component :is="w.kind === 'worktree' ? GitBranch : SquareDot" class="sm" />
    </span>

    <!-- §12 — the branch is the identity; the repo name is context. -->
    <span class="name">{{ w.name }}</span>

    <span class="meta num">
      <!-- Absent capability, absent indicator (§3.9): no git means no counters. -->
      <template v-if="w.git">
        <span v-if="w.git.ahead" class="c ahead" :title="w.git.ahead + ' commit(s) ahead'">
          <ArrowUp class="sm" />{{ w.git.ahead }}
        </span>
        <span v-if="w.git.behind" class="c behind" :title="w.git.behind + ' commit(s) behind'">
          <ArrowDown class="sm" />{{ w.git.behind }}
        </span>
        <span v-if="dirty" class="c dirty" :title="dirty + ' uncommitted change(s)'">
          <i class="pip" />{{ dirty }}
        </span>
        <span v-if="w.git.conflicted" class="c conflict" :title="'conflicted'">
          <TriangleAlert class="sm" />{{ w.git.conflicted }}
        </span>
        <span v-if="w.git.headState !== 'attached'" class="chip danger">{{ w.git.headState }}</span>
      </template>

      <span
        v-if="w.runtime"
        class="dot"
        :class="w.runtime.status"
        :title="'runtime ' + w.runtime.status"
      />
      <span v-if="w.agentSessions.length" class="c agent" title="agent session active">
        <Sparkles class="sm" />{{ w.agentSessions.length }}
      </span>
      <span v-if="w.lease" class="lease" title="path lease held"><Lock class="sm" /></span>

      <!-- §7 — the chat is opened *on* this checkout. The scope is where you
           clicked; there is no second menu asking which workspace you meant. -->
      <span
        class="go"
        role="button"
        :title="'Chat on ' + w.name"
        @click.stop="openAgentOn({ kind: 'workspace', workspaceId: w.id })"
      >
        <Sparkles class="sm" />
      </span>
    </span>
  </button>
</template>

<style scoped>
/* Hidden until the row is under the cursor or selected: every row carries it,
   and twenty of them lit at once would read as decoration. */
.go {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-left: 2px;
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  opacity: 0;
  transition: opacity var(--dur-1) var(--ease-soft), color var(--dur-1) var(--ease-soft);
}
.row:hover .go, .row.selected .go { opacity: 1; }
.go:hover { background: var(--agent-soft); color: var(--agent); }

.row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  height: var(--row-h);
  padding: 0 10px 0 11px;
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--text-muted);
  position: relative;
  transition:
    background var(--dur-1) var(--ease-soft),
    color var(--dur-1) var(--ease-soft);
}
.row:hover { background: var(--hover); }
.row.selected { background: var(--selected); color: var(--text); }
.row.selected::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 2px;
  border-radius: 0 2px 2px 0;
  background: var(--accent);
}

.kind { color: var(--text-dim); display: flex; flex: none; }
.row.selected .kind { color: var(--accent); }

.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-md);
  font-weight: 450;
  letter-spacing: -0.005em;
}
.row.selected .name { font-weight: 550; }

.meta {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: var(--fs-xs);
  flex: none;
}
.c {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.c .lucide { width: 11px; height: 11px; stroke-width: 2.4; }
.ahead { color: var(--ok); }
.behind { color: var(--warn); }
.dirty { color: var(--warn); }
.conflict { color: var(--danger); font-weight: 600; }
.agent { color: var(--agent); }
.pip {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  margin-right: 2px;
}
.lease { color: var(--warn); display: flex; }
.lease .lucide { width: 12px; height: 12px; }
</style>
