<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type {
  // Aliased: the component that draws one is `Attachment` too, and the file
  // needs both in the same scope.
  Attachment as AttachedFile,
  AgentScopePreview, Conversation, AgentTurn, Workspace,
} from '@cockpit/shared'
import {
  ArrowDown, Asterisk, Check, Clock, Copy, Gauge, Hand, Lock,
  Redo2, Undo2, X,
} from '@lucide/vue'
import AgentMarkdown from '../agent/AgentMarkdown.vue'
import ToolCall from '../agent/ToolCall.vue'
import ToolGroup from '../agent/ToolGroup.vue'
import Attachment from '../agent/Attachment.vue'
import Composer from '../agent/Composer.vue'
import PermissionAsk from '../agent/PermissionAsk.vue'
import Wordmark from '../brand/Wordmark.vue'
import {
  activeAgentScope, agentDraft, agentFiles, attachmentSrc, client, guard, isBusy, isLive, openSentFiles,
  askRevert, goTo, loadTranscript, markThreadRead, openThreadFor, pinThread, previewScope, scopeLabel,
  sendTurn, sessionsForScope, startAgentIn, startFresh, state, stopConversation, toast,
  transcriptOf,
} from '../../core/store.js'
import { anchorOf, anchorsIn, readPrompt } from '@cockpit/shared'
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

const engines = ref<{ id: string; available: boolean; bin: string; models?: string[] }[]>([])
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
  // A pasted screenshot on its own is a question. What is refused is an empty
  // turn — no words and nothing attached.
  if (!agentDraft.value.trim() && !agentFiles.value.length) return false
  if (busy.value) return false
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
  const files = agentFiles.value
  busy.value = true
  if (continuing.value && selected.value) {
    const ok = await sendTurn(selected.value.id, text, files)
    // Emptied together, and only on an answer: a refused turn has to leave the
    // screenshot in the box, or the way to retry is to go and find it again.
    if (ok) {
      agentDraft.value = ''
      agentFiles.value = []
    }
  } else if (scope.value) {
    // `startAgentIn` opens the new thread on this scope; nothing to do here.
    await startAgentIn(engine.value, scope.value, text, files)
  }
  busy.value = false
}

/**
 * A thumbnail clicked, opened at a size the screenshot can be read at.
 *
 * Handed the whole turn's pictures rather than the one: two screenshots in a
 * turn are nearly always the before and the after, and flicking between them
 * is the comparison. Files that are not images, and images whose bytes have
 * not arrived, are not in the list and do not open.
 */
/**
 * The turn as it was written: words, with each attachment sitting at the point
 * its `#handle` put it.
 *
 * A turn from before anchors existed has no handles, so this returns one text
 * part and the strip above carries its files — which is what those turns
 * always looked like.
 */
function bubble(turn: AgentTurn): ({ text: string } | { file: AttachedFile })[] {
  const files = turn.attachments ?? []
  const byHandle = new Map(files.filter((f) => f.handle).map((f) => [f.handle, f]))
  // `readPrompt` rather than `splitPrompt`: the chip here is an element with
  // padding of its own, so the room the composer had to write into the text
  // for its own chip would arrive as a second space either side of this one.
  return readPrompt(turn.prompt, byHandle.keys()).map((p) =>
    p.kind === 'text' ? { text: p.text } : { file: byHandle.get(p.handle)! },
  )
}

/* ── taking a turn out of the window ─────────────────────────────────────
 *
 * Both halves of an exchange are selectable text and always have been, which
 * is not the same as being copyable: a question is a bubble with chips in it
 * and an answer is rendered Markdown with tool cards between its paragraphs,
 * so dragging across either takes a sample of the layout rather than the
 * thing that was said. One button per half takes exactly the half it belongs
 * to — the words, as words.
 */

/** The last thing copied, so the button can say so where it was pressed. */
const copied = ref<string | null>(null)

async function copy(id: string, text: string): Promise<void> {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    copied.value = id
    window.setTimeout(() => {
      if (copied.value === id) copied.value = null
    }, 1400)
  } catch {
    // The one failure worth a toast: nothing visibly happened, and the reason
    // is a permission the window cannot show.
    toast('error', 'could not copy')
  }
}

/**
 * The question as it reads on screen: the words, with each attachment back to
 * the `#handle` the person typed.
 *
 * Through `bubble` rather than off `turn.prompt`, because the raw prompt still
 * carries the invisible room the composer wrote around each chip (`ANCHOR_PAD`)
 * — two non-breaking spaces a side, which would arrive in the paste as
 * characters nobody typed and nothing renders.
 */
