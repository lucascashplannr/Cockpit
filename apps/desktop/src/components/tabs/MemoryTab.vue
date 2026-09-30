<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { OPEN_QUESTIONS_SECTION, RULED_OUT_SECTION, sectionsFor, signatureAlone, splitSignature } from '@cockpit/shared'
import type { MemoryDoc, MemorySigned, Workspace } from '@cockpit/shared'
import {
  BookDashed, BookX, Check, ChevronDown, ChevronRight, Copy, CornerDownLeft, Info, MessageSquare, Pencil, Save, Trash2,
  X,
} from '@lucide/vue'
import Splitter from '../Splitter.vue'
import {
  LAYOUT_DEFAULTS, LAYOUT_LIMITS, activeAgentScope, askEraseMemory, client, guard, layout, memoryChoiceFor, memoryLabel,
  openConversationByRef, openThreadFor, resetColumnWidth, resetMemorySideHeight, saveLayout,
  setColumnWidth, setMemorySideHeight, state, toast,
} from '../../core/store.js'
import { createMarked } from '../../core/markdown.js'

/**
 * §6 — the layer nobody else builds: the understanding that outlives every
 * conversation. The conversations themselves are in History, at the top right
 * of the thread; the log of what happened is the Journal. The whole point:
 * "vider devient gratuit".
 */

const props = defineProps<{ workspace: Workspace }>()

const doc = ref<MemoryDoc | null>(null)

/* ── which memory ─────────────────────────────────────────────────────────
 *
 * The one the conversation on screen uses — or, before it starts, the one the
 * composer's chip is set to. The name at the top opens every memory of the
 * project, to read one, clean it up or erase it without touching which one
 * the conversation uses.
 */
const bound = computed<string | null>(() => {
  const sc = activeAgentScope.value
  const c = openThreadFor(sc)
  return c ? c.memory : sc ? memoryChoiceFor(sc) : null
})
const viewing = ref<string | null>(null)
const shownId = computed(() => viewing.value ?? bound.value)
/** A memory with a file behind it, rather than "new" or "off". */
const real = computed(() => !!shownId.value && shownId.value !== 'new' && shownId.value !== 'off')
const memories = computed(() => state.memories[props.workspace.projectId] ?? [])
const shownName = computed(() =>
  doc.value && real.value ? doc.value.name : memoryLabel(props.workspace.projectId, shownId.value ?? 'new'),
)
const switcherOpen = ref(false)
const switcherRoot = ref<HTMLElement | null>(null)
function view(id: string | null): void {
  viewing.value = id === bound.value ? null : id
  switcherOpen.value = false
}
watch(bound, () => {
  viewing.value = null
})
const draft = ref('')
const editing = ref(false)
const addText = ref('')
const addSection = ref<string>('Decisions')

/** A topic's memory has a Goal; a project's does not — it has no single one. */
const SECTIONS = computed(() => sectionsFor(props.workspace.topicId ? 'topic' : 'project'))

/* ── the file, read rather than dumped ────────────────────────────────────
 *
 * It stays a markdown file — the agent reads it raw, git diffs it, "Edit raw"
 * opens it as it is. What changes is only how it is drawn: each heading a fold
 * with how much is under it, each `- ` line an entry with a real dot, the
 * template's `_(guidance)_` as a hint beside its heading rather than as body,
 * and the `_(front, 30 Sep, 7QX2M4KD)_` an agent's note is signed with as a
 * quiet tag instead of underscores in the middle of the sentence — one that
 * opens the conversation that wrote it, when the note says which.
 */
const md = createMarked({ breaks: false })

interface Entry {
  /** Rendered, escaped inline markdown — see core/markdown.ts. */
  html: string
  /** Who and when, when the note was signed — and which conversation, since notes say. */
  by: MemorySigned | null
  /** A line that is not a list item — prose, or part of a state written as text. */
  prose: boolean
}
interface Section {
  title: string
  hint: string | null
  entries: Entry[]
  /** The state is signed once, at its foot, rather than per line. */
  by: MemorySigned | null
}

