<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { ChevronDown, ChevronUp, Copy, Eraser, History, RotateCcw, Search, X } from '@lucide/vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type { TerminalCommand, Workspace } from '@cockpit/shared'
import { client, guard, onTermData, onTermExit, state, toast } from '../../core/store.js'

/**
 * §2 — "Il en embarque un, indispensable comme porte de sortie."
 * A real TTY running the user's own shell; the cockpit never pretends to
 * replace it.
 */

/** `wholeProject`: the shell opens at the project's root folder, not in this checkout. */
const props = defineProps<{ workspace: Workspace; wholeProject?: boolean }>()

const host = ref<HTMLElement | null>(null)
const findInput = ref<HTMLInputElement | null>(null)
const term = shallowRef<Terminal | null>(null)
const fit = shallowRef<FitAddon | null>(null)
const search = shallowRef<SearchAddon | null>(null)
const termId = ref<string | null>(null)
const error = ref<string | null>(null)
/** The shell ended on its own; the next Enter starts another in its place. */
const exited = ref(false)
const q = ref('')
const hits = ref<{ index: number; count: number } | null>(null)
let unsubscribe: (() => void) | null = null
let unsubscribeExit: (() => void) | null = null
let ro: ResizeObserver | null = null

const isMac = navigator.platform.toLowerCase().includes('mac')

function readVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/**
 * A colour token, as a colour.
 *
 * This is why the shell came up in white on the light theme. A custom property
 * is *substituted*, not resolved: `getPropertyValue('--text')` hands back the
 * literal string `light-dark(#16161c, #ecedf3)`, which is a perfectly good CSS
 * value and not a colour xterm can parse. It fell back to its own palette —
 * white on black — and `.xterm-viewport { background: transparent }` hid the
 * black half, leaving white text on the app's light ground.
 *
 * Reading it back off a real element makes the browser do the resolving, which
 * is the only thing that can: `light-dark()` needs the `color-scheme` in force
 * at that point in the tree, and the tokens are written as one palette in
 * light-dark pairs on purpose (tokens.css). The probe goes in the body so it
 * inherits the same scheme the app is drawn in.
 */
