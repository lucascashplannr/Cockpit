<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { AgentScopePreview, Conversation, AgentTurn, Workspace } from '@cockpit/shared'
import {
  ArrowDown, BookMarked, CircleStop, Clock, Gauge, Hand, Lock,
  Redo2, ShieldCheck, Sparkles, Undo2, X,
} from '@lucide/vue'
import MemoryTab from './MemoryTab.vue'
import AgentMarkdown from '../agent/AgentMarkdown.vue'
import ToolCall from '../agent/ToolCall.vue'
import ToolGroup from '../agent/ToolGroup.vue'
import Composer from '../agent/Composer.vue'
import Wordmark from '../brand/Wordmark.vue'
import {
  activeAgentScope, agentDraft, client, closeThread, guard, isRunning,
  askRevert, loadTranscript, markThreadRead, openThreadFor, pinThread, previewScope, scopeLabel,
  sendTurn, sessionsForScope, startAgentIn, startFresh, state, toast, transcriptOf,
} from '../../core/store.js'
import { usePaced } from '../../core/reveal.js'

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

/**
 * Re-read whenever the scope changes — or whenever a conversation on it starts
 * or ends. It used to be fetched once per scope, so a lock taken after you
 * arrived was invisible and a lock released while you watched stayed on screen
 * until you navigated away and back.
 */
watch(
  [scope, () => sessionsForScope(scope.value).map((c) => c.id + c.status).join()],
  async ([s]) => {
    if (!s) {
      preview.value = null
      return
    }
    preview.value = await previewScope(s)
  },
  { immediate: true },
)

/** §4 — allowed, and the reason a restore point is captured before any write. */
const onMain = computed(() => preview.value?.paths.filter((p) => p.onProtectedBranch) ?? [])
/**
 * §7 — what is in the way, minus the thing you are looking at.
 *
 * A conversation holds a lease over its own scope for as long as it runs, so
 * the thread on screen was reporting itself as "another conversation working
 * here" — the one holder that is never in the way, announced in the one place
 * it makes no sense. It is told apart by the session the lease belongs to.
 */
const blocked = computed(() =>
  (preview.value?.blocked ?? []).filter((b) => b.sessionId !== selected.value?.id),
)
const paths = computed(() => preview.value?.paths ?? [])

/**
 * Which thread is open is the scope's business, not this component's: it used
 * to be a local ref, so walking over to another project and back reset the
 * panel to its empty composer while the work was still running. It lives in
 * the store now, and it is remembered.
 */
const selected = computed(() => openThreadFor(scope.value))

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

/**
 * §3.3 — the transcript is the journal filtered, never a second copy. Split by
 * turn so the thread reads as the exchange it was: each question, then what
 * the engine did before the next one.
 *
 * A call and its outcome arrive as two events separated by however long the
 * command took, and are shown as one thing: a transcript listing only the
 * calls reads as though every one of them succeeded.
 */
type Item =
  | { kind: 'text'; id: string; text: string }
  | {
      kind: 'tool'
      id: string
      tool: string
      input: Record<string, unknown>
      result: { stdout: string; stderr: string; isError: boolean; interrupted: boolean } | null
      denied: boolean
    }
  /** §16 — a turn's work put back. It happened to the code, so it is in the
   *  thread rather than only in a toast that has since gone. */
  | { kind: 'revert'; id: string; files: number; workspaces: number; redo: boolean }

/**
 * What a turn is actually drawn as.
 *
 * `items` is what happened; this is what is worth a card. A run of calls with
 * nothing said between them is one line that can be unfolded — twenty full
 * cards in a row is a transcript nobody reads to the end of.
 */
type Row =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'call'; id: string; call: Extract<Item, { kind: 'tool' }> }
  | { kind: 'group'; id: string; calls: Extract<Item, { kind: 'tool' }>[] }
  | { kind: 'revert'; id: string; files: number; workspaces: number; redo: boolean }

/** Two is where a fold starts earning its keep; one call folded is one click
 *  charged for nothing. */
const GROUP_AT = 2

