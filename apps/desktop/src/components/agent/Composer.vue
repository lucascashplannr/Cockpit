<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { CornerDownLeft, FileCode, FileText, Paperclip, Square, UnfoldVertical, X } from '@lucide/vue'
import {
  agentDraft, agentFiles, attachFiles, attachText, client, dataUrl, detachFile, engineName, guard,
  isLongPaste, openDraftFiles, placedHandles, saveComposer, state,
} from '../../core/store.js'
import { ANCHOR_PAD, CLAUDE_MODELS, anchorOf, anchorWritten, splitPrompt } from '@cockpit/shared'
import type { DraftFile } from '../../core/store.js'
import { fuzzyFilter } from '../../core/fuzzy.js'
import Picker from './Picker.vue'
import EffortSlider from './EffortSlider.vue'
import ModelPicker from './ModelPicker.vue'
import type { Option } from './Picker.vue'

/**
 * Where the question is written, and everything that shapes the answer.
 *
 * It used to be a bare textarea and two engine buttons, so the three decisions
 * that most change what comes back — which model, how hard it thinks, and
 * whether it may write at all — could only be made by editing the core. They
 * are one row under the box now, because that is where they are decided: per
 * question, not per project.
 */
const props = defineProps<{
  /** The big centred one on an empty conversation, or the one in the footer. */
  big?: boolean
  disabled?: boolean
  /**
   * Every repository the conversation is scoped to, in the order the engine
   * receives them: the first is its working directory, the rest are handed
   * over explicitly. `@` completes across all of them — a topic spanning two
   * repositories used to complete files from the anchor only, so half of what
   * the conversation could touch could not be named in the box that points
   * it at things.
   */
  sources?: { workspaceId: string; name: string; path: string }[]
  engines?: { id: string; available: boolean; bin: string; models?: string[] }[]
  engine?: string
  /** `start` opens a conversation, `continue` adds a turn, `queue` waits. */
  mode: 'start' | 'continue' | 'queue'
  placeholder: string
  /**
   * A turn is in flight.
   *
   * The way out of one belongs here and not only in the bar three hundred
   * pixels up: the box is where you are looking when you decide you have seen
   * enough, and hunting for the stop button is exactly the moment you should
   * not be hunting for anything.
   */
  busy?: boolean
}>()
const emit = defineEmits<{ send: []; stop: []; 'update:engine': [string] }>()

const box = ref<HTMLTextAreaElement | null>(null)

/* ── model and effort ─────────────────────────────────────────────────── */

/**
 * Only what the installed `claude` accepts: the core reads that out of the CLI,
 * because the one on PATH and the one bundled with the desktop app are often a
 * few versions apart, and a model the older one has never heard of is a launch
 * that fails. Nothing to read means everything is offered.
 */
