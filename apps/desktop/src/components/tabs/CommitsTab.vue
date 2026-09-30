<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import type { CommitDetail, CommitGraph, FileDiff, GraphCommit, GraphRef, Workspace } from '@cockpit/shared'
import { ArrowUpFromLine, ChevronRight, Cloud, Copy, GitBranch, GitGraph, Search, Sparkles, Tag, X } from '@lucide/vue'
import { client, guard, toast } from '../../core/store.js'
import { layout } from '../../core/graph.js'
import type { LaidRow } from '../../core/graph.js'

/**
 * §2 — "on ne cache pas git": the commits, and which of them were pushed.
 *
 * The scope bar only ever *counts* this — ↑3 on Push, ↓2 on Catch up — and a
 * count is the one thing you cannot read the work from. This draws it: the
 * branch as a line, the base and the upstream as the lines it is measured
 * against, and every commit on them.
 *
 * Two facts ride on the dots, because they are the two a count stood for:
 *
 * - **Not pushed** is a hollow dot. It is exactly `git rev-list --not
 *   --remotes`: nothing on any remote-tracking ref has it.
 * - **Pushed, and when** is the ↑ on the commit a push left at the tip of a
 *   remote branch. Git keeps that nowhere but in the reflog of the
 *   remote-tracking ref (`update by push`), so a push made from another
 *   machine shows as a moved `origin/…` label and no ↑ — which is true: it was
 *   not pushed from here.
 *
 * `this branch` is HEAD, its upstream and the base; `all` is every branch and
 * tag. The first is the question you ask most; the second is the graph.
 */

const props = defineProps<{ workspace: Workspace }>()

const PAGE = 300
const LANE = 14
const PAD = 17
const ROW = 30
const MID = ROW / 2
/** Past this, lanes are clipped rather than pushing the subjects off the row. */
const MAX_LANES = 12
/** A diff longer than this is cut, and says so — the Diff tab is for reading a whole one. */
const MAX_LINES = 2000

const scope = ref<'branch' | 'all'>('branch')
const limit = ref(PAGE)
const data = ref<CommitGraph | null>(null)
const failed = ref(false)
const q = ref('')
/** The row the keyboard is on. */
const cursor = ref<string | null>(null)
/** Which commit is open. One at a time — this is a list, not a tree. */
const opened = ref<string | null>(null)
const details = reactive(new Map<string, CommitDetail | 'loading' | 'failed'>())
/** `hash␟path` → the file's diff in that commit. */
const diffs = reactive(new Map<string, FileDiff | 'loading'>())
const openFiles = reactive(new Set<string>())

const list = ref<HTMLElement | null>(null)

const head = computed(() => props.workspace.git?.lastCommit?.hash ?? null)

let seq = 0
async function load() {
  const mine = ++seq
  const res = await guard(() =>
    client.call('git.graph', { workspaceId: props.workspace.id, scope: scope.value, limit: limit.value }),
  )
  if (mine !== seq) return
  failed.value = !res
  if (res) data.value = res
}

// Everything that moves a line on this graph moves one of these: a commit, a
// switch, a push (ahead), a fetch (behind). The service pushes all of them.
watch(
  () => {
    const g = props.workspace.git
    return [
      props.workspace.id, scope.value, limit.value,
      g?.lastCommit?.hash, g?.branch, g?.upstream, g?.ahead, g?.behind, g?.behindBase,
    ].join('|')
  },
  load,
  { immediate: true },
)

// A different repository, or a different reading of this one, is a new page.
watch(
  () => props.workspace.id + '|' + scope.value,
  () => {
    limit.value = PAGE
    opened.value = null
    cursor.value = null
    details.clear()
    diffs.clear()
    openFiles.clear()
  },
)

