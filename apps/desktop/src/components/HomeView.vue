<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { Component } from 'vue'
import {
  ArrowDown, ArrowUp, CircleAlert, CloudDownload, FolderOpen, FolderPlus, GitBranch, Hand,
  Lightbulb, Search, SlidersHorizontal, Sparkles, SquareDot, X,
} from '@lucide/vue'
import type { Workspace } from '@cockpit/shared'
import Wordmark from './brand/Wordmark.vue'
import NewProjectSources from './NewProjectSources.vue'
import { fuzzyFilter, highlight } from '../core/fuzzy.js'
import {
  activeProject, activityFor, canLeaveHome, closeHome, cycleTheme, newProject, recentWorkspaces,
  selectWorkspace, state,
} from '../core/store.js'

/**
 * §12 — the start page. The app opens on a search field rather than on the
 * row that happened to be selected last time, because "where do I go
 * now" is a different question from "what was I doing".
 *
 * It is the palette's slower sibling on purpose: same matching, but it also
 * answers with no query typed, and it is the only screen that says the app's
 * name. The palette (⌘K) still works on top of it for everything else.
 */

const query = ref('')
const cursor = ref(0)
const input = ref<HTMLInputElement | null>(null)

interface Hit {
  id: string
  label: string
  hint?: string
  icon: Component
  /** Present for a workspace, so the row can show its state (§12). */
  ws?: Workspace
  run: () => void | Promise<void>
}

/** A hit plus where the query matched it, so the row can underline itself. */
interface Row extends Hit {
  positions: number[]
}

const projectOf = (w: Workspace) => state.projects.find((p) => p.id === w.projectId)

/** `project/branch` — the same identity the palette matches on. */
function labelOf(w: Workspace): string {
  const p = projectOf(w)
  return p ? p.name + '/' + w.name : w.name
}

function toHit(w: Workspace): Hit {
  return {
    id: 'ws:' + w.id,
    label: labelOf(w),
    hint: w.path,
    icon: w.kind === 'worktree' ? GitBranch : SquareDot,
    ws: w,
    run: () => selectWorkspace(w.id),
  }
}

const actions = computed<Hit[]>(() => [
  {
    id: 'act:new',
    label: 'New project from scratch',
    hint: 'an empty project, ready for its first repository',
    icon: FolderPlus,
    run: () => newProject('scratch'),
  },
  {
    id: 'act:folder',
    label: 'New project from a folder',
    hint: 'something already on this machine',
    icon: FolderOpen,
    run: () => newProject('folder'),
  },
  {
    id: 'act:clone',
    label: 'New project from a repository',
    hint: 'clone from GitHub or any git remote',
    icon: CloudDownload,
    run: () => newProject('clone'),
  },
  {
    id: 'act:settings',
    label: 'Settings',
    hint: state.settings?.devRoot ?? 'the Dev folder, the editor',
    icon: SlidersHorizontal,
    run: () => {
      state.settingsOpen = true
    },
  },
  {
    id: 'act:theme',
    label: 'Switch the theme',
    hint: state.theme,
    icon: Sparkles,
    run: cycleTheme,
  },
])

const openable = computed(() => state.workspaces.filter((w) => w.kind !== 'group'))

/**
 * With no query the page answers with habit; with one it answers with search.
 * Both lists are the same rows, so the eye never has to re-learn them.
 */
const rows = computed<Row[]>(() => {
  const q = query.value.trim()
  if (!q) {
    const base = recentWorkspaces.value.length ? recentWorkspaces.value : openable.value
    return base.slice(0, 6).map((w) => ({ ...toHit(w), positions: [] }))
  }
  const pool = [...openable.value.map(toHit), ...actions.value]
  return fuzzyFilter(pool, q, (h) => h.label, 8).map((s) => ({ ...s.item, positions: s.positions }))
})

const heading = computed(() =>
  query.value.trim() ? 'Results' : recentWorkspaces.value.length ? 'Recent' : 'Everything open',
)

const parts = (r: Row) => highlight(r.label, r.positions)

const dirty = (w: Workspace) => (w.git ? w.git.staged + w.git.unstaged + w.git.untracked : 0)