function readColor(name: string, fallback: string): string {
  const probe = document.createElement('span')
  probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;color:var(${name})`
  document.body.appendChild(probe)
  const v = getComputedStyle(probe).color
  probe.remove()
  return v || fallback
}

/** The four colours xterm is told about, read fresh from the tokens. */
function palette() {
  return {
    background: readColor('--surface-review', '#0c0c0f'),
    foreground: readColor('--text', '#16161c'),
    cursor: readColor('--accent', '#5b58e0'),
    selectionBackground: readColor('--accent-soft', 'rgba(91,88,224,0.16)'),
  }
}

/**
 * `a` laid over `b` at `t`, as `#rrggbb`.
 *
 * The search addon draws its highlights as decorations and takes nothing but
 * opaque hex — no `rgb()`, no alpha, no token. So the soft warn tint the rest
 * of the window uses for "this matched" is mixed onto the pane by hand.
 */
function mix(a: string, b: string, t: number): string {
  const rgb = (c: string) => (c.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number)
  const [x, y] = [rgb(a), rgb(b)]
  return '#' + x.map((v, i) => Math.round(v * t + (y[i] ?? 0) * (1 - t)).toString(16).padStart(2, '0')).join('')
}

function findOptions(): ISearchOptions {
  const ground = readColor('--surface-review', '#ffffff')
  const warn = readColor('--warn', '#9d6410')
  return {
    decorations: {
      matchBackground: mix(warn, ground, 0.2),
      matchOverviewRuler: mix(warn, ground, 0.5),
      activeMatchBackground: mix(warn, ground, 0.45),
      activeMatchColorOverviewRuler: mix(warn, ground, 1),
    },
  }
}

/**
 * The line-editing keys every Mac text field has, as the shell spells them.
 * xterm already turns ⌥← / ⌥→ / ⌥⌫ into words; ⌘ it leaves alone, because
 * on another platform it would be the Windows key.
 */
const MAC_KEYS: Record<string, string> = {
  ArrowLeft: '\x01', // ^A — start of line
  ArrowRight: '\x05', // ^E — end of line
  Backspace: '\x15', // ^U — erase to the start of the line
}

function onKey(e: KeyboardEvent): boolean {
  const meta = isMac ? e.metaKey : e.ctrlKey && e.shiftKey
  // The window's view chord, not the shell's: left to bubble, or xterm turns
  // ⌘⌥← into an escape sequence and the prompt gets it instead of the ladder.
  if (e.metaKey && e.altKey && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) return false
  if (!meta || e.altKey) return true
  if (e.key.toLowerCase() === 'f') {
    if (e.type === 'keydown') openFind()
    e.preventDefault()
    return false
  }
  if (e.key.toLowerCase() === 'y' && !e.shiftKey) {
    if (e.type === 'keydown') void openHistory()
    e.preventDefault()
    return false
  }
  const seq = isMac && !e.shiftKey && !e.ctrlKey ? MAC_KEYS[e.key] : undefined
  if (seq) {
    if (e.type === 'keydown') send(seq)
    e.preventDefault()
    return false
  }
  return true
}

function send(d: string) {
  if (exited.value) {
    // Enter on a dead shell is the one keystroke that means anything.
    if (d === '\r') void boot()
    return
  }
  if (termId.value) void client.call('terminal.write', { termId: termId.value, data: d })
}

async function boot() {
  await teardown()
  const el = host.value
  if (!el) return
  error.value = null
  exited.value = false

  const t = new Terminal({
    fontFamily: readVar('--mono', 'monospace'),
    fontSize: 13,
    lineHeight: 1.45,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 5000,
    theme: palette(),
  })
  const f = new FitAddon()
  const s = new SearchAddon()
  t.loadAddon(f)
  t.loadAddon(s)
  // ⌘-click, as in every Mac terminal: a plain click in a terminal is a
  // selection starting, and a dev server prints its URL on every restart.
  t.loadAddon(
    new WebLinksAddon((ev, uri) => {
      if (ev.metaKey || ev.ctrlKey) window.open(uri, '_blank')
    }),
  )
  s.onDidChangeResults(({ resultIndex, resultCount }) => {
    hits.value = { index: resultIndex, count: resultCount }
  })
  t.attachCustomKeyEventHandler(onKey)
  t.open(el)
  f.fit()
  term.value = t
  fit.value = f
  search.value = s

  const res = await guard(() =>
    client.call('terminal.open', {
      ...(props.wholeProject ? { projectId: props.workspace.projectId } : { workspaceId: props.workspace.id }),
      cols: t.cols,
      rows: t.rows,
    }),
  )
  if (!res) {
    error.value = 'Could not open a terminal (node-pty unavailable in the core).'
    return
  }
  termId.value = res.termId
  unsubscribe = onTermData(res.termId, (d) => t.write(d))
  unsubscribeExit = onTermExit(res.termId, () => {
    termId.value = null
    exited.value = true
    t.write('\r\n\x1b[2m[process exited — press Enter to start a new shell]\x1b[0m\r\n')
  })

  t.onData(send)

  ro = new ResizeObserver(() => {
    try {
      f.fit()
      if (termId.value) {
        void client.call('terminal.resize', { termId: termId.value, cols: t.cols, rows: t.rows })
      }
    } catch {
      /* element detached */
    }
  })
  ro.observe(el)
  t.focus()
}

async function teardown() {
  ro?.disconnect()
  ro = null
  unsubscribe?.()
  unsubscribe = null
  unsubscribeExit?.()
  unsubscribeExit = null
  if (termId.value) {
    const id = termId.value
    termId.value = null
    await client.call('terminal.close', { termId: id }).catch(() => undefined)
  }
  term.value?.dispose()
  term.value = null
  search.value = null
  hits.value = null
}

/* ── the bar ───────────────────────────────────────────────────────── */

/** ⌘K in Terminal.app: scrollback gone, the prompt kept as the first line. */
function clear() {
  const t = term.value
  if (!t) return
  t.clear()
  search.value?.clearDecorations()
  hits.value = null
  t.focus()
}

async function restart() {
  await boot()
}

/** The selection if there is one, else everything the buffer still holds. */
async function copy() {
  const t = term.value
  if (!t) return
  let text = t.getSelection()
  const all = !text
  if (all) {
    const b = t.buffer.active
    const lines: string[] = []
    for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '')
    text = lines.join('\n').replace(/\s+$/, '')
  }
  if (!text) return
  await navigator.clipboard.writeText(text)
  toast('ok', all ? 'copied the terminal' : 'copied the selection', { icon: 'copy' })
  t.focus()
}

