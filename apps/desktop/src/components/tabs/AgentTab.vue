<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { AgentScope, AgentScopePreview, AgentSession, Workspace } from '@cockpit/shared'
import {
  BookMarked, CircleStop, CornerDownLeft, FolderTree, GitBranch, Layers, Lock, RotateCcw,
  ShieldCheck, Sparkles, SquareStack, Wrench, X,
} from '@lucide/vue'
import MemoryTab from './MemoryTab.vue'
import {
  activeAgentScope, agentScopeOptions, client, guard, previewScope, resumeSession,
  scopeKey, sameScope, sessionsForScope, startAgentIn, state,
} from '../../core/store.js'

/**
 * §7 — a session is a scope + an engine + a lease. This surface is those three
 * in that order: what it is for, what will run it, what to ask.
 *
 * What it replaces: a checkbox list of every workspace in the project, where
 * "an agent on this feature" and "an agent on this repo" were the same control
 * with different boxes ticked. Nothing downstream could tell them apart, the
 * protected-branch refusal arrived only after the prompt had been written, and
 * resuming overwrote the question the conversation had opened with.
 *
 * §6 — the conversation is the durable half. A session is a thread of turns;
 * the composer either opens one or adds to the one selected, and it never
 * silently becomes the other.
 */

const props = defineProps<{ workspace: Workspace }>()

const engines = ref<{ id: string; available: boolean; bin: string }[]>([])
const engine = ref('claude')
const busy = ref(false)

/* ── scope ─────────────────────────────────────────────────────────────── */

const scope = computed(() => activeAgentScope.value)
const preview = ref<AgentScopePreview | null>(null)

/** §7's fourth row: the same checkout, smaller blast radius. */
const folderOpen = ref(false)
const folder = ref('')

function pick(s: AgentScope): void {
  state.agentScope = s
  folderOpen.value = false
}

function applyFolder(): void {
  const w = scope.value
  const sub = folder.value.trim().replace(/^\/+|\/+$/g, '')
  // Which checkout the folder is under: the one selected, or the one this tab
  // is looking at — a project or feature scope has no single path to narrow.
  const workspaceId =
    w && (w.kind === 'workspace' || w.kind === 'folder') ? w.workspaceId : state.activeWorkspaceId
  if (!sub || !workspaceId) return
  state.agentScope = { kind: 'folder', workspaceId, subpath: sub }
  folderOpen.value = false
}

watch(
  scope,
  async (s) => {
    preview.value = null
    if (s) preview.value = await previewScope(s)
  },
  { immediate: true },
)

/** §4 — allowed, and the reason a restore point is captured before any write. */
const onMain = computed(() => preview.value?.paths.filter((p) => p.onProtectedBranch) ?? [])
const blocked = computed(() => preview.value?.blocked ?? [])

/* ── conversations (§6) ────────────────────────────────────────────────── */

const conversations = computed(() =>
  [...sessionsForScope(scope.value)].sort((a, b) => b.startedAt - a.startedAt),
)

/** Null means the composer opens a new thread rather than continuing one. */
const selectedId = ref<string | null>(null)
const selected = computed(() => conversations.value.find((c) => c.id === selectedId.value) ?? null)

// A thread that belongs to another scope must not stay selected under this one.
watch(scope, () => {
  selectedId.value = null
})
watch(conversations, (list) => {
  if (selectedId.value && !list.some((c) => c.id === selectedId.value)) selectedId.value = null
})

const isLive = (s: AgentSession) => s.status !== 'ended' && s.status !== 'failed'

/** §3.3 — the transcript is the journal filtered, never a second copy of it. */
const transcript = computed(() => {
  const id = selectedId.value
  if (!id) return []
  return state.events
    .filter(
      (e) =>
        e.actor.kind === 'agent' &&
        e.actor.sessionId === id &&
        (e.type === 'agent.output' || e.type === 'agent.tool_use'),
    )
    .slice(-300)
})

const totalCost = computed(() => conversations.value.reduce((n, s) => n + s.costUsd, 0))

