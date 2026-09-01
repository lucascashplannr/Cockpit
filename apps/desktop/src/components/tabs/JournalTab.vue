<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Component } from 'vue'
import type { CockpitEvent, EventType, Workspace } from '@cockpit/shared'
import {
  Boxes, Brain, ChevronRight, Cpu, FolderGit2, GitBranch, Lock, Power, ScrollText,
  Search, Server, Sparkles, SquareTerminal, X,
} from '@lucide/vue'
import { state } from '../../core/store.js'

/**
 * §6 — the third layer: what happened, written automatically. Reading it is
 * how you rebuild context after three days away (§18, "moins de 60 secondes").
 *
 * Which is what the first version of this tab could not do. It printed the
 * envelope — `git.plan`, `human`, `switch` — in four fixed columns, and in the
 * 440px this panel is actually dragged to, three of them were chrome and the
 * fourth, the only one carrying anything, had eighty pixels left to say it in.
 * Sixty seconds of that is a wall of `git.plan / git.applied` pairs at the same
 * second, which is one act written twice in the model's own vocabulary.
 *
 * So the row is now a sentence rather than a record: *when*, *who*, *what*,
 * *about what*. Three rules get it there.
 *
 * 1. **The dotted type never reaches the window** — the same boundary §4's
 *    lexicon draws for `worktree` and `runtime`. `git.applied {operation:
 *    'switch'}` is "Switch branch"; `topic.merge` is "Send to the base",
 *    because that is what the button that caused it says.
 * 2. **A plan and the act it became are one line.** The preview is real and it
 *    is logged, but it is only news when nothing followed it — then the row
 *    stays and says `planned`.
 * 3. **Nothing is hidden, only folded.** Every row opens onto its own envelope:
 *    the raw type, the actor, the whole payload. The journal is the record the
 *    rest of the system derives from (§3.3) and this is a reading of it, so
 *    there has to be a way back to what was actually written.
 *
 * Attribution stays, quietly (§12): an agent's rows are marked in the agent's
 * purple, a person's are the ground everything else is read against. Four
 * hundred green "human" labels said only that you use your own cockpit.
 */

const props = defineProps<{ workspace: Workspace }>()

type Kind = 'all' | 'git' | 'agent' | 'runtime'

const scope = ref<'workspace' | 'all'>('workspace')
const kind = ref<Kind>('all')
const q = ref('')
/** Which row has its envelope open. One at a time — this is a list, not a tree. */
const opened = ref<string | null>(null)

/** The filter icons are the same ones the rest of the app uses for those
 *  three subjects, so the bar needs no labels beyond its own. A subject is a
 *  family of types rather than one prefix: a dev server writes `runtime.*` and
 *  the supervisor that holds it writes `process.*`, and "servers" means both. */
const KINDS: { id: Kind; label: string; icon: Component; has: (t: string) => boolean }[] = [
  { id: 'all', label: 'all', icon: ScrollText, has: () => true },
  { id: 'git', label: 'git', icon: GitBranch, has: (t) => t.startsWith('git.') || t.startsWith('worktree.') },
  { id: 'agent', label: 'agent', icon: Sparkles, has: (t) => t.startsWith('agent.') },
  { id: 'runtime', label: 'servers', icon: Server, has: (t) => t.startsWith('runtime.') || t.startsWith('process.') },
]

/** One glyph per subject, by prefix, longest first. */
const SUBJECTS: [string, Component][] = [
  ['git.', GitBranch],
  ['worktree.', GitBranch],
  ['agent.', Sparkles],
  ['runtime.', Server],
  ['process.', Cpu],
  ['topic.', Boxes],
  ['project.', FolderGit2],
  ['workspace.', FolderGit2],
  ['memory.', Brain],
  ['terminal.', SquareTerminal],
  ['lease.', Lock],
  ['core.', Power],
]

/**
 * §4's verb table, which is the only place these acts have a name a person
 * chose. `rebase` and `merge` are both Catch up — they are two strategies for
 * the same direction (base → branch), and the journal is the last place that
 * should reopen the question the rename settled.
 */
