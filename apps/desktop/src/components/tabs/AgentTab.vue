<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { AgentScopePreview, Conversation, AgentTurn, CockpitEvent, Workspace } from '@cockpit/shared'
import {
  BookMarked, CircleAlert, CircleStop, CornerDownLeft, Hand, History, Lock, RotateCcw,
  ShieldCheck, Sparkles, Wrench, X,
} from '@lucide/vue'
import MemoryTab from './MemoryTab.vue'
import {
  activeAgentScope, attentionOf, client, closeThread, guard, isRunning, markThreadRead,
  openThreadFor, pinThread, previewScope, resumeSession, scopeLabel, sessionsForScope,
  startAgentIn, state,
} from '../../core/store.js'
import type { Attention } from '../../core/store.js'

/**
 * Layer 2 — the agent, and nothing else.
 *
 * It used to open with a row of scope buttons: Project / Topic / This repo /
 * Folder. That was navigating twice — once to the workspace in the list, then
 * again inside the agent to say what you meant. A conversation is opened
 * *on* something now (a topic row, a workspace row, the project), and this
 * surface only says what it is on.
 *
 * The conversation list and the memory are both instruments of the agent rather
 * than neighbours of it: they open over it and close back to it.
 */

const props = defineProps<{ workspace: Workspace }>()

const engines = ref<{ id: string; available: boolean; bin: string }[]>([])
const engine = ref('claude')
const busy = ref(false)
const scrollEl = ref<HTMLElement | null>(null)

const scope = computed(() => activeAgentScope.value)
const label = computed(() => scopeLabel(scope.value))
const preview = ref<AgentScopePreview | null>(null)

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
const paths = computed(() => preview.value?.paths ?? [])

/* ── conversations (§6) ────────────────────────────────────────────────── */

const conversations = computed(() =>
  [...sessionsForScope(scope.value)].sort((a, b) => b.startedAt - a.startedAt),
)

/**
 * Which thread is open is the scope's business, not this component's: it used
 * to be a local ref, so walking over to another project and back reset the
 * panel to its empty composer while the work was still running. It lives in
 * the store now, and it is remembered.
 */
const selected = computed(() => openThreadFor(scope.value))

function open(c: Conversation): void {
  if (scope.value) pinThread(scope.value, c.id)
  state.historyOpen = false
}

function close(c: Conversation): void {
  if (scope.value) closeThread(scope.value, c.id)
}

/**
 * Having a finished thread on screen is having read it — that is what clears
 * the "waiting for you" marks in the rail and the list.
 *
 * On screen, and not merely mounted: the panel is built under the start page,
 * which covers the whole window, so without the `homeOpen` guard a launch
 * would quietly mark the last thread read over a page nobody can see through.
 * The same guard is why the start page is in the dependency list: leaving it
 * is the moment the thread actually becomes visible.
 */
watch(
  () => [selected.value?.id, selected.value?.status, selected.value?.endedAt, state.homeOpen],
  () => {
    const c = selected.value
    if (c && !state.homeOpen) markThreadRead(c)
  },
  { immediate: true },
)

const waiting = computed(() =>
  conversations.value.filter((c) => attentionOf(c) !== 'none').length,
)

const ATTENTION_TEXT: Record<Attention, string> = {
  none: '',
  reply: 'answered — waiting for you',
  blocked: 'stopped: it was refused a tool it needed',
  failed: 'the engine failed',
}

/**
 * §3.3 — the transcript is the journal filtered, never a second copy. Split by
 * turn so the thread reads as the exchange it was: each question, then what
 * the engine did before the next one.
 */
interface Exchange {
  turn: AgentTurn
  events: CockpitEvent[]
}

const exchanges = computed<Exchange[]>(() => {
  const s = selected.value
  if (!s) return []
  const mine = state.events.filter(
    (e) =>
      e.actor.kind === 'agent' &&
      e.actor.sessionId === s.id &&
      (e.type === 'agent.output' || e.type === 'agent.tool_use'),
  )
  return s.history.map((turn, i) => {
    const next = s.history[i + 1]
    return {
      turn,
      events: mine.filter((e) => e.ts >= turn.startedAt && (!next || e.ts < next.startedAt)),
    }
  })
})

/* ── the composer ──────────────────────────────────────────────────────── */

/** With a thread open it adds a turn; with none it opens one. The label says. */
const continuing = computed(() => !!selected.value?.resumable)
const canSend = computed(() => {
  if (!state.agentDraft.trim() || busy.value) return false
  if (selected.value && isRunning(selected.value)) return false
  if (blocked.value.length) return false
  return continuing.value || !!scope.value
})