/* Two counts rather than one umbrella noun: the window has no word that
   covers both a repository and a branch of it, and it does not need one. */
const repoCount = computed(() => openable.value.filter((w) => w.kind !== 'worktree').length)
const branchCount = computed(() => openable.value.filter((w) => w.kind === 'worktree').length)

/* One tip per visit. Fixed set, so nothing here can ever describe a control
   that does not exist. */
const TIPS = [
  'Press ⌘K anywhere to run a command without leaving the keyboard.',
  'Type / in the palette to jump to a file, # to search every repository at once.',
  'r rebases and p pushes — both show you the plan before anything runs.',
  '⌘1 is the agent; ⌘2 and up are the review tools beside it.',
  'A topic is one named branch across every repository it touches.',
]
const tip = TIPS[Math.floor(Math.random() * TIPS.length)]

function move(delta: number) {
  const n = rows.value.length
  if (!n) return
  cursor.value = (cursor.value + delta + n) % n
}

function run(h: Row | undefined) {
  if (!h) return
  void h.run()
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    move(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    move(-1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    run(rows.value[cursor.value])
  } else if (e.key === 'Escape') {
    // A typed query is the nearest thing to go back from; the page itself
    // is only dismissable once there is something behind it.
    if (query.value) {
      e.preventDefault()
      query.value = ''
    } else if (canLeaveHome.value) {
      e.preventDefault()
      closeHome()
    }
  }
}

watch(rows, () => {
  cursor.value = 0
})

onMounted(() => void nextTick(() => input.value?.focus()))
</script>

<template>
  <div class="home">
    <div class="drag" />

    <!-- The rail is underneath the start page, so its settings button is out
         of reach; the corner is the one place the chrome still has. -->
    <div class="corner">
      <button class="icon-btn" title="Settings" @click="state.settingsOpen = true">
        <SlidersHorizontal class="sm" />
      </button>
      <button v-if="canLeaveHome" class="icon-btn" title="Back to where you were (esc)" @click="closeHome">
        <X class="sm" />
      </button>
    </div>

    <div class="stage">
      <header class="hero">
        <Wordmark :height="36" class="wm" />
        <p class="tag">Everything in flight, in one window.</p>
      </header>

      <div class="box">
        <Search class="sm lead" />
        <input
          ref="input"
          v-model="query"
          class="q"
          type="text"
          spellcheck="false"
          autocomplete="off"
          placeholder="Search a repository, a branch, or a command…"
          @keydown="onKey"
        />
        <span class="kbd">⌘K</span>
      </div>

      <p class="meta">
        <span :class="{ off: state.connection !== 'connected' }">
          {{ state.connection === 'connected' ? 'connected' : state.connection }}
        </span>
        <span class="sep">·</span>
        <span>{{ state.projects.length }} {{ state.projects.length === 1 ? 'project' : 'projects' }}</span>
        <span class="sep">·</span>
        <span>{{ repoCount }} {{ repoCount === 1 ? 'repository' : 'repositories' }}</span>
        <span v-if="branchCount" class="sep">·</span>
        <span v-if="branchCount">
          {{ branchCount }} {{ branchCount === 1 ? 'branch' : 'branches' }}
        </span>
      </p>

      <!-- Nothing registered yet is the only state with a single answer. -->
      <div v-if="!state.projects.length" class="virgin">
        <p>
          No project yet. However it starts, it ends up the same way —
          <code class="mono">Dev/Project/repository</code> — with the project folder left free so
          a second repository can join the first.
        </p>
        <NewProjectSources @pick="newProject" />
      </div>

      <div v-else class="results">
        <p class="section-label">{{ heading }}</p>

        <button
          v-for="(h, i) in rows"
          :key="h.id"
          class="hit"
          :class="{ on: i === cursor }"
          @mousemove="cursor = i"
          @click="run(h)"
        >
          <component :is="h.icon" class="sm gl" />

          <span class="label">
            <span v-for="(p, pi) in parts(h)" :key="pi" :class="{ hi: p.hit }">{{ p.text }}</span>
          </span>

          <span class="state num">
            <template v-if="h.ws">
              <template v-if="h.ws.git">
                <span v-if="h.ws.git.ahead" class="c ahead"><ArrowUp class="sm" />{{ h.ws.git.ahead }}</span>
                <span v-if="h.ws.git.behind" class="c behind"><ArrowDown class="sm" />{{ h.ws.git.behind }}</span>
                <span v-if="dirty(h.ws)" class="c dirty"><i class="pip" />{{ dirty(h.ws) }}</span>
              </template>
              <span
                v-if="activityFor('workspace', h.ws.id).running"
                class="c agent live"
                :title="activityFor('workspace', h.ws.id).running + ' conversation(s) running here'"
              >
                <Sparkles class="sm" />{{ activityFor('workspace', h.ws.id).running }}
              </span>
              <span
                v-else-if="activityFor('workspace', h.ws.id).attention !== 'none'"
                class="c needs"
                :class="activityFor('workspace', h.ws.id).attention"
                title="an agent here is waiting for you"
              >
                <component
                  :is="activityFor('workspace', h.ws.id).attention === 'reply' ? Hand : CircleAlert"
                  class="sm"
                />
              </span>
              <span v-if="h.ws.runtime" class="dot" :class="h.ws.runtime.status" />
            </template>
            <span v-else-if="h.hint" class="hint">{{ h.hint }}</span>
          </span>
        </button>

        <p v-if="!rows.length" class="none">
          Nothing matches <em>{{ query }}</em>
        </p>
      </div>

      <!-- The page's other answer to "where do I go now": nowhere yet — start
           something. Three cards rather than one button, because which of the
           three it is is the only question, and answering it here saves the
           click the sheet would have charged for it (§12). -->
      <div v-if="state.projects.length" class="newp">
        <p class="section-label">New project</p>
        <NewProjectSources @pick="newProject" />
      </div>

      <!-- §3.9 again: a legend for a list that is not there teaches nothing. -->
      <div class="hints">
        <template v-if="rows.length">
          <span class="hint"><span class="kbd">↑</span><span class="kbd">↓</span> move</span>
          <span class="hint"><span class="kbd">↵</span> open</span>
        </template>
        <span class="hint"><span class="kbd">⌘K</span> run anything</span>
        <span v-if="canLeaveHome" class="hint"><span class="kbd">esc</span> back</span>
      </div>

      <p class="tip"><Lightbulb class="sm" /><b>Tip</b>{{ tip }}</p>
    </div>

    <footer class="foot">
      <span class="mono path" :title="activeProject?.root ?? ''">{{ activeProject?.root ?? '' }}</span>
      <span class="mono ver">{{ state.status?.version ? 'v' + state.status.version : '' }}</span>
    </footer>
  </div>
</template>

<style scoped>
.home {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  /* One soft pool of light behind the wordmark, so the page has a centre even
     before anything is on it. */
  background-image: radial-gradient(110% 60% at 50% 12%, var(--accent-soft), transparent 62%);
}

.drag {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  /* The start page covers the whole window, so it carries its own drag strip
     — and the traffic lights float over it, so the strip is exactly the room
     they need rather than the height of a band that no longer exists. */
  height: var(--lights-h);
  -webkit-app-region: drag;
}
.corner {
  /* Centred in the drag strip: (44 - 28) / 2. */
  position: absolute;
  top: 11px;
  right: 12px;
  z-index: 2;
  display: flex;
  gap: 2px;
  /* It sits inside the drag strip, which would otherwise swallow the click. */
  -webkit-app-region: no-drag;
}

.stage {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  /* Anchored near the top rather than centred: the field is the first thing
     the hands go to, and a centred column moves it every time the list under
     it grows or shrinks. */
  justify-content: flex-start;
  gap: 14px;
  padding: calc(var(--lights-h) + 38px) 32px 8px;
}

.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-bottom: 2px;
}
/* The mark's own C carries the accent and the rest of the word is text —
   the one place in the app where the accent is decoration rather than
   meaning, and the only place it is allowed to be. */
