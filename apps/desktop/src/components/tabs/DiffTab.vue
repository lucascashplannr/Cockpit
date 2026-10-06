<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CommitPreview, DiffFile, FileDiff, StashEntry, Workspace } from '@cockpit/shared'
import type { Component } from 'vue'
import {
  Archive, ArchiveRestore, Check, ChevronRight, CircleDashed, Code, Columns2, Eye, FileCode, Rows2, GitBranch, LoaderCircle,
  ChevronUp, FileText, GitCommitHorizontal, Save, ArrowLeft, PencilLine, Sparkles, Upload, X, SquareArrowOutUpRight, Trash2, TriangleAlert,
  Copy, FilePen, FolderOpen, GitGraph, Info, Undo2, User, UsersRound,
} from '@lucide/vue'
import Splitter from '../Splitter.vue'
import MarkdownPreview from '../MarkdownPreview.vue'
import FileChanges from '../FileChanges.vue'
import {
  LAYOUT_DEFAULTS, LAYOUT_LIMITS, commit, commitPreview, openCommits, discard, lastCommitMessage, discardTick, draftCommitMessage, guard, layout, resetPlaceWidth,
  resetCommitHeight, saveLayout, savePlaceWidth, selectWorkspace, setColumnWidth, setCommitHeight, stash, stashList, toast, client, state,
} from '../../core/store.js'

/**
 * §12 — the review surface. "La distinction humain / agent est le garde-fou
 * principal : elle rend visible, donc contrôlable, la part de code jamais
 * relue." Every file row is marked with its author; the distinction is carried
 * by the mark on the row rather than by a filter over the list.
 */

const props = defineProps<{ workspace: Workspace }>()

/* ── one column, or two ───────────────────────────────────────────────────
 *
 * The Diff is a list beside a viewer, and under about 620px there is no beside
 * left: 320 of it is the list, and the hunk that is the point of the screen
 * gets what remains. The frame used to stack them instead — viewer under list,
 * under the commit box — and that was worse than it sounds. A unified diff in
 * the bottom two fifths of a narrow column is a few clipped lines of code with
 * nowhere to go, sitting under the two things you were actually reading.
 *
 * So when the room is not there, the panel stops trying to show both at once:
 * the list is the screen, a file opens over it, and the back arrow returns.
 * The hunk then gets the full height and full width of the column, which is
 * the most this panel has to give it.
 *
 * Measured here rather than left to the container query that used to do it in
 * `ReviewTools`: the drill-down is behaviour, not styling, and `select` has to
 * know which one it is doing.
 */
const root = ref<HTMLElement | null>(null)
const narrow = ref(false)
/** Narrow only: the file is open over the list. */
const drilled = ref(false)

/**
 * The commit box's own height, watched so the handle has somewhere to start.
 *
 * Left alone the box is as tall as what is in it, and `layout.commit` is null
 * — so the first pixel of a drag has no number to work from unless one is
 * being kept. Measuring it also means the handle picks up where the box
 * actually is after a draft grew the message or a stash appeared, rather than
 * jumping to whatever it was worth the last time anyone dragged it.
 */
const bar = ref<HTMLElement | null>(null)
const measuredCommit = ref(LAYOUT_LIMITS.commit.min)

/**
 * The ceiling on the box is the panel, not the constant.
 *
 * 560 is the most anyone should want; it is not always available. A short
 * panel dragged to it would leave the file list at nothing, and a list of zero
 * files above a commit box is the panel forgetting what it is for — so the
 * handle stops with 140px of list still standing, and a window that shrinks
 * afterwards pulls the box back down with it rather than swallowing the list.
 */
const panelH = ref(0)
const commitMax = computed(() =>
  Math.max(LAYOUT_LIMITS.commit.min, Math.min(LAYOUT_LIMITS.commit.max, panelH.value - 140)),
)

/**
 * The file list's width, and its ceiling. Like the commit box, the limit is
 * the panel as much as the constant: the list stops where the viewer would
 * drop below 320px, and a panel that shrinks afterwards narrows the list
 * rather than squeezing the diff out.
 */
const panelW = ref(0)
const filesMax = computed(() =>
  Math.max(LAYOUT_LIMITS.files.min, Math.min(LAYOUT_LIMITS.files.max, panelW.value - 320)),
)
/** Where the line holds on the way past (see Splitter's `snap`): half, and the default. */
const filesSnaps = computed(() => [Math.round(panelW.value / 2), LAYOUT_DEFAULTS.files])
const filesW = computed(() => Math.min(layout.files, filesMax.value))

let ro: ResizeObserver | null = null
let barRo: ResizeObserver | null = null
onMounted(() => {
  ro = new ResizeObserver(([e]) => {
    if (!e) return
    narrow.value = e.contentRect.width < 620
    panelW.value = e.contentRect.width
    panelH.value = e.contentRect.height
    if (layout.commit && layout.commit > commitMax.value) setCommitHeight(commitMax.value)
  })
  if (root.value) ro.observe(root.value)
  barRo = new ResizeObserver(([e]) => {
    // The whole box, padding included — that is what the handle sits on.
    if (e) measuredCommit.value = (e.target as HTMLElement).offsetHeight
  })
  watch(
    bar,
    (el, old) => {
      if (old) barRo?.unobserve(old)
      if (el) barRo?.observe(el)
    },
    { immediate: true },
  )
})
onBeforeUnmount(() => {
  ro?.disconnect()
  barRo?.disconnect()
})

const files = ref<DiffFile[]>([])
const current = ref<FileDiff | null>(null)
const selected = ref<string | null>(null)

/* ── one text, or two ─────────────────────────────────────────────────────
 *
 * Unified reads a change as a story, top to bottom; split reads it as a
 * before and after. Which is better depends on the change, so it is the
 * reader's call, and it is remembered. Narrow, there is no room for two
 * columns of code, and the panel falls back to unified without forgetting
 * the choice.
 *
 * File is the third: neither a story nor a before and after, but the file as
 * it stands with the change marked on it (see `FileChanges`). A deleted file
 * has nothing to stand as, and falls back the same way.
 */
type DiffView = 'unified' | 'split' | 'file'
const VIEW_KEY = 'cockpit.diffView'
function readView(): DiffView {
  try {
    const v = localStorage.getItem(VIEW_KEY)
    return v === 'split' || v === 'file' ? v : 'unified'
  } catch {
    return 'unified'
  }
}
const view = ref<DiffView>(readView())
function setView(v: DiffView): void {
  if (v === view.value) return
  leaveEdit(() => {
    // A line asked for was asked for once; coming back later opens on the change.
    if (v !== 'file') startLine.value = null
    view.value = v
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      /* remembered for this session only */
    }
  })
}
const split = computed(() => view.value === 'split' && !narrow.value)
const whole = computed(() => view.value === 'file' && editable.value)

/* ── editing, in place ────────────────────────────────────────────────────
 *
 * The whole-file view is an editor that starts closed. Off until asked, and
 * not remembered: opening the app on a review should never mean a keystroke
 * lands in a file. Once on it stays on from file to file, because a pass that
 * fixes one typo usually finds a second.
 *
 * An edit that is not saved exists only on screen, so the three ways of
 * walking away from it — another file, another view, closing the editor — ask
 * first. Unlike a discard, nothing keeps it: the question says so.
 */
const editing = ref(false)
const fileView = ref<InstanceType<typeof FileChanges> | null>(null)
const unsaved = computed(() => !!fileView.value?.dirty)

function leaveEdit(then: () => void): void {
  if (!unsaved.value) return then()
  state.pendingConfirm = {
    title: 'Drop your edit?',
    body: ['What you typed in ' + baseName(selected.value ?? '') + ' is not saved, and nothing keeps a copy of it.'],
    verb: 'Drop the edit',
    cancel: 'Keep editing',
    done: 'Edit dropped',
    danger: true,
    run: async () => {
      then()
      return true
    },
  }
}

function toggleEditing(): void {
  if (!whole.value || !editing.value) editHere()
  else
    leaveEdit(() => {
      editing.value = false
      void fileView.value?.revert()
    })
}

async function afterSave() {
  await Promise.all([load(), refreshCommit()])
  await reloadCurrent()
}

/* ── a markdown file, read as it reads ────────────────────────────────────
 *
 * A doc is reviewed twice: once as source, for what exactly changed, and once
 * rendered, for whether it still reads. The second used to mean opening it
 * somewhere else. Code is the default because this is a diff first; Preview
 * is remembered like Unified/Split is.
 *
 * The preview is the whole file as it stands on disk, not the hunks — a
 * rendered fragment of a table or a list is not something you can read. What
 * changed is carried over as marks in the margin.
 */
type MdView = 'code' | 'preview'
const MD_KEY = 'cockpit.diffMarkdownView'
function readMdView(): MdView {
  try {
    return localStorage.getItem(MD_KEY) === 'preview' ? 'preview' : 'code'
  } catch {
    return 'code'
  }
}
const mdView = ref<MdView>(readMdView())
function setMdView(v: MdView): void {
  mdView.value = v
  try {
    localStorage.setItem(MD_KEY, v)
  } catch {
    /* remembered for this session only */
  }
}

/** A deleted file has nothing on disk to render. */
const isMarkdown = computed(() => {
  const path = selected.value
  if (!path || !/\.(md|markdown)$/i.test(path)) return false
  return files.value.find((f) => f.path === path)?.status !== 'D'
})
const previewing = computed(() => isMarkdown.value && mdView.value === 'preview')

const preview = ref<{ path: string; content: string; truncated: boolean } | null>(null)