const models = computed(() => {
  const known = props.engines?.find((e) => e.id === 'claude')?.models
  return known ? CLAUDE_MODELS.filter((m) => known.includes(m.id)) : CLAUDE_MODELS
})
const EFFORTS = [
  { id: 'low', label: 'Low', hint: 'quick passes' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High', hint: 'the default' },
  { id: 'xhigh', label: 'X-high' },
  { id: 'max', label: 'Max', hint: 'when correctness beats cost' },
  // Not an engine flag: the core runs it at Max and says the word in each turn.
  { id: 'ultracode', label: 'Ultracode', hint: 'fans the work out across agents' },
]

function pickModel(id: string): void {
  state.engineOptions.model = id
  saveComposer()
}
function pickEffort(id: string): void {
  state.engineOptions.effort = id
  saveComposer()
}

/** An engine that is not on PATH is shown and unpickable, never hidden: its
 *  absence is a thing to install, not a thing to wonder about. */
const engineOptions = computed<Option[]>(() =>
  (props.engines ?? []).map((e) => ({
    id: e.id,
    label: engineName(e.id),
    hint: e.available ? undefined : 'not installed',
    disabled: !e.available,
  })),
)

/* ── @ mentions ───────────────────────────────────────────────────────────
 *
 * The tracked files of every repository in the scope, fetched once per scope
 * and kept: an agent is pointed at code under version control, and offering
 * `node_modules` would bury the three files anyone actually means.
 */
interface FileRef {
  /** The repository it lives in — shown whenever there is more than one. */
  repo: string
  /** Its path inside that repository, which is how anyone thinks of it. */
  rel: string
  /** What is written into the prompt. */
  insert: string
  /** What the fuzzy match runs over. */
  hay: string
}

const files = ref<FileRef[]>([])
/** Whether the repository has to be named on every row, or is understood. */
const multi = computed(() => (props.sources?.length ?? 0) > 1)

/**
 * Round-robin rather than concatenated: with an empty query the list is the
 * first eight, and appended one repository after another that is eight files
 * from the first repository and none from the second.
 */
function interleave(lists: FileRef[][]): FileRef[] {
  const out: FileRef[] = []
  const longest = lists.reduce((n, l) => Math.max(n, l.length), 0)
  for (let i = 0; i < longest; i++) for (const l of lists) if (l[i]) out.push(l[i]!)
  return out
}

/** The scope this list was asked for, so a slow answer cannot land after a
 *  faster one taken on a different scope. */
let asked = 0

watch(
  () => (props.sources ?? []).map((s) => s.workspaceId).join(),
  async () => {
    const mine = ++asked
    const srcs = props.sources ?? []
    if (!srcs.length) {
      files.value = []
      return
    }
    const lists = await Promise.all(
      srcs.map((s) => guard(() => client.call('fs.tracked', { workspaceId: s.workspaceId }))),
    )
    if (mine !== asked) return
    const many = srcs.length > 1
    files.value = interleave(
      lists.map((list, i) => {
        const s = srcs[i]!
        return (list ?? []).map((rel) => ({
          repo: s.name,
          rel,
          // The engine runs in the first path and is handed the rest as whole
          // directories, so a relative path only means anything in the first
          // one. Everywhere else it is named in full, which is the one form
          // that resolves wherever the process happens to be standing.
          insert: i === 0 ? rel : s.path + '/' + rel,
          // Typing the repository's name is a way of narrowing to it, so it
          // is part of what is matched — but only when there is a choice.
          hay: many ? s.name + '/' + rel : rel,
        }))
      }),
    )
  },
  { immediate: true },
)

/**
 * The `@token` or `#token` the caret is currently inside, if any. The caret
 * position is tracked rather than read on demand: a computed that reaches into
 * the DOM does not re-evaluate when only the selection moves.
 *
 * Two sigils, one mechanism. `@` points at a file in the repository, `#` at a
 * file attached to this very message — the same act, aimed at two places, so
 * it would be perverse to make them two different gestures.
 */
const caret = ref(0)
const mention = computed(() => {
  const upto = agentDraft.value.slice(0, caret.value)
  const m = /(^|\s)([@#])([^\s@#]*)$/.exec(upto)
  if (!m) return null
  const q = m[3] ?? ''
  return { sigil: m[2]!, query: q, from: upto.length - q.length - 1 }
})

/** One row of whichever list is open. */
interface Row {
  key: string
  /** What it is called. */
  label: string
  /** Where it is, or what it answers to — the right-hand column. */
  hint?: string
  /** What goes into the prompt after the sigil. */
  insert: string
  /** An attached picture shows itself; everything else shows an icon. */
  pic?: string
}

const fileRows = computed<Row[]>(() =>
  files.value.map((f) => ({ key: f.repo + '/' + f.rel, label: f.rel, hint: multi.value ? f.repo : undefined, insert: f.insert })),
)

/**
 * The attachments, as things the sentence can point at.
 *
 * Every one of them, placed or not: pointing at the same screenshot twice is a
 * perfectly ordinary thing to write, and a list that hid what was already used
 * would refuse it for no reason.
 */
const attachRows = computed<Row[]>(() =>
  agentFiles.value.map((f) => ({
    key: f.id,
    label: f.name,
    hint: anchorOf(f.handle),
    insert: f.handle,
    pic: f.mediaType.startsWith('image/') ? dataUrl(f) : undefined,
  })),
)

const matches = computed<Row[]>(() => {
  const m = mention.value
  if (m === null) return []
  const rows = m.sigil === '#' ? attachRows.value : fileRows.value
  if (!m.query) return rows.slice(0, 8)
  return fuzzyFilter(rows, m.query, (r) => (r.hint ?? '') + '/' + r.label, 8).map((s) => s.item)
})

const cursor = ref(0)
watch(matches, () => {
  cursor.value = 0
})
const picking = computed(() => matches.value.length > 0 && mention.value !== null)

function track(): void {
  caret.value = box.value?.selectionStart ?? 0
}

function accept(r: Row | undefined): void {
  const m = mention.value
  if (!m || !r) return
  const after = agentDraft.value.slice(caret.value)
  // An attachment token is written with the blank its chip needs around it; a
  // `@path` is drawn as plain text and wants none.
  const token = m.sigil === '#' ? anchorWritten(r.insert) : m.sigil + r.insert
  agentDraft.value = agentDraft.value.slice(0, m.from) + token + ' ' + after
  nextTick(() => {
    const pos = m.from + token.length + 1
    box.value?.focus()
    box.value?.setSelectionRange(pos, pos)
    caret.value = pos
  })
}

/**
 * Text into the box where the caret was, and the caret after it.
 *
 * This is what makes a paste mean something: the anchor for the screenshot
 * lands at the point in the sentence the person had reached, which is exactly
 * the point they were talking about when they pressed ⌘V.
 */
function insertAtCaret(text: string): void {
  const at = Math.min(caret.value, agentDraft.value.length)
  const before = agentDraft.value.slice(0, at)
  const after = agentDraft.value.slice(at)
  // A token needs air around it or it fuses with the word before it and stops
  // being a token at all.
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  // Always a space after, and the caret goes beyond it: the anchor is finished
  // the moment it is inserted, so it should look finished — a pill — rather
  // than sitting open under the cursor waiting for a keystroke that says so.
  const tail = /^\s/.test(after) ? '' : ' '
  agentDraft.value = before + lead + text + tail + after
  const pos = at + lead.length + text.length + tail.length
  nextTick(() => {
    box.value?.focus()
    box.value?.setSelectionRange(pos, pos)
    caret.value = pos
  })
}

/* ── prompt history ───────────────────────────────────────────────────── */

const histAt = ref(-1)

/**
 * `↑` only walks history from an empty box, or from a prompt already recalled.
 * Anywhere else it stays the caret key it has always been — stealing it would
 * make editing a long prompt impossible.
 */
function walkHistory(step: number, ev: KeyboardEvent): void {
  const recalled = histAt.value >= 0
  if (!recalled && (agentDraft.value !== '' || step < 0)) return
  const next = histAt.value + step
  if (next < -1 || next >= state.promptHistory.length) return
  ev.preventDefault()
  histAt.value = next
  agentDraft.value = next === -1 ? '' : (state.promptHistory[next] ?? '')
}

/**
 * Backspace at the edge of a finished chip takes the whole chip.
 *
 * A chip is read as one thing, so it has to delete as one thing. Character by
 * character it came apart in a way nothing on screen explained: the first press
 * cropped the chip's right side — that was its padding going, but the padding
 * is invisible, so the chip simply got narrower for no reason — the next made
 * the chip vanish and the syntax underneath appear, and only then did the
 * letters start to go, five presses later than expected.
 *
 * What is left behind is the `#`, not nothing. Deleting an anchor is nearly
 * always the beginning of naming a different attachment, and the `#` is both
 * the thing that says so and the thing that opens the list — so the gesture
 * ends where choosing starts. Deleting *that* is one more press.
 *
 * Only a chip that is actually drawn. With the caret inside the token it is
 * open as text, and then Backspace is Backspace: what you see is what goes.
 */
function eatAnchor(ev: KeyboardEvent): boolean {
  const el = box.value
  if (!el || el.selectionStart !== el.selectionEnd) return false
  const at = el.selectionStart
  const draft = agentDraft.value
  let i = 0
  for (const part of splitPrompt(draft, agentFiles.value.map((f) => f.handle))) {
    const start = i
    const end = start + (part.kind === 'text' ? part.text.length : anchorOf(part.handle).length)
    i = end
    if (part.kind !== 'anchor') continue
    // Inside it, or at the end of it: it is being written, not read.
    if (at > start && at <= end) return false
    // Past its right edge, with nothing in between but the chip's own room.
    if (at <= end || at > end + ANCHOR_PAD.length) continue
    if (/[^\u00a0]/.test(draft.slice(end, at))) continue
    const lead = /\u00a0*$/.exec(draft.slice(0, start))![0].length
    const from = start - Math.min(lead, ANCHOR_PAD.length)
    ev.preventDefault()
    agentDraft.value = draft.slice(0, from) + '#' + draft.slice(at)
    nextTick(() => {
      el.setSelectionRange(from + 1, from + 1)
      caret.value = from + 1
    })
    return true
  }
  return false
}

function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'Backspace' && !ev.metaKey && !ev.altKey && eatAnchor(ev)) return
  if (picking.value) {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault()
      cursor.value = (cursor.value + 1) % matches.value.length
      return
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault()
      cursor.value = (cursor.value - 1 + matches.value.length) % matches.value.length
      return
    }
    if (ev.key === 'Enter' || ev.key === 'Tab') {
      ev.preventDefault()
      accept(matches.value[cursor.value])
      return
    }
    if (ev.key === 'Escape') {
      ev.preventDefault()
      // Closes the list without losing the `@`: it is being typed, not undone.
      agentDraft.value += ' '
      caret.value = agentDraft.value.length
      return
    }
  }
  // Enter sends, as it does in every chat. ⌘⏎ (or ⇧⏎) is the line break, for
  // the prompt that needs paragraphs. Not while an input method is still
  // composing: that Enter picks the character, it does not end the message.
  if (ev.key === 'Enter' && !ev.isComposing && ev.keyCode !== 229) {
    if (ev.metaKey || ev.ctrlKey) {
      ev.preventDefault()
      newline(ev.target as HTMLTextAreaElement)
      return
    }
    if (!ev.shiftKey && !ev.altKey) {
      ev.preventDefault()
      submit()
      return
    }
  }
  if (ev.key === 'ArrowUp') walkHistory(1, ev)
  else if (ev.key === 'ArrowDown') walkHistory(-1, ev)
}