function asked(turn: AgentTurn): string {
  return bubble(turn)
    .map((p) => ('text' in p ? p.text : anchorOf(p.file.handle)))
    .join('')
    .trim()
}

/**
 * What it said, without what it did.
 *
 * The cards are left out on purpose. A turn's prose is the answer; its tool
 * calls are the working, and forty lines of `git diff` pasted into a message
 * to a colleague is not what anyone reaching for this button meant. The
 * paragraphs are rejoined with a blank line, which is the gap the cards
 * between them stood in.
 */
function answered(x: Exchange): string {
  return x.rows
    .flatMap((r) => (r.kind === 'text' ? [r.text] : []))
    .join('\n\n')
    .trim()
}

/**
 * What each attachment is called in the sentence above it, or `all`.
 *
 * Empty when the turn anchors nothing — which is most turns, and every turn
 * taken before anchors existed. A row of tiles each labelled `all` draws no
 * distinction; it just says so five times.
 */
function labels(turn: AgentTurn): Record<string, string> {
  const files = turn.attachments ?? []
  const placed = new Set(anchorsIn(turn.prompt, files.map((f) => f.handle)))
  if (!placed.size) return {}
  return Object.fromEntries(
    files.map((f) => [f.id, placed.has(f.handle) ? anchorOf(f.handle) : 'all']),
  )
}