const commits = computed<GraphCommit[]>(() => data.value?.commits ?? [])
const laid = computed(() => layout(commits.value, head.value))
const lanes = computed(() => Math.min(Math.max(laid.value.width, 1), MAX_LANES))
const gutter = computed(() => PAD * 2 + (lanes.value - 1) * LANE)

const rows = computed(() =>
  commits.value.map((c, i) => ({ c, g: laid.value.rows[i]! })),
)

const index = computed(() => new Map(commits.value.map((c, i) => [c.hash, i])))

const unpushed = computed(() =>
  data.value?.hasRemote ? commits.value.filter((c) => !c.pushed).length : 0,
)

// ── filtering ─────────────────────────────────────────────────────────
// Dimmed rather than removed: the graph is the point, and a list with the
// commits in between taken out is a graph with its lines cut.

const needle = computed(() => q.value.trim().toLowerCase())
function matches(c: GraphCommit): boolean {
  const n = needle.value
  if (!n) return true
  return (
    c.subject.toLowerCase().includes(n) ||
    c.author.toLowerCase().includes(n) ||
    c.hash.startsWith(n) ||
    c.refs.some((r) => r.name.toLowerCase().includes(n))
  )
}
const matchCount = computed(() => (needle.value ? commits.value.filter(matches).length : 0))

// ── drawing ───────────────────────────────────────────────────────────

const x = (lane: number) => PAD + lane * LANE

