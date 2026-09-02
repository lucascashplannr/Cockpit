<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CommitPreview, DiffFile, FileDiff, StashEntry, Workspace } from '@cockpit/shared'
import type { Component } from 'vue'
import {
  Archive, ArchiveRestore, Check, ChevronRight, CircleDashed, FileCode, GitBranch,
  GitCommitHorizontal, ArrowLeft, Sparkles, SquareArrowOutUpRight, Trash2, TriangleAlert,
  User, UsersRound,
} from '@lucide/vue'
import Splitter from '../Splitter.vue'
import {
  LAYOUT_LIMITS, commit, commitPreview, draftCommitMessage, guard, layout, resetCommitHeight,
  saveLayout, selectWorkspace, setCommitHeight, stash, stashList, toast, client, state,
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

let ro: ResizeObserver | null = null
let barRo: ResizeObserver | null = null
onMounted(() => {
  ro = new ResizeObserver(([e]) => {
    if (!e) return
    narrow.value = e.contentRect.width < 620
    panelH.value = e.contentRect.height
    if (layout.commit && layout.commit > commitMax.value) setCommitHeight(commitMax.value)
  })
  if (root.value) ro.observe(root.value)
  barRo = new ResizeObserver(([e]) => {
    if (e) measuredCommit.value = Math.round(e.contentRect.height)
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
const loading = ref(false)

const totals = computed(() => ({
  add: files.value.reduce((n, f) => n + f.additions, 0),
  del: files.value.reduce((n, f) => n + f.deletions, 0),
}))

async function load() {
  loading.value = true
  const r = await guard(() => client.call('diff.files', { workspaceId: props.workspace.id }))
  files.value = r ?? []
  loading.value = false
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
    else void select(files.value[0]!.path)
  }
}

async function select(path: string) {
  selected.value = path
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

const message = ref('')
const stageAll = ref(true)
const committing = ref(false)
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
const fileCount = computed(() =>
  willCommit.value.reduce((n, r) => n + (stageAll.value ? r.staged + r.unstaged : r.staged), 0),
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
  () => !!message.value.trim() && fileCount.value > 0 && !blocked.value.length && !committing.value,
)

async function doCommit() {
  if (!canCommit.value) return
  committing.value = true
  const ok = await commit(null, props.workspace.id, message.value.trim(), stageAll.value)
  committing.value = false
  // The plan dialog takes it from here; clearing on success keeps the field
  // from re-offering a message that has already been used.
  if (ok) {
    message.value = ''
    drafted.value = null
  }
}

/* ── §16 — the draft ──────────────────────────────────────────────────────
 *
 * An engine reads the diff and proposes a first sentence into this box. It
 * does not commit, and it cannot: what goes in is a string, and the button
 * next to it is still the one a person presses.
 *
 * §12 is why `drafted` exists. A message nobody rewrote is a message nobody
 * wrote, and the difference should be visible while it can still be acted on
 * — so the note sits under the box until the text is touched, and the journal
 * keeps the fact afterwards.
 */

/**
 * The box grows to what is in it, up to a point.
 *
 * A drafted body is three or four wrapped lines, and a two-line box showed the
 * subject with the reason scrolled out of sight — which is the half a person
 * most needs to read before committing something they did not write. Measured
 * rather than counted from newlines: at this width the wrapping is most of the
 * height.
 */
const box = ref<HTMLTextAreaElement | null>(null)

function fit() {
  const el = box.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 190) + 'px'
}

watch(message, () => void nextTick(fit))

const drafting = ref(false)
const drafted = ref<string | null>(null)
/** The exact text that came back, so any edit at all clears the mark. */
const draftText = ref('')

async function draftMessage() {
  if (drafting.value || !fileCount.value) return
  drafting.value = true
  // Whatever is already in the box is a hint, not a thing to protect: someone
  // who types "fixes the TVA rounding" and presses Draft is asking for that
  // note turned into a message, not preserved beside one.
  const text = await draftCommitMessage(
    null,
    props.workspace.id,
    stageAll.value,
    message.value.trim() || undefined,
  )
  drafting.value = false
  if (!text) return
  message.value = text
  draftText.value = text
  drafted.value = 'claude'
}

watch(message, (v) => {
  if (v !== draftText.value) drafted.value = null
})

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
    ...(message.value.trim() ? { message: message.value.trim() } : {}),
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

watch(() => props.workspace.id, load, { immediate: true })
// The core re-pushes workspaces whenever the watcher fires; refresh with it.
watch(
  () => props.workspace.git && props.workspace.git.staged + props.workspace.git.unstaged + props.workspace.git.untracked,
  () => void load(),
)

/** One icon per author, and the icon is the same everywhere it appears. */
const mark: Record<string, Component> = {
  human: User,
  agent: Sparkles,
  mixed: UsersRound,
  unknown: CircleDashed,
}
</script>

<template>
  <div ref="root" class="diff" :class="{ narrow, drilled: narrow && drilled }">
    <aside class="files">
      <div class="ftop">
        <span class="section-label">files ({{ files.length }})</span>
        <span class="tot num">
          <span class="add">+{{ totals.add }}</span>
          <span class="del">−{{ totals.del }}</span>
        </span>
      </div>

      <div class="scroll">
        <button
          v-for="f in files"
          :key="f.path"
          class="frow"
          :class="{ on: f.path === selected }"
          @click="select(f.path)"
        >
          <span class="attr" :class="f.attribution" :title="'written by: ' + f.attribution">
            <component :is="mark[f.attribution]" class="sm" />
          </span>
          <span class="st" :class="f.status">{{ f.status }}</span>
          <span class="fp">{{ f.path }}</span>
          <span class="counts num">
            <span v-if="f.additions" class="add">+{{ f.additions }}</span>
            <span v-if="f.deletions" class="del">−{{ f.deletions }}</span>
          </span>
          <!-- Narrow, the row goes somewhere rather than merely being picked. -->
          <ChevronRight v-if="narrow" class="go" />
        </button>

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
        :size="layout.commit ?? measuredCommit"
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
      <div ref="bar" class="commitbar" :style="layout.commit ? { height: layout.commit + 'px' } : undefined">
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

          <!-- The draft button belongs to the box, not to the footer: three
               controls in a 320px row wrapped the checkbox onto two lines, and
               a button that writes the message reads better beside the message
               than beside the one that commits it. -->
          <div class="cmhead">
            <span class="section-label">message</span>
            <span class="grow" />
            <button
              class="btn ghost tiny"
              :disabled="!fileCount || drafting"
              :title="
                message.trim()
                  ? 'Draft a message from this diff — what is in the box is used as a hint'
                  : 'Draft a message from this diff'
              "
              @click="draftMessage"
            >
              <Sparkles />
              {{ drafting ? 'Drafting…' : 'Draft' }}
            </button>
          </div>

          <textarea
            ref="box"
            v-model="message"
            class="input cmsg selectable"
            rows="2"
            :placeholder="
              fileCount
                ? 'What changed, and why. ⌘⏎ to commit.'
                : 'Nothing to commit'
            "
            :disabled="!fileCount"
            @keydown.meta.enter="doCommit"
          />
          <!-- §12 — a message nobody rewrote is a message nobody wrote. The
               mark stands until the text is touched. -->
          <p v-if="drafted" class="cdrafted">
            <Sparkles class="sm" />
            Drafted by {{ drafted }} from this diff — read it before you commit.
          </p>

          <div class="cfoot">
            <label class="call">
              <input v-model="stageAll" type="checkbox" />
              <span>stage everything</span>
            </label>
            <span class="grow" />
            <button class="btn primary" :disabled="!canCommit" @click="doCommit">
              <GitCommitHorizontal />
              {{
                committing
                  ? 'Planning…'
                  : 'Commit ' + fileCount + ' file' + (fileCount === 1 ? '' : 's')
              }}
            </button>
          </div>

          <!-- Not committing is a real answer, and it was the one the window
               had no button for: the tree had to be clean to close a topic or
               switch a branch, and the only way there was a commit you did not
               mean or a terminal. -->
          <div v-if="dirty" class="caside">
            <button class="btn ghost tiny" :disabled="stashing" @click="setAside">
              <Archive />
              {{
                stashing
                  ? 'Planning…'
                  : elsewhere.length
                    ? 'Set aside all ' + (elsewhere.length + 1) + ' repos'
                    : 'Set aside instead'
              }}
            </button>
            <span class="anote">
              {{
                message.trim()
                  ? 'Listed here, labelled with the message above.'
                  : 'Listed here until you put it back.'
              }}
            </span>
          </div>
        </template>
      </div>
    </aside>

    <div class="view">
      <div v-if="selected" class="vhead">
        <button v-if="narrow" class="icon-btn back" title="Back to the files" @click="drilled = false">
          <ArrowLeft class="sm" />
        </button>
        <span class="mono vpath">{{ selected }}</span>
        <span class="grow" />
        <button class="btn ghost" @click="openInIde">
          <SquareArrowOutUpRight />Open in IDE
        </button>
      </div>

      <div class="hunks mono" v-if="current && current.lines.length">
        <div v-for="(l, i) in current.lines" :key="i" class="line" :class="l.kind">
          <span class="gutter num">{{ l.oldLine ?? '' }}</span>
          <span class="gutter num">{{ l.newLine ?? '' }}</span>
          <span class="sign">{{ l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ' }}</span>
          <span class="txt">{{ l.text }}</span>
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
  padding: 10px 12px 12px;
  border-top: 1px solid var(--line);
  background: var(--bg-sunken);
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

/* A message is a sentence and often two, and a 30px input made writing one
   feel like filling in a field. */
.cmsg {
  width: 100%;
  resize: vertical;
  min-height: 48px;
  max-height: 190px;
  overflow-y: auto;
  line-height: 1.5;
}

.cfoot { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
.cfoot .grow { flex: 1; }
.call {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  white-space: nowrap;
}
.call input { accent-color: var(--accent); }
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

/* The draft mark. Quiet — it is a fact about the text, not a warning. */
.cdrafted {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 6px 0 0;
  font-size: 10px;
  line-height: 1.45;
  color: var(--agent);
}
.cdrafted .lucide { flex: none; }

.cmhead { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }
.cmhead .grow { flex: 1; }

.caside {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}
.tiny { height: 24px; padding: 0 8px; font-size: var(--fs-xs); }
.tiny .lucide { width: 12px; height: 12px; }
.anote {
  flex: 1;
  min-width: 0;
  font-size: 10px;
  line-height: 1.4;
  color: var(--text-dim);
}

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

.diff { display: grid; grid-template-columns: 320px minmax(0, 1fr); height: 100%; }
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
  background: var(--panel);
}
.ftop {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px 8px;
}
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
.attr.human { color: var(--human); }
.attr.agent { color: var(--agent); }
.attr.mixed { color: var(--warn); }
.attr.unknown { color: var(--text-dim); }
.attr.mixed { color: var(--warn); }

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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* Truncate from the left; `plaintext` keeps the string itself in reading
     order, which bare `rtl` does not — it moves the leading slash to the end. */
  direction: rtl;
  unicode-bidi: plaintext;
  text-align: left;
  font-family: var(--mono);
  font-size: var(--fs-xs);
}
.counts { display: flex; gap: 5px; font-size: 10px; flex: none; }

.view { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
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
  color: var(--text-dim);
  background: var(--bg-sunken);
  font-size: var(--fs-xs);
  padding: 3px 0;
  margin: 6px 0 2px;
}

.gutter {
  flex: none;
  width: 44px;
  transition: width var(--dur-1) var(--ease-soft);
}
/* Narrow, the hunk has the whole panel and the numbers should not take a
   quarter of it back. */
.diff.narrow .gutter {
  width: 30px;
  padding-right: 6px;
  padding-right: 10px;
  text-align: right;
  color: var(--text-dim);
  opacity: 0.6;
  user-select: none;
}
.sign { flex: none; width: 14px; text-align: center; user-select: none; }
.line.add .sign, .line.add .txt { color: var(--diff-add-text); }
.line.del .sign, .line.del .txt { color: var(--diff-del-text); }
.txt { flex: 1; padding-right: 16px; }
</style>