function rowsOf(items: Item[]): Row[] {
  const rows: Row[] = []
  let run: Extract<Item, { kind: 'tool' }>[] = []

  const flush = (): void => {
    if (!run.length) return
    if (run.length < GROUP_AT) rows.push({ kind: 'call', id: run[0]!.id, call: run[0]! })
    else rows.push({ kind: 'group', id: run[0]!.id, calls: run })
    run = []
  }

  for (const it of items) {
    if (it.kind === 'tool') {
      run.push(it)
      continue
    }
    // A sentence between two calls ends the run: it is the agent saying why
    // what follows is different from what came before. So does an undo, which
    // is the loudest possible break in what a turn did.
    flush()
    if (it.kind === 'revert') rows.push({ ...it })
    else rows.push({ kind: 'text', id: it.id, text: it.text })
  }
  flush()
  return rows
}

interface Exchange {
  turn: AgentTurn
  items: Item[]
  rows: Row[]
}

/**
 * §16 — a refusal, told apart from a failure.
 *
 * The engine says so in the result itself, which is better than matching the
 * conversation's `denials` back onto a call: the same command can be run twice
 * in one turn, and only one of the two refused.
 */
const DENIED = /has been denied/i

/**
 * Every event of the conversation, dealt out to the turn it happened in.
 *
 * One pass, not one per turn: this was a scan of the whole transcript for each
 * turn in it, re-run whenever anything arrived — quadratic in the length of a
 * conversation, on the hot path of a streaming answer.
 *
 * `byCall` spans the whole conversation rather than one turn, which also fixes
 * the case that made a finished call look like it never returned: a command
 * whose result landed after the next question had already been asked.
 */
function bucketize(sessionId: string, turns: AgentTurn[]): Item[][] {
  const buckets: Item[][] = turns.map(() => [])
  if (!turns.length) return buckets
  const byCall = new Map<string, Extract<Item, { kind: 'tool' }>>()
  let ti = 0

  for (const e of transcriptOf(sessionId)) {
    if (e.actor.kind !== 'agent' || e.actor.sessionId !== sessionId) continue
    // Events are stored in the order they happened, so the turn only ever
    // moves forward.
    while (ti + 1 < turns.length && e.ts >= turns[ti + 1]!.startedAt) ti++
    if (e.ts < turns[0]!.startedAt) continue
    const into = buckets[ti]!

    if (e.type === 'agent.output') {
      const text = (e.payload as { text?: string })?.text ?? ''
      if (text.trim()) into.push({ kind: 'text', id: e.id, text })
      continue
    }
    if (e.type === 'agent.reverted') {
      const p = e.payload as { files?: number; workspaces?: number; redo?: boolean }
      into.push({
        kind: 'revert',
        id: e.id,
        files: Number(p?.files ?? 0),
        workspaces: Number(p?.workspaces ?? 0),
        redo: !!p?.redo,
      })
      continue
    }
    if (e.type === 'agent.tool_use') {
      const p = e.payload as { toolUseId?: string; tool?: string; input?: Record<string, unknown> }
      const item: Extract<Item, { kind: 'tool' }> = {
        kind: 'tool',
        id: e.id,
        tool: p?.tool ?? 'tool',
        input: p?.input ?? {},
        result: null,
        denied: false,
      }
      if (p?.toolUseId) byCall.set(p.toolUseId, item)
      into.push(item)
      continue
    }
    if (e.type === 'agent.tool_result') {
      const p = e.payload as {
        toolUseId?: string
        stdout?: string
        stderr?: string
        isError?: boolean
        interrupted?: boolean
      }
      const call = p?.toolUseId ? byCall.get(p.toolUseId) : undefined
      // A result whose call fell off the end of the kept journal is dropped
      // rather than shown alone: an outcome with nothing to be the outcome of
      // is noise.
      if (!call) continue
      const stdout = p?.stdout ?? ''
      call.result = {
        stdout,
        stderr: p?.stderr ?? '',
        isError: !!p?.isError,
        interrupted: !!p?.interrupted,
      }
      call.denied = !!p?.isError && DENIED.test(stdout)
    }
  }
  return buckets
}