function showImage(turn: AgentTurn, file: AttachedFile): void {
  openSentFiles(turn.attachments, file)
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
const pending = computed(() => selected.value?.pending ?? [])

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
 * The whole of when, in the reader's own locale — for the tooltip only.
 *
 * It used to stand in the row beside the relative time: "11h ago · 20 sep,
 * 21:41", which is the same fact twice, one of them in a form nobody reads
 * until they have a reason to. "11h ago" is what anyone actually wants; the
 * clock is what they check when the answer is "no, the other one", and a
 * pointer resting on the words is exactly that moment. So it is said in full
 * there — weekday, date, year, to the second — rather than abbreviated to fit
 * a line it no longer has to fit in.
 */
function stamp(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
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
  if (s.pending.length) return 'asking'
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
        <p class="invite">
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
          placeholder="Describe the change. @ for a file, ⏎ to start, ⌘⏎ for a new line."
          @update:engine="engine = $event"
          @send="send"
        />

        <p class="guard">
          {{
            state.engineOptions.permissionMode === 'plan'
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
        <span v-if="selected.pending.length" class="needs approval chip warn" title="A tool call is waiting on your answer, above the box">
          <Hand class="sm" /> needs you
        </span>
        <span v-else-if="isBusy(selected)" class="busytag">
          <Asterisk class="star" />working
        </span>
        <span
          v-else-if="isLive(selected)"
          class="alive"
          title="The engine is still here between turns: the next thing you say goes straight in, and it holds this scope until it is let go"
        >open</span>

        <!-- How full the window is and what the thread has cost went down to
             the end of the settings row under the box (ContextMeter): both are
             questions asked while deciding what to type next, and this line is
             three hundred pixels from where that happens. What was left here
             when they went is the thing this bar is for — that a turn ended
             without permission to finish, which used to be hidden behind them
             for the whole of any conversation that had reported usage. -->
        <span v-if="selected.denials.length" class="needs blocked chip warn" :title="'refused: ' + selected.denials.join(', ')">
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
            <!-- The half a person wrote, and its own footer.
                 
                 Only as wide as what is in it, and hovered on its own: the two
                 halves of an exchange carry different controls, and a single
                 hover over the whole turn lit both — so reaching for the copy
                 under an answer also offered an Undo belonging to the question
                 three lines up. -->
            <div class="ask">
              <!-- What was attached, above the words: the screenshot is the
                   question and the sentence is the caption, not the other way
                   round. Turns from before attachments existed carry none. -->
              <!-- Every picture, once, above the words — and each one labelled
                   with what the sentence calls it. The sentence itself carries
                   the tag rather than the picture: a screenshot dropped into the
                   middle of a paragraph makes the paragraph unreadable, and the
                   thing being said is still a sentence. -->
              <ul v-if="x.turn.attachments?.length" class="sent">
                <Attachment
                  v-for="a in x.turn.attachments"
                  :key="a.id"
                  :file="a"
                  :label="labels(x.turn)[a.id]"
                  @click="showImage(x.turn, a)"
                />
              </ul>
              <div v-if="x.turn.prompt" class="said selectable">
                <template v-for="(part, i) in bubble(x.turn)" :key="i">
                  <span v-if="'text' in part">{{ part.text }}</span>
                  <!-- The tag, as it was written, wearing the chip it wore in
                       the box it was written in — and still the way through to
                       the picture, which is what it replaced. -->
                  <span
                    v-else
                    class="tag"
                    :class="{ pic: part.file.image }"
                    :title="part.file.name"
                    @click="showImage(x.turn, part.file)"
                  >{{ anchorOf(part.file.handle) }}</span>
                </template>
              </div>

              <!-- §16 — when it was asked, the question itself, the tree as it
                   stood before it, and the way forward again once an undo has
                   happened here. Under the bubble rather than over it: a row of
                   controls above a message is a heading, and this is a footer —
                   the same place the answer keeps its own.

                   The row is always rendered and always this tall, so the feed
                   under it does not move as the pointer crosses a turn: what
                   changes on hover is only whether it is inked. -->
              <div class="exbar">
                <span class="when" :title="stamp(x.turn.startedAt)">{{ ago(x.turn.startedAt) }}</span>
                <button
                  v-if="x.turn.prompt"
                  class="act"
                  :class="{ done: copied === 'q' + x.turn.id }"
                  title="Copy what you asked"
                  aria-label="Copy what you asked"
                  @click="copy('q' + x.turn.id, asked(x.turn))"
                >
                  <Check v-if="copied === 'q' + x.turn.id" class="sm" />
                  <Copy v-else class="sm" />
                </button>
                <!-- Marks, not sentences. "Undo from here" was the only worded
                     button in a thread, and a row that says one thing in words
                     and two in glyphs reads as a row with a heading on it. The
                     words are in the tooltip, where the other two keep theirs,
                     and the phrasing is unchanged: neither of these does
                     anything on its own — both open the confirmation, and that
                     dialog is where a destructive step gets named in full. -->
                <!-- Neither of these while the turn is running: the agent is
                     writing into those files as the row is drawn, and putting
                     the tree back to before a turn that has not finished
                     restores it under a process that is still editing. The
                     way to stop a turn is the Stop under the box; once it
                     lands, both come back. Copy of what *you* wrote stays —
                     nothing it does touches the tree. -->
                <button
                  v-if="x.turn.redoable && x.turn.status !== 'running'"
                  class="act"
                  title="Redo — bring back what the undo discarded"
                  aria-label="Redo this turn"
                  @click="askRevert(selected.id, x.turn, true)"
                >
                  <Redo2 class="sm" />
                </button>
                <button
                  v-if="x.turn.restorable && x.turn.status !== 'running'"
                  class="act"
                  title="Undo from here — put the files back to how they were before this turn"
                  aria-label="Undo from here"
                  @click="askRevert(selected.id, x.turn, false)"
                >
                  <Undo2 class="sm" />
                </button>
              </div>
            </div>

            <!-- The half it answered, with its own footer and its own hover. -->
            <div class="reply">
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
            <p v-if="x.turn.status === 'running' && pending.length" class="pulse asking">
              <Hand class="star" />
              <span class="verb">Waiting for you to allow {{ pending[0]!.tool }}</span>
              <span class="sep">·</span>
              <span class="num">{{ since(pending[0]!.askedAt) }}</span>
            </p>
            <!-- The verb is the phase it is in *now*; the two numbers are the
                 whole turn, from the moment the question went in. They read as
                 one claim — "thinking for 19 minutes" — and they are three, so
                 each one says what it counts on hover. The token figure in
                 particular is everything the engine has written this turn:
                 reasoning and the arguments of every tool call, not the
                 paragraphs on screen, which is why it runs to five figures on
                 a long turn while the answer above it is four lines. -->
            <p v-else-if="x.turn.status === 'running'" class="pulse">
              <Asterisk class="star" />
              <span class="verb">{{ shownDoing }}…</span>
              <span class="sep">·</span>
              <span class="num" :title="'Since the question went in, ' + stamp(x.turn.startedAt) + ' — the whole turn, not this step'">{{ since(x.turn.startedAt) }}</span>
              <template v-if="liveTokens">
                <span class="sep">·</span>
                <span class="num" title="Everything the engine has written this turn — its reasoning and the arguments of every tool call, not only the words on screen">{{ k(liveTokens) }} tokens</span>
              </template>
            </p>

            <!-- The answer's own footer, and only what can be done to it.
                 
                 It used to be a receipt — context, output, elapsed, cost, four
                 numbers under every answer in the thread. They were quiet and
                 they were still a column of arithmetic down a page whose whole
                 job is to be read, and they are said better in one place than
                 in twenty: the meter under the box carries the conversation's
                 cost and the last turn's figures, which is where anyone asking
                 the question is already looking.

                 Nothing at all while the turn is running. It appeared the
                 moment the first paragraph landed, so an answer still being
                 written — with the live line under it saying so — offered a
                 Copy that would hand over half of it, silently. A footer is
                 what goes *under* a finished answer; the turn above still has
                 its own line, and every earlier answer keeps its button. -->
            <div v-if="x.turn.status !== 'running' && (answered(x) || x.turn.endedAt)" class="rbar">
              <!-- When the answer landed, which is not when the question was
                   asked: a turn that took four minutes has two times, and the
                   one that matters at this end of it is this one. Absent while
                   the turn is still running — the line above is already saying
                   how long it has been at it, live. -->
              <span v-if="x.turn.endedAt" class="when" :title="stamp(x.turn.endedAt)">
                {{ ago(x.turn.endedAt) }}
              </span>
              <button
                v-if="answered(x)"
                class="act"
                :class="{ done: copied === 'a' + x.turn.id }"
                title="Copy the answer — the words, without the tool calls"
                aria-label="Copy the answer"
                @click="copy('a' + x.turn.id, answered(x))"
              >
                <Check v-if="copied === 'a' + x.turn.id" class="sm" />
                <Copy v-else class="sm" />
              </button>
            </div>
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

        <PermissionAsk v-if="selected && pending.length" :session-id="selected.id" :requests="pending" />

        <Composer
          :mode="queueing ? 'queue' : continuing ? 'continue' : 'start'"
          :disabled="!canSend"
          :busy="queueing"
          :sources="sources"
          :session="selected"
          @stop="stopConversation(selected.id)"
          :placeholder="
            queueing
              ? 'Say the next thing now — it goes in when this turn lands'
              : continuing
                ? 'Next turn — @ for a file, the memory is re-read on the way in'
                : 'This conversation cannot be resumed; ⏎ opens a new one'
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
.needs.approval { color: var(--warn); }
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
/* `invite`, not `ask`: the asked half of an exchange four hundred lines below
   is also `.ask`, it is declared later, and it won — so the one line on the
   empty screen was being laid out as a chat bubble: a column, right-aligned,
   capped at 76% of the panel, three words on three lines against the far
   edge. Two different things never share a class name in one sheet. */
.invite {
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
.invite .target { color: var(--accent); font-weight: 550; }

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
     to be centred in, and only on the threads that had finished. `--band-h` is
     that tall case made permanent, and the tab strip beside this one is held to
     the same figure so the two rules fall on one line (tokens.css).

     The right padding is not symmetry either: it is the room the three floating
     instruments need — the history button, the stop and the ✕, none of which
     live in this bar any more. They sit over it rather than inside it so that
     the invitation, which has no bar, has them in the same corner. 114 is their
     box exactly — 12 of margin, then 28 of ✕, 28 of stop and 44 of history a
     pixel apart. Buttons of one set touch; the 9 that separates the cluster
     from the title line is this bar's own gap, which falls after the last thing
     on it because `.grow` is the item that follows. */
  height: var(--band-h);
  padding: 0 114px 0 20px;
  background: var(--surface-work);
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
/* Stopped on a question for you: steady, and in the colour of a request. */
.dot.asking { background: var(--warn); box-shadow: 0 0 0 3px var(--warn-soft); }

/* One clear gap between exchanges, and none of the smaller ones inside a turn
   pretending to be it. */
.ex + .ex { margin-top: 26px; }

/* ── the two halves of an exchange ───────────────────────────────────────
 *
 * Each is its own box, and each is hovered on its own. It was one region over
 * the whole turn, which meant the pointer anywhere in an answer also lit an
 * Undo belonging to the question above it — two different things to do, one
 * of them destructive, offered by the same gesture.
 *
 * The asked half is sized to what is in it rather than to the column, so the
 * region that lights is the bubble and its footer, not the empty half of the
 * line beside them. `fit-content` takes the wider of the bubble and the row
 * under it; the 76% it is capped at is the bubble's own old maximum. */
.ask {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  width: fit-content;
  max-width: 76%;
  /* The gap between the halves, paid once here rather than by the bubble:
     the bubble is no longer the last thing in this half. */
  margin: 0 0 14px auto;
}
/* Inside the column the two of them are already at the right edge and already
   bounded by it, so their own margin-auto and 76% would be a second, smaller
   measure inside the first. */
.ask .sent, .ask .said { margin-left: 0; margin-right: 0; max-width: 100%; }
.ask .sent, .ask .said, .ask .sent:last-child { margin-bottom: 3px; }
/* What was asked reads as said, not as logged: it is the only thing on the
   page a person wrote. */
/* Beside the bubble and on its side of the column: what was attached is part
   of what was said, so it hangs off the same margin rather than starting a
   second conversation down the left. */
.sent {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
  margin: 0 0 6px auto;
  padding: 0;
  max-width: 76%;
  list-style: none;
}
/* Nothing was typed with them, so the files *are* the turn and carry the gap
   the bubble would have paid. */
.sent:last-child { margin-bottom: 14px; }

/* The same chip the composer draws over the token, now that it can be a real
   element rather than a background painted under a textarea. */
.tag {
  display: inline-block;
  padding: 0 5px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg);
  font-size: 0.92em;
  line-height: 1.35;
  white-space: nowrap;
}
/* Every tag opens — a picture into the viewer, a paste or a file as text —
   so every one points the way a button does. */
.tag { cursor: pointer; }
.tag.pic:hover { border-color: var(--line-strong); background: var(--hover); }

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
 * The one line on the page that is about *now*: what it is doing, how long it
 * has been at it, how much is written. It is the only arithmetic left in a
 * thread — the receipt that used to follow it under every landed turn is in
 * the meter under the box, where the same question is asked once instead of
 * once per answer. The numbers sit on tabular figures so a count climbing does
 * not shuffle the words after it. */
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
/* Stopped on a question for you: the hand holds still — nothing is being done
   until you answer, and a spinning mark would say otherwise. */
.pulse.asking .star { color: var(--warn); animation: none; stroke-width: 1.75; }

/* ── §16, the receipt ─────────────────────────────────────────────────────
 *
 * Under the turn, at the weight of a footnote: worth being able to find, never
 * worth reading before the answer it belongs to.
 */
/* The mirror of `.exbar` on the other side of the exchange: a stated height
   that is always there, and ink only while this half is under the pointer. */
.rbar {
  display: flex;
  align-items: center;
  min-height: 20px;
  margin-top: 2px;
  opacity: 0;
  transition: opacity var(--dur-1) var(--ease-soft);
}
.reply:hover .rbar, .reply:focus-within .rbar { opacity: 1; }
.rbar .act { padding: 3px 6px; }

/* ── what you can do to an exchange ──────────────────────────────────────
 *
 * Four buttons, one shape: copy the question, redo, undo from here, copy the
 * answer. A mark alone, at the weight of everything else on its row, lighting
 * only under the pointer — a labelled button anywhere in a thread is the
 * loudest thing in it, and the row each of these sits in already says which
 * half of the exchange it belongs to. What each one is stays in its tooltip. */
.act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 3px;
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  transition: color var(--dur-1) var(--ease-soft), background var(--dur-1) var(--ease-soft);
}
.act:hover { color: var(--text); background: var(--hover); }
.act .lucide { width: 12px; height: 12px; }
/* Taken. The app's yes, for the second and a bit the tick is up — and stated
   on the button rather than read off which icon is inside it, because the
   icon set's own class names are not ours to depend on. */
.act.done, .act.done:hover { color: var(--ok); }

/* In the exchange's bar: the same quiet as the timestamp and the undo beside
   it, appearing with them rather than on its own. */
/* The bar inks as one thing, so the marks in it carry no opacity of their
   own — only the room they need to be pressed. */
.exbar .act { padding: 3px 6px; }

/* ── §6, the window ─────────────────────────────────────────────────────── */
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
/* Two things, not four: when it was asked, and what can be done about it.
   The marks are one set and sit at one gap; the room that used to be between
   every pair is kept once, in front of them, as the space that separates the
   fact from the acts.

   The height is stated and unconditional — that is what keeps the thread still
   as the pointer crosses it. Only the ink changes on hover; the row is there,
   and this tall, whether or not anything in it can be seen. */
.exbar {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 2px;
  min-height: 20px;
  opacity: 0;
  transition: opacity var(--dur-1) var(--ease-soft);
}
.ask:hover .exbar, .ask:focus-within .exbar { opacity: 1; }
/* Both footers carry one: when it was asked, when it landed. Roughly, in the
   row; exactly, in the tooltip resting on it — which is why the cursor stays
   an arrow over a word that is not a link and does not select like prose. */
.when {
  margin-right: 8px;
  font-size: 10px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: default;
}
/* Keyboard reach as well as pointer: an escape hatch you cannot tab to is an
   escape hatch for one kind of person. */

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
}
/* The same column as the conversation above it: a box that ran wider than the
   text it is about read as a different surface rather than the end of one. */
.foot > * { max-width: var(--measure); margin-left: auto; margin-right: auto; }
</style>
