<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { Component } from 'vue'
import {
  AppWindow, ArrowRight, ArrowUpFromLine, BookMarked, Check, CloudDownload, CornerDownLeft, FileCode,
  FolderOpen,
  FolderGit2, FolderPlus, GitBranch, GitCompareArrows, GitMerge, Layers, Pause, Play, RefreshCw, ScrollText,
  Search, Settings, SlidersHorizontal, Sparkles, SquareDot, SquareTerminal, TextSearch,
  Trash2, Undo2,
  RotateCcw, Archive, Zap,
} from '@lucide/vue'
import { fuzzyFilter, highlight } from '../core/fuzzy.js'
import {
  startTopic, activeProject, activeWorkspace, addRepoTo, archivedTopics, client, closeTopic, deleteTopic, goTo, guard, mergeTopic, markResolved, newProject, stopTopic, projectTopics, rebaseTopic, reopenTopic, requestPlan, resolveConflict, restartCore, selectWorkspace, state, toast,
} from '../core/store.js'
import type { TabId } from '../core/store.js'

/**
 * §12 — "L'objectif « 1 à 3 clics » est en réalité un objectif zéro clic :
 * le clavier bat toujours la souris."
 *
 * Four modes, chosen by the first character:
 *   (nothing)  workspaces + actions
 *   >          commands only
 *   /          files in the current workspace (git-tracked, §12)
 *   #          full-text across every repo at once (§12)
 */

interface Item {
  id: string
  label: string
  hint?: string
  group: string
  icon: Component
  run: () => void | Promise<void>
}

const query = ref('')
const cursor = ref(0)
const input = ref<HTMLInputElement | null>(null)
const trackedFiles = ref<string[]>([])
const searchHits = ref<{ workspaceId: string; path: string; line: number; text: string }[]>([])
const searching = ref(false)

const mode = computed<'default' | 'command' | 'file' | 'text'>(() => {
  const q = query.value
  if (q.startsWith('>')) return 'command'
  if (q.startsWith('/')) return 'file'
  if (q.startsWith('#')) return 'text'
  return 'default'
})

const leadIcon = computed<Component>(() =>
  mode.value === 'file'
    ? FolderOpen
    : mode.value === 'text'
      ? TextSearch
      : mode.value === 'command'
        ? ArrowRight
        : Search,
)

const term = computed(() => (mode.value === 'default' ? query.value : query.value.slice(1).trim()))

function close() {
  state.paletteOpen = false
}

/** Wraps an action so the palette closes first; the result is discarded
 *  because every handler reports through the toast itself. */
function act(fn: () => unknown) {
  return async () => {
    close()
    await fn()
  }
}

/** Commands are built from the live capability set, so an absent capability
 *  contributes no command at all (§3.9). */