function openFind() {
  const sel = term.value?.getSelection()
  if (sel && !sel.includes('\n')) q.value = sel
  void nextTick(() => {
    findInput.value?.focus()
    findInput.value?.select()
  })
}

function find(dir: 1 | -1, incremental = false) {
  const s = search.value
  if (!s) return
  if (!q.value) {
    s.clearDecorations()
    term.value?.clearSelection()
    hits.value = null
    return
  }
  const opts = { ...findOptions(), incremental }
  if (dir === 1) s.findNext(q.value, opts)
  else s.findPrevious(q.value, opts)
}

function closeFind() {
  q.value = ''
  find(1)
  term.value?.focus()
}

function onFindKey(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    find(e.shiftKey ? -1 : 1)
  } else if (e.key === 'Escape') {
    // Not up to the window: Escape here means "done finding", not "leave
    // the terminal for the conversation".
    e.preventDefault()
    e.stopPropagation()
    closeFind()
  }
}

watch(q, () => find(1, true))

/* ── the history ───────────────────────────────────────────────────── */

/**
 * What was run in this project's terminals, whichever shell ran it and
 * whenever. Find searches what is on the screen; this is for what is not
 * there any more — cleared, restarted over, or typed last week. The core
 * keeps it (the shell reports each line as it runs it), so it is read when
 * the panel opens and on every change of the query, not held here.
 */
const historyOpen = ref(false)
const historyInput = ref<HTMLInputElement | null>(null)
const historyList = ref<HTMLElement | null>(null)
const hq = ref('')
const commands = ref<TerminalCommand[]>([])
const picked = ref(0)
/** Answers arrive in the order they were asked only by luck; the last asked wins. */
let asked = 0

async function loadHistory() {
  const mine = ++asked
  const rows = await client
    .call('terminal.history', { projectId: props.workspace.projectId, q: hq.value || undefined })
    .catch(() => [] as TerminalCommand[])
  if (mine !== asked) return
  commands.value = rows
  picked.value = 0
}

async function openHistory() {
  if (historyOpen.value) {
    historyInput.value?.focus()
    return
  }
  hq.value = ''
  historyOpen.value = true
  void nextTick(() => historyInput.value?.focus())
  await loadHistory()
}

function closeHistory() {
  historyOpen.value = false
  term.value?.focus()
}

function toggleHistory() {
  if (historyOpen.value) closeHistory()
  else void openHistory()
}

/**
 * Onto the prompt, and — only when asked — run. Pasted rather than written:
 * a command of several lines sent raw would run its first line on the way in,
 * and a paste is what the shell knows how to hold until Enter.
 */
function use(c: TerminalCommand, run: boolean) {
  closeHistory()
  if (exited.value) return
  term.value?.paste(c.command)
  if (run) send('\r')
}

async function forget(c: TerminalCommand) {
  await client.call('terminal.forget', { projectId: props.workspace.projectId, command: c.command }).catch(() => undefined)
  const at = picked.value
  await loadHistory()
  picked.value = Math.min(at, Math.max(0, commands.value.length - 1))
  historyInput.value?.focus()
}

function onHistoryKey(e: KeyboardEvent) {
  const n = commands.value.length
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    if (!n) return
    picked.value = (picked.value + (e.key === 'ArrowDown' ? 1 : -1) + n) % n
    void nextTick(() => historyList.value?.querySelector('.cmd.on')?.scrollIntoView({ block: 'nearest' }))
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const c = commands.value[picked.value]
    if (c) use(c, e.metaKey || e.ctrlKey)
  } else if (e.key === 'Escape') {
    // As in Find: done with the history, not done with the terminal.
    e.preventDefault()
    e.stopPropagation()
    closeHistory()
  }
}

watch(hq, () => void loadHistory())

/** Where a run was, when the history spans more than the checkout in front of you. */
function place(c: TerminalCommand): string {
  if (!c.workspaceId || (!props.wholeProject && c.workspaceId === props.workspace.id)) return ''
  return state.workspaces.find((w) => w.id === c.workspaceId)?.name ?? ''
}

