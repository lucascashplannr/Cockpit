<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import {
  BookMarked, BookOpen, Bot, Check, ChevronDown, ChevronRight, FileText, FolderGit2, Layers, Paperclip, Plug, Puzzle, Search,
  Sparkles, Wrench,
} from '@lucide/vue'
import type { AgentScope, Conversation } from '@cockpit/shared'
import { chooseMemory, memoryLabel, state, toggleProjectRepo, widenProject } from '../../core/store.js'
import { fuzzyFilter, highlight } from '../../core/fuzzy.js'
import { useAgentContext } from './agentContext.js'

/**
 * What the agent gets, at the start of the settings row: the clip on its own,
 * then the context as one of the row's pickers.
 *
 * The context half says where it runs and which memory. It opens a menu of
 * everything the agent is given — one row each — and a row opens its own
 * flyout beside the menu: the repositories to tick, the memories to pick from,
 * or what Claude loaded (instructions, skills, MCP servers…), to read.
 */
const props = defineProps<{
  session?: Conversation | null
  scope?: AgentScope | null
  sources?: { workspaceId: string; name: string; path: string }[]
  guides: { repo: string; rel: string }[]
  started: boolean
}>()
const emit = defineEmits<{ attach: [] }>()

const ctx = useAgentContext(props)
const { narrowing, narrowed, reposEditable, reposValue, memoryEditable, memoryId, memoryName, memoryNotes, loadout, borrowed, projectId } = ctx

const memoryShown = computed(() => (memoryId.value === 'off' ? 'No memory' : memoryName.value))

/* ── the rows ─────────────────────────────────────────────────────────── */

type Key = 'repos' | 'memory' | 'guides' | 'docs' | 'skills' | 'mcp' | 'plugins' | 'agents' | 'tools'
interface RowDef {
  key: Key
  label: string
  icon: unknown
  value: string
  /** Only when there is a choice to make or more than one thing to see:
   *  a single fact is said on the row itself, its detail in the tooltip. */
  opens: boolean
  title?: string
  lit?: boolean
  bad?: boolean
}

const docs = computed(() => state.docsInfo[projectId.value ?? ''] ?? null)
const builtIn = computed(() => loadout.value?.tools.filter((t) => !t.startsWith('mcp__')) ?? [])
const NOT_YET = 'Shows once a conversation in this project has started'

/**
 * A list's row: its count when there are several, the one name when there is
 * one, None when there are none — and only the first of those opens.
 */
function listRow(key: Key, label: string, icon: unknown, names: string[] | undefined, one?: (n: string) => string): RowDef {
  if (!names) return { key, label, icon, value: '–', opens: false, title: NOT_YET }
  if (names.length === 0) return { key, label, icon, value: 'None', opens: false }
  if (names.length === 1) return { key, label, icon, value: names[0]!, opens: false, title: one?.(names[0]!) }
  return { key, label, icon, value: String(names.length), opens: true }
}

const chosen = computed<RowDef[]>(() => {
  const srcs = props.sources ?? []
  const reposOpen = reposEditable.value || srcs.length > 1 || extraDirs.value.length > 0
  return [
    {
      key: 'repos', label: 'Repositories', icon: FolderGit2, value: reposValue.value, lit: narrowed.value,
      opens: reposOpen,
      title: reposOpen ? undefined : srcs.map((x) => x.path).join('\n') + (props.started ? '\nFixed when the conversation started' : ''),
    },
    {
      key: 'memory', label: 'Memory', icon: BookMarked, value: memoryShown.value,
      opens: memoryEditable.value,
      title: memoryEditable.value
        ? undefined
        : (memoryNotes.value !== null ? memoryNotes.value + (memoryNotes.value === 1 ? ' note' : ' notes') + '\n' : '') +
          'Fixed when the conversation started',
    },
  ]
})
const brought = computed<RowDef[]>(() => {
  const l = loadout.value
  const d = docs.value
  return [
    listRow('guides', 'Instructions', FileText, props.guides.map((g) => g.rel), () => 'In ' + props.guides[0]!.repo + ' — read at the start of every conversation'),
    {
      key: 'docs', label: 'Docs', icon: BookOpen, opens: false,
      value: d ? [d.repo, d.folder].filter(Boolean).join('/') : 'None', title: d?.path,
    },
    listRow('skills', 'Skills', Sparkles, l?.skills),
    {
      ...listRow('mcp', 'MCP servers', Plug, l?.mcp.map((m) => m.name), () => mcpRows.value[0]!.hint),
      bad: !!l?.mcp.some((m) => m.status === 'failed'),
    },
    listRow('plugins', 'Plugins', Puzzle, l?.plugins.map((p) => p.name)),
    listRow('agents', 'Sub-agents', Bot, l?.agents),
    { ...listRow('tools', 'Tools', Wrench, l ? builtIn.value : undefined), title: l ? 'git push and git commit are refused' : NOT_YET },
  ]
})