const GUIDANCE = /^_\(([\s\S]*?)\)_$/

function entry(raw: string, prose: boolean): Entry {
  const { text, signed } = splitSignature(raw)
  return { html: md.parseInline(text.trim()) as string, by: signed, prose }
}

function readSection(title: string, body: string): Section {
  const out: Section = { title, hint: null, entries: [], by: null }
  let rest = body.trim()
  // The template's guidance, when it is the first thing under the heading —
  // up to the line that closes it, since the first entry follows it directly.
  if (rest.startsWith('_(')) {
    const end = rest.search(/\)_[ \t]*(\n|$)/)
    const g = end > 0 ? GUIDANCE.exec(rest.slice(0, end + 2)) : null
    if (g && !signatureAlone(g[0])) {
      out.hint = g[1]!.replace(/\s+/g, ' ').trim()
      rest = rest.slice(end + 2).trim()
    }
  }
  let current: string | null = null
  const flush = (prose: boolean) => {
    if (current !== null && current.trim()) out.entries.push(entry(current, prose))
    current = null
  }
  for (const line of rest.split('\n')) {
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      flush(false)
      current = bullet[1]!
      continue
    }
    if (!line.trim()) {
      flush(false)
      continue
    }
    // A signature on a line of its own signs the whole section (the state).
    const alone = signatureAlone(line)
    if (alone) {
      flush(false)
      out.by = alone
      continue
    }
    // An indented line carries on the entry above; anything else is prose.
    if (current !== null && /^\s{2,}/.test(line)) current += ' ' + line.trim()
    else {
      flush(false)
      out.entries.push(entry(line, true))
    }
  }
  flush(false)
  return out
}

/**
 * A signature says which conversation wrote the note, by its title: the
 * repository and the date alone said nothing about which one it was. One that
 * is gone for good falls back to the repository, and leads nowhere.
 */
function source(ref: string) {
  return doc.value?.sources?.[ref] ?? null
}
function about(s: MemorySigned): string {
  const c = s.ref ? source(s.ref) : null
  if (!c) return s.by + ', ' + s.date
  return '"' + c.title + '" — ' + s.by + ', ' + s.date + (c.removed ? ' · removed, kept for this memory' : '') + '. Open it'
}

/** The note's signature, followed back to the conversation that wrote it. */
function follow(ref: string): void {
  void openConversationByRef(props.workspace.projectId, ref)
}

const sections = computed<Section[]>(() => (doc.value?.sections ?? []).map((x) => readSection(x.title, x.body)))

/**
 * Which sections are folded, by title, kept across launches: how much of the
 * memory you want in front of you is a habit, not a property of one file.
 * An empty section has nothing to unfold and is always drawn folded.
 */
const FOLD_KEY = 'cockpit.memoryFolds'
const folded = ref<Record<string, boolean>>(readFolds())
function readFolds(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}') as Record<string, boolean>
  } catch {
    return {}
  }
}
function toggle(title: string): void {
  folded.value = { ...folded.value, [title]: !folded.value[title] }
  try {
    localStorage.setItem(FOLD_KEY, JSON.stringify(folded.value))
  } catch {
    /* a preference: forgetting it costs a click */
  }
}
const isOpen = (x: Section) => x.entries.length > 0 && !folded.value[x.title]

/* ── the memory against its side ──────────────────────────────────────────
 *
 * The same boundary the Code tab has between its tree and its editor, and the
 * same handle on it: beside when there is room, under it when there is not,
 * and where the line was left is kept — a width and a height apart, since the
 * one says nothing about the other.
 */