function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return Math.floor(s / 60) + 'm'
  if (s < 86400) return Math.floor(s / 3600) + 'h'
  if (s < 86400 * 30) return Math.floor(s / 86400) + 'd'
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/**
 * The appearance changing repaints the shell in place.
 *
 * Two sources, because there are two ways it changes: the setting in the rail,
 * and — while that setting is 'system' — the OS deciding it is evening. The
 * terminal is the one surface in the window that does not get this for free:
 * everything else is CSS and re-resolves itself, while xterm was handed four
 * colours once at boot and would have kept them until the tab was closed.
 */
const scheme = window.matchMedia('(prefers-color-scheme: dark)')
function repaint() {
  const t = term.value
  if (t) t.options.theme = palette()
}
scheme.addEventListener('change', repaint)

onMounted(boot)
onBeforeUnmount(() => {
  scheme.removeEventListener('change', repaint)
  void teardown()
})
watch(() => (props.wholeProject ? 'project:' + props.workspace.projectId : props.workspace.id), () => {
  historyOpen.value = false
  void boot()
})
// After the attribute lands on the root, not with it: `palette()` reads the
// scheme in force, and reading it in the same tick as the change gets the old
// one back.
watch(() => state.theme, () => void nextTick(repaint))
</script>

<template>
  <div class="terminal">
    <div class="bar">
      <label class="find">
        <Search class="sm" />
        <input
          ref="findInput"
          v-model="q"
          :placeholder="isMac ? 'Find  ⌘F' : 'Find'"
          spellcheck="false"
          @keydown="onFindKey"
        />
        <template v-if="q">
          <span class="count num">{{
            !hits || !hits.count ? 'none' : hits.index < 0 ? hits.count + '+' : hits.index + 1 + ' of ' + hits.count
          }}</span>
          <button class="wipe" title="Previous  ⇧↵" :disabled="!hits?.count" @click="find(-1)"><ChevronUp /></button>
          <button class="wipe" title="Next  ↵" :disabled="!hits?.count" @click="find(1)"><ChevronDown /></button>
          <button class="wipe" title="Close  Esc" @click="closeFind"><X /></button>
        </template>
      </label>
      <span class="tools">
        <button
          class="icon-btn"
          :class="{ on: historyOpen }"
          :title="isMac ? 'History  ⌘Y' : 'History'"
          @click="toggleHistory"
        >
          <History class="sm" />
        </button>
        <button class="icon-btn" title="Copy the selection, or everything" :disabled="!term" @click="copy">
          <Copy class="sm" />
        </button>
        <button class="icon-btn" title="Clear the scrollback" :disabled="!term" @click="clear">
          <Eraser class="sm" />
        </button>
        <button class="icon-btn" title="Restart the shell" @click="restart">
          <RotateCcw class="sm" />
        </button>
      </span>
    </div>
    <div class="wrap">
      <div v-if="error" class="empty"><strong>Terminal unavailable</strong><span>{{ error }}</span></div>
      <div ref="host" class="term" />
      <div v-if="historyOpen" class="history">
        <label class="find wide">
          <Search class="sm" />
          <input
            ref="historyInput"
            v-model="hq"
            placeholder="Search the commands run in this project"
            spellcheck="false"
            @keydown="onHistoryKey"
          />
          <button class="wipe" title="Close  Esc" @click="closeHistory"><X /></button>
        </label>
        <div v-if="commands.length" ref="historyList" class="cmds">
          <div
            v-for="(c, i) in commands"
            :key="c.command"
            class="cmd"
            role="button"
            :class="{ on: i === picked, failed: !!c.exitCode }"
            :title="c.command"
            @mousemove="picked = i"
            @click="use(c, $event.metaKey || $event.ctrlKey)"
          >
            <span class="line">{{ c.command.replace(/\s*\n\s*/g, ' ⏎ ') }}</span>
            <span v-if="place(c)" class="meta place">{{ place(c) }}</span>
            <span v-if="c.exitCode" class="meta code num" :title="'Last run ended with ' + c.exitCode">{{ c.exitCode }}</span>
            <span v-if="c.count > 1" class="meta num" :title="'Run ' + c.count + ' times'">×{{ c.count }}</span>
            <span class="meta num when">{{ ago(c.ts) }}</span>
            <button class="wipe" title="Forget this command" @click.stop="forget(c)"><X /></button>
          </div>
        </div>
        <div v-else class="empty">
          <template v-if="hq"><strong>No command matches</strong></template>
          <template v-else>
            <strong>Nothing run here yet</strong>
            <span>Every command run in this project's terminals is kept here, across restarts and Clear.</span>
          </template>
        </div>
        <div v-if="commands.length" class="keys">
          <span><kbd>↵</kbd> to the prompt</span>
          <span><kbd>{{ isMac ? '⌘' : 'Ctrl' }}↵</kbd> run</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.terminal {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--surface-review);
}

