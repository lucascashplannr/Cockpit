<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import {
  BookMarked, BookOpen, Bot, Check, ChevronDown, ChevronRight, FileText, FolderGit2, Layers, Paperclip, Plug,
  Plus, Search, Sparkles,
} from '@lucide/vue'
import type { AgentScope, Conversation, LoadoutChoice } from '@cockpit/shared'
import {
  chooseDocs, chooseMemory, loadoutChoiceFor, memoryLabel, projectSkillsOff, refreshCatalog, refreshSkills, saveSkillsForProject, setSkills,
  skillsKey, state, toggleInstruction, toggleProjectRepo, toggleSkill, widenProject,
} from '../../core/store.js'
import AddSkillDialog from './AddSkillDialog.vue'
import { fuzzyFilter, highlight } from '../../core/fuzzy.js'
import { useAgentContext } from './agentContext.js'

/**
 * What the agent gets, at the start of the settings row: the clip on its own,
 * then the context as one of the row's pickers.
 *
 * The context half says where it runs and which memory. It opens a menu of
 * everything the agent is given — one row each — and a row opens its own
 * flyout beside the menu: the repositories to tick, the memories to pick from,
 * the instruction files and skills to switch off, the docs to read, or what
 * Claude loaded (MCP servers, sub-agents), to read.
 *
 * All of it is decided before the conversation starts — the engine reads it at
 * launch — and shown, not offered, once it has.
 */
const props = defineProps<{
  session?: Conversation | null
  scope?: AgentScope | null
  sources?: { workspaceId: string; name: string; path: string }[]
  /** Instruction files found in the repositories, with their full path. */
  guides: { repo: string; rel: string; path: string }[]
  /** The repositories' own `docs/` folders, offered beside the project's Docs home. */
  docsFolders?: { path: string; label: string }[]
  started: boolean
}>()
const emit = defineEmits<{ attach: [] }>()

const ctx = useAgentContext(props)
const { narrowing, narrowed, reposEditable, reposValue, memoryEditable, memoryId, memoryName, memoryNotes, loadout, borrowed, projectId } = ctx

const memoryShown = computed(() => (memoryId.value === 'off' ? 'No memory' : memoryName.value))

/* ── the rows ─────────────────────────────────────────────────────────── */

type Key = 'repos' | 'memory' | 'guides' | 'docs' | 'skills' | 'mcp' | 'agents'
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

/* ── what is chosen before it starts ───────────────────────────────────── */

/** Before the first turn the switches below change it; after, they show it. */
const editable = computed(() => !props.started && !!props.scope)
const choice = computed<LoadoutChoice>(() =>
  editable.value && props.scope
    ? loadoutChoiceFor(props.scope)
    : (props.session?.choice ?? { instructionsOff: [], skillsOff: [] }),
)

/* Instruction files */
const guidesOn = computed(() => props.guides.filter((g) => !choice.value.instructionsOff.includes(g.path)))

/* Docs: the project's home, a repository's own docs/ folder, or none. */
const home = computed(() => state.docsInfo[projectId.value ?? ''] ?? null)
const homeLabel = computed(() => (home.value ? [home.value.repo, home.value.folder].filter(Boolean).join('/') || 'Docs' : ''))
interface DocsOption { key: string; path: string | null | undefined; label: string; hint?: string; title?: string }
const docsOptions = computed<DocsOption[]>(() => {
  const out: DocsOption[] = []
  if (home.value) out.push({ key: 'home', path: undefined, label: homeLabel.value, hint: 'the project’s', title: home.value.path })
  for (const f of props.docsFolders ?? []) {
    if (home.value?.path !== f.path) out.push({ key: f.path, path: f.path, label: f.label, title: f.path })
  }
  out.push({ key: 'none', path: null, label: 'No docs' })
  return out
})
const docsShown = computed(() => {
  const d = choice.value.docs
  if (d === undefined) return home.value ? { label: homeLabel.value, title: home.value.path } : { label: 'None' }
  if (d === null) return { label: 'None' }
  return { label: props.docsFolders?.find((f) => f.path === d)?.label ?? d.split('/').slice(-2).join('/'), title: d }
})
const docsKey = computed(() => (choice.value.docs === undefined ? 'home' : choice.value.docs === null ? 'none' : choice.value.docs))

