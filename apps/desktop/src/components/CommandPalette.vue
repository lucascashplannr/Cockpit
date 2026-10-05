<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { Component } from 'vue'
import type { Topic, Workspace } from '@cockpit/shared'
import {
  AppWindow, ArrowDownToLine, ArrowRight, ArrowUpFromLine, BookMarked, Box, Check, CloudDownload,
  Columns2, FileCode,
  FolderOpen,
  FolderGit2, FolderPlus, GitBranch, GitCompareArrows, GitGraph, GitMerge, Globe, History, Layers, PanelLeftClose, PanelLeftOpen, Pause, Play, RefreshCw,
  ScrollText,
  Search, Settings, SlidersHorizontal, Sparkles, SquareDot, SquareTerminal, Stamp, TextSearch,
  Terminal, Trash2, Undo2,
  RotateCcw, Archive, Zap, Activity,
} from '@lucide/vue'
import { fuzzyFilter, highlight } from '../core/fuzzy.js'
import type { Scored } from '../core/fuzzy.js'
import {
  SHELL_VIEWS, setView, viewKey, openCommits, startTopic, activeProject, activeWorkspace, addRepoTo, adoptTopic, askDeleteTopic, chooseCommand, openDeclarations, client, closeTopic, goTo, guard, keyTargets, layout, mergeTopic, markResolved, newProject, onProject, openFileAt, stopTopic, rebaseTopic, reopenTopic, requestPlan, resolveConflict, revealLabel, restartCore, selectProject, selectWorkspace, selectedTopicId, state, toggleList,
} from '../core/store.js'
import type { ShellView, TabId } from '../core/store.js'

/**
 * §12 — "L'objectif « 1 à 3 clics » est en réalité un objectif zéro clic :
 * le clavier bat toujours la souris."
 *
 * Four modes, chosen by the first character:
 *   (nothing)  repositories, branches + actions
 *   >          commands only
 *   /          files (git-tracked, §12)
 *   #          full-text search (§12)
 *
 * And one question asked before any of them: *where*. The palette opens on
 * the narrowest thing you are standing on — a repository, the topic it
 * belongs to, the project — and every mode answers inside it: files are that
 * topic's files, "Close" closes that topic. Everywhere is one ⇥ away.
 */

/** §12's ladder, said in words — the switcher says it in three glyphs. */
const VIEW_LABELS: Record<ShellView, { label: string; hint: string }> = {
  agent: { label: 'Agent only', hint: 'the conversation takes the window' },
  split: { label: 'Agent and review side by side', hint: 'the two columns' },
  review: { label: 'Review only', hint: 'diff, code, journal, terminal across the window' },
}

interface Item {
  id: string
  label: string
  hint?: string
  group: string
  icon: Component
  /** Words it is found by without showing them — above all the ones the
   *  lexicon retired: fingers still type "rebase" and "archive". */
  keywords?: string
  /** The keystroke that does the same thing outside the palette. */
  keys?: string
  /** Acts on the place the palette is scoped to, so it outranks an equal
   *  match that acts somewhere else. */
  boost?: number
  run: () => void | Promise<void>
  /** The hint *is* the result — a search hit's line — so it shows on every
   *  row rather than only on the one under the cursor. */
  always?: boolean
  /** The label is a path: drawn as the file name, with its folder dimmed
   *  after it — still matched as one string. */
  path?: boolean
  /** Asks for one word before running: the input becomes the question. */
  ask?: { placeholder: string; run: (answer: string) => void | Promise<void> }
}

/* ── where ─────────────────────────────────────────────────────────── */

type Level = 'all' | 'project' | 'topic' | 'repo'

interface Scope {
  level: Level
  /** What the chip says. */
  name: string
  /** What it is, for the tooltip and the placeholder. */
  kind: string
  icon: Component
  workspaces: Workspace[]
}

const searchable = (w: Workspace) => w.kind !== 'group'

/**
 * The topic you are in: the one standing selected, or the one the selected
 * row belongs to. A topic from another project is not "here".
 */
const hereTopic = computed<Topic | null>(() => {
  const id = selectedTopicId.value ?? activeWorkspace.value?.topicId ?? null
  const t = id ? state.topics.find((x) => x.id === id) : null
  return t && t.projectId === state.activeProjectId && t.state !== 'closed' ? t : null
})

/** A topic standing selected is the narrowest thing selected: the row that
 *  stays active under it is only what the review column shows. */
const hereRepo = computed<Workspace | null>(() => (selectedTopicId.value || onProject.value ? null : activeWorkspace.value))

function topicWorkspaces(t: Topic): Workspace[] {
  return state.workspaces.filter((w) => searchable(w) && (w.topicId === t.id || t.workspaceIds.includes(w.id)))
}

const scopes = computed<Scope[]>(() => {
  const out: Scope[] = [
    { level: 'all', name: 'Everywhere', kind: 'every project', icon: Globe, workspaces: state.workspaces.filter(searchable) },
  ]
  const p = activeProject.value
  if (p) {
    out.push({
      level: 'project',
      name: p.name,
      kind: 'Project',
      icon: Box,
      workspaces: state.workspaces.filter((w) => searchable(w) && w.projectId === p.id),
    })
  }
  const t = hereTopic.value
  if (t) out.push({ level: 'topic', name: t.name, kind: 'Topic', icon: Layers, workspaces: topicWorkspaces(t) })
  const w = hereRepo.value
  if (w && searchable(w)) {
    out.push({
      level: 'repo',
      name: w.name,
      kind: w.kind === 'worktree' ? 'Branch' : 'Repository',
      icon: w.kind === 'worktree' ? GitBranch : SquareDot,
      workspaces: [w],
    })
  }
  return out
})

// Mounted fresh on every open, so this is read once per open: the palette
// starts where you are standing, and widening is a decision you make.
const level = ref<Level>(scopes.value[scopes.value.length - 1]!.level)
const scope = computed<Scope>(() => scopes.value.find((s) => s.level === level.value) ?? scopes.value[0]!)

/** "“test”" for a topic, the bare name for everything else — the palette's
 *  sentences read "Close “test”", never "Close test". */
