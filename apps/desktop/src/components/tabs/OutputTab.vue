<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ArrowDown, CirclePlay, CircleStop, Copy, Eraser, ExternalLink, Logs, Search, Server, X,
} from '@lucide/vue'
import type { ProcessLog, ServerBoardRow, Workspace } from '@cockpit/shared'
import Splitter from '../Splitter.vue'
import {
  LAYOUT_LIMITS, clearRuntimeLogs, layout, loadRuntimeLogs, onRuntimeLogData, openDeclarations, refreshBoard,
  resetRunningHeight, saveLayout, setRunningHeight, state, toast, toggleWorkspaceRuntime,
} from '../../core/store.js'

/**
 * §8 — what this checkout's processes have written: its servers and the
 * commands run from the bar, one block per run.
 *
 * This was the Servers tool, and most of it was a board: every checkout of
 * the project with a runtime, its ports, and a switch per row. Then the bar
 * took the switch, the server picker and the ports, and the board was left
 * answering questions the bar already answers — at the top of the pane, over
 * the one thing only this pane has, which is the output. So the output is the
 * tool, and the tool is named for it.
 *
 * What is left of the board is the part the bar cannot say: what else in this
 * project is up. Listed only while something is, because a list of everything
 * that is down is a list of nothing happening. This checkout's own row is in
 * it too, first and marked, so the list reads as the whole project rather than
 * as everything except the one you are looking at.
 *
 * Each run keeps its own seams. The pane used to be one string per workspace,
 * so three failed starts read as one long error with no way to tell where one
 * attempt ended — and the history and the live buffer were both printed, so
 * every line said twice.
 */

/** `wholeProject`: every repository of the project, each run named for where it ran. */
const props = defineProps<{ workspace: Workspace; wholeProject?: boolean }>()

/** What the pane speaks for: this checkout, or every one the project holds. */
const covered = computed<Workspace[]>(() =>
  props.wholeProject
    ? state.workspaces.filter((w) => w.projectId === props.workspace.projectId && w.kind !== 'group')
    : [props.workspace],
)
const coveredKey = computed(() => covered.value.map((w) => w.id).join(','))
const coveredIds = computed(() => new Set(covered.value.map((w) => w.id)))

/** A run's name: across a project, the repository comes first. */
function tag(wsId: string, label: string): string {
  if (!props.wholeProject) return label
  return (state.workspaces.find((w) => w.id === wsId)?.name ?? '?') + ' · ' + label
}

const history = ref<(ProcessLog & { workspaceId: string })[]>([])
const body = ref<HTMLElement | null>(null)
const follow = ref(true)
/** Which process's runs are shown; null is all of them. */
const only = ref<string | null>(null)
const q = ref('')

type Status = 'running' | 'exited' | 'failed'
type Tone = '' | 'err' | 'warn'
interface Line { text: string; tone: Tone; parts: { t: string; url?: string }[] | null }
interface Run { id: string; label: string; proc: string; wsId: string; at: number; status: Status; code: number | null; lines: Line[] }

/** One run's lines, bounded: a pane is read from the bottom. */
const RUN_LINES = 800

