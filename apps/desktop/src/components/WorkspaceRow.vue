<script setup lang="ts">
import { computed } from 'vue'
import {
  ArrowDownToLine, ArrowUp, CircleAlert, CirclePlay, CircleStop, GitBranch, GitCompareArrows,
  Hand, Lock, Sparkles,
  SquareDot, TriangleAlert,
} from '@lucide/vue'
import type { Workspace } from '@cockpit/shared'
import {
  activityFor, openAgentOn, selectedTopicId, selectWorkspace, state, toggleWorkspaceRuntime,
} from '../core/store.js'

const props = defineProps<{ workspace: Workspace; compact?: boolean }>()

const w = computed(() => props.workspace)
// Selecting a topic anchors the panel on one of its rows, so the row id
// alone would light two things at once. The narrower selection wins: while the
// topic is what is selected, none of its rows is.
const selected = computed(
  () => w.value.id === state.activeWorkspaceId && !selectedTopicId.value,
)

/**
 * §8 — `starting` counts as running: a server still coming up is one to stop,
 * not one to start a second time onto the same port.
 */
const serverRunning = computed(
  () => w.value.runtime?.status === 'up' || w.value.runtime?.status === 'starting',
)

/**
 * Select first, then act. Starting a server from a row you are not standing on
 * would leave the window pointed somewhere else while the thing you asked for
 * boots out of sight — and looking at it is the reason you started it.
 */
async function startHere() {
  selectWorkspace(w.value.id)
  await toggleWorkspaceRuntime(w.value)
}

const dirty = computed(() => {
  const g = w.value.git
  return g ? g.staged + g.unstaged + g.untracked : 0
})

/**
 * §4 — the two distances a row can be behind, drawn separately because they
 * are closed by two different verbs.
 *
 *   the base moved     → Catch up, `behindBase`
 *   its own remote     → Pull, `behind`
 *
 * One counter tried to serve both and could not: `behindBase ?? behind` falls
 * back only on null, so a topic branch level with its base (`behindBase: 0`)
 * and one commit behind its own remote showed nothing at all — while the bar
 * beside it offered `Pull 1`. `||` would have fixed that case and lost the
 * other, hiding the base's count whenever both were live.
 *
 * So: the same two glyphs the bar uses for the same two verbs, each drawn only
 * when it has something to say. In the ordinary case that is still one number.
 */
const behindBase = computed(() => w.value.git?.behindBase ?? 0)

/**
 * Only against this branch's *own* remote. A topic branch tracks
 * `origin/<base>` until its first push, and `behind` there is the base's
 * distance wearing the wrong name — already counted to the left.
 */
const toPull = computed(() => {
  const g = w.value.git
  return g && g.branch && g.upstream === 'origin/' + g.branch ? g.behind : 0
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
        <!-- One ↓, and it counts whichever distance this row can actually act
             on: the base while there is a base to catch up from, and otherwise
             its own remote, which is what a row sitting on the base is behind.
             Two arrows for the two would say the row has twice as much wrong
             with it as it does; the verb that closes each is on the bar, with
             its own number. -->
        <span
          v-if="behindBase"
          class="c behind"
          :title="behindBase + ' commit(s) behind ' + (w.git.base ?? 'the base') + ' — Catch up brings them in'"
        >
          <GitCompareArrows class="sm" />{{ behindBase }}
        </span>
        <span
          v-if="toPull"
          class="c behind"
          :title="toPull + ' commit(s) on ' + w.git.upstream + ' you do not have — Pull brings them in'"
        >
          <ArrowDownToLine class="sm" />{{ toPull }}
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

      <!-- §8 — and the servers are started *here* too, for the same reason the
           agent is: "click play and it switches to that branch and runs it"
           should not require selecting the row first and then crossing the
           window to a bar. Absent where there is nothing to run (§3.9). -->
      <span
        v-if="w.runtime"
        class="go run"
        :class="{ lit: serverRunning }"
        role="button"
        :title="serverRunning ? 'Stop the servers on ' + w.name : 'Start the servers on ' + w.name"
        @click.stop="startHere"
      >
        <component :is="serverRunning ? CircleStop : CirclePlay" class="sm" />
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

/* A server that is up is not a hover affordance — it is the state of the row,
   so it stays lit when the pointer leaves and keeps the runtime's own colour. */
.go.run:hover { background: var(--ok-soft); color: var(--ok); }
.go.run.lit { opacity: 1; color: var(--ok); }

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