/** A line break where the caret is, replacing any selection. */
function newline(el: HTMLTextAreaElement): void {
  const from = el.selectionStart ?? agentDraft.value.length
  const to = el.selectionEnd ?? from
  agentDraft.value = agentDraft.value.slice(0, from) + '\n' + agentDraft.value.slice(to)
  nextTick(() => {
    el.setSelectionRange(from + 1, from + 1)
    caret.value = from + 1
  })
}

function submit(): void {
  histAt.value = -1
  emit('send')
}

const sendLabel = computed(() =>
  props.mode === 'queue' ? 'Queue' : props.mode === 'continue' ? 'Continue' : 'Start',
)
/**
 * Who approves a tool call. What the mode does not approve by itself is asked
 * above the box, with the call spelled out, and waits for a yes or a no.
 */
const PERMISSIONS: Option[] = [
  { id: 'auto', label: 'Auto', hint: 'Claude handles permission decisions' },
  { id: 'manual', label: 'Manual', hint: 'Always ask before making changes' },
  { id: 'acceptEdits', label: 'Accept edits', hint: 'Automatically accept all file edits' },
  { id: 'plan', label: 'Plan', hint: 'Create a plan before making changes' },
]
const plan = computed(() => state.engineOptions.permissionMode === 'plan')
function pickPermission(id: string): void {
  state.engineOptions.permissionMode = id as typeof state.engineOptions.permissionMode
  saveComposer()
}