// Up here rather than beside `split`: the watch on `labels` reads the runs as
// soon as it is set up, and a `const` below it is not there yet.
// Written as an escape rather than a literal ESC byte: a control character in
// source survives until something normalises it away, and then strips
// nothing while still looking correct.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g
const ERR = /\b(error|err!|fatal|failed|exception|enoent|eaddrinuse|eacces|cannot find|not found)\b/i
const WARN = /\b(warn|warning|deprecated)\b/i
const URL_RE = /(https?:\/\/[^\s'"<>)]+)/g

/* ── the runs ──────────────────────────────────────────────────────── */

function statusOf(id: string, fallback: Status, code: number | null): { status: Status; code: number | null } {
  if (!(id in state.procExits)) return { status: fallback, code }
  const c = state.procExits[id] ?? null
  return { status: c === 0 ? 'exited' : 'failed', code: c }
}

const runs = computed<Run[]>(() => {
  const out: Run[] = []
  const known = new Set<string>()
  for (const h of history.value) {
    known.add(h.procId)
    const live = state.procOutput[h.procId]?.text ?? ''
    const st = h.status === 'running' ? statusOf(h.procId, 'running', null) : { status: h.status, code: h.exitCode }
    out.push({ id: h.procId, label: tag(h.workspaceId, h.label), proc: h.label, wsId: h.workspaceId, at: h.startedAt, ...st, lines: split(h.text + live) })
  }
  // Started since the history was read: only the live buffer knows of it.
  for (const [id, o] of Object.entries(state.procOutput)) {
    if (!coveredIds.value.has(o.workspaceId) || known.has(id)) continue
    out.push({ id, label: tag(o.workspaceId, o.label), proc: o.label, wsId: o.workspaceId, at: o.at, ...statusOf(id, 'running', null), lines: split(o.text) })
  }
  // A finished run with nothing left to say is only noise — a running one
  // is kept, because "web · running" over an empty body is still an answer.
  return out.filter((r) => r.lines.length || r.status === 'running').sort((a, b) => a.at - b.at)
})

/**
 * The names, each with the state of its latest run — the same dot the bar
 * uses. Offered as a filter only once there are two: one name is "all".
 */
const labels = computed(() => {
  const m = new Map<string, Status>()
  for (const r of runs.value) m.set(r.label, r.status)
  return [...m].map(([name, status]) => ({ name, status }))
})
watch(labels, (l) => {
  if (only.value && !l.some((x) => x.name === only.value)) only.value = null
})

const shown = computed(() => {
  const needle = q.value.trim().toLowerCase()
  const list = only.value ? runs.value.filter((r) => r.label === only.value) : runs.value
  if (!needle) return list
  return list
    .map((r) => ({ ...r, lines: r.lines.filter((l) => l.text.toLowerCase().includes(needle)) }))
    .filter((r) => r.lines.length)
})

const filtering = computed(() => !!q.value.trim() || !!only.value)

/* ── a line ────────────────────────────────────────────────────────── */

function split(raw: string): Line[] {
  const rows = raw.replace(ANSI, '').split('\n')
  if (rows.length && rows[rows.length - 1] === '') rows.pop()
  return rows.slice(-RUN_LINES).map((row) => {
    // A progress bar redraws its line with `\r`; only the last draw is real.
    const text = row.includes('\r') ? (row.split('\r').filter(Boolean).pop() ?? '') : row
    const tone: Tone = ERR.test(text) ? 'err' : WARN.test(text) ? 'warn' : ''
    return { text, tone, parts: text.includes('http') ? linkify(text) : null }
  })
}

/** `Local: http://localhost:5173/` is the line people go looking for. */
function linkify(text: string): Line['parts'] {
  const parts: { t: string; url?: string }[] = []
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    const i = m.index ?? 0
    if (i > last) parts.push({ t: text.slice(last, i) })
    parts.push({ t: m[0], url: m[0] })
    last = i + m[0].length
  }
  if (last < text.length) parts.push({ t: text.slice(last) })
  return parts
}

function openUrl(url: string) {
  window.open(url, '_blank')
}

/* ── what a run's header says ──────────────────────────────────────── */

function clock(ts: number): string {
  const d = new Date(ts)
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString()
    ? t
    : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + t
}

function stateWord(r: Run): string {
  if (r.status === 'running') return 'running'
  if (r.status === 'exited') return 'done'
  return r.code == null ? 'stopped' : 'exited ' + r.code
}

/** The port a running server is bound to, when the name says which. */
function portOf(r: Run): number | null {
  if (r.status !== 'running') return null
  return covered.value.find((w) => w.id === r.wsId)?.runtime?.ports.find((p) => p.name === r.proc)?.port ?? null
}

/* ── loading, following ────────────────────────────────────────────── */

async function load() {
  const key = coveredKey.value
  const got = await Promise.all(
    covered.value.map(async (w) => (await loadRuntimeLogs(w.id)).map((l) => ({ ...l, workspaceId: w.id }))),
  )
  if (coveredKey.value === key) history.value = got.flat()
}

watch(
  coveredKey,
  () => {
    history.value = []
    only.value = null
    follow.value = true
    void load().then(toBottom)
  },
  { immediate: true },
)

// Refreshed on the way in: the other branches are a snapshot and the tab may
// have been closed while three topics came and went.
void refreshBoard()
watch(() => covered.value.map((w) => w.runtime?.status).join(), () => void refreshBoard())

let stops: (() => void)[] = []
watch(
  coveredKey,
  () => {
    for (const s of stops) s()
    stops = covered.value.map((w) =>
      onRuntimeLogData(w.id, () => {
        if (follow.value) void toBottom()
      }),
    )
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  for (const s of stops) s()
})

async function toBottom() {
  await nextTick()
  const el = body.value
  if (el) el.scrollTop = el.scrollHeight
}

/** Scrolling up means you are reading; scrolling back down means you are not. */
function onScroll() {
  const el = body.value
  if (!el) return
  follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}

function jump() {
  follow.value = true
  void toBottom()
}

watch([only, q], () => {
  if (follow.value) void toBottom()
})

/* ── the two verbs ─────────────────────────────────────────────────── */

async function clear() {
  for (const w of covered.value) if (!(await clearRuntimeLogs(w.id))) return
  only.value = null
  q.value = ''
  await load()
}

async function copy() {
  const text = shown.value
    .map((r) => '── ' + r.label + ' · ' + clock(r.at) + ' · ' + stateWord(r) + '\n' + r.lines.map((l) => l.text).join('\n'))
    .join('\n\n')
  await navigator.clipboard.writeText(text)
  toast('ok', filtering.value ? 'copied what is shown' : 'copied', { icon: 'copy' })
}

/* ── the rest of the project ───────────────────────────────────────── */

/** This checkout, or another repository of the same topic. */
function isCurrent(r: ServerBoardRow): boolean {
  // On the project every row is equally "here", so none is marked.
  if (props.wholeProject) return false
  if (r.workspaceId === props.workspace.id) return true
  const topic = props.workspace.topicId
  return !!topic && state.workspaces.find((w) => w.id === r.workspaceId)?.topicId === topic
}

const running = computed(() =>
  state.board
    .filter((r) => r.projectId === props.workspace.projectId && (r.status === 'up' || r.status === 'starting'))
    .map((r) => ({ ...r, current: isCurrent(r) }))
    // Stable: current first, the rest in the board's own order.
    .sort((a, b) => Number(b.current) - Number(a.current)),
)

/** Which word the badge uses: a topic's repositories are all "this topic". */
const currentWord = computed(() => (props.workspace.topicId ? 'this topic' : 'current'))

/*
 * The list's height, draggable like the commit box: left alone it is as tall
 * as its rows up to a third of the pane, and a drag turns that into a number.
 * Measured, so the first pixel of a drag starts from where the list is.
 */
const root = ref<HTMLElement | null>(null)
const list = ref<HTMLElement | null>(null)
const measured = ref(LAYOUT_LIMITS.running.min)
const paneH = ref(0)
/** The output keeps at least 120px: the list is beside it, not instead of it. */
const runningMax = computed(() =>
  Math.max(LAYOUT_LIMITS.running.min, Math.min(LAYOUT_LIMITS.running.max, paneH.value - 160)),
)

let ro: ResizeObserver | null = null
let listRo: ResizeObserver | null = null
onMounted(() => {
  ro = new ResizeObserver(([e]) => {
    if (!e) return
    paneH.value = e.contentRect.height
    if (layout.running && layout.running > runningMax.value) setRunningHeight(runningMax.value)
  })
  if (root.value) ro.observe(root.value)
  listRo = new ResizeObserver(([e]) => {
    if (e) measured.value = (e.target as HTMLElement).offsetHeight
  })
  watch(
    list,
    (el, old) => {
      if (old) listRo?.unobserve(old)
      if (el) listRo?.observe(el)
    },
    { immediate: true },
  )
})
onBeforeUnmount(() => {
  ro?.disconnect()
  listRo?.disconnect()
})

/**
 * The topic, when there is one: it is what tells two rows of the same
 * repository apart. Never the project — the heading already names it.
 */
function contextOf(r: ServerBoardRow): string | null {
  return r.topic
}

async function stopRow(id: string) {
  const w = state.workspaces.find((x) => x.id === id)
  if (w) await toggleWorkspaceRuntime(w)
}

/* ── an empty pane ─────────────────────────────────────────────────── */

/** Nothing declared to run here: no server, no command — say so, and offer the way in. */
const runnable = computed(() => covered.value.some((w) => !!w.runtime) || state.commands.length > 0)

function setUp() {
  openDeclarations(props.wholeProject ? undefined : props.workspace.repoName, 'server')
}

const canStart = computed(() => {
  // One switch per repository, and each has its own on its row's bar.
  const rt = props.wholeProject ? null : props.workspace.runtime
  return !!rt && rt.status !== 'up' && rt.status !== 'starting'
})

async function start() {
  await toggleWorkspaceRuntime(props.workspace)
}
</script>

<template>
  <div ref="root" class="output">
    <div class="bar">
      <div v-if="labels.length > 1" class="seg">
        <button :class="{ on: !only }" @click="only = null">All</button>
        <button
          v-for="l in labels"
          :key="l.name"
          :class="{ on: only === l.name }"
          :title="l.name + ' — ' + l.status"
          @click="only = only === l.name ? null : l.name"
        >
          <i class="dot" :class="l.status" />{{ l.name }}
        </button>
      </div>
      <label class="find">
        <Search class="sm" />
        <input v-model="q" placeholder="Filter lines" spellcheck="false" />
        <button v-if="q" class="wipe" title="Clear the filter" @click="q = ''"><X /></button>
      </label>
      <span class="tools">
        <button class="icon-btn" title="Copy what is shown" :disabled="!shown.length" @click="copy">
          <Copy class="sm" />
        </button>
        <button class="icon-btn" title="Clear the output" :disabled="!runs.length" @click="clear">
          <Eraser class="sm" />
        </button>
      </span>
    </div>

    <div class="pane">
    <div ref="body" class="runs" @scroll="onScroll">
      <section v-for="r in shown" :key="r.id" class="run" :class="r.status">
        <!-- Sticky, like the journal's days: "which run is this" is asked
             while scrolling through it, not when its first line goes by. -->
        <header class="rhead">
          <i class="dot" :class="r.status" />
          <span class="rl">{{ r.label }}</span>
          <span class="rt num">{{ clock(r.at) }}</span>
          <span class="rs" :class="r.status">{{ stateWord(r) }}</span>
          <span class="rule" />
          <button
            v-if="portOf(r)"
            class="rport num"
            :title="'Open http://localhost:' + portOf(r)"
            @click="openUrl('http://localhost:' + portOf(r))"
          >:{{ portOf(r) }}<ExternalLink /></button>
        </header>
        <pre class="lines selectable"><template v-for="(l, i) in r.lines" :key="i"><span class="ln" :class="l.tone"><template v-if="l.parts"><template v-for="(p, j) in l.parts" :key="j"><a v-if="p.url" href="#" @click.prevent="openUrl(p.url)">{{ p.t }}</a><template v-else>{{ p.t }}</template></template></template><template v-else>{{ l.text }}</template></span>
</template><span v-if="!r.lines.length" class="quiet">Nothing written yet.</span></pre>
      </section>

      <div v-if="!shown.length && filtering" class="empty">
        <Search />
        <strong>Nothing matches</strong>
        <span>No line here answers to that.</span>
        <button class="btn" @click="q = ''; only = null">Clear the filter</button>
      </div>
      <div v-else-if="!shown.length && !runnable" class="empty">
        <Server />
        <strong>Nothing to run here</strong>
        <span>{{ wholeProject ? 'No repository of this project declares a server or a command yet.' : 'This repository declares no server and no command yet.' }} Set one up and its output lands here.</span>
        <button class="btn" @click="setUp"><Server /> Set up a server</button>
      </div>
      <div v-else-if="!shown.length" class="empty">
        <Logs />
        <strong>Nothing written yet</strong>
        <span>Start the servers or run a command — whatever they print lands here, one block per run.</span>
        <button v-if="canStart" class="btn" @click="start"><CirclePlay /> Start</button>
      </div>
    </div>

    <button v-if="!follow && shown.length" class="jump" @click="jump">
      <ArrowDown /> Newest
    </button>
    </div>

    <!-- The part of the old board the bar cannot say. -->
    <template v-if="running.length">
      <Splitter
        :size="measured"
        :min="LAYOUT_LIMITS.running.min"
        :max="runningMax"
        grows="up"
        label="Height of the running list"
        @resize="setRunningHeight"
        @done="saveLayout"
        @reset="resetRunningHeight"
      />
    <div
      ref="list"
      class="else"
      :style="layout.running ? { height: layout.running + 'px', maxHeight: 'none' } : undefined"
    >
      <div class="ehead">Running in this project</div>
      <div v-for="r in running" :key="r.workspaceId" class="erow" :class="{ current: r.current }">
        <i class="dot" :class="r.status === 'up' ? 'running' : 'starting'" />
        <span class="en">{{ r.workspace }}</span>
        <span v-if="r.current" class="ebadge">{{ currentWord }}</span>
        <span v-if="contextOf(r)" class="ec">{{ contextOf(r) }}</span>
        <span class="grow" />
        <span v-for="p in r.ports" :key="p.name" class="ep num" :title="p.name">:{{ p.port }}</span>
        <button v-if="r.url" class="icon-btn" title="Open it" @click="openUrl(r.url)"><ExternalLink class="sm" /></button>
        <button class="icon-btn" title="Stop it" @click="stopRow(r.workspaceId)"><CircleStop class="sm" /></button>
      </div>
    </div>
    </template>
  </div>
</template>

<style scoped>
.output {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  container-type: inline-size;
}

/* ── the bar — the journal's, so the two read as one family ────────── */
.bar {
  flex: none;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 10px;
  padding: 9px 10px 9px 14px;
  border-bottom: 1px solid var(--line);
}
.seg { max-width: 100%; overflow-x: auto; scrollbar-width: none; }
.seg > button { white-space: nowrap; }
.seg .dot { margin-right: 1px; }

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
.tools { display: flex; gap: 2px; flex: none; margin-left: auto; }

/* ── status: one dot, one set of colours, everywhere in the pane ───── */
.dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: var(--text-dim);
  opacity: 0.6;
}
.dot.running { background: var(--ok); opacity: 1; }
.dot.starting { background: var(--warn); opacity: 1; }
.dot.failed { background: var(--danger); opacity: 1; }