/* Skills: what the engine listed, what is on disk (a skill added a minute ago
   has been listed by nothing yet), and what was switched off (it lists those no more). */
const sourceIds = computed(() => (props.sources ?? []).map((s) => s.workspaceId))
watch(
  sourceIds,
  (ids) => {
    void refreshSkills(ids)
    // Asked of the engine itself, about a second: what it would load here.
    void refreshCatalog(ids)
  },
  { immediate: true },
)
const onDisk = computed(() => state.skillsOnDisk[skillsKey(sourceIds.value)] ?? [])
const describe = (name: string) => onDisk.value.find((x) => x.name === name)?.description
const skillCatalog = computed(() =>
  [
    ...new Set([
      ...(loadout.value?.skills ?? []),
      ...onDisk.value.map((x) => x.name),
      ...choice.value.skillsOff,
      ...(borrowed.value?.choice?.skillsOff ?? []),
      ...(editable.value ? projectSkillsOff(projectId.value) : []),
    ]),
  ].sort((a, b) => a.localeCompare(b)),
)
const skillsOn = computed(() => skillCatalog.value.filter((n) => !choice.value.skillsOff.includes(n)))
/** A plugin's skills go with their plugin: the engine switches those off only as a whole. */
const pluginNames = computed(() => new Set((loadout.value?.plugins ?? []).map((p) => p.name)))
const fromPlugin = (name: string) => name.includes(':') && pluginNames.value.has(name.slice(0, name.indexOf(':')))
const sameAsProject = computed(() => {
  const a = [...choice.value.skillsOff].sort().join('\n')
  return a === [...projectSkillsOff(projectId.value)].sort().join('\n')
})

/* Sub-agents need the Agent tool, which a project's tool list may leave out. */
const agentsUsable = computed(() => !!loadout.value?.tools.includes('Agent'))

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

/** "3 of 4" once something is off; the count, or the one name, otherwise. */
function partOf(on: number, all: number, one?: string): string {
  if (on < all) return on + ' of ' + all
  return all === 1 && one ? one : String(all)
}

const guidesRow = computed<RowDef>(() => {
  const all = props.guides.length
  if (!all) return { key: 'guides', label: 'Instructions', icon: FileText, value: 'None', opens: false }
  return {
    key: 'guides', label: 'Instructions', icon: FileText,
    value: partOf(guidesOn.value.length, all, props.guides[0]!.rel),
    opens: editable.value || all > 1,
    title: all === 1 && !editable.value ? 'In ' + props.guides[0]!.repo + ' — read at the start of every conversation' : undefined,
  }
})