const OPS: Record<string, string> = {
  switch: 'Switch branch',
  branch: 'Create branch',
  worktree: 'Isolate branch',
  rebase: 'Catch up',
  merge: 'Catch up',
  push: 'Push',
  sync: 'Sync',
  commit: 'Commit',
  'topic.open': 'Open topic',
  'topic.rebase': 'Catch up',
  'topic.merge': 'Send to the base',
  'topic.close': 'Close topic',
  'topic.delete': 'Delete topic',
}

const TITLES: Partial<Record<EventType, string>> = {
  'core.started': 'Cockpit started',
  'core.stopping': 'Cockpit stopping',
  'core.reconciled': 'Reconciled',
  'core.orphan_reaped': 'Orphan cleared',
  'workspace.forgotten': 'Forgotten',
  'workspace.probed': 'Probed',
  'project.created': 'Project created',
  'project.repo_added': 'Repository added',
  'project.renamed': 'Project renamed',
  'project.moved': 'Project moved',
  'project.trashed': 'Project trashed',
  'topic.opened': 'Topic opened',
  'topic.started': 'Topic started',
  'topic.stopped': 'Topic stopped',
  'topic.renamed': 'Topic renamed',
  'topic.closed': 'Topic closed',
  'topic.deleted': 'Topic deleted',
  'git.restore_point': 'Restore point',
  'git.undone': 'Undone',
  'git.conflict.resolved': 'Conflict resolved',
  'git.conflict.aborted': 'Conflict aborted',
  'worktree.seeded': 'Branch seeded',
  'runtime.provision': 'Server preparing',
  'runtime.up': 'Server up',
  'runtime.down': 'Server stopped',
  'runtime.health': 'Server checked',
  'runtime.log': 'Server output',
  'process.spawned': 'Process started',
  'process.exited': 'Process exited',
  'agent.session_started': 'Conversation started',
  'agent.session_resumed': 'Conversation resumed',
  'agent.output': 'Agent wrote',
  'agent.tool_result': 'Tool finished',
  'agent.denied': 'Tool refused',
  'agent.checkpoint': 'Checkpoint',
  'agent.reverted': 'Reverted',
  'agent.session_ended': 'Conversation ended',
  'lease.acquired': 'Lock taken',
  'lease.released': 'Lock released',
  'lease.denied': 'Lock refused',
  'memory.written': 'Memory written',
  'memory.promoted': 'Promoted to memory',
  'terminal.opened': 'Terminal opened',
  'terminal.closed': 'Terminal closed',
  'capability.event': 'Event',
}

/**
 * The one word that says the act did not simply work. Absent on the happy
 * path: a list where every row carries a badge has no badges.
 */
const NOTES: Partial<Record<EventType, string>> = {
  'git.plan': 'planned',
  'git.failed': 'failed',
  'git.conflict': 'conflict',
}

/** The outcomes a plan can turn into — see the fold in `rows`. */
const OUTCOMES = new Set(['git.applied', 'git.failed', 'git.conflict'])

interface Shaped {
  /** The first event of the fold: stable across the rows a repeat collapses into. */
  id: string
  ev: CockpitEvent
  icon: Component
  title: string
  detail: string
  note: string | null
  /** How many identical events this row stands for, and when the run started. */
  count: number
  first: number
}

// ── reading a payload ────────────────────────────────────────────────

function bag(e: CockpitEvent): Record<string, unknown> {
  return e.payload && typeof e.payload === 'object' ? (e.payload as Record<string, unknown>) : {}
}

function opOf(e: CockpitEvent): string | null {
  const o = bag(e).operation
  return typeof o === 'string' ? o : null
}

function base(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p
}

function lastLine(s: string): string {
  return s.trim().split('\n').filter(Boolean).pop() ?? ''
}

function count(n: number, one: string, many = one + 's'): string {
  return n ? n + ' ' + (n === 1 ? one : many) : ''
}

function join(...parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join(' · ')
}

function iconOf(type: string): Component {
  return SUBJECTS.find(([p]) => type.startsWith(p))?.[1] ?? ScrollText
}