/* ── memory ───────────────────────────────────────────────────────────── */

interface MemoryOption { id: string; label: string; hint?: string; title?: string }
const fixed = computed<MemoryOption[]>(() => {
  const sc = props.scope
  const out: MemoryOption[] = []
  if (sc?.kind === 'topic') out.push({ id: 'topic:' + sc.topicId, label: memoryLabel(projectId.value, 'topic:' + sc.topicId), hint: 'this topic' })
  out.push({ id: 'new', label: 'New memory', title: 'Starts with its first note' }, { id: 'off', label: 'No memory' })
  return out
})
const existing = computed<MemoryOption[]>(() =>
  (state.memories[projectId.value ?? ''] ?? [])
    .filter((m) => !fixed.value.some((f) => f.id === m.id))
    .map((m) => ({ id: m.id, label: m.name, hint: m.entries + (m.entries === 1 ? ' note' : ' notes') })),
)
const query = ref('')
const cursor = ref(-1)
const found = computed(() => {
  const term = query.value.trim()
  if (!term) return existing.value.map((option) => ({ option, positions: [] as number[] }))
  return fuzzyFilter(existing.value, term, (o) => o.label, 200).map((s) => ({ option: s.item, positions: s.positions }))
})
watch(query, () => (cursor.value = query.value.trim() ? 0 : -1))
function pickMemory(id: string | undefined): void {
  if (!id || !props.scope) return
  chooseMemory(props.scope, id)
  close()
}
function move(by: number): void {
  const n = found.value.length
  if (!n) return
  cursor.value = (cursor.value + by + n) % n
  void nextTick(() => root.value?.querySelector('.fly .it.cur')?.scrollIntoView({ block: 'nearest' }))
}

/* ── Claude's own lists ───────────────────────────────────────────────── */

/** `anthropic-skills:pdf` → `pdf` under `anthropic-skills`; the ungrouped first. */
function grouped(names: string[]): { from: string; names: string[] }[] {
  const out: { from: string; names: string[] }[] = []
  for (const full of names) {
    const at = full.indexOf(':')
    const from = at < 0 ? '' : full.slice(0, at)
    let g = out.find((x) => x.from === from)
    if (!g) out.push((g = { from, names: [] }))
    g.names.push(at < 0 ? full : full.slice(at + 1))
  }
  return out.sort((a, b) => (a.from ? 1 : 0) - (b.from ? 1 : 0))
}
const mcpRows = computed(() =>
  (loadout.value?.mcp ?? []).map((m) => {
    const tools = loadout.value!.tools.filter((t) => t.startsWith('mcp__' + m.name + '__')).length
    return {
      name: m.name,
      hint: m.status === 'connected' ? tools + (tools === 1 ? ' tool' : ' tools') : m.status,
      dot: m.status === 'connected' ? 'ok' : m.status === 'failed' ? 'bad' : 'dim',
    }
  }),
)
const extraDirs = computed(() => {
  const srcs = props.sources ?? []
  const l = props.session?.loadout
  return l ? l.dirs.filter((d) => !srcs.some((s) => s.path === d) && !d.includes('/attachments')) : []
})
const home = (p: string) => p.replace(/^\/Users\/[^/]+/, '~')