const skillsRow = computed<RowDef>(() => {
  const all = skillCatalog.value.length
  if (!all) return { key: 'skills', label: 'Skills', icon: Sparkles, value: loadout.value ? 'None' : '–', opens: true, title: loadout.value ? undefined : NOT_YET }
  return {
    key: 'skills', label: 'Skills', icon: Sparkles,
    value: partOf(skillsOn.value.length, all, skillCatalog.value[0]),
    // Always: adding one is in there too.
    opens: true,
  }
})

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
  return [
    guidesRow.value,
    {
      key: 'docs', label: 'Docs', icon: BookOpen,
      opens: editable.value && docsOptions.value.length > 1,
      value: docsShown.value.label, title: docsShown.value.title,
    },
    skillsRow.value,
    {
      ...listRow('mcp', 'MCP servers', Plug, l?.mcp.map((m) => m.name), () => mcpRows.value[0]!.hint),
      bad: !!l?.mcp.some((m) => m.status === 'failed'),
    },
    {
      ...listRow('agents', 'Sub-agents', Bot, l?.agents),
      ...(l && l.agents.length && !agentsUsable.value
        ? { title: 'Not usable here: the Agent tool is not among this project’s tools (agents.allow in cockpit.yaml)' }
        : {}),
    },
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
function grouped(names: string[]): { from: string; items: { full: string; short: string }[] }[] {
  const out: { from: string; items: { full: string; short: string }[] }[] = []
  for (const full of names) {
    const at = full.indexOf(':')
    const from = at < 0 ? '' : full.slice(0, at)
    let g = out.find((x) => x.from === from)
    if (!g) out.push((g = { from, items: [] }))
    g.items.push({ full, short: at < 0 ? full : full.slice(at + 1) })
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
const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, '~')

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

/* Adding a skill: a sheet over the window, so the menu closes under it. */
const adding = ref<'write' | 'import' | null>(null)
function addSkill(mode: 'write' | 'import'): void {
  close()
  adding.value = mode
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
        <span class="div" />
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
            <div v-for="s in sources ?? []" :key="s.workspaceId" class="it still" :title="tilde(s.path)">
              <FolderGit2 class="ic" /><span class="nm">{{ ctx.labelOf(s) }}</span>
            </div>
            <div v-for="d in extraDirs" :key="d" class="it still" :title="d">
              <FolderGit2 class="ic" /><span class="nm">{{ d.split('/').pop() }}</span><span class="k">{{ tilde(d) }}</span>
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

        <!-- Instructions: ticked in place before it starts; said after. -->
        <template v-else-if="sub === 'guides'">
          <template v-if="editable && scope">
            <button
              v-for="g in guides"
              :key="g.path"
              class="it"
              :title="g.path"
              @click="toggleInstruction(scope, g.path)"
            >
              <span class="box" :class="{ on: !choice.instructionsOff.includes(g.path) }"><Check v-if="!choice.instructionsOff.includes(g.path)" /></span>
              <span class="nm">{{ g.rel }}</span><span class="k">{{ g.repo }}</span>
            </button>
          </template>
          <template v-else>
            <div v-for="g in guides" :key="g.path" class="it still" :class="{ off: choice.instructionsOff.includes(g.path) }" :title="g.path">
              <FileText class="ic" /><span class="nm">{{ g.rel }}</span>
              <span class="k">{{ choice.instructionsOff.includes(g.path) ? 'off' : g.repo }}</span>
            </div>
          </template>
        </template>

        <!-- Docs: one answer, so it closes on a choice. -->
        <template v-else-if="sub === 'docs' && scope">
          <button
            v-for="o in docsOptions"
            :key="o.key"
            class="it"
            :title="o.title"
            @click="chooseDocs(scope, o.path); sub = null"
          >
            <Check class="tk" :class="{ hidden: docsKey !== o.key }" />
            <span class="nm">{{ o.label }}</span><span v-if="o.hint" class="k">{{ o.hint }}</span>
          </button>
        </template>

        <!-- Skills: switched per conversation, saved for the project. -->
        <template v-else-if="sub === 'skills'">
          <template v-if="editable && scope">
            <div v-if="skillCatalog.length" class="bar">
              <span class="cnt">{{ skillsOn.length }} of {{ skillCatalog.length }} on</span>
              <button class="lk" @click="setSkills(scope, skillCatalog.filter((n) => !fromPlugin(n)), true)">All on</button>
              <button class="lk" @click="setSkills(scope, skillCatalog.filter((n) => !fromPlugin(n)), false)">All off</button>
            </div>
            <div class="scroll skl">
              <template v-for="g in grouped(skillCatalog)" :key="g.from">
                <p v-if="g.from" class="grp">{{ g.from }}</p>
                <button
                  v-for="it in g.items"
                  :key="it.full"
                  class="it slim"
                  :disabled="fromPlugin(it.full)"
                  :title="fromPlugin(it.full) ? 'A plugin’s skills go on and off with the plugin' : describe(it.full)"
                  @click="toggleSkill(scope, it.full)"
                >
                  <span class="box" :class="{ on: !choice.skillsOff.includes(it.full) }"><Check v-if="!choice.skillsOff.includes(it.full)" /></span>
                  <span class="nm">{{ it.short }}</span>
                </button>
              </template>
            </div>
            <template v-if="!sameAsProject">
              <span class="rule" />
              <button class="it act" title="Every new conversation in this project starts with these skills" @click="saveSkillsForProject(scope)">
                <span class="box ghost" /><span class="nm">Save for this project</span>
              </button>
            </template>
          </template>
          <div v-else-if="skillCatalog.length" class="scroll pad">
            <template v-for="g in grouped(skillCatalog)" :key="g.from">
              <p v-if="g.from" class="from">{{ g.from }}</p>
              <div class="chips">
                <span v-for="it in g.items" :key="it.full" :class="{ off: choice.skillsOff.includes(it.full) }" :title="describe(it.full)">{{ it.short }}</span>
              </div>
            </template>
          </div>
          <!-- Adding one: written in the sheet, or imported from a folder there. -->
          <span v-if="skillCatalog.length" class="rule" />
          <button class="it act" title="Write one, or import a folder of them" @click="addSkill('write')"><Plus class="ic" /><span class="nm">Add a skill…</span></button>
        </template>

        <!-- MCP servers -->
        <template v-else-if="sub === 'mcp'">
          <div v-for="m in mcpRows" :key="m.name" class="it still">
            <i class="dot" :class="m.dot" /><span class="nm">{{ m.name }}</span><span class="k" :class="{ bad: m.dot === 'bad' }">{{ m.hint }}</span>
          </div>
          <p v-if="!mcpRows.length" class="none">None</p>
        </template>

        <!-- Sub-agents -->
        <template v-else-if="sub === 'agents' && loadout">
          <div v-if="loadout.agents.length" class="chips pad"><span v-for="a in loadout.agents" :key="a">{{ a }}</span></div>
          <p v-if="!agentsUsable" class="none note">Not usable here: the Agent tool is not among this project’s tools (<code>agents.allow</code> in cockpit.yaml).</p>
        </template>

      </div>
    </div>
    <Teleport to="body">
      <AddSkillDialog v-if="adding" :sources="sources" :mode="adding" @close="adding = null" />
    </Teleport>
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
/* ServerSwitch's divider between the two answers, in the picker's own ink. */
.div { flex: none; width: 1px; height: 12px; margin: 0 2px; background: currentColor; opacity: 0.22; }
/* Narrowed changes what Start does, so the picker that says it is lit. */
.what.narrowed, .what.narrowed:hover { background: var(--agent-soft); color: var(--agent); }
.what.narrowed .lead { color: var(--agent); }
.what.narrowed .div { opacity: 0.35; }

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
/* Edge to edge: the panels' own padding is 5px, and a rule is not content. */
/* `.ctx` first: base.css's `.menu .rule` insets every menu's rule by 2px and
   would win over a bare `.rule` here. */
.ctx .rule { display: block; flex: none; height: 1px; margin: 5px -5px; background: var(--line); }
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
.none.note { font-size: var(--fs-xs); line-height: 1.5; }
.none code { font-family: var(--mono); font-size: 10.5px; }
.it.off .nm, .chips span.off { color: var(--text-dim); text-decoration: line-through; }
button.it:disabled { opacity: 0.45; cursor: default; }
button.it:disabled:hover { background: transparent; }
.it.slim { min-height: 28px; }
.it.act .nm { color: var(--text-muted); }
.it.act:hover .nm { color: var(--text); }

/* Skills: a count and the two shortcuts, then the list in its own scroll. */
.bar { display: flex; align-items: center; gap: 2px; padding: 4px 6px 4px 10px; }
.bar .cnt { flex: 1; font-size: var(--fs-xs); color: var(--text-dim); font-variant-numeric: tabular-nums; }
.bar .lk {
  height: 22px;
  padding: 0 7px;
  border: none;
  border-radius: 5px;
  background: transparent;
  font: inherit;
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.bar .lk:hover { background: var(--hover); color: var(--text); }
.fly.k-skills { display: flex; flex-direction: column; overflow: hidden; }
.fly.k-skills .scroll.skl { flex: 1 1 auto; max-height: 320px; }
.grp { margin: 8px 10px 2px; font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-dim); }

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