const root = ref<HTMLElement | null>(null)
const stacked = ref(false)
const panelW = ref(0)
const panelH = ref(0)
const sideMax = computed(() =>
  Math.max(LAYOUT_LIMITS.memorySide.min, Math.min(LAYOUT_LIMITS.memorySide.max, panelW.value - 320)),
)
const sideHMax = computed(() =>
  Math.max(LAYOUT_LIMITS.memorySideHeight.min, Math.min(LAYOUT_LIMITS.memorySideHeight.max, panelH.value - 140)),
)
const sideW = computed(() => Math.min(layout.memorySide, sideMax.value))
/** Null while it has never been dragged: then it is as tall as the form in it. */
const sideH = computed(() =>
  layout.memorySideHeight === null ? null : Math.min(layout.memorySideHeight, sideHMax.value),
)
const side = ref<HTMLElement | null>(null)
/** What the handle reports as the side's height when it has none of its own. */
const sideMeasured = ref(0)
/** Where the line holds on the way past: half, and the default. */
const sideSnaps = computed(() => [Math.round(panelW.value / 2), LAYOUT_DEFAULTS.memorySide])
const sideHSnaps = computed(() => [Math.round(panelH.value / 2)])

let ro: ResizeObserver | null = null
onMounted(() => {
  // Two things watched, one callback: only the tab's own box decides how the
  // two halves are laid out; the side's own size only feeds its handle.
  ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      if (e.target !== root.value) continue
      stacked.value = e.contentRect.width < 620
      panelW.value = e.contentRect.width
      panelH.value = e.contentRect.height
    }
    sideMeasured.value = side.value?.offsetHeight ?? 0
  })
  if (root.value) ro.observe(root.value)
  if (side.value) ro.observe(side.value)
  document.addEventListener('mousedown', onDocDown)
  document.addEventListener('keydown', onDocKey)
})
onBeforeUnmount(() => {
  ro?.disconnect()
  document.removeEventListener('mousedown', onDocDown)
  document.removeEventListener('keydown', onDocKey)
})

/* ── the file, named at the top ───────────────────────────────────────────
 *
 * As in the Code tab: the name, the rest of what is known about it behind ⓘ,
 * and the way to change it at the right edge — a pen to open it raw, Save and
 * a way back out once it is open.
 */
const detailRoot = ref<HTMLElement | null>(null)
const head = ref<HTMLElement | null>(null)
const detailOpen = ref(false)
/**
 * Where the card opens, against ⓘ. ⓘ sits after the memory's name, so it is
 * wherever the name ends — and a card hung from it at a fixed offset ran past
 * the panel's edge and cut the path off mid-word. Under ⓘ when it fits;
 * pulled back inside the header when it does not.
 */
const detailBox = ref<{ left: string; width: string }>({ left: '-6px', width: '300px' })
function toggleDetail(): void {
  detailOpen.value = !detailOpen.value
  if (!detailOpen.value || !head.value || !detailRoot.value) return
  const h = head.value.getBoundingClientRect()
  const at = detailRoot.value.getBoundingClientRect()
  const width = Math.min(340, h.width - 16)
  const left = Math.max(h.left + 8, Math.min(at.left - 6, h.right - 8 - width))
  detailBox.value = { left: left - at.left + 'px', width: width + 'px' }
}
const dirty = computed(() => editing.value && draft.value !== (doc.value?.content ?? ''))

function since(ts: number): string {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60_000))
  if (m < 1) return 'just now'
  if (m < 60) return m + 'm ago'
  const h = Math.round(m / 60)
  if (h < 24) return h + 'h ago'
  return Math.round(h / 24) + 'd ago'
}

async function copyPath() {
  if (!doc.value) return
  await navigator.clipboard.writeText(doc.value.path)
  detailOpen.value = false
  toast('info', 'Path copied')
}

function onDocDown(e: MouseEvent) {
  if (detailRoot.value && !detailRoot.value.contains(e.target as Node)) detailOpen.value = false
  if (switcherRoot.value && !switcherRoot.value.contains(e.target as Node)) switcherOpen.value = false
}
function onDocKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    detailOpen.value = false
    switcherOpen.value = false
  }
  // ⌘S saves here as it does in the Code tab — only while the file is open.
  if (editing.value && e.key === 's' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    if (dirty.value) void save()
  }
}