/* ── the runs ──────────────────────────────────────────────────────── */
.pane { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.runs { flex: 1; min-height: 0; overflow-y: auto; padding-bottom: 20px; }

.rhead {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 10px 0 14px;
  background: var(--surface-review);
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.rl { color: var(--text); font-weight: 600; }
.rt { opacity: 0.8; }
.rs.running { color: var(--ok); }
.rs.failed { color: var(--danger); }
.rhead .rule { flex: 1; height: 1px; background: var(--line-soft); }
.rport {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-muted);
  background: var(--hover);
}
.rport:hover { background: var(--active); color: var(--text); }
.rport .lucide { width: 11px; height: 11px; }

/* The text is the content, so it gets the room: a hairline down its left
   edge ties the lines to the header above them, and it turns red when the
   run did — the colour of the rail is the answer before a word is read. */
.lines {
  margin: 2px 12px 12px 17px;
  padding: 2px 0 2px 12px;
  border-left: 1px solid var(--line);
  font-family: var(--mono);
  font-size: var(--fs-xs);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-muted);
}
.run.failed .lines { border-left-color: var(--danger-soft); }
.run.running .lines { border-left-color: var(--ok-soft); }
.ln.err { color: var(--danger); }
.ln.warn { color: var(--warn); }
.lines a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
.quiet { color: var(--text-dim); font-family: var(--font); }