function quoted(name: string): string {
  return '“' + name + '”'
}

function stepScope(by: 1 | -1) {
  const list = scopes.value
  const i = list.findIndex((s) => s.level === scope.value.level)
  level.value = list[(i + by + list.length) % list.length]!.level
}

/* ── state ─────────────────────────────────────────────────────────── */

const query = ref(state.paletteSeed)
state.paletteSeed = ''
const cursor = ref(0)
const input = ref<HTMLInputElement | null>(null)
/** Tracked files per workspace, fetched once per open and only when asked. */
const trackedFiles = ref(new Map<string, string[]>())
const loadingFiles = ref(false)
const searchHits = ref<{ workspaceId: string; path: string; line: number; text: string }[]>([])
const searching = ref(false)
/** A command that asked for a word; while set, the input is its answer. */
const asking = ref<Item | null>(null)

type Mode = 'default' | 'command' | 'file' | 'text'

const mode = computed<Mode>(() => {
  if (asking.value) return 'default'
  const q = query.value
  if (q.startsWith('>')) return 'command'
  if (q.startsWith('/')) return 'file'
  if (q.startsWith('#')) return 'text'
  return 'default'
})

const MODES: { mode: Mode; prefix: string; label: string }[] = [
  { mode: 'command', prefix: '>', label: 'Commands' },
  { mode: 'file', prefix: '/', label: 'Files' },
  { mode: 'text', prefix: '#', label: 'Text' },
]

/** The pills set the prefix rather than a hidden flag, so what is typed is
 *  still the whole truth and a backspace undoes the click. */
function toggleMode(m: Mode) {
  const t = term.value
  const prefix = MODES.find((x) => x.mode === m)?.prefix ?? ''
  query.value = mode.value === m ? t : prefix + t
  void nextTick(() => input.value?.focus())
}

const leadIcon = computed<Component>(() =>
  asking.value
    ? asking.value.icon
    : mode.value === 'file'
      ? FolderOpen
      : mode.value === 'text'
        ? TextSearch
        : mode.value === 'command'
          ? ArrowRight
          : Search,
)

const term = computed(() => (mode.value === 'default' ? query.value : query.value.slice(1).trim()))

const where = computed(() => {
  const s = scope.value
  if (s.level === 'all') return 'everywhere'
  return s.level === 'topic' ? quoted(s.name) : s.name
})

const placeholder = computed(() => {
  if (asking.value) return asking.value.ask!.placeholder
  switch (mode.value) {
    case 'command':
      return 'Commands for ' + where.value
    case 'file':
      return 'Files in ' + where.value
    case 'text':
      return 'Text in ' + where.value
    default:
      // The mode pills say > / # already; the prompt only has to say where.
      return 'Search ' + where.value
  }
})

function close() {
  state.paletteOpen = false
}

/** Wraps an action so the palette closes first; the result is discarded
 *  because every handler reports through the toast itself. */
function act(fn: () => unknown) {
  return async () => {
    close()
    await fn()
  }
}

/* ── the last few commands run from here ───────────────────────────── */

const RECENT_KEY = 'cockpit.palette.recent'
const RECENT_MAX = 5
/** What the palette shows before anything is typed. */
const OPENING_RECENT = 3
const OPENING_MIN = 8
const OPENING_MAX = 14

function readRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function rememberCommand(id: string) {
  const next = [id, ...readRecent().filter((x) => x !== id)].slice(0, 20)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // A palette that cannot remember is still a palette.
  }
}

/* ── commands ──────────────────────────────────────────────────────── */

/** Boosts: large enough to break a tie between two equal matches, small
 *  enough that a word typed exactly still beats a scattered one. */
const HERE = 160
const NEAR = 80

/**
 * Commands are built from the live capability set, so an absent capability
 * contributes no command at all (§3.9) — and from the scope, so a topic you
 * are not in contributes none either.
 */
