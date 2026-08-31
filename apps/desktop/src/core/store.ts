import { computed, reactive, ref, shallowRef } from 'vue'
import type {
  AddRepoSource, AgentScope, AgentScopePreview, Conversation, CockpitEvent, CockpitSettings,
  CommitPreview, CoreStatus, EngineOptions,
  DatabasePlan, Topic,
  NewProjectSource, PlanPreview, Project, SeedProposal, Workspace,
} from '@cockpit/shared'
import { CoreClient } from './client.js'
import type { ConnectionState } from './client.js'

/**
 * A thin reactive mirror of what the core pushes. It deliberately holds no
 * derived truth of its own: §3.4 applies to the UI too — if it is not in the
 * last push, it is not displayed.
 */

/** What the folder picker is being opened for — it is not always a project. */
export interface PickFolderOptions {
  title?: string
  message?: string
  buttonLabel?: string
  defaultPath?: string
}

/** §13 rule 1 — the whole of what the renderer may ask of its host. */
interface CockpitHost {
  corePort: number
  /** `process.platform`, so the window can draw what only macOS needs. */
  platform?: string
  /** Absolute path, or null when the user cancels. Absent outside Electron. */
  pickFolder?: (opts?: PickFolderOptions) => Promise<string | null>
  /** Brings a core back after one was stopped. Absent outside Electron. */
  restartCore?: () => Promise<boolean>
  /** The window's own three verbs, drawn by TrafficLights. Absent in a browser. */
  window?: { close: () => void; minimize: () => void; zoom: (alt: boolean) => void }
}

const host = (window as unknown as { cockpitHost?: CockpitHost }).cockpitHost

/**
 * The window chrome the app draws itself, and only where there is a window to
 * draw it for: absent in the browser dev server, and absent off macOS, where
 * the native frame is still there and still has its own buttons.
 */
export const hostWindow = host?.platform === 'darwin' ? (host.window ?? null) : null
const PORT = host?.corePort ?? 7717
const URL = 'ws://127.0.0.1:' + PORT

export type TabId = 'code' | 'diff' | 'agent' | 'memory' | 'journal' | 'terminal' | 'ticket'

/**
 * The four roles, in the order they are used.
 *
 *   1. navigate  — projects, repos, worktrees, branches: what you aim at
 *   2. agent     — the act, working on (1), with the memory as its tool
 *   3. review    — Diff, Code, Journal: reading what came out of (2)
 *   4. run       — the runtime and the terminal: seeing it work
 *
 * The Agent owns the panel permanently; these are what open beside it.
 */
export type ReviewTool = 'diff' | 'code' | 'journal' | 'terminal'


export const state = reactive({
  connection: 'connecting' as ConnectionState,
  connectionDetail: '' as string,
  projects: [] as Project[],
  workspaces: [] as Workspace[],
  topics: [] as Topic[],
  agents: [] as Conversation[],
  events: [] as CockpitEvent[],

  /**
   * §3.3 — the sentence being written right now, per conversation.
   *
   * Deliberately *not* in `events`: the journal is what the transcript derives
   * from, and a token is not something that happened. This is painted while it
   * arrives and thrown away the instant the durable `agent.output` lands with
   * the finished message, so the transcript never shows the same words twice.
   */
  deltas: {} as Record<string, { messageId: string; text: string }>,

  status: null as CoreStatus | null,

  activeProjectId: null as string | null,
  activeWorkspaceId: null as string | null,
  /**
   * §12 had six peer tabs, which flattened four different roles into one row:
   * the Agent is the act, Memory is its tool, Diff/Code/Journal are review
   * after the fact, and the runtime is how you see it run. So there is no
   * `activeTab` any more — there is what the agent is doing, and what you have
   * opened beside it.
   */
  /** Layer 3, as a fourth column. Closed by default: the chat gets the width. */
  reviewOpen: false,
  reviewTool: 'diff' as ReviewTool,
  /** §6 — the agent's own tool, over the conversation rather than beside it. */
  memoryOpen: false,
  /** Every conversation on this scope, over the chat rather than beside it. */
  historyOpen: false,

  /**
   * §7 — the scope the composer is aimed at, and the prompt being written for
   * it. Held here rather than in the tab so that going to the Diff to check
   * what changed does not throw away a half-written prompt.
   */
  agentScope: null as AgentScope | null,
  agentDraft: '',

  /**
   * How the engine is asked to run. Remembered here rather than on the
   * conversation: the window is where the choice is made, and passing it again
   * on resume keeps a thread on the model it was started with without adding a
   * column to a schema whose bump costs the user their history.
   */
  engineOptions: { model: 'opus', effort: 'high', plan: false } as EngineOptions & { plan: boolean },

  /**
   * §6 — what has been asked here before, newest first. `↑` in an empty
   * composer walks it, which is the cheapest possible way to re-run a prompt
   * with one word changed.
   */
  promptHistory: [] as string[],

  /** The start page. It owns the window on launch and whenever the mark is
   *  clicked; §12's "zero click" target starts from a search field, not from
   *  whatever workspace happened to be selected last session. */
  homeOpen: true,

  paletteOpen: false,
  /** §7 — the sheet that creates a project rather than finding one. */
  newProjectOpen: false,
  /** Which of the three sources it opens on — chosen on the start page (§12). */
  newProjectMode: 'scratch' as NewProjectSource['kind'],
  /** §7 — the sheet that adds a repository to a project that already exists. */
  addRepoProjectId: null as string | null,
  /** §15 — machine-local settings: the Dev folder, the editor. */
  settingsOpen: false,
  settings: null as CockpitSettings | null,
  /** Where projects already live, offered when no Dev folder is set. */
  suggestedDevRoot: null as string | null,
  /** The project whose settings sheet is open, by id. */
  editingProjectId: null as string | null,
  /** §4 — the sheet that opens a topic across N repositories. */
  topicDialogOpen: false,
  pendingPlan: null as PlanPreview | null,
  planBusy: false,
  toast: null as { kind: 'ok' | 'error' | 'info'; text: string } | null,
  theme: (localStorage.getItem('cockpit.theme') ?? 'system') as 'system' | 'dark' | 'light',
})

export const termOutput = shallowRef(new Map<string, string[]>())
const termListeners = new Map<string, ((d: string) => void)[]>()