function startEdit() {
  draft.value = doc.value?.content ?? ''
  editing.value = true
}

function cancelEdit() {
  editing.value = false
  draft.value = doc.value?.content ?? ''
}

async function load() {
  editing.value = false
  if (!real.value) {
    doc.value = null
    draft.value = ''
    return
  }
  const id = shownId.value!
  const d = await guard(() => client.call('memory.read', { workspaceId: props.workspace.id, memoryId: id }))
  // Only if it is still the one asked for: switching fast must not land on the last answer.
  if (shownId.value !== id) return
  doc.value = d ?? null
  draft.value = d?.content ?? ''
}

async function save() {
  const r = await guard(
    () => client.call('memory.write', { workspaceId: props.workspace.id, content: draft.value, memoryId: doc.value?.id }),
    'memory saved',
  )
  if (r) {
    editing.value = false
    await load()
  }
}

/**
 * By hand, into the section it belongs in — the same thing an agent's
 * `memory_note` does, minus the signature: a line a person wrote is theirs.
 */
async function add() {
  const text = addText.value.trim()
  if (!text) return
  const r = await guard(() =>
    client.call('memory.promote', {
      workspaceId: props.workspace.id,
      section: addSection.value,
      text,
      memoryId: doc.value?.id,
    }),
  )
  if (r) {
    addText.value = ''
    toast('ok', 'added to ' + addSection.value)
    await load()
  }
}

/** What each section is for, said where you are about to write into it. */
const PLACEHOLDER: Record<string, string> = {
  Goal: 'What this work is for.',
  Decisions: 'Something settled — and why.',
  Contracts: 'An endpoint, payload or file other code relies on — and where it lives.',
  Constraints: 'Something that must not break.',
  'Ruled out': 'An approach dropped — and why.',
  State: 'Where the work stands.',
  'Open questions': 'Something undecided — and what hangs on it.',
}

/**
 * An agent writes the memory while you watch: the tool follows, as long as
 * the raw file is not open under your cursor.
 */
watch(
  () => state.events[state.events.length - 1],
  (e) => {
    if (!e || editing.value) return
    if (e.type === 'memory.promoted' || e.type === 'memory.written') void load()
  },
)

watch([() => props.workspace.id, shownId], load, { immediate: true })
</script>