function buildCommands(lvl: Level): Item[] {
  const w = activeWorkspace.value
  const project = activeProject.value
  const out: Item[] = []

  // The topics this scope can act on. Narrow scopes name one topic, so the
  // verbs say its name; wide ones list every topic of the project.
  const topicHere = lvl === 'topic' || lvl === 'repo' ? hereTopic.value : null
  const topics =
    lvl === 'all' || lvl === 'project'
      ? state.topics.filter((f) => f.projectId === state.activeProjectId && f.state !== 'closed')
      : topicHere && (lvl === 'topic' || w?.topicId === topicHere.id)
        ? [topicHere]
        : []
  const closed =
    lvl === 'all' || lvl === 'project'
      ? state.topics.filter((f) => f.projectId === state.activeProjectId && f.state === 'closed')
      : []
  const topicBoost = lvl === 'topic' ? HERE : lvl === 'repo' ? NEAR : 0

  // The repository verbs act on the selected row. Scoped to a topic that row
  // does not belong to, they would act on something outside of where you
  // said you were — so they are not offered there at all.
  const repo = lvl === 'topic' && w && !hereTopic.value?.workspaceIds.includes(w.id) && w.topicId !== hereTopic.value?.id
    ? null
    : w
  const repoBoost = lvl === 'repo' ? HERE : 0

  // §4 — the durable unit of work, and the switch between two of them. Listed
  // before anything workspace-scoped: it is the level the day is organised at.
  if (project && lvl !== 'repo') {
    out.push({
      id: 'topic:open',
      label: 'Open a topic',
      hint: 'one named branch across every repository it touches',
      group: 'Topic',
      icon: Layers,
      keywords: 'new topic feature create',
      run: act(() => {
        state.topicDialogOpen = true
      }),
    })
  }

  for (const f of topics) {
    const name = quoted(f.name)
    const push = (item: Omit<Item, 'group' | 'boost'>) =>
      out.push({ ...item, group: 'Topic', boost: topicBoost, keywords: 'topic ' + f.name + ' ' + (item.keywords ?? '') })
    // An inferred topic has one verb and it is the one that gives it the
    // others. Listing the rest would offer acts with nothing to act on.
    if (f.derived) {
      push({
        id: 'topic:adopt:' + f.id,
        label: 'Take over ' + name,
        hint: 'inferred from the branch name — records it as a topic of its own; nothing on disk moves',
        icon: Stamp,
        keywords: 'adopt',
        run: act(() => adoptTopic(f.id)),
      })
      continue
    }
    const isLive = f.state === 'running'
    push({
      id: 'topic:toggle:' + f.id,
      label: (isLive ? 'Stop ' : 'Start ') + name,
      hint: isLive ? 'its servers go down; the branches stay' : 'bring its servers up',
      icon: isLive ? Pause : Play,
      keywords: 'servers run park activate',
      run: act(() => (isLive ? stopTopic(f.id) : startTopic(f.id))),
    })
    push({
      id: 'topic:rebase:' + f.id,
      label: 'Catch ' + name + ' up with its base',
      hint: 'every repository it spans, one plan — stops at the first conflict',
      icon: GitCompareArrows,
      keywords: 'rebase update sync',
      run: act(() => rebaseTopic(f.id)),
    })
    push({
      id: 'topic:land:' + f.id,
      label: 'Send ' + name + ' to its base',
      hint: 'onto the base branch in every repository — the plan is shown first',
      icon: GitMerge,
      keywords: 'merge land ship',
      run: act(() => mergeTopic(f.id, false)),
    })
    push({
      id: 'topic:landpush:' + f.id,
      label: 'Send ' + name + ' to its base and push',
      hint: 'the same, then pushes the base branch',
      icon: GitMerge,
      keywords: 'merge land ship',
      run: act(() => mergeTopic(f.id, true)),
    })
    push({
      id: 'topic:close:' + f.id,
      label: 'Close ' + name,
      hint: 'reversible — the branches are removed by their own plan',
      icon: Archive,
      keywords: 'archive',
      run: act(() => closeTopic(f.id, true)),
    })
    push({
      id: 'topic:delete:' + f.id,
      label: 'Delete ' + name + '…',
      hint: 'drops the record for good; the branch is a checkbox in the question',
      icon: Trash2,
      keywords: 'remove',
      run: act(() => askDeleteTopic(f.id)),
    })
  }
  // §3.9 — a closed topic is listed only where it can be acted on.
  for (const f of closed) {
    out.push({
      id: 'topic:reopen:' + f.id,
      label: 'Reopen ' + quoted(f.name),
      hint: 'closed ' + new Date(f.updatedAt).toLocaleDateString(),
      group: 'Topic',
      icon: RotateCcw,
      keywords: 'topic unarchive restore',
      run: act(() => reopenTopic(f.id)),
    })
    out.push({
      id: 'topic:delete:' + f.id,
      label: 'Delete ' + quoted(f.name) + '…',
      hint: 'closed — remove it from the record for good',
      group: 'Topic',
      icon: Trash2,
      keywords: 'topic remove',
      run: act(() => askDeleteTopic(f.id)),
    })
  }

  // §7 — the layout does not stop at creation: a backend joining a project a
  // month later lands beside the repositories already in it, not elsewhere.
  if (project && lvl !== 'repo' && lvl !== 'topic') {
    out.push({
      id: 'project:addRepo',
      label: 'Add a repository',
      hint: 'a new one, a clone, or a folder moved into ' + project.name,
      group: 'Project',
      icon: FolderGit2,
      keywords: 'clone import',
      run: act(() => addRepoTo(project.id)),
    })
  }

  const tab = (id: TabId, label: string, icon: Component) => {
    const n = keyTargets.value.indexOf(id)
    out.push({
      id: 'tab:' + id,
      label: 'Go to ' + label,
      group: 'View',
      icon,
      keys: n >= 0 && n < 9 ? '⌘' + (n + 1) : undefined,
      run: act(() => {
        goTo(id)
      }),
    })
  }

  // The tools of one checkout; on the project there is none to open them on.
  const single = !onProject.value

  if (w) {
    if (single) tab('code', 'Code', FileCode)
    if (single && w.git) tab('diff', 'Diff', GitCompareArrows)
    if (single && w.git) {
      out.push({
        id: 'tab:commits',
        label: 'Go to Commits',
        group: 'View',
        icon: GitGraph,
        keywords: 'history log graph push',
        run: act(() => openCommits()),
      })
    }
    tab('agent', 'Agent', Sparkles)
    tab('memory', 'Memory', BookMarked)
    tab('journal', 'Journal', ScrollText)
    tab('terminal', 'Terminal', SquareTerminal)

    // §12 — the same three the switcher draws. A tool says *what* to show;
    // these say how much of the window to give it, which is a different
    // question and the palette is where every question is asked.
    for (const v of SHELL_VIEWS) {
      if (v === state.view) continue
      out.push({
        id: 'view:' + v,
        label: VIEW_LABELS[v].label,
        hint: VIEW_LABELS[v].hint,
        group: 'View',
        icon: Columns2,
        keywords: 'layout',
        keys: viewKey(v),
        run: act(() => setView(v)),
      })
    }
  }

  // §12 — and the list beside all of that. Outside the block above because it
  // is not one of the three views; inside the same group because it is the
  // same kind of question: how much of the window, to what.
  if (w) {
    out.push({
      id: 'view:list',
      label: layout.listOpen ? 'Narrow the list' : 'Widen the list',
      hint: layout.listOpen ? 'a strip of tiles — the width goes to the conversation' : 'names and counters back',
      group: 'View',
      icon: layout.listOpen ? PanelLeftClose : PanelLeftOpen,
      keywords: 'layout sidebar collapse hide show strip column navigation',
      keys: '⌘B',
      run: act(toggleList),
    })
  }

  if (repo) {
    const r = repo
    out.push({
      id: 'ide',
      label: 'Open ' + r.name + ' in the IDE',
      group: 'Open',
      icon: FileCode,
      keywords: 'editor code vscode',
      keys: 'O',
      boost: repoBoost,
      run: act(() => guard(() => client.call('workspace.openIn', { workspaceId: r.id, target: 'ide' }))),
    })
    out.push({
      id: 'finder',
      label: revealLabel,
      hint: r.name,
      group: 'Open',
      icon: FolderOpen,
      keywords: 'finder explorer folder',
      boost: repoBoost,
      run: act(() => guard(() => client.call('workspace.openIn', { workspaceId: r.id, target: 'finder' }))),
    })

    if (r.runtime) {
      const rt = r.runtime
      out.push({
        id: 'rt',
        label: rt.status === 'up' ? 'Stop the servers' : 'Start the servers',
        hint: rt.impl,
        group: 'Servers',
        icon: Zap,
        keywords: 'runtime run dev',
        boost: repoBoost,
        run: act(() => guard(() => client.call(rt.status === 'up' ? 'runtime.down' : 'runtime.up', { workspaceId: r.id }))),
      })
      if (rt.preview?.kind === 'url') {
        out.push({
          id: 'prev',
          label: 'Open the preview',
          hint: rt.preview.value,
          group: 'Servers',
          icon: AppWindow,
          keywords: 'browser url',
          boost: repoBoost,
          run: act(() => guard(() => client.call('workspace.openIn', { workspaceId: r.id, target: 'browser' }))),
        })
      }
    }

    out.push({
      id: 'declare',
      label: 'Manage commands & servers',
      hint: 'what this project runs, per repository or for the project itself',
      group: 'Run',
      icon: SlidersHorizontal,
      keywords: 'declare manifest scripts',
      run: act(() => openDeclarations()),
    })

    // §8 — the declared one-shots, in the order the manifest lists them.
    // They sit under their own heading rather than among the git verbs: what
    // they have in common is that the project declared them, not what they do.
    for (const c of state.commands) {
      out.push({
        id: 'cmd:' + c.name,
        label: c.name,
        hint: c.cmd,
        group: 'Run',
        icon: Terminal,
        boost: repoBoost,
        // The same act as the bar's, so running `build` from here also leaves
        // `build` on the bar's button: which command is "the one" is a habit,
        // and a habit does not care which surface you pressed it from.
        run: act(() => chooseCommand(c)),
      })
    }

    // §3.7 — a stopped rebase replaces the git verbs rather than sitting beside
    // them: git refuses every one of them until this ends, and offering a
    // rebase mid-rebase is offering a guaranteed error.
    if (r.git?.operation) {
      const o = r.git.operation
      out.push({
        id: 'git:continue',
        label: 'Continue the ' + o.kind,
        hint: o.unresolvedPaths.length
          ? o.unresolvedPaths.length + ' file(s) still carry conflict markers'
          : 'stages the resolved files and carries on',
        group: 'Conflict',
        icon: Check,
        boost: HERE,
        run: act(() => resolveConflict('continue')),
      })
      if (o.kind !== 'merge') {
        out.push({
          id: 'git:skip',
          label: 'Skip this commit',
          hint: 'drop it and move to the next',
          group: 'Conflict',
          icon: GitCompareArrows,
          boost: HERE,
          run: act(() => resolveConflict('skip')),
        })
      }
      out.push({
        id: 'git:abort',
        label: 'Abort the ' + o.kind,
        hint: 'the branch goes back exactly where it started; the autostash comes with it',
        group: 'Conflict',
        icon: Undo2,
        boost: HERE,
        run: act(() => resolveConflict('abort')),
      })
      if (o.unresolvedPaths.length) {
        out.push({
          id: 'git:markall',
          label: 'Mark every conflicted file resolved',
          hint: 'only when the markers belong in those files',
          group: 'Conflict',
          icon: Check,
          boost: HERE,
          run: act(() => markResolved(o.conflictedPaths)),
        })
      }
    } else if (r.git) {
      /**
       * §4 — the verbs by the names on the bar, not by the RPC ids, and with
       * the base branch named: "Send to dev" says which way the code moves,
       * which is the whole reason the lexicon renamed them. The retired words
       * stay findable as keywords.
       *
       * Catch up is absent on the base branch for the same reason it is absent
       * from the bar there: a branch cannot be replayed onto itself, and what
       * you are behind is your own remote, which is Pull.
       */
      const base = r.git.base ?? 'the base branch'
      const ops: { op: 'rebase' | 'pull' | 'merge' | 'push' | 'sync'; label: string; icon: Component; keywords: string; keys?: string }[] = []
      if (r.git.behindBase != null) {
        ops.push({ op: 'rebase', label: 'Catch up from ' + base, icon: GitCompareArrows, keywords: 'rebase update', keys: 'R' })
      }
      ops.push(
        { op: 'pull', label: 'Pull this branch from origin', icon: ArrowDownToLine, keywords: 'fetch download' },
        { op: 'merge', label: 'Send this branch to ' + base, icon: GitMerge, keywords: 'merge land ship' },
        { op: 'push', label: 'Push this branch to origin', icon: ArrowUpFromLine, keywords: 'upload', keys: 'P' },
        { op: 'sync', label: 'Fetch every remote', icon: RefreshCw, keywords: 'sync remote' },
      )
      for (const o of ops) {
        out.push({
          id: 'git:' + o.op,
          label: o.label,
          hint: r.name + ' · shows a plan first',
          group: 'Git',
          icon: o.icon,
          keywords: 'git ' + o.keywords,
          keys: o.keys,
          boost: repoBoost,
          run: act(() => requestPlan(r.id, o.op)),
        })
      }
      out.push({
        id: 'git:branch',
        label: 'Create a branch here',
        hint: 'in this checkout — nothing new on disk',
        group: 'Git',
        icon: GitBranch,
        keywords: 'git new checkout',
        boost: repoBoost,
        run: () => {},
        ask: {
          placeholder: 'Name for the new branch, then ⏎',
          run: (name) => requestPlan(r.id, 'branch', { name }),
        },
      })
      out.push({
        id: 'git:worktree',
        label: 'Create a branch in its own folder',
        hint: 'a separate checkout, so this one keeps what is in it',
        group: 'Git',
        icon: GitBranch,
        keywords: 'git new worktree',
        boost: repoBoost,
        run: () => {},
        ask: {
          placeholder: 'Name for the new branch, then ⏎',
          run: (name) => requestPlan(r.id, 'worktree', { name }),
        },
      })
      out.push({
        id: 'git:undo',
        label: 'Undo the last operation',
        hint: 'back to the last restore point',
        group: 'Git',
        icon: Undo2,
        keywords: 'git revert roll back restore',
        boost: repoBoost,
        run: act(() => guard(() => client.call('git.undo', { workspaceId: r.id }))),
      })
    }
  }

  // §12 — "Agent ici ← C0, deux touches". The cheapest possible path.
  if (w) {
    out.push({
      id: 'agent:here',
      label: 'Ask the agent here',
      hint: 'logged, locked, restore point captured first',
      group: 'Agent',
      icon: Sparkles,
      keywords: 'chat conversation claude',
      run: act(() => {
        goTo('agent')
      }),
    })
  }

  // Project-level, not workspace-level: it is the folder that gets renamed,
  // moved, untracked or thrown away.
  if (project) {
    out.push({
      id: 'proj:settings',
      label: 'Project settings…',
      hint: project.name + ' — rename, move, untrack',
      group: 'Project',
      icon: Settings,
      keywords: 'rename move untrack',
      run: act(() => {
        state.editingProjectId = project.id
      }),
    })
  }

  // Cockpit's own — nothing to do with where you are, so every scope keeps
  // them: a scope narrows what you act *on*, and Settings acts on nothing.
  out.push({
    id: 'core:restart',
    label: 'Restart the service',
    hint: 'servers keep running; conversations end but stay resumable',
    group: 'Cockpit',
    icon: RefreshCw,
    keywords: 'core daemon reload',
    run: act(() => restartCore()),
  })
  out.push({
    id: 'rescan',
    label: 'Refresh everything',
    group: 'Cockpit',
    icon: RefreshCw,
    keywords: 'reconcile rescan probe',
    run: act(() => guard(() => client.call('core.reconcile', {}), 'refreshed')),
  })
  // Three rows rather than one: "which of the three" is the only question the
  // sheet asks that the palette can answer first, and typing "clone" should
  // land on the one that matters.
  out.push({
    id: 'newproj',
    label: 'New project from scratch…',
    hint: 'an empty project, ready for its first repository',
    group: 'Cockpit',
    icon: FolderPlus,
    keywords: 'create',
    run: act(() => newProject('scratch')),
  })
  out.push({
    id: 'newproj:folder',
    label: 'New project from a folder…',
    hint: 'something already on this machine',
    group: 'Cockpit',
    icon: FolderOpen,
    keywords: 'create import',
    run: act(() => newProject('folder')),
  })
  out.push({
    id: 'newproj:clone',
    label: 'New project from a repository…',
    hint: 'clone from GitHub or any git remote',
    group: 'Cockpit',
    icon: CloudDownload,
    keywords: 'create clone github',
    run: act(() => newProject('clone')),
  })
  out.push({
    id: 'service',
    label: 'Service…',
    hint: 'version, agents, PATH, logs, restart',
    group: 'Cockpit',
    icon: Activity,
    keywords: 'logs version status',
    run: act(() => {
      state.serviceOpen = true
    }),
  })
  out.push({
    id: 'settings',
    label: 'Settings…',
    hint: 'the Dev folder, the editor',
    group: 'Cockpit',
    icon: SlidersHorizontal,
    keywords: 'preferences',
    run: act(() => {
      state.settingsOpen = true
    }),
  })

  return out
}