export const client = new CoreClient(URL, {
  onState(s, detail) {
    state.connection = s
    state.connectionDetail = detail ?? ''
    // 'outdated' is a working connection, just an incomplete one: everything
    // that does exist should still load, and the banner explains the rest.
    if (s === 'connected' || s === 'outdated') void bootstrap()
  },
  onProjects(p) {
    state.projects = p
    ensureSelection()
  },
  onTopics(f) {
    state.topics = f
  },
  onWorkspaces(w) {
    state.workspaces = w
    ensureSelection()
  },
  onAgents(s) {
    state.agents = s
  },
  onAgentDelta(sessionId, messageId, text) {
    const cur = state.deltas[sessionId]
    // A new message replaces the last one rather than appending to it: two
    // messages in one turn is ordinary, and concatenating them would read as
    // one long garbled paragraph.
    if (!cur || cur.messageId !== messageId) state.deltas[sessionId] = { messageId, text }
    else cur.text += text
  },
  onEvent(e) {
    state.events.push(e)
    if (state.events.length > 800) state.events.splice(0, state.events.length - 800)
    // The finished message has landed, so the draft of it goes. Matching on
    // the id rather than clearing blindly: the next message may already be
    // streaming by the time this one is journalled.
    if (e.actor.kind === 'agent') {
      const sid = e.actor.sessionId
      const cur = state.deltas[sid]
      if (!cur) return
      if (e.type === 'agent.session_ended') delete state.deltas[sid]
      else if (e.type === 'agent.output') {
        const id = (e.payload as { messageId?: string | null })?.messageId
        if (!id || id === cur.messageId) delete state.deltas[sid]
      }
    }
  },
  onTerm(termId, data) {
    for (const fn of termListeners.get(termId) ?? []) fn(data)
  },
  onTermExit(termId) {
    for (const fn of termListeners.get(termId) ?? []) fn('\r\n\x1b[2m[process exited]\x1b[0m\r\n')
  },
})

export function onTermData(termId: string, fn: (d: string) => void): () => void {
  const arr = termListeners.get(termId) ?? []
  arr.push(fn)
  termListeners.set(termId, arr)
  return () => {
    const cur = termListeners.get(termId) ?? []
    termListeners.set(
      termId,
      cur.filter((f) => f !== fn),
    )
  }
}

async function bootstrap(): Promise<void> {
  const [projects, workspaces, topics, agents, events, status, config] = await Promise.all([
    client.call('project.list', undefined),
    client.call('workspace.list', {}),
    client.call('topic.list', { includeArchived: true }),
    client.call('agent.list', undefined),
    client.call('journal.tail', { limit: 300 }),
    client.call('core.status', undefined),
    // Tolerated on its own: a core older than this window answers
    // `unknown_method`, and losing the whole bootstrap over the Dev folder
    // would take the projects down with it.
    client.call('config.get', undefined).catch(() => null),
  ])
  state.projects = projects
  state.workspaces = workspaces
  state.topics = topics
  state.agents = agents
  state.events = events
  state.status = status
  if (config) {
    state.settings = config.settings
    state.suggestedDevRoot = config.suggestedDevRoot
  }
  ensureSelection()
}

function ensureSelection(): void {
  if (!state.projects.length) return
  if (!state.activeProjectId || !state.projects.some((p) => p.id === state.activeProjectId)) {
    state.activeProjectId = state.projects[0]!.id
  }
  const inProject = state.workspaces.filter((w) => w.projectId === state.activeProjectId)
  if (!state.activeWorkspaceId || !inProject.some((w) => w.id === state.activeWorkspaceId)) {
    state.activeWorkspaceId = inProject[0]?.id ?? null
  }
}

export const activeProject = computed(() => state.projects.find((p) => p.id === state.activeProjectId) ?? null)

export const activeWorkspace = computed(
  () => state.workspaces.find((w) => w.id === state.activeWorkspaceId) ?? null,
)

export const projectWorkspaces = computed(() =>
  state.workspaces.filter((w) => w.projectId === state.activeProjectId),
)

/**
 * The review tools this workspace has, in order — §3.9 drops the Diff on a
 * folder with no repository, and the strip must not draw a tool that would
 * open on nothing.
 */
export function reviewToolsFor(w: Workspace | null): ReviewTool[] {
  if (!w) return []
  const ids: ReviewTool[] = []
  if (w.git) ids.push('diff')
  ids.push('code', 'journal', 'terminal')
  return ids
}

export const reviewTools = computed(() => reviewToolsFor(activeWorkspace.value))

/**
 * What ⌘1..⌘n land on, and the only list they read — so a number can never
 * point at a tool this workspace does not have. ⌘1 is the Agent because the
 * Agent is what the window is for; the review tools follow it.
 */
export const keyTargets = computed<TabId[]>(() =>
  activeWorkspace.value ? ['agent', ...reviewTools.value] : [],
)

/**
 * The one way to say "show me X", from the palette, a keystroke or a badge.
 * Every layout's rules live here rather than in three components: `memory` is
 * the agent's tool and opens over the conversation, `agent` is the ground
 * state and closes whatever is on top of it, and the rest are review.
 */
export function goTo(id: TabId): void {
  if (id === 'agent') {
    state.reviewOpen = false
    state.memoryOpen = false
    return
  }
  if (id === 'memory') {
    state.memoryOpen = true
    return
  }
  if (id === 'ticket') return
  state.reviewTool = id
  state.reviewOpen = true
  state.memoryOpen = false
}



/** §12's "where am I" for the Agent: the sessions still running. */
export const liveSessions = computed(() =>
  state.agents.filter((s) => s.status !== 'ended' && s.status !== 'failed'),
)

/* ── agents (§7) ────────────────────────────────────────────────────────
 * The scope is the whole idea: a session says what it is *for* — a topic,
 * a project, one checkout, one folder — and the core turns that into the paths
 * the lease is taken on. What the window has to do is offer those four and
 * never the checkbox soup that came before, where "an agent on this topic"
 * and "an agent on this repo" were the same control with different boxes
 * ticked, and nothing afterwards could tell you which you had run.
 */

export function scopeKey(scope: AgentScope): string {
  switch (scope.kind) {
    case 'topic':
      return 'topic:' + scope.topicId
    case 'project':
      return 'project:' + scope.projectId
    case 'folder':
      return 'folder:' + scope.workspaceId + ':' + scope.subpath
    default:
      return 'workspace:' + scope.workspaceId
  }
}

export function sameScope(a: AgentScope | null, b: AgentScope | null): boolean {
  return !!a && !!b && scopeKey(a) === scopeKey(b)
}

/**
 * §7 — a chat is opened *on* something: a topic row, a workspace row, the
 * project. The scope is where you clicked, never a menu inside the agent —
 * picking it there meant navigating twice, once to the workspace and once
 * again to say which workspace you meant.
 */
export function openAgentOn(scope: AgentScope): void {
  // The panel still renders against a workspace, so the scope has to bring one
  // with it: the first it resolves to is the one you were pointing at.
  const w = anchorFor(scope)
  if (w) {
    state.activeWorkspaceId = w.id
    state.activeProjectId = w.projectId
  }
  state.agentScope = scope
  state.homeOpen = false
  state.memoryOpen = false
  state.historyOpen = false
  state.paletteOpen = false
}