<template>
  <div
    ref="root"
    class="mem"
    :class="{ stacked }"
    :style="{ '--side-w': sideW + 'px', '--side-h': sideH === null ? 'auto' : sideH + 'px' }"
  >
    <div class="main">
      <!-- Only over a memory there is: with none, a name and a menu of other
           memories is a question the empty screen below already answers. -->
      <div v-if="real" ref="head" class="ehead">
        <div ref="switcherRoot" class="switcher">
          <button
            class="mname"
            :class="{ open: switcherOpen, other: !!viewing }"
            :title="viewing ? 'Another memory than this conversation\'s' : 'This conversation\'s memory — every memory of the project is here'"
            @click="switcherOpen = !switcherOpen"
          >
            <span class="mn">{{ shownName }}</span>
            <ChevronDown class="mchev" />
          </button>
          <ul v-if="switcherOpen" class="menu mmenu">
            <li v-if="viewing && bound">
              <button @click="view(bound)"><ChevronRight class="back" />Back to this conversation's</button>
            </li>
            <li v-for="m in memories" :key="m.id">
              <button @click="view(m.id)">
                <Check class="tick" :class="{ hidden: m.id !== shownId }" />
                <span class="mnm">{{ m.name }}</span>
                <span class="mhint">{{ m.entries }} {{ m.entries === 1 ? 'note' : 'notes' }} · {{ since(m.updatedAt) }}</span>
              </button>
            </li>
            <li v-if="!memories.length" class="mnone">No memory in this project yet.</li>
          </ul>
        </div>
        <div v-if="doc" ref="detailRoot" class="ename">
          <span v-if="dirty" class="edirty" title="Unsaved changes" aria-label="Unsaved changes" />
          <button
            class="icon-btn einfo"
            :class="{ on: detailOpen }"
            title="About this file"
            aria-label="About this file"
            :aria-expanded="detailOpen"
            @click="toggleDetail"
          >
            <Info />
          </button>
          <div v-if="detailOpen" class="menu edetail" :style="detailBox" role="dialog" aria-label="About this file">
            <div class="dpath mono selectable">{{ doc.path }}</div>
            <dl class="dfacts">
              <dt>Modified</dt>
              <dd>{{ doc.updatedAt ? since(doc.updatedAt) : 'not written yet' }}</dd>
            </dl>
            <div class="rule" />
            <button @click="copyPath"><Copy />Copy path</button>
          </div>
        </div>
        <span class="grow" />
        <template v-if="editing">
          <button class="icon-btn eact" title="Cancel" aria-label="Cancel" @click="cancelEdit">
            <X />
          </button>
          <button
            class="icon-btn eact esave"
            :class="{ due: dirty }"
            :disabled="!dirty"
            title="Save (⌘S)"
            aria-label="Save"
            @click="save"
          >
            <Save />
          </button>
        </template>
        <template v-else-if="doc">
          <!-- Only when there is something to lose: an empty form has nothing to erase. -->
          <button
            v-if="sections.some((x) => x.entries.length) || doc.kind === 'named'"
            class="icon-btn eact erase"
            title="Erase this memory"
            aria-label="Erase this memory"
            @click="askEraseMemory(workspace.id, doc)"
          >
            <Trash2 />
          </button>
          <button class="icon-btn eact" title="Edit raw" aria-label="Edit raw" @click="startEdit">
            <Pencil />
          </button>
        </template>
      </div>

      <!-- Never "no memory": every topic and project has one from the start,
           and the empty form is what says where things go. -->
      <!-- A conversation with no memory yet, or none at all: said plainly,
           with the way to another one right above it. -->
      <div v-if="!real" class="nomem">
        <template v-if="shownId === 'off'">
          <BookX />
          <strong>No memory</strong>
          <span>This conversation reads none and writes none. Pick one from the Memory chip when you start the next.</span>
        </template>
        <template v-else>
          <BookDashed />
          <strong>No memory yet</strong>
          <span>It begins with the agent's first note, named after this conversation.</span>
        </template>
      </div>
      <template v-else-if="!editing">
        <div class="doc">
          <section
            v-for="x in sections"
            :key="x.title"
            class="sec"
            :class="{
              discarded: x.title === RULED_OUT_SECTION,
              asks: x.title === OPEN_QUESTIONS_SECTION,
              blank: !x.entries.length,
              open: isOpen(x),
            }"
          >
            <button class="shead" :disabled="!x.entries.length" :aria-expanded="isOpen(x)" @click="toggle(x.title)">
              <ChevronRight class="sm chev" />
              <span class="stitle">{{ x.title }}</span>
              <span v-if="x.entries.length" class="count num">{{ x.entries.length }}</span>
              <!-- What goes here, from the file's own guidance — and for Ruled
                   out, why it matters: §6's "la section la plus précieuse". -->
              <span v-if="!isOpen(x) || !x.entries.length" class="hint">{{
                x.title === RULED_OUT_SECTION ? 'what stops a new conversation re-proposing it' : x.hint
              }}</span>
            </button>
            <ul v-if="isOpen(x)" class="entries selectable">
              <li v-for="(e, i) in x.entries" :key="i" :class="{ prose: e.prose }">
                <!-- Escaped by the renderer: raw HTML in the file comes out as text. -->
                <span class="etext" v-html="e.html" />
                <button
                  v-if="e.by?.ref && source(e.by.ref)"
                  class="by link"
                  :title="about(e.by)"
                  @click="follow(e.by.ref)"
                >
                  <MessageSquare class="bic" /><span class="bwho">{{ source(e.by.ref)!.title }}</span><span class="bwhen">{{ e.by.date }}</span>
                </button>
                <span v-else-if="e.by" class="by">
                  <span class="bwho">{{ e.by.by }}</span><span class="bwhen">{{ e.by.date }}</span>
                </span>
              </li>
              <li v-if="x.by" class="signed">
                <button
                  v-if="x.by.ref && source(x.by.ref)"
                  class="by link"
                  :title="about(x.by)"
                  @click="follow(x.by.ref)"
                >
                  <MessageSquare class="bic" /><span class="bwho">{{ source(x.by.ref)!.title }}</span><span class="bwhen">{{ x.by.date }}</span>
                </button>
                <span v-else class="by"><span class="bwho">{{ x.by.by }}</span><span class="bwhen">{{ x.by.date }}</span></span>
              </li>
            </ul>
          </section>

          <!-- A file with none of the memory's headings in it. -->
          <p v-if="!sections.length" class="none">
            Nothing under any of the memory's headings — open it raw to see the file as it is.
          </p>
        </div>
      </template>

      <template v-else>
        <textarea v-model="draft" class="editor mono selectable" spellcheck="false" />
      </template>
    </div>

    <Splitter
      v-if="real && !stacked"
      :style="{ left: panelW - sideW - 3 + 'px' }"
      :size="sideW"
      :min="LAYOUT_LIMITS.memorySide.min"
      :max="sideMax"
      grows="left"
      :snap="sideSnaps"
      label="Width of the memory's side"
      @resize="setColumnWidth('memorySide', $event)"
      @done="saveLayout"
      @reset="resetColumnWidth('memorySide')"
    />
    <Splitter
      v-else-if="real"
      :size="sideH ?? sideMeasured"
      :min="LAYOUT_LIMITS.memorySideHeight.min"
      :max="sideHMax"
      grows="up"
      :snap="sideHSnaps"
      label="Height of the form under the memory"
      @resize="setMemorySideHeight($event)"
      @done="saveLayout"
      @reset="resetMemorySideHeight"
    />

    <aside v-show="real" ref="side" class="side">
      <!-- The composer's shape, at the size of a note: what you write, the
           section it goes into, and the one act. -->
      <div class="well">
        <textarea
          v-model="addText"
          class="input note selectable"
          rows="3"
          :placeholder="PLACEHOLDER[addSection] ?? 'Something the next conversation should know.'"
          @keydown.meta.enter.prevent="add"
        />
        <div class="wfoot">
          <label class="pick" title="The section it goes into">
            <select v-model="addSection" aria-label="Section">
              <option v-for="t in SECTIONS" :key="t" :value="t">{{ t }}</option>
            </select>
            <ChevronRight class="xs pchev" />
          </label>
          <span class="grow" />
          <button
            class="btn primary go"
            :disabled="!addText.trim()"
            :title="'Add to ' + addSection + ' (⌘⏎)'"
            :aria-label="'Add to ' + addSection"
            @click="add"
          >
            <CornerDownLeft class="ic" />
          </button>
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
/* The document, and the box that adds to it — side by side, or stacked
   under 620 the way the Code tab stacks its tree. The line between them is a
   handle (Splitter), so the split is sized by the person reading, not by us:
   the side keeps a width beside the memory and a height under it. */