/* ── what comes in with the question ──────────────────────────────────────
 *
 * Three doors onto one function, because a person moving a screenshot into a
 * conversation does not think of them as three things: ⌘V, a drag from the
 * desktop, and the clip for when the file is somewhere they have to go and
 * find. Only the last one was ever conceivable here, and it did not exist
 * either — so a bug that a picture explains in a second had to be typed out.
 */

const picker = ref<HTMLInputElement | null>(null)
const over = ref(false)

function pick(): void {
  picker.value?.click()
}

/**
 * Attached, and named at the caret.
 *
 * The anchor is inserted rather than merely offered, because the moment of
 * attaching *is* the moment of meaning it: you paste the screenshot after the
 * sentence it illustrates. Deleting the token is how you say "no, this one is
 * about the whole message" — the file stays attached either way, which is the
 * property that makes the token safe to delete.
 */
async function take(list: Iterable<File>): Promise<void> {
  const added = await attachFiles(list)
  if (added.length) insertAtCaret(added.map((f) => anchorWritten(f.handle)).join(' '))
}

function picked(ev: Event): void {
  const el = ev.target as HTMLInputElement
  void take(el.files ?? [])
  // Cleared, or picking the same file twice in a row fires no event at all.
  el.value = ''
}

/**
 * A paste carrying files is an attachment; a short paste of text is a paste.
 *
 * A *long* one is folded: two hundred lines of a component dropped into the
 * box buried the question under a scroll region, and the textarea re-wrapped
 * every indented line it could not fit. It becomes a `#paste` chip at the
 * caret and a tile over the box, the way a screenshot does, and the core
 * writes it back in at the chip when the turn is sent. A path, a word, a
 * couple of lines are not intercepted — they read as part of the sentence.
 */
function onPaste(ev: ClipboardEvent): void {
  track()
  const files = [...(ev.clipboardData?.files ?? [])]
  if (files.length) {
    ev.preventDefault()
    void take(files)
    return
  }
  const text = ev.clipboardData?.getData('text/plain') ?? ''
  if (!isLongPaste(text)) return
  ev.preventDefault()
  // A paste replaces what is selected, folded or not.
  const el = box.value
  if (el && el.selectionStart !== el.selectionEnd) {
    const [from, to] = [el.selectionStart, el.selectionEnd]
    agentDraft.value = agentDraft.value.slice(0, from) + agentDraft.value.slice(to)
    caret.value = from
  }
  const f = attachText(text.replace(/\r\n?/g, '\n'))
  if (f) insertAtCaret(anchorWritten(f.handle))
}

/**
 * The folded text, back into the box as text — where its chip stood, or at
 * the caret if nothing pointed at it.
 *
 * For the paste that was meant to be edited: folding is the right default for
 * a log, and the wrong one for the ten lines you wanted to trim first.
 */
function unfold(f: DraftFile): void {
  if (f.text === undefined) return
  const draft = agentDraft.value
  let i = 0
  let out = ''
  let done = false
  let trim = false
  for (const part of splitPrompt(draft, agentFiles.value.map((x) => x.handle))) {
    const len = part.kind === 'text' ? part.text.length : anchorOf(part.handle).length
    let raw = draft.slice(i, i + len)
    i += len
    if (trim) {
      raw = raw.replace(/^\u00a0+/, '')
      trim = false
    }
    if (!done && part.kind === 'anchor' && part.handle === f.handle) {
      // The chip's own room goes with it; the text brings its own spacing.
      out = out.replace(/\u00a0+$/, '') + f.text
      done = true
      trim = true
      continue
    }
    out += raw
  }
  agentFiles.value = agentFiles.value.filter((x) => x.id !== f.id)
  if (done) {
    agentDraft.value = out
    nextTick(() => box.value?.focus())
  } else {
    insertAtCaret(f.text)
  }
}

/** The opening of a folded paste — as much as a tile can show, and no more. */
function head(text = ''): string {
  return text.replace(/^\s*\n/, '').split('\n', 14).join('\n')
}
function lineCount(text = ''): number {
  return text.replace(/\n$/, '').split('\n').length
}

/**
 * `dragenter`/`dragleave` fire for every child the pointer crosses, so a
 * counter is kept rather than a flag: hovering the textarea inside the box
 * would otherwise clear the highlight while the file is still over it.
 */
let depth = 0
function onDragEnter(ev: DragEvent): void {
  if (!ev.dataTransfer?.types.includes('Files')) return
  depth++
  over.value = true
}
function onDragLeave(): void {
  depth = Math.max(0, depth - 1)
  if (!depth) over.value = false
}
function onDrop(ev: DragEvent): void {
  const files = [...(ev.dataTransfer?.files ?? [])]
  depth = 0
  over.value = false
  if (!files.length) return
  ev.preventDefault()
  void take(files)
}

