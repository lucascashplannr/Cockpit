<script setup lang="ts">
import { computed } from 'vue'
import {
  ArrowDown, ArrowUp, BookMarked, FileDiff, GitBranch, History, Layers, MousePointerClick,
  PanelRight, Plug,
} from '@lucide/vue'
import AgentTab from './tabs/AgentTab.vue'
import ConflictPanel from './ConflictPanel.vue'
import Wordmark from './brand/Wordmark.vue'
import TopicActions from './TopicActions.vue'
import WorkspaceActions from './WorkspaceActions.vue'
import {
  activeAgentScope, activeWorkspace, attentionOf, goTo, scopeLabel, selectedTopicGroup,
  sessionsForScope, state,
} from '../core/store.js'

/**
 * The third column, and the four roles in the order they are used (§12,
 * rewritten):
 *
 *   1. navigate — the rail and the list to the left, and the scope bar the
 *                 Agent carries: project, topic, repository, branch.
 *   2. agent    — this column. Permanently. It is what the window is for.
 *   3. review   — Diff / Code / Journal / Terminal, in a fourth column that
 *                 opens on demand and is closed by default.
 *   4. run      — the runtime verbs, in the title band above.
 *
 * They used to be six peer tabs, which said all four were the same kind of
 * thing. They are not: one of them is the act and the rest are its instruments.
 */

const w = computed(() => activeWorkspace.value)

/**
 * §4 — what this line is speaking for.
 *
 * On a topic that is every branch under it, not the one that happens to be the
 * anchor. The bar used to read the anchor's git state whatever the scope was,
 * so standing on a topic showed one of its branches by name and that branch's
 * counts — a true statement about something nobody had asked about, sitting
 * where the answer to "how does this topic stand" belongs.
 */
const covered = computed(() =>
  selectedTopicGroup.value?.workspaces ?? (w.value ? [w.value] : []),
)

/**
 * The branch is named only when there is exactly one of it. Across a topic
 * there is no single branch to name, and picking one would be arbitrary.
 */
const git = computed(() => {
  const ws = covered.value.filter((x) => x.git)
  if (!ws.length) return null
  return {
    branch: ws.length === 1 ? (ws[0]!.git!.branch ?? 'detached') : null,
    ahead: ws.reduce((n, x) => n + (x.git?.ahead ?? 0), 0),
    behind: ws.reduce((n, x) => n + (x.git?.behind ?? 0), 0),
  }
})

const changed = computed(() =>
  covered.value.reduce((n, x) => {
    const g = x.git
    return n + (g ? g.staged + g.unstaged + g.untracked : 0)
  }, 0),
)

/* ── what the conversation is on, and its two instruments ─────────────────
 *
 * These lived on a second bar of their own, directly under this one, so the
 * column opened with two rows of chrome before the first word of the work:
 * one saying where the branch stood, one saying what the agent was pointed at.
 * They are the same sentence — *this is what you are on* — split across two
 * lines, and the split cost thirty-eight pixels of every screen.
 */
const scope = computed(() => activeAgentScope.value)
const label = computed(() => scopeLabel(scope.value))
const conversations = computed(() => sessionsForScope(scope.value))
const waiting = computed(
  () => conversations.value.filter((c) => attentionOf(c) !== 'none').length,
)

</script>