/**
 * The thread on screen is fetched whole, once. Everything after that arrives as
 * events and is appended, so this fires on identity rather than on content.
 */
watch(
  () => selected.value?.id,
  (id) => {
    if (id) void loadTranscript(id)
  },
  { immediate: true },
)

const exchanges = computed<Exchange[]>(() => {
  const s = selected.value
  if (!s) return []
  const buckets = bucketize(s.id, s.history)
  return s.history.map((turn, i) => {
    const items = buckets[i] ?? []
    return { turn, items, rows: rowsOf(items) }
  })
})

/**
 * §3.3 — the sentence being written right now, which is not in the journal and
 * must not be: it is a draft of the `agent.output` event that will replace it.
 * Painted under the last exchange, where the finished message will appear.
 */
const streaming = computed(() => {
  const s = selected.value
  if (!s) return ''
  return state.deltas[s.id]?.text ?? ''
})

/**
 * The same sentence, at reading speed.
 *
 * The deltas arrive in whatever bursts the engine sends them — often a whole
 * clause at once — and painting each burst the moment it lands made the answer
 * appear in slabs. `usePaced` keeps what is on screen a prefix of what has
 * arrived and walks it forward a few characters a frame, so the message is
 * written rather than stamped. It never falls more than a tenth of a second
 * behind, which is why the durable `agent.output` can still replace the draft
 * without anything visibly snapping into place.
 */
const typed = usePaced(() => streaming.value)

/**
 * §3.4 — a thread whose journal has been rotated out says so.
 *
 * The turns live in their own table and outlive the events by design, so an
 * old conversation still lists everything it was asked and can show none of
 * what it answered. Rendering that as a column of unanswered questions would
 * be the window inventing a story; naming the reason is the whole difference.
 */
const rotated = computed(() => {
  const s = selected.value
  if (!s || !s.history.length) return false
  if (transcriptOf(s.id).length) return false
  return !isRunning(s)
})

/* ── the composer ──────────────────────────────────────────────────────── */

/** With a thread open it adds a turn; with none it opens one. The label says. */
const continuing = computed(() => {
  const s = selected.value
  return !!s && (isRunning(s) || s.resumable)
})

/**
 * §6 — a running conversation is no longer a closed door.
 *
 * The composer used to grey itself out for the whole of a turn, so the thought
 * you had while reading the answer had to be held until the engine finished.
 * A turn said now is queued and goes in when this one lands; the only thing
 * that still refuses is a scope another session holds.
 */
const canSend = computed(() => {
  if (!agentDraft.value.trim() || busy.value) return false
  if (blocked.value.length) return false
  return continuing.value || !!scope.value
})

/** Said, but not started yet: it goes in when the engine finishes this turn. */
const queueing = computed(() => !!selected.value && isRunning(selected.value))

async function send(): Promise<void> {
  if (!canSend.value) return
  const text = agentDraft.value.trim()
  busy.value = true
  if (continuing.value && selected.value) {
    const ok = await sendTurn(selected.value.id, text)
    if (ok) agentDraft.value = ''
  } else if (scope.value) {
    // `startAgentIn` opens the new thread on this scope; nothing to do here.
    await startAgentIn(engine.value, scope.value, text)
  }
  busy.value = false
}

/** "Init and Init-Backend" — a list, read the way it would be said. */
function names(list: string[]): string {
  if (list.length <= 1) return list[0] ?? 'this scope'
  return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1]
}

/**
 * §7 — clearing a lease nothing is holding.
 *
 * Offered only when no session is behind it, which is the one case where this
 * cannot interrupt work: the process that took it is gone, and the lock is
 * simply outliving it.
 */
async function release(leaseId: string): Promise<void> {
  const r = await guard(() => client.call('lease.release', { leaseId }), 'the lock is cleared')
  if (r && scope.value) preview.value = await previewScope(scope.value)
}

/**
 * The conversation in the way, brought back on screen.
 *
 * "Something else is working here" with no way to go and look at it is half an
 * answer; the lease knows which session it belongs to, so the banner can hand
 * it over rather than describe it.
 */