function ago(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return m + 'm ago'
  const h = Math.floor(m / 60)
  return h < 24 ? h + 'h ago' : Math.floor(h / 24) + 'd ago'
}
const foot = computed(() => {
  const l = loadout.value
  return l ? (l.version ? 'Claude ' + l.version + ' · ' : '') + ago(l.at) : ''
})

/* ── opening, the flyout, closing ─────────────────────────────────────── */

const open = ref(false)
const sub = ref<Key | null>(null)
const subTop = ref(0)
const root = ref<HTMLElement | null>(null)
const fly = ref<HTMLElement | null>(null)
let hoverTimer: ReturnType<typeof setTimeout> | null = null

function close(): void {
  open.value = false
}
function toggle(): void {
  open.value = !open.value
}

/** Beside its row, then pulled back inside the window if it would spill. */
async function place(key: Key): Promise<void> {
  const row = root.value?.querySelector<HTMLElement>('.menu .row[data-k="' + key + '"]')
  subTop.value = row ? row.offsetTop - 6 : 0
  await nextTick()
  const r = fly.value?.getBoundingClientRect()
  if (!r) return
  const over = r.bottom - (window.innerHeight - 10)
  if (over > 0) subTop.value -= over
  if (r.top - over < 10) subTop.value += 10 - (r.top - over)
}
function show(key: Key): void {
  if (hoverTimer) clearTimeout(hoverTimer)
  hoverTimer = null
  if (sub.value === key) return
  query.value = ''
  sub.value = key
  void place(key).then(() => {
    if (key === 'memory') root.value?.querySelector<HTMLInputElement>('.fly .find input')?.focus()
  })
}
/** A short wait on hover, so crossing a row on the way into a flyout keeps it. */
function hover(key: Key): void {
  if (hoverTimer) clearTimeout(hoverTimer)
  hoverTimer = setTimeout(() => show(key), sub.value ? 140 : 60)
}
/** Onto a row that opens nothing: the open flyout goes, after the same wait. */
function leave(): void {
  if (hoverTimer) clearTimeout(hoverTimer)
  hoverTimer = setTimeout(() => (sub.value = null), 140)
}
function holdFlyout(): void {
  if (hoverTimer) clearTimeout(hoverTimer)
  hoverTimer = null
}

function onDocDown(ev: MouseEvent): void {
  if (!root.value?.contains(ev.target as Node)) close()
}
/** Innermost first: Escape takes the flyout, then the menu, and nothing behind. */
function onKey(ev: KeyboardEvent): void {
  if (ev.key !== 'Escape') return
  ev.stopImmediatePropagation()
  ev.preventDefault()
  if (sub.value) sub.value = null
  else close()
}
watch(open, (isOpen) => {
  if (isOpen) {
    document.addEventListener('mousedown', onDocDown)
    window.addEventListener('keydown', onKey, true)
  } else {
    sub.value = null
    query.value = ''
    document.removeEventListener('mousedown', onDocDown)
    window.removeEventListener('keydown', onKey, true)
  }
})
onBeforeUnmount(() => {
  if (hoverTimer) clearTimeout(hoverTimer)
  document.removeEventListener('mousedown', onDocDown)
  window.removeEventListener('keydown', onKey, true)
})

const title = computed(
  () =>
    'Runs in: ' + reposValue.value + '\nMemory: ' + memoryShown.value +
    (props.started ? '\nBoth fixed when the conversation started' : ''),
)
</script>