function anchorFor(scope: AgentScope): Workspace | null {
  const real = (w: Workspace) => w.kind !== 'group'
  switch (scope.kind) {
    case 'topic':
      return state.workspaces.find((w) => w.topicId === scope.topicId && real(w)) ?? null
    case 'project':
      return (
        state.workspaces.find((w) => w.projectId === scope.projectId && w.kind === 'main') ??
        state.workspaces.find((w) => w.projectId === scope.projectId && real(w)) ??
        null
      )
    default:
      return state.workspaces.find((w) => w.id === scope.workspaceId) ?? null
  }
}

/** What to call the current scope in the agent's one line of chrome. */
export function scopeLabel(scope: AgentScope | null): { kind: string; name: string } {
  if (!scope) return { kind: '', name: '' }
  switch (scope.kind) {
    case 'topic':
      return {
        kind: 'Topic',
        name: state.topics.find((f) => f.id === scope.topicId)?.name ?? 'topic',
      }
    case 'project':
      return {
        kind: 'Project',
        name: state.projects.find((p) => p.id === scope.projectId)?.name ?? 'project',
      }
    case 'folder': {
      const w = state.workspaces.find((x) => x.id === scope.workspaceId)
      return { kind: 'Subfolder', name: (w?.name ?? '') + '/' + scope.subpath }
    }
    default: {
      const w = state.workspaces.find((x) => x.id === scope.workspaceId)
      // A checkout of a branch is a branch; a repository at its default
      // branch is the repository; anything with no git in it is just a folder.
      const kind = !w?.repo ? 'Folder' : w.kind === 'worktree' ? 'Branch' : 'Repository'
      return { kind, name: w?.name ?? '' }
    }
  }
}

/**
 * What the chat is aimed at: whatever was last opened on, and otherwise the
 * workspace that is selected — clicking a row in the list is itself a way of
 * saying "here", so the chat follows the selection when nothing narrower has
 * been asked for.
 */
export const activeAgentScope = computed<AgentScope | null>(() => {
  const chosen = state.agentScope
  const w = activeWorkspace.value
  if (chosen) {
    // A scope whose anchor is gone (topic closed, repo forgotten) would leave
    // the chat pointing at nothing; fall back to where we are standing.
    const stillThere =
      chosen.kind === 'topic'
        ? state.topics.some((f) => f.id === chosen.topicId)
        : chosen.kind === 'project'
          ? state.projects.some((p) => p.id === chosen.projectId)
          : state.workspaces.some((x) => x.id === chosen.workspaceId)
    if (stillThere) return chosen
  }
  return w ? { kind: 'workspace', workspaceId: w.id } : null
})

/**
 * §4 — the topic is a thing you can stand on, not only a header above its
 * rows. Selecting it *is* selecting its scope: the chat aims at the whole
 * topic, and the verbs that act on every worktree it spans move up into the
 * title band, where the workspace verbs already live.
 *
 * Read from `state.agentScope` rather than `activeAgentScope`: the fallback
 * there resolves to a workspace, and the list has to know that nothing narrower
 * than the topic is selected.
 */
export const selectedTopicId = computed(() =>
  state.agentScope?.kind === 'topic' ? state.agentScope.topicId : null,
)

/** §7 — what a scope would do, before it is asked to do it. */
export async function previewScope(scope: AgentScope): Promise<AgentScopePreview | null> {
  try {
    return await client.call('agent.preview', { scope })
  } catch {
    // A core that does not speak this yet is not an error worth a toast: the
    // composer simply shows no preview and the start call still answers.
    return null
  }
}

/** Every conversation ever run against this exact scope, newest first. */
export function sessionsForScope(scope: AgentScope | null): Conversation[] {
  if (!scope) return []
  const key = scopeKey(scope)
  return state.agents.filter((s) => scopeKey(s.scope) === key)
}

export async function startAgentIn(
  engine: string,
  scope: AgentScope,
  prompt: string,
): Promise<boolean> {
  const res = await guard(() =>
    client.call('agent.start', { engine, scope, prompt, options: engineOptions() }),
  )
  if (!res) return false
  if ('denied' in res) {
    // §7 — a refusal explains itself; a silent no is worse than a blocked run.
    toast('error', res.reason)
    return false
  }
  rememberPrompt(prompt)
  state.agentDraft = ''
  // The thread that was just opened is the one to land in, and the panel must
  // still be on it after a detour through three other projects (§6).
  pinThread(scope, res.sessionId)
  // §4 — say that the anchor exists, or capturing it was pointless.
  toast(
    'ok',
    res.restorePoints.length
      ? 'session started · restore point ' + res.restorePoints[0]!.head.slice(0, 8)
      : 'session started',
  )
  return true
}

/* ── which conversation is open, and which are waiting (§6) ─────────────
 *
 * A conversation used to be selected in a local ref inside the panel, so
 * looking at another project and coming back destroyed the selection: the work
 * was still running, and the panel was back on its empty composer as though
 * nothing had ever been asked. Leaving a scope is not closing a thread. Which
 * one is open is a property of the scope, it survives the detour, and it
 * survives the window being closed.
 *
 * Three facts, and only the first is a preference:
 *   pinned — the thread chosen by hand, out of the history
 *   closed — the threads deliberately put away with the ✕
 *   read   — how far into a finished thread the person has actually got
 */
const THREADS_KEY = 'cockpit.threads'

interface ThreadMemory {
  /** scopeKey → session id, chosen by hand and kept until it is closed. */
  pinned: Record<string, string>
  /** session id → put away. The one thing that stops it re-opening. */
  closed: Record<string, true>
  /** session id → the `endedAt` that has been read. */
  read: Record<string, number>
  /**
   * When this window first learned to track any of the above. Every
   * conversation that ended before it counts as read — otherwise switching to
   * a build that has this would light up every project in the rail at once
   * over work finished weeks ago.
   */
  since: number
}

export const threads = reactive<ThreadMemory>(readThreads())

function readThreads(): ThreadMemory {
  const empty: ThreadMemory = { pinned: {}, closed: {}, read: {}, since: Date.now() }
  try {
    const raw = JSON.parse(localStorage.getItem(THREADS_KEY) ?? 'null') as Partial<ThreadMemory> | null
    if (!raw || typeof raw !== 'object') return empty
    return {
      pinned: raw.pinned ?? {},
      closed: raw.closed ?? {},
      read: raw.read ?? {},
      since: typeof raw.since === 'number' ? raw.since : empty.since,
    }
  } catch {
    return empty
  }
}

function saveThreads(): void {
  localStorage.setItem(THREADS_KEY, JSON.stringify(threads))
}

/* ── how wide the columns are ─────────────────────────────────────────── */

const LAYOUT_KEY = 'cockpit.layout'