/* ── the composer ──────────────────────────────────────────────────────── */

/**
 * One control, two acts, never ambiguous: with a thread selected it adds a
 * turn to that conversation, and with none it opens one. The label says which.
 */
const continuing = computed(() => !!selected.value && selected.value!.resumable)
const canSend = computed(() => {
  if (!state.agentDraft.trim() || busy.value) return false
  if (selected.value && isLive(selected.value)) return false
  if (blocked.value.length) return false
  return continuing.value || !!scope.value
})

async function send(): Promise<void> {
  const text = state.agentDraft.trim()
  if (!text || !canSend.value) return
  busy.value = true
  if (continuing.value && selected.value) {
    const ok = await resumeSession(selected.value.id, text)
    if (ok) state.agentDraft = ''
  } else if (scope.value) {
    await startAgentIn(engine.value, scope.value, text)
  }
  busy.value = false
}

async function stop(id: string): Promise<void> {
  await guard(() => client.call('agent.stop', { sessionId: id }), 'session stopped')
}

onMounted(async () => {
  const r = await guard(() => client.call('agent.engines', undefined))
  engines.value = r ?? []
  const firstAvailable = engines.value.find((e) => e.available)
  if (firstAvailable) engine.value = firstAvailable.id
})

/* ── presentation ──────────────────────────────────────────────────────── */

function payloadText(p: unknown): string {
  const o = p as { text?: string; tool?: string; paths?: string[] }
  if (o?.text) return o.text
  if (o?.tool) return o.tool + (o.paths?.length ? ' → ' + o.paths.join(', ') : '')
  return JSON.stringify(p).slice(0, 200)
}

function ago(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return m + 'm ago'
  const h = Math.floor(m / 60)
  return h < 24 ? h + 'h ago' : Math.floor(h / 24) + 'd ago'
}

function dotClass(s: AgentSession): string {
  if (s.status === 'ended') return 'down'
  if (s.status === 'failed') return 'unhealthy'
  if (s.status === 'starting') return 'starting'
  return 'up'
}

const SCOPE_ICON = { project: SquareStack, feature: Layers, workspace: GitBranch, folder: FolderTree }
</script>

