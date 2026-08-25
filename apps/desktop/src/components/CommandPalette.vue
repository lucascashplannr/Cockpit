<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { fuzzyFilter, highlight } from '../core/fuzzy.js'
import {
  activeWorkspace, client, guard, requestPlan, selectWorkspace, state, toast,
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
  icon: string
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

  const tab = (id: TabId, label: string) =>
    out.push({
      id: 'tab:' + id,
      label: 'Go to ' + label,
      group: 'View',
      icon: '→',
      run: act(() => {
        state.activeTab = id
      }),
    })

  if (w) {
    tab('code', 'Code')
    if (w.git) tab('diff', 'Diff')
    tab('agent', 'Agent')
    tab('memory', 'Memory')
    tab('journal', 'Journal')
    tab('terminal', 'Terminal')

    out.push({
      id: 'ide',
      label: 'Open in IDE',
      hint: w.name,
      group: 'Open',
      icon: '⌘',
      run: act(() => guard(() => client.call('workspace.openIn', { workspaceId: w.id, target: 'ide' }))),
    })
    out.push({
      id: 'finder',
      label: 'Reveal in Finder',
      group: 'Open',
      icon: '⌘',
      run: act(() => guard(() => client.call('workspace.openIn', { workspaceId: w.id, target: 'finder' }))),
    })

    if (w.runtime) {
      out.push({
        id: 'rt',
        label: w.runtime.status === 'up' ? 'Stop the servers' : 'Start the servers',
        hint: w.runtime.impl,
        group: 'Runtime',
        icon: '⚡',
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
          group: 'Runtime',
          icon: '◈',
          run: act(() => guard(() => client.call('workspace.openIn', { workspaceId: w.id, target: 'browser' }))),
        })
      }
    }

    if (w.git) {
      for (const op of ['rebase', 'merge', 'push', 'sync'] as const) {
        out.push({
          id: 'git:' + op,
          label: op[0]!.toUpperCase() + op.slice(1) + (op === 'rebase' || op === 'merge' ? ' onto the base branch' : ''),
          hint: 'shows a plan first',
          group: 'Git',
          icon: '⌥',
          run: act(() => requestPlan(w.id, op)),
        })
      }
      out.push({
        id: 'git:branch',
        label: 'Create a branch here',
        hint: 'C1',
        group: 'Git',
        icon: '⌥',
        run: act(() => {
          const name = window.prompt('Branch name')
          if (name) void requestPlan(w.id, 'branch', { name })
        }),
      })
      out.push({
        id: 'git:worktree',
        label: 'Create an isolated worktree',
        hint: 'C2 — promotes this work without losing it',
        group: 'Git',
        icon: '⌥',
        run: act(() => {
          const name = window.prompt('Branch name for the worktree')
          if (name) void requestPlan(w.id, 'worktree', { name })
        }),
      })
      out.push({
        id: 'git:undo',
        label: 'Undo the last operation',
        hint: 'restore point',
        group: 'Git',
        icon: '↩',
        run: act(() => guard(() => client.call('git.undo', { workspaceId: w.id }))),
      })
    }

    // §12 — "Agent ici ← C0, deux touches". The cheapest possible path.
    out.push({
      id: 'agent:here',
      label: 'Agent here',
      hint: 'C0 · traced, leased, restore point captured',
      group: 'Agent',
      icon: '◆',
      run: act(() => {
        state.activeTab = 'agent'
      }),
    })
  }

  out.push({
    id: 'rescan',
    label: 'Re-probe everything',
    group: 'Core',
    icon: '⟳',
    run: act(() => guard(() => client.call('core.reconcile', {}), 'rescanned')),
  })
  out.push({
    id: 'addproj',
    label: 'Add a project…',
    group: 'Core',
    icon: '＋',
    run: act(async () => {
      const root = window.prompt('Path of the project folder')
      if (root) await guard(() => client.call('project.add', { root }), 'project added')
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
      group: 'Workspaces',
      icon: w.kind === 'worktree' ? '⑂' : '▪',
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
    icon: '·',
    run: act(() => {
      state.activeTab = 'code'
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
    icon: '⌕',
    run: act(() => {
      selectWorkspace(h.workspaceId)
      state.activeTab = 'code'
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
        <span class="lead">{{ mode === 'file' ? '/' : mode === 'text' ? '#' : mode === 'command' ? '>' : '⌕' }}</span>
        <input
          ref="input"
          v-model="query"
          class="q"
          spellcheck="false"
          placeholder="Jump to a workspace, or type > for commands, / for files, # to search"
          @keydown.down.prevent="move(1)"
          @keydown.up.prevent="move(-1)"
          @keydown.enter.prevent="choose"
        />
        <span v-if="searching" class="chip">searching…</span>
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
            <span class="icon">{{ entry.item.icon }}</span>
            <span class="lbl">
              <span
                v-for="(part, i) in highlight(entry.item.label, entry.positions)"
                :key="i"
                :class="{ hit: part.hit }"
                >{{ part.text }}</span
              >
            </span>
            <span v-if="entry.item.hint" class="hint">{{ entry.item.hint }}</span>
          </button>
        </template>

        <div v-if="!flat.length" class="none">
          {{ mode === 'text' && term.length < 2 ? 'Type at least two characters.' : 'No match.' }}
        </div>
      </div>

      <footer class="pfoot">
        <span><span class="kbd">↑↓</span> navigate</span>
        <span><span class="kbd">⏎</span> run</span>
        <span><span class="kbd">esc</span> close</span>
        <span class="grow" />
        <span class="dimhint">&gt; commands · / files · # search all repos</span>
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
  background: rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(3px);
}

.pal {
  width: min(660px, 92vw);
  max-height: 68vh;
  display: flex;
  flex-direction: column;
  background: var(--overlay);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-overlay);
  overflow: hidden;
  animation: rise 120ms cubic-bezier(0.2, 0.8, 0.3, 1);
}
@keyframes rise {
  from { opacity: 0; transform: translateY(-6px) scale(0.99); }
  to { opacity: 1; transform: none; }
}

.inputrow {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  height: 48px;
  border-bottom: 1px solid var(--line);
}
.lead { color: var(--text-dim); font-size: 15px; width: 12px; text-align: center; }
.q {
  flex: 1;
  background: none;
  border: none;
  color: var(--text);
  font: inherit;
  font-size: var(--fs-lg);
}
.q::placeholder { color: var(--text-dim); }

.list { flex: 1; overflow-y: auto; padding: 6px; }
.glabel { padding: 8px 10px 4px; }

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--text-muted);
}
.row.on { background: var(--selected); color: var(--text); }
.icon { flex: none; width: 14px; text-align: center; color: var(--text-dim); font-size: 11px; }
.row.on .icon { color: var(--accent); }
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
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-xs);
  color: var(--text-dim);
}

.none { padding: 22px; text-align: center; color: var(--text-dim); font-size: var(--fs-sm); }

.pfoot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 14px;
  height: 32px;
  padding: 0 14px;
  border-top: 1px solid var(--line);
  background: var(--bg-sunken);
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.pfoot .grow { flex: 1; }
.dimhint { opacity: 0.8; }
</style>