function reveal(sessionId: string): void {
  if (scope.value) pinThread(scope.value, sessionId)
  state.historyOpen = false
}

async function stop(id: string): Promise<void> {
  await guard(() => client.call('agent.stop', { sessionId: id }), 'conversation stopped')
}

/* ── what has been said and not yet asked (§6) ───────────────────────────
 *
 * A queued turn used to be a toast and then nothing: the box emptied, the
 * words were gone from the screen, and whether they had been kept was a matter
 * of faith until the engine got to them. They are shown where they will land,
 * greyed, and can be taken back while they are still only waiting.
 */
const queued = computed(() => selected.value?.queued ?? [])

async function unqueue(prompt: string): Promise<void> {
  const s = selected.value
  if (!s) return
  const r = await guard(() => client.call('agent.unqueue', { sessionId: s.id, prompt }))
  if (r && !r.ok) toast('error', r.reason ?? 'it has already gone in')
}

/* ── scrolling ───────────────────────────────────────────────────────────
 *
 * New output should not have to be scrolled to — but it must not drag the
 * reader off what they went back to look at either. This followed the bottom
 * unconditionally, so scrolling up to re-read a command's output during a long
 * turn threw you back down on the next token, every token.
 *
 * So: it follows only while you are already at the bottom, and otherwise says
 * there is more below and offers to go there.
 */
const stuck = ref(true)

function onScroll(): void {
  const el = scrollEl.value
  if (!el) return
  // A hair of slack: a fractional scrollHeight is normal and would otherwise
  // read as "scrolled up" for the whole of a turn.
  stuck.value = el.scrollHeight - el.scrollTop - el.clientHeight < 48
}

async function toBottom(): Promise<void> {
  stuck.value = true
  await nextTick()
  const el = scrollEl.value
  if (el) el.scrollTop = el.scrollHeight
}

watch(
  [exchanges, typed, queued],
  async () => {
    if (!stuck.value) return
    await nextTick()
    const el = scrollEl.value
    if (el) el.scrollTop = el.scrollHeight
  },
  { deep: true },
)

// Another thread opens at its end, whatever the last one was scrolled to.
watch(() => selected.value?.id, () => void toBottom())

onMounted(async () => {
  const r = await guard(() => client.call('agent.engines', undefined))
  engines.value = r ?? []
  const firstAvailable = engines.value.find((e) => e.available)
  if (firstAvailable) engine.value = firstAvailable.id
})

/* ── §16, what it cost; §6, how full it is ───────────────────────────────
 *
 * The numbers were on the floor: the engine reports usage and cost on every
 * result event and the parser dropped both. §16 asks for cost outright, and
 * §6's whole argument is that a conversation whose window is filling up is one
 * about to drift — which nobody can act on if nothing says it.
 */

/**
 * 15535 → "15.5k", 228_400 → "228k".
 *
 * The decimal is kept to 100k because that is the range a context meter lives
 * in: rounding 15.5k to "16k" throws away precision exactly where the number
 * is being watched change.
 */
function k(n: number): string {
  if (n < 1000) return String(n)
  const t = n / 1000
  return (t < 100 ? t.toFixed(1) : Math.round(t)) + 'k'
}

/**
 * Money at the precision the number deserves. A tenth of a cent rounded to
 * "$0.00" reads as free, which is the one thing a cost display must never say.
 */
function money(n: number): string {
  if (n >= 1) return '$' + n.toFixed(2)
  if (n >= 0.01) return '$' + n.toFixed(3)
  return n > 0 ? '$' + n.toFixed(4) : '$0'
}

function secs(from: number, to: number | null): string {
  if (!to) return ''
  const ms = to - from
  if (ms < 1000) return ms + 'ms'
  if (ms < 60_000) return (ms / 1000).toFixed(1) + 's'
  const m = Math.floor(ms / 60_000)
  return m + 'm ' + Math.round((ms % 60_000) / 1000) + 's'
}