/**
 * §12's three columns, with their widths handed back to the user.
 *
 * They were constants in `tokens.css` — the right default, the wrong final
 * answer: how much room the list needs against the conversation is a property
 * of the work rather than of the app. A project of twenty branches wants a
 * wide list; reading a long diff wants a wide review; neither wants the other.
 *
 * The rail is not in here. It holds one column of icons and has one correct
 * width, so a handle on it would offer a choice with no good answers.
 */
export const LAYOUT_LIMITS = {
  /** Below 200 the branch names ellipsis away and the list stops being one. */
  list: { min: 200, max: 620 },
  /**
   * 440 — the shipped default — is the least a side-by-side diff hunk fits in
   * without wrapping every line. The floor is lower than that on purpose:
   * under 620 the review stacks its list above its viewer (a container query
   * in ReviewTools), and stacked, a narrow column is a deliberate choice
   * rather than a broken one.
   */
  review: { min: 320, max: 900 },
}

/** What a fresh install starts from, and what a double-click goes back to. */
export const LAYOUT_DEFAULTS = { list: 340, review: 440 }

export const layout = reactive(readLayout())

function readLayout(): { list: number; review: number } {
  const fallback = { ...LAYOUT_DEFAULTS }
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null') as Partial<typeof fallback> | null
    if (!raw) return fallback
    return {
      list: clampTo(raw.list ?? fallback.list, LAYOUT_LIMITS.list),
      review: clampTo(raw.review ?? fallback.review, LAYOUT_LIMITS.review),
    }
  } catch {
    return fallback
  }
}

function clampTo(n: number, l: { min: number; max: number }): number {
  return Number.isFinite(n) ? Math.min(l.max, Math.max(l.min, Math.round(n))) : l.min
}

/** Live during a drag; only written to disk when the pointer is let go. */
export function setColumnWidth(which: 'list' | 'review', px: number): void {
  layout[which] = clampTo(px, LAYOUT_LIMITS[which])
}

export function saveLayout(): void {
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
}

/** Double-clicking a divider: back to the width the app shipped with. */
export function resetColumnWidth(which: 'list' | 'review'): void {
  layout[which] = LAYOUT_DEFAULTS[which]
  saveLayout()
}

/* ── which topics are folded away ─────────────────────────────────────── */

const COLLAPSED_KEY = 'cockpit.collapsed'

/**
 * §4 — a topic groups the branches of one piece of work, and a project with
 * four of them in flight is four headers and a dozen rows before the one being
 * looked for. Folding a topic away is how the list stays a list.
 *
 * Persisted, because a fold is a statement about what you are not working on
 * today, and having to repeat it every launch would make it not worth making.
 */
export const collapsedTopics = reactive<Record<string, true>>(readCollapsed())

function readCollapsed(): Record<string, true> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '{}') as Record<string, true>
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

export function toggleTopicCollapsed(topicId: string): void {
  if (collapsedTopics[topicId]) delete collapsedTopics[topicId]
  else collapsedTopics[topicId] = true
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsedTopics))
}

/* ── the composer's own memory ────────────────────────────────────────── */

const COMPOSER_KEY = 'cockpit.composer'
const HISTORY_MAX = 60

/**
 * The model, the effort, and the last few things asked. Restored before the
 * first paint so the composer never flashes a default the user replaced weeks
 * ago. Plan mode is deliberately *not* restored: it is a posture for one piece
 * of work, and inheriting it silently is how a session that was meant to write
 * quietly does nothing.
 */
function loadComposer(): void {
  try {
    const raw = JSON.parse(localStorage.getItem(COMPOSER_KEY) ?? 'null') as {
      model?: string
      effort?: string
      history?: string[]
    } | null
    if (!raw) return
    if (raw.model) state.engineOptions.model = raw.model
    if (raw.effort) state.engineOptions.effort = raw.effort
    if (Array.isArray(raw.history)) state.promptHistory = raw.history.filter((x) => typeof x === 'string')
  } catch {
    /* a corrupt entry is a default, not a crash */
  }
}

export function saveComposer(): void {
  localStorage.setItem(
    COMPOSER_KEY,
    JSON.stringify({
      model: state.engineOptions.model,
      effort: state.engineOptions.effort,
      history: state.promptHistory.slice(0, HISTORY_MAX),
    }),
  )
}

/** Newest first, and never the same prompt twice in a row. */
export function rememberPrompt(text: string): void {
  const t = text.trim()
  if (!t) return
  state.promptHistory = [t, ...state.promptHistory.filter((x) => x !== t)].slice(0, HISTORY_MAX)
  saveComposer()
}

loadComposer()

/** Still running, whatever it is doing — the only thing a spinner is about. */
export function isRunning(c: Conversation): boolean {
  return c.status !== 'ended' && c.status !== 'failed'
}

/**
 * Why a finished conversation is still asking for a person.
 *
 *   blocked — the allow-list refused a tool, so it stopped short of the job
 *   failed  — the engine died
 *   reply   — it answered, and the answer has not been read
 *
 * A running conversation is never in any of these: it is working, not waiting.
 */
export type Attention = 'none' | 'reply' | 'blocked' | 'failed'

export function attentionOf(c: Conversation): Attention {
  if (isRunning(c)) return 'none'
  const at = c.endedAt ?? c.startedAt
  if (at < threads.since) return 'none'
  if ((threads.read[c.id] ?? 0) >= at) return 'none'
  if (c.status === 'failed') return 'failed'
  if (c.denials.length) return 'blocked'
  return 'reply'
}

const ATTENTION_RANK: Record<Attention, number> = { none: 0, reply: 1, blocked: 2, failed: 3 }

/** What a badge somewhere in the shell has to say about one thing. */
export interface AgentActivity {
  running: number
  waiting: number
  /** The loudest of the waiting ones, which is the colour the badge takes. */
  attention: Attention
}

const NO_ACTIVITY: AgentActivity = { running: 0, waiting: 0, attention: 'none' }

/**
 * §12's "where am I", answered for everything the shell draws at once: the
 * project tiles in the rail, the topic headers and the rows in the list.
 *
 * Built from `state.agents` rather than from `Workspace.agentSessions`, for
 * two reasons: that array only covers running sessions, and a conversation
 * waiting to be read is exactly the thing this is for; and it says nothing
 * about the scope, so a topic-wide conversation could never light its own
 * header.
 */