.mem { position: relative; display: flex; height: 100%; }
.mem.stacked { flex-direction: column; }

.main { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; container: memdoc / inline-size; }
.doc { flex: 1; overflow-y: auto; padding: 24px 28px 44px; max-width: 800px; }
.mem.stacked .doc { padding: 18px 18px 30px; }

/* The file, named at the top — the Code tab's header, measure for measure. */
.ehead {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 40px;
  padding: 0 8px 0 14px;
  border-bottom: 1px solid var(--line);
}
.ename { position: relative; min-width: 0; display: flex; align-items: center; gap: 2px; }

/* The memory's name, and every other one behind it. The pull to the left is
   the wrapper's: on the button, it made the button 4px wider than the box
   that sizes it, and `max-width: 100%` clipped the name by exactly that. */
.switcher { position: relative; min-width: 0; margin-left: -6px; }
.mname {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  height: 30px;
  padding: 0 8px 0 6px;
  border-radius: var(--radius-sm);
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text);
}
.mname:hover, .mname.open { background: var(--hover); }
/* Reading another memory than the conversation's: said by the name itself. */
.mname.other .mn { color: var(--accent); }
.mn { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mchev { flex: none; width: 14px; height: 14px; color: var(--text-dim); }
.mmenu {
  top: calc(100% + 6px);
  left: 0;
  width: 320px;
  max-width: calc(100cqw - 16px);
  max-height: 340px;
  overflow-y: auto;
  list-style: none;
  padding: 5px;
}
.mmenu .tick { width: 12px; height: 12px; color: var(--accent); }
.mmenu .tick.hidden { visibility: hidden; }
.mmenu .back { transform: rotate(180deg); }
.mmenu button { display: flex; align-items: center; gap: 7px; width: 100%; }
.mnm { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mhint { flex: none; margin-left: auto; padding-left: 14px; font-size: 10px; color: var(--text-dim); white-space: nowrap; }
.mnone { padding: 6px 9px; font-size: var(--fs-xs); color: var(--text-dim); }

/* The Docs and Diff tabs' empty screen: the thing that is missing, drawn
   quietly, what it is, and one sentence on how it comes to be. */
.nomem {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  /* A short measure: two or three lines of a sentence, not one line of the
     panel's width. */
  max-width: 300px;
  /* Auto on every side, in a column that is the panel's full height: the
     middle of the panel, however tall it is. */
  margin: auto;
  padding: 0 40px 24px;
  text-align: center;
  font-size: var(--fs-sm);
  line-height: 1.5;
  color: var(--text-muted);
}
.nomem .lucide { width: 22px; height: 22px; margin-bottom: 8px; color: var(--text-dim); }
.nomem strong { color: var(--text); }
.ep {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.edirty {
  flex: none;
  width: 7px;
  height: 7px;
  margin: 0 3px 0 5px;
  border-radius: 50%;
  background: var(--warn);
}
.einfo { width: 24px; height: 24px; }
.einfo .lucide { width: 13px; height: 13px; }
.einfo.on { background: var(--active); color: var(--text); }
.edetail {
  top: calc(100% + 6px);
  min-width: 0;
  padding: 10px 5px 5px;
}
.dpath {
  padding: 0 9px;
  font-size: var(--fs-xs);
  color: var(--text);
  overflow-wrap: anywhere;
}
.dfacts {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 5px 14px;
  margin: 10px 0 4px;
  padding: 0 9px;
  font-size: var(--fs-xs);
}
.dfacts dt { color: var(--text-dim); }
.dfacts dd { margin: 0; color: var(--text-muted); }
.eact { width: 26px; height: 26px; }
.eact .lucide { width: 14px; height: 14px; }
/* Only worth pressing when there is something to write; then it says so. */
.esave.due { color: var(--accent); }
.erase:hover:not(:disabled) { color: var(--danger); }

/* A heading is a fold: the chevron, the name, how much is under it. Closed,
   or empty, it says what goes there instead. */
.sec + .sec { margin-top: 6px; }
.shead {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  padding: 6px 8px 6px 4px;
  margin-left: -4px;
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--text);
}
.shead:hover:not(:disabled) { background: var(--hover); }
.shead:disabled { cursor: default; opacity: 1; }
.chev {
  flex: none;
  align-self: center;
  color: var(--text-dim);
  transition: transform var(--dur-1) var(--ease-soft);
}
.sec.open .chev { transform: rotate(90deg); }
.sec.blank .chev { opacity: 0.35; }
.stitle { flex: none; font-size: var(--fs-md); font-weight: 650; letter-spacing: 0.01em; }
.sec.blank .stitle { color: var(--text-muted); font-weight: 560; }
.count {
  flex: none;
  min-width: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--active);
  font-size: 10px;
  line-height: 16px;
  text-align: center;
  color: var(--text-muted);
}
.hint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.sec.discarded .stitle { color: var(--accent); }

/* Entries: a real list, one dot each — the accent's for Ruled out, which is
   the section that pays for itself. */
.entries {
  list-style: none;
  margin: 2px 0 12px;
  padding: 0 0 0 26px;
  font-size: var(--fs-md);
  line-height: 1.55;
  color: var(--text-muted);
}
.entries li { position: relative; padding: 3px 0; overflow-wrap: anywhere; }
.entries li:not(.prose):not(.signed)::before {
  content: '';
  position: absolute;
  left: -14px;
  top: calc(3px + 0.775em - 2.5px);
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--text-dim);
}
.sec.discarded .entries li:not(.prose):not(.signed)::before { background: var(--accent); }
/* Amber is the app's word for "waiting on you" — which is what a question is. */
.sec.asks .entries li:not(.prose):not(.signed)::before { background: var(--warn); }
.sec.asks:not(.blank) .stitle { color: var(--warn); }
.etext :deep(code) {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--active);
  font-family: var(--mono);
  font-size: 0.88em;
  color: var(--text);
}
.etext :deep(strong) { color: var(--text); }
/* Who wrote it and when, at the weight of a footnote: no box, the name a
   touch firmer than the date. One that says which conversation wrote it
   carries a speech mark and opens that conversation — the box only comes
   up under the pointer, where it says "this can be pressed". */