<template>
  <div class="agent">
    <!-- 1. What this is for. §7's scope table, as three presets and a folder. -->
    <header class="scopebar">
      <div class="picker">
        <button
          v-for="o in agentScopeOptions"
          :key="o.key"
          class="sc"
          :class="{ on: sameScope(o.scope, scope) }"
          :title="o.detail"
          @click="pick(o.scope)"
        >
          <component :is="SCOPE_ICON[o.scope.kind]" class="sm" />
          <span class="l">{{ o.label }}</span>
        </button>

        <button
          class="sc"
          :class="{ on: scope?.kind === 'folder' }"
          title="Narrow the run to one folder of this checkout"
          @click="folderOpen = !folderOpen"
        >
          <FolderTree class="sm" />
          <span class="l">Folder</span>
        </button>

        <span class="grow" />
        <span v-if="totalCost" class="cost num">${{ totalCost.toFixed(2) }} here</span>
        <!-- §6 — the memory is the agent's own instrument, not a sibling tab:
             it is what gets prepended to the prompt, so it belongs to the
             thing that sends it. -->
        <button
          class="sc mem"
          :class="{ on: state.memoryOpen }"
          title="The durable memory this run reads (§6)"
          @click="state.memoryOpen = !state.memoryOpen"
        >
          <BookMarked class="sm" />
          <span class="l">Memory</span>
          <span v-if="workspace.hasMemory" class="pip" />
        </button>
      </div>

      <div v-if="folderOpen" class="folder">
        <input
          v-model="folder"
          class="input"
          placeholder="packages/core — a path inside this checkout"
          @keydown.enter="applyFolder"
        />
        <button class="btn" :disabled="!folder.trim()" @click="applyFolder">Narrow</button>
      </div>

      <!-- 2. What that resolves to, before it is asked to do anything. -->
      <div v-if="preview" class="resolved">
        <span
          v-for="p in preview.paths"
          :key="p.workspaceId + p.path"
          class="rp"
          :class="{ main: p.onProtectedBranch, held: p.leasedBy }"
          :title="p.path"
        >
          <Lock v-if="p.leasedBy" class="sm" />
          <span class="n">{{ p.name }}</span>
          <span v-if="p.branch" class="b mono">{{ p.branch }}</span>
          <span v-else class="b">no repo</span>
        </span>
        <span v-if="preview.preamble.memory" class="chip agent" title="§6 — prepended to the prompt">
          feature memory
        </span>
        <span v-if="preview.preamble.context" class="chip agent" title="§7 — the cross-repo map">
          CONTEXT.md
        </span>
      </div>

      <p v-if="blocked.length" class="note danger">
        <Lock class="sm" /> {{ blocked.join(' · ') }}. §7 refuses two agents on one subtree —
        stop that session, or narrow this one.
      </p>
      <p v-else-if="onMain.length" class="note">
        <ShieldCheck class="sm" />
        {{ onMain.map((p) => p.name).join(', ') }}
        {{ onMain.length > 1 ? 'are' : 'is' }} on the main branch. A restore point is captured
        before the first write, and undo goes back to it.
      </p>
    </header>

    <div class="body">
      <!-- §6 — over the conversation rather than beside it: it is read while
           writing the prompt, and closing it puts the thread straight back. -->
      <section v-if="state.memoryOpen" class="memory">
        <header class="mhead">
          <BookMarked class="sm" />
          <span class="ttl">Memory</span>
          <span class="grow" />
          <button class="icon-btn" title="Back to the conversation (Esc)" @click="state.memoryOpen = false">
            <X class="sm" />
          </button>
        </header>
        <div class="mbody"><MemoryTab :workspace="props.workspace" /></div>
      </section>

      <!-- 3. The conversation. -->
      <section v-else class="stream">
        <div v-if="!selected" class="empty">
          <Sparkles />
          <strong>{{ conversations.length ? 'Pick a conversation' : 'Nothing run here yet' }}</strong>
          <span>
            A session is a set of paths, not a feature — the scope above decides which, and the
            same prompt works on a worktree, a whole project, or a folder with no repo at all.
          </span>
        </div>
        <template v-else>
          <div class="thead">
            <span class="dot" :class="dotClass(selected)" />
            <span class="ttl">{{ selected.title || 'untitled' }}</span>
            <span class="grow" />
            <span class="meta num">${{ selected.costUsd.toFixed(2) }}</span>
            <button
              v-if="isLive(selected)"
              class="icon-btn"
              title="Stop this session"
              @click="stop(selected.id)"
            >
              <CircleStop class="sm" />
            </button>
            <button class="icon-btn" title="Back to the list" @click="selectedId = null">
              <X class="sm" />
            </button>
          </div>

          <!-- §6 — every turn, in order. A resume adds one; it replaces nothing. -->
          <ol class="turns">
            <li v-for="t in selected.history" :key="t.id" class="turn">
              <span class="seq num">{{ t.seq }}</span>
              <span class="ask selectable">{{ t.prompt }}</span>
              <span class="tmeta">
                <span v-if="t.costUsd" class="num">${{ t.costUsd.toFixed(2) }}</span>
                <span :class="t.status">{{ t.status }}</span>
              </span>
            </li>
          </ol>

          <div v-if="!transcript.length" class="none">
            No output in the journal for this session — the tail only reaches so far back.
          </div>
          <div v-else class="lines">
            <div v-for="e in transcript" :key="e.id" class="ln">
              <span class="badge" :class="e.type === 'agent.tool_use' ? 'tool' : 'text'">
                <component :is="e.type === 'agent.tool_use' ? Wrench : Sparkles" class="sm" />
              </span>
              <span class="txt selectable" :class="{ tool: e.type === 'agent.tool_use' }">
                {{ payloadText(e.payload) }}
              </span>
            </div>
          </div>
        </template>
      </section>

      <aside v-if="!state.memoryOpen" class="side">
        <div class="sidehead">
          <span class="section-label">conversations</span>
          <button
            class="btn ghost new"
            :class="{ on: !selectedId }"
            title="Open a new thread on this scope"
            @click="selectedId = null"
          >
            New
          </button>
        </div>

        <p v-if="!conversations.length" class="none">
          None on this scope. What you ask below opens the first.
        </p>

        <button
          v-for="c in conversations"
          :key="c.id"
          class="conv"
          :class="{ on: selectedId === c.id }"
          @click="selectedId = c.id"
        >
          <span class="crow">
            <span class="dot" :class="dotClass(c)" />
            <span class="ceng">{{ c.engine }}</span>
            <span class="grow" />
            <span class="cwhen">{{ ago(c.startedAt) }}</span>
          </span>
          <span class="ctitle">{{ c.title || 'untitled' }}</span>
          <span class="crow bot">
            <span class="cturns num">{{ c.history.length }} turn{{ c.history.length === 1 ? '' : 's' }}</span>
            <span class="grow" />
            <span class="ccost num">${{ c.costUsd.toFixed(2) }}</span>
            <RotateCcw v-if="c.resumable" class="sm rz" title="Can be picked back up" />
          </span>
        </button>
      </aside>
    </div>

    <!-- 4. The one control. It opens a thread, or adds to the one selected. -->
    <footer class="composer">
      <div class="engines" :class="{ dim: continuing }">
        <button
          v-for="e in engines"
          :key="e.id"
          class="eng"
          :class="{ on: engine === e.id, off: !e.available }"
          :disabled="!e.available || continuing"
          :title="continuing ? 'A resumed conversation stays on its own engine' : e.available ? e.bin : e.id + ' is not on PATH'"
          @click="engine = e.id"
        >
          {{ continuing && selected ? (e.id === selected.engine ? e.id : '') : e.id }}
        </button>
      </div>

      <textarea
        v-model="state.agentDraft"
        class="input prompt selectable"
        rows="2"
        :placeholder="
          continuing
            ? 'Next turn — the memory is re-read on the way in'
            : scope
              ? 'What should it do on ' + (preview?.label ?? 'this scope') + '?'
              : 'Pick a scope first'
        "
        @keydown.meta.enter="send"
      />

      <button class="btn primary send" :disabled="!canSend" @click="send">
        <CornerDownLeft class="sm" />
        {{ continuing ? 'Continue' : 'Start' }}
        <span class="kbd">⌘⏎</span>
      </button>

      <p class="guard">Never pushes · diff reviewed before any commit · restore point first</p>
    </footer>
  </div>