<template>
  <div ref="root" class="ctx">
    <!-- Two controls: the clip on its own, then the context drawn as one of
         the row's pickers (Opus 5.5, Effort…), chevron and all. -->
    <div class="pair">
      <button class="clip" title="Attach images or files" aria-label="Attach images or files" @click="emit('attach')">
        <Paperclip />
      </button>
      <button class="what" :class="{ open, narrowed }" :title="title" aria-label="What the agent gets" @click="toggle">
        <Layers class="lead" />
        <span class="v">{{ reposValue }}</span>
        <span class="sep">·</span>
        <span class="v mem">{{ memoryShown }}</span>
        <ChevronDown class="chev-d" />
      </button>
    </div>

    <div v-if="open" class="menu">
      <template v-for="(group, gi) in [chosen, brought]" :key="gi">
        <span v-if="gi === 1" class="rule" />
        <button
          v-for="r in group"
          :key="r.key"
          class="row"
          :data-k="r.key"
          :class="{ on: sub === r.key, still: !r.opens }"
          :title="r.title"
          @mouseenter="r.opens ? hover(r.key) : leave()"
          @click="r.opens && show(r.key)"
        >
          <component :is="r.icon" class="ic" />
          <span class="lbl">{{ r.label }}</span>
          <span class="val" :class="{ lit: r.lit, bad: r.bad }">{{ r.value }}</span>
          <ChevronRight v-if="r.opens" class="chev" />
          <span v-else class="chev" />
        </button>
      </template>
      <p v-if="foot" class="foot" :title="borrowed ? 'What Claude loaded in the latest conversation of this project — this one has not started yet' : 'What Claude loaded when this conversation started'">{{ foot }}</p>

      <!-- The flyout: beside the menu, level with its row. -->
      <div v-if="sub" ref="fly" class="fly" :class="'k-' + sub" :style="{ top: subTop + 'px' }" @mouseenter="holdFlyout">
        <!-- Repositories -->
        <template v-if="sub === 'repos'">
          <template v-if="reposEditable && narrowing">
            <button
              v-for="w in narrowing.every"
              :key="w.id"
              class="it"
              :title="narrowing.picked.length === 1 && narrowing.picked[0] === w.id ? 'The last one stays: a conversation needs somewhere to run' : w.path"
              @click="toggleProjectRepo(w.id)"
            >
              <span class="box" :class="{ on: narrowing.picked.includes(w.id) }"><Check v-if="narrowing.picked.includes(w.id)" /></span>
              <span class="nm">{{ ctx.repoName(w.name) }}</span>
              <span v-if="w.git?.branch" class="k">{{ w.git.branch }}</span>
            </button>
            <template v-if="narrowing.narrowed">
              <span class="rule" />
              <button class="it" @click="widenProject(narrowing.projectId)"><span class="box ghost" /><span class="nm">Select all</span></button>
            </template>
          </template>
          <template v-else>
            <div v-for="(s, i) in sources ?? []" :key="s.workspaceId" class="it still" :title="s.path">
              <FolderGit2 class="ic" /><span class="nm">{{ s.name }}</span>
              <span class="k">{{ i === 0 && (sources?.length ?? 0) > 1 ? 'works here' : home(s.path) }}</span>
            </div>
            <div v-for="d in extraDirs" :key="d" class="it still" :title="d">
              <FolderGit2 class="ic" /><span class="nm">{{ d.split('/').pop() }}</span><span class="k">{{ home(d) }}</span>
            </div>
            <p v-if="!(sources ?? []).length" class="none">None</p>
          </template>
        </template>

        <!-- Memory -->
        <template v-else-if="sub === 'memory'">
          <template v-if="memoryEditable">
            <button v-for="f in fixed" :key="f.id" class="it" :title="f.title" @click="pickMemory(f.id)">
              <Check class="tk" :class="{ hidden: memoryId !== f.id }" />
              <span class="nm">{{ f.label }}</span>
              <span v-if="f.hint" class="k">{{ f.hint }}</span>
            </button>
            <template v-if="existing.length">
              <span class="rule" />
              <label class="find">
                <Search />
                <input
                  v-model="query"
                  type="text"
                  spellcheck="false"
                  autocomplete="off"
                  placeholder="Find a memory…"
                  @keydown.down.prevent="move(1)"
                  @keydown.up.prevent="move(-1)"
                  @keydown.enter.prevent="pickMemory(found[cursor]?.option.id)"
                >
              </label>
              <div class="scroll">
                <button
                  v-for="(r, i) in found"
                  :key="r.option.id"
                  class="it"
                  :class="{ cur: i === cursor }"
                  @mousemove="cursor = i"
                  @click="pickMemory(r.option.id)"
                >
                  <Check class="tk" :class="{ hidden: memoryId !== r.option.id }" />
                  <span class="nm">
                    <span v-for="(part, j) in highlight(r.option.label, r.positions)" :key="j" :class="{ hit: part.hit }">{{ part.text }}</span>
                  </span>
                  <span class="k">{{ r.option.hint }}</span>
                </button>
                <p v-if="!found.length" class="none">No memory matches “{{ query.trim() }}”</p>
              </div>
            </template>
          </template>
          <div v-else class="it still" title="Fixed when the conversation started">
            <BookMarked class="ic" /><span class="nm">{{ memoryShown }}</span>
            <span v-if="memoryNotes !== null" class="k">{{ memoryNotes }} {{ memoryNotes === 1 ? 'note' : 'notes' }}</span>
          </div>
        </template>

        <!-- Instructions -->
        <template v-else-if="sub === 'guides'">
          <div v-for="g in guides" :key="g.repo + g.rel" class="it still" title="Read by Claude at the start of every conversation">
            <FileText class="ic" /><span class="nm">{{ g.rel }}</span><span class="k">{{ g.repo }}</span>
          </div>
          <p v-if="!guides.length" class="none">None</p>
        </template>

        <!-- Skills -->
        <template v-else-if="sub === 'skills' && loadout">
          <div class="scroll pad">
            <template v-for="g in grouped(loadout.skills)" :key="g.from">
              <p v-if="g.from" class="from">{{ g.from }}</p>
              <div class="chips"><span v-for="s in g.names" :key="s">{{ s }}</span></div>
            </template>
          </div>
          <p v-if="!loadout.skills.length" class="none">None</p>
        </template>

        <!-- MCP servers -->
        <template v-else-if="sub === 'mcp'">
          <div v-for="m in mcpRows" :key="m.name" class="it still">
            <i class="dot" :class="m.dot" /><span class="nm">{{ m.name }}</span><span class="k" :class="{ bad: m.dot === 'bad' }">{{ m.hint }}</span>
          </div>
          <p v-if="!mcpRows.length" class="none">None</p>
        </template>

        <!-- Plugins -->
        <template v-else-if="sub === 'plugins' && loadout">
          <div v-for="p in loadout.plugins" :key="p.name" class="it still">
            <Puzzle class="ic" /><span class="nm">{{ p.name }}</span><span class="k">{{ p.source.split('@')[1] }}</span>
          </div>
          <p v-if="!loadout.plugins.length" class="none">None</p>
        </template>

        <!-- Sub-agents -->
        <template v-else-if="sub === 'agents' && loadout">
          <div v-if="loadout.agents.length" class="chips pad"><span v-for="a in loadout.agents" :key="a">{{ a }}</span></div>
          <p v-else class="none">None</p>
        </template>

        <!-- Tools -->
        <template v-else-if="sub === 'tools'">
          <div class="chips pad" title="git push and git commit are refused"><span v-for="t in builtIn" :key="t">{{ t }}</span></div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ctx { position: relative; min-width: 0; }

