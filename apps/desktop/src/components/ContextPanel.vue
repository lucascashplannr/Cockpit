<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  ArrowDown, ArrowUp, FileDiff, GitBranch, MousePointerClick, PanelRight, Plug,
} from '@lucide/vue'
import AgentTab from './tabs/AgentTab.vue'
import ReviewTools from './ReviewTools.vue'
import ConflictPanel from './ConflictPanel.vue'
import Wordmark from './brand/Wordmark.vue'
import { activeWorkspace, goTo, setDrawerH, state } from '../core/store.js'

/**
 * The third column, and the four roles in the order they are used (§12,
 * rewritten):
 *
 *   1. navigate — the rail and the list to the left, and the scope bar the
 *                 Agent carries: project, feature, repo, folder.
 *   2. agent    — this column. Permanently. It is what the window is for.
 *   3. review   — Diff / Code / Journal / Terminal, opened beside it. Three
 *                 candidate placements, switched by the bench (⌘⇧D).
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

/* ── the drawer's drag handle ──────────────────────────────────────────── */
const dragging = ref(false)

function startDrag(e: PointerEvent): void {
  dragging.value = true
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  const move = (ev: PointerEvent) => setDrawerH(window.innerHeight - ev.clientY)
  const up = (ev: PointerEvent) => {
    dragging.value = false
    el.releasePointerCapture(ev.pointerId)
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
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

          <!-- `modes` is a switch between two whole screens; the other two open
               a surface beside the conversation and leave it where it is. -->
          <div v-if="state.reviewLayout === 'modes'" class="seg modes">
            <button :class="{ on: !state.reviewOpen }" @click="state.reviewOpen = false">Work</button>
            <button :class="{ on: state.reviewOpen }" @click="state.reviewOpen = true">
              Review
              <span v-if="changed" class="tbadge num">{{ changed }}</span>
            </button>
          </div>
          <button
            v-else
            class="btn ghost rev"
            :class="{ on: state.reviewOpen }"
            :title="state.reviewLayout === 'drawer' ? 'Review drawer' : 'Review panel'"
            @click="state.reviewOpen = !state.reviewOpen"
          >
            <PanelRight class="sm" />
            Review
            <span v-if="changed" class="tbadge num">{{ changed }}</span>
          </button>

          <span class="path mono" :title="w.path">{{ w.path }}</span>
        </div>
      </header>

      <!-- §3.7 — above everything on purpose: while a rebase is stopped, none
           of what is below is the next thing to do. Absent otherwise (§3.9). -->
      <ConflictPanel />

      <!-- `modes`: the review layer takes the whole column instead. -->
      <div v-if="state.reviewLayout === 'modes' && state.reviewOpen" class="body">
        <ReviewTools :workspace="w" />
      </div>

      <template v-else>
        <div class="body">
          <AgentTab :workspace="w" />
        </div>

        <!-- `drawer`: under the conversation, dragged to size, the way a
             terminal panel sits in an editor. -->
        <template v-if="state.reviewLayout === 'drawer' && state.reviewOpen">
          <div
            class="handle"
            :class="{ dragging }"
            title="Drag to resize"
            @pointerdown.prevent="startDrag"
          />
          <div class="drawer" :style="{ height: state.drawerH + 'px' }">
            <ReviewTools :workspace="w" closable />
          </div>
        </template>
      </template>
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
.path {
  flex: none;
  margin-left: 10px;
  color: var(--text-dim);
  font-size: var(--fs-xs);
  /* Truncate from the left; `plaintext` keeps the string itself in reading
     order, which bare `rtl` does not — it moves the leading slash to the end. */
  direction: rtl;
  unicode-bidi: plaintext;
  max-width: 30%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status {
  display: flex;
  align-items: center;
  gap: 8px 10px;
  /* 34px is the height of the search field in the column to the left, so the
     two columns start their content on one line. */
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

.seg.modes { flex: none; height: 26px; }
.seg.modes > button { height: 22px; font-size: var(--fs-xs); gap: 6px; }
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

/* ── the drawer ──────────────────────────────────────────────────────── */
/* 5px of grab area for a 1px line: a hairline is the right thing to see and
   the wrong thing to aim at. */
.handle {
  flex: none;
  height: 5px;
  cursor: ns-resize;
  background: var(--line);
  background-clip: content-box;
  border-top: 2px solid transparent;
  border-bottom: 2px solid transparent;
  touch-action: none;
}
.handle:hover, .handle.dragging { background: var(--accent); }

.drawer { flex: none; min-height: 0; overflow: hidden; }

.body { flex: 1; min-height: 0; overflow: hidden; }
</style>
