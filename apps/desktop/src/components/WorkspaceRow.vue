<script setup lang="ts">
import { computed } from 'vue'
import {
  ArrowDown, ArrowUp, CircleAlert, GitBranch, Hand, Lock, Sparkles, SquareDot, TriangleAlert,
} from '@lucide/vue'
import type { Workspace } from '@cockpit/shared'
import { activityFor, openAgentOn, selectedTopicId, selectWorkspace, state } from '../core/store.js'

const props = defineProps<{ workspace: Workspace; compact?: boolean }>()

const w = computed(() => props.workspace)
// Selecting a topic anchors the panel on one of its rows, so the row id
// alone would light two things at once. The narrower selection wins: while the
// topic is what is selected, none of its rows is.
const selected = computed(
  () => w.value.id === state.activeWorkspaceId && !selectedTopicId.value,
)

const dirty = computed(() => {
  const g = w.value.git
  return g ? g.staged + g.unstaged + g.untracked : 0
})

/**
 * §12 — "où j'en suis", for the one thing that moves while you are looking
 * somewhere else. Read from the conversations rather than from
 * `w.agentSessions`: that array only ever holds running sessions, and a
 * conversation that finished and has not been read is exactly what this row
 * has to be able to say.
 */
const act = computed(() => activityFor('workspace', w.value.id))

const ATTENTION_TEXT: Record<string, string> = {
  reply: 'an agent answered here — waiting for you',
  blocked: 'an agent stopped here: it was refused a tool it needed',
  failed: 'an agent failed here',
}

/**
 * Two things live in this list and the icon is what tells them apart: a
 * repository sitting on its default branch, and a branch checked out in a
 * folder of its own. "Worktree" is how git does the second one; it is not
 * what the row is.
 */
const kindLabel = computed(() =>
  w.value.kind === 'main'
    ? 'repository'
    : w.value.kind === 'worktree'
      ? 'branch'
      : w.value.kind === 'external'
        ? 'folder'
        : w.value.kind,
)
</script>

<template>
  <button class="row" :class="{ selected, compact }" @click="selectWorkspace(w.id)">
    <!-- The kind is the one thing an icon says faster than a word. -->
    <span class="kind" :title="kindLabel">
      <component :is="w.kind === 'worktree' ? GitBranch : SquareDot" class="sm" />
    </span>

    <!-- §12 — the branch is the identity; the repository name is context. -->
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
        :title="'servers ' + w.runtime.status"
      />
      <!-- Two different facts, never merged into one number: an agent is at
           work here, and an agent is waiting on you here. -->
      <span
        v-if="act.running"
        class="c agent live"
        :title="act.running + ' conversation(s) running here'"
      >
        <Sparkles class="sm" />{{ act.running }}
      </span>
      <span
        v-if="act.attention !== 'none'"
        class="c needs"
        :class="act.attention"
        :title="ATTENTION_TEXT[act.attention]"
      >
        <component :is="act.attention === 'reply' ? Hand : CircleAlert" class="sm" />
        <template v-if="act.waiting > 1">{{ act.waiting }}</template>
      </span>
      <span v-if="w.lease" class="lease" title="locked — an agent is working here">
        <Lock class="sm" />
      </span>

      <!-- §7 — the agent is aimed *here* by clicking here. The scope is where
           you clicked; there is no second menu asking what you meant. -->
      <span
        class="go"
        role="button"
        :title="'Ask the agent on ' + w.name"
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
  transition:
    background var(--dur-1) var(--ease-soft),
    color var(--dur-1) var(--ease-soft);
}
/* Under a topic header, stepped in by the width of that header's chevron.
   The `compact` flag has been passed down since the list first grouped rows
   and never did anything; the gap between groups was carrying the hierarchy
   on its own. Now that the gap is a fifth of what it was, the indent is what
   says these rows belong to the line above them. */
.row.compact { padding-left: 29px; }

.row:hover { background: var(--hover); }
/* The tint is the whole signal. There was an accent bar down the left edge as
   well, which is the convention for a rail whose items are otherwise
   undecorated — here it sat against a filled row, an icon that already turns
   accent, and a name that already gains weight, so it was a fourth voice
   saying a thing three others had said. */
.row.selected { background: var(--selected); color: var(--text); }

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
/* The row's only animated thing, and it means exactly one thing: something is
   running in here right now. */
.live { animation: pulse 1.6s var(--ease-soft) infinite; }
.needs.reply { color: var(--agent); }
.needs.blocked { color: var(--warn); }
.needs.failed { color: var(--danger); }
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