/**
 * Read again whenever the diff is: `current` is replaced on every reload the
 * panel does (a discard, the watcher firing), and the preview has to follow it
 * or its marks would point at lines that moved.
 */
watch(
  [previewing, current],
  async () => {
    const path = selected.value
    if (!previewing.value || !path) return
    const r = await guard(() => client.call('fs.read', { workspaceId: props.workspace.id, rel: path }))
    if (selected.value !== path) return
    preview.value = r && !r.binary ? { path, content: r.content, truncated: r.truncated } : null
  },
  { immediate: true },
)

/**
 * The diff, in the new file's line numbers. Added lines are `changed`; a run
 * of deletions with nothing added in its place is a `cut` before the line that
 * follows it. A file that is new from top to bottom marks nothing — every
 * block in green says no more than the A in the list does.
 */
const marks = computed(() => {
  const lines = current.value?.lines ?? []
  const changed = new Set<number>()
  const cut = new Set<number>()
  if (!lines.some((l) => l.kind === 'context' || l.kind === 'del')) return { changed, cut }
  let last = 0
  let dropped = false
  for (const l of lines) {
    if (l.kind === 'del') dropped = true
    else if (l.kind === 'add') {
      changed.add(l.newLine!)
      last = l.newLine!
      dropped = false
    } else if (l.kind === 'context') {
      if (dropped) cut.add(l.newLine!)
      last = l.newLine!
      dropped = false
    } else if (dropped) {
      // A hunk that ends on a deletion: the cut sits before whatever came next.
      cut.add(last + 1)
      dropped = false
    }
  }
  if (dropped) cut.add(last + 1)
  return { changed, cut }
})

type Cell = { num: number | null; kind: 'context' | 'add' | 'del' | 'blank'; text: string }
type SplitRow = { meta: string; hunk: number } | { left: Cell; right: Cell }

/**
 * The same lines, paired. A run of deletions followed by a run of additions is
 * one edit, so they are laid side by side line for line, and whichever run is
 * shorter is padded with blank cells to keep the rows level.
 */
const splitRows = computed<SplitRow[]>(() => {
  const lines = current.value?.lines ?? []
  const rows: SplitRow[] = []
  const blank: Cell = { num: null, kind: 'blank', text: '' }
  let i = 0
  let hunk = -1
  const at = (k: number, kind: string) => lines[k]?.kind === kind
  while (i < lines.length) {
    const l = lines[i]!
    if (l.kind === 'meta') {
      rows.push({ meta: l.text, hunk: ++hunk })
      i++
    } else if (l.kind === 'context') {
      rows.push({
        left: { num: l.oldLine, kind: 'context', text: l.text },
        right: { num: l.newLine, kind: 'context', text: l.text },
      })
      i++
    } else {
      const dels: typeof lines = []
      const adds: typeof lines = []
      while (at(i, 'del')) dels.push(lines[i++]!)
      while (at(i, 'add')) adds.push(lines[i++]!)
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        const d = dels[k]
        const a = adds[k]
        rows.push({
          left: d ? { num: d.oldLine, kind: 'del', text: d.text } : blank,
          right: a ? { num: a.newLine, kind: 'add', text: a.text } : blank,
        })
      }
    }
  }
  return rows
})
const loading = ref(false)

/* ── §16 — discarding, and never for good ─────────────────────────────────
 *
 * Three reaches: a file, the files ticked in the list, one hunk of the file
 * on screen. All three go through the core's discard, which stashes what it
 * takes — so nothing here asks "are you sure". The entry shows up under Set
 * aside, and the toast offers Undo while the moment is still fresh.
 */

const picked = ref<string[]>([])
const discarding = ref(false)

function togglePick(path: string) {
  picked.value = picked.value.includes(path)
    ? picked.value.filter((p) => p !== path)
    : [...picked.value, path]
}

/**
 * The whole list in one tick. The box in the header is the same box the rows
 * carry, so ticking it means what ticking a row means — all of them, and
 * ticking it back means none.
 */
const allPicked = computed(() => files.value.length > 0 && picked.value.length === files.value.length)
const somePicked = computed(() => picked.value.length > 0 && !allPicked.value)

function toggleAll() {
  picked.value = allPicked.value ? [] : files.value.map((f) => f.path)
}

/** Which hunk each meta line opens, so its button knows what it discards. */
const hunkOf = computed(() => {
  let n = -1
  return (current.value?.lines ?? []).map((l) => (l.kind === 'meta' ? ++n : n))
})

function hunkLines(index: number) {
  const out: { kind: 'context' | 'add' | 'del'; text: string }[] = []
  let n = -1
  for (const l of current.value?.lines ?? []) {
    if (l.kind === 'meta') n++
    else if (n === index) out.push({ kind: l.kind, text: l.text })
    else if (n > index) break
  }
  return out
}

async function discardFiles(paths: string[]) {
  if (!paths.length || discarding.value) return
  discarding.value = true
  const ok = await discard({ workspaceId: props.workspace.id, paths })
  discarding.value = false
  if (ok) {
    picked.value = picked.value.filter((p) => !paths.includes(p))
    await afterDiscard()
  }
}

async function discardHunk(index: number) {
  const path = selected.value
  if (!path || discarding.value) return
  discarding.value = true
  const ok = await discard({
    workspaceId: props.workspace.id,
    hunk: { path, index, lines: hunkLines(index) },
  })
  discarding.value = false
  // Refused because the file moved under the reader: showing it again is the
  // answer to "look at it again", so that happens either way.
  if (ok) await afterDiscard()
  else await reloadCurrent()
}

async function afterDiscard() {
  await Promise.all([load(), refreshStashes(), refreshCommit()])
  await reloadCurrent()
}

/** The file on screen, read again in place — no drilling, no reselecting. */
async function reloadCurrent() {
  const path = selected.value
  if (!path || !files.value.some((f) => f.path === path)) return
  const r = await guard(() => client.call('diff.file', { workspaceId: props.workspace.id, path }))
  if (selected.value === path) current.value = r
}

watch(discardTick, () => void afterDiscard())

const totals = computed(() => ({
  add: files.value.reduce((n, f) => n + f.additions, 0),
  del: files.value.reduce((n, f) => n + f.deletions, 0),
}))

async function load() {
  loading.value = true
  const r = await guard(() => client.call('diff.files', { workspaceId: props.workspace.id }))
  files.value = r ?? []
  loading.value = false
  picked.value = picked.value.filter((p) => files.value.some((f) => f.path === p))
  const still = files.value.some((f) => f.path === selected.value)
  if (!files.value.length) {
    selected.value = null
    current.value = null
    drilled.value = false
  } else if (!still) {
    // Wide, the viewer is always showing something, so a first file is picked
    // for it. Narrow, opening one is a move the user makes: landing inside a
    // file they never asked for, with the list they came for now behind a back
    // arrow, is the panel deciding for them.
    if (narrow.value) drilled.value = false
    else void open(files.value[0]!.path)
  }
}

function select(path: string) {
  // The file being edited, clicked again: it is already open, and reading it
  // again would be the one thing that loses the edit.
  if (path === selected.value && unsaved.value) return
  leaveEdit(() => void open(path))
}

async function open(path: string) {
  selected.value = path
  startLine.value = null
  current.value = null
  if (narrow.value) drilled.value = true
  const r = await guard(() => client.call('diff.file', { workspaceId: props.workspace.id, path }))
  current.value = r
}

/* ── §16 — "revue humaine du diff avant tout commit" ──────────────────────
 *
 * The review was here and the commit was not, so the only way out of a dirty
 * worktree was a terminal — and `topic.close` refuses over uncommitted
 * changes, which meant Cockpit blocked you on a state it could not clear.
 * It belongs next to the diff it is a review of, not in a menu.
 */

/**
 * One line — the summary every log, blame and PR title shows. There is no
 * field for a body: a second box made committing feel like filling in a form.
 *
 * `body` still exists for one case. Amending a commit that already has a body
 * keeps it as it was, rather than an unseen field quietly deleting it.
 */
const subject = ref('')
const body = ref('')
const message = computed(() => {
  const head = subject.value.trim()
  const rest = body.value.trim()
  return head && rest ? head + '\n\n' + rest : head
})

/**
 * What goes in. It was a "stage everything" checkbox, which answered one of
 * three questions: everything, what git already has staged, or the files you
 * ticked in the list above — the last one had no way to be said at all.
 */
type Include = 'all' | 'staged' | 'picked'
const include = ref<Include>('all')
const stageAll = computed(() => include.value === 'all')
const committing = ref(false)

// Ticking a file is choosing what to commit; clearing the ticks gives it back.
watch(
  () => picked.value.length > 0,
  (any) => {
    if (any) include.value = 'picked'
    else if (include.value === 'picked') include.value = 'all'
  },
)
const rows = ref<CommitPreview[]>([])

/**
 * The commit is this repository's, and only this repository's.
 *
 * It used to be the topic's: one message, one commit per repository, in one
 * click. That was right about the gesture and wrong about the words. Two
 * repositories in a topic are two different diffs — a field added to the API
 * and a form that reads it — and one message committed to both describes at
 * most one of them. The commit that got "test commit" in the backend because
 * that is what the frontend needed to say is a commit nobody can read later,
 * and §12's whole argument is that history has to stay readable.
 *
 * So the box commits where you are standing, and the topic's other
 * repositories are listed under it as somewhere to go rather than something to
 * sweep up. What *is* still topic-wide is Push, which carries no words and so
 * cannot lie in any of them.
 */