/** Where the conversation stands against its own window. */
const ctx = computed(() => {
  const u = selected.value?.usage
  if (!u || !u.contextWindow) return null
  return {
    ...u,
    pct: Math.min(100, Math.round((u.contextTokens / u.contextWindow) * 100)),
  }
})

/**
 * §6 — "vider devient gratuit : la conversation part, la mémoire reste."
 *
 * The threshold is where a window stops being a curiosity and starts being the
 * reason answers are getting worse. Said once, with the two things that
 * actually help beside it, rather than as a colour nobody has been taught.
 */
const CROWDED = 70
const crowded = computed(() => (ctx.value?.pct ?? 0) >= CROWDED)

/* ── presentation ──────────────────────────────────────────────────────── */

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
    <!-- The scope and the two instruments moved up into the column's own bar
         (ContextPanel): they said "this is what you are on", which is what
         that line already said, one row higher. What is left here is what only
         a conversation can say — the scope's own warnings. -->
    <!-- How many repositories the scope covers moved into the scope line above
         (ContextPanel): it is a fact about what you are standing on, and it was
         costing a whole row of the conversation to say a number. -->

    <!-- §7 — why this scope cannot be started on, in terms of the thing in the
         way rather than of the lease that represents it. -->
    <div v-if="blocked.length" class="note held">
      <Lock class="sm" />
      <div class="bls">
        <p v-for="b in blocked" :key="b.leaseId" class="bl">
          <template v-if="b.live">
            Another conversation is working in {{ names(b.names) }}, started
            {{ ago(b.acquiredAt) }}<template v-if="b.reason">: “{{ b.reason }}”</template> — two
            agents never share a folder.
            <button v-if="b.sessionId" class="link" @click="reveal(b.sessionId)">Open it</button>
          </template>
          <template v-else>
            {{ names(b.names) }} {{ b.names.length > 1 ? 'are' : 'is' }} still marked in use by a
            conversation that is no longer running — nothing is working here.
            <button class="link" @click="release(b.leaseId)">Clear the lock</button>
          </template>
        </p>
      </div>
    </div>
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

    <!-- Every conversation on this scope used to be a third full-height panel
         here, opened *instead of* the thread. It is a drawer under the column's
         bar now (ConversationDrawer), so the thread it is a way back into stays
         on screen while you look for it. -->

    <!-- The conversation. Nothing yet: the composer is the page, the way a new one is
         a question and a box under it. -->
    <div v-else-if="!selected" class="hero">
      <div class="heroinner">
        <!-- The one screen in the app that is nothing but an invitation, so
             it is the one that gets to say the app's name in full. The
             question stays under it rather than instead of it: the wordmark
             says where you are, and only the line says what it will act on. -->
        <Wordmark :height="36" class="wm" />
        <p class="ask">
          What should
          <span class="target">{{ label.name }}</span>
          do?
        </p>

        <Composer
          big
          mode="start"
          :disabled="!canSend"
          :workspace-id="props.workspace.id"
          :engines="engines"
          :engine="engine"
          placeholder="Describe the change. @ for a file, ⌘⏎ to start."
          @update:engine="engine = $event"
          @send="send"
        />

        <p class="guard">
          {{
            state.engineOptions.plan
              ? 'Plan mode — it reads and proposes, and writes nothing'
              : 'Never pushes · diff reviewed before any commit · restore point first'
          }}
        </p>
      </div>
    </div>

    <!-- A thread. The exchange, then the box to continue it. -->
    <template v-else>
      <div ref="scrollEl" class="thread" @scroll.passive="onScroll">
        <div class="tbar">
          <span class="dot" :class="dotClass(selected)" />
          <span class="ttitle">{{ selected.title || 'untitled' }}</span>
          <!-- Running is the one state worth a word: it is why the panel comes
               back to this thread rather than to an empty composer. -->
          <span v-if="isRunning(selected)" class="live">working</span>

          <!-- §6 + §16 — how full the window is, and what the thread has cost.
               In this bar because both are facts about the conversation, and
               this is the conversation's own line. -->
          <span
            v-if="ctx"
            class="ctx"
            :class="{ crowded }"
            :title="
              k(ctx.contextTokens) + ' of ' + k(ctx.contextWindow) + ' tokens in context' +
              (ctx.model ? ' · ' + ctx.model : '') + ' · ' + money(ctx.costUsd) + ' so far'
            "
          >
            <span class="gauge"><i :style="{ width: Math.max(2, ctx.pct) + '%' }" /></span>
            <span class="num">{{ ctx.pct }}%</span>
            <span class="num cost">{{ money(ctx.costUsd) }}</span>
          </span>
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

        <!-- §3.4 — what is missing, and why, rather than a thread that looks
             like it was never answered. -->
        <p v-if="rotated" class="rot">
          <Clock class="sm" />
          The journal for this conversation has been rotated out — its turns are
          listed, what was said in them is gone.
        </p>

        <div v-for="(x, i) in exchanges" :key="x.turn.id" class="ex">
          <!-- §16 — the tree as it stood before this question was asked.
               Quiet until the exchange is under the cursor: every turn carries
               one, and twenty visible at once would read as decoration. -->
          <!-- §16 — the tree as it stood before this question was asked, and
               the way forward again once an undo has happened here. Quiet
               until the exchange is under the cursor: every turn carries these,
               and twenty pairs lit at once would read as a toolbar. Neither
               does anything on its own — both open the confirmation. -->
          <div v-if="x.turn.restorable || x.turn.redoable" class="exbar">
            <button
              v-if="x.turn.redoable"
              class="revert"
              title="Bring back what the undo discarded"
              @click="askRevert(selected.id, x.turn, true)"
            >
              <Redo2 class="sm" /> Redo
            </button>
            <button
              v-if="x.turn.restorable"
              class="revert"
              title="Put the files back to how they were before this turn"
              @click="askRevert(selected.id, x.turn, false)"
            >
              <Undo2 class="sm" /> Undo from here
            </button>
          </div>

          <div class="said selectable">{{ x.turn.prompt }}</div>
          <div
            v-if="x.turn.status === 'running' && !x.items.length && !typed"
            class="thinking"
          >
            working…
          </div>
          <template v-for="r in x.rows" :key="r.id">
            <div v-if="r.kind === 'text'" class="ln">
              <span class="badge text"><Sparkles class="sm" /></span>
              <AgentMarkdown class="txt" :text="r.text" />
            </div>
            <!-- Full width, and out of the badge column: a card is a thing the
                 agent did, not a thing it said. -->
            <ToolCall
              v-else-if="r.kind === 'call'"
              class="call"
              :tool="r.call.tool"
              :input="r.call.input"
              :result="r.call.result"
              :denied="r.call.denied"
              :live="x.turn.status === 'running'"
            />
            <ToolGroup
              v-else-if="r.kind === 'group'"
              class="call"
              :calls="r.calls"
              :live="x.turn.status === 'running'"
            />
            <!-- It happened to the code, so it is a line in the thread rather
                 than a toast that has since gone. -->
            <p v-else class="undone">
              <component :is="r.redo ? Redo2 : Undo2" class="sm" />
              {{ r.files }} file{{ r.files === 1 ? '' : 's' }}
              {{ r.redo ? 'brought back to after this turn' : 'put back to before this turn' }}<template
                v-if="r.workspaces > 1"
              >, across {{ r.workspaces }} repositories</template>
            </p>
          </template>

          <!-- What the turn cost, under it, at the weight of a receipt. Only
               once it has landed: a running turn has no total yet, and a zero
               would be a claim rather than a blank. -->
          <p v-if="x.turn.usage" class="meter">
            <span>{{ k(x.turn.usage.context) }} ctx</span>
            <span>{{ k(x.turn.usage.output) }} out</span>
            <span v-if="secs(x.turn.startedAt, x.turn.endedAt)">
              {{ secs(x.turn.startedAt, x.turn.endedAt) }}
            </span>
            <span v-if="x.turn.usage.costUsd">{{ money(x.turn.usage.costUsd) }}</span>
          </p>

          <!-- The sentence as it is being written. Same shape as a finished
               message on purpose: it *is* that message, a moment early, and the
               durable event replaces it in place without anything moving. -->
          <div v-if="typed && i === exchanges.length - 1" class="ln">
            <span class="badge text"><Sparkles class="sm" /></span>
            <AgentMarkdown class="txt" :text="typed" live />
          </div>
        </div>

        <!-- Said, and not yet asked. In the shape of a question because that
             is what it is, and dimmed because the engine has not seen it. -->
        <div v-for="(q, i) in queued" :key="'q' + i" class="ex">
          <div class="said pending selectable">
            {{ q }}
            <button class="drop" title="Take this back before it goes in" @click="unqueue(q)">
              <X class="sm" />
            </button>
          </div>
          <p class="waits"><Clock class="sm" /> waiting for this turn to land</p>
        </div>
      </div>

      <!-- Only when it would otherwise be a surprise: while you are at the
           bottom the thread follows on its own and this says nothing. -->
      <button v-if="!stuck" class="jump" @click="toBottom">
        <ArrowDown class="sm" /> Latest
      </button>

      <footer class="foot">
        <!-- §6 — "vider devient gratuit : la conversation part, la mémoire
             reste". The one moment that sentence is actionable is this one, so
             it is said here rather than in a document. -->
        <p v-if="crowded" class="crowd">
          <Gauge class="sm" />
          <span>
            The window is {{ ctx?.pct }}% full — answers get worse from here.
            Promote what matters to the memory, then start fresh: the next
            conversation reads it on the way in.
          </span>
          <button class="link" @click="state.memoryOpen = true">Memory</button>
          <button class="link go" @click="scope && startFresh(scope)">Start fresh</button>
        </p>

        <Composer
          :mode="queueing ? 'queue' : continuing ? 'continue' : 'start'"
          :disabled="!canSend"
          :workspace-id="props.workspace.id"
          :placeholder="
            queueing
              ? 'Say the next thing now — it goes in when this turn lands'
              : continuing
                ? 'Next turn — @ for a file, the memory is re-read on the way in'
                : 'This conversation cannot be resumed; ⌘⏎ opens a new one'
          "
          @send="send"
        />
      </footer>
    </template>
  </div>