const commands = computed<Item[]>(() => {
  const w = activeWorkspace.value
  const out: Item[] = []

  // §13 — the core is started detached by this app, so without this there is
  // no way to pick up new core code short of hunting the pid.
  out.push({
    id: 'core:restart',
    label: 'Restart the service',
    hint: 'servers keep running; conversations end but stay resumable',
    group: 'Cockpit',
    icon: RefreshCw,
    run: act(() => restartCore()),
  })

  // §4 — the durable unit of work, and the switch between two of them. Listed
  // before anything workspace-scoped: it is the level the day is organised at.
  if (activeProject.value) {
    out.push({
      id: 'topic:open',
      label: 'Open a topic',
      hint: 'one named branch across every repository it touches',
      group: 'Topic',
      icon: Layers,
      run: act(() => {
        state.topicDialogOpen = true
      }),
    })
  }

  // §7 — the layout does not stop at creation: a backend joining a project a
  // month later lands beside the repositories already in it, not elsewhere.
  if (activeProject.value) {
    out.push({
      id: 'project:addRepo',
      label: 'Add a repository',
      hint: 'a new one, a clone, or a folder moved into ' + activeProject.value.name,
      group: 'Project',
      icon: FolderGit2,
      run: act(() => addRepoTo(activeProject.value!.id)),
    })
  }
  for (const f of projectTopics.value) {
    if (f.derived) continue
    const isLive = f.state === 'running'
    out.push({
      id: 'topic:land:' + f.id,
      label: 'Send ' + f.name + ' to its base',
      hint: 'onto the base branch in every repository — the plan is shown first',
      group: 'Topic',
      icon: GitMerge,
      run: act(() => mergeTopic(f.id, false)),
    })
    out.push({
      id: 'topic:landpush:' + f.id,
      label: 'Send ' + f.name + ' to its base and push',
      hint: 'the same, then pushes the base branch',
      group: 'Topic',
      icon: GitMerge,
      run: act(() => mergeTopic(f.id, true)),
    })
    out.push({
      id: 'topic:rebase:' + f.id,
      label: 'Catch ' + f.name + ' up with its base',
      hint: 'every repository it spans, one plan — stops at the first conflict',
      group: 'Topic',
      icon: GitCompareArrows,
      run: act(() => rebaseTopic(f.id)),
    })
    out.push({
      id: 'topic:toggle:' + f.id,
      label: (isLive ? 'Stop ' : 'Start ') + f.name,
      hint: isLive ? 'its servers go down; the branches stay' : 'bring its servers up',
      group: 'Topic',
      icon: isLive ? Pause : Play,
      run: act(() => (isLive ? stopTopic(f.id) : startTopic(f.id))),
    })
    out.push({
      id: 'topic:close:' + f.id,
      label: 'Close ' + f.name,
      hint: 'reversible — the branches are removed by their own plan',
      group: 'Topic',
      icon: Archive,
      run: act(() => closeTopic(f.id, true)),
    })
    out.push({
      id: 'topic:delete:' + f.id,
      label: 'Delete ' + f.name + '…',
      hint: 'drops the record for good; refuses over anything unmerged',
      group: 'Topic',
      icon: Trash2,
      run: act(() =>
        deleteTopic(f.id, {
          removeWorktrees: true,
          deleteBranches: window.confirm(
            'Delete the branch "' + f.slug + '" in every repository too?\n\n' +
              'Cancel keeps the branches and removes only the checkouts and the record.',
          ),
        }),
      ),
    })
  }
  // §3.9 — a closed topic is listed only where it can be acted on.
  for (const f of archivedTopics.value) {
    out.push({
      id: 'topic:reopen:' + f.id,
      label: 'Reopen ' + f.name,
      hint: 'closed ' + new Date(f.updatedAt).toLocaleDateString(),
      group: 'Topic',
      icon: RotateCcw,
      run: act(() => reopenTopic(f.id)),
    })
    out.push({
      id: 'topic:delete:' + f.id,
      label: 'Delete ' + f.name + '…',
      hint: 'closed — remove it from the record for good',
      group: 'Topic',
      icon: Trash2,
      run: act(() => deleteTopic(f.id, { removeWorktrees: true, deleteBranches: false })),
    })
  }

  const tab = (id: TabId, label: string, icon: Component) =>
    out.push({
      id: 'tab:' + id,
      label: 'Go to ' + label,
      group: 'View',
      icon,
      run: act(() => {
        goTo(id)
      }),
    })

  if (w) {
    tab('code', 'Code', FileCode)
    if (w.git) tab('diff', 'Diff', GitCompareArrows)
    tab('agent', 'Agent', Sparkles)
    tab('memory', 'Memory', BookMarked)
    tab('journal', 'Journal', ScrollText)
    tab('terminal', 'Terminal', SquareTerminal)

    out.push({
      id: 'ide',
      label: 'Open in IDE',
      hint: w.name,
      group: 'Open',
      icon: FileCode,
      run: act(() => guard(() => client.call('workspace.openIn', { workspaceId: w.id, target: 'ide' }))),
    })
    out.push({
      id: 'finder',
      label: 'Reveal in Finder',
      group: 'Open',
      icon: FolderOpen,
      run: act(() => guard(() => client.call('workspace.openIn', { workspaceId: w.id, target: 'finder' }))),
    })

    if (w.runtime) {
      out.push({
        id: 'rt',
        label: w.runtime.status === 'up' ? 'Stop the servers' : 'Start the servers',
        hint: w.runtime.impl,
        group: 'Servers',
        icon: Zap,
        run: act(() =>
          guard(() =>
            client.call(w.runtime!.status === 'up' ? 'runtime.down' : 'runtime.up', { workspaceId: w.id }),
          ),
        ),
      })
      if (w.runtime.preview?.kind === 'url') {
        out.push({
          id: 'prev',
          label: 'Open the preview',
          hint: w.runtime.preview.value,
          group: 'Servers',
          icon: AppWindow,
          run: act(() => guard(() => client.call('workspace.openIn', { workspaceId: w.id, target: 'browser' }))),
        })
      }
    }

    // §3.7 — a stopped rebase replaces the git verbs rather than sitting beside
    // them: git refuses every one of them until this ends, and offering a
    // rebase mid-rebase is offering a guaranteed error.
    if (w.git?.operation) {
      const o = w.git.operation
      out.push({
        id: 'git:continue',
        label: 'Continue the ' + o.kind,
        hint: o.unresolvedPaths.length
          ? o.unresolvedPaths.length + ' file(s) still carry conflict markers'
          : 'stages the resolved files and carries on',
        group: 'Conflict',
        icon: Check,
        run: act(() => resolveConflict('continue')),
      })
      if (o.kind !== 'merge') {
        out.push({
          id: 'git:skip',
          label: 'Skip this commit',
          hint: 'drop it and move to the next',
          group: 'Conflict',
          icon: GitCompareArrows,
          run: act(() => resolveConflict('skip')),
        })
      }
      out.push({
        id: 'git:abort',
        label: 'Abort the ' + o.kind,
        hint: 'the branch goes back exactly where it started; the autostash comes with it',
        group: 'Conflict',
        icon: Undo2,
        run: act(() => resolveConflict('abort')),
      })
      if (o.unresolvedPaths.length) {
        out.push({
          id: 'git:markall',
          label: 'Mark every conflicted file resolved',
          hint: 'only when the markers belong in those files',
          group: 'Conflict',
          icon: Check,
          run: act(() => markResolved(o.conflictedPaths)),
        })
      }
    } else if (w.git) {
      const gitIcon: Record<string, Component> = {
        rebase: GitCompareArrows,
        merge: GitMerge,
        push: ArrowUpFromLine,
        sync: RefreshCw,
      }
      for (const op of ['rebase', 'merge', 'push', 'sync'] as const) {
        out.push({
          id: 'git:' + op,
          label: op[0]!.toUpperCase() + op.slice(1) + (op === 'rebase' || op === 'merge' ? ' onto the base branch' : ''),
          hint: 'shows a plan first',
          group: 'Git',
          icon: gitIcon[op]!,
          run: act(() => requestPlan(w.id, op)),
        })
      }
      out.push({
        id: 'git:branch',
        label: 'Create a branch here',
        hint: 'in this checkout — nothing new on disk',
        group: 'Git',
        icon: GitBranch,
        run: act(() => {
          const name = window.prompt('Name for the new branch')
          if (name) void requestPlan(w.id, 'branch', { name })
        }),
      })
      out.push({
        id: 'git:worktree',
        label: 'Create a branch in its own folder',
        hint: 'a separate checkout, so this one keeps what is in it',
        group: 'Git',
        icon: GitBranch,
        run: act(() => {
          const name = window.prompt('Name for the new branch')
          if (name) void requestPlan(w.id, 'worktree', { name })
        }),
      })
      out.push({
        id: 'git:undo',
        label: 'Undo the last operation',
        hint: 'back to the last restore point',
        group: 'Git',
        icon: Undo2,
        run: act(() => guard(() => client.call('git.undo', { workspaceId: w.id }))),
      })
    }

    // §12 — "Agent ici ← C0, deux touches". The cheapest possible path.
    out.push({
      id: 'agent:here',
      label: 'Ask the agent here',
      hint: 'logged, locked, restore point captured first',
      group: 'Agent',
      icon: Sparkles,
      run: act(() => {
        goTo('agent')
      }),
    })
  }

  // Project-level, not workspace-level: it is the folder that gets renamed,
  // moved, untracked or thrown away.
  if (activeProject.value) {
    out.push({
      id: 'proj:settings',
      label: 'Project settings…',
      hint: activeProject.value.name + ' — rename, move, untrack',
      group: 'Project',
      icon: Settings,
      run: act(() => {
        state.editingProjectId = activeProject.value!.id
      }),
    })
  }

  out.push({
    id: 'rescan',
    label: 'Refresh everything',
    group: 'Cockpit',
    icon: RefreshCw,
    run: act(() => guard(() => client.call('core.reconcile', {}), 'refreshed')),
  })
  // Three rows rather than one: "which of the three" is the only question the
  // sheet asks that the palette can answer first, and typing "clone" should
  // land on the one that matters.
  out.push({
    id: 'newproj',
    label: 'New project from scratch…',
    hint: 'an empty project, ready for its first repository',
    group: 'Cockpit',
    icon: FolderPlus,
    run: act(() => newProject('scratch')),
  })
  out.push({
    id: 'newproj:folder',
    label: 'New project from a folder…',
    hint: 'something already on this machine',
    group: 'Cockpit',
    icon: FolderOpen,
    run: act(() => newProject('folder')),
  })
  out.push({
    id: 'newproj:clone',
    label: 'New project from a repository…',
    hint: 'clone from GitHub or any git remote',
    group: 'Cockpit',
    icon: CloudDownload,
    run: act(() => newProject('clone')),
  })
  out.push({
    id: 'settings',
    label: 'Settings…',
    hint: 'the Dev folder, the editor',
    group: 'Cockpit',
    icon: SlidersHorizontal,
    run: act(() => {
      state.settingsOpen = true
    }),
  })

  return out
})