async function refreshCommit() {
  rows.value = await commitPreview(null, props.workspace.id, stageAll.value)
}

/**
 * The rest of the topic, and what each of them is holding.
 *
 * Not an action — a door. Closing out a topic still means every repository
 * gets committed, and the thing the topic-wide commit was really buying was
 * not having to hunt for the next one.
 */
const elsewhere = computed(() => {
  const t = props.workspace.topicId
  if (!t) return []
  return state.workspaces
    .filter((w) => w.topicId === t && w.id !== props.workspace.id && w.repo && w.kind !== 'group')
    .map((w) => ({
      id: w.id,
      name: w.name,
      dirty: (w.git?.staged ?? 0) + (w.git?.unstaged ?? 0) + (w.git?.untracked ?? 0),
      conflicted: w.git?.conflicted ?? 0,
    }))
    .filter((w) => w.dirty > 0 || w.conflicted > 0)
})

const willCommit = computed(() => rows.value.filter((r) => r.willCommit))
const counts = computed(() => ({
  all: rows.value.reduce((n, r) => n + r.staged + r.unstaged, 0),
  staged: rows.value.reduce((n, r) => n + r.staged, 0),
}))
const fileCount = computed(() =>
  include.value === 'picked'
    ? picked.value.length
    : willCommit.value.reduce((n, r) => n + (stageAll.value ? r.staged + r.unstaged : r.staged), 0),
)
/**
 * §3.7 — a conflict is a state to work in, and this one had no way out.
 *
 * The bar refused over `conflicted > 0` and said only "resolve the conflict
 * first", which is fine advice while a rebase is in progress: the conflict
 * panel is right there with continue, abort and skip. `git stash pop` reaches
 * the same state with *nothing* in progress — markers in the tree, unmerged
 * entries in the index, no MERGE_HEAD to continue and no rebase to abort — and
 * from there the sentence was a wall. Cockpit blocked the commit, offered no
 * verb, and the only way on was a terminal.
 *
 * So the block names the files and carries the one verb that clears them.
 */
const blocked = computed(() =>
  rows.value
    .filter((r) => r.conflicted > 0)
    .map((r) => {
      const g = state.workspaces.find((w) => w.id === r.workspaceId)?.git ?? null
      return {
        workspaceId: r.workspaceId,
        repo: r.repo,
        count: r.conflicted,
        // Mid-rebase, the conflict panel owns this and says so; the paths are
        // listed there with the verbs that end the operation.
        operation: g?.operation?.kind ?? null,
        paths: g?.conflictedPaths ?? [],
      }
    }),
)

const marking = ref('')

/**
 * `git add` on the paths, which is what "resolved" means to git.
 *
 * It stages the file as it stands — the same escape hatch the palette offers,
 * and the same one `continue` deliberately is not: a file that is *meant* to
 * contain conflict markers has to be markable too. Which is why the button
 * says to look at the file first, and why the file is one click above it.
 */
async function markResolved(b: { workspaceId: string; paths: string[] }) {
  if (!b.paths.length || marking.value) return
  marking.value = b.workspaceId
  const res = await guard(() =>
    client.call('git.stage', { workspaceId: b.workspaceId, paths: b.paths }),
  )
  marking.value = ''
  if (res && !res.ok) {
    toast('error', res.detail)
    return
  }
  await Promise.all([refreshCommit(), load()])
}
const canCommit = computed(
  () =>
    !!subject.value.trim() &&
    // An amend with nothing new is a message rewrite, and still an amend.
    (fileCount.value > 0 || amending.value) &&
    !blocked.value.length &&
    !committing.value,
)

/** Where it lands, said before the button rather than after it. */
const git = computed(() => props.workspace.git)

/**
 * Amending is a mode, not a click: the box fills with the last commit's
 * message so what gets rewritten is visible and editable first, and leaving
 * the mode puts back whatever was being written before.
 */
const amending = ref(false)
let beforeAmend: { subject: string; body: string } | null = null

async function startAmend() {
  menuOpen.value = false
  if (amending.value || !git.value?.lastCommit) return
  const full = (await lastCommitMessage(props.workspace.id)) ?? git.value.lastCommit.subject
  beforeAmend = { subject: subject.value, body: body.value }
  const [head, ...rest] = full.split('\n')
  subject.value = head ?? ''
  body.value = rest.join('\n').trim()
  amending.value = true
  void nextTick(() => subjectEl.value?.focus())
}

function stopAmend() {
  amending.value = false
  if (beforeAmend) {
    subject.value = beforeAmend.subject
    body.value = beforeAmend.body
  }
  beforeAmend = null
}

async function doCommit(opts: { push?: boolean } = {}) {
  menuOpen.value = false
  if (!canCommit.value) return
  committing.value = true
  const paths =
    include.value === 'picked'
      ? picked.value.flatMap((p) => {
          const f = files.value.find((x) => x.path === p)
          return f?.oldPath ? [p, f.oldPath] : [p]
        })
      : undefined
  const ok = await commit(null, props.workspace.id, message.value, stageAll.value, {
    ...(paths ? { paths } : {}),
    ...(amending.value ? { amend: true } : {}),
    ...(opts.push ? { push: true } : {}),
  })
  committing.value = false
  // The plan dialog takes it from here; clearing on success keeps the field
  // from re-offering a message that has already been used.
  if (ok) {
    subject.value = ''
    body.value = ''
    amending.value = false
    beforeAmend = null
  }
}

/** The rest of what the button can do, opened upward — the box sits at the foot of the panel. */
const menuOpen = ref(false)
const menuRoot = ref<HTMLElement | null>(null)
function onDocDown(e: MouseEvent) {
  if (menuRoot.value && !menuRoot.value.contains(e.target as Node)) menuOpen.value = false
  if (detailRoot.value && !detailRoot.value.contains(e.target as Node)) detailOpen.value = false
}
function onDocKey(e: KeyboardEvent) {
  if (e.key === 'Escape') detailOpen.value = false
}
onMounted(() => {
  document.addEventListener('mousedown', onDocDown)
  document.addEventListener('keydown', onDocKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocDown)
  document.removeEventListener('keydown', onDocKey)
})

const commitLabel = computed(() => {
  if (committing.value) return 'Planning…'
  const n = fileCount.value
  const files = n + ' file' + (n === 1 ? '' : 's')
  if (amending.value) return n ? 'Amend with ' + files : 'Amend message'
  return 'Commit ' + files
})


/* ── §16 — the draft ──────────────────────────────────────────────────────
 *
 * An engine reads the diff and proposes a first sentence into this box. It
 * does not commit, and it cannot: what goes in is a string, and the button
 * next to it is still the one a person presses.
 *
 * §12's mark — a line saying the sentence was drafted rather than typed —
 * used to sit under the box. The journal still records it, which is the part
 * that has to survive; a banner over the commit button did not earn its room.
 */

const subjectEl = ref<HTMLInputElement | null>(null)

const drafting = ref(false)

async function draftMessage() {
  if (drafting.value || !fileCount.value) return
  drafting.value = true
  // Whatever is already in the box is a hint, not a thing to protect: someone
  // who types "fixes the TVA rounding" and presses Draft is asking for that
  // note turned into a message, not preserved beside one.
  const text = await draftCommitMessage(
    null,
    props.workspace.id,
    include.value !== 'staged',
    subject.value.trim() || undefined,
  )
  drafting.value = false
  if (!text) return
  // The summary line only — there is nowhere for a body to go.
  subject.value = text.trim().split('\n')[0] ?? ''
  body.value = ''
}

/* ── §16 — set aside, and see that you did ───────────────────────────────
 *
 * The list is the point. `stash.ts` in the core says why at length: a stash
 * the app never mentions is how a day's work goes missing. So the entries sit
 * above the box the work would otherwise have been committed from, in the
 * repository each was taken from, until someone puts one back or drops it.
 */

const stashes = ref<StashEntry[]>([])
const stashing = ref(false)

/** Anything at all in the tree — staged or not. `willCommit` is a narrower
 *  question and answers no when nothing is staged but plenty is changed. */
const dirty = computed(() => rows.value.some((r) => r.staged + r.unstaged > 0))

/**
 * Setting work aside stayed topic-wide where committing did not, and the
 * difference is what the words are for: a stash label names a moment you are
 * stepping away from, not a change you are describing, and the entries are
 * listed per repository whatever they were labelled. The button says how far
 * it reaches, and the confirmation names every repository before it runs.
 */
const stashScope = computed(() => props.workspace.topicId)

async function refreshStashes() {
  stashes.value = await stashList(stashScope.value, props.workspace.id)
}

async function setAside() {
  if (!dirty.value || stashing.value) return
  stashing.value = true
  // The message field doubles as the stash's label when it has something in
  // it: naming what you set aside is the difference between a list you can
  // read in a week and four rows of "WIP on topic/x".
  await stash({
    topicId: stashScope.value,
    workspaceId: props.workspace.id,
    action: 'push',
    ...(subject.value.trim() ? { message: subject.value.trim() } : {}),
    includeUntracked: true,
  })
  stashing.value = false
}

/**
 * What to call an entry in the list.
 *
 * Git's own subject for an unnamed stash is "WIP on <branch>: <sha> <subject
 * of HEAD>" — the commit it was sitting on, which in a list reads as the name
 * of the thing you set aside. "0d705e9 Merge test adding logos" is not what is
 * in there; the files are. So a named entry shows its name and an unnamed one
 * shows what it holds.
 */