/* ── the bar: a ghost clip, then a ghost picker (Picker's trigger, as the
   composer row strips it) ── */
.pair { display: inline-flex; align-items: center; gap: 2px; max-width: 100%; }
.clip, .what {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  height: 24px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  font: inherit;
  font-size: 11px;
  white-space: nowrap;
}
.clip { flex: none; padding: 0 7px; color: var(--text-muted); }
.clip .lucide { width: 13px; height: 13px; }
.what { gap: 5px; padding: 0 6px 0 8px; color: var(--text); font-weight: 550; }
.clip:hover, .what:hover, .what.open { background: var(--hover); color: var(--text); }
.what .lead { flex: none; width: 13px; height: 13px; color: var(--text-dim); }
.chev-d { flex: none; width: 11px; height: 11px; color: var(--text-dim); }
.v { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.v:not(.mem) { flex: none; }
.sep { flex: none; color: var(--text-dim); font-weight: 400; }
/* Narrowed changes what Start does, so the picker that says it is lit. */
.what.narrowed, .what.narrowed:hover { background: var(--agent-soft); color: var(--agent); }
.what.narrowed .lead, .what.narrowed .sep { color: var(--agent); }

/* ── the menu: upward, from the group's left edge ── */
.menu {
  position: absolute;
  left: 0;
  bottom: calc(100% + 6px);
  z-index: 20;
  width: 264px;
  padding: 5px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-lg);
  background: var(--panel-raised);
  box-shadow: var(--shadow-md);
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 32px;
  padding: 0 8px 0 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  font: inherit;
  font-size: var(--fs-sm);
  color: var(--text);
  text-align: left;
}
.row:hover, .row.on { background: var(--hover); }
/* A fact, not a door: no hover, no chevron. */
.row.still { cursor: default; }
.row.still:hover { background: transparent; }
.row .ic { width: 15px; height: 15px; flex: none; color: var(--text-muted); }
.lbl { flex: none; }
.val {
  margin-left: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-xs);
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.val.lit { color: var(--agent); }
.val.bad { color: var(--danger); }
.chev { width: 13px; height: 13px; flex: none; color: var(--text-dim); }
.rule { display: block; height: 1px; margin: 5px 8px; background: var(--line); }
.foot { margin: 4px 10px 3px; font-size: 10.5px; color: var(--text-dim); }

