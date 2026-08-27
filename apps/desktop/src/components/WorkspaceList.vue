<script setup lang="ts">
import { computed } from 'vue'
import {
  ArrowUp, FolderPlus, GitCompareArrows, GitMerge, Layers, Pause, Play, Plus, RefreshCw, Search,
} from '@lucide/vue'
import type { Feature } from '@cockpit/shared'
import WorkspaceRow from './WorkspaceRow.vue'
import {
  activateFeature, activeProject, addRepoTo, client, guard, landFeature, parkFeature, rebaseFeature,
  state, workspaceGroups,
} from '../core/store.js'

/**
 * §12 — "La liste centrale liste des workspaces, groupés par feature quand une
 * feature existe. Un workspace nu et un groupe de trois cohabitent
 * naturellement." The feature header only appears when there is a feature.
 */

const groups = computed(() => workspaceGroups.value)

const hasProjects = computed(() => state.projects.length > 0)

function featureSummary(ws: { git: { ahead: number } | null; runtime: { status: string } | null }[]) {
  const ahead = ws.reduce((n, w) => n + (w.git?.ahead ?? 0), 0)
  const up = ws.filter((w) => w.runtime?.status === 'up').length
  return { ahead, up, total: ws.length }
}

async function rescan() {
  await guard(() => client.call('core.reconcile', {}), 'rescanned')
}

/**
 * §8 + §11 — the switch. Parked means the worktrees are on disk and agents may
 * still run in them; live means the servers are up and the ports are bound.
 * Only a feature Cockpit actually opened has somewhere to keep that state, so
 * an inferred one gets no toggle (§3.9 — absent, not disabled).
 */
function togglable(f: Feature | null): boolean {
  return !!f && !f.derived && f.state !== 'archived'
}

async function toggle(f: Feature) {
  if (f.state === 'live') await parkFeature(f.id)
  else await activateFeature(f.id)
}

/**
 * §4 — the feature is the unit of work, so catching it up is one act. Rebasing
 * three worktrees used to mean selecting each one and approving three plans.
 */
function behind(ws: { git: { behind: number } | null }[]): number {
  return ws.reduce((n, w) => n + (w.git?.behind ?? 0), 0)
}

function ahead(ws: { git: { ahead: number } | null }[]): number {
  return ws.reduce((n, w) => n + (w.git?.ahead ?? 0), 0)
}

/** Uncommitted work: landing refuses over it, so the button says so up front. */
function dirty(ws: { git: { staged: number; unstaged: number } | null }[]): number {
  return ws.reduce((n, w) => n + (w.git?.staged ?? 0) + (w.git?.unstaged ?? 0), 0)
}
</script>

<template>
  <section class="list">
    <header class="head">
      <button class="search" @click="state.paletteOpen = true">
        <Search class="sm" />
        <span class="ph">Search or run a command</span>
        <span class="kbd">⌘K</span>
      </button>
    </header>

    <div class="scroll">
      <div v-if="!hasProjects" class="empty">
        <FolderPlus />
        <strong>No project yet</strong>
        <span>
          Add a folder with <span class="kbd">+</span> in the rail, or run
          <code class="mono">cockpit add .</code> in any repository.
        </span>
      </div>

      <template v-else>
        <div v-for="(g, i) in groups" :key="g.featureId ?? 'loose-' + i" class="group">
          <!-- A feature is a decoration (§4): no feature, no header. -->
          <div v-if="g.title" class="group-head" :class="{ live: g.feature?.state === 'live' }">
            <Layers class="sm gi" />
            <span class="title">{{ g.title }}</span>
            <span class="summary num">
              <span v-if="g.feature && g.feature.costUsd > 0" class="dim cost">
                ${{ g.feature.costUsd.toFixed(2) }}
              </span>
              <span v-if="featureSummary(g.workspaces).ahead" class="up">
                <ArrowUp class="sm" />{{ featureSummary(g.workspaces).ahead }}
              </span>
              <span class="dim">{{ featureSummary(g.workspaces).total }}</span>
            </span>
            <!-- §4 — the step the lifecycle was missing: the branch goes onto
                 the base, in each repository's main checkout. Before this the
                 last move was always "go to a terminal". -->
            <button
              v-if="togglable(g.feature)"
              class="icon-btn small"
              :class="{ ready: ahead(g.workspaces) && !dirty(g.workspaces) }"
              :title="dirty(g.workspaces)
                ? 'Commit first — landing refuses over uncommitted changes'
                : 'Land on the base branch — one --no-ff merge per repository'"
              @click="landFeature(g.feature!.id, false)"
            >
              <GitMerge class="sm" />
            </button>
            <!-- One plan across every repository it spans, stopping at the
                 first conflict and keeping what already replayed. -->
            <button
              v-if="togglable(g.feature)"
              class="icon-btn small"
              :class="{ nudge: behind(g.workspaces) }"
              :title="behind(g.workspaces)
                ? 'Rebase every repository onto its base — ' + behind(g.workspaces) + ' commit(s) behind'
                : 'Rebase every repository in this feature onto its base'"
              @click="rebaseFeature(g.feature!.id)"
            >
              <GitCompareArrows class="sm" />
            </button>
            <!-- §3.9 - an inferred feature has no state to toggle, so no button. -->
            <button
              v-if="togglable(g.feature)"
              class="icon-btn small toggle"
              :class="{ on: g.feature!.state === 'live' }"
              :title="g.feature!.state === 'live' ? 'Park - servers down, worktrees kept' : 'Make live - bring its runtimes up'"
              @click="toggle(g.feature!)"
            >
              <component :is="g.feature!.state === 'live' ? Pause : Play" class="sm" />
            </button>
          </div>
          <div v-else-if="groups.length > 1 && i > 0" class="divider">
            <span class="section-label">other workspaces</span>
          </div>

          <WorkspaceRow v-for="w in g.workspaces" :key="w.id" :workspace="w" :compact="!!g.title" />
        </div>
      </template>
    </div>

    <footer v-if="activeProject" class="foot">
      <span class="root" :title="activeProject.root">{{ activeProject.root }}</span>
      <button
        class="icon-btn small"
        title="Open a feature - a branch per repository, one plan"
        @click="state.featureDialogOpen = true"
      >
        <Plus class="sm" />
      </button>
      <!-- §7 - one folder per repository, inside the project folder. Beside
           the feature button because it is the same kind of act: adding
           something to the project rather than looking at what is in it. -->
      <button
        class="icon-btn small"
        title="Add a repository - a new one, a clone, or a folder moved in"
        @click="addRepoTo(activeProject.id)"
      >
        <FolderPlus class="sm" />
      </button>
      <button class="icon-btn small" title="Re-probe everything" @click="rescan">
        <RefreshCw class="sm" />
      </button>
    </footer>
  </section>