/** A line from one lane to another over half a row, as one S-curve. */
function curve(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M${x1} ${y1}V${y2}`
  const ym = (y1 + y2) / 2
  return `M${x1} ${y1}C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`
}

function strokes(g: LaidRow) {
  const xl = x(g.lane)
  return [
    ...g.through.map((s) => ({ d: `M${x(s.lane)} 0V${ROW}`, color: s.color })),
    ...g.into.map((s) => ({ d: curve(x(s.lane), 0, xl, MID), color: s.color })),
    ...g.out.map((s) => ({ d: curve(xl, MID, x(s.lane), ROW), color: s.color })),
  ]
}

function isLocal(c: GraphCommit): boolean {
  return !!data.value?.hasRemote && !c.pushed
}

// ── words ─────────────────────────────────────────────────────────────

function ago(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 1) return 'now'
  if (m < 60) return m + 'm'
  const h = Math.floor(m / 60)
  if (h < 24) return h + 'h'
  const d = Math.floor(h / 24)
  if (d < 30) return d + 'd'
  const at = new Date(ts)
  return at.toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    ...(at.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  })
}

function when(ts: number): string {
  return new Date(ts).toLocaleString([], {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function nodeTip(c: GraphCommit): string {
  if (!data.value?.hasRemote) return 'This repository has no remote'
  return c.pushed ? 'Pushed' : 'Not pushed — on this machine only'
}

function pushTip(c: GraphCommit): string {
  return c.pushes.map((p) => 'Pushed to ' + p.ref + ' · ' + when(p.ts)).join('\n')
}

function refTip(r: GraphRef): string {
  if (r.kind === 'head') return 'HEAD, detached on this commit'
  if (r.kind === 'tag') return 'Tag ' + r.name
  if (r.kind === 'remote') return r.name + ' — where the remote was when it was last fetched or pushed'
  return r.current ? r.name + ' — the branch you are on' : 'Branch ' + r.name
}

/** Three labels, then a count: a commit ten branches point at is still one row. */
function shownRefs(c: GraphCommit): { shown: GraphRef[]; rest: GraphRef[] } {
  return { shown: c.refs.slice(0, 3), rest: c.refs.slice(3) }
}

function short(hash: string): string {
  return hash.slice(0, 7)
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? '' : p.slice(0, i + 1)
}
function nameOf(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1)
}

// ── acting ────────────────────────────────────────────────────────────

async function open(hash: string) {
  opened.value = hash
  cursor.value = hash
  if (details.has(hash) && details.get(hash) !== 'failed') return
  details.set(hash, 'loading')
  const d = await guard(() => client.call('git.show', { workspaceId: props.workspace.id, hash }))
  details.set(hash, d ?? 'failed')
}

function toggle(hash: string) {
  // Selecting the text of a line is not asking to open it.
  const sel = window.getSelection()
  if (sel && !sel.isCollapsed) return
  if (opened.value === hash) {
    opened.value = null
    cursor.value = hash
  } else {
    void open(hash)
  }
}

function fileKey(hash: string, path: string): string {
  return hash + '\u001f' + path
}

async function toggleFile(hash: string, path: string, oldPath: string | null) {
  const key = fileKey(hash, path)
  if (openFiles.has(key)) {
    openFiles.delete(key)
    return
  }
  openFiles.add(key)
  if (diffs.has(key)) return
  diffs.set(key, 'loading')
  const d = await guard(() =>
    client.call('git.showFile', { workspaceId: props.workspace.id, hash, path, oldPath }),
  )
  if (d) diffs.set(key, d)
  else {
    diffs.delete(key)
    openFiles.delete(key)
  }
}

function fileDiff(hash: string, path: string): FileDiff | 'loading' | undefined {
  return diffs.get(fileKey(hash, path))
}

async function jump(hash: string) {
  if (!index.value.has(hash)) {
    toast('info', short(hash) + ' is further back than this page — show older commits to reach it.')
    return
  }
  await open(hash)
  await reveal(hash)
}

async function reveal(hash: string) {
  await nextTick()
  list.value?.querySelector(`[data-hash="${hash}"]`)?.scrollIntoView({ block: 'nearest' })
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast('ok', 'Copied ' + short(text))
  } catch {
    toast('error', 'Could not copy to the clipboard.')
  }
}

function onKey(e: KeyboardEvent) {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const all = commits.value
  if (!all.length) return
  const at = cursor.value ? (index.value.get(cursor.value) ?? -1) : -1
  const move = (to: number) => {
    const c = all[Math.max(0, Math.min(all.length - 1, to))]!
    cursor.value = c.hash
    // Walking with the commit open keeps it open on the new one: reading down
    // a branch is the reason to use the keys at all.
    if (opened.value) void open(c.hash)
    void reveal(c.hash)
  }
  if (e.key === 'ArrowDown' || e.key === 'j') move(at + 1)
  else if (e.key === 'ArrowUp' || e.key === 'k') move(at <= 0 ? 0 : at - 1)
  else if ((e.key === 'Enter' || e.key === ' ') && cursor.value) toggle(cursor.value)
  else if (e.key === 'Escape' && opened.value) opened.value = null
  else return
  e.preventDefault()
}

function more() {
  limit.value += PAGE
}
</script>

<template>
  <div class="commits" :style="{ '--gutter': gutter + 'px' }">
    <div class="bar">
      <div class="seg">
        <button :class="{ on: scope === 'branch' }" title="This branch, its upstream and the base" @click="scope = 'branch'">
          this branch
        </button>
        <button :class="{ on: scope === 'all' }" title="Every branch and tag" @click="scope = 'all'">all branches</button>
      </div>
      <label class="find">
        <Search class="sm" />
        <input v-model="q" placeholder="Filter" spellcheck="false" />
        <span v-if="needle" class="hits num">{{ matchCount }}</span>
        <button v-if="q" class="wipe" title="Clear" @click="q = ''"><X /></button>
      </label>
      <span v-if="data && !data.hasRemote" class="sum" title="Nothing here has anywhere to be pushed to">no remote</span>
      <span v-else-if="unpushed" class="sum local num" :title="unpushed + ' commits exist on this machine only'">
        <span class="ring" />{{ unpushed }} not pushed
      </span>
    </div>

    <div
      v-if="rows.length"
      ref="list"
      class="rows"
      tabindex="0"
      @keydown="onKey"
    >
      <div v-for="{ c, g } in rows" :key="c.hash" class="entry" :data-hash="c.hash">
        <div
          class="r"
          :class="{ open: opened === c.hash, cur: cursor === c.hash, dim: !matches(c), head: c.hash === head }"
          role="button"
          :aria-expanded="opened === c.hash"
          @click="toggle(c.hash)"
        >
          <svg class="g" :width="gutter" :height="ROW" :viewBox="`0 0 ${gutter} ${ROW}`" aria-hidden="true">
            <path v-for="(s, i) in strokes(g)" :key="i" :d="s.d" class="ln" :class="'s' + s.color" />
            <circle v-if="c.hash === head" :cx="x(g.lane)" :cy="MID" r="7" class="halo" :class="'s' + g.color" />
            <circle
              :cx="x(g.lane)"
              :cy="MID"
              r="4"
              class="dot"
              :class="[isLocal(c) ? 'hollow' : 'f' + g.color, 's' + g.color]"
            >
              <title>{{ nodeTip(c) }}</title>
            </circle>
          </svg>

          <span class="subj">{{ c.subject }}</span>

          <span v-if="c.refs.length" class="refs">
            <span
              v-for="r in shownRefs(c).shown"
              :key="r.kind + r.name"
              class="ref"
              :class="[r.kind, { current: r.current }]"
              :title="refTip(r)"
            >
              <Cloud v-if="r.kind === 'remote'" />
              <Tag v-else-if="r.kind === 'tag'" />
              <GitBranch v-else />
              <span class="rn">{{ r.name }}</span>
            </span>
            <span
              v-if="shownRefs(c).rest.length"
              class="ref more"
              :title="shownRefs(c).rest.map((r) => r.name).join('\n')"
            >+{{ shownRefs(c).rest.length }}</span>
          </span>

          <span v-if="c.pushes.length" class="pushed" :title="pushTip(c)">
            <ArrowUpFromLine /><span class="pl">pushed</span> {{ ago(c.pushes[0]!.ts) }}
          </span>

          <span class="who" :class="{ agent: c.agent }" :title="c.agent ? c.author + ', with an agent as co-author' : c.email">
            <Sparkles v-if="c.agent" class="sm" />{{ c.author }}
          </span>
          <span class="when num" :title="when(c.ts)">{{ ago(c.ts) }}</span>
        </div>

        <div v-if="opened === c.hash" class="detail">
          <div class="gut" aria-hidden="true">
            <span
              v-for="s in g.below.filter((s) => s.lane < MAX_LANES)"
              :key="s.lane"
              class="bar-l"
              :class="'b' + s.color"
              :style="{ left: x(s.lane) - 0.75 + 'px' }"
            />
          </div>

          <div class="card">
            <template v-if="details.get(c.hash) && typeof details.get(c.hash) === 'object'">
              <template v-for="d in [details.get(c.hash) as CommitDetail]" :key="d.hash">
                <p class="subject selectable">{{ d.subject }}</p>
                <pre v-if="d.body" class="body selectable">{{ d.body }}</pre>

                <div class="meta">
                  <button class="hash mono" :title="'Copy ' + d.hash" @click="copy(d.hash)">
                    {{ short(d.hash) }}<Copy />
                  </button>
                  <span class="selectable">{{ d.author }}</span>
                  <span class="dimmed">{{ when(d.ts) }}</span>
                  <span v-if="d.committer !== d.author" class="dimmed">· committed by {{ d.committer }}</span>
                </div>

                <div v-if="d.parents.length" class="meta">
                  <span class="dimmed">{{ d.parents.length > 1 ? 'Merge of' : 'After' }}</span>
                  <button v-for="p in d.parents" :key="p" class="hash mono link" :title="'Go to ' + p" @click="jump(p)">
                    {{ short(p) }}
                  </button>
                </div>

                <div v-if="c.pushes.length" class="meta pushes">
                  <span v-for="p in c.pushes" :key="p.ref + p.ts" class="pushline">
                    <ArrowUpFromLine /><span>Pushed to <b>{{ p.ref }}</b> · {{ when(p.ts) }}</span>
                  </span>
                </div>
                <div v-else-if="isLocal(c)" class="meta">
                  <span class="pushline local"><span class="ring" /><span>Not pushed — this commit is on this machine only</span></span>
                </div>

                <div class="files">
                  <div class="fhead">
                    <span>{{ d.files.length }} {{ d.files.length === 1 ? 'file' : 'files' }}</span>
                    <span class="num add">+{{ d.files.reduce((n, f) => n + f.additions, 0) }}</span>
                    <span class="num del">−{{ d.files.reduce((n, f) => n + f.deletions, 0) }}</span>
                  </div>
                  <template v-for="f in d.files" :key="f.path">
                    <button
                      class="file"
                      :class="{ on: openFiles.has(fileKey(d.hash, f.path)) }"
                      :title="f.oldPath ? f.oldPath + ' → ' + f.path : f.path"
                      @click="toggleFile(d.hash, f.path, f.oldPath)"
                    >
                      <ChevronRight class="ch" />
                      <span class="st" :class="f.status">{{ f.status }}</span>
                      <span class="fp"><span class="fd">{{ dirOf(f.path) }}</span>{{ nameOf(f.path) }}</span>
                      <span v-if="f.binary" class="fb">binary</span>
                      <template v-else>
                        <span class="num add">+{{ f.additions }}</span>
                        <span class="num del">−{{ f.deletions }}</span>
                      </template>
                    </button>
                    <div v-if="openFiles.has(fileKey(d.hash, f.path))" class="hunks mono">
                      <template v-for="fd in [fileDiff(d.hash, f.path)]" :key="0">
                        <div v-if="!fd || fd === 'loading'" class="hnote">Reading…</div>
                        <div v-else-if="fd.binary" class="hnote">Binary file — no lines to show.</div>
                        <div v-else-if="!fd.lines.length" class="hnote">No textual change.</div>
                        <template v-else>
                          <div v-for="(l, i) in fd.lines.slice(0, MAX_LINES)" :key="i" class="line" :class="l.kind">
                            <span class="gn num">{{ l.kind === 'meta' ? '' : (l.oldLine ?? '') }}</span>
                            <span class="gn num">{{ l.kind === 'meta' ? '' : (l.newLine ?? '') }}</span>
                            <span class="sign">{{ l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ' }}</span>
                            <span class="txt">{{ l.text }}</span>
                          </div>
                          <div v-if="fd.lines.length > MAX_LINES" class="hnote">
                            {{ fd.lines.length - MAX_LINES }} more lines not shown.
                          </div>
                        </template>
                      </template>
                    </div>
                  </template>
                  <div v-if="!d.files.length" class="hnote">No file changed.</div>
                </div>
              </template>
            </template>
            <div v-else-if="details.get(c.hash) === 'failed'" class="hnote">Could not read this commit.</div>
            <div v-else class="hnote">Reading…</div>
          </div>
        </div>
      </div>

      <button v-if="data?.more" class="btn ghost older" @click="more">Show older commits</button>
    </div>

    <div v-else-if="data" class="empty">
      <GitGraph />
      <strong>No commits yet</strong>
      <span>The first commit on this repository will be drawn here, with every push after it.</span>
    </div>
    <div v-else-if="failed" class="empty">
      <GitGraph />
      <strong>Could not read the history</strong>
      <span>Git did not answer for this repository.</span>
      <button class="btn" @click="load">Try again</button>
    </div>
  </div>
</template>

<style scoped>
/* Lane inks. The accent is HEAD's own line and nothing else; the rest are
   only there to tell two lines apart, so they are the quietest hues that still
   do, and none of them is a semantic colour — green here would read as "ok". */
.commits {
  --lane-0: var(--accent);
  --lane-1: light-dark(#23879a, #5cc3d4);
  --lane-2: light-dark(#b0487b, #ee8cba);
  --lane-3: light-dark(#86772a, #d2bf61);
  --lane-4: light-dark(#51709f, #92b0e0);
  --lane-5: light-dark(#98603a, #dea27a);
  display: flex;
  flex-direction: column;
  height: 100%;
  container-type: inline-size;
}

.bar {
  flex: none;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 10px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--line);
}

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
.hits { font-size: 11px; color: var(--text-dim); }
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

.sum {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-xs);
  color: var(--text-dim);
  white-space: nowrap;
}
.sum.local { color: var(--text-muted); }
/* The hollow dot, as a legend: the same mark the graph uses, so the words
   beside it teach the drawing. */
.ring {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1.6px solid var(--accent);
}

.rows { flex: 1; overflow-y: auto; padding-bottom: 24px; outline: none; }

/* ── the row ───────────────────────────────────────────────────────── */
.r {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding-right: 12px;
  font-size: var(--fs-sm);
  cursor: default;
}
.r:hover { background: var(--hover); }
.r.open { background: var(--hover); }
.rows:focus-visible .r.cur { background: var(--selected); }
.r.dim > :not(.g) { opacity: 0.32; }

.g { flex: none; display: block; overflow: hidden; }
.ln { fill: none; stroke-width: 1.6; stroke-linecap: round; }
.dot { stroke-width: 1.6; }
.dot.hollow { fill: var(--surface-review); }
.halo { fill: none; stroke-width: 1.2; opacity: 0.4; }
.s0 { stroke: var(--lane-0); } .f0 { fill: var(--lane-0); }
.s1 { stroke: var(--lane-1); } .f1 { fill: var(--lane-1); }
.s2 { stroke: var(--lane-2); } .f2 { fill: var(--lane-2); }
.s3 { stroke: var(--lane-3); } .f3 { fill: var(--lane-3); }
.s4 { stroke: var(--lane-4); } .f4 { fill: var(--lane-4); }
.s5 { stroke: var(--lane-5); } .f5 { fill: var(--lane-5); }

.subj {
  flex: 1 1 auto;
  min-width: 60px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}
.r.head .subj { font-weight: 500; }

.refs { flex: 0 1 auto; display: inline-flex; gap: 4px; min-width: 0; overflow: hidden; }
.ref {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 19px;
  padding: 0 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
  min-width: 0;
  background: var(--hover);
  color: var(--text-muted);
}
.ref .lucide { flex: none; width: 11px; height: 11px; }
.rn { overflow: hidden; text-overflow: ellipsis; max-width: 150px; }
.ref.current { background: var(--accent-soft); color: var(--accent); }
.ref.head { background: var(--accent-soft); color: var(--accent); }
.ref.remote { background: none; box-shadow: inset 0 0 0 1px var(--line); color: var(--text-dim); }
.ref.more { color: var(--text-dim); }

.pushed {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-xs);
  color: var(--text-dim);
  white-space: nowrap;
}
.pushed .lucide { width: 12px; height: 12px; }

.who {
  flex: 0 0 auto;
  max-width: 130px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.who.agent { color: var(--agent); }
.when {
  flex: none;
  width: 44px;
  text-align: right;
  font-size: var(--fs-xs);
  color: var(--text-dim);
}

/* ── an opened commit ──────────────────────────────────────────────────
 * The lanes keep running down its left edge, so opening one never cuts the
 * graph in two. */
.detail { display: flex; align-items: stretch; }
.gut { position: relative; flex: none; width: var(--gutter); }
.bar-l { position: absolute; top: 0; bottom: 0; width: 1.6px; border-radius: 1px; }
.b0 { background: var(--lane-0); } .b1 { background: var(--lane-1); } .b2 { background: var(--lane-2); }
.b3 { background: var(--lane-3); } .b4 { background: var(--lane-4); } .b5 { background: var(--lane-5); }

.card {
  flex: 1;
  min-width: 0;
  margin: 4px 14px 12px 0;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line-soft);
  background: var(--bg-sunken);
  font-size: var(--fs-sm);
}
.subject { margin: 0 0 6px; font-weight: 600; color: var(--text); line-height: 1.45; }
.body {
  margin: 0 0 10px;
  font-family: inherit;
  font-size: var(--fs-sm);
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-muted);
}
.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  margin-top: 4px;
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.dimmed { color: var(--text-dim); }
.hash {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 6px;
  border-radius: 5px;
  background: var(--hover);
  color: var(--text-muted);
  font-size: 11.5px;
}
.hash:hover { background: var(--active); color: var(--text); }
.hash .lucide { width: 11px; height: 11px; opacity: 0.6; }
.hash.link { color: var(--accent); }
.pushes { flex-direction: column; align-items: flex-start; }
/* One sentence beside its glyph, wrapping as a sentence: the glyph stays on
   the first line rather than centring against a two-line date. */
.pushline { display: inline-flex; align-items: baseline; gap: 6px; color: var(--text-muted); }
.pushline > .lucide, .pushline > .ring { flex: none; align-self: flex-start; margin-top: 2px; }
.pushline b { font-weight: 600; color: var(--text); }
.pushline .lucide { width: 12px; height: 12px; }
.pushline.local { color: var(--text-muted); }

.files { margin-top: 10px; border-top: 1px solid var(--line-soft); padding-top: 8px; }
.fhead {
  display: flex;
  gap: 8px;
  margin-bottom: 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.file {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 26px;
  padding: 0 6px 0 2px;
  border-radius: 5px;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  text-align: left;
}
.file:hover { background: var(--hover); color: var(--text); }
.file .ch { flex: none; width: 12px; height: 12px; color: var(--text-dim); transition: transform var(--dur-2) var(--ease); }
.file.on .ch { transform: rotate(90deg); }
.st { flex: none; width: 12px; font-family: var(--mono); font-weight: 600; font-size: 11px; color: var(--text-dim); }
.st.A { color: var(--ok); }
.st.D { color: var(--danger); }
.st.R, .st.C { color: var(--info); }
.fp { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fd { color: var(--text-dim); }
.fb { font-size: 11px; color: var(--text-dim); }
.add { color: var(--diff-add-text); font-size: 11px; }
.del { color: var(--diff-del-text); font-size: 11px; }

.hunks {
  margin: 2px 0 8px;
  border: 1px solid var(--line-soft);
  border-radius: 6px;
  background: var(--surface-review);
  overflow-x: auto;
  font-size: 11.5px;
  line-height: 1.6;
}
.line { display: flex; min-width: max-content; }
.line.add { background: var(--diff-add-bg); }
.line.del { background: var(--diff-del-bg); }
.line.meta { color: var(--text-dim); background: var(--hover); }
.gn { flex: none; width: 38px; padding-right: 6px; text-align: right; color: var(--text-dim); opacity: 0.7; user-select: none; }
.sign { flex: none; width: 14px; text-align: center; color: var(--text-dim); user-select: none; }
.line.add .sign, .line.add .txt { color: var(--diff-add-text); }
.line.del .sign, .line.del .txt { color: var(--diff-del-text); }
.txt { white-space: pre; padding-right: 12px; color: var(--text-muted); }
.hnote { padding: 6px 8px; font-size: var(--fs-xs); color: var(--text-dim); }

.older { margin: 10px auto 0; display: flex; }

/* The author goes first when the column is narrow, then the word "pushed";
   the subject, the labels and the time are what the row is. */
@container (max-width: 520px) {
  .who { display: none; }
  .pl { display: none; }
  .rn { max-width: 90px; }
}
@container (max-width: 380px) {
  .refs .ref:not(.current):not(.head) { display: none; }
}
</style>