/* ── places to go ──────────────────────────────────────────────────── */

function workspaceItem(w: Workspace, lvl: Level): Item {
  const project = state.projects.find((p) => p.id === w.projectId)?.name ?? ''
  const topic = w.topicId ? state.topics.find((t) => t.id === w.topicId)?.name : null
  return {
    id: 'ws:' + w.id,
    label: w.name,
    hint: [
      lvl === 'all' ? project : null,
      topic && lvl !== 'topic' ? quoted(topic) : null,
      w.git ? '↑' + w.git.ahead + ' ↓' + w.git.behind : null,
      w.runtime?.status === 'up' ? 'running' : null,
    ]
      .filter(Boolean)
      .join(' · '),
    // Two groups, because they are two things: a repository sitting on its
    // default branch, and a branch checked out in its own folder.
    group: w.kind === 'worktree' ? 'Branches' : 'Repositories',
    icon: w.kind === 'worktree' ? GitBranch : SquareDot,
    keywords: w.repoName + ' ' + (w.git?.branch ?? '') + (lvl === 'all' ? '' : ' ' + project),
    run: act(() => selectWorkspace(w.id)),
  }
}

/**
 * Where the scope lets you jump. A repository's own scope offers its other
 * checkouts — the same code on another branch is the one jump that stays
 * inside it.
 */