</template>

<style scoped>
.agent {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* ── 1 + 2: scope, and what it resolves to ───────────────────────────── */
.scopebar {
  flex: none;
  padding: 12px 18px 11px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-sunken);
}
.picker { display: flex; align-items: center; gap: 4px; }
.grow { flex: 1; }
.sc {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 11px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--bg);
  font-size: var(--fs-xs);
  font-weight: 500;
  color: var(--text-muted);
  transition: color var(--dur-1) var(--ease-soft), border-color var(--dur-1) var(--ease-soft);
}
.sc:hover { color: var(--text); border-color: var(--line-strong); }
.sc.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.cost { font-size: var(--fs-xs); color: var(--text-dim); }

.folder { display: flex; gap: 6px; margin-top: 8px; }
.folder .input { height: 28px; font-size: var(--fs-xs); }

/* The resolved paths are the honest answer to "what will this touch", and it
   is worth the row: §7's whole safety argument is that the scope is explicit. */
.resolved { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin-top: 9px; }
.rp {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  background: var(--hover);
  font-size: 11px;
}
.rp .n { color: var(--text); font-weight: 500; }
.rp .b { color: var(--text-dim); font-size: 10px; }
.rp.main { background: var(--warn-soft); }
.rp.main .n, .rp.main .b { color: var(--warn); }
.rp.held { background: var(--danger-soft); }
.rp.held .n, .rp.held .b { color: var(--danger); }