</template>

<style scoped>
.agent { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; }
.grow { flex: 1; }

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
/* A lock is a state, not a failure. It used to be painted in the colour this
   app reserves for something having gone wrong, which is why it read as an
   error nobody could explain. */
.note.held { color: var(--warn); background: var(--warn-soft); align-items: flex-start; }
.bls { display: flex; flex-direction: column; gap: 4px; }
.bl { margin: 0; }
.bl .link {
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
  font-size: inherit;
}
.bl .link:hover { color: var(--text); }

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
.wm {
  margin: 0 auto 10px;
  color: var(--brand-ink);
  --wm-lead: var(--accent);
}
/* Demoted from the 26px headline it was when it *was* the hero: above it now
   stands a mark cut on a 12-row grid, and a line of type at display size
   beside pixel letterforms makes both look like a mistake. Quiet, and one
   step up from the guard line under the composer. */
.ask {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 5px;
  flex-wrap: wrap;
  margin: 0 0 20px;
  font-size: var(--fs-md);
  font-weight: 450;
  color: var(--text-muted);
}
.ask .target { color: var(--accent); font-weight: 550; }

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

/* ── §16, the receipt ─────────────────────────────────────────────────────
 *
 * Under the turn, at the weight of a footnote: worth being able to find, never
 * worth reading before the answer it belongs to.
 */