function titleOf(e: CockpitEvent): string {
  const p = bag(e)
  const op = opOf(e)
  // A git row is named after the act, not after which half of it this is;
  // `planned` / `failed` is the note beside it.
  if (op) return OPS[op] ?? op
  if (e.type === 'workspace.discovered') {
    return p.kind === 'worktree' ? 'Branch found' : p.kind === 'group' ? 'Folder found' : 'Repository found'
  }
  if (e.type === 'runtime.up' && e.level === 'error') return 'Server failed'
  // A tool call is named by its tool: "Bash", "Edit". Anything else here is a
  // second word for a thing the row already spells out on its right.
  if (e.type === 'agent.tool_use' && typeof p.tool === 'string') return p.tool
  return TITLES[e.type] ?? e.type.split('.').pop()!.replace(/_/g, ' ')
}

/**
 * The one thing in the payload worth a line. Written per event where the
 * useful field is not obvious from its name, and by preference order where it
 * is — the generic scan at the bottom is what keeps a capability's own event
 * from rendering blank.
 */
const FALLBACK = ['detail', 'text', 'name', 'reason', 'branch', 'label', 'tool', 'impl', 'note', 'chunk']

function detailOf(e: CockpitEvent): string {
  const p = bag(e)
  const s = (k: string): string => (typeof p[k] === 'string' ? (p[k] as string) : '')
  const n = (k: string): number | null => (typeof p[k] === 'number' ? (p[k] as number) : null)
  const arr = (k: string): unknown[] => (Array.isArray(p[k]) ? (p[k] as unknown[]) : [])

  let out = ''
  switch (e.type) {
    // git ──────────────────────────────────────────────────────────────
    // A plan that stayed a plan is only interesting for what it warned about.
    case 'git.plan': out = String(arr('warnings')[0] ?? count(arr('steps').length, 'step')); break
    case 'git.applied': out = ''; break
    case 'git.failed': out = join(s('step'), lastLine(s('output'))); break
    case 'git.conflict': out = join(s('repo'), count(arr('paths').length, 'file')); break
    case 'git.conflict.resolved': out = join(s('kind'), s('action')); break
    case 'git.conflict.aborted': out = join(s('kind'), s('onto')); break
    case 'git.restore_point': out = s('reason'); break
    case 'git.undone': out = join(s('head').slice(0, 8), s('reason')); break
    case 'worktree.seeded': out = join(s('repo'), count(arr('copied').length, 'file') + ' carried over'); break

    // where ────────────────────────────────────────────────────────────
    case 'workspace.discovered': out = s('branch') || base(s('path')); break
    case 'workspace.forgotten': out = base(s('path')); break
    case 'project.created':
    case 'project.repo_added': out = join(base(s('repo')) || base(s('root')), s('source')); break
    case 'project.moved': out = base(s('from')) + ' → ' + base(s('to')); break

    // topics ───────────────────────────────────────────────────────────
    case 'topic.opened': out = join(s('name') || s('topicId'), count(arr('repos').length, 'repository', 'repositories')); break
    case 'topic.started': out = join(count(arr('workspaces').length, 'repository', 'repositories'), arr('failed').length ? arr('failed').join(', ') + ' failed' : ''); break
    case 'topic.stopped': out = s('reason') || s('topicId'); break

    // running ──────────────────────────────────────────────────────────
    case 'runtime.provision': out = s('impl'); break
    case 'runtime.up':
    case 'runtime.down': out = s('detail') || s('impl'); break
    case 'runtime.health': out = join(s('status'), s('detail')); break
    case 'runtime.log': out = lastLine(s('chunk')); break
    case 'process.spawned': out = join(s('label'), s('command')); break
    case 'process.exited': out = join(s('label'), n('code') === null ? '' : 'exit ' + n('code')); break

    // agents ───────────────────────────────────────────────────────────
    case 'agent.output': out = s('text'); break
    case 'agent.tool_use': out = String(arr('paths')[0] ?? firstString(p.input) ?? ''); break
    case 'agent.tool_result': out = p.isError ? lastLine(s('stderr')) : lastLine(s('stdout')); break
    case 'agent.denied': out = arr('tools').join(', '); break
    case 'agent.checkpoint': out = s('reason'); break
    case 'agent.session_ended': out = n('code') === null ? '' : 'exit ' + n('code'); break

    // the rest ─────────────────────────────────────────────────────────
    case 'memory.written': out = n('bytes') === null ? base(s('path')) : n('bytes') + ' bytes'; break
    case 'memory.promoted': out = join(s('section'), s('text')); break
    case 'lease.acquired':
    case 'lease.released':
    case 'lease.denied': out = join(s('holder'), arr('paths').map(String).map(base).join(', ')); break
    case 'terminal.opened': out = base(s('cwd')); break
    case 'terminal.closed': out = n('code') === null ? '' : 'exit ' + n('code'); break
    case 'core.started': out = n('port') === null ? '' : 'port ' + n('port'); break
    case 'core.reconciled': out = join(count(n('projects') ?? 0, 'project'), count(n('workspaces') ?? 0, 'repository', 'repositories')); break
  }

  if (!out) {
    for (const k of FALLBACK) {
      const v = p[k]
      if (typeof v === 'string' && v) { out = v; break }
    }
  }
  // A journal line is one line: a stack trace collapses to its width and the
  // whole of it is a click away in the envelope below.
  return out.replace(/\s+/g, ' ').trim().slice(0, 400)
}