function placesFor(lvl: Level): Item[] {
  const s = scopes.value.find((x) => x.level === lvl)
  if (!s) return []
  let ws: Workspace[]
  if (lvl === 'repo') {
    const w = s.workspaces[0]!
    ws = state.workspaces.filter(
      (x) => searchable(x) && x.id !== w.id && x.projectId === w.projectId && x.repoName === w.repoName,
    )
  } else {
    // The row you are standing on is not somewhere to go — but a topic
    // standing selected has no row under it, so all of its repositories are.
    ws = s.workspaces.filter((x) => lvl === 'all' || x.id !== hereRepo.value?.id)
  }
  const out = ws.map((w) => workspaceItem(w, lvl))
  if (lvl === 'all') {
    for (const p of state.projects) {
      const n = state.workspaces.filter((w) => w.projectId === p.id && searchable(w)).length
      out.push({
        id: 'proj:' + p.id,
        label: p.name,
        hint: (p.id === state.activeProjectId ? 'this project · ' : '') + n + (n === 1 ? ' repository' : ' repositories'),
        group: 'Projects',
        icon: Box,
        keywords: 'project',
        run: act(() => selectProject(p.id)),
      })
    }
  }
  return out
}

const commands = computed(() => buildCommands(level.value))
const places = computed(() => placesFor(level.value))

/* ── files and text ────────────────────────────────────────────────── */

/** Several checkouts in one list need their repository in front of each
 *  path; one checkout does not, and "api/" on every row would be noise. */