export const agentActivity = computed(() => {
  const map = new Map<string, AgentActivity>()
  const bump = (key: string, running: boolean, att: Attention) => {
    const a = map.get(key) ?? { running: 0, waiting: 0, attention: 'none' as Attention }
    if (running) a.running++
    if (att !== 'none') {
      a.waiting++
      if (ATTENTION_RANK[att] > ATTENTION_RANK[a.attention]) a.attention = att
    }
    map.set(key, a)
  }

  for (const c of state.agents) {
    const running = isRunning(c)
    const att = attentionOf(c)
    if (!running && att === 'none') continue

    // A conversation lights every level it belongs to: the checkouts it can
    // write in, the topic those sit under, and the project holding them.
    const keys = new Set<string>()
    if (c.scope.kind === 'topic') keys.add('topic:' + c.scope.topicId)
    if (c.scope.kind === 'project') keys.add('project:' + c.scope.projectId)
    if (c.topicId) keys.add('topic:' + c.topicId)
    for (const id of c.workspaceIds) {
      keys.add('workspace:' + id)
      const w = state.workspaces.find((x) => x.id === id)
      if (!w) continue
      keys.add('project:' + w.projectId)
      if (w.topicId) keys.add('topic:' + w.topicId)
    }
    for (const k of keys) bump(k, running, att)
  }
  return map
})

export function activityFor(kind: 'workspace' | 'topic' | 'project', id: string): AgentActivity {
  return agentActivity.value.get(kind + ':' + id) ?? NO_ACTIVITY
}

/**
 * The conversation the panel should be showing on this scope.
 *
 * Nothing here is a guess about what the person wants next: it is what they
 * left open. A thread runs until it is put away — and one still running comes
 * back first, because that is the one there is news about.
 */
export function openThreadFor(scope: AgentScope | null): Conversation | null {
  if (!scope) return null
  const all = [...sessionsForScope(scope)].sort((a, b) => b.startedAt - a.startedAt)
  const pinned = all.find((c) => c.id === threads.pinned[scopeKey(scope)])
  if (pinned) return pinned
  const open = all.filter((c) => !threads.closed[c.id])
  return open.find(isRunning) ?? open[0] ?? null
}

/** Opening one out of the history, which also takes it back out of the bin. */
export function pinThread(scope: AgentScope, sessionId: string): void {
  threads.pinned[scopeKey(scope)] = sessionId
  delete threads.closed[sessionId]
  saveThreads()
}

/**
 * The ✕ on a thread. Deliberate, and therefore respected even for a session
 * still running: the conversation carries on, this window simply stops leading
 * with it, and the badges still say it is there.
 */
export function closeThread(scope: AgentScope, sessionId: string): void {
  if (threads.pinned[scopeKey(scope)] === sessionId) delete threads.pinned[scopeKey(scope)]
  threads.closed[sessionId] = true
  saveThreads()
}

/** Having it on screen is having read it; there is no second "mark as read". */
export function markThreadRead(c: Conversation): void {
  if (isRunning(c)) return
  const at = c.endedAt ?? c.startedAt
  if ((threads.read[c.id] ?? 0) >= at) return
  threads.read[c.id] = at
  saveThreads()
}


/**
 * §12 — "La liste centrale liste des workspaces, groupés par topic quand une
 * topic existe." A bare workspace and a group of three sit side by side; the
 * grouping is never forced.
 */
export interface ListGroup {
  topicId: string | null
  title: string | null
  topic: Topic | null
  workspaces: Workspace[]
}

export const workspaceGroups = computed<ListGroup[]>(() => {
  const groups: ListGroup[] = []
  const loose: Workspace[] = []
  const byTopic = new Map<string, Workspace[]>()

  for (const w of projectWorkspaces.value) {
    if (w.kind === 'group') continue
    if (w.topicId) {
      const arr = byTopic.get(w.topicId) ?? []
      arr.push(w)
      byTopic.set(w.topicId, arr)
    } else {
      loose.push(w)
    }
  }

  for (const [fid, ws] of byTopic) {
    const topic = state.topics.find((f) => f.id === fid) ?? null
    groups.push({ topicId: fid, title: topic?.name ?? ws[0]?.name ?? '', topic, workspaces: ws })
  }
  groups.sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''))

  if (loose.length) groups.push({ topicId: null, title: null, topic: null, workspaces: loose })
  return groups
})

/** The topic standing selected, with the rows it spans — null unless one is. */
export const selectedTopicGroup = computed<ListGroup | null>(() => {
  const id = selectedTopicId.value
  return id ? (workspaceGroups.value.find((g) => g.topicId === id) ?? null) : null
})

/** §5 — asking whether a capability exists is how the UI decides to render
 *  anything at all. Absent means the control is not drawn (§3.9). */
export function has(w: Workspace | null, cap: string): boolean {
  return !!w?.capabilities.some((c) => c.id === cap)
}

export function toast(kind: 'ok' | 'error' | 'info', text: string): void {
  state.toast = { kind, text }
  window.setTimeout(() => {
    if (state.toast?.text === text) state.toast = null
  }, 4200)
}

export async function guard<T>(fn: () => Promise<T>, okMessage?: string): Promise<T | null> {
  try {
    const r = await fn()
    if (okMessage) toast('ok', okMessage)
    return r
  } catch (e) {
    toast('error', e instanceof Error ? e.message : String(e))
    return null
  }
}

/**
 * §13 rule 1 — the renderer never resolves a path itself: the host opens the
 * dialog, the core decides what the folder turns out to be. Electron has no
 * `window.prompt`, so the fallback exists only for the browser dev server.
 */
export async function pickFolder(opts: PickFolderOptions = {}): Promise<string | null> {
  if (host?.pickFolder) return host.pickFolder(opts)
  return window.prompt(opts.message ?? 'Path of the folder', opts.defaultPath ?? '')
}

/**
 * §7 — creating a project is a sheet, not a folder picker (see
 * NewProjectDialog). Which of the three sources it opens on is chosen before
 * the sheet, on the start page, so the first click already says something.
 */
export function newProject(mode: NewProjectSource['kind'] = 'scratch'): void {
  state.newProjectMode = mode
  state.newProjectOpen = true
}

/** Selects what was just created; the rail itself arrives by broadcast. */
async function selectCreatedProject(id: string): Promise<void> {
  await refreshProjects()
  state.activeProjectId = id
  state.activeWorkspaceId = null
  ensureSelection()
}

/**
 * §12 — switching project switches what the window is about, and the selected
 * workspace is half of that.
 *
 * Assigning the id on its own is the bug it exists to prevent: the previous
 * project's workspace stays selected, so the title bar reads
 * `<new project> / <old repository>` and the panel under it shows the old
 * repository's files — until the next push from the core happens to run
 * `ensureSelection` and snap the selection somewhere else, which makes it look
 * intermittent rather than wrong.
 *
 * Where it lands: the last workspace touched in that project, so coming back
 * to one resumes it rather than restarting it; failing that, its first.
 */
export function selectProject(id: string): void {
  state.activeProjectId = id
  const inProject = state.workspaces.filter((w) => w.projectId === id)
  const last = recentIds.value.find((rid) => inProject.some((w) => w.id === rid))
  state.activeWorkspaceId = last ?? inProject[0]?.id ?? null
}