async function send(): Promise<void> {
  if (!canSend.value) return
  const text = state.agentDraft.trim()
  busy.value = true
  if (continuing.value && selected.value) {
    const ok = await resumeSession(selected.value.id, text)
    if (ok) state.agentDraft = ''
  } else if (scope.value) {
    // `startAgentIn` opens the new thread on this scope; nothing to do here.
    await startAgentIn(engine.value, scope.value, text)
  }
  busy.value = false
}

async function stop(id: string): Promise<void> {
  await guard(() => client.call('agent.stop', { sessionId: id }), 'conversation stopped')
}

// New output should not have to be scrolled to.
watch(
  exchanges,
  async () => {
    await nextTick()
    const el = scrollEl.value
    if (el) el.scrollTop = el.scrollHeight
  },
  { deep: true },
)

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

function dotClass(s: Conversation): string {
  if (isRunning(s)) return 'working'
  if (s.status === 'failed') return 'unhealthy'
  return 'down'
}
</script>

<template>
  <div class="agent">
    <!-- One line of chrome: what this conversation is on, and its two
         instruments. -->
    <header class="chrome">
      <span class="scope" :title="paths.map((p) => p.path).join('\n')">
        <span class="k">{{ label.kind }}</span>
        <span class="n">{{ label.name }}</span>
      </span>
      <span v-if="paths.length > 1" class="spread">{{ paths.length }} repositories</span>

      <span class="grow" />

      <button
        class="chip-btn"
        :class="{ on: state.historyOpen, waiting: waiting > 0 }"
        title="Earlier conversations here"
        @click="state.historyOpen = !state.historyOpen"
      >
        <History class="sm" />
        <span v-if="conversations.length" class="num">{{ conversations.length }}</span>
        <span v-if="waiting" class="pip warn" />
      </button>
      <!-- §6 — the memory is what gets prepended to the prompt, so it belongs
           to the thing that sends it rather than beside it as a peer. -->
      <button
        class="chip-btn"
        :class="{ on: state.memoryOpen }"
        title="The durable memory this conversation reads on the way in"
        @click="state.memoryOpen = !state.memoryOpen"
      >
        <BookMarked class="sm" />
        <span v-if="workspace.hasMemory" class="pip" />
      </button>
    </header>

    <p v-if="blocked.length" class="note danger">
      <Lock class="sm" /> {{ blocked.join(' · ') }} — locked; two agents never share a folder.
    </p>
    <p v-else-if="onMain.length" class="note">
      <ShieldCheck class="sm" />
      {{ onMain.map((p) => p.name).join(', ') }} on the default branch — a restore point is
      captured before the first write.
    </p>

    <!-- §6 — over the conversation, never beside it: it is read while writing. -->
    <section v-if="state.memoryOpen" class="over">
      <header class="ohead">
        <BookMarked class="sm mk" />
        <span class="ttl">Memory</span>
        <span class="grow" />
        <button class="icon-btn" title="Back to the conversation (Esc)" @click="state.memoryOpen = false">
          <X class="sm" />
        </button>
      </header>
      <div class="obody"><MemoryTab :workspace="props.workspace" /></div>
    </section>

    <!-- Every conversation here. Also over the conversation: it is a way back
         into one, not a column to keep open. -->
    <section v-else-if="state.historyOpen" class="over">
      <header class="ohead">
        <History class="sm mk" />
        <span class="ttl">Conversations</span>
        <span class="grow" />
        <button class="icon-btn" title="Close (Esc)" @click="state.historyOpen = false">
          <X class="sm" />
        </button>
      </header>
      <div class="obody convos">
        <p v-if="!conversations.length" class="none">
          Nothing has run here yet.
        </p>
        <button
          v-for="c in conversations"
          :key="c.id"
          class="conv"
          :class="{ on: selected?.id === c.id }"
          @click="open(c)"
        >
          <span class="crow">
            <span class="dot" :class="dotClass(c)" />
            <span class="ceng">{{ c.engine }}</span>
            <span class="cturns">{{ c.history.length }} turn{{ c.history.length === 1 ? '' : 's' }}</span>
            <span
              v-if="attentionOf(c) !== 'none'"
              class="needs"
              :class="attentionOf(c)"
              :title="ATTENTION_TEXT[attentionOf(c)]"
            >
              <component :is="attentionOf(c) === 'reply' ? Hand : CircleAlert" class="sm" />
            </span>
            <span class="grow" />
            <span class="cwhen">{{ ago(c.startedAt) }}</span>
          </span>
          <span class="ctitle">{{ c.title || 'untitled' }}</span>
        </button>
      </div>
    </section>

    <!-- The conversation. Nothing yet: the composer is the page, the way a new one is
         a question and a box under it. -->
    <div v-else-if="!selected" class="hero">
      <div class="heroinner">
        <h1 class="ask">
          <Sparkles class="mk" />
          What should
          <span class="target">{{ label.name }}</span>
          do?
        </h1>

        <div class="composer big">
          <textarea
            v-model="state.agentDraft"
            class="input prompt selectable"
            rows="3"
            placeholder="Describe the change. ⌘⏎ to start."
            @keydown.meta.enter="send"
          />
          <div class="crow2">
            <div class="engines">
              <button
                v-for="e in engines"
                :key="e.id"
                class="eng"
                :class="{ on: engine === e.id, off: !e.available }"
                :disabled="!e.available"
                :title="e.available ? e.bin : e.id + ' is not on PATH'"
                @click="engine = e.id"
              >
                {{ e.id }}
              </button>
            </div>
            <span class="grow" />
            <button
              v-if="conversations.length"
              class="btn ghost"
              @click="state.historyOpen = true"
            >
              <History class="sm" /> {{ conversations.length }} earlier
            </button>
            <button class="btn primary" :disabled="!canSend" @click="send">
              <CornerDownLeft class="sm" /> Start <span class="kbd">⌘⏎</span>
            </button>
          </div>
        </div>

        <p class="guard">Never pushes · diff reviewed before any commit · restore point first</p>
      </div>
    </div>

    <!-- A thread. The exchange, then the box to continue it. -->
    <template v-else>
      <div ref="scrollEl" class="thread">
        <div class="tbar">
          <span class="dot" :class="dotClass(selected)" />
          <span class="ttitle">{{ selected.title || 'untitled' }}</span>
          <!-- Running is the one state worth a word: it is why the panel comes
               back to this thread rather than to an empty composer. -->
          <span v-if="isRunning(selected)" class="live">working</span>
          <span v-else-if="selected.denials.length" class="needs blocked chip warn" :title="'refused: ' + selected.denials.join(', ')">
            <Hand class="sm" /> needs you
          </span>
          <span class="grow" />
          <button
            v-if="isRunning(selected)"
            class="icon-btn"
            title="Stop this conversation"
            @click="stop(selected.id)"
          >
            <CircleStop class="sm" />
          </button>
          <button
            class="icon-btn"
            title="Put this conversation away and start a new one here"
            @click="close(selected)"
          >
            <X class="sm" />
          </button>
        </div>

        <div v-for="x in exchanges" :key="x.turn.id" class="ex">
          <div class="said selectable">{{ x.turn.prompt }}</div>
          <div v-if="x.turn.status === 'running' && !x.events.length" class="thinking">working…</div>
          <div v-for="e in x.events" :key="e.id" class="ln">
            <span class="badge" :class="e.type === 'agent.tool_use' ? 'tool' : 'text'">
              <component :is="e.type === 'agent.tool_use' ? Wrench : Sparkles" class="sm" />
            </span>
            <span class="txt selectable" :class="{ tool: e.type === 'agent.tool_use' }">
              {{ payloadText(e.payload) }}
            </span>
          </div>
        </div>
      </div>

      <footer class="composer foot">
        <textarea
          v-model="state.agentDraft"
          class="input prompt selectable"
          rows="2"
          :placeholder="
            continuing
              ? 'Next turn — the memory is re-read on the way in'
              : 'This conversation cannot be resumed; ⌘⏎ opens a new one'
          "
          @keydown.meta.enter="send"
        />
        <button class="btn primary send" :disabled="!canSend" @click="send">
          <component :is="continuing ? RotateCcw : CornerDownLeft" class="sm" />
          {{ continuing ? 'Continue' : 'Start' }}
          <span class="kbd">⌘⏎</span>
        </button>
      </footer>
    </template>
  </div>