.wm {
  color: var(--brand-ink);
  --wm-lead: var(--accent);
}
.tag {
  margin: 0;
  font-size: var(--fs-md);
  color: var(--text-dim);
  letter-spacing: 0.01em;
}

/* ── the field ───────────────────────────────────────────────────────── */
.box {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  max-width: 560px;
  height: 46px;
  padding: 0 12px 0 14px;
  border-radius: var(--radius);
  border: 1px solid var(--line);
  background: var(--panel-raised);
  box-shadow: var(--shadow-md);
  transition:
    border-color var(--dur-2) var(--ease-soft),
    box-shadow var(--dur-2) var(--ease-soft);
}
.box:focus-within {
  border-color: var(--accent);
  box-shadow: var(--shadow-md), 0 0 0 3px var(--accent-soft);
}
.lead { color: var(--text-dim); }
.q {
  flex: 1;
  min-width: 0;
  border: none;
  background: none;
  color: var(--text);
  font: inherit;
  font-size: var(--fs-lg);
  letter-spacing: -0.01em;
}
.q::placeholder { color: var(--text-dim); }
.q:focus { outline: none; }

.meta {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: -6px 0 0;
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.meta .sep { opacity: 0.5; }
.meta .off { color: var(--warn); }

/* ── the list ────────────────────────────────────────────────────────── */
.results {
  width: 100%;
  max-width: 560px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-height: 0;
  overflow-y: auto;
}
.results .section-label { margin: 6px 0 6px 4px; }

.hit {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 36px;
  flex: none;
  padding: 0 10px;
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--text-muted);
  transition: background var(--dur-1) var(--ease-soft), color var(--dur-1) var(--ease-soft);
}
.hit.on { background: var(--selected); color: var(--text); }
.gl { color: var(--text-dim); }
.hit.on .gl { color: var(--accent); }