function firstString(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  for (const v of Object.values(input as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim()) return v
  }
  return null
}

function shape(e: CockpitEvent): Shaped {
  return {
    id: e.id,
    ev: e,
    icon: iconOf(e.type),
    title: titleOf(e),
    detail: detailOf(e),
    note: NOTES[e.type] ?? (e.level === 'error' ? 'error' : null),
    count: 1,
    first: e.ts,
  }
}

// ── the list ─────────────────────────────────────────────────────────

const matcher = computed(() => KINDS.find((k) => k.id === kind.value)!)

/** Scope and subject, before anything is read out of a payload. */
const picked = computed(() => {
  const has = matcher.value.has
  return state.events.filter(
    (e) =>
      (scope.value === 'all' || e.workspaceId === props.workspace.id || e.workspaceId === null) &&
      has(e.type),
  )
})

/** Searched on what the row *says*, not on the envelope it came in. */
const found = computed(() => {
  const shaped = picked.value.map(shape)
  const needle = q.value.trim().toLowerCase()
  if (!needle) return shaped
  return shaped.filter(
    (s) =>
      s.title.toLowerCase().includes(needle) ||
      s.detail.toLowerCase().includes(needle) ||
      s.ev.type.includes(needle),
  )
})

/**
 * Two folds, both of them things the eye does anyway.
 *
 * A plan followed within seconds by its outcome is one act: the preview is
 * kept only when nothing came of it. And a run of identical lines — a dev
 * server's output, a health probe every thirty seconds — is one line with a
 * count, timed by its most recent.
 */
const rows = computed(() => {
  const src = found.value
  const out: Shaped[] = []
  for (let i = 0; i < src.length; i++) {
    const s = src[i]!
    const next = src[i + 1]
    if (
      s.ev.type === 'git.plan' &&
      next &&
      OUTCOMES.has(next.ev.type) &&
      next.ev.ts - s.ev.ts < 10_000 &&
      opOf(next.ev) === opOf(s.ev)
    ) {
      continue
    }
    const last = out[out.length - 1]
    if (
      last &&
      last.ev.type === s.ev.type &&
      last.title === s.title &&
      last.detail === s.detail &&
      last.ev.actor.kind === s.ev.actor.kind &&
      s.ev.ts - last.ev.ts < 120_000
    ) {
      last.count++
      last.ev = s.ev
      continue
    }
    out.push(s)
  }
  return out.reverse().slice(0, 500)
})

/** Days, newest first, so a week away is read as days rather than as a wall. */
const groups = computed(() => {
  const out: { key: string; label: string; rows: Shaped[] }[] = []
  for (const r of rows.value) {
    const key = new Date(r.ev.ts).toDateString()
    const g = out[out.length - 1]
    if (g && g.key === key) g.rows.push(r)
    else out.push({ key, label: dayLabel(r.ev.ts), rows: [r] })
  }
  return out
})

const filtering = computed(() => scope.value === 'all' || kind.value !== 'all' || !!q.value.trim())