</template>

<style scoped>
/* Behind its base is the one state where this verb is the next thing to do. */
.nudge { color: var(--warn); }
/* Committed and ahead: landing is the next thing, so it says so. */
.ready { color: var(--ok); }

.list {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--panel);
  border-right: 1px solid var(--line);
}

.head {
  padding: var(--col-top) 12px 10px;
  flex: none;
}

/* The palette trigger doubles as the column header — §12 makes it the real
   entry point, so it sits where the eye lands first. */
.search {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  height: 34px;
  padding: 0 8px 0 11px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--bg-sunken);
  color: var(--text-dim);
  font-size: var(--fs-sm);
  box-shadow: var(--shadow-xs);
  transition:
    border-color var(--dur-2) var(--ease-soft),
    background var(--dur-2) var(--ease-soft),
    box-shadow var(--dur-2) var(--ease-soft);
  -webkit-app-region: no-drag;
}
.search:hover {
  border-color: var(--line-strong);
  background: var(--panel-raised);
  box-shadow: var(--shadow-sm);
  color: var(--text-muted);
}
.ph { flex: 1; text-align: left; }

.scroll {
  flex: 1;
  overflow-y: auto;
  padding: 2px 10px 12px;
}

.group + .group { margin-top: 14px; }

.group-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px 11px 6px;
}
.gi { color: var(--text-dim); }
.title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-md);
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text);
}
.summary { display: flex; align-items: center; gap: 9px; font-size: var(--fs-xs); }
.summary .up { color: var(--ok); display: inline-flex; align-items: center; gap: 2px; }
.summary .up .lucide { width: 11px; height: 11px; stroke-width: 2.4; }
.summary .dim { color: var(--text-dim); }
.summary .cost { font-variant-numeric: tabular-nums; }

/* Live reads as a state of the header, not as a badge to hunt for. */
.group-head.live .gi { color: var(--ok); }
.toggle { margin-left: 4px; opacity: 0; transition: opacity var(--dur-2) var(--ease-soft); }
.group-head:hover .toggle,
.toggle.on { opacity: 1; }
.toggle.on { color: var(--ok); }

.divider { padding: 16px 11px 6px; }

.foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 38px;
  padding: 0 8px 0 14px;
  border-top: 1px solid var(--line);
  background: var(--panel);
}
.root {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* Truncate from the left; `plaintext` keeps the string itself in reading
     order, which bare `rtl` does not — it moves the leading slash to the end. */
  direction: rtl;
  unicode-bidi: plaintext;
  text-align: left;
  font-size: var(--fs-xs);
  color: var(--text-dim);
  font-family: var(--mono);
}
.icon-btn.small { width: 26px; height: 26px; }
.empty code { font-size: var(--fs-xs); color: var(--text-muted); }
.empty .kbd { height: 18px; min-width: 18px; }
</style>