.meter {
  display: flex;
  gap: 12px;
  margin: 6px 0 0 30px;
  font-size: 10px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}

/* ── §6, the window ─────────────────────────────────────────────────────── */
.ctx {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 10px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  cursor: default;
}
.gauge {
  width: 46px;
  height: 3px;
  flex: none;
  border-radius: 2px;
  background: var(--line-strong);
  overflow: hidden;
}
.gauge i {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--text-dim);
  transition: width var(--dur-3) var(--ease-soft);
}
/* Only once it means something. A gauge coloured from 4% teaches nobody where
   the line is. */
.ctx.crowded { color: var(--warn); }
.ctx.crowded .gauge i { background: var(--warn); }

.crowd {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 10px;
  padding: 9px 12px;
  border: 1px solid var(--warn-soft);
  border-radius: var(--radius-sm);
  background: var(--warn-soft);
  font-size: 11px;
  line-height: 1.5;
  color: var(--warn);
}
.crowd .lucide { flex: none; }
.crowd span { flex: 1; }
.crowd .link {
  flex: none;
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
  font-size: inherit;
  white-space: nowrap;
}
.crowd .link:hover { color: var(--text); }
.crowd .link.go { font-weight: 650; }

/* ── the undo, above the question it would take you back before ──────────
 *
 * Right-aligned over the prompt bubble, and invisible until the exchange is
 * under the cursor: it belongs to that turn, and a column of them lit at once
 * would read as a toolbar rather than as an escape hatch.
 */