const manyPlaces = computed(() => scope.value.workspaces.length > 1)

function prefixOf(w: Workspace): string {
  return (w.repoName || w.name) + '/'
}

function branchHint(w: Workspace): string {
  const bits: string[] = []
  if (scope.value.level === 'all') bits.push(state.projects.find((p) => p.id === w.projectId)?.name ?? '')
  if (w.kind === 'worktree') bits.push(w.git?.branch ?? w.name)
  return bits.filter(Boolean).join(' · ')
}

const fileItems = computed<Item[]>(() => {
  const out: Item[] = []
  for (const w of scope.value.workspaces) {
    const files = trackedFiles.value.get(w.id)
    if (!files) continue
    const prefix = manyPlaces.value ? prefixOf(w) : ''
    const hint = manyPlaces.value ? branchHint(w) : ''
    for (const f of files) {
      out.push({
        id: 'file:' + w.id + ':' + f,
        label: prefix + f,
        hint: hint || undefined,
        path: true,
        group: 'Files',
        icon: FileCode,
        run: act(() => openFileAt(w.id, f)),
      })
    }
  }
  return out
})

const textItems = computed<Item[]>(() =>
  searchHits.value.map((h) => {
    const w = state.workspaces.find((x) => x.id === h.workspaceId)
    const prefix = w && manyPlaces.value ? prefixOf(w) : ''
    return {
      id: 'hit:' + h.workspaceId + h.path + h.line,
      label: prefix + h.path + ':' + h.line,
      hint: h.text.trim().slice(0, 90),
      always: true,
      path: true,
      group: 'Matches',
      icon: TextSearch,
      run: act(() => openFileAt(h.workspaceId, h.path, h.line)),
    }
  }),
)

/* ── ranking ───────────────────────────────────────────────────────── */

const haystack = (i: Item) => i.label + ' ' + i.group + ' ' + (i.keywords ?? '') + ' ' + (i.hint ?? '')

/** A word found as typed scores in the thousands; letters picked out of a
 *  hint one by one score in the tens. Once there is a real hit, those are
 *  noise — "rebase" should not list "Restart the service" under the answer. */
const WORD_HIT = 500
const SCATTERED = 150

/** A match, with what it scored before the scope's boost was added. */
interface Ranked extends Scored<Item> {
  raw: number
}

function rank(pool: Item[], t: string, limit = 40): Ranked[] {
  let hits: Ranked[] = fuzzyFilter(pool, t, haystack, Infinity).map((h) => ({ ...h, raw: h.score }))
  if (strong(hits)) hits = hits.filter((h) => h.raw >= SCATTERED)
  for (const h of hits) h.score += h.item.boost ?? 0
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, limit)
}

const strong = (hits: Ranked[]) => hits.some((h) => h.raw >= WORD_HIT)

const plain = (items: Item[]): Ranked[] => items.map((item) => ({ item, score: 0, raw: 0, positions: [] }))

/** Nothing typed: what you most likely came for, in that order. */
function opening(): Item[] {
  const cmds = commands.value
  const byId = new Map(cmds.map((c) => [c.id, c]))
  const recent = readRecent()
    .map((id) => byId.get(id))
    .filter((c): c is Item => !!c)
    .slice(0, RECENT_MAX)
  const taken = new Set(recent.map((c) => c.id))
  const rest = cmds.filter((c) => !taken.has(c.id))
  const here = rest.filter((c) => (c.boost ?? 0) >= HERE)
  const others = rest.filter((c) => (c.boost ?? 0) < HERE)
  // A short list, not a menu of everything: what acts on here, where you
  // might go next, and the rest only if that leaves the list thin. Typing
  // still reaches every command.
  const first = [
    ...recent.slice(0, OPENING_RECENT).map((c) => ({ ...c, id: 'recent:' + c.id, group: 'Recent', icon: c.icon })),
    ...here,
    ...places.value.slice(0, 6),
  ]
  return [...first, ...others.slice(0, Math.max(0, OPENING_MIN - first.length))].slice(0, OPENING_MAX)
}

const scoped = computed<Ranked[]>(() => {
  const t = term.value
  if (asking.value) return []
  if (mode.value === 'command') return t ? rank(commands.value, t) : plain(commands.value)
  if (mode.value === 'file') {
    const hits: Ranked[] = fuzzyFilter(fileItems.value, t, (i) => i.label + ' ' + (i.hint ?? ''), Infinity).map((h) => ({ ...h, raw: h.score }))
    return (strong(hits) ? hits.filter((h) => h.raw >= SCATTERED) : hits).slice(0, 60)
  }
  if (mode.value === 'text') return plain(textItems.value)
  if (!t) return plain(opening())
  return rank([...places.value, ...commands.value], t)
})

/**
 * Nothing here, something elsewhere: say so and show it, rather than a bare
 * "No match" that makes you guess whether the thing exists at all — or a few
 * letters scraped out of hints, which is what a scope with no real hit has
 * left. Only for what is already in memory: files and text would mean a
 * fetch per keystroke.
 */
const outside = computed<Ranked[]>(() => {
  const t = term.value
  if (!t || scope.value.level === 'all' || strong(scoped.value)) return []
  if (mode.value === 'command') return rank(buildCommands('all'), t, 12)
  if (mode.value === 'default') return rank([...placesFor('all'), ...buildCommands('all')], t, 12)
  return []
})

/** Showing what is outside the scope, because the scope had nothing real. */
const elsewhere = computed(
  () => outside.value.length > 0 && (!scoped.value.length || (!strong(scoped.value) && strong(outside.value))),
)

const results = computed(() => (elsewhere.value ? outside.value : scoped.value))

const grouped = computed(() => {
  const map = new Map<string, { item: Item; positions: number[] }[]>()
  for (const r of results.value) {
    const arr = map.get(r.item.group) ?? []
    arr.push({ item: r.item, positions: r.positions })
    map.set(r.item.group, arr)
  }
  return [...map.entries()].map(([group, items]) => ({ group, items }))
})

const flat = computed(() => grouped.value.flatMap((g) => g.items.map((e) => e.item)))