<template>
  <section class="panel">
    <!-- Nothing selected is still a first impression: the app says its name. -->
    <div v-if="!w" class="welcome">
      <Wordmark :height="48" class="wm" />
      <p class="tag">Everything in flight, in one window.</p>
      <div class="hints">
        <span class="hint">
          <span class="kbd">⌘K</span> jump to a repository or branch, or run anything
        </span>
        <span class="hint"><MousePointerClick class="sm" /> or pick one on the left</span>
      </div>
    </div>

    <template v-else>
      <!-- One line: what this is, where it stands, and the instruments of the
           conversation about it. Quiet on purpose — everything here is a fact
           about the work rather than the work, so only the name it is all
           about carries full contrast. -->
      <header class="head">
        <span class="scope" :title="label.name">
          <span class="k">{{ label.kind }}</span>
          <span class="n">{{ label.name }}</span>
        </span>

        <!-- How many repositories the word to the left stands for. This was a
             whole row of its own inside the conversation, spent on one number;
             it is a fact about the scope, so it belongs on the scope's line. -->
        <span
          v-if="covered.length > 1"
          class="stat num"
          :title="covered.length + ' repositories in this scope'"
        >
          <Layers class="sm si" />
          <span class="v">{{ covered.length }}</span>
        </span>

        <span v-if="git || w.runtime" class="rule" />

        <template v-if="git">
          <!-- Named only when there is one to name, and not when it is already
               the name above it: on a worktree the two are the same word, and
               saying it twice in one line is the noise this bar was merged to
               remove. Across a topic there is no single branch at all. -->
          <span v-if="git.branch && git.branch !== label.name" class="stat">
            <GitBranch class="sm si" />
            <span class="v">{{ git.branch }}</span>
          </span>
          <span class="stat num">
            <span class="v sync">
              <span :class="{ on: git.ahead }"><ArrowUp class="sm" />{{ git.ahead }}</span>
              <span :class="{ warn: git.behind }"><ArrowDown class="sm" />{{ git.behind }}</span>
            </span>
          </span>
          <!-- The count is the way into the review layer: what changed is the
               reason you would open it at all. -->
          <button
            class="stat num act"
            :title="changed + ' uncommitted change(s) — open the diff'"
            @click="goTo('diff')"
          >
            <FileDiff class="sm si" />
            <span class="v" :class="{ warn: changed }">{{ changed }}</span>
          </button>
        </template>

        <span v-if="w.runtime" class="stat">
          <i class="dot" :class="w.runtime.status" />
          <span class="v">{{ w.runtime.impl }}</span>
          <span class="k">{{ w.runtime.status }}</span>
        </span>

        <!-- §8 — a non-portable runtime says so, rather than failing later. -->
        <span
          v-if="w.runtime && !w.runtime.portable"
          class="stat quiet"
          title="These servers are set up on this machine only — they do not follow the repository"
        >
          local only
        </span>

        <span v-for="p in w.runtime?.ports ?? []" :key="p.name" class="stat num">
          <Plug class="sm si" />
          <span class="k">{{ p.name }}</span>
          <span class="v">:{{ p.port }}</span>
        </span>

        <span v-if="w.lease" class="stat warn" :title="w.lease.reason">locked</span>

        <span class="grow" />

        <!-- The verbs of the thing named at the left of this same line. They
             were in the window's title band, where they had a subject only
             because the subject had been dragged up there to give them one. -->
        <TopicActions v-if="selectedTopicGroup" :group="selectedTopicGroup" />
        <WorkspaceActions v-else />

        <span class="rule" />

        <!-- §6 — the conversation's own two instruments. They belong beside
             what they are about, which is the scope named at the far left of
             this same line. -->
        <button
          class="ib"
          :class="{ on: state.historyOpen, waiting: waiting > 0 }"
          title="Earlier conversations here"
          @click="state.historyOpen = !state.historyOpen"
        >
          <History class="sm" />
          <span v-if="conversations.length" class="n">{{ conversations.length }}</span>
        </button>
        <button
          class="ib"
          :class="{ on: state.memoryOpen }"
          title="The durable memory this conversation reads on the way in"
          @click="state.memoryOpen = !state.memoryOpen"
        >
          <BookMarked class="sm" />
          <span v-if="w.hasMemory" class="pip" />
        </button>

        <span class="rule" />

        <!-- One icon. The word and the badge both said what the count two
             stats to the left already says, in a bar whose whole point is to
             stop repeating itself. -->
        <button
          class="ib"
          :class="{ on: state.reviewOpen }"
          :title="(state.reviewOpen ? 'Close' : 'Open') + ' the review — diff, code, journal, terminal'"
          @click="state.reviewOpen = !state.reviewOpen"
        >
          <PanelRight class="sm" />
        </button>
      </header>

      <!-- §3.7 — above everything on purpose: while a rebase is stopped, none
           of what is below is the next thing to do. Absent otherwise (§3.9). -->
      <ConflictPanel />

      <div class="body">
        <AgentTab :workspace="w" />
      </div>
    </template>
  </section>
</template>

<style scoped>
/* The verbs drop their labels when this column gets narrow, and it is this
   box — not the window — that knows how narrow it is: the conversation gives
   up its width to the review column while the window stays exactly as wide. */