.exbar {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  min-height: 20px;
  margin-bottom: 2px;
}
.revert {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: var(--text-dim);
}
.revert {
  padding: 3px 9px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  opacity: 0;
  transition:
    opacity var(--dur-1) var(--ease-soft),
    color var(--dur-1) var(--ease-soft),
    border-color var(--dur-1) var(--ease-soft);
}
/* Keyboard reach as well as pointer: an escape hatch you cannot tab to is an
   escape hatch for one kind of person. */
.ex:hover .revert, .revert:focus-visible { opacity: 1; }
.revert:hover {
  color: var(--warn);
  border-color: var(--warn);
  background: var(--warn-soft);
}

/* What an undo left behind, in the thread, at the weight of a fact. */
.undone {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 10px 0;
  padding: 5px 9px;
  border-left: 2px solid var(--warn);
  font-size: 11px;
  color: var(--text-muted);
  background: var(--warn-soft);
}
.undone .lucide { flex: none; color: var(--warn); }

/* Queued: the same bubble, at the weight of something that has not happened.
   Its ✕ only appears on hover — it is an escape hatch, not a decoration. */
.said.pending {
  position: relative;
  background: var(--panel-raised);
  border: 1px dashed var(--line-strong);
  color: var(--text-muted);
}
.said.pending .drop {
  position: absolute;
  top: -8px;
  right: -8px;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 1px solid var(--line-strong);
  background: var(--panel-raised);
  color: var(--text-dim);
  opacity: 0;
  transition: opacity var(--dur-1) var(--ease-soft);
}
.said.pending:hover .drop { opacity: 1; }
.said.pending .drop:hover { color: var(--danger); border-color: var(--danger); }
.waits {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 5px;
  margin: -6px 2px 0;
  font-size: 10px;
  color: var(--text-dim);
}

/* §3.4 — the reason a thread is empty, where the thread would be. */
.rot {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 0 16px;
  padding: 8px 11px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-dim);
  background: var(--panel-raised);
}
.rot .lucide { flex: none; }

/* Over the conversation, above the composer: it is about the thread, and it
   must not push the box it sits over. */
.jump {
  position: absolute;
  left: 50%;
  bottom: 104px;
  z-index: 2;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 11px;
  border-radius: 999px;
  border: 1px solid var(--line-strong);
  background: var(--panel-raised);
  box-shadow: var(--shadow-sm);
  font-size: 11px;
  color: var(--text-muted);
}
.jump:hover { color: var(--text); border-color: var(--accent); }

/* The only thing on the page that says "still writing" once text is flowing:
   the word "working" would be redundant beside a sentence forming. */
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
.txt { flex: 1; min-width: 0; }

/* A card is left-aligned with the badge column rather than indented under it:
   what the agent *did* is a peer of what it said, not a footnote to it. */
.call { margin: 0 0 10px; }

.foot {
  flex: none;
  padding: 12px 18px 14px;
  border-top: 1px solid var(--line);
  background: var(--bg-sunken);
}
</style>