watch(results, () => {
  cursor.value = 0
})

/* ── fetching ──────────────────────────────────────────────────────── */

/** File lists are fetched lazily, only in their mode, once per checkout. */
watch(
  [mode, () => scope.value.workspaces.map((w) => w.id).join(',')],
  async () => {
    if (mode.value !== 'file') return
    const missing = scope.value.workspaces.filter((w) => !trackedFiles.value.has(w.id))
    if (!missing.length) return
    loadingFiles.value = true
    const got = await Promise.all(
      missing.map((w) =>
        client
          .call('fs.tracked', { workspaceId: w.id })
          .catch(() => [] as string[])
          .then((files) => [w.id, files] as const),
      ),
    )
    const next = new Map(trackedFiles.value)
    for (const [id, files] of got) next.set(id, files)
    trackedFiles.value = next
    loadingFiles.value = false
  },
  { immediate: true },
)

let searchTimer: number | null = null
let searchSeq = 0
watch(
  [mode, term, level],
  () => {
    if (searchTimer) window.clearTimeout(searchTimer)
    if (mode.value !== 'text' || term.value.length < 2) {
      searchHits.value = []
      searching.value = false
      return
    }
    searchTimer = window.setTimeout(async () => {
      const seq = ++searchSeq
      searching.value = true
      // §12 — every repository of the scope at once, which is the point.
      const ids = scope.value.workspaces.map((w) => w.id)
      const r = await client.call('search.text', { workspaceIds: ids, query: term.value, max: 80 }).catch(() => null)
      // A slower answer to an older question must not replace a newer one.
      if (seq !== searchSeq) return
      searchHits.value = r?.hits ?? []
      searching.value = false
    }, 180)
  },
  { immediate: true },
)

/* ── keys ──────────────────────────────────────────────────────────── */

function move(delta: number) {
  const n = flat.value.length
  if (!n) return
  cursor.value = (cursor.value + delta + n) % n
  void nextTick(() => {
    document.querySelector('.pal .row.on')?.scrollIntoView({ block: 'nearest' })
  })
}

function run(item: Item) {
  const id = item.id.replace(/^recent:/, '')
  if (commands.value.some((c) => c.id === id) || item.id.startsWith('recent:')) rememberCommand(id)
  if (item.ask) {
    asking.value = item
    query.value = ''
    void nextTick(() => input.value?.focus())
    return
  }
  void item.run()
}

function choose() {
  if (asking.value) {
    const answer = query.value.trim()
    if (!answer) return
    const a = asking.value.ask!
    close()
    void a.run(answer)
    return
  }
  const item = flat.value[cursor.value]
  if (item) run(item)
}

/** Backspace on an empty answer backs out of the question. It never touches
 *  the scope: clearing what you typed is not asking to look somewhere else,
 *  and only ⇥ says that. */
function onBackspace(e: KeyboardEvent) {
  if (!asking.value || query.value !== '') return
  e.preventDefault()
  asking.value = null
}

/** Escape answers the innermost question: the one being asked, then the
 *  palette. Stopped here so the window's own Escape does not close past it. */
function onEscape(e: KeyboardEvent) {
  if (!asking.value) return
  e.stopPropagation()
  e.preventDefault()
  asking.value = null
  query.value = ''
}

function pickScope(l: Level) {
  level.value = l
  void nextTick(() => input.value?.focus())
}

/**
 * A path's two halves, each with its own share of the match highlighted. The
 * name is what you were looking for; the folder only tells two of them apart.
 */
function pathParts(label: string, positions: number[]) {
  const cut = label.lastIndexOf('/')
  if (cut < 0) return { name: highlight(label, positions), dir: [] }
  return {
    name: highlight(label.slice(cut + 1), positions.filter((p) => p > cut).map((p) => p - cut - 1)),
    dir: highlight(label.slice(0, cut), positions.filter((p) => p < cut)),
  }
}

function indexOfItem(item: Item): number {
  return flat.value.indexOf(item)
}

const emptyText = computed(() => {
  if (mode.value === 'text' && term.value.length < 2) return 'Type at least two characters.'
  if (mode.value === 'file' && loadingFiles.value) return 'Reading the file list…'
  if (mode.value === 'text' && searching.value) return 'Searching…'
  return scope.value.level === 'all' ? 'No match.' : 'Nothing in ' + where.value + '.'
})

onMounted(() => {
  void nextTick(() => input.value?.focus())
})
</script>