function nameOf(e: StashEntry): string {
  // Belt as well as braces — `stashList` fills these in for an older core, and
  // a name is not worth a render error whatever arrives here.
  const paths = e.paths ?? []
  if (e.titled ?? true) return e.subject
  if (!paths.length) return 'Uncommitted work'
  const more = (e.files ?? paths.length) - paths.length
  return paths.join(', ') + (more > 0 ? ' +' + more : '')
}

function actOnStash(entry: StashEntry, action: 'pop' | 'drop') {
  void stash({
    topicId: null,
    workspaceId: entry.workspaceId,
    action,
    ref: entry.ref,
    label: nameOf(entry),
  })
}

/** Short enough for a 320px column; exact enough to tell yesterday from an
 *  hour ago, which is the only question anyone asks of a stash. */
function since(ts: number): string {
  if (!ts) return ''
  const m = Math.max(0, Math.round((Date.now() - ts) / 60_000))
  if (m < 1) return 'just now'
  if (m < 60) return m + 'm ago'
  const h = Math.round(m / 60)
  if (h < 24) return h + 'h ago'
  return Math.round(h / 24) + 'd ago'
}

/**
 * A plan closing — applied or cancelled — is the moment the tree may have
 * moved under this panel. Watching that rather than the workspace catches
 * `stash drop`, which changes no file and would otherwise leave a row on
 * screen for an entry that no longer exists. Both dialogs count: the stash
 * verbs ask through the confirmation, everything else through the plan.
 */
watch(
  () => !!state.pendingPlan || !!state.pendingConfirm,
  (now, before) => {
    if (before && !now) {
      void refreshStashes()
      void refreshCommit()
      void load()
    }
  },
)

watch([() => props.workspace.id, stageAll], () => void refreshCommit(), { immediate: true })
watch(() => props.workspace.id, () => void refreshStashes(), { immediate: true })
// The counts come from the core's own probe, so they follow every push.
watch(() => props.workspace.git, () => void refreshCommit())

/* ── about the file ───────────────────────────────────────────────────────
 *
 * The header shows the name and nothing else; this is where the rest went.
 * What the diff already knows is shown at once, and what only the disk knows
 * — its length, its size, when it last moved — is read when the panel opens,
 * not every time a file is selected.
 */
const STATUS: Record<DiffFile['status'], string> = {
  A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Unmerged',
}
const WHO: Record<DiffFile['attribution'], string> = {
  human: 'Human', agent: 'Agent', mixed: 'Human and agent', unknown: 'Unknown',
}
const selectedFile = computed(() => files.value.find((f) => f.path === selected.value) ?? null)
const hunkCount = computed(() => (current.value?.lines ?? []).filter((l) => l.kind === 'meta').length)

const detailRoot = ref<HTMLElement | null>(null)
const detailOpen = ref(false)
const detail = ref<{ path: string; lines: number | null; bytes: number; mtime: number } | null>(null)

async function toggleDetail() {
  detailOpen.value = !detailOpen.value
  const path = selected.value
  if (!detailOpen.value || !path || selectedFile.value?.status === 'D') return
  const r = await guard(() => client.call('fs.read', { workspaceId: props.workspace.id, rel: path }))
  if (!r || selected.value !== path) return
  // A truncated or binary read cannot be counted, so it is not.
  const whole = !r.binary && !r.truncated
  detail.value = {
    path,
    lines: whole ? r.content.split('\n').length - (r.content.endsWith('\n') ? 1 : 0) : null,
    bytes: whole ? new TextEncoder().encode(r.content).length : 0,
    mtime: r.mtimeMs,
  }
}

watch(selected, () => {
  detailOpen.value = false
  detail.value = null
})

function bytes(n: number): string {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

async function copyPath() {
  if (!selected.value) return
  await navigator.clipboard.writeText(selected.value)
  detailOpen.value = false
  toast('info', 'Path copied')
}

async function revealFolder() {
  const path = selected.value
  if (!path) return
  detailOpen.value = false
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : undefined
  await guard(() =>
    client.call('workspace.openIn', {
      workspaceId: props.workspace.id,
      target: 'finder',
      ...(dir ? { path: dir } : {}),
    }),
  )
}

async function openInIde() {
  if (!selected.value) return
  await guard(() =>
    client.call('workspace.openIn', {
      workspaceId: props.workspace.id,
      target: 'ide',
      path: selected.value!,
    }),
  )
}

/**
 * §12 — a review that finds a typo should not need an IDE to fix it, nor
 * another tool. Edit means one thing wherever it is pressed: this file, here,
 * open for typing. From a hunk view that is a move to the whole file first —
 * at the line asked for, when a line number was what was clicked.
 */
const editable = computed(() => !!selected.value && selectedFile.value?.status !== 'D')
const startLine = ref<number | null>(null)
function editHere(line: number | null = null) {
  if (!editable.value) return
  startLine.value = line
  editing.value = true
  setView('file')
}

/**
 * Hunk views draw two columns of numbers, before and after. A file that is
 * new from top to bottom has no before, and a deleted one no after: the empty
 * column was only pushing the code away from the edge, so it is not drawn.
 */
const sides = computed(() => {
  const lines = (current.value?.lines ?? []).filter((l) => l.kind !== 'meta')
  const old = lines.some((l) => l.oldLine != null)
  const now = lines.some((l) => l.newLine != null)
  return { old: old || !now, new: now || !old }
})

/**
 * A removed line has no number in the new file, so it lands on the line that
 * took its place — the next one that does, or the last one before it at the
 * end of the file.
 */
function nearestNew(nums: (number | null)[], i: number): number | null {
  for (let k = i; k < nums.length; k++) if (nums[k] != null) return nums[k]!
  for (let k = i - 1; k >= 0; k--) if (nums[k] != null) return nums[k]!
  return null
}
const unifiedNew = computed(() => (current.value?.lines ?? []).map((l) => (l.kind === 'meta' ? null : l.newLine)))
const splitNew = computed(() => splitRows.value.map((r) => ('meta' in r ? null : r.right.num)))

watch(() => props.workspace.id, load, { immediate: true })
// The core re-pushes workspaces whenever the watcher fires; refresh with it.
watch(
  () => props.workspace.git && props.workspace.git.staged + props.workspace.git.unstaged + props.workspace.git.untracked,
  () => void load(),
)

/**
 * The name is what you look for in the list; the folder only tells two
 * files of the same name apart. So the name leads, and the folder follows,
 * fainter, and is the part that gives way when the column is narrow.
 */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}
function dirName(path: string): string {
  const i = path.lastIndexOf('/')
  // Wrapped in left-to-right marks: the element is `direction: rtl` so its
  // ellipsis lands on the left, and the marks keep the slashes where they are.
  return i > 0 ? '\u200e' + path.slice(0, i) + '\u200e' : ''
}

/** One icon per author, and the icon is the same everywhere it appears. */
const mark: Record<string, Component> = {
  human: User,
  agent: Sparkles,
  mixed: UsersRound,
  unknown: CircleDashed,
}
</script>

