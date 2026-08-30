<script setup lang="ts">
import { computed } from 'vue'
import {
  ArrowDown, ArrowUp, FileDiff, GitBranch, MousePointerClick, PanelRight, Plug,
} from '@lucide/vue'
import AgentTab from './tabs/AgentTab.vue'
import ConflictPanel from './ConflictPanel.vue'
import Wordmark from './brand/Wordmark.vue'
import { activeWorkspace, goTo, state } from '../core/store.js'

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

const changed = computed(() => {
  const g = w.value?.git
  return g ? g.staged + g.unstaged + g.untracked : 0
})

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
      <header class="head">
        <!-- Layer 1's state line: where this is, what has moved, what is up.
             The verbs that act on it are in the title band (WorkspaceActions). -->
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
            <!-- The count is the way into the review layer: what changed is
                 the reason you would open it at all. -->
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
            class="chip"
            title="These servers are set up on this machine only — they do not follow the repository"
          >
            local only
          </span>

          <span v-for="p in w.runtime?.ports ?? []" :key="p.name" class="stat num">
            <Plug class="sm si" />
            <span class="k">{{ p.name }}</span>
            <span class="v">:{{ p.port }}</span>
          </span>

          <span v-if="w.lease" class="chip warn" :title="w.lease.reason">locked</span>

          <span class="grow" />

          <button
            class="btn ghost rev"
            :class="{ on: state.reviewOpen }"
            title="Review what changed — diff, code, journal, terminal"
            @click="state.reviewOpen = !state.reviewOpen"
          >
            <PanelRight class="sm" />
            Review
            <span v-if="changed" class="tbadge num">{{ changed }}</span>
          </button>
        </div>
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
.grow { flex: 1; }

.status {
  display: flex;
  align-items: center;
  gap: 8px 10px;
  /* Tall enough that the pills and the Review button sit on one line without
     the row collapsing onto them. */
  min-height: 34px;
  padding: 0 0 12px;
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

/* ── the way into layer 3 ────────────────────────────────────────────── */
/* The changed count is a button, because it is the reason you would open the
   review layer at all: what moved is what there is to read. */
.stat.act { cursor: pointer; }
.stat.act:hover { background: var(--active); }

.btn.ghost.rev { flex: none; height: 26px; padding: 0 10px; font-size: var(--fs-xs); gap: 6px; }
.btn.ghost.rev.on { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
.tbadge {
  font-size: 10px;
  padding: 0 5px;
  height: 16px;
  min-width: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--hover);
  color: var(--text-muted);
}
.on .tbadge { background: var(--accent-soft); color: var(--accent); }


.body { flex: 1; min-height: 0; overflow: hidden; }
</style>
