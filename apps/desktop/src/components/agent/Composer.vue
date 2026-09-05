<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { CircleStop, FileCode, FileText, Map as MapIcon, Paperclip, X } from '@lucide/vue'
import {
  agentDraft, agentFiles, attachFiles, client, dataUrl, detachFile, engineName, guard,
  saveComposer, state,
} from '../../core/store.js'
import { fuzzyFilter } from '../../core/fuzzy.js'
import Picker from './Picker.vue'
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
  engines?: { id: string; available: boolean; bin: string }[]
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
 * Aliases rather than pinned ids: the engine resolves `opus` to whatever the
 * current Opus is, and a hard-coded model string is a thing that silently
 * rots.
 */
const MODELS = [
  { id: 'fable', label: 'Fable', hint: 'the most capable' },
  { id: 'opus', label: 'Opus', hint: 'the default' },
  { id: 'sonnet', label: 'Sonnet', hint: 'faster, cheaper' },
  { id: 'haiku', label: 'Haiku', hint: 'quick and small' },
]
const EFFORTS = [
  { id: 'low', label: 'Low', hint: 'quick passes' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High', hint: 'the default' },
  { id: 'xhigh', label: 'X-high' },
  { id: 'max', label: 'Max', hint: 'when correctness beats cost' },
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
 * The `@token` the caret is currently inside, if any. The caret position is
 * tracked rather than read on demand: a computed that reaches into the DOM
 * does not re-evaluate when only the selection moves.
 */
const caret = ref(0)
const mention = computed(() => {
  const upto = agentDraft.value.slice(0, caret.value)
  const m = /(^|\s)@([^\s@]*)$/.exec(upto)
  if (!m) return null
  const q = m[2] ?? ''
  return { query: q, from: upto.length - q.length - 1 }
})

const matches = computed(() => {
  const m = mention.value
  if (m === null) return []
  if (!m.query) return files.value.slice(0, 8)
  return fuzzyFilter(files.value, m.query, (f) => f.hay, 8).map((s) => s.item)
})

const cursor = ref(0)
watch(matches, () => {
  cursor.value = 0
})
const picking = computed(() => matches.value.length > 0 && mention.value !== null)

function track(): void {
  caret.value = box.value?.selectionStart ?? 0
}

function accept(f: FileRef | undefined): void {
  const m = mention.value
  if (!m || !f) return
  const after = agentDraft.value.slice(caret.value)
  agentDraft.value = agentDraft.value.slice(0, m.from) + '@' + f.insert + ' ' + after
  nextTick(() => {
    const pos = m.from + f.insert.length + 2
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

function onKey(ev: KeyboardEvent): void {
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
  if (ev.key === 'ArrowUp') walkHistory(1, ev)
  else if (ev.key === 'ArrowDown') walkHistory(-1, ev)
}

function submit(): void {
  histAt.value = -1
  emit('send')
}

const sendLabel = computed(() =>
  props.mode === 'queue' ? 'Queue' : props.mode === 'continue' ? 'Continue' : 'Start',
)
const plan = computed(() => state.engineOptions.plan)
function togglePlan(): void {
  state.engineOptions.plan = !state.engineOptions.plan
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

function picked(ev: Event): void {
  const el = ev.target as HTMLInputElement
  void attachFiles(el.files ?? [])
  // Cleared, or picking the same file twice in a row fires no event at all.
  el.value = ''
}

/**
 * A paste carrying files is an attachment; a paste carrying text is a paste.
 * Only the first case is intercepted — taking the event unconditionally would
 * break copying a path into the box, which is the older way of doing this and
 * still a perfectly good one.
 */
function onPaste(ev: ClipboardEvent): void {
  const files = [...(ev.clipboardData?.files ?? [])]
  if (!files.length) return
  ev.preventDefault()
  void attachFiles(files)
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
  void attachFiles(files)
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
    <!-- The files, over the box: the list is what the word being typed could
         mean, so it belongs against the word rather than below the row. -->
    <ul v-if="picking" class="mentions">
      <li
        v-for="(m, i) in matches"
        :key="m.repo + '/' + m.rel"
        :class="{ on: i === cursor }"
        @mousedown.prevent="accept(m)"
      >
        <FileCode class="xs" />
        <span class="path">{{ m.rel }}</span>
        <!-- Which repository it is in, only when the scope spans more than
             one: two files of the same name in two repos are the whole reason
             the list is worth reading rather than skimming. -->
        <span v-if="multi" class="from">{{ m.repo }}</span>
      </li>
    </ul>

    <!-- What is attached, over the box and under the mentions: it is part of
         the question being written, so it reads before the words rather than
         under the row of settings that shape the answer. -->
    <ul v-if="agentFiles.length" class="files">
      <li v-for="f in agentFiles" :key="f.id" :class="{ pic: f.mediaType.startsWith('image/') }">
        <!-- The picture itself, not an icon labelled with its name: the whole
             reason for pasting one is that looking is faster than reading. -->
        <img v-if="f.mediaType.startsWith('image/')" :src="dataUrl(f)" :alt="f.name" />
        <template v-else>
          <FileText class="xs" />
          <span class="fname">{{ f.name }}</span>
          <span class="fsize">{{ size(f.bytes) }}</span>
        </template>
        <button class="drop" :title="'Remove ' + f.name" @click="detachFile(f.id)">
          <X class="xs" />
        </button>
      </li>
    </ul>

    <textarea
      ref="box"
      v-model="agentDraft"
      class="input prompt selectable"
      :rows="big ? 3 : 2"
      :placeholder="placeholder"
      @keydown="onKey"
      @keydown.meta.enter="submit"
      @keyup="track"
      @click="track"
      @input="track"
      @paste="onPaste"
    />

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
      <Picker :options="MODELS" :model-value="state.engineOptions.model" @update:model-value="pickModel" />
      <Picker
        label="Effort"
        :options="EFFORTS"
        :model-value="state.engineOptions.effort"
        @update:model-value="pickEffort"
      />

      <!-- §3.7 — the plan before the change, applied to the agent itself.
           A toggle rather than a picker: it has two states and one of them
           changes what pressing Start does. -->
      <button
        class="opt plan"
        :class="{ on: plan }"
        title="Plan mode — it reads and proposes, and writes nothing"
        @click="togglePlan"
      >
        <MapIcon class="xs" /> Plan
      </button>

      <span class="grow" />
      <!-- Beside the send button rather than instead of it: this app lets you
           say the next thing while it is still on the last one, so both acts
           are available at once and neither may hide the other. -->
      <button v-if="busy" class="btn stop" title="Stop what it is doing" @click="emit('stop')">
        <CircleStop class="xs" />
        Stop
      </button>
      <button class="btn primary" :disabled="disabled" @click="submit">
        {{ sendLabel }}
        <span class="kbd">⌘⏎</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.composer {
  position: relative;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-lg);
  background: var(--panel-raised);
  padding: 10px 10px 9px;
}
/* Plan mode changes what pressing Start *does*, so it is worth a whole-box
   signal rather than one lit chip among eleven. */
.composer.planning { border-color: var(--accent); }
/* A file is over the box and will land in it. The same whole-box signal, for
   the same reason: it is the box that is about to change, not one control. */
.composer.over { border-color: var(--accent); background: var(--accent-soft); }
.composer.over * { pointer-events: none; }

.prompt {
  border: none;
  background: transparent;
  padding: 4px 4px 8px;
  resize: none;
  width: 100%;
}
.prompt:focus { box-shadow: none; border-color: transparent; }

.row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.grow { flex: 1; }

.opt {
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg);
  white-space: nowrap;
}
.opt:hover:not(:disabled) { color: var(--text); background: var(--hover); }
.opt.on { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }
.opt.plan { display: inline-flex; align-items: center; gap: 4px; }
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
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  height: 28px;
  padding: 0 9px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg);
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
/* An image is shown, so it gets no chrome of its own: the thumbnail is the
   chip. Square, because a strip of chips at four aspect ratios reads as a
   mess rather than as a list. */
.files li.pic {
  width: 48px;
  height: 48px;
  padding: 0;
  overflow: hidden;
}
.files li.pic img { width: 100%; height: 100%; object-fit: cover; display: block; }
.files .fname { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.files .fsize { flex: none; font-size: 10px; color: var(--text-dim); }
.files .lucide { flex: none; color: var(--text-dim); }

/* Present on every chip, and only legible on the one under the cursor: a strip
   of five ✕ is a row of buttons where a list of files should be. */
.drop {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--panel-raised);
  color: var(--text-dim);
  opacity: 0;
  transition: opacity 90ms ease;
}
.files li.pic .drop { position: absolute; top: 3px; right: 3px; }
.files li:hover .drop, .drop:focus-visible { opacity: 1; }
.drop:hover { color: var(--danger); }

/* An escape hatch, not a call to action: it is offered at the weight of the
   controls around it, and only turns red under the cursor — the moment it is
   about to be used. */
.btn.stop {
  gap: 5px;
  height: 28px;
  padding: 0 11px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--text-muted);
  font-size: var(--fs-xs);
  font-weight: 600;
}
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
</style>