<template>
  <div
    ref="root"
    class="diff"
    :class="{ narrow, drilled: narrow && drilled }"
    :style="{ '--files-w': filesW + 'px' }"
  >
    <!-- The line between the list and the diff, draggable like the shell's
         own columns. Narrow, there is one column and nothing to divide. -->
    <Splitter
      v-if="!narrow"
      :style="{ left: filesW - 3 + 'px' }"
      :size="filesW"
      :min="LAYOUT_LIMITS.files.min"
      :max="filesMax"
      grows="right"
      :snap="filesSnaps"
      label="Width of the file list"
      @resize="setColumnWidth('files', $event)"
      @done="savePlaceWidth('files')"
      @reset="resetPlaceWidth('files')"
    />
    <aside class="files">
      <!-- One bar, not two: the header counts the files until some are ticked,
           and then it counts the ticked ones and carries what you can do to
           them. The box on its right is the rows' own box, one row up. -->
      <div class="ftop" :class="{ picking: picked.length > 0 }">
        <span class="section-label">
          {{ picked.length ? picked.length + ' selected' : 'files (' + files.length + ')' }}
        </span>
        <span class="grow" />
        <template v-if="picked.length">
          <!-- The same undo mark the rows carry, so the verb on the selection
               and the verb on one file are plainly the same verb. -->
          <button
            class="icon-btn danger"
            :disabled="discarding"
            :title="'Discard ' + picked.length + ' selected ' + (picked.length === 1 ? 'file' : 'files') + ' — kept under Set aside, with Undo'"
            @click="discardFiles(picked)"
          >
            <Undo2 class="sm" />
          </button>
          <button class="btn ghost tiny" @click="picked = []">Clear</button>
        </template>
        <span v-else class="tot num">
          <span class="add">+{{ totals.add }}</span>
          <span class="del">−{{ totals.del }}</span>
        </span>
        <input
          v-if="picked.length"
          type="checkbox"
          class="all"
          :checked="allPicked"
          :indeterminate="somePicked"
          :title="allPicked ? 'Clear the selection' : 'Select every file'"
          @change="toggleAll"
        />
      </div>

      <div class="scroll">
        <div
          v-for="f in files"
          :key="f.path"
          class="fline"
          :class="{ picking: picked.length > 0, ticked: picked.includes(f.path) }"
        >
        <button
          class="frow"
          :class="{ on: f.path === selected }"
          @click="$event.metaKey ? togglePick(f.path) : select(f.path)"
        >
          <span class="attr" :class="f.attribution" :title="'written by: ' + f.attribution">
            <component :is="mark[f.attribution]" class="sm" />
          </span>
          <span class="st" :class="f.status">{{ f.status }}</span>
          <span class="fp" :title="f.oldPath ? f.oldPath + ' → ' + f.path : f.path">
            <span class="fname">{{ baseName(f.path) }}</span>
            <span v-if="dirName(f.path)" class="fdir">{{ dirName(f.path) }}</span>
          </span>
          <span class="counts num">
            <span v-if="f.additions" class="add">+{{ f.additions }}</span>
            <span v-if="f.deletions" class="del">−{{ f.deletions }}</span>
          </span>
          <!-- Narrow, the row goes somewhere rather than merely being picked. -->
          <ChevronRight v-if="narrow" class="go" />
        </button>
          <span class="facts">
            <button
              class="icon-btn"
              :disabled="discarding"
              :title="'Discard changes to ' + f.path + ' — kept under Set aside, with Undo'"
              @click="discardFiles([f.path])"
            >
              <Undo2 class="sm" />
            </button>
            <input
              type="checkbox"
              :checked="picked.includes(f.path)"
              :title="'Select ' + f.path + ' (⌘-click the row does the same)'"
              @change="togglePick(f.path)"
            />
          </span>
        </div>

        <div v-if="!files.length && !loading" class="empty">
          <FileCode />
          <strong>Clean</strong>
          <span>Nothing uncommitted here.</span>
        </div>
      </div>

      <!-- The boundary between the list and the box, made draggable like the
           columns are: how much of the panel each deserves depends on the work
           in front of you, not on a number we picked. -->
      <Splitter
        :size="measuredCommit"
        :min="LAYOUT_LIMITS.commit.min"
        :max="commitMax"
        grows="up"
        label="Height of the commit box"
        @resize="setCommitHeight"
        @done="saveLayout"
        @reset="resetCommitHeight"
      />

      <!-- §16 — the commit lives against the review, and commits every
           repository of the topic at once because that is the unit the work
           was done in. -->
      <!-- A ceiling, not a height: a box dragged taller than what is in it used
           to keep the difference as an empty band under the button. -->
      <div ref="bar" class="commitbar" :style="layout.commit ? { maxHeight: layout.commit + 'px' } : undefined">
        <!-- §16 — work that is parked, where the work it was taken from would
             be. A stash nothing mentions is the failure mode this feature is
             built around; see `stash.ts` in the core. It stays on screen
             through a conflict: a pop that half-applied is exactly when you
             need to see that the entry is still there. -->
        <div v-if="stashes.length" class="cstash">
          <span class="section-label">set aside ({{ stashes.length }})</span>
          <div v-for="e in stashes" :key="e.workspaceId + e.ref" class="srow">
            <Archive class="sm" />
            <span class="sbody">
              <span class="ssub" :class="{ untitled: !e.titled }">{{ nameOf(e) }}</span>
              <span class="smeta">
                {{ e.repo }}<template v-if="e.branch"> · {{ e.branch }}</template>
                · {{ e.files }} file{{ e.files === 1 ? '' : 's' }}
                <template v-if="since(e.ts)"> · {{ since(e.ts) }}</template>
              </span>
            </span>
            <button
              class="icon-btn"
              title="Put it back — replays this onto the working tree"
              @click="actOnStash(e, 'pop')"
            >
              <ArchiveRestore class="sm" />
            </button>
            <button
              class="icon-btn drop"
              title="Throw it away — there is no undo for this"
              @click="actOnStash(e, 'drop')"
            >
              <Trash2 class="sm" />
            </button>
          </div>
        </div>

        <div v-if="blocked.length" class="cblock">
          <div v-for="b in blocked" :key="b.workspaceId" class="brepo">
            <div class="bhead">
              <TriangleAlert class="sm" />
              <span class="bname">
                {{ b.repo }}: {{ b.count }} unmerged file{{ b.count === 1 ? '' : 's' }}
              </span>
              <span class="grow" />
              <button
                v-if="!b.operation && b.paths.length"
                class="btn ghost tiny"
                :disabled="!!marking"
                title="Runs git add on these paths — look at the file first, it is staged as it stands"
                @click="markResolved(b)"
              >
                <Check />
                {{ marking === b.workspaceId ? 'Marking…' : 'Mark resolved' }}
              </button>
            </div>
            <button
              v-for="p in b.paths"
              :key="p"
              class="bfile mono"
              :title="'Open ' + p"
              @click="select(p)"
            >
              {{ p }}
            </button>
            <p class="bnote">
              <template v-if="b.operation">
                A {{ b.operation }} is in progress — finish or abort it in the conflict panel.
              </template>
              <template v-else-if="b.paths.length">
                Nothing is mid-operation here — no rebase to continue, no merge to abort.
                This is what a stash coming back over a change leaves behind: fix the
                markers, then mark it resolved.
              </template>
              <template v-else>
                <!-- A service older than this window sends the count and not the
                     paths. Saying so beats a button that cannot name what it
                     would stage. -->
                The running service did not say which files — restart Cockpit, or open
                {{ b.repo }} and resolve them there.
              </template>
            </p>
          </div>
        </div>

        <template v-else>
          <!-- The topic's other repositories: named, counted, and one click
               away — but committed on their own terms, with their own message,
               once you are standing in them. -->
          <div v-if="elsewhere.length" class="cscope">
            <span class="section-label">also in this topic</span>
            <button
              v-for="e in elsewhere"
              :key="e.id"
              class="crow"
              :title="'Go to ' + e.name + ' to commit it'"
              @click="selectWorkspace(e.id)"
            >
              <GitBranch class="sm" />
              <span class="cname">{{ e.name }}</span>
              <span v-if="e.conflicted" class="num bad">{{ e.conflicted }} unmerged</span>
              <span v-else class="num">{{ e.dirty }}</span>
              <ChevronRight class="go" />
            </button>
            <p class="cnote">Each commits with its own message. Push covers the topic.</p>
          </div>

          <div class="cbox" :class="{ amending }">
            <!-- Where it lands comes first: the branch is the one thing in
                 here that is hard to take back once it is wrong. -->
            <div class="chead">
              <template v-if="amending">
                <PencilLine class="sm" />
                <span class="clead">Amending</span>
                <span class="cwhere" :title="git?.lastCommit?.subject">{{ git?.lastCommit?.hash.slice(0, 7) }}</span>
                <span class="grow" />
                <button class="btn ghost tiny" title="Back to a new commit" @click="stopAmend">
                  <X />Cancel
                </button>
              </template>
              <template v-else>
                <GitCommitHorizontal class="sm" />
                <span class="clead">Commit to</span>
                <span v-if="git?.branch" class="cwhere">{{ git.branch }}</span>
                <span v-else class="cwhere warn">detached HEAD</span>
                <span v-if="git?.ahead" class="cahead num" :title="git.ahead + ' commit(s) not pushed yet'">
                  ↑{{ git.ahead }}
                </span>
              </template>
            </div>

            <!-- The app's own field, not one drawn for this box: a commit
                 message is text you type like any other. Draft sits at its
                 end, because what it writes lands here. -->
            <div class="cfield">
              <input
                ref="subjectEl"
                v-model="subject"
                class="input cmsg selectable"
                :placeholder="fileCount || amending ? 'Commit message' : 'Nothing to commit'"
                :disabled="!fileCount && !amending"
                @keydown.enter.prevent="$event.metaKey && doCommit()"
              />
              <button
                v-if="!amending"
                class="icon-btn cdraft"
                :class="{ on: drafting }"
                :disabled="!fileCount || drafting"
                :aria-label="drafting ? 'Drafting…' : 'Draft a message'"
                :title="
                  drafting
                    ? 'Drafting…'
                    : subject.trim()
                      ? 'Draft a message from this diff — what you wrote is used as a hint'
                      : 'Draft a message from this diff'
                "
                @click="draftMessage"
              >
                <LoaderCircle v-if="drafting" class="spin" />
                <Sparkles v-else />
              </button>
            </div>

            <div class="cinclude">
              <div class="seg" role="group" aria-label="What goes into the commit">
                <button
                  :class="{ on: include === 'all' }"
                  :title="'Every change, untracked files included'"
                  @click="include = 'all'"
                >
                  All <span class="segn num">{{ counts.all }}</span>
                </button>
                <button
                  :class="{ on: include === 'staged' }"
                  :disabled="!counts.staged"
                  title="Only what git already has staged"
                  @click="include = 'staged'"
                >
                  Staged <span class="segn num">{{ counts.staged }}</span>
                </button>
                <button
                  :class="{ on: include === 'picked' }"
                  :disabled="!picked.length"
                  title="The files ticked in the list above"
                  @click="include = 'picked'"
                >
                  Selected <span class="segn num">{{ picked.length }}</span>
                </button>
              </div>
            </div>

            <div ref="menuRoot" class="csplit">
              <button
                class="btn primary cmain"
                :disabled="!canCommit"
                :title="'⌘⏎'"
                @click="doCommit()"
              >
                <component :is="amending ? PencilLine : GitCommitHorizontal" />
                {{ commitLabel }}
              </button>
              <button
                class="btn primary cmore"
                :class="{ open: menuOpen, dim: !canCommit && !menuOpen }"
                :disabled="committing"
                title="More ways to commit"
                @click="menuOpen = !menuOpen"
              >
                <ChevronUp />
              </button>
              <div v-if="menuOpen" class="menu cmenu">
                <button :disabled="!canCommit" @click="doCommit({ push: true })">
                  <Upload /> {{ amending ? 'Amend & push' : 'Commit & push' }}
                </button>
                <div class="rule" />
                <button v-if="!amending" :disabled="!git?.lastCommit" @click="startAmend">
                  <PencilLine /> Amend last commit
                </button>
                <button v-else @click="stopAmend(); menuOpen = false">
                  <GitCommitHorizontal /> New commit instead
                </button>
                <!-- Not committing is a real answer, and it was the one the
                     window had no button for: the tree had to be clean to close
                     a topic or switch a branch, and the only way there was a
                     commit you did not mean or a terminal. -->
                <template v-if="dirty && !amending">
                  <div class="rule" />
                  <button
                    :disabled="stashing"
                    :title="
                      subject.trim()
                        ? 'Stash everything, labelled with the summary above — listed here until you put it back'
                        : 'Stash everything — listed here until you put it back'
                    "
                    @click="menuOpen = false; setAside()"
                  >
                    <Archive />
                    {{ elsewhere.length ? 'Set aside all ' + (elsewhere.length + 1) + ' repos' : 'Set aside' }}
                  </button>
                </template>
              </div>
            </div>
          </div>

          <!-- The last commit, as context: what this one follows, and what
               Amend would rewrite. And the way into every commit before it:
               the history is behind the commit box, so it opens from the
               commit the box would follow, already open on it. -->
          <div v-if="git?.lastCommit && !amending" class="cafter">
            <!-- No tooltip: this sits on the window's bottom edge, where a
                 native one is drawn half off the screen. -->
            <button
              class="clast"
              :aria-label="'Last commit: ' + git.lastCommit.subject + ' — see every commit'"
              @click="openCommits(git.lastCommit.hash)"
            >
              <GitGraph class="clasticon" />
              <span class="clastsub">{{ git.lastCommit.subject }}</span>
              <span class="clastago">{{ since(git.lastCommit.ts) }}</span>
              <ChevronRight class="clastgo" />
            </button>
          </div>
        </template>
      </div>
    </aside>

    <div class="view">
      <div v-if="selected" class="vhead">
        <button v-if="narrow" class="icon-btn back" title="Back to the files" @click="drilled = false">
          <ArrowLeft class="sm" />
        </button>
        <!-- The name alone: the folders are in the list beside it, and the
             rest of what there is to know about the file is one click away. -->
        <div ref="detailRoot" class="vname">
          <span class="mono vpath" :title="selected">{{ baseName(selected) }}</span>
          <span v-if="unsaved" class="vdirty" title="Unsaved changes" aria-label="Unsaved changes" />
          <button
            class="icon-btn vinfo"
            :class="{ on: detailOpen }"
            title="About this file"
            aria-label="About this file"
            :aria-expanded="detailOpen"
            @click="toggleDetail"
          >
            <Info />
          </button>
          <div v-if="detailOpen" class="menu vdetail" role="dialog" aria-label="About this file">
            <div class="dpath mono selectable">{{ selected }}</div>
            <div v-if="selectedFile?.oldPath" class="dfrom mono selectable">from {{ selectedFile.oldPath }}</div>
            <dl class="dfacts">
              <template v-if="selectedFile">
                <dt>Status</dt>
                <dd>{{ STATUS[selectedFile.status] }}</dd>
                <dt>Written by</dt>
                <dd class="dwho" :class="selectedFile.attribution">
                  <component :is="mark[selectedFile.attribution]" />{{ WHO[selectedFile.attribution] }}
                </dd>
                <dt>Changes</dt>
                <dd class="num">
                  <span class="add">+{{ selectedFile.additions }}</span>
                  <span class="del">−{{ selectedFile.deletions }}</span>
                  <template v-if="hunkCount"> · {{ hunkCount }} {{ hunkCount === 1 ? 'hunk' : 'hunks' }}</template>
                </dd>
              </template>
              <template v-if="detail">
                <template v-if="detail.lines !== null">
                  <dt>Lines</dt>
                  <dd class="num">{{ detail.lines }}</dd>
                  <dt>Size</dt>
                  <dd class="num">{{ bytes(detail.bytes) }}</dd>
                </template>
                <dt>Modified</dt>
                <dd>{{ since(detail.mtime) }}</dd>
              </template>
            </dl>
            <div class="rule" />
            <button @click="copyPath"><Copy />Copy path</button>
            <button @click="revealFolder"><FolderOpen />Open folder</button>
          </div>
        </div>
        <span class="grow" />
        <div class="vtools">
        <!-- Each carries its icon and its word; when the column cannot spare
             the room, the words go and the path keeps it. The title and the
             aria-label still say what the icon means. -->
        <!-- One Edit, meaning one thing: this file, here. From a hunk view
             it opens the whole file to type in. -->
        <button
          v-if="editable && !previewing"
          class="btn ghost vbtn"
          :class="{ on: whole && editing }"
          :disabled="whole && fileView?.truncated"
          :title="whole && editing ? 'Stop editing' : 'Edit this file'"
          :aria-label="whole && editing ? 'Stop editing' : 'Edit this file'"
          :aria-pressed="whole && editing"
          @click="toggleEditing"
        >
          <FilePen /><span class="vlabel">Edit</span>
        </button>
        <button
          v-if="whole && !previewing && editing"
          class="icon-btn vsave"
          :class="{ due: unsaved }"
          :disabled="!unsaved"
          title="Save (⌘S)"
          aria-label="Save"
          @click="fileView?.save()"
        >
          <Save />
        </button>
        <button class="btn ghost vbtn" title="Open in IDE" aria-label="Open in IDE" @click="openInIde">
          <SquareArrowOutUpRight /><span class="vlabel">Open in IDE</span>
        </button>
        <div v-if="isMarkdown" class="seg" role="group" aria-label="Markdown view">
          <button :class="{ on: mdView === 'code' }" title="Code" aria-label="Code" @click="setMdView('code')">
            <Code /><span class="vlabel">Code</span>
          </button>
          <button :class="{ on: mdView === 'preview' }" title="Preview" aria-label="Preview" @click="setMdView('preview')">
            <Eye /><span class="vlabel">Preview</span>
          </button>
        </div>
        <!-- Narrow, there is no room for Split and it is not offered; a
             deleted file has no whole to show. With neither, there is no
             choice to make and no switch. -->
        <div
          v-if="!previewing && current && current.lines.length && (!narrow || editable)"
          class="seg"
          role="group"
          aria-label="Diff view"
        >
          <button :class="{ on: !whole && !split }" title="Unified" aria-label="Unified" @click="setView('unified')">
            <Rows2 /><span class="vlabel">Unified</span>
          </button>
          <button v-if="!narrow" :class="{ on: split && !whole }" title="Split" aria-label="Split" @click="setView('split')">
            <Columns2 /><span class="vlabel">Split</span>
          </button>
          <button
            v-if="editable"
            :class="{ on: whole }"
            title="Whole file, with the changes marked"
            aria-label="Whole file"
            @click="setView('file')"
          >
            <FileText /><span class="vlabel">File</span>
          </button>
        </div>
        </div>
      </div>

      <div v-if="previewing" class="preview">
        <template v-if="preview && preview.path === selected">
          <p v-if="preview.truncated" class="ptrunc">Only the start of this file is shown — it is too large to read in full here.</p>
          <MarkdownPreview :source="preview.content" :changed="marks.changed" :cut="marks.cut" />
        </template>
      </div>

      <FileChanges
        v-else-if="whole && current && current.lines.length"
        ref="fileView"
        :workspace="workspace"
        :path="selected!"
        :lines="current.lines"
        :editing="editing"
        :start-line="startLine"
        @saved="afterSave"
      />

      <div class="hunks mono split" v-else-if="split && current && current.lines.length">
        <template v-for="(r, i) in splitRows" :key="i">
          <div v-if="'meta' in r" class="line meta">
            <span class="txt">{{ r.meta }}</span>
            <button
              class="hdisc"
              :disabled="discarding"
              title="Discard this change — kept under Set aside, with Undo"
              @click="discardHunk(r.hunk)"
            >
              <Undo2 />Discard
            </button>
          </div>
          <div v-else class="sxs">
            <div class="line" :class="r.left.kind">
              <span
                class="gutter num"
                :class="{ jump: editable }"
                :title="editable ? 'Edit from here' : undefined"
                @click="editable && editHere(nearestNew(splitNew, i))"
              >{{ r.left.num ?? '' }}</span>
              <span class="sign">{{ r.left.kind === 'del' ? '−' : ' ' }}</span>
              <span class="txt">{{ r.left.text }}</span>
            </div>
            <div class="line" :class="r.right.kind">
              <span
                class="gutter num"
                :class="{ jump: editable }"
                :title="editable ? 'Edit from here' : undefined"
                @click="editable && editHere(nearestNew(splitNew, i))"
              >{{ r.right.num ?? '' }}</span>
              <span class="sign">{{ r.right.kind === 'add' ? '+' : ' ' }}</span>
              <span class="txt">{{ r.right.text }}</span>
            </div>
          </div>
        </template>
      </div>

      <div class="hunks mono" v-else-if="current && current.lines.length">
        <div v-for="(l, i) in current.lines" :key="i" class="line" :class="l.kind">
          <template v-if="l.kind === 'meta'">
            <span v-if="sides.old" class="gutter num" />
            <span v-if="sides.new" class="gutter num" />
          </template>
          <template v-else>
            <span
              v-if="sides.old"
              class="gutter num"
              :class="{ jump: editable }"
              :title="editable ? 'Edit from here' : undefined"
              @click="editable && editHere(nearestNew(unifiedNew, i))"
            >{{ l.oldLine ?? '' }}</span>
            <span
              v-if="sides.new"
              class="gutter num"
              :class="{ jump: editable }"
              :title="editable ? 'Edit from here' : undefined"
              @click="editable && editHere(nearestNew(unifiedNew, i))"
            >{{ l.newLine ?? '' }}</span>
          </template>
          <span class="sign">{{ l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ' }}</span>
          <span class="txt">{{ l.text }}</span>
          <button
            v-if="l.kind === 'meta'"
            class="hdisc"
            :disabled="discarding"
            title="Discard this change — kept under Set aside, with Undo"
            @click="discardHunk(hunkOf[i]!)"
          >
            <Undo2 />Discard
          </button>
        </div>
      </div>

      <div v-else-if="current && current.binary" class="empty"><strong>Binary file</strong></div>
      <div v-else-if="selected" class="empty"><span>No textual change to show.</span></div>
      <div v-else class="empty"><span>Select a file.</span></div>
    </div>
  </div>
</template>

<style scoped>
/* §16 — the commit bar. Pinned to the foot of the file list: it acts on what
   is listed above it, and a commit button that scrolls away is one nobody
   trusts they have seen the whole of. */
/* Pinned, and it means it this time. In the narrow review column the whole
   diff is laid out as 40%/60% rows, so a commit block merely sitting last in
   the file list ended up halfway down a squeezed scroll region — present, but
   never where the hand goes. Sticky to the foot of its own column keeps it
   where §16 needs it: against the review it is the review of. */
.commitbar {
  position: sticky;
  bottom: 0;
  z-index: 2;
  flex: none;
  /* Only when it has been dragged to a height of its own: a box shorter than
     its contents scrolls rather than clipping the button off the end of it. */
  overflow-y: auto;
  padding: 12px 12px 12px;
  border-top: 1px solid var(--line);
  background: var(--surface-dock);
}

/* What the count is made of. */
.cscope { margin: 0 0 9px; }
.crow {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  height: 24px;
  padding: 0 7px;
  margin-left: -7px;
  border-radius: var(--radius-sm);
  text-align: left;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  transition: background var(--dur-1) var(--ease-soft), color var(--dur-1) var(--ease-soft);
}
.crow:hover { background: var(--hover); color: var(--text); }
.crow .go { width: 12px; height: 12px; flex: none; color: var(--text-dim); }
.crow .num.bad { color: var(--danger); }
.crow .lucide { width: 12px; height: 12px; color: var(--text-dim); }
.cname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.crow .num { color: var(--text-dim); font-size: 11px; }

.cnote {
  margin: 5px 0 0;
  font-size: 10px;
  color: var(--text-dim);
  line-height: 1.45;
}
/* §16 — parked work, listed above the box it would have been committed from. */
.cstash { margin: 0 0 10px; }
.srow {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 0;
}
.srow > .lucide { width: 13px; height: 13px; flex: none; color: var(--text-dim); }
.sbody { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.ssub {
  font-size: var(--fs-xs);
  color: var(--text);
  direction: ltr;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Paths standing in for a name are still paths, and read as such. */
.ssub.untitled { font-family: var(--mono); font-size: 11px; color: var(--text-muted); }
.smeta {
  font-size: 10px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.srow .icon-btn { width: 24px; height: 24px; }
.srow .icon-btn .lucide { width: 13px; height: 13px; }
.srow .icon-btn.drop:hover { color: var(--danger); }



/* ── the commit box ─────────────────────────────────────────────────────
   Where it lands, what it says, what goes in, the verb — in reading order.
   The panel around it is sunken, so the field is what reads as the thing to
   fill in. */
/* Two groups, not one block: what you write (where it lands, the message),
   then what you do (what goes in, the verb). The room is between the groups,
   not spread evenly through them. */
.cbox {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cinclude { margin-top: 8px; }
.chead {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 24px;
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.chead > .lucide { width: 13px; height: 13px; flex: none; color: var(--text-dim); }
.chead .grow { flex: 1; }
.chead .btn { margin-right: -6px; }
/* One line, always: the lead keeps its words, the branch gives way. */
.clead { flex: none; white-space: nowrap; }
.cahead { flex: none; }
.cwhere {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--hover);
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text);
}
.cwhere.warn { color: var(--warn); }
.cahead { font-size: 11px; color: var(--text-dim); }
.cbox.amending .chead,
.cbox.amending .chead > .lucide { color: var(--warn); }

.cmsg:disabled { opacity: 0.6; }
.cfield { position: relative; }
.cfield .cmsg { padding-right: 38px; }
.cdraft {
  position: absolute;
  top: 50%;
  right: 5px;
  transform: translateY(-50%);
}
.cdraft .lucide { width: 14px; height: 14px; }

/* What goes in: three answers, the width of the box, each counted. */
/* The shared `.seg` well is drawn for a raised surface; on this sunken panel
   its background and border both vanished, so it gets its own edge here. */
.cinclude .seg {
  display: flex;
  width: 100%;
  background: var(--active);
  border-color: var(--line);
}
.cinclude .seg > button { flex: 1; justify-content: center; }
.cinclude .seg > button:disabled { opacity: 0.4; cursor: default; }
.segn { font-size: 10px; color: var(--text-dim); }
.seg > button.on .segn { color: var(--accent); }

/* The verb, with the rest of its verbs one chevron away. One button in two
   halves: the group carries the shadow and the halves carry none, so the seam
   is a hairline and not two shadows meeting, and neither half moves on its
   own when pressed. The height is every other button's. */
.csplit {
  position: relative;
  display: flex;
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-sm);
}
.csplit > .btn { box-shadow: none; }
.csplit > .btn:active:not(:disabled) { transform: none; }
.cmain { flex: 1; border-top-right-radius: 0; border-bottom-right-radius: 0; }
.cmore {
  flex: none;
  width: 32px;
  padding: 0;
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}
/* The seam is the half's own left border, so it runs edge to edge (an inset
   shadow stops a pixel short, inside the border) and survives the hover that
   clears a primary's border. */
.csplit > .cmore,
.csplit > .cmore:hover:not(:disabled) {
  border-left-color: color-mix(in srgb, var(--accent-text) 25%, transparent);
}
/* Still clickable with nothing to commit — Amend lives behind it — but drawn
   at the main half's weight, so the two read as one button. */
.cmore.dim { opacity: 0.4; }
.cmore.dim:hover:not(:disabled) { opacity: 0.75; }
.cmore .lucide { transition: transform var(--dur-1) var(--ease-soft); }
.cmore.open .lucide { transform: rotate(180deg); }
.cmenu { bottom: calc(100% + 6px); right: 0; }

.cafter {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
/* A line of context that is also a way in, drawn as a row of the box it is
   in: the same edges and corners as the button above it, at rest and on
   hover alike. It used to borrow six pixels either side so its text lined up
   with the box while resting, and its hover then stood out past everything
   else in it; and at 11px in the dimmest grey it was the faintest thing on
   the panel, which is the opposite of what a way in should be. */
.clast {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 8px 0 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line-soft);
  font-size: var(--fs-xs);
  color: var(--text-muted);
  text-align: left;
  transition:
    background var(--dur-1) var(--ease-soft),
    border-color var(--dur-1) var(--ease-soft),
    color var(--dur-1) var(--ease-soft);
}
.clast:hover { background: var(--hover); border-color: var(--line); color: var(--text); }
.clasticon { flex: none; width: 13px; height: 13px; color: var(--text-dim); }
.clastsub { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.clastago { flex: none; margin-left: auto; color: var(--text-dim); }
.clastgo { flex: none; width: 13px; height: 13px; color: var(--text-dim); transition: color var(--dur-1) var(--ease-soft); }
.clast:hover .clastgo { color: var(--text-muted); }

.tiny { height: 24px; padding: 0 8px; font-size: var(--fs-xs); }
.tiny .lucide { width: 12px; height: 12px; }

.cblock { display: flex; flex-direction: column; gap: 10px; }
.brepo { display: flex; flex-direction: column; gap: 3px; }
.bhead {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: var(--fs-xs);
  color: var(--danger);
}
.bhead .lucide { flex: none; }
.bhead .grow { flex: 1; }
.bname { font-weight: 550; }
.bhead .tiny { color: var(--text-muted); }
.bfile {
  display: block;
  width: 100%;
  padding: 3px 7px;
  border-radius: var(--radius-sm);
  text-align: left;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  unicode-bidi: plaintext;
}
.bfile:hover { background: var(--hover); color: var(--text); }
.bnote {
  margin: 2px 0 0;
  font-size: 10px;
  line-height: 1.45;
  color: var(--text-dim);
}

.diff {
  position: relative;
  display: grid;
  grid-template-columns: var(--files-w, 300px) minmax(0, 1fr);
  height: 100%;
}
/* One column at a time: the list, or the file opened over it. Both are laid
   into the same cell so the switch costs no reflow of the other. */
.diff.narrow { grid-template-columns: minmax(0, 1fr); }
.diff.narrow > * { grid-area: 1 / 1; }
.diff.narrow .view { display: none; }
.diff.narrow.drilled .files { display: none; }
.diff.narrow.drilled .view { display: flex; }
.diff.narrow .files { border-right: none; }

.files {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--line);
  min-height: 0;
  background: var(--surface-review);
}
.ftop {
  display: flex;
  align-items: center;
  /* The verbs sit close together; the box that stands for the whole list is
     given a little air so it does not read as a third verb. */
  gap: 3px;
  /* The right padding lines the header's box up with the rows': the list
     inside .scroll is inset 6px, and the row's box sits 9px in from that. */
  padding: 12px 15px 8px;
  transition: color var(--dur-1) var(--ease-soft);
}
.ftop .btn { height: 22px; padding: 0 7px; font-size: var(--fs-xs); }
/* Discard is the mark alone: at this size the word crowded Clear, and the
   mark is the one the rows already use. */
.ftop .icon-btn { width: 22px; height: 22px; }
.ftop .icon-btn.danger { color: var(--danger); }
.ftop .icon-btn.danger:hover:not(:disabled) { color: var(--danger); background: var(--danger-soft); }
.ftop.picking { color: var(--text); }
.ftop.picking .section-label { color: var(--text); }
/* The box that ticks the whole list. It only exists once a file is ticked —
   until then there is no selection to widen, and an empty header carries no
   box at all. */
.ftop .all { flex: none; width: 14px; height: 14px; margin-left: 7px; }
.tot { display: flex; gap: 8px; font-size: var(--fs-xs); font-weight: 550; }
.add { color: var(--ok); }
.del { color: var(--danger); }

.scroll { flex: 1; overflow-y: auto; padding: 0 6px 6px; }

.frow {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  height: 30px;
  padding: 0 9px;
  border-radius: var(--radius-sm);
  text-align: left;
  font-size: var(--fs-sm);
  color: var(--text-muted);
  transition: background var(--dur-1) var(--ease-soft), color var(--dur-1) var(--ease-soft);
}
.frow:hover { background: var(--hover); }
.frow .go { width: 13px; height: 13px; flex: none; color: var(--text-dim); }
.frow.on { background: var(--selected); color: var(--text); }

.attr { flex: none; display: flex; align-items: center; color: var(--text-dim); }
.attr .lucide { width: 13px; height: 13px; }
/* Monochrome: the glyph already says who — person, sparkles, both, unknown. */

.st {
  flex: none;
  width: 12px;
  font-size: 10px;
  font-weight: 700;
  color: var(--text-dim);
}
.st.A { color: var(--ok); }
.st.D { color: var(--danger); }
.st.M { color: var(--warn); }
.st.U { color: var(--danger); }

.fp {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  overflow: hidden;
  white-space: nowrap;
}
.fname {
  flex: none;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: var(--fs-sm);
}
.fdir {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  /* Truncate from the left, so the folder nearest the file survives. */
  direction: rtl;
  text-align: left;
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.counts { display: flex; gap: 5px; font-size: 10px; flex: none; }

/* The row's own verbs sit over its counts and take their place on hover —
   the counts are for scanning, the verbs for the row under the pointer. */
.fline { position: relative; }
.facts {
  position: absolute;
  top: 0;
  right: 9px;
  height: 30px;
  display: none;
  align-items: center;
  gap: 6px;
}
.facts .icon-btn { width: 22px; height: 22px; }
.facts input { width: 14px; height: 14px; flex: none; }
.fline:hover .facts,
.fline.picking .facts { display: flex; }
/* Narrow, the row ends in a chevron because it goes somewhere. The verbs take
   that end of the row, so the chevron steps aside rather than sitting under
   the discard button. */
.fline:hover .frow .go,
.fline.picking .frow .go { display: none; }
/* The verbs take the counts' place, and the row gives them room: hiding the
   counts alone left a long path running underneath the buttons. */
.fline:hover .counts,
.fline.picking .counts { display: none; }
.fline:hover .frow,
.fline.picking .frow { padding-right: 58px; }
.fline.picking:not(:hover) .facts .icon-btn { display: none; }
.fline.ticked .frow { color: var(--text); }


.view {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  container: viewer / inline-size;
}
.vhead {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 14px;
  border-bottom: 1px solid var(--line);
}
.vpath {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.grow { flex: 1; }
.vhead .btn { height: 26px; padding: 0 9px; font-size: var(--fs-xs); }
.vhead .back { width: 26px; height: 26px; margin-left: -4px; }
/* Editing is a state the header is in, not a thing it did. */
.vhead .vbtn.on,
.vhead .vbtn.on:hover:not(:disabled) { background: var(--accent-soft); color: var(--accent); }
.vdirty {
  flex: none;
  width: 7px;
  height: 7px;
  margin: 0 3px 0 5px;
  border-radius: 50%;
  background: var(--warn);
}
.vsave { width: 26px; height: 26px; }
.vsave .lucide { width: 14px; height: 14px; }
/* Only worth pressing when there is something to write; then it says so. */
.vsave.due { color: var(--accent); }

.hunks {
  flex: 1;
  overflow: auto;
  padding: 6px 0 24px;
  font-size: var(--fs-sm);
  line-height: 1.5;
}
.line { display: flex; white-space: pre; }
.line.add { background: var(--diff-add-bg); }
.line.del { background: var(--diff-del-bg); }
.line.meta {
  align-items: center;
  color: var(--text-dim);
  background: var(--bg-sunken);
  font-size: var(--fs-xs);
  padding: 3px 0;
  margin: 6px 0 2px;
}

.vhead .seg { flex: none; }
/* The three controls read as one set, so they sit closer to each other than
   to anything else in the header. */
.vtools { flex: none; display: flex; align-items: center; gap: 4px; }

.vname { position: relative; min-width: 0; display: flex; align-items: center; gap: 2px; }
.vinfo { width: 24px; height: 24px; }
.vinfo .lucide { width: 13px; height: 13px; }
.vinfo.on { background: var(--active); color: var(--text); }
.vdetail {
  top: calc(100% + 6px);
  left: -6px;
  width: 300px;
  max-width: calc(100cqw - 16px);
  padding: 10px 5px 5px;
}
.dpath, .dfrom {
  padding: 0 9px;
  font-size: var(--fs-xs);
  color: var(--text);
  overflow-wrap: anywhere;
}
.dfrom { margin-top: 3px; color: var(--text-dim); }
.dfacts {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 5px 14px;
  margin: 10px 0 4px;
  padding: 0 9px;
  font-size: var(--fs-xs);
}
.dfacts dt { color: var(--text-dim); }
.dfacts dd { margin: 0; color: var(--text-muted); display: flex; align-items: center; gap: 6px; }
.dwho .lucide { width: 12px; height: 12px; }
.vhead .seg > button { height: 20px; padding: 0 8px; }
.vhead .seg .lucide { width: 12px; height: 12px; flex: none; }
.vhead .btn .lucide { flex: none; }

/* The header is icons, and the words come back only when the viewer is wide
   enough that they cost nothing — a full-width window, not merely a roomy one.
   The shapes are learnt after a day; the words were only ever for the first. */
@container viewer (max-width: 1100px) {
  .vlabel { display: none; }
  /* Square, and as tall as the switches beside it. */
  .vhead .vbtn { flex: none; width: 28px; height: 28px; padding: 0; }
  /* Two bare icons already carry their own inset; the set's gap on top of it
     pushed them apart. */
  .vhead .vbtn + .vbtn { margin-left: -4px; }
  .vhead .seg > button { padding: 0 6px; }
}

.preview { flex: 1; min-height: 0; overflow: auto; }
.ptrunc {
  max-width: 780px;
  margin: 14px auto 0;
  padding: 0 32px;
  font-size: var(--fs-xs);
  color: var(--warn);
}

/* The numbers are for finding your place, not for reading: small, faint,
   right-aligned against the code, and never tinted by the change. */
.gutter {
  flex: none;
  width: 40px;
  padding-right: 8px;
  text-align: right;
  font-size: 0.85em;
  color: var(--text-dim);
  opacity: 0.55;
  user-select: none;
  transition: width var(--dur-1) var(--ease-soft);
}
.gutter + .gutter { width: 34px; }
/* A number is also the way into the editor at that line; it says so only
   when the pointer is on it. */
.gutter.jump { cursor: pointer; }
.gutter.jump:hover { color: var(--accent); opacity: 1; }
/* Narrow, the hunk has the whole panel and the numbers should not take a
   quarter of it back. */
.diff.narrow .gutter { width: 30px; padding-right: 6px; }
.hunks { tab-size: 4; }

/* Split: two halves that keep their rows level, so long lines wrap rather
   than scroll one side out of step with the other. */
.sxs { display: grid; grid-template-columns: 1fr 1fr; }
.sxs > .line { min-width: 0; }
.sxs > .line + .line { border-left: 1px solid var(--line-soft); }
.split .txt { white-space: pre-wrap; overflow-wrap: anywhere; }
.line.blank { background: var(--bg-sunken); }
.split .line.meta > .txt { padding-left: 20px; }
.sign { flex: none; width: 14px; text-align: center; user-select: none; }
.line.add .sign, .line.add .txt { color: var(--diff-add-text); }
.line.del .sign, .line.del .txt { color: var(--diff-del-text); }
.txt { flex: 1; padding-right: 16px; }

/* A hunk's own discard, on its header line: out of the way until the
   pointer is on that change. */
.hdisc {
  position: sticky;
  right: 8px;
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  margin-right: 8px;
  padding: 0 7px;
  border-radius: 5px;
  font-family: var(--font);
  font-size: 11px;
  color: var(--text-dim);
  opacity: 0;
  transition: opacity var(--dur-1) var(--ease-soft), background var(--dur-1) var(--ease-soft), color var(--dur-1) var(--ease-soft);
}
.hdisc .lucide { width: 12px; height: 12px; }
.line.meta:hover .hdisc,
.hdisc:focus-visible { opacity: 1; }
.hdisc:hover { color: var(--danger); background: var(--hover); }
</style>