/**
 * A thumbnail clicked, before it has been sent anywhere.
 *
 * The same viewer the thread uses: a screenshot is worth checking *before* the
 * question goes in, and having to send it to find out you pasted the wrong one
 * is the reason to look.
 */
function open(f: DraftFile): void {
  openDraftFiles(f)
}

/* ── the anchors, drawn as what they are ──────────────────────────────────
 *
 * `#shot` is the truth of the prompt and it stays the truth: the value behind
 * the box is always plain text, so history, undo, selection, ⌘Z and every
 * other thing a textarea does for free keep working. What changes is how a
 * *finished* anchor is drawn — as a pill rather than as syntax.
 *
 * Two layers: a mirror holding the same string, invisible, whose sole output
 * is the rounded ground under a token — and the textarea itself, above it,
 * still holding the real text and the real caret. Nothing is intercepted;
 * clicking a pill places the caret the way clicking any word does.
 *
 * An anchor the caret is inside — or sitting at the end of — is *not* drawn as
 * a pill. That is what makes it editable again without a mode: Backspace over
 * the space after a pill lands the caret at the end of the token, the pill
 * becomes text under the cursor, and the next keystroke edits the handle. No
 * key had to be intercepted for that; it falls out of where the caret is.
 */

const mirror = ref<HTMLDivElement | null>(null)
const focused = ref(false)

interface Written {
  kind: 'text' | 'anchor'
  text: string
  /** The caret is in it, so it is being written rather than read. */
  live: boolean
}

const written = computed<Written[]>(() => {
  const draft = agentDraft.value
  const at = caret.value
  const out: Written[] = []
  let i = 0
  for (const part of splitPrompt(draft, agentFiles.value.map((f) => f.handle))) {
    const start = i
    // Cut from the draft rather than written out from the handle: a token is
    // as long as its handle either way, but it may be spelled with either
    // dash, and this layer has to hold the characters the box above it holds —
    // not the ones that mean the same thing.
    const text =
      part.kind === 'text' ? part.text : draft.slice(start, start + anchorOf(part.handle).length)
    i = start + text.length
    out.push({
      kind: part.kind,
      text,
      // Being at the very start of a token is still being before it; being at
      // its end is being in it, which is what makes Backspace open it up.
      live: focused.value && at > start && at <= i,
    })
  }
  // The chip is drawn over the blank beside the token as well as over the
  // token itself. That blank is real text — `ANCHOR_PAD`, written in when the
  // anchor was — so it is already in both layers and already accounted for at
  // every wrap: taking it into the chip's span moves no glyph and costs no
  // alignment, and it is the only side padding a chip on this layer can have.
  for (let k = 0; k < out.length; k++) {
    const w = out[k]!
    if (w.kind !== 'anchor' || w.live) continue
    const before = out[k - 1]
    const after = out[k + 1]
    if (before?.kind === 'text') {
      const room = /\u00a0*$/.exec(before.text)![0].length
      const n = Math.min(room, ANCHOR_PAD.length)
      before.text = before.text.slice(0, before.text.length - n)
      w.text = '\u00a0'.repeat(n) + w.text
    }
    if (after?.kind === 'text') {
      const room = /^\u00a0*/.exec(after.text)![0].length
      const n = Math.min(room, ANCHOR_PAD.length)
      after.text = after.text.slice(n)
      w.text = w.text + '\u00a0'.repeat(n)
    }
  }
  // A trailing newline collapses in a div but not in a textarea, so the mirror
  // would come up one line short and every pill below it would sit high.
  out.push({ kind: 'text', text: '\u200b', live: false })
  return out
})

/** The mirror is not scrolled by the browser; it is scrolled by its textarea. */
function syncScroll(): void {
  if (mirror.value && box.value) mirror.value.scrollTop = box.value.scrollTop
}

/** Rounded the way a person reads a file size, not the way a disk reports one. */
function size(n: number): string {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB'
  return (n / (1024 * 1024)).toFixed(1) + ' MB'
}

defineExpose({ focus: () => box.value?.focus() })
</script>