</template>

<style scoped>
.agent { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.grow { flex: 1; }

/* ── one line of chrome ──────────────────────────────────────────────── */
.chrome {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 14px 0 18px;
  border-bottom: 1px solid var(--line);
}
.scope { display: inline-flex; align-items: baseline; gap: 7px; min-width: 0; }
.scope .k {
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.scope .n {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.spread {
  font-size: 10px;
  color: var(--text-dim);
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--hover);
}

.chip-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px;
  border-radius: 999px;
  border: 1px solid var(--line);
  color: var(--text-muted);
  font-size: var(--fs-xs);
  transition: color var(--dur-1) var(--ease-soft), border-color var(--dur-1) var(--ease-soft);
}
.chip-btn:hover { color: var(--text); border-color: var(--line-strong); }
.chip-btn.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.chip-btn.waiting { border-color: var(--warn); color: var(--warn); }
.chip-btn .pip { width: 5px; height: 5px; border-radius: 50%; background: var(--agent); }
.chip-btn .pip.warn { background: var(--warn); }

.note {
  flex: none;
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin: 0;
  padding: 8px 18px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-dim);
  border-bottom: 1px solid var(--line-soft);
}
.note .lucide { flex: none; margin-top: 1px; }
.note.danger { color: var(--danger); background: var(--danger-soft); }