/* ── newest ────────────────────────────────────────────────────────── */
/* Floating over the text rather than in the bar: it is about the bottom of
   the pane, and the bottom of the pane is where it points. */
.jump {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 11px;
  border-radius: 13px;
  border: 1px solid var(--line);
  background: var(--panel-raised);
  box-shadow: var(--shadow-md);
  font-size: var(--fs-xs);
  color: var(--text-muted);
  z-index: 2;
}
.jump:hover { color: var(--text); }
.jump .lucide { width: 12px; height: 12px; }

/* ── elsewhere ─────────────────────────────────────────────────────── */
.else {
  flex: none;
  max-height: 30%;
  overflow-y: auto;
  border-top: 1px solid var(--line);
  padding: 6px 0 8px;
}
.ehead {
  padding: 4px 14px 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.erow {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 8px 0 14px;
  font-size: var(--fs-sm);
}
.en { color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ec { color: var(--text-dim); font-size: var(--fs-xs); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.grow { flex: 1; }
.ep {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-muted);
  background: var(--hover);
  border-radius: var(--radius-sm);
  padding: 1px 6px;
}
.erow .icon-btn { width: 24px; height: 24px; }
.erow.current .en { font-weight: 600; }
.ebadge {
  flex: none;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  font-size: 10.5px;
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-soft);
  white-space: nowrap;
}
</style>