<template>
  <div
    class="composer"
    :class="{ big, planning: plan, over }"
    @dragenter="onDragEnter"
    @dragover.prevent
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
  >
    <div class="well">
      <!-- The files, over the box: the list is what the word being typed could
           mean, so it belongs against the word rather than below the row. -->
      <ul v-if="picking" class="mentions">
        <li
          v-for="(m, i) in matches"
          :key="m.key"
          :class="{ on: i === cursor }"
          @mousedown.prevent="accept(m)"
        >
          <!-- An attached picture shows itself: `#` is answered by looking. -->
          <img v-if="m.pic" class="tiny" :src="m.pic" alt="" />
          <FileCode v-else class="xs" />
          <span class="path">{{ m.label }}</span>
          <!-- Which repository the file is in, or what the attachment answers
               to. Only when there is something to say: two files of the same
               name in two repos are the whole reason the list is worth reading
               rather than skimming. -->
          <span v-if="m.hint" class="from">{{ m.hint }}</span>
        </li>
      </ul>

      <!-- What is attached, over the box and under the mentions: it is part of
           the question being written, so it reads before the words rather than
           under the row of settings that shape the answer. -->
      <ul v-if="agentFiles.length" class="files">
        <li
          v-for="f in agentFiles"
          :key="f.id"
          :class="{
            pic: f.mediaType.startsWith('image/'),
            text: f.pasted,
            loose: !placedHandles.has(f.handle),
          }"
          :title="
            f.pasted
              ? (f.text ?? '').slice(0, 600) + ((f.text ?? '').length > 600 ? '\n…' : '')
              : placedHandles.has(f.handle)
              ? f.name + ' — placed at ' + anchorOf(f.handle) + ' in the message'
              : f.name + ' — about the whole message. Type ' + anchorOf(f.handle) + ' to place it.'
          "
          @click="open(f)"
        >
          <!-- The picture itself, not an icon labelled with its name: the whole
               reason for pasting one is that looking is faster than reading. -->
          <img v-if="f.mediaType.startsWith('image/')" :src="dataUrl(f)" :alt="f.name" />
          <!-- Folded text says what it starts with and how much of it there is:
               `paste.txt` would tell two pastes apart by number and nothing else. -->
          <template v-else-if="f.pasted">
            <pre class="snip">{{ head(f.text) }}</pre>
            <span class="fsize">{{ lineCount(f.text) }} lines</span>
            <button class="drop unfold" title="Unfold back into the message as text" @click.stop="unfold(f)">
              <UnfoldVertical class="xs" />
            </button>
          </template>
          <template v-else>
            <FileText class="glyph" />
            <span class="fname">{{ f.name }}</span>
            <span class="fsize">{{ size(f.bytes) }}</span>
          </template>
          <button class="drop" :title="'Remove ' + f.name" @click.stop="detachFile(f.id)">
            <X class="xs" />
          </button>
          <!-- Only when there is something to say.
               A tile is 48px across, so the handle written on it truncates to
               `#shot…` and answers nothing — and it does not need to, because
               the tokens are legible in the box two lines below, in the same
               order as these. What is *not* visible anywhere else is that a file
               belongs to no point in particular, so that is what gets a badge. -->
          <span v-if="!placedHandles.has(f.handle)" class="tok">all</span>
        </li>
      </ul>

      <div class="box">
        <!-- Under the text, and drawing nothing but the rounded ground beneath a
             finished anchor. Invisible characters, identical to the ones above
             them: that is the only way the pill can be exactly as wide as the
             word it is behind, at every wrap and every window width. -->
        <div ref="mirror" class="mirror" aria-hidden="true">
          <span
            v-for="(w, i) in written"
            :key="i"
            :class="{ pill: w.kind === 'anchor' && !w.live }"
          >{{ w.text }}</span>
        </div>

        <textarea
          ref="box"
          v-model="agentDraft"
          class="input prompt selectable"
          :rows="big ? 3 : 2"
          :placeholder="placeholder"
          @keydown="onKey"
          @keyup="track"
          @click="track"
          @input="track"
          @paste="onPaste"
          @scroll="syncScroll"
          @focus="focused = true"
          @blur="focused = false"
        />

      </div>

      <!-- In the well, beside the words: sending is an act on what was typed.
           The settings under the well only shape the answer. -->
      <div class="send">
        <!-- Beside the send button rather than instead of it: this app lets you
             say the next thing while it is still on the last one, so both acts
             are available at once and neither may hide the other. -->
        <button v-if="busy" class="btn stop" title="Stop what it is doing" aria-label="Stop" @click="emit('stop')">
          <Square class="sq" />
        </button>
        <!-- An icon, with the verb kept in the tooltip: Start, Continue and Queue
             are one act from here, and which one it is shows on hover. -->
        <button
          class="btn primary go"
          :disabled="disabled"
          :title="sendLabel + ' (⏎)'"
          :aria-label="sendLabel"
          @click="submit"
        >
          <CornerDownLeft class="ic" />
        </button>
      </div>
    </div>

    <div class="row">
      <!-- The clip before the settings: it adds to the question, where they
           only shape the answer. -->
      <button class="opt clip" title="Attach images or files" @click="pick">
        <Paperclip class="xs" />
      </button>
      <input ref="picker" class="hidden" type="file" multiple @change="picked" />

      <!-- Engine first: it decides what every control after it means. -->
      <Picker
        v-if="engineOptions.length"
        :options="engineOptions"
        :model-value="engine"
        @update:model-value="emit('update:engine', $event)"
      />
      <ModelPicker :models="models" :model-value="state.engineOptions.model" @update:model-value="pickModel" />
      <EffortSlider
        :options="EFFORTS"
        :model-value="state.engineOptions.effort"
        @update:model-value="pickEffort"
      />

      <!-- Who approves a tool call. Plan is one of the four — §3.7, the plan
           before the change, applied to the agent itself — and still lights
           the whole box, because it changes what pressing Start does. -->
      <Picker :options="PERMISSIONS" :model-value="state.engineOptions.permissionMode" @update:model-value="pickPermission" />
    </div>
  </div>
</template>

<style scoped>
/* Two parts: the well, which holds what is being said and the act of sending
   it, and the row of settings under it, which only shape the answer. The
   settings used to sit inside the box, where they read as part of the message. */
.composer { position: relative; }