/* ── memory / history, over the conversation ─────────────────────────── */
.over { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.ohead {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 12px 0 18px;
  border-bottom: 1px solid var(--line);
}
.ohead .mk { color: var(--agent); }
.ohead .ttl { font-size: var(--fs-sm); font-weight: 600; color: var(--text); }
.obody { flex: 1; min-height: 0; overflow: hidden; }
.obody.convos { overflow-y: auto; padding: 10px 12px 20px; display: flex; flex-direction: column; gap: 4px; }
.none { margin: 8px 6px; color: var(--text-dim); font-size: var(--fs-xs); }

.conv {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  text-align: left;
}
.conv:hover { background: var(--hover); }
.conv.on { background: var(--selected); border-color: var(--accent-soft); }
.crow { display: flex; align-items: center; gap: 8px; font-size: 10px; color: var(--text-dim); }

/* One glyph, three tints: the agent's own colour when it simply answered, and
   the warning ramp when it stopped on something only a person can settle. */
.needs { display: inline-flex; align-items: center; }
.needs .lucide { width: 12px; height: 12px; stroke-width: 2.4; }
.needs.reply { color: var(--agent); }
.needs.blocked { color: var(--warn); }
.needs.failed { color: var(--danger); }
.ceng { font-weight: 600; color: var(--text); font-size: 11px; }
.ctitle {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* ── the empty conversation: the question is the page ────────────────── */
.hero { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 24px; }
.heroinner { width: 100%; max-width: 620px; }
.ask {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 0 0 20px;
  font-size: 26px;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--text);
}
.ask .mk { width: 24px; height: 24px; color: var(--agent); }
.ask .target { color: var(--accent); }

.composer.big {
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-lg);
  background: var(--panel-raised);
  padding: 10px 10px 9px;
  box-shadow: var(--shadow-sm);
}
.composer.big .prompt {
  border: none;
  background: transparent;
  padding: 4px 4px 8px;
  resize: none;
  width: 100%;
}
.composer.big .prompt:focus { box-shadow: none; border-color: transparent; }
.crow2 { display: flex; align-items: center; gap: 8px; }

.engines { display: flex; gap: 4px; }
.eng {
  height: 26px;
  padding: 0 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  font-size: var(--fs-xs);
  color: var(--text-muted);
  background: var(--bg);
}
.eng.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.eng.off { opacity: 0.35; }

.guard { margin: 12px 2px 0; text-align: center; font-size: 10px; color: var(--text-dim); }

/* ── a thread ────────────────────────────────────────────────────────── */
.thread { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 22px 20px; }
.tbar {
  position: sticky;
  top: -14px;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 9px;
  margin: -14px -22px 14px;
  padding: 10px 14px 10px 22px;
  background: var(--bg);
  border-bottom: 1px solid var(--line-soft);
}
.ttitle {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.live {
  flex: none;
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--agent);
  animation: pulse 1.6s var(--ease-soft) infinite;
}
.tbar .needs.chip { flex: none; height: 20px; padding: 0 8px; font-size: 10px; }

/* The conversation's own heartbeat. `--agent` rather than the runtime green:
   this is a thing an agent is doing, and colour maps to one idea (tokens.css). */
.dot.working {
  background: var(--agent);
  box-shadow: 0 0 0 3px var(--agent-soft);
  animation: pulse 1.6s var(--ease-soft) infinite;
}

.ex + .ex { margin-top: 20px; }
/* What was asked reads as said, not as logged: it is the only thing on the
   page a person wrote. */
.said {
  margin: 0 0 12px auto;
  max-width: 82%;
  width: fit-content;
  padding: 9px 13px;
  border-radius: var(--radius) var(--radius) 4px var(--radius);
  background: var(--accent-soft);
  color: var(--text);
  font-size: var(--fs-sm);
  line-height: 1.55;
  white-space: pre-wrap;
}
.thinking { color: var(--text-dim); font-size: var(--fs-xs); font-style: italic; }

.ln { display: flex; gap: 11px; font-size: var(--fs-sm); line-height: 1.6; margin-bottom: 10px; }
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

.composer.foot {
  flex: none;
  display: flex;
  align-items: flex-end;
  gap: 10px;
  padding: 12px 18px 14px;
  border-top: 1px solid var(--line);
  background: var(--bg-sunken);
}
.composer.foot .prompt { flex: 1; resize: vertical; min-height: 46px; }
.send { flex: none; height: 46px; }
</style>