.panel {
  container-type: inline-size;
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
/* One row, and quiet. It was two — the branch's state, then the agent's scope
   — each with its own pills on its own line, so the column spent seventy-odd
   pixels telling you where you were before showing you anything. Everything
   here is a fact *about* the work rather than the work, so it is all one small
   size in one dim colour, and the only thing at full contrast is the name the
   whole line is about. */
/* Also the window's handle. The band that used to be the drag region is gone,
   and a frameless window nobody can move is worse than a band nobody needs —
   so this bar carries it, and every control in it opts back out. */
.head {
  -webkit-app-region: drag;
  flex: none;
  display: flex;
  align-items: center;
  /* Wraps rather than clips. This row now carries the name, the state, the
     verbs and the instruments, and on a narrow column with a runtime and three
     ports it will not all fit — a second line is a worse look than one line,
     and losing the Push button off the right edge is worse than both. */
  flex-wrap: wrap;
  /* `align-items` centres each item inside its line; with wrapping on, the
     lines themselves are placed by `align-content`, whose default leaves a
     single short line sitting against the top of a 52px bar. Both are needed. */
  align-content: center;
  gap: 4px 8px;
  /* Tall enough to be a header rather than a strip of chrome squeezed above
     the work. 52px is also exactly where the rail's own top matter ends, so
     the two columns start their content on one line. */
  min-height: 52px;
  padding: 0 12px 0 18px;
  min-width: 0;
  /* Its own surface. On `--bg` it was the same colour as the conversation
     under it and only a hairline said otherwise; on the raised white it reads
     as the thing the column is headed by. */
  background: var(--panel-raised);
  border-bottom: 1px solid var(--line);
}
.grow { flex: 1; }

/* What the conversation is on — the one thing here that is not a detail. */
/* Centred, not baseline-aligned. Baseline pushes the smaller label down until
   its baseline meets the name's, which makes the pair's box taller than the
   name and centres *that* — so the text everyone actually looks at ends up
   sitting below the middle of the bar. In a row of 28px controls the two want
   to be centred on each other, not on a shared baseline. */
.scope { display: inline-flex; align-items: center; gap: 6px; min-width: 0; margin-right: 2px; }
.scope .k {
  flex: none;
  line-height: 1;
  font-size: 10px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.scope .n {
  line-height: 1;
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* A hairline instead of a gap: it separates the three groups without adding
   another shape to a row that just lost eleven of them. */
.rule { flex: none; width: 1px; height: 14px; background: var(--line); }

/* No pill, no fill. A stat is a word and a number. */
.stat {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 2px;
  border-radius: var(--radius-sm);
  font-size: var(--fs-xs);
  line-height: 1;
  color: var(--text-dim);
  min-width: 0;
}
.stat.quiet { color: var(--text-dim); opacity: 0.75; }
.stat.warn { color: var(--warn); }
.si { color: var(--text-dim); opacity: 0.8; }
.stat .k { color: var(--text-dim); }
.stat .v {
  color: var(--text-muted);
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stat .v.warn { color: var(--warn); }
.sync { gap: 8px; }
.sync span { display: inline-flex; align-items: center; gap: 2px; color: var(--text-dim); font-weight: 500; }
.sync .lucide { width: 12px; height: 12px; stroke-width: 2.4; }
/* Zero stays dim: a count of nothing is not news. */
.sync span.on { color: var(--ok); }
.sync span.warn { color: var(--warn); }

/* The changed count is a button, because it is the reason you would open the
   review layer at all: what moved is what there is to read. */
.stat.act { cursor: pointer; padding: 0 6px; }
.stat.act:hover { background: var(--hover); color: var(--text); }

.head button,
.head :deep(button),
.head .scope { -webkit-app-region: no-drag; }

/* The three controls on the right, one shape. Ghosts until they are on. */
.ib {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  font-size: var(--fs-xs);
  color: var(--text-dim);
  transition: color var(--dur-1) var(--ease-soft), background var(--dur-1) var(--ease-soft);
}
.ib:hover { color: var(--text); background: var(--hover); }
.ib.on { color: var(--accent); background: var(--accent-soft); }
.ib.waiting { color: var(--warn); }
.ib .n { font-size: 11px; color: var(--text-dim); }
.ib.on .n, .ib.waiting .n { color: inherit; }
.ib .pip { width: 5px; height: 5px; border-radius: 50%; background: var(--agent); }

.body { flex: 1; min-height: 0; overflow: hidden; }
</style>