.note {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin: 9px 0 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-dim);
}
.note .lucide { flex: none; margin-top: 1px; }
.note.danger { color: var(--danger); }

/* ── 3: the conversation ─────────────────────────────────────────────── */
.body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 300px; }

.stream { min-width: 0; min-height: 0; overflow-y: auto; padding: 16px 22px 24px; }
.thead { display: flex; align-items: center; gap: 9px; margin-bottom: 14px; }
.ttl {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta { font-size: var(--fs-xs); color: var(--text-dim); }

.turns { list-style: none; margin: 0 0 18px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.turn {
  display: flex;
  align-items: baseline;
  gap: 9px;
  padding: 8px 11px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--panel);
}
.seq {
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  background: var(--hover);
  color: var(--text-dim);
  font-size: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.turn .ask { flex: 1; min-width: 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.5; }
.tmeta { flex: none; display: flex; gap: 8px; font-size: 10px; color: var(--text-dim); }
.tmeta .running { color: var(--accent); }
.tmeta .failed { color: var(--danger); }

.lines { display: flex; flex-direction: column; gap: 11px; }
.ln { display: flex; gap: 11px; font-size: var(--fs-sm); line-height: 1.6; }
.badge {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 7px;
  background: var(--agent-soft);
  color: var(--agent);
}
.badge .lucide { width: 12px; height: 12px; }
.badge.tool { background: var(--hover); color: var(--text-dim); }
.txt { color: var(--text-muted); white-space: pre-wrap; word-break: break-word; }
.txt.tool { color: var(--text-dim); font-family: var(--mono); font-size: var(--fs-xs); }
.none { margin: 0; color: var(--text-dim); font-size: var(--fs-xs); line-height: 1.5; }

.side {
  border-left: 1px solid var(--line);
  background: var(--panel);
  overflow-y: auto;
  padding: 14px 12px 20px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sidehead { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px; }
.btn.ghost.new { height: 24px; padding: 0 9px; font-size: 11px; }
.btn.ghost.new.on { border-color: var(--accent); color: var(--accent); }

.conv {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  padding: 9px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  text-align: left;
  transition: background var(--dur-1) var(--ease-soft);
}
.conv:hover { background: var(--hover); }
.conv.on { background: var(--selected); border-color: var(--accent-soft); }
.crow { display: flex; align-items: center; gap: 6px; font-size: 10px; color: var(--text-dim); }
.ceng { font-weight: 600; color: var(--text); font-size: 11px; }
.ctitle {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.rz { color: var(--text-dim); }

/* ── the memory, as the agent's instrument ───────────────────────────── */
.sc.mem { margin-left: 8px; }
.sc.mem .pip {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--agent);
}
.memory { grid-column: 1 / -1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.mhead {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 12px 0 20px;
  border-bottom: 1px solid var(--line);
}
.mhead .ttl { font-size: var(--fs-sm); font-weight: 600; color: var(--text); }
.mhead .lucide { color: var(--agent); }
.mbody { flex: 1; min-height: 0; overflow: hidden; }

/* ── 4: the composer ─────────────────────────────────────────────────── */
.composer {
  flex: none;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  grid-template-rows: auto auto;
  gap: 8px 10px;
  align-items: start;
  padding: 12px 18px 13px;
  border-top: 1px solid var(--line);
  background: var(--bg-sunken);
}
.engines { display: flex; gap: 4px; padding-top: 3px; }
.engines.dim { opacity: 0.5; }
.eng {
  height: 28px;
  padding: 0 11px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  font-size: var(--fs-xs);
  color: var(--text-muted);
  background: var(--bg);
}
.eng.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.eng.off { opacity: 0.35; }
.eng:empty { display: none; }

.prompt { resize: vertical; min-height: 52px; }
.send { align-self: stretch; }
.guard {
  grid-column: 1 / -1;
  margin: 0;
  font-size: 10px;
  color: var(--text-dim);
}
</style>