/* ── the flyout: the menu's own panel, beside it ── */
.fly {
  position: absolute;
  left: calc(100% + 4px);
  width: 300px;
  max-height: min(440px, calc(100vh - 20px));
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 5px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-lg);
  background: var(--panel-raised);
  box-shadow: var(--shadow-md);
}
.fly.k-memory { display: flex; flex-direction: column; overflow: hidden; width: 340px; }
.it {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 32px;
  padding: 0 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  font: inherit;
  font-size: var(--fs-sm);
  color: var(--text);
  text-align: left;
}
button.it:hover, .it.cur { background: var(--hover); }
.it.still { cursor: default; }
.it .ic { width: 14px; height: 14px; flex: none; color: var(--text-dim); }
.it .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.it .nm .hit { font-weight: 650; }
.it .k {
  flex: none;
  max-width: 50%;
  margin-left: auto;
  padding-left: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.it .k.bad { color: var(--danger); }
.tk { width: 13px; height: 13px; flex: none; color: var(--accent); }
.tk.hidden { visibility: hidden; }
/* A box, not a bare tick: several are on at once. */
.box {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
}
.box.on { background: var(--accent); border-color: var(--accent); }
.box.ghost { visibility: hidden; }
.box .lucide { width: 10px; height: 10px; stroke-width: 3; color: var(--accent-text); }
.find {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  margin: 2px 2px 4px;
  padding: 0 9px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--panel);
}
.find:focus-within { border-color: var(--focus-ring); }
.find .lucide { width: 12px; height: 12px; flex: none; color: var(--text-dim); }
.find input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: var(--fs-sm);
}
.find input::placeholder { color: var(--text-dim); }
.scroll { min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.fly.k-memory .scroll { flex: 1 1 auto; max-height: 260px; }
.none { margin: 0; padding: 8px 10px; font-size: var(--fs-sm); color: var(--text-dim); }

/* Many short names: chips, under the plugin they come from. */
.pad { padding: 6px 7px; }
.from { margin: 10px 0 5px; font-size: var(--fs-xs); color: var(--text-dim); }
.from:first-child { margin-top: 0; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chips span {
  padding: 1px 7px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg-sunken);
  font-size: var(--fs-xs);
  line-height: 18px;
  color: var(--text-muted);
}
.dot { width: 7px; height: 7px; flex: none; margin: 0 3px; border-radius: 50%; }
.dot.ok { background: var(--ok); }
.dot.bad { background: var(--danger); }
.dot.dim { background: var(--line-strong); }
</style>