export async function createProject(input: {
  name: string
  parent: string
  source: NewProjectSource
}): Promise<boolean> {
  const created = await guard(() => client.call('project.create', input), 'project created')
  if (!created) return false
  state.newProjectOpen = false
  await selectCreatedProject(created.id)
  // The Dev folder is set the first time one is used, so the second project
  // never asks the question again.
  if (input.source.kind !== 'folder' && !state.settings?.devRoot) {
    await saveSettings({ devRoot: input.parent })
  }
  return true
}

/**
 * §7 — a repository joining a project that already exists, which is the half
 * of the layout that keeps being true after the project is created. Addressed
 * by project id rather than a boolean: the list, the palette and the project
 * sheet all open it, and each of them already knows which project it means.
 */
export function addRepoTo(projectId: string | null = state.activeProjectId): void {
  if (projectId) state.addRepoProjectId = projectId
}

export const addingRepoTo = computed(
  () => state.projects.find((p) => p.id === state.addRepoProjectId) ?? null,
)

export async function addRepo(input: {
  projectId: string
  source: AddRepoSource
  wrapRootAs?: string | null
}): Promise<boolean> {
  const r = await guard(() => client.call('project.addRepo', input))
  if (!r) return false
  state.addRepoProjectId = null
  toast('ok', r.wrapped ? 'repository added; the first one moved into ' + r.wrapped + '/' : 'repository added')
  // The commit is the one failure worth surviving: the repository is real
  // either way, and a missing user.email is not this sheet's problem to solve.
  if (r.note) toast('info', 'the first commit failed — ' + r.note)
  await refreshProjects()
  const added = state.workspaces.find((w) => w.path === r.repoPath)
  if (added) selectWorkspace(added.id)
  return true
}

/* ── settings ──────────────────────────────────────────────────────────
 * §15 — machine-local, and small on purpose: what lives here is what the
 * repository has no business knowing.
 */

export async function loadSettings(): Promise<void> {
  const view = await guard(() => client.call('config.get', undefined))
  if (!view) return
  state.settings = view.settings
  state.suggestedDevRoot = view.suggestedDevRoot
}

export async function saveSettings(patch: Partial<CockpitSettings>): Promise<boolean> {
  const view = await guard(() => client.call('config.set', patch))
  if (!view) return false
  state.settings = view.settings
  state.suggestedDevRoot = view.suggestedDevRoot
  return true
}

/** Where a new project would go: the Dev folder, or what the projects suggest. */
export const devRoot = computed(() => state.settings?.devRoot ?? state.suggestedDevRoot ?? '')

export const editingProject = computed(
  () => state.projects.find((p) => p.id === state.editingProjectId) ?? null,
)

/**
 * A project's id is derived from its path, so moving one replaces it rather
 * than mutating it: the old id stops existing and everything selected under it
 * has to follow to the new one.
 */
export async function moveProject(
  projectId: string,
  root: string,
  moveFiles: boolean,
): Promise<boolean> {
  const next = await guard(
    () => client.call('project.move', { projectId, root, moveFiles }),
    moveFiles ? 'project moved' : 'project re-pointed',
  )
  if (!next) return false
  state.activeProjectId = next.id
  state.activeWorkspaceId = null
  state.editingProjectId = next.id
  await refreshProjects()
  return true
}

export async function renameProject(projectId: string, name: string | null): Promise<boolean> {
  const next = await guard(() => client.call('project.rename', { projectId, name }), 'project renamed')
  if (!next) return false
  await refreshProjects()
  return true
}

/** Untrack: Cockpit forgets it, the folder stays exactly where it is. */
export async function forgetProject(projectId: string): Promise<boolean> {
  const ok = await guard(() => client.call('project.forget', { projectId }), 'project untracked')
  if (!ok) return false
  dropSelection(projectId)
  await refreshProjects()
  return true
}

/** The only action in the app that touches the source tree — and it goes to Trash. */
export async function trashProject(projectId: string): Promise<boolean> {
  const res = await guard(() => client.call('project.trash', { projectId }), 'moved to Trash')
  if (!res) return false
  dropSelection(projectId)
  await refreshProjects()
  return true
}

function dropSelection(projectId: string): void {
  state.editingProjectId = null
  if (state.activeProjectId === projectId) {
    state.activeProjectId = null
    state.activeWorkspaceId = null
  }
}

async function refreshProjects(): Promise<void> {
  const [projects, workspaces] = await Promise.all([
    client.call('project.list', undefined),
    client.call('workspace.list', {}),
  ])
  state.projects = projects
  state.workspaces = workspaces
  ensureSelection()
}

export function selectWorkspace(id: string): void {
  state.activeWorkspaceId = id
  // Clicking a row is saying "this one", so a scope wider than the row — the
  // topic it sits under, the project — stops being the answer. Dropping it
  // lets activeAgentScope fall back to this workspace; a folder scope inside
  // it is narrower than the click, and survives.
  const scope = state.agentScope
  if (scope && (scope.kind === 'topic' || scope.kind === 'project')) state.agentScope = null
  const w = state.workspaces.find((x) => x.id === id)
  if (w && w.projectId !== state.activeProjectId) state.activeProjectId = w.projectId
  remember(id)
  state.homeOpen = false
}

/* ── the start page ────────────────────────────────────────────────────
 * Recency is the one thing the start page needs that the core does not
 * store: it is a property of this machine's habits, not of the projects.
 * Ids only, so a workspace that disappears simply drops out of the list.
 */
const RECENT_KEY = 'cockpit.recent'
const RECENT_MAX = 8

export const recentIds = ref<string[]>(readRecent())

function readRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function remember(id: string): void {
  const next = [id, ...recentIds.value.filter((x) => x !== id)].slice(0, RECENT_MAX)
  recentIds.value = next
  localStorage.setItem(RECENT_KEY, JSON.stringify(next))
}

/** The recent list, resolved against what actually exists right now. */
export const recentWorkspaces = computed<Workspace[]>(() =>
  recentIds.value
    .map((id) => state.workspaces.find((w) => w.id === id))
    .filter((w): w is Workspace => !!w && w.kind !== 'group'),
)

export function openHome(): void {
  state.homeOpen = true
  state.paletteOpen = false
}

/** Leaving the start page needs somewhere to go; with no project there is not. */
export const canLeaveHome = computed(() => state.projects.length > 0)

export function closeHome(): void {
  if (canLeaveHome.value) state.homeOpen = false
}

export function applyTheme(): void {
  const el = document.documentElement
  if (state.theme === 'system') el.removeAttribute('data-theme')
  else el.setAttribute('data-theme', state.theme)
  localStorage.setItem('cockpit.theme', state.theme)
}

export function cycleTheme(): void {
  state.theme = state.theme === 'system' ? 'dark' : state.theme === 'dark' ? 'light' : 'system'
  applyTheme()
}