/* A well, not a card. On the white conversation a raised white is no step at
   all, so the box takes a fill of its own and a soft edge. What sits inside it
   (the pills, the file tokens, Stop) shows the conversation's colour through
   it; `--inset` hands that down to the attachments, which are drawn on `--bg`
   everywhere else. */
.well {
  --inset: var(--surface-work);
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  column-gap: 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface-input);
  padding: 8px 8px 8px 10px;
}
.well > .files { grid-column: 1 / -1; }
.send { display: flex; align-items: center; gap: 6px; padding-bottom: 2px; }
.send .go { width: 32px; padding: 0; }
.send .ic { width: 15px; height: 15px; }
/* Plan mode changes what pressing Start *does*, so it is worth a whole-box
   signal rather than one lit chip among eleven. */
.composer.planning .well { border-color: var(--accent); }
/* A file is over the box and will land in it. The same whole-box signal, for
   the same reason: it is the box that is about to change, not one control. */
.composer.over .well { border-color: var(--accent); background: var(--accent-soft); }
.composer.over * { pointer-events: none; }

/* ── the box, and the two layers that share its geometry ────────────────
 *
 * Every rule that decides where a character lands is stated once, on both, or
 * the pill drifts off the word it belongs to — by a pixel at first, and by a
 * whole line the moment something wraps. */
.box { position: relative; }

.prompt,
.mirror {
  width: 100%;
  padding: 4px 4px 8px;
  border: none;
  font: inherit;
  font-size: var(--fs-sm);
  /* Looser than the 1.55 everything else uses, and the chips are the reason.
     A chip is its glyphs plus its vertical padding, and that padding does not
     enter the line box — so at 1.55 a chip stands 2.85px proud of its line and
     two of them on consecutive lines run into each other. This is the room
     that lets the padding stand without them touching. On the pair, like
     every other rule here: a line-height the two layers disagreed about would
     put every line after the first in a different place in each. */
  line-height: 1.85;
  letter-spacing: inherit;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  word-break: normal;
  tab-size: 4;
}

.prompt {
  position: relative;
  z-index: 1;
  background: transparent;
  resize: none;
  /* A textarea is inline-level, so it sits on a text baseline and the block
     around it keeps 6px of descender space underneath. The mirror is sized to
     that block, so it was six pixels taller than the thing it mirrors — which
     never showed as a misplaced pill, but did give the two layers different
     scroll ranges. */
  display: block;
}
/* `background` too, and that is not belt-and-braces.
   `.input:focus` in base.css sets an opaque `--panel-raised`, and it has the
   same specificity as this component's `.prompt` — so which one wins comes
   down to the order the two stylesheets happen to be injected in. It went one
   way in a page that mounts this component alone and the other way in the
   app, where the textarea painted solid white over the mirror the moment it
   took focus. The chips were there the whole time, underneath it. */
.prompt:focus { box-shadow: none; border-color: transparent; background: transparent; }

.mirror {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  /* The characters are only here to be measured against. */
  color: transparent;
  user-select: none;
}

/* A finished anchor, wearing the same clothes as the chips in the row below —
   `.opt`, the Plan and Model buttons — a shade smaller, because this one sits
   inside a sentence rather than beside it.

   There is no side padding here, and there cannot be: this layer lines up
   character-for-character with the textarea above it, so anything that moves a
   glyph is forbidden. Padding was tried as width handed straight back in
   negative margin — it moves nothing and still paints — but what it paints
   over is the single space beside the token, 3.26px of it, and five pixels of
   padding overran that by 2.7px a side and welded the chip to the words.

   (Widening every space with `word-spacing` would afford it. Tried and taken
   out again: it loosens the gaps in ordinary prose too, and a sentence that
   reads double-spaced is a worse price than a snug chip.)

   So the room is written into the prompt instead — `ANCHOR_PAD`, two
   non-breaking spaces a side, put there with the anchor and taken into this
   span by `written`. Real characters, identical in both layers, so the chip
   gets 6.5px of side padding for nothing and still keeps the ordinary space
   outside it as the gap to the next word.

   Height is the other half, and it is paid for in `line-height` above rather
   than here — see that rule. */
.mirror .pill {
  padding: 3px 0;
  /* The border, and only the border, handed back — it paints over the plain
     space outside the chip, which has 3.26px to spare. */
  margin: 0 -1px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--inset, var(--bg));
}

/* Under the well, on the conversation's own ground, so nothing here needs a
   box of its own: the controls are ghosts until the pointer is on one. The
   pickers are other components, hence `:deep`. */
.row { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; padding: 6px 2px 0; }
.row .opt,
.row :deep(.trigger) { border-color: transparent; background: transparent; }
.row .opt:hover:not(:disabled),
.row :deep(.trigger:hover),
.row :deep(.trigger.open) { border-color: transparent; background: var(--hover); }
.row .opt.on { border-color: transparent; background: var(--accent-soft); }

.opt {
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font-size: 11px;
  color: var(--text-muted);
  background: var(--inset, var(--bg));
  white-space: nowrap;
}
.opt:hover:not(:disabled) { color: var(--text); background: var(--hover); }
.opt.on { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }
.opt.clip { display: inline-flex; align-items: center; justify-content: center; padding: 0 7px; }
.xs { width: 11px; height: 11px; }
.hidden { display: none; }