.by {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: 4px;
  padding: 1px 6px;
  border-radius: 5px;
  font: inherit;
  font-size: 11.5px;
  line-height: 18px;
  color: var(--text-dim);
  white-space: nowrap;
  vertical-align: 1px;
}
.bwho { font-weight: 550; }
/* A conversation's title is a sentence: it gets a measure, not the line. */
.by.link .bwho { max-width: 30ch; overflow: hidden; text-overflow: ellipsis; }
.bic { flex: none; width: 12px; height: 12px; }
.by.link { cursor: pointer; transition: background var(--dur-1) var(--ease-soft), color var(--dur-1) var(--ease-soft); }
.by.link:hover { background: var(--hover); color: var(--text-muted); }
.by.link:hover .bwho { color: var(--text); }
.signed { padding-top: 6px; }
.signed .by { margin-left: -6px; }
.none { margin: 0; color: var(--text-dim); font-size: var(--fs-sm); }

.editor {
  flex: 1;
  min-height: 0;
  margin: 12px 16px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface-review);
  color: var(--text);
  font-size: var(--fs-sm);
  line-height: 1.6;
  resize: none;
}

.grow { flex: 1; min-width: 0; }

.side {
  flex: none;
  width: var(--side-w, 310px);
  border-left: 1px solid var(--line);
  background: var(--surface-review);
  overflow-y: auto;
  padding: 12px;
}
.mem.stacked .side {
  width: auto;
  height: var(--side-h, auto);
  border-left: none;
  border-top: 1px solid var(--line);
}
/* The composer's well, at the size of a note. */
.well {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface-input);
  padding: 6px 8px 8px 10px;
}
.note {
  display: block;
  width: 100%;
  padding: 4px 2px;
  border: none;
  background: transparent;
  font-size: var(--fs-sm);
  line-height: 1.6;
  resize: none;
}
.note:focus { box-shadow: none; border-color: transparent; background: transparent; }
.wfoot { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
/* The section, worn like the composer's option chips — a size up, to stand
   the same height as the button beside it. */
.pick {
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 28px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg);
}
.pick:hover { background: var(--hover); }
.pick select {
  appearance: none;
  height: 100%;
  padding: 0 28px 0 11px;
  border: none;
  background: transparent;
  font: inherit;
  font-size: 12.5px;
  color: var(--text-muted);
  cursor: pointer;
}
.pick select:focus { outline: none; }
.pchev { position: absolute; right: 9px; transform: rotate(90deg); color: var(--text-dim); pointer-events: none; }
.go { width: 32px; height: 28px; padding: 0; }
.go .ic { width: 15px; height: 15px; }

</style>