/** §3.7 — no git operation runs without its plan being shown first. */
export async function requestPlan(
  workspaceId: string,
  operation: 'rebase' | 'merge' | 'branch' | 'worktree' | 'push' | 'sync',
  args: Record<string, string> = {},
): Promise<void> {
  const plan = await guard(() => client.call('git.plan', { workspaceId, operation, args }))
  if (plan) state.pendingPlan = plan
}

export async function applyPendingPlan(): Promise<void> {
  const plan = state.pendingPlan
  if (!plan) return
  state.planBusy = true
  const res = await guard(() => client.call('git.apply', { planId: plan.planId }))
  state.planBusy = false
  state.pendingPlan = null
  if (!res) return
  // The topic row is written by the plan's own apply hook, so the list is
  // only true again once that has run.
  await refreshTopics()

  // §3.7 — a conflict is where the plan stopped, not how it failed. Selecting
  // the repository that stopped is the whole handover: the conflict panel is
  // attached to the workspace, so the next thing on screen is what to do.
  if (res.conflict) {
    if (res.conflict.workspaceId) state.activeWorkspaceId = res.conflict.workspaceId
    toast('info', res.conflict.repo + ': ' + res.conflict.kind + ' stopped on a conflict — resolve it below')
    return
  }
  if (!res.ok) {
    toast(
      'error',
      plan.onFailure === 'halt'
        ? 'stopped — what already succeeded was kept; see the journal'
        : 'stopped — nothing was left behind; see the journal',
    )
    return
  }
  toast('ok', plan.operation + ' applied')
}

/* ── commit and land ─────────────────────────────────────────────────────
 * §16 — "revue humaine du diff avant tout commit". The review is the Diff
 * tab, so the commit lives there too; and §4 — landing is one act across
 * every repository the topic spans, like opening and rebasing it.
 */

export async function commitPreview(
  topicId: string | null,
  workspaceId: string,
  all: boolean,
): Promise<CommitPreview[]> {
  try {
    return await client.call('git.commitPreview', {
      ...(topicId ? { topicId } : { workspaceIds: [workspaceId] }),
      all,
    })
  } catch {
    // A core older than this window has no such method; the Diff tab still
    // shows the diff, which is the part that matters.
    return []
  }
}

export async function commit(
  topicId: string | null,
  workspaceId: string,
  message: string,
  all: boolean,
): Promise<boolean> {
  const res = await guard(() =>
    client.call('git.commit', {
      ...(topicId ? { topicId } : { workspaceIds: [workspaceId] }),
      message,
      all,
    }),
  )
  if (!res) return false
  if (!res.ok || !res.plan) {
    toast('error', res.detail)
    return false
  }
  state.pendingPlan = res.plan
  return true
}

/**
 * §4 — the step the lifecycle was missing. The topic branch goes onto the
 * base in each repository's main checkout, as one `--no-ff` merge.
 */
export async function mergeTopic(topicId: string, push: boolean): Promise<void> {
  const res = await guard(() => client.call('topic.merge', { topicId, push }))
  if (!res) return
  if (!res.ok || !res.plan) {
    toast('error', res.detail)
    return
  }
  state.pendingPlan = res.plan
}

/* ── conflicts ───────────────────────────────────────────────────────────
 * §3.7 — the state a stopped rebase leaves behind, and the three verbs that
 * end it. Nothing is cached here: `git.operation` rides along on every
 * workspace push, and the core re-probes on every file change — so a conflict
 * resolved in the IDE updates this panel without anyone asking it to.
 */

export const activeConflict = computed(() => activeWorkspace.value?.git?.operation ?? null)

/** Every workspace mid-operation, so a topic-wide rebase can be picked up
 *  from whichever repository the user is looking at. */
export const conflictedWorkspaces = computed(() =>
  state.workspaces.filter((w) => w.projectId === state.activeProjectId && w.git?.operation),
)

export const conflictBusy = ref(false)

export async function resolveConflict(action: 'continue' | 'abort' | 'skip'): Promise<void> {
  const w = activeWorkspace.value
  if (!w || conflictBusy.value) return
  conflictBusy.value = true
  const res = await guard(() => client.call('git.resolve', { workspaceId: w.id, action }))
  conflictBusy.value = false
  if (!res) return
  toast(res.ok ? 'ok' : 'error', res.detail)
}

/** The escape hatch for a file whose content is *meant* to contain markers. */
export async function markResolved(paths: string[]): Promise<void> {
  const w = activeWorkspace.value
  if (!w || !paths.length || conflictBusy.value) return
  conflictBusy.value = true
  const res = await guard(() => client.call('git.stage', { workspaceId: w.id, paths }))
  conflictBusy.value = false
  if (res && !res.ok) toast('error', res.detail)
}

/** Opens one conflicted file where it can actually be fixed (§2). */
export async function openConflictFile(path: string): Promise<void> {
  const w = activeWorkspace.value
  if (!w) return
  await guard(() => client.call('workspace.openIn', { workspaceId: w.id, target: 'ide', path }))
}

/**
 * §4 — catching a topic up is one act across every repository it spans.
 * It stops at the first conflict and keeps what already replayed; running it
 * again after resolving picks up the rest, because a branch already rebased
 * costs only a fetch.
 */
export async function rebaseTopic(topicId: string): Promise<void> {
  const res = await guard(() => client.call('topic.rebase', { topicId }))
  if (!res) return
  if (!res.ok || !res.plan) {
    toast('error', res.detail)
    return
  }
  state.pendingPlan = res.plan
}

/* ── topics ────────────────────────────────────────────────────────────
 * §4 — the durable unit of work. Everything here is a thin call: the core
 * decides what is possible, the window only asks.
 */

export async function refreshTopics(): Promise<void> {
  const [topics, workspaces] = await Promise.all([
    // Closed ones included: you cannot reopen or delete what is not listed.
    client.call('topic.list', { includeArchived: true }),
    client.call('workspace.list', {}),
  ])
  state.topics = topics
  state.workspaces = workspaces
  ensureSelection()
}

export const projectTopics = computed(() =>
  state.topics.filter((f) => f.projectId === state.activeProjectId && f.state !== 'closed'),
)

export const liveTopic = computed(() => projectTopics.value.find((f) => f.state === 'running') ?? null)

/** Closed, but still on record — reopenable, and deletable. */
export const archivedTopics = computed(() =>
  state.topics.filter((f) => f.projectId === state.activeProjectId && f.state === 'closed'),
)

export async function reopenTopic(topicId: string): Promise<void> {
  const res = await guard(() => client.call('topic.reopen', { topicId }))
  if (!res) return
  if (!res.ok) {
    toast('error', res.detail)
    return
  }
  await refreshTopics()
  toast('ok', res.detail)
}