.label {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-sm);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.label .hi { color: var(--accent); font-weight: 600; }

.state {
  display: flex;
  align-items: center;
  gap: 9px;
  flex: none;
  font-size: var(--fs-xs);
}
.state .hint {
  color: var(--text-dim);
  max-width: 22ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.c {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--text-dim);
  font-weight: 500;
}
.c .lucide { width: 11px; height: 11px; stroke-width: 2.4; }
.c.ahead { color: var(--ok); }
.c.behind { color: var(--warn); }
.c.dirty { color: var(--warn); }
.c.agent { color: var(--agent); }
.c.live { animation: pulse 1.6s var(--ease-soft) infinite; }
.c.needs.reply { color: var(--agent); }
.c.needs.blocked { color: var(--warn); }
.c.needs.failed { color: var(--danger); }
.pip {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  display: block;
}
.state .dot { width: 7px; height: 7px; }

.none {
  margin: 10px 4px;
  font-size: var(--fs-sm);
  color: var(--text-dim);
}
.none em { color: var(--text-muted); font-style: normal; }

.virgin {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  width: 100%;
  max-width: 560px;
  margin-top: 8px;
  text-align: center;
}
.virgin p { max-width: 52ch; }
.virgin p { margin: 0; font-size: var(--fs-sm); color: var(--text-dim); line-height: 1.6; }
.virgin code { color: var(--text-muted); }

/* Same column as the field and the list above it, so the three cards line up
   with everything else on the page rather than floating at their own width. */
.newp {
  width: 100%;
  max-width: 560px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
}
.newp .section-label { margin-left: 4px; }

/* ── the keyboard legend ─────────────────────────────────────────────── */
.hints {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 4px;
}
.hint {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.hint .kbd + .kbd { margin-left: -2px; }

.tip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0 0;
  max-width: 78ch;
  font-size: var(--fs-xs);
  color: var(--text-dim);
  text-align: center;
}
.tip .lucide { color: var(--accent); opacity: 0.85; }
.tip b { color: var(--text-muted); font-weight: 600; margin-right: 4px; }

/* ── the footer ──────────────────────────────────────────────────────── */
.foot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: 34px;
  padding: 0 16px;
  font-size: var(--fs-xs);
  color: var(--text-dim);
  opacity: 0.7;
}
.foot .path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* A path is truncated from the left — the tail is the informative end. `rtl`
     alone would also reorder the string and move the leading slash to the back;
     `plaintext` takes the direction from the first strong character instead, so
     only the clipping flips. */
  direction: rtl;
  unicode-bidi: plaintext;
}
.foot .ver { flex: none; }
</style>