/* ── what is attached ──────────────────────────────────────────────────── */

.files {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0 0 8px;
  padding: 0 4px;
  list-style: none;
}
.files li {
  position: relative;
  /* One square, whatever is in it — the thread's tiles made the same call.
     Files and pastes used to be 220px pills beside 48px pictures, so a turn
     carrying both read as two lists pushed together. */
  width: var(--tile, 72px);
  height: var(--tile, 72px);
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 6px 5px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--inset, var(--bg));
  color: var(--text-muted);
  overflow: hidden;
  /* Every tile opens: a picture into the viewer, a paste or a file into a
     sheet to read — and a paste to edit. */
  cursor: pointer;
}
.files li:hover { border-color: var(--line-strong); }
/* An image is shown, so it gets no chrome of its own: the thumbnail is the
   tile. */
.files li.pic {
  padding: 0;
}

/* "This one is not about any particular point."
   A note, at the weight of a note: it is the quieter of the two states and
   the one that is true by default, so it says so without arguing. */
.tok {
  position: absolute;
  left: 3px;
  bottom: 3px;
  padding: 0 4px;
  border-radius: 4px;
  background: var(--panel-raised);
  color: var(--text-dim);
  font-size: 9px;
  font-weight: 620;
  line-height: 13px;
  white-space: nowrap;
}
/* On a file or a paste the bottom edge carries its size, so the note moves
   to the top, where only the hover buttons on the right compete for room. */
.files li:not(.pic) .tok { top: 3px; bottom: auto; background: var(--hover); }
.files li.pic img { width: 100%; height: 100%; object-fit: cover; display: block; }

/* A file: the mark says "a file", the name says which, the size says how much. */
.files .glyph { width: 14px; height: 14px; flex: none; color: var(--text-dim); }
.files .fname {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  max-width: 100%;
  overflow: hidden;
  text-align: center;
  font-size: 9.5px;
  line-height: 1.25;
  word-break: break-all;
}
.files .fsize { flex: none; font-size: 9px; line-height: 1.2; color: var(--text-dim); white-space: nowrap; }

/* A paste reads from the top-left like the page it came from — unwrapped, so
   its indentation is still its indentation — and runs out into a fade. */
.files li.text { align-items: stretch; justify-content: flex-start; padding: 5px 5px 4px; }
.files .snip {
  flex: 1;
  min-height: 0;
  margin: 0;
  overflow: hidden;
  /* A preview, not text to select: base.css gives every `pre` the I-beam,
     which made this the one tile that did not point like the others. */
  cursor: inherit;
  user-select: none;
  font-family: var(--mono);
  font-size: 6.5px;
  line-height: 1.35;
  white-space: pre;
  color: var(--text-muted);
  -webkit-mask-image: linear-gradient(to bottom, #000 55%, transparent);
  mask-image: linear-gradient(to bottom, #000 55%, transparent);
}
.files li.text .fsize { text-align: right; }

/* Present on every tile, and only legible on the one under the cursor: a strip
   of five ✕ is a row of buttons where a list of files should be. */
.drop {
  position: absolute;
  top: 3px;
  right: 3px;
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border: 1px solid var(--line);
  border-radius: 50%;
  background: var(--panel-raised);
  color: var(--text-dim);
  opacity: 0;
  transition: opacity 90ms ease;
}
.drop.unfold { right: 22px; }
.files li:hover .drop, .drop:focus-visible { opacity: 1; }
.drop:hover { color: var(--danger); }
/* Unfolding loses nothing, so it does not warn like removing does. */
.drop.unfold:hover { color: var(--text); }

/* An escape hatch, not a call to action: it is offered at the weight of the
   controls around it, and only turns red under the cursor — the moment it is
   about to be used. */
/* The send button's twin: the same 32px square, one glyph, the verb in the
   tooltip. A filled square is the stop sign every player has taught. */
.btn.stop {
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--inset, var(--bg));
  color: var(--text-muted);
}
.btn.stop .sq { width: 11px; height: 11px; fill: currentColor; stroke-width: 0; border-radius: 2px; }
.btn.stop:hover {
  color: var(--danger);
  border-color: var(--danger);
  background: var(--danger-soft);
}

.mentions {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: calc(100% - 6px);
  z-index: 5;
  margin: 0;
  padding: 4px;
  list-style: none;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--panel-raised);
  box-shadow: var(--shadow-sm);
  /* Eight rows and the box's own padding. It was 220px, twelve short of the
     eight `matches` returns, so the last one was always cut in half — visible
     the moment a topic filled the list from two repositories rather than a
     single one from one. */
  max-height: 240px;
  overflow-y: auto;
}
.mentions li {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 8px;
  border-radius: 5px;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  cursor: pointer;
}
.mentions li.on { background: var(--selected); color: var(--text); }
.mentions .from {
  margin-left: auto;
  padding-left: 10px;
  flex: none;
  font-size: 10px;
  color: var(--text-dim);
}
.mentions .lucide { flex: none; color: var(--text-dim); }
.mentions .path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mentions .tiny {
  flex: none;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  object-fit: cover;
  display: block;
}
</style>