/* ── the bar — Output's, so the review tools read as one family ────── */
.bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px 10px;
  padding: 9px 10px 9px 14px;
  border-bottom: 1px solid var(--line);
}
.find {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 1 320px;
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
.count { flex: none; font-size: 11px; color: var(--text-dim); padding-right: 2px; }
.wipe {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  flex: none;
  border-radius: 5px;
  color: var(--text-dim);
}
.wipe:hover:not(:disabled) { background: var(--hover); color: var(--text); }
.wipe:disabled { opacity: 0.4; }
.wipe .lucide { width: 12px; height: 12px; }
.tools { display: flex; gap: 2px; flex: none; margin-left: auto; }

.wrap { position: relative; flex: 1; min-height: 0; padding: 14px 8px 8px 16px; }

/*
 * The history, over the shell rather than beside it: the pane is as narrow as
 * 360px, and a command is read whole or not at all. The shell keeps running
 * underneath and is exactly where it was when this closes.
 */
.history {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 10px 8px 14px;
  background: var(--surface-review);
}
.find.wide { flex: none; }
.cmds { flex: 1; min-height: 0; overflow-y: auto; margin-right: -6px; padding-right: 6px; }
.cmd {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 4px 0 9px;
  border-radius: var(--radius-sm);
}
.cmd.on { background: var(--hover); }
.cmd .line {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-family: var(--mono);
  font-size: var(--fs-xs);
  color: var(--text);
}
.cmd .meta { flex: none; font-size: 11px; color: var(--text-dim); }
.cmd .place { max-width: 30%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.cmd .code { color: var(--danger); }
.cmd .when { min-width: 3ch; text-align: right; }
/* The time gives its place to the one action a row has, so nothing shifts. */
.cmd .wipe { display: none; }
.cmd.on .wipe { display: grid; }
.cmd.on .when { display: none; }
.history .empty { flex: 1; }
.keys {
  flex: none;
  display: flex;
  gap: 14px;
  padding: 2px 9px 0;
  font-size: 11px;
  color: var(--text-dim);
}
.keys kbd { font: inherit; color: var(--text-muted); margin-right: 3px; }
.term { height: 100%; }
:deep(.xterm) { height: 100%; }
:deep(.xterm-viewport) { background: transparent !important; }

/*
 * The cursor, trimmed to the text. xterm paints it the full height of the
 * cell, and the cell is 1.45 lines tall: the block stood well clear of the
 * letters either side of it. Clipped rather than resized, so the rows keep
 * their leading and the blink (which animates the background) is untouched.
 */
.term { --cursor-top: 3px; --cursor-bottom: 5px; }
.term :deep(.xterm-rows .xterm-cursor) { clip-path: inset(var(--cursor-top) 0 var(--cursor-bottom)); }
/* The unfocused outline would lose its top and bottom to the clip: redrawn inside it. */
.term :deep(.xterm-rows .xterm-cursor.xterm-cursor-outline) {
  outline: none;
  background:
    linear-gradient(var(--accent), var(--accent)) 0 var(--cursor-top) / 100% 1px,
    linear-gradient(var(--accent), var(--accent)) 0 calc(100% - var(--cursor-bottom)) / 100% 1px,
    linear-gradient(var(--accent), var(--accent)) 0 0 / 1px 100%,
    linear-gradient(var(--accent), var(--accent)) 100% 0 / 1px 100%;
  background-repeat: no-repeat;
}
</style>