/**
 * §16 — every refusal below is a refusal to lose work, so the confirmations
 * are not setup. Unmerged commits are the only thing `force` unlocks,
 * because they are the only thing nothing can bring back.
 */
export async function deleteTopic(
  topicId: string,
  opts: { removeWorktrees: boolean; deleteBranches: boolean },
): Promise<void> {
  const f = state.topics.find((x) => x.id === topicId)
  const run = (force: boolean) =>
    guard(() => client.call('topic.delete', { topicId, ...opts, force }))

  let res = await run(false)
  if (!res) return

  if (!res.ok) {
    // Only the unmerged-branch refusal is forceable; anything else is a state
    // to fix, not a prompt to click through.
    if (!/UNMERGED|not merged/i.test(res.detail)) {
      toast('error', res.detail)
      return
    }
    if (!window.confirm(res.detail + '\n\nDelete anyway? This cannot be undone.')) return
    res = await run(true)
    if (!res?.ok) {
      if (res) toast('error', res.detail)
      return
    }
  }

  if (res.plan) {
    const lines = [
      'Delete "' + (f?.name ?? 'this topic') + '" for good?',
      '',
      ...res.warnings.map((w) => '• ' + w),
    ]
    if (!window.confirm(lines.join('\n'))) return
    state.pendingPlan = res.plan
    return
  }
  await refreshTopics()
  toast('ok', res.detail)
}

/**
 * §7 — what a new worktree will be missing, before it is created.
 *
 * Tolerated on its own: a core older than this window answers `unknown_method`,
 * and losing the whole topic sheet over the seed section would be worse than
 * showing it without one.
 */
export async function previewSeed(
  slug: string,
  repoWorkspaceIds: string[],
): Promise<SeedProposal[]> {
  if (!state.activeProjectId || !slug) return []
  try {
    return await client.call('worktree.seedPreview', {
      projectId: state.activeProjectId,
      repoWorkspaceIds,
      slug,
    })
  } catch {
    return []
  }
}

/** §10 — what giving each worktree its own database would involve. */
export async function previewDatabase(
  slug: string,
  repoWorkspaceIds: string[],
): Promise<DatabasePlan[]> {
  if (!state.activeProjectId || !slug) return []
  try {
    return await client.call('database.preview', {
      projectId: state.activeProjectId,
      repoWorkspaceIds,
      slug,
    })
  } catch {
    return []
  }
}

/** §3.7 — opening a topic is a plan like any other: previewed, then applied. */
export async function openTopic(input: {
  name: string
  setup: 'branch' | 'isolated' | 'full'
  repoWorkspaceIds?: string[]
  base?: string
  seed?: SeedProposal[]
  rememberSeed?: boolean
  cloneDatabase?: boolean
}): Promise<void> {
  if (!state.activeProjectId) return
  const res = await guard(() =>
    client.call('topic.open', { projectId: state.activeProjectId!, ...input }),
  )
  if (!res) return
  state.topicDialogOpen = false
  state.pendingPlan = res.plan
}

/**
 * §8 — an exclusive runtime held elsewhere is a refusal, not a failure. The
 * second call is the user answering "yes, park the other one".
 */
export async function startTopic(topicId: string): Promise<void> {
  const res = await guard(() => client.call('topic.start', { topicId, force: false }))
  if (!res) return
  if (!res.ok) {
    if (!res.conflicts.length) {
      toast('error', res.detail)
      return
    }
    const ok = window.confirm(res.conflicts.join('\n') + '\n\nPark it and continue?')
    if (!ok) return
    const forced = await guard(() => client.call('topic.start', { topicId, force: true }))
    if (!forced?.ok) return
    await refreshTopics()
    toast('ok', forced.stoppedTopics.length ? 'started — stopped ' + forced.stoppedTopics.join(', ') : 'started')
    return
  }
  await refreshTopics()
  toast('ok', 'started')
}

export async function stopTopic(topicId: string): Promise<void> {
  const res = await guard(() => client.call('topic.stop', { topicId }))
  if (!res) return
  await refreshTopics()
  toast('ok', 'stopped — the branches stay exactly where they are')
}

/** §16 — refuses over unpushed work; removing the checkouts is its own plan. */
export async function closeTopic(topicId: string, removeWorktrees: boolean): Promise<void> {
  const res = await guard(() => client.call('topic.close', { topicId, removeWorktrees }))
  if (!res) return
  if (!res.ok) {
    toast('error', res.detail)
    return
  }
  if (res.plan) {
    state.pendingPlan = res.plan
    return
  }
  await refreshTopics()
  toast('ok', res.detail)
}

/**
 * §13 — stop the core over its own socket, then have the host spawn a fresh
 * one. Needed because this app starts the core detached: without it, picking
 * up new core code means finding a pid by hand.
 */
export async function restartCore(): Promise<void> {
  if (!host?.restartCore) {
    toast('info', 'run `cockpit restart` in a terminal — this window cannot start the service')
    return
  }
  toast('info', 'stopping the service…')
  try {
    await client.call('core.shutdown', undefined)
  } catch {
    // Already down, or it dropped the socket before answering. Either is fine.
  }
  const ok = await host.restartCore()
  if (!ok) {
    toast('error', 'the service did not come back — run `cockpit daemon` to see why')
    return
  }
  client.reconnectNow()
  toast('ok', 'service restarted')
}

/** §6 — the conversation is still there; the memory has moved on since. */
/**
 * §6 — the next turn, whether or not the engine is still on the last one.
 *
 * A live conversation is written into: the process is there with its stdin
 * open, and a turn said while it works is queued rather than refused. A
 * conversation whose process is gone is resumed, which hands the engine back
 * its own context. The composer does not have to know which it is.
 */
export async function sendTurn(sessionId: string, prompt: string): Promise<boolean> {
  rememberPrompt(prompt)
  const c = state.agents.find((x) => x.id === sessionId)
  if (c && isRunning(c)) {
    const res = await guard(() => client.call('agent.send', { sessionId, prompt }))
    if (!res) return false
    if (!res.ok) {
      toast('error', res.reason)
      return false
    }
    if (res.queued) toast('ok', 'queued — it is still on the last turn')
    return true
  }
  return resumeSession(sessionId, prompt)
}

/** What the composer currently says, in the shape the core takes. */
export function engineOptions(): EngineOptions {
  const o = state.engineOptions
  return { model: o.model, effort: o.effort, plan: o.plan }
}

export async function resumeSession(sessionId: string, prompt: string): Promise<boolean> {
  const res = await guard(() =>
    client.call('agent.resume', { sessionId, prompt, options: engineOptions() }),
  )
  if (!res) return false
  if ('denied' in res) {
    toast('error', res.reason)
    return false
  }
  toast('ok', 'resumed')
  return true
}

export const busy = ref(false)
