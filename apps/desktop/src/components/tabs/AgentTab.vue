<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { AgentScopePreview, Conversation, AgentTurn, Workspace } from '@cockpit/shared'
import {
  ArrowDown, Asterisk, Clock, Gauge, Hand, Lock,
  Redo2, Undo2, X,
} from '@lucide/vue'
import AgentMarkdown from '../agent/AgentMarkdown.vue'
import ToolCall from '../agent/ToolCall.vue'
import ToolGroup from '../agent/ToolGroup.vue'
import Composer from '../agent/Composer.vue'
import Wordmark from '../brand/Wordmark.vue'
import {
  activeAgentScope, agentDraft, client, guard, isBusy, isLive,
  askRevert, goTo, loadTranscript, markThreadRead, openThreadFor, pinThread, previewScope, scopeLabel,
  sendTurn, sessionsForScope, startAgentIn, startFresh, state, stopConversation, toast,
  transcriptOf,
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

/**
 * §7 — every repository this conversation covers, in the order the engine gets
 * them: the first is its working directory, the rest are handed over whole.
 * The composer completes `@` across all of them.
 *
 * Before the preview lands there is one thing we can name, and it is the
 * workspace the column is standing on.
 */
const sources = computed(() =>
  preview.value?.paths.length
    ? preview.value.paths.map((p) => ({ workspaceId: p.workspaceId, name: p.name, path: p.path }))
    : [
        {
          workspaceId: props.workspace.id,
          name: props.workspace.name,
          path: props.workspace.path,
        },
      ],
)
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

/**
 * Having a finished thread on screen is having read it — that is what clears
 * the "waiting for you" marks in the rail and the list.
 *
 * This carried a `homeOpen` guard while a start page covered the whole window
 * on launch: without it the last thread was marked read behind a page nobody
 * could see through. The panel is the window now, so mounted and on screen are
 * the same thing and the guard has nothing left to guard.
 */
watch(
  () => [selected.value?.id, selected.value?.status, selected.value?.endedAt],
  () => {
    const c = selected.value
    if (c) markThreadRead(c)
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

/**
 * Every run of calls folds, down to a run of one.
 *
 * This was 2, on the reasoning that folding a single call charges a click for
 * nothing. What it actually bought was one full card — icon, command, a
 * preview of stdout — for every lone `cat` in a conversation, which is most of
 * them. The line is not a saving of space; it is the altitude the transcript
 * is read at, and a turn should read the same whether it ran one command or
 * nine. What the agent *said* is never folded.
 */
const GROUP_AT = 1

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
  return !isLive(s)
})

/* ── the composer ──────────────────────────────────────────────────────── */

/** With a thread open it adds a turn; with none it opens one. The label says. */
const continuing = computed(() => {
  const s = selected.value
  return !!s && (isLive(s) || s.resumable)
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

/**
 * Said, but not started yet: it goes in when the engine finishes this turn.
 *
 * Only while a turn is actually in flight. This used to ask whether the
 * *process* was up, so a conversation that had answered and was sitting idle
 * offered to Queue — a word that means "behind something", with nothing in
 * front of it. Pressing it sent the turn immediately, which is what Continue
 * had always said it would do.
 */
const queueing = computed(() => !!selected.value && isBusy(selected.value))

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

/* ── what it is doing right now ──────────────────────────────────────────
 *
 * A turn in flight used to be one italic word — "working…" — and only until
 * the first tool call landed, after which the thread went silent for however
 * long the work took. Silence and a hang look identical, so the question the
 * window left unanswered was the only one anyone actually has: is it still
 * going?
 *
 * Three facts answer it, and all three are things we already know: what it is
 * doing, how long it has been at it, and how much of the answer is written.
 * The last one is the one that cannot be faked — it comes from the engine's
 * own token count, and a hung turn's stops climbing.
 */

/**
 * One clock for everything on this panel that ages: the elapsed counter on the
 * turn in flight, and "2h ago" over every question that was ever asked.
 *
 * Fast while a turn is running, because a second-hand that only moves every
 * half minute is worse than none. Slow otherwise — the only reader then is a
 * relative timestamp that nobody watches tick, and a re-render a second for it
 * would be the panel's most expensive idle habit.
 */
const now = ref(Date.now())
let clock: number | null = null

watch(
  () => !!selected.value && isBusy(selected.value),
  (busy) => {
    if (clock !== null) clearInterval(clock)
    now.value = Date.now()
    clock = window.setInterval(() => {
      now.value = Date.now()
    }, busy ? 1000 : 30_000)
  },
  { immediate: true },
)
onUnmounted(() => {
  if (clock !== null) clearInterval(clock)
  if (dwell !== null) clearTimeout(dwell)
})

/** Seconds, then minutes. No milliseconds: this one is read while it moves. */
function since(from: number): string {
  const s = Math.max(0, Math.floor((now.value - from) / 1000))
  if (s < 60) return s + 's'
  return Math.floor(s / 60) + 'm ' + (s % 60) + 's'
}

/** What has been written of the answer so far, in the engine's own count. */
const liveTokens = computed(() => (selected.value ? (state.progress[selected.value.id] ?? 0) : 0))

/**
 * The verb, in the terms of the thing being done.
 *
 * A tool call with no outcome yet *is* what it is doing — there is never more
 * than one in flight — so the last unfinished call is the answer whenever
 * there is one.
 */
const VERBS: Record<string, string> = {
  Bash: 'Running',
  Read: 'Reading',
  Write: 'Writing',
  Edit: 'Editing',
  NotebookEdit: 'Editing',
  Glob: 'Searching',
  Grep: 'Searching',
  Task: 'Delegating',
  TodoWrite: 'Planning',
  WebFetch: 'Fetching',
  WebSearch: 'Searching',
}

function verbFor(tool: string, input: Record<string, unknown>): string {
  const s = (key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '')
  const verb = VERBS[tool] ?? tool
  // A command is read whole; everything else is known by its last path segment,
  // which is how anyone says it out loud.
  const subject =
    tool === 'Bash'
      ? s('command')
      : (s('file_path') || s('path') || s('pattern') || s('description') || s('url'))
          .split('/')
          .slice(-1)[0] ?? ''
  // Cut without a mark of its own — the line's own trailing ellipsis is the
  // one that says "still going", and two in a row read as a rendering bug.
  const short = subject.length > 44 ? subject.slice(0, 44).trimEnd() : subject
  return short ? verb + ' ' + short : verb
}

const doing = computed(() => {
  const last = exchanges.value[exchanges.value.length - 1]
  for (let i = (last?.items.length ?? 0) - 1; i >= 0; i--) {
    const it = last!.items[i]!
    if (it.kind === 'tool' && !it.result) return verbFor(it.tool, it.input)
  }
  // Nothing outstanding and words arriving: it is writing the answer. Nothing
  // outstanding and nothing arriving: it is deciding what to do next.
  return typed.value ? 'Writing' : 'Thinking'
})

/**
 * The same thing, at a speed a person can read.
 *
 * `doing` is exact and therefore useless on its own: a `Read` that returns in
 * 40ms would put a long file name on the line for two frames and take it away
 * again, so a turn full of quick calls reads as a stutter between "Thinking…"
 * and something nobody had time to see. Lucas: *"it gives an ultra glitch."*
 *
 * So the line holds whatever it is showing for `DWELL`, and when the hold ends
 * it takes the **current** value rather than the one that asked for the change.
 * A phase shorter than the hold is therefore skipped entirely rather than
 * flashed — which is the right trade: the name of a command that has already
 * finished is not news, and the point of naming the long ones is that they are
 * long.
 */
const DWELL = 700
const shownDoing = ref('')
let dwell: number | null = null
let dwelledAt = 0

watch(
  doing,
  (next) => {
    // A change is already scheduled; it will pick up whatever is true then.
    if (dwell !== null) return
    const t = performance.now()
    const wait = DWELL - (t - dwelledAt)
    if (wait <= 0) {
      shownDoing.value = next
      dwelledAt = t
      return
    }
    dwell = window.setTimeout(() => {
      dwell = null
      shownDoing.value = doing.value
      dwelledAt = performance.now()
    }, wait)
  },
  { immediate: true },
)

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

/**
 * The day and the minute it was asked, in the reader's own locale.
 *
 * Beside the relative time rather than instead of it: "2h ago" is what anyone
 * actually wants, and the clock time is what they check when the answer is
 * "no, the other one".
 */
function stamp(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function ago(ts: number): string {
  const m = Math.floor((now.value - ts) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return m + 'm ago'
  const h = Math.floor(m / 60)
  return h < 24 ? h + 'h ago' : Math.floor(h / 24) + 'd ago'
}

function dotClass(s: Conversation): string {
  if (isBusy(s)) return 'working'
  if (isLive(s)) return 'idle'
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
    <!-- Standing on a default branch used to be a full-width banner here,
         over every conversation, saying an unchanging sentence nobody had
         asked twice. It is a fact about where you are standing rather than
         about the conversation, and it is one glyph on the line that says
         where you are standing now (ContextPanel). What stays a banner is
         what is above it: a lock is the one thing here you have to act on. -->

    <!-- The memory was an overlay here, over the conversation, on the rule
         that the chat gets the width. It is a document you read *while*
         writing a prompt, which is the one thing an overlay cannot let you
         do — so it is a tool in the review column now (ReviewTools), beside
         the thread rather than on top of it. -->

    <!-- Every conversation on this scope used to be a third full-height panel
         here, opened *instead of* the thread. It is a drawer at the top of
         this column now (ContextPanel), so the thread it is a way back into
         stays on screen while you look for it. -->

    <!-- The conversation. Nothing yet: the composer is the page, the way a new one is
         a question and a box under it. -->
    <div v-if="!selected" class="hero">
      <div class="heroinner">
        <!-- The one screen in the app that is nothing but an invitation, so
             it is the one that gets to say the app's name in full. The
             question stays under it rather than instead of it: the wordmark
             says where you are, and only the line says what it will act on. -->
        <Wordmark :height="48" class="wm" />
        <p class="ask">
          What should
          <span class="target">{{ label.name }}</span>
          do?
        </p>

        <Composer
          big
          mode="start"
          :disabled="!canSend"
          :sources="sources"
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
      <!-- Out of the scroller rather than sticky inside it: the conversation
           below is a centred column with air on both sides now, and a bar that
           lives in that column would either be as narrow as the text or have
           to fight its way back out with negative margins. -->
      <div class="tbar">
        <span class="dot" :class="dotClass(selected)" />
        <span class="ttitle">{{ selected.title || 'untitled' }}</span>
        <!-- Three states, and the difference between the first two is the
             whole of §6's promise about what a session is. Working: a turn
             is in flight. Open: the engine is still here between turns, so
             the next thing said goes straight in — and it is holding this
             scope until it is let go. Neither: it is a thread you can read
             and resume. This said WORKING for the middle one, which is how
             a finished answer came to sit under a word claiming otherwise. -->
        <span v-if="isBusy(selected)" class="busytag">
          <Asterisk class="star" />working
        </span>
        <span
          v-else-if="isLive(selected)"
          class="alive"
          title="The engine is still here between turns: the next thing you say goes straight in, and it holds this scope until it is let go"
        >open</span>

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
        <!-- Nothing at this end any more. All three instruments float over the
             bar from `ContextPanel` — the ✕ and the history because the
             invitation, which has no bar, needs them in the same corner, and
             the stop button because it belongs between those two rather than
             behind them. What this bar carries here is the room they need. -->
      </div>

      <!-- The scroller and the one thing that floats over it. Wrapped, so
           "Latest" is placed against the bottom of the conversation rather
           than measured up from the bottom of the panel: it was a hardcoded
           104px, and the composer stopped being 104px tall the moment its
           background came off. -->
      <div class="scroller">
        <div ref="scrollEl" class="thread" @scroll.passive="onScroll">

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
            <div class="exbar">
              <!-- When it was asked. Always rendered, so the row this shares
                   with the undo has one height whether or not there is anything
                   to undo, and nothing shifts as the pointer crosses a turn. -->
              <span class="when">{{ ago(x.turn.startedAt) }} · {{ stamp(x.turn.startedAt) }}</span>
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
            <template v-for="r in x.rows" :key="r.id">
              <!-- No avatar, no badge: what a person wrote is a bubble on the
                   right, so everything at the left margin is the agent by
                   elimination. A glyph per paragraph was a column of purple down
                   a page whose whole job is to be read. -->
              <div v-if="r.kind === 'text'" class="ln">
                <AgentMarkdown class="txt" :text="r.text" />
              </div>
              <!-- A card is a thing the agent did, not a thing it said. -->
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

            <!-- What the turn cost, under it, at the weight of a receipt — and
                 only while the exchange is under the cursor, like the undo above
                 it. Four numbers under every turn is a column of arithmetic down
                 the side of a conversation: worth being able to find, never worth
                 reading before the answer it belongs to.

                 Only once it has landed: a running turn has no total yet, and a
                 zero would be a claim rather than a blank. -->
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
              <AgentMarkdown class="txt" :text="typed" live />
            </div>

            <!-- The turn, while it is still happening: what it is doing, how
                 long it has been at it, and how much is written. At the bottom of
                 the turn because that is where the next thing will appear — it is
                 the line the answer is being written onto.

                 It says nothing about how to stop: the way out is under the box,
                 where the hand already is, and a third Stop on this screen would
                 make all three easier to miss. -->
            <p v-if="x.turn.status === 'running'" class="pulse">
              <Asterisk class="star" />
              <span class="verb">{{ shownDoing }}…</span>
              <span class="sep">·</span>
              <span class="num">{{ since(x.turn.startedAt) }}</span>
              <template v-if="liveTokens">
                <span class="sep">·</span>
                <span class="num">{{ k(liveTokens) }} tokens</span>
              </template>
            </p>
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
      </div>

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
          <button class="link" @click="goTo('memory')">Memory</button>
          <button class="link go" @click="scope && startFresh(scope)">Start fresh</button>
        </p>

        <Composer
          :mode="queueing ? 'queue' : continuing ? 'continue' : 'start'"
          :disabled="!canSend"
          :busy="queueing"
          :sources="sources"
          @stop="stopConversation(selected.id)"
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
/* Both of these carry the anchor the floating instruments hang from
   (ContextPanel): whichever of the two is on screen *is* the top of the
   conversation, and the warnings above it are not part of it. */
.hero {
  anchor-name: --convtop;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.heroinner { width: 100%; max-width: 620px; }
.wm {
  /* The gap tracks the mark: at 48 the wordmark is its own block rather than a
     heading, and 10px under it read as the line being a subtitle glued to the
     logo instead of the question it is. */
  margin: 0 auto 16px;
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

/* ── a thread ────────────────────────────────────────────────────────────
 *
 * The conversation is a column of a fixed measure, centred, with the panel's
 * width falling away on both sides. It used to run the full width of whatever
 * the splitter gave it, which on a wide window is a 1400px line of prose —
 * about twice what anyone reads comfortably, and the reason a long answer felt
 * like a wall. The number is a measure, not a look: ~90 characters at this
 * size, which is the top of the range typography has agreed on for a century.
 *
 * Applied to the children rather than to a wrapper so the scrollbar stays at
 * the panel's edge, where the eye expects it, instead of at the column's.
 */
.thread {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px var(--pad) 26px;
  /* Both edges, so the column stays centred on the *panel* rather than on
     whatever is left of it once the scrollbar has taken its side. Without this
     the conversation sat half a scrollbar to the left of the box it is typed
     into — close enough to look like a mistake and not close enough to be one. */
  scrollbar-gutter: stable both-edges;
}
.thread > * {
  width: 100%;
  max-width: var(--measure);
  margin-left: auto;
  margin-right: auto;
}
.agent { --measure: 780px; --pad: 20px; }

.tbar {
  anchor-name: --convtop;
  flex: none;
  display: flex;
  align-items: center;
  gap: 9px;
  /* A stated height, not one that falls out of what happens to be in it.
     Padding around the tallest child made the bar 49px while a conversation was
     live — the stop button is 28 — and 41px the moment that button went away,
     with the pair floating over it (ContextPanel) still measured from the top
     at 10. So the ✕ sat two pixels off the bottom edge of a bar it was supposed
     to be centred in, and only on the threads that had finished. 49 is the tall
     case made permanent: 48 of content over the 1px rule, which centres a 28px
     instrument at 10 whatever else the bar is carrying.

     The right padding is not symmetry either: it is the room the three floating
     instruments need — the history button, the stop and the ✕, none of which
     live in this bar any more. They sit over it rather than inside it so that
     the invitation, which has no bar, has them in the same corner. 114 is their
     box exactly — 12 of margin, then 28 of ✕, 28 of stop and 44 of history a
     pixel apart. Buttons of one set touch; the 9 that separates the cluster
     from the title line is this bar's own gap, which falls after the last thing
     on it because `.grow` is the item that follows. */
  height: 49px;
  padding: 0 114px 0 20px;
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
/* `busytag`, not `live` — for the same reason the one below is not `open`.
   A scoped style also lands on a child component's *root* element, and
   `AgentMarkdown` puts `live` on its root while a message is streaming: this
   rule was setting the answer being written in UPPERCASE PURPLE and letting it
   snap back to prose the moment the durable event replaced the draft.

   Two collisions in this one file is a pattern, not bad luck. Before naming a
   class here, check it against the root classes of everything this template
   renders: AgentMarkdown (md / live), ToolCall (tc / failed / pending),
   ToolGroup (tg / bad), Composer (composer / big / planning). */
.busytag {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  font-weight: 600;
  color: var(--agent);
}
/* Alive between turns: the same fact as the dot beside it, in a word, at the
   weight of a fact. No pulse — nothing is happening, and an animation is a
   claim that something is.

   Named `alive` and not `open`, which is what it says: a scoped style also
   lands on a child component's *root* element, and `ToolGroup`'s root carries
   `open` when it is unfolded — so `.open { text-transform: uppercase }` here
   was silently shouting every expanded tool's output three levels down. Any
   class in this file that could also be a child's root class is a collision
   waiting to happen. */
.alive {
  flex: none;
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-dim);
  cursor: default;
}

/* The one moving thing in the window, and it moves only while a turn does.
   Turning rather than blinking: a blink is a warning light, and this is the
   opposite — it is the window saying it is still with you. */
.star {
  width: 13px;
  height: 13px;
  stroke-width: 2.4;
  animation: turn 2.6s linear infinite;
}
@keyframes turn {
  to { transform: rotate(360deg); }
}
/* Someone who has asked for less motion gets a steady mark, not a missing one. */
@media (prefers-reduced-motion: reduce) {
  .star { animation: none; }
}
.tbar .needs.chip { flex: none; height: 20px; padding: 0 8px; font-size: 10px; }

/* The conversation's own heartbeat. `--agent` rather than the runtime green:
   this is a thing an agent is doing, and colour maps to one idea (tokens.css). */
.dot.working {
  background: var(--agent);
  box-shadow: 0 0 0 3px var(--agent-soft);
  animation: pulse 1.6s var(--ease-soft) infinite;
}
/* Here, and not working. Still the agent's colour — it is still its process —
   and steady, because that is the difference being drawn. */
.dot.idle { background: var(--agent); opacity: 0.5; }

/* One clear gap between exchanges, and none of the smaller ones inside a turn
   pretending to be it. */
.ex + .ex { margin-top: 26px; }
/* What was asked reads as said, not as logged: it is the only thing on the
   page a person wrote. */
.said {
  margin: 0 0 14px auto;
  max-width: 76%;
  width: fit-content;
  padding: 7px 12px;
  border-radius: var(--radius);
  background: var(--accent-soft);
  color: var(--text);
  font-size: var(--fs-sm);
  line-height: 1.55;
  white-space: pre-wrap;
}
/* ── the turn in flight ─────────────────────────────────────────────────
 *
 * Deliberately the same shape and weight as `.meter`, the receipt under a turn
 * that has landed: this is that line, one moment earlier, saying what is being
 * spent rather than what was. The numbers sit on tabular figures so a count
 * climbing does not shuffle the words after it.
 */
/* Bigger than the receipt it becomes. It is the only line on the page that is
   about *now*, it is what you look at while you wait, and at 11px it read as
   another footnote among the footnotes. */
.pulse {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px 0 2px;
  font-size: var(--fs-sm);
  color: var(--text-muted);
}
.pulse .star { flex: none; width: 15px; height: 15px; color: var(--agent); }
.pulse .verb { color: var(--text); font-weight: 550; }
.pulse .sep { color: var(--text-dim); opacity: 0.6; }
.pulse .num { color: var(--text-dim); font-variant-numeric: tabular-nums; }

/* ── §16, the receipt ─────────────────────────────────────────────────────
 *
 * Under the turn, at the weight of a footnote: worth being able to find, never
 * worth reading before the answer it belongs to.
 */
.meter {
  display: flex;
  gap: 12px;
  margin: 6px 0 0;
  font-size: 10px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  opacity: 0;
  transition: opacity var(--dur-1) var(--ease-soft);
}
.ex:hover .meter, .ex:focus-within .meter { opacity: 1; }

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

/* ── when it was asked, and the way back before it ───────────────────────
 *
 * Right-aligned over the prompt bubble, and invisible until the exchange is
 * under the cursor: both belong to that turn, and a column of them lit at once
 * would read as a toolbar rather than as an escape hatch.
 */
.exbar {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
  min-height: 20px;
  margin-bottom: 2px;
}
.when {
  font-size: 10px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  opacity: 0;
  transition: opacity var(--dur-1) var(--ease-soft);
}
.revert {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  font-size: 10px;
  color: var(--text-dim);
  opacity: 0;
  transition:
    opacity var(--dur-1) var(--ease-soft),
    color var(--dur-1) var(--ease-soft),
    border-color var(--dur-1) var(--ease-soft);
}
/* Keyboard reach as well as pointer: an escape hatch you cannot tab to is an
   escape hatch for one kind of person. */
.ex:hover .when, .ex:hover .revert, .revert:focus-visible { opacity: 1; }

/* The app's own hover, not a colour of its own.
 *
 * This lit up amber on hover, which is the ramp this window reserves for "something
 * needs you" — so the one control on the page that merely *asks a question*
 * was the loudest thing on it, in a colour that means something else. Neither
 * button does anything on its own; both open the confirmation, and that dialog
 * is where the warning belongs. */
.revert:hover {
  color: var(--text);
  border-color: var(--line);
  background: var(--hover);
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

/* The scroller and its floating button share a box, so the button is placed
   against the end of the conversation rather than against the bottom of the
   panel. */
.scroller { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }

/* Over the conversation, just clear of the composer: it is about the thread,
   and it must not push the box it sits over. */
.jump {
  position: absolute;
  left: 50%;
  bottom: 14px;
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

/* What the agent said: plain text at the left margin, no gutter and no glyph.
   The badge that used to sit here is gone — see the template. */
.ln { font-size: var(--fs-sm); line-height: 1.6; margin-bottom: 10px; }
.txt { min-width: 0; }

/* What it *did* is a peer of what it said, on the same margin. */
.call { margin: 0 0 10px; }

/* One surface, top to bottom. The sunken band under the composer drew a second
   panel across the bottom of the window — the box already has a border, and a
   filled tray behind it is the same statement made twice. What is left is a
   hairline, which is only there so a long answer does not run into the box it
   is answered in. */
.foot {
  flex: none;
  /* The scroller above reserves a gutter on each side; this has no scrollbar,
     so it pays for the same inset out of its own padding. That is what puts
     the box on the same axis as the conversation. */
  padding: 12px calc(var(--pad) + var(--sbw)) 14px;
  border-top: 1px solid var(--line-soft);
}
/* The same column as the conversation above it: a box that ran wider than the
   text it is about read as a different surface rather than the end of one. */
.foot > * { max-width: var(--measure); margin-left: auto; margin-right: auto; }
</style>