const workspaceItems = computed<Item[]>(() =>
  state.workspaces
    .filter((w) => w.kind !== 'group')
    .map((w) => ({
      id: 'ws:' + w.id,
      label: w.name,
      hint:
        (state.projects.find((p) => p.id === w.projectId)?.name ?? '') +
        (w.git ? ' · ↑' + w.git.ahead + ' ↓' + w.git.behind : '') +
        (w.runtime?.status === 'up' ? ' · running' : ''),
      // Two groups, because they are two things: a repository sitting on its
      // default branch, and a branch checked out in its own folder.
      group: w.kind === 'worktree' ? 'Branches' : 'Repositories',
      icon: w.kind === 'worktree' ? GitBranch : SquareDot,
      run: act(() => selectWorkspace(w.id)),
    })),
)

const fileItems = computed<Item[]>(() => {
  const w = activeWorkspace.value
  if (!w) return []
  return trackedFiles.value.map((f) => ({
    id: 'file:' + f,
    label: f,
    group: 'Files',
    icon: FileCode,
    run: act(() => {
      goTo('code')
      toast('info', f)
    }),
  }))
})

const textItems = computed<Item[]>(() =>
  searchHits.value.map((h) => ({
    id: 'hit:' + h.workspaceId + h.path + h.line,
    label: h.path + ':' + h.line,
    hint: h.text.trim().slice(0, 90),
    group: 'Matches',
    icon: TextSearch,
    run: act(() => {
      selectWorkspace(h.workspaceId)
      goTo('code')
    }),
  })),
)