function dayLabel(ts: number): string {
  const d = new Date(ts)
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((midnight(new Date()) - midnight(d)) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return d.toLocaleDateString([], { weekday: 'long' })
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
}

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function actorLabel(a: { kind: string; engine?: string }): string {
  return a.kind === 'agent' ? (a.engine || 'agent') : a.kind
}

/** What the row folded, said in the tooltip rather than in a second column. */
function tip(r: Shaped): string {
  const who = actorLabel(r.ev.actor)
  const runs = r.count > 1 ? r.count + ' times since ' + time(r.first) + ' · ' : ''
  return runs + who + ' · ' + r.ev.type
}

function toggle(r: Shaped) {
  // Selecting the text of a line is not asking to open it.
  const sel = window.getSelection()
  if (sel && !sel.isCollapsed) return
  opened.value = opened.value === r.id ? null : r.id
}

function envelope(r: Shaped): string {
  return JSON.stringify(r.ev.payload ?? null, null, 2).slice(0, 4000)
}

function clear() {
  scope.value = 'workspace'
  kind.value = 'all'
  q.value = ''
}
</script>

<template>
  <div class="journal">
    <div class="bar">
      <div class="seg">
        <button :class="{ on: scope === 'workspace' }" @click="scope = 'workspace'">here</button>
        <button :class="{ on: scope === 'all' }" @click="scope = 'all'">everything</button>
      </div>
      <div class="seg">
        <button
          v-for="k in KINDS"
          :key="k.id"
          :class="{ on: kind === k.id }"
          :title="k.label"
          @click="kind = k.id"
        >
          <component :is="k.icon" class="sm" /><span class="kl">{{ k.label }}</span>
        </button>
      </div>
      <label class="find">
        <Search class="sm" />
        <input v-model="q" placeholder="Filter" spellcheck="false" />
        <button v-if="q" class="wipe" title="Clear" @click="q = ''"><X /></button>
      </label>
    </div>

    <div class="rows">
      <template v-for="g in groups" :key="g.key">
        <div class="day">
          <span>{{ g.label }}</span>
          <span class="rule" />
          <span class="dn num">{{ g.rows.length }}</span>
        </div>

        <div v-for="r in g.rows" :key="r.id" class="entry">
          <div
            class="r"
            :class="[r.ev.level, { open: opened === r.id }]"
            :title="tip(r)"
            role="button"
            tabindex="0"
            :aria-expanded="opened === r.id"
            @click="toggle(r)"
            @keydown.enter.prevent="toggle(r)"
            @keydown.space.prevent="toggle(r)"
          >
            <span class="t num">{{ time(r.ev.ts) }}</span>
            <component :is="r.icon" class="ic sm" :class="r.ev.actor.kind" />
            <span class="ti">{{ r.title }}</span>
            <span v-if="r.count > 1" class="x num">×{{ r.count }}</span>
            <span v-if="r.detail" class="de selectable">{{ r.detail }}</span>
            <span class="end">
              <span v-if="r.note" class="no" :class="r.ev.level">{{ r.note }}</span>
              <ChevronRight class="ch sm" />
            </span>
          </div>
          <div v-if="opened === r.id" class="raw">
            <div class="rmeta">
              <span class="rt">{{ r.ev.type }}</span>
              <span class="rw" :class="r.ev.actor.kind">{{ actorLabel(r.ev.actor) }}</span>
              <span v-if="r.count > 1" class="rw">latest of {{ r.count }}</span>
            </div>
            <pre class="selectable">{{ envelope(r) }}</pre>
          </div>
        </div>
      </template>

      <div v-if="!rows.length && filtering" class="empty">
        <Search />
        <strong>Nothing matches</strong>
        <span>No entry here answers to that. Widen it, or start again.</span>
        <button class="btn" @click="clear">Clear the filters</button>
      </div>
      <div v-else-if="!rows.length" class="empty">
        <ScrollText />
        <strong>Nothing logged yet</strong>
        <span>Every branch moved, agent turn and server started lands here, by itself.</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* A container query, not a media query: the window is wide, this column is
   whatever it was last dragged to (see ReviewTools). */
.journal { display: flex; flex-direction: column; height: 100%; container-type: inline-size; }

.bar {
  flex: none;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 10px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--line);
}
.seg .lucide { width: 12px; height: 12px; }

/* Searching a journal is reading it, so the field is part of the bar rather
   than a mode you enter. It takes the width left over and drops to a line of
   its own before it gets too narrow to type a word into. */