<template>
  <div class="scrim" @mousedown.self="close">
    <div class="pal" role="dialog" aria-label="Command palette">
      <div class="inputrow">
        <component :is="leadIcon" class="lead" />
        <span v-if="asking" class="asking">{{ asking.label }}</span>
        <input
          ref="input"
          v-model="query"
          class="q"
          spellcheck="false"
          :placeholder="placeholder"
          @keydown.down.prevent="move(1)"
          @keydown.up.prevent="move(-1)"
          @keydown.enter.prevent="choose"
          @keydown.tab.exact.prevent="stepScope(1)"
          @keydown.shift.tab.prevent="stepScope(-1)"
          @keydown.backspace="onBackspace"
          @keydown.esc="onEscape"
        />
        <RefreshCw v-if="searching || loadingFiles" class="busy spin sm" />
      </div>

      <div v-if="!asking" class="scopebar">
        <div class="scopes" role="tablist" aria-label="Where to search">
          <button
            v-for="s in scopes"
            :key="s.level"
            class="scope"
            role="tab"
            :aria-selected="s.level === scope.level"
            :class="{ on: s.level === scope.level }"
            :title="(s.level === 'all' ? 'Every project' : s.kind + ' — ' + s.name) + '  ⇥'"
            @mousedown.prevent
            @click="pickScope(s.level)"
          >
            <component :is="s.icon" class="sm" />
            <span class="sname">{{ s.name }}</span>
          </button>
        </div>
        <span class="grow" />
        <div class="modes">
          <button
            v-for="m in MODES"
            :key="m.mode"
            class="mode"
            :class="{ on: mode === m.mode }"
            :title="'Type ' + m.prefix + ' first'"
            @mousedown.prevent
            @click="toggleMode(m.mode)"
          >
            <span class="pfx">{{ m.prefix }}</span>{{ m.label }}
          </button>
        </div>
      </div>

      <div v-if="!asking" class="list">
        <div v-if="elsewhere" class="elsewhere">
          Nothing in {{ where }} — from everywhere instead.
          <button class="linkish" @mousedown.prevent @click="pickScope('all')">Search everywhere</button>
        </div>

        <template v-for="g in grouped" :key="g.group">
          <div class="glabel">{{ g.group }}</div>
          <button
            v-for="entry in g.items"
            :key="entry.item.id"
            class="row"
            :class="{ on: indexOfItem(entry.item) === cursor }"
            @mousemove="cursor = indexOfItem(entry.item)"
            @click="run(entry.item)"
          >
            <component :is="entry.item.icon" class="icon sm" />
            <span v-if="entry.item.path" class="lbl">
              <template v-for="parts in [pathParts(entry.item.label, entry.positions)]" :key="0">
                <span v-for="(part, i) in parts.name" :key="'n' + i" :class="{ hit: part.hit }">{{ part.text }}</span>
                <span v-if="parts.dir.length" class="dir">
                  <span v-for="(part, i) in parts.dir" :key="'d' + i" :class="{ hit: part.hit }">{{ part.text }}</span>
                </span>
              </template>
            </span>
            <span v-else class="lbl">
              <span
                v-for="(part, i) in highlight(entry.item.label, entry.positions)"
                :key="i"
                :class="{ hit: part.hit }"
                >{{ part.text }}</span
              >
            </span>
            <!-- The detail of a row is for the row you are on; ten of them at
                 once is the noise, not the information. -->
            <template v-if="indexOfItem(entry.item) === cursor || entry.item.always">
              <span v-if="entry.item.hint" class="hint">{{ entry.item.hint }}</span>
              <span v-if="entry.item.keys && indexOfItem(entry.item) === cursor" class="kbd">{{ entry.item.keys }}</span>
            </template>
          </button>
        </template>

        <div v-if="!flat.length" class="none">
          <span>{{ emptyText }}</span>
          <button
            v-if="scope.level !== 'all' && term && !searching && !loadingFiles"
            class="linkish"
            @mousedown.prevent
            @click="pickScope('all')"
          >
            Search everywhere <span class="kbd">⇥</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 12vh;
  background: var(--scrim);
  backdrop-filter: blur(6px) saturate(1.1);
  animation: fade var(--dur-2) var(--ease-soft);
}
@keyframes fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

.pal {
  width: min(680px, 92vw);
  max-height: 64vh;
  display: flex;
  flex-direction: column;
  background: var(--overlay);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg), var(--inset-top);
  overflow: hidden;
  animation: rise var(--dur-3) var(--ease);
}
@keyframes rise {
  from { opacity: 0; transform: translateY(-10px) scale(0.985); }
  to { opacity: 1; transform: none; }
}

.inputrow {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 18px;
  height: 54px;
}
/* A question being asked has no scope bar under it, so it draws its own edge. */
.inputrow:has(+ .list), .inputrow:last-child { border-bottom: 1px solid var(--line); }
.lead { flex: none; width: 18px; height: 18px; color: var(--text-dim); }
.busy { flex: none; color: var(--text-dim); }
.asking {
  flex: none;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-sm);
  font-weight: 560;
}
.q {
  flex: 1;
  min-width: 0;
  background: none;
  border: none;
  color: var(--text);
  font: inherit;
  font-size: var(--fs-lg);
  letter-spacing: -0.01em;
}
.q::placeholder { color: var(--text-dim); }
/* The palette input is the whole row; a ring around it would box in nothing. */
.q:focus-visible { outline: none; }

/* Where, on the left; what kind of thing, on the right. Part of the input's
   band rather than a band of its own — one rule under both, not two. */
.scopebar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  /* Room under the question before the answers' filters, so the two read as
     a prompt and its options rather than one crowded block. */
  margin-top: 6px;
  padding: 0 12px 10px;
  border-bottom: 1px solid var(--line);
}
.scopebar .grow { flex: 1; }
.scopes, .modes { display: flex; align-items: center; gap: 2px; min-width: 0; }
.scopes { overflow: hidden; }
.scope, .mode {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: var(--fs-xs);
  color: var(--text-dim);
  white-space: nowrap;
  transition: background var(--dur-1) var(--ease-soft), color var(--dur-1) var(--ease-soft);
}
.scope { min-width: 0; }
.scope svg { opacity: 0.8; }
.scope .sname { overflow: hidden; text-overflow: ellipsis; max-width: 160px; }
.scope:hover, .mode:hover { color: var(--text-muted); }
.scope.on { background: var(--accent-soft); color: var(--accent); }
.scope.on svg { opacity: 1; }
.mode.on { background: var(--hover); color: var(--text); }
.pfx { font-family: var(--mono); font-size: 11px; margin-right: 1px; opacity: 0.6; }

.list { flex: 1; overflow-y: auto; padding: 4px 8px 8px; }
.glabel {
  padding: 12px 10px 4px;
  font-size: var(--fs-xs);
  font-weight: 500;
  color: var(--text-dim);
}

.elsewhere {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 10px 2px;
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.linkish {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--accent);
  font-size: var(--fs-xs);
  font-weight: 540;
}
.linkish:hover { text-decoration: underline; }

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--text-muted);
}
.row.on { background: var(--selected); color: var(--text); }
.icon { flex: none; color: var(--text-dim); opacity: 0.8; }
.row.on .icon { color: var(--accent); opacity: 1; }
.lbl {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-md);
}
.lbl .hit { color: var(--text); font-weight: 600; }
.lbl .dir { margin-left: 8px; font-size: var(--fs-xs); color: var(--text-dim); }
.lbl .dir .hit { color: var(--text-muted); }
.row.on .lbl .hit { color: var(--accent); }
.hint {
  flex: none;
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.row .kbd { flex: none; }

.none {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 28px;
  text-align: center;
  color: var(--text-dim);
  font-size: var(--fs-sm);
}
</style>