const results = computed(() => {
  const t = term.value
  if (mode.value === 'command') return fuzzyFilter(commands.value, t, (i) => i.label + ' ' + i.group)
  if (mode.value === 'file') return fuzzyFilter(fileItems.value, t, (i) => i.label, 60)
  if (mode.value === 'text') return textItems.value.map((item) => ({ item, score: 0, positions: [] }))
  const pool = [...workspaceItems.value, ...commands.value]
  if (!t) {
    return pool.slice(0, 22).map((item) => ({ item, score: 0, positions: [] }))
  }
  return fuzzyFilter(pool, t, (i) => i.label + ' ' + (i.hint ?? '') + ' ' + i.group)
})

const grouped = computed(() => {
  const map = new Map<string, { item: Item; positions: number[] }[]>()
  for (const r of results.value) {
    const arr = map.get(r.item.group) ?? []
    arr.push({ item: r.item, positions: r.positions })
    map.set(r.item.group, arr)
  }
  return [...map.entries()].map(([group, items]) => ({ group, items }))
})

const flat = computed(() => results.value.map((r) => r.item))

watch(results, () => {
  cursor.value = 0
})

/** File list and full-text search are fetched lazily, only in their mode. */
watch([mode, () => activeWorkspace.value?.id], async () => {
  if (mode.value === 'file' && activeWorkspace.value) {
    const r = await client
      .call('fs.tracked', { workspaceId: activeWorkspace.value.id })
      .catch(() => [] as string[])
    trackedFiles.value = r
  }
})

let searchTimer: number | null = null
watch([mode, term], () => {
  if (mode.value !== 'text' || term.value.length < 2) {
    searchHits.value = []
    return
  }
  if (searchTimer) window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(async () => {
    searching.value = true
    // §12 — every repo of the project at once, which is the point.
    const ids = state.workspaces
      .filter((w) => w.projectId === state.activeProjectId && w.kind !== 'group')
      .map((w) => w.id)
    const r = await client.call('search.text', { workspaceIds: ids, query: term.value, max: 80 }).catch(() => null)
    searchHits.value = r?.hits ?? []
    searching.value = false
  }, 180)
})

function move(delta: number) {
  const n = flat.value.length
  if (!n) return
  cursor.value = (cursor.value + delta + n) % n
  void nextTick(() => {
    document.querySelector('.pal .row.on')?.scrollIntoView({ block: 'nearest' })
  })
}

function choose() {
  const item = flat.value[cursor.value]
  if (item) void item.run()
}

function indexOfItem(item: Item): number {
  return flat.value.indexOf(item)
}

onMounted(() => {
  void nextTick(() => input.value?.focus())
})
</script>