.find {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 130px;
  min-width: 120px;
  height: 28px;
  padding: 0 4px 0 9px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: var(--bg-sunken);
  color: var(--text-dim);
  transition:
    border-color var(--dur-1) var(--ease-soft),
    background var(--dur-1) var(--ease-soft),
    box-shadow var(--dur-1) var(--ease-soft);
}
.find:focus-within {
  border-color: var(--accent);
  background: var(--panel-raised);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.find input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: none;
  outline: none;
  color: var(--text);
  font: inherit;
  font-size: var(--fs-xs);
}
.find input::placeholder { color: var(--text-dim); }
.wipe {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  flex: none;
  border-radius: 5px;
  color: var(--text-dim);
}
.wipe:hover { background: var(--hover); color: var(--text); }
.wipe .lucide { width: 12px; height: 12px; }

.rows { flex: 1; overflow-y: auto; padding-bottom: 24px; }

/* Sticky, because the question "when was this" is asked while scrolling and
   never at the moment the header happens to pass. */
.day {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 28px;
  padding: 0 14px;
  background: var(--bg);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.day .rule { flex: 1; height: 1px; background: var(--line-soft); }
.day .dn { font-size: 11px; opacity: 0.75; }

/* ── the row ───────────────────────────────────────────────────────────
 * 13px, not 12: this is prose now, and the tab it sits in is read at the
 * same distance as the conversation beside it. The two fixed columns left
 * are the clock and one glyph; everything after them is the sentence. */
.r {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 28px;
  padding: 4px 10px 4px 12px;
  border-left: 2px solid transparent;
  font-size: var(--fs-sm);
  line-height: 1.45;
}
.r:hover { background: var(--hover); }
.r.open { background: var(--hover); }
.r.warn { border-left-color: var(--warn); }
.r.error { border-left-color: var(--danger); }

.t {
  flex: none;
  width: 58px;
  font-family: var(--mono);
  font-size: var(--fs-xs);
  color: var(--text-dim);
}

/* Subject in the glyph, author in its colour. A person's rows are the ground
   the agent's are read against, which is the comparison §12 asks the eye to
   make and the only one worth ink on every line. */
.ic { flex: none; color: var(--text-muted); }
.ic.agent { color: var(--agent); }
.ic.system { color: var(--text-dim); opacity: 0.75; }
.r.warn .ic { color: var(--warn); }
.r.error .ic { color: var(--danger); }

.ti { flex: none; color: var(--text); white-space: nowrap; }
.de {
  flex: 1;
  min-width: 0;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* How many times the same line happened, where the eye already is. */
.x {
  flex: none;
  height: 16px;
  min-width: 16px;
  padding: 0 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--hover);
  color: var(--text-dim);
  font-size: 10.5px;
  font-weight: 600;
}
/* One auto margin, not two: flexbox splits free space evenly between every
   auto margin on a line, so a note and a chevron each holding one left the
   note stranded in the middle of rows that had nothing else to say. */
.end {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
.no {
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.no.warn { color: var(--warn); }
.no.error { color: var(--danger); }

.ch {
  flex: none;
  color: var(--text-dim);
  opacity: 0;
  transition: opacity var(--dur-1) var(--ease-soft), transform var(--dur-2) var(--ease);
}
.r:hover .ch { opacity: 0.5; }
.r.open .ch { opacity: 0.7; transform: rotate(90deg); }

/* ── the envelope ──────────────────────────────────────────────────────
 * What was actually written, indented to the sentence it belongs to. */
.raw {
  margin: 2px 14px 10px 79px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line-soft);
  background: var(--bg-sunken);
}
.rmeta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 6px;
  font-size: 11px;
  color: var(--text-dim);
}
.rt { font-family: var(--mono); color: var(--text-muted); }
.rw.agent { color: var(--agent); }
.raw pre {
  margin: 0;
  max-height: 260px;
  overflow: auto;
  font-family: var(--mono);
  font-size: 11.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-muted);
}

.empty { gap: 8px; }
.empty .btn { margin-top: 6px; }

/* Under ~430px the sentence no longer fits on one line, so it takes two
   rather than being cut to eighty pixels — which is what the column layout
   this replaced did at every width this panel is actually used at. */
@container (max-width: 430px) {
  .seg .kl { display: none; }
  .r { flex-wrap: wrap; row-gap: 1px; }
  /* The note and the chevron stay on the title's line — they are two words
     about the act, not part of what it was about. */
  .end { order: 1; }
  .de { order: 2; flex-basis: 100%; padding-left: 67px; }
  .raw { margin-left: 24px; }
}
</style>