<template>
  <div class="scrim" @mousedown.self="close">
    <div class="pal" role="dialog" aria-label="Command palette">
      <div class="inputrow">
        <component :is="leadIcon" class="lead lg" />
        <input
          ref="input"
          v-model="query"
          class="q"
          spellcheck="false"
          placeholder="Jump to a repository or branch, or type &gt; for commands, / for files, # to search"
          @keydown.down.prevent="move(1)"
          @keydown.up.prevent="move(-1)"
          @keydown.enter.prevent="choose"
        />
        <span v-if="searching" class="chip"><RefreshCw class="spin" />searching</span>
      </div>

      <div class="list">
        <template v-for="g in grouped" :key="g.group">
          <div class="glabel section-label">{{ g.group }}</div>
          <button
            v-for="entry in g.items"
            :key="entry.item.id"
            class="row"
            :class="{ on: indexOfItem(entry.item) === cursor }"
            @mousemove="cursor = indexOfItem(entry.item)"
            @click="entry.item.run()"
          >
            <span class="icon"><component :is="entry.item.icon" class="sm" /></span>
            <span class="lbl">
              <span
                v-for="(part, i) in highlight(entry.item.label, entry.positions)"
                :key="i"
                :class="{ hit: part.hit }"
                >{{ part.text }}</span
              >
            </span>
            <span v-if="entry.item.hint" class="hint">{{ entry.item.hint }}</span>
            <CornerDownLeft v-if="indexOfItem(entry.item) === cursor" class="ret sm" />
          </button>
        </template>

        <div v-if="!flat.length" class="none">
          {{ mode === 'text' && term.length < 2 ? 'Type at least two characters.' : 'No match.' }}
        </div>
      </div>

      <footer class="pfoot">
        <span><span class="kbd">↑</span><span class="kbd">↓</span> navigate</span>
        <span><span class="kbd">⏎</span> run</span>
        <span><span class="kbd">esc</span> close</span>
        <span class="grow" />
        <span class="dimhint">&gt; commands · / files · # search every repository</span>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 12vh;
  background: var(--scrim);
  backdrop-filter: blur(6px) saturate(1.1);
  animation: fade var(--dur-2) var(--ease-soft);
}
@keyframes fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

.pal {
  width: min(720px, 92vw);
  max-height: 68vh;
  display: flex;
  flex-direction: column;
  background: var(--overlay);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg), var(--inset-top);
  overflow: hidden;
  animation: rise var(--dur-3) var(--ease);
}
@keyframes rise {
  from { opacity: 0; transform: translateY(-10px) scale(0.985); }
  to { opacity: 1; transform: none; }
}

.inputrow {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 18px;
  height: 56px;
  border-bottom: 1px solid var(--line);
}
.lead { color: var(--text-dim); }
.q {
  flex: 1;
  min-width: 0;
  background: none;
  border: none;
  color: var(--text);
  font: inherit;
  font-size: var(--fs-lg);
  letter-spacing: -0.01em;
}
.q::placeholder { color: var(--text-dim); }
/* The palette input is the whole row; a ring around it would box in nothing. */
.q:focus-visible { outline: none; }

.list { flex: 1; overflow-y: auto; padding: 8px; }
.glabel { padding: 10px 12px 5px; }

.row {
  display: flex;
  align-items: center;
  gap: 11px;
  width: 100%;
  height: 38px;
  padding: 0 12px;
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--text-muted);
  transition: background var(--dur-1) var(--ease-soft), color var(--dur-1) var(--ease-soft);
}
.row.on { background: var(--selected); color: var(--text); }
.icon {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  background: var(--hover);
  color: var(--text-dim);
  transition: background var(--dur-1) var(--ease-soft), color var(--dur-1) var(--ease-soft);
}
.row.on .icon { background: var(--accent-soft); color: var(--accent); }
.lbl {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-md);
}
.lbl .hit { color: var(--accent); font-weight: 620; }
.hint {
  flex: none;
  max-width: 42%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.ret { color: var(--text-dim); opacity: 0.7; }

.none { padding: 28px; text-align: center; color: var(--text-dim); font-size: var(--fs-sm); }

.pfoot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 16px;
  height: 38px;
  padding: 0 16px;
  border-top: 1px solid var(--line);
  background: var(--bg-sunken);
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.pfoot > span { display: inline-flex; align-items: center; gap: 5px; }
.pfoot .grow { flex: 1; }
.dimhint { opacity: 0.85; }
.chip .spin { width: 12px; height: 12px; }
</style>
