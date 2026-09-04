import { computed, reactive, ref, shallowRef } from 'vue'
import type {
  AddRepoSource, AgentScope, AgentScopePreview, Conversation, CockpitEvent, CockpitSettings,
  CommitPreview, CoreStatus, EngineOptions,
  DatabasePlan, Topic,
  ApplyResult, NewProjectSource, PlanPreview, ProcessLog, Project, RevertPreviewEntry, SeedProposal,
  ProjectSettings, ServerBoardRow, StashEntry, Workspace,
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

export type TabId = 'code' | 'diff' | 'agent' | 'memory' | 'servers' | 'journal' | 'terminal' | 'ticket'

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
export type ReviewTool = 'diff' | 'code' | 'servers' | 'journal' | 'terminal' | 'memory'

/**
 * §12 — how the window is divided between the two things it can show on the
 * right: the Agent, and the review column.
 *
 * Three named states rather than one boolean, because the boolean could only
 * ever say "beside" or "not at all". Reading a long diff, or a file, wants the
 * whole width and does not want the conversation next to it, and the only way
 * to get that was to drag the divider across the window and drag it back.
 *
 * They are an ordered ladder, left to right — how much of the window the
 * review has: none, some, all. That order is what the two keystrokes walk and
 * what the control draws.
 */
export type ShellView = 'agent' | 'split' | 'review'

/** The ladder, in order. The one place that says what "next" means. */
export const SHELL_VIEWS: ShellView[] = ['agent', 'split', 'review']


/**
 * §16 — an undo waiting to be confirmed, with what it would change.
 *
 * `plan` is null while the core is still working out the answer: the dialog
 * opens immediately and fills in, rather than the button hanging for the
 * length of a `git diff` on a large repository with nothing on screen.
 */
export interface PendingRevert {
  sessionId: string
  turnId: string
  /** Going forward again, rather than back: the same call, the other way. */
  redo: boolean
  /** Which turn, in the words it was asked in. */
  turnSeq: number
  turnPrompt: string
  plan: RevertPreviewEntry[] | null
  busy: boolean
}

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

  /**
   * How far into the answer the turn in flight is, per conversation, in the
   * engine's own output tokens.
   *
   * Beside the journal for the same reason the deltas are, and for one more:
   * it is the only thing on screen that moves while an agent is thinking with
   * nothing to show for it yet. A spinner says "something is happening"; a
   * count that climbs says the same thing and can be trusted, because a hung
   * turn's count stops.
   */
  progress: {} as Record<string, number>,

  /**
   * §3.3 — one conversation's transcript, fetched whole and then kept current
   * by the same events that update everything else.
   *
   * This used to be read straight out of `events`, which is a rolling buffer
   * of the last few hundred events across every project. So yesterday's thread
   * opened as a column of questions with no answers under them, and a busy
   * conversation lost its own opening while it was still running — the journal
   * had all of it, and nothing was asking for it by conversation.
   */
  transcripts: {} as Record<string, CockpitEvent[]>,

  /**
   * §8 — what each workspace's servers are writing, live.
   *
   * Beside the journal rather than in it, for the same reason agent deltas are
   * (§3.3): a dev server writes thousands of lines an hour and none of them
   * are history. Bounded per workspace, and the oldest go first — a log view
   * is read from the bottom.
   */
  runtimeLogs: {} as Record<string, string>,

  /** §11 — every checkout with a runtime, across every project. */
  board: [] as ServerBoardRow[],

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
  /**
   * Layer 3, as a fourth column. `agent` by default: the chat gets the width
   * until there is something to read.
   */
  view: 'agent' as ShellView,
  reviewTool: 'diff' as ReviewTool,
  /** Every conversation on this scope, over the chat rather than beside it. */
  historyOpen: false,

  /**
   * §7 — the scope the composer is aimed at, and the prompt being written for
   * it. Held here rather than in the tab so that going to the Diff to check
   * what changed does not throw away a half-written prompt.
   */
  agentScope: null as AgentScope | null,
  /**
   * What is being written, per conversation.
   *
   * One draft for the whole window meant a half-typed question followed you
   * into whatever thread you opened next, and was gone from the one you left
   * it in. A draft belongs to the thing it is being said to.
   */
  drafts: {} as Record<string, string>,

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

  /**
   * §16 + §3.7 — the undo being asked about, and what it would cost.
   *
   * At app level rather than inside the thread: it is a decision that discards
   * work, and those are confirmed in a dialog in this app, never in a strip of
   * text that a stray click can dismiss.
   */
  pendingRevert: null as PendingRevert | null,

  paletteOpen: false,
  /** §7 — the sheet that creates a project rather than finding one. */
  newProjectOpen: false,
  /** Which of the three sources the sheet opens on. */
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
  /**
   * §4 — what produced the plan on screen, and against which base.
   *
   * Only Catch up needs it, and it is the whole of "catch up from another
   * branch this time": the base is not a setting you go and change, it is a
   * word in the plan you are already reading. `workspaceId` is the checkout
   * whose branch list gets offered — for a topic, the first repository it
   * spans, since they are all forked from the same base.
   */
  pendingPlanFrom: null as
    | { scope: { kind: 'workspace'; id: string } | { kind: 'topic'; id: string }
        workspaceId: string
        base: string }
    | null,
  pendingConfirm: null as PendingConfirm | null,
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
  onAgentProgress(sessionId, outputTokens) {
    state.progress[sessionId] = outputTokens
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
    // A transcript already on screen is kept current by the same event that
    // updated the journal, rather than by re-fetching the thread. Only the
    // ones that have been opened: holding every conversation's would make this
    // buffer the thing it was supposed to replace.
    if (e.actor.kind === 'agent') {
      const t = state.transcripts[e.actor.sessionId]
      if (t) t.push(e)
    }
    // The finished message has landed, so the draft of it goes. Matching on
    // the id rather than clearing blindly: the next message may already be
    // streaming by the time this one is journalled.
    if (e.actor.kind === 'agent') {
      const sid = e.actor.sessionId
      // A process that is gone is not part way through anything. Cleared here
      // rather than left to the last `progress` push, which a session killed
      // mid-turn never sends.
      if (e.type === 'agent.session_ended') delete state.progress[sid]
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
  onRuntimeLog(workspaceId, _procId, _label, chunk) {
    if (!workspaceId) return
    const next = (state.runtimeLogs[workspaceId] ?? '') + chunk
    // A dev server left running all day would grow this without bound, and
    // nobody scrolls back through a megabyte of HMR notices.
    state.runtimeLogs[workspaceId] = next.length > LOG_MAX ? next.slice(-LOG_MAX) : next
    for (const fn of logListeners.get(workspaceId) ?? []) fn(chunk)
  },
})

/** Roughly a screenful of scrollback per workspace, which is what it is for. */
const LOG_MAX = 120_000
const logListeners = new Map<string, ((d: string) => void)[]>()

/** Lets a log view follow one workspace's output without re-rendering on each chunk. */
export function onRuntimeLogData(workspaceId: string, fn: (d: string) => void): () => void {
  const arr = logListeners.get(workspaceId) ?? []
  arr.push(fn)
  logListeners.set(workspaceId, arr)
  return () => {
    const cur = logListeners.get(workspaceId) ?? []
    logListeners.set(workspaceId, cur.filter((f) => f !== fn))
  }
}

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
  ids.push('code')
  // §3.9 — a checkout with nothing to run has no Servers tool, rather than one
  // that opens on an empty list. The board it opens on is machine-wide, but
  // the strip is still the strip of *this* workspace.
  if (w.runtime) ids.push('servers')
  ids.push('journal', 'terminal')
  // §6 — the memory, last.
  //
  // It was an overlay *over* the conversation, on the rule that the chat gets
  // the width; it is a document you read while writing a prompt, and an
  // overlay is the one shape that cannot be. Here it is beside the thread
  // rather than on top of it — and it is the same kind of thing as the four
  // above it: something written down that you go and read.
  //
  // Appended rather than led with so that ⌘2 is still the Diff. Its place in
  // the strip is one line, here, if that turns out to be wrong.
  ids.push('memory')
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
 * Every layout's rule lives here rather than in three components: `agent` is
 * the ground state and gives the window back to the conversation, and
 * everything else is a review tool, opened beside it.
 */
export function goTo(id: TabId): void {
  if (id === 'agent') {
    state.view = 'agent'
    return
  }
  if (id === 'ticket') return
  state.reviewTool = id
  // Beside the conversation, never instead of it: asking for the Diff is
  // asking to *see* the diff, and if it is already filling the window that is
  // the view you meant to stay in. Only the control and the two keystrokes
  // take the conversation off the screen, because only they are about the
  // window rather than about a tool.
  if (state.view === 'agent') state.view = 'split'
}

/** Which of the two right-hand columns is on screen, for the shell to draw. */
export const showsAgent = computed(() => state.view !== 'review')
export const showsReview = computed(() => state.view !== 'agent' && !!activeWorkspace.value)

/**
 * One step along the ladder — `+1` hands width to the review, `-1` to the
 * Agent. Written as a step rather than as three `setView` calls because that
 * is what the keys do and what the ends of the control do; it clamps rather
 * than wrapping, so holding a key cannot cycle you past the view you wanted.
 */
export function stepView(by: 1 | -1): void {
  const at = SHELL_VIEWS.indexOf(state.view)
  const next = SHELL_VIEWS[Math.min(SHELL_VIEWS.length - 1, Math.max(0, at + by))]!
  setView(next)
}

export function setView(view: ShellView): void {
  // §3.9 — there is no review of nothing. With no checkout selected the
  // review column has nothing to mount, so the ladder is one rung long.
  if (view !== 'agent' && !activeWorkspace.value) return
  state.view = view
  // The drawer hangs off the conversation's own bar; taking the conversation
  // off the screen has to take it with it, or it comes back later attached to
  // a bar that is no longer there.
  if (view === 'review') state.historyOpen = false
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
  // And put the thread where it can be seen. Asking the agent something from
  // a row while the review had the whole window used to change the scope of a
  // conversation that was not on screen — the click did exactly what it said
  // and nothing visible happened.
  if (state.view === 'review') state.view = 'split'
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
      // A repository is a repository wherever it is checked out. The kicker
      // labels the *name* beside it, and that name is the repository's in both
      // cases — so "BRANCH Init" put a category on a word that was never in it,
      // while the branch it meant was the chip to its right saying something
      // else entirely. Anything with no git in it is just a folder.
      return { kind: w?.repo ? 'Repository' : 'Folder', name: w?.name ?? '' }
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
  // The box that was typed into, named before the pin moves the active one on.
  delete state.drafts[draftKey(scope, null)]
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
 *   fresh  — an empty composer here, chosen over any of them
 *   read   — how far into a finished thread the person has actually got
 *
 * There was a fourth, `closed`: a bin of threads put away with the ✕, which
 * `openThreadFor` skipped when it picked. It made the ✕ a per-conversation act
 * — close this one, and the one before it comes up — so three open threads took
 * three ✕s to get back to an empty box, each one surfacing a conversation
 * nobody had asked for. But there is only ever one thread showing, and the ✕ is
 * how you stop showing it: `fresh` says that in one fact for the scope instead
 * of a growing set of ids. Nothing was ever killed by it and nothing is now —
 * a conversation mid-turn carries on, and the history has all of them.
 */
const THREADS_KEY = 'cockpit.threads'

interface ThreadMemory {
  /** scopeKey → session id, chosen by hand and kept until something replaces it. */
  pinned: Record<string, string>
  /** session id → the `endedAt` that has been read. */
  read: Record<string, number>
  /** scopeKey → showing an empty composer here rather than any thread. */
  fresh: Record<string, true>
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
  const empty: ThreadMemory = { pinned: {}, read: {}, fresh: {}, since: Date.now() }
  try {
    const raw = JSON.parse(localStorage.getItem(THREADS_KEY) ?? 'null') as Partial<ThreadMemory> | null
    if (!raw || typeof raw !== 'object') return empty
    return {
      pinned: raw.pinned ?? {},
      read: raw.read ?? {},
      fresh: raw.fresh ?? {},
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
  /**
   * The commit box under the file list in the Diff tab.
   *
   * A boundary one level down from the columns, and it earned a handle for the
   * same reason they did: forty changed files want the list, a message with a
   * drafted body and three stashes wants the box, and neither of those is a
   * property of the app. The floor leaves the message and its two buttons
   * standing — below that the box would be a scroll region pretending to be a
   * form.
   */
  commit: { min: 132, max: 560 },
}

/** What a fresh install starts from, and what a double-click goes back to. */
export const LAYOUT_DEFAULTS = { list: 340, review: 440 }

export const layout = reactive(readLayout())

/**
 * The commit box is the one pane with no default height: left alone it is as
 * tall as what is in it, which is right nearly always — a number here would
 * mean padding an empty box out or scrolling a full one for no reason. Null is
 * therefore a real value and not a missing one, and it is what a double-click
 * on the handle goes back to.
 */
function readLayout(): { list: number; review: number; commit: number | null } {
  const fallback = { ...LAYOUT_DEFAULTS, commit: null as number | null }
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null') as Partial<typeof fallback> | null
    if (!raw) return fallback
    return {
      list: clampTo(raw.list ?? fallback.list, LAYOUT_LIMITS.list),
      review: clampTo(raw.review ?? fallback.review, LAYOUT_LIMITS.review),
      commit:
        typeof raw.commit === 'number' ? clampTo(raw.commit, LAYOUT_LIMITS.commit) : null,
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

export function setCommitHeight(px: number): void {
  layout.commit = clampTo(px, LAYOUT_LIMITS.commit)
}

/** Back to a box the size of its contents — see `readLayout`. */
export function resetCommitHeight(): void {
  layout.commit = null
  saveLayout()
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

/**
 * The engine's process is up.
 *
 * Which is *not* the same as it working, and conflating the two was the window
 * telling a lie every day: a conversation that had answered and was sitting
 * there with its stdin open said WORKING in the bar, pulsed its dot, and
 * offered to Queue a turn that nothing was ahead of. "The process is alive"
 * is a fact about a lease and about how the next turn gets sent — it is never
 * a thing to report as activity.
 *
 * The two are told apart by `status`, which the core has always distinguished:
 * `thinking` while a turn is in flight, `idle` between them.
 */
export function isLive(c: Conversation): boolean {
  return c.status !== 'ended' && c.status !== 'failed'
}

/** A turn is in flight. This, and only this, is what "working" means. */
export function isBusy(c: Conversation): boolean {
  return c.status === 'starting' || c.status === 'thinking'
}

/**
 * When it last had something to say.
 *
 * `endedAt` is null for as long as the process is up, so a conversation that
 * answered an hour ago and is still open has to be dated by its last turn —
 * otherwise "answered, waiting for you" is measured against when the whole
 * thread was opened, and a long conversation never looks new.
 */
export function lastActivityAt(c: Conversation): number {
  const last = c.history[c.history.length - 1]
  return c.endedAt ?? last?.endedAt ?? last?.startedAt ?? c.startedAt
}

/**
 * Why a finished conversation is still asking for a person.
 *
 *   blocked — the allow-list refused a tool, so it stopped short of the job
 *   failed  — the engine died
 *   reply   — it answered, and the answer has not been read
 *
 * A working conversation is never in any of these: it is working, not waiting.
 * Being *alive* is not being busy — an answer sitting unread on a session
 * whose process is still up is exactly the thing this is for, and it used to
 * be invisible for as long as that process lived.
 */
export type Attention = 'none' | 'reply' | 'blocked' | 'failed'

export function attentionOf(c: Conversation): Attention {
  if (isBusy(c)) return 'none'
  const at = lastActivityAt(c)
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
    const running = isBusy(c)
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
 * left showing. One thread at a time — opening another does not close this one,
 * it stops being the one on screen — and the empty composer is a state of the
 * scope, not the absence of anything to show.
 */
export function openThreadFor(scope: AgentScope | null): Conversation | null {
  if (!scope) return null
  // The ✕, and §6's "start fresh": an empty box here, whatever is pinned.
  if (threads.fresh[scopeKey(scope)]) return null
  const all = [...sessionsForScope(scope)].sort((a, b) => b.startedAt - a.startedAt)
  const pinned = all.find((c) => c.id === threads.pinned[scopeKey(scope)])
  if (pinned) return pinned
  // Never chosen on this scope: the busy one first — that is the one there is
  // news about — then any whose process is still up, which is the one a turn
  // goes straight into.
  return all.find(isBusy) ?? all.find(isLive) ?? all[0] ?? null
}

/** Showing one out of the history. Whatever was showing simply stops being. */
export function pinThread(scope: AgentScope, sessionId: string): void {
  threads.pinned[scopeKey(scope)] = sessionId
  // Opening a conversation is the opposite of composing a new one.
  delete threads.fresh[scopeKey(scope)]
  saveThreads()
}

/**
 * §6 — "vider devient gratuit : la conversation part, la mémoire reste."
 *
 * An empty composer on this scope, with every existing thread left exactly
 * where it is: nothing is ended, nothing is lost, and the history still has all
 * of it. The next question starts a conversation that reads the memory on the
 * way in, which is the whole of what makes clearing free.
 *
 * This is also what the ✕ on a thread does. A conversation still answering
 * carries on answering — the window stops showing it, the rail and the count
 * still say it is there, and one click of the ✕ gets to the empty box however
 * many threads have been opened on the way.
 */
export function startFresh(scope: AgentScope): void {
  threads.fresh[scopeKey(scope)] = true
  saveThreads()
}

/**
 * §6 — the conversation removed, here and in the service.
 *
 * The service draws the line (`agents.remove`): the conversation and its turns
 * go, the journal and the per-path attribution stay. What is left to do here
 * is the window's own bookkeeping, all of it keyed by session id — a pin, a
 * read mark and a cached transcript. A pin left pointing at a
 * conversation that no longer exists is the one that actually bites:
 * `openThreadFor` finds nothing for it and falls silently through to whatever
 * ran before, so the panel answers a question nobody asked.
 *
 * Answers whether it happened, so the caller can keep its confirmation open
 * on a refusal ("it is still running") instead of closing on a lie.
 */
/**
 * §6 — the engine let go. The conversation itself stays: its turns, its journal
 * and the fact it can be resumed.
 *
 * Here rather than in a component because three of them ask for it — the
 * instruments over the thread, the composer while a turn is in flight, and the
 * history list — and three copies of one RPC call is three places for the toast
 * to disagree with itself.
 */
export async function stopConversation(sessionId: string): Promise<void> {
  await guard(() => client.call('agent.stop', { sessionId }), 'conversation stopped')
}

export async function deleteConversation(sessionId: string): Promise<boolean> {
  const r = await guard(() => client.call('agent.delete', { sessionId }))
  if (!r) return false
  if (!r.ok) {
    toast('error', r.reason)
    return false
  }
  for (const key of Object.keys(threads.pinned)) {
    if (threads.pinned[key] === sessionId) delete threads.pinned[key]
  }
  delete threads.read[sessionId]
  saveThreads()
  delete state.transcripts[sessionId]
  delete state.deltas[sessionId]
  // The list is pushed by the service, but not before this returns — dropping
  // it here is what keeps the row from staying under the cursor for a beat
  // after the click that removed it.
  state.agents = state.agents.filter((c) => c.id !== sessionId)
  return true
}

/* ── the transcript, and what is being written into it ─────────────────── */

/** Fetched once per conversation; live events keep it current after that. */
const transcriptLoading = new Set<string>()

/**
 * §3.3 — the thread as the journal has it, whole.
 *
 * Idempotent and cheap to call from a watcher: a conversation already loaded
 * is left alone, because the events arriving since are already being appended.
 */
export async function loadTranscript(sessionId: string): Promise<void> {
  if (state.transcripts[sessionId] || transcriptLoading.has(sessionId)) return
  transcriptLoading.add(sessionId)
  try {
    const events = await guard(() => client.call('agent.transcript', { sessionId }))
    // Only if nothing arrived while the call was in flight — an event pushed
    // in the meantime went into `state.events` and would be lost by an
    // assignment that overwrote it. Merging by id keeps both.
    if (events) {
      const seen = new Set(events.map((e) => e.id))
      const live = state.events.filter(
        (e) => e.actor.kind === 'agent' && e.actor.sessionId === sessionId && !seen.has(e.id),
      )
      state.transcripts[sessionId] = [...events, ...live]
    }
  } finally {
    transcriptLoading.delete(sessionId)
  }
}

/** What the transcript is derived from, for a thread that may not be loaded. */
export function transcriptOf(sessionId: string): CockpitEvent[] {
  return state.transcripts[sessionId] ?? []
}

/**
 * Which draft the composer is currently showing.
 *
 * A thread has its own; a scope with no thread open has one for the question
 * that will start one. They are different boxes and always were — the window
 * simply had a single string behind both.
 */
export function draftKey(scope: AgentScope | null, sessionId?: string | null): string {
  if (sessionId) return 'thread:' + sessionId
  return scope ? 'new:' + scopeKey(scope) : 'new:none'
}

export const activeDraftKey = computed(() =>
  draftKey(activeAgentScope.value, openThreadFor(activeAgentScope.value)?.id ?? null),
)

/** The box itself, wherever the window happens to be pointing. */
export const agentDraft = computed<string>({
  get: () => state.drafts[activeDraftKey.value] ?? '',
  set: (v) => {
    state.drafts[activeDraftKey.value] = v
  },
})

/** Having it on screen is having read it; there is no second "mark as read". */
export function markThreadRead(c: Conversation): void {
  if (isBusy(c)) return
  const at = lastActivityAt(c)
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
 * the sheet, so the first click already says something.
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

/**
 * §15 — this machine's settings for one project.
 *
 * Merged in the core, so the window sends the field it changed and nothing
 * else. Nothing here is written into the repository: locking a branch is a
 * handrail one person put up on one machine, not a team convention — those
 * belong in `cockpit.yaml`, which is versioned and reviewed.
 */
export async function setProjectSettings(
  projectId: string,
  patch: Partial<ProjectSettings>,
): Promise<boolean> {
  const res = await guard(() => client.call('project.settings', { projectId, patch }), 'saved')
  if (!res) return false
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
}

/* ── recency ───────────────────────────────────────────────────────────
 * Which workspace you were last in, per project, so `selectProject` resumes
 * one rather than restarting it. A property of this machine's habits, not of
 * the projects, so the core does not store it. Ids only, so a workspace that
 * disappears simply drops out of the list.
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
/**
 * A plan with nothing to warn about and nothing destructive in it.
 *
 * The confirmation exists because a rebase rewrites history and a push leaves
 * this machine — reading the steps first is the whole point of §12's "2 clicks:
 * bouton → confirmation du plan". A `git switch` onto a branch with a clean
 * tree has neither property: git either moves you or refuses, and nothing is
 * lost either way. A modal in front of that is a modal in front of nothing,
 * and modals in front of nothing are how people learn to click through the
 * ones that matter.
 *
 * Steps are required as well as warnings being absent: a plan that would do
 * nothing has something to say about why, and that something is a warning the
 * dialog is the only place to read.
 */
function isTrivial(plan: PlanPreview): boolean {
  return (
    plan.steps.length > 0 &&
    plan.warnings.length === 0 &&
    !plan.steps.some((s) => s.destructive)
  )
}

/**
 * Workspaces with a git plan in flight, and which verb it is.
 *
 * It exists because of the plan dialog's own absence: while every plan was read
 * in a modal, the modal *was* the busy state — it covered the window, it said
 * what was running, and nothing behind it could be clicked. A switch applied
 * without one leaves a bar that looks idle for as long as git takes, so the
 * controls that must not be pressed during it have to say so themselves.
 *
 * A record rather than one id: nothing stops a second repository being asked
 * for something while this one works.
 */
export const gitBusy = reactive<Record<string, string>>({})

export async function requestPlan(
  workspaceId: string,
  operation: 'rebase' | 'merge' | 'branch' | 'switch' | 'worktree' | 'push' | 'pull' | 'sync',
  args: Record<string, string> = {},
  /**
   * `always` is the default and stays the default: every verb that reaches
   * outside this checkout keeps its confirmation. `whenItMatters` hands the
   * decision to the plan itself — see `isTrivial` — and is for the two verbs
   * that cannot lose anything, switching branch and creating one.
   */
  confirm: 'always' | 'whenItMatters' = 'always',
): Promise<void> {
  // From asking for the plan, not from applying it: building one shells out to
  // git too, and the gap between the click and the dialog is exactly as long
  // as the gap between the click and the switch.
  gitBusy[workspaceId] = operation
  try {
    const plan = await guard(() => client.call('git.plan', { workspaceId, operation, args }))
    if (!plan) return
    if (confirm === 'whenItMatters' && isTrivial(plan)) {
      // Never through `state.pendingPlan`: the dialog is rendered off it, and
      // setting it around an awaited call flashes the modal for a frame — which
      // is worse than showing it properly.
      await settlePlan(plan, await guard(() => client.call('git.apply', { planId: plan.planId })))
      return
    }
    const w = state.workspaces.find((x) => x.id === workspaceId)
    if (operation === 'push') {
      askPush(plan, (w?.git?.branch ?? 'this branch') + ' to origin')
      return
    }
    if (operation === 'pull') {
      askPull(plan, w?.git?.branch ?? 'this branch')
      return
    }
    if (operation === 'rebase') {
      const base = args.base ?? w?.git?.base ?? ''
      state.pendingPlanFrom = { scope: { kind: 'workspace', id: workspaceId }, workspaceId, base }
      askCatchUp(plan, base, null)
      return
    }
    state.pendingPlanFrom = null
    state.pendingPlan = plan
  } finally {
    delete gitBusy[workspaceId]
  }
}

/** What an apply came to, wherever it was applied from. */
async function settlePlan(
  plan: PlanPreview,
  res: ApplyResult | null,
  /** What to say when it worked, for a caller whose button had its own word
   *  for it — "put back" beats "stash pop applied". */
  okMessage?: string,
): Promise<void> {
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
    // The core writes a sentence into the output when it knows what happened —
    // "N file(s) came back with conflict markers", say. Repeating "see the
    // journal" over the top of an explanation the plan already produced is how
    // a stash that half-applied looked like an unexplained failure.
    // The first of them, not the last: the core writes what went wrong and
    // then what it did about it ("1 step(s) not run"), and the second sentence
    // without the first is a consequence with no cause.
    const said = res.output.split('\n').find((l) => l.startsWith('[cockpit] '))
    toast(
      'error',
      said
        ? said.slice('[cockpit] '.length)
        : plan.onFailure === 'halt'
          ? 'stopped — what already succeeded was kept; see the journal'
          : 'stopped — nothing was left behind; see the journal',
    )
    return
  }
  toast('ok', okMessage ?? plan.operation + ' applied')
}

/* ── a plan you do not need to read ──────────────────────────────────
 *
 * §3.7 says every operation shows its plan. It does not say the plan has to be
 * the thing you read first, and for the small reversible ones it should not be:
 * two lines of `git stash push` under a numbered-step heading is a wall of
 * machinery in front of a question with a one-word answer.
 *
 * So this asks the question in words — what will happen, and what it is called
 * — and keeps the commands one disclosure away, where anyone who wants to know
 * exactly what runs still finds them before pressing the button. Nothing about
 * the plan itself changes: it is the same object, applied through the same
 * `git.apply`, journaled the same way.
 *
 * The heavy dialog stays for the operations that rewrite history.
 */
interface ConfirmBase {
  /** The question, asked as one. */
  title: string
  /** What it does, in sentences — the plan's own warnings, usually. */
  body: string[]
  /** The button that says yes, in the words of the thing it does. */
  verb: string
  /** What the toast says afterwards. */
  done: string
  /**
   * The user's own words, shown back to them.
   *
   * A commit message is the one input in the app that becomes permanent the
   * moment the button is pressed, and the dialog that confirms it is the last
   * place a typo can be caught. It is quoted rather than folded into `body`
   * because it is not the app talking.
   */
  quote?: string
  /** Red button, for the one that cannot be taken back. */
  danger: boolean
}

/**
 * Most questions here are a git plan wearing plain words. Some are not: removing
 * a conversation runs no git at all, and it is still a question with the same
 * shape — a title, a sentence about what it costs, a red button. It carries the
 * act instead of a plan, and answers the same way: `true` if it happened.
 *
 * One dialog for both, deliberately. A second confirmation drawn its own way is
 * how an app ends up asking "are you sure" in three different voices.
 */
export type PendingConfirm = ConfirmBase &
  (
    | { plan: PlanPreview; run?: never }
    | { plan?: never; run: () => Promise<boolean> }
  )

export async function applyPendingConfirm(): Promise<void> {
  const c = state.pendingConfirm
  if (!c) return
  if (!c.plan) {
    state.planBusy = true
    const ok = await c.run()
    state.planBusy = false
    // A refusal ("it is still running") stays in front of the person who asked,
    // with the question still on screen — `run` has already said why.
    if (!ok) return
    state.pendingConfirm = null
    toast('ok', c.done)
    return
  }
  state.planBusy = true
  const res = await guard(() => client.call('git.apply', { planId: c.plan.planId }))
  state.planBusy = false
  state.pendingConfirm = null
  // §4 — it belonged to the question, and the question is answered.
  state.pendingPlanFrom = null
  // Its own wording rather than settlePlan's "<operation> applied": the button
  // said "Put it back", and the toast that follows should agree with it.
  await settlePlan(c.plan, res, c.done)
}

export async function applyPendingPlan(): Promise<void> {
  const plan = state.pendingPlan
  if (!plan) return
  state.planBusy = true
  const res = await guard(() => client.call('git.apply', { planId: plan.planId }))
  state.planBusy = false
  state.pendingPlan = null
  state.pendingPlanFrom = null
  await settlePlan(plan, res)
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
  // §16 — the review already happened, in the tab this was pressed from. What
  // is left to confirm is the sentence and where it lands, not two lines of
  // `git add` under a numbered heading.
  const n = res.preview
    .filter((r) => r.willCommit)
    .reduce((sum, r) => sum + (all ? r.staged + r.unstaged : r.staged), 0)
  state.pendingConfirm = {
    title: 'Commit ' + n + ' file' + (n === 1 ? '' : 's') + '?',
    body: res.plan.warnings,
    quote: message,
    verb: 'Commit',
    done: 'committed',
    danger: false,
    plan: res.plan,
  }
  return true
}

/**
 * §16 — a first sentence out of the diff, into the box a person types in.
 *
 * It returns the draft rather than setting it: the field is the user's, and a
 * function that wrote into it directly would be one keystroke away from
 * overwriting a message someone had already begun.
 */
export async function draftCommitMessage(
  topicId: string | null,
  workspaceId: string,
  all: boolean,
  hint?: string,
): Promise<string | null> {
  const res = await guard(() =>
    client.call('git.draftMessage', {
      ...(topicId ? { topicId } : { workspaceIds: [workspaceId] }),
      all,
      ...(hint ? { hint } : {}),
    }),
  )
  if (!res) return null
  if (!res.ok) {
    toast('error', res.detail)
    return null
  }
  if (res.truncated) toast('info', 'The diff was too large to send whole — read the draft closely.')
  return res.message
}

/* ── stash ───────────────────────────────────────────────────────────────
 * §16 — the list is the feature. See `stash.ts` in the core for why: a stash
 * the app does not mention is how uncommitted work goes missing.
 */

export async function stashList(
  topicId: string | null,
  workspaceId: string,
): Promise<StashEntry[]> {
  try {
    const rows = await client.call(
      'git.stashList',
      topicId ? { topicId } : { workspaceIds: [workspaceId] },
    )
    // The daemon outlives the window it was started from: `pnpm dev` reloads
    // the renderer, the core keeps running, and a field added on one side
    // arrives undefined on the other for as long as that process lives.
    //
    // This is not a theoretical concern. `titled` and `paths` were added after
    // a running core, so `paths.length` threw inside a render — which does not
    // fail like a missing feature, it fails like a broken app: the whole review
    // column goes blank and every later update is dropped. A version seam is
    // filled in here, once, rather than trusted in a template.
    return rows.map((e) => ({
      ...e,
      titled: e.titled ?? true,
      paths: e.paths ?? [],
      files: e.files ?? 0,
    }))
  } catch {
    // A core older than this window has no stash at all; the diff and the
    // commit are unaffected, so this stays quiet rather than raising a toast
    // on every refresh.
    return []
  }
}

/** What each verb is called, in the question and on the button. */
const STASH_WORDS: Record<
  'push' | 'pop' | 'apply' | 'drop',
  { title: (label?: string) => string; verb: string; done: string; danger: boolean }
> = {
  push: {
    title: () => 'Set this work aside?',
    verb: 'Set aside',
    done: 'set aside — listed under the files',
    danger: false,
  },
  pop: {
    title: (l) => (l ? 'Put back “' + l + '”?' : 'Put this back?'),
    verb: 'Put it back',
    done: 'put back into the working tree',
    danger: false,
  },
  apply: {
    title: (l) => (l ? 'Copy back “' + l + '”?' : 'Copy this back?'),
    verb: 'Copy it back',
    done: 'copied back — the entry is still there',
    danger: false,
  },
  drop: {
    title: (l) => (l ? 'Drop “' + l + '”?' : 'Drop this entry?'),
    verb: 'Drop it',
    done: 'entry dropped',
    danger: true,
  },
}

export async function stash(
  params: {
    topicId: string | null
    workspaceId: string
    action: 'push' | 'pop' | 'apply' | 'drop'
    message?: string
    includeUntracked?: boolean
    ref?: string
    /** The entry's own name, so the question can say which one it means. */
    label?: string
  },
): Promise<boolean> {
  const { topicId, workspaceId, action, label, ...rest } = params
  const res = await guard(() =>
    client.call('git.stash', {
      // push sweeps the whole topic; pop, apply and drop name one entry in one
      // repository, so they carry the workspace and never the topic.
      ...(action === 'push' && topicId ? { topicId } : { workspaceIds: [workspaceId] }),
      workspaceId,
      action,
      ...rest,
    }),
  )
  if (!res) return false
  if (!res.ok || !res.plan) {
    toast('error', res.detail)
    return false
  }
  const w = STASH_WORDS[action]
  state.pendingConfirm = {
    title: w.title(label),
    body: res.plan.warnings,
    verb: w.verb,
    done: w.done,
    danger: w.danger,
    plan: res.plan,
  }
  return true
}

/**
 * §4 — every branch of the topic to origin, in one act.
 *
 * The one topic-wide verb the commit box gave up. A commit message describes a
 * diff, and a topic's repositories do not share one — but a push says nothing
 * at all, so doing them together invents nothing. It keeps the full plan
 * dialog: this is the step that leaves the machine.
 */
export async function pushTopic(topicId: string): Promise<void> {
  const res = await guard(() => client.call('topic.push', { topicId }))
  if (!res) return
  if (!res.ok || !res.plan) {
    toast('info', res.detail)
    return
  }
  // A topic forks one branch name across its repositories, so nearly always
  // there is one name to say. Saying "2 branches" when both are `vat-rework`
  // is technically true and reads as though they were different things.
  const branches = new Set(
    state.workspaces
      .filter((w) => w.topicId === topicId && w.git?.branch)
      .map((w) => w.git!.branch!),
  )
  const n = res.plan.repos?.length ?? res.plan.steps.length
  const one = branches.size === 1 ? [...branches][0]! : null
  askPush(
    res.plan,
    n > 1
      ? one
        ? one + ' from ' + n + ' repositories'
        : n + ' branches to origin'
      : (one ?? 'this branch') + ' to origin',
  )
}

/**
 * §16 — the verb that leaves the machine, asked rather than briefed.
 *
 * Push is short: one command per repository, no rollback to describe, no
 * restore point to promise. Everything the plan dialog draws around it — the
 * numbered steps, the all-or-nothing note, the shield saying nothing is
 * destructive — is scaffolding around a single sentence and a single decision.
 * The commands are still there, one disclosure down, which is what §3.7 asks
 * for: the plan is shown before it runs, not necessarily read first.
 *
 * A force-push keeps the red button. It is the one push that can take
 * something away from someone else.
 */
function askPush(plan: PlanPreview, subject: string): void {
  const force = plan.steps.some((s) => s.destructive)
  state.pendingConfirm = {
    title: (force ? 'Force-push ' : 'Push ') + subject + '?',
    body: plan.warnings,
    verb: force ? 'Force-push' : 'Push',
    done: force ? 'force-pushed' : 'pushed to origin',
    danger: force,
    plan,
  }
}

/**
 * §4 — Catch up, asked rather than briefed, and for the same reason Push is.
 *
 * It was the heavy dialog: four numbered commands, an all-or-nothing note and
 * a shield, above the one thing anybody wanted to change (which branch) and the
 * one thing anybody had to read (the warnings). Nothing there was wrong and all
 * of it was scaffolding around a single decision. The commands are one
 * disclosure down, which is what §3.7 asks for — the plan is shown before it
 * runs, not necessarily read first.
 *
 * Not `danger`, deliberately, even though it rewrites history: a Catch up takes
 * a restore point, so it is the kind of thing you can take back, and the red
 * button is reserved for the kind you cannot. The sentence says so instead.
 */
function askCatchUp(plan: PlanPreview, base: string, repos: string[] | null): void {
  // A Catch up with nothing destructive in it is the fast-forward the planner
  // builds when the branch *is* the base — a different sentence, because
  // nothing is replayed and nothing is rewritten.
  const replays = plan.steps.some((s) => s.destructive)
  const body = [
    replays
      ? (repos && repos.length > 1 ? 'Every branch in this topic is' : 'Your work is') +
        ' replayed on top of ' + base + '. Nothing is discarded — a conflict is where both' +
        ' sides changed the same lines.'
      : base + ' has moved on and you have not. This only moves you forward — nothing of' +
        ' yours is replayed or rewritten.',
  ]
  if (repos && repos.length > 1) body.push('In ' + repos.join(', ') + '.')
  body.push(...plan.warnings)
  if (plan.capturesRestorePoint) body.push('A restore point is captured first, so this can be undone.')

  state.pendingConfirm = {
    title: 'Catch up from ' + base + '?',
    body,
    verb: 'Catch up',
    done: 'caught up with ' + base,
    danger: false,
    plan,
  }
}

/**
 * §4 — the other direction, and the one nothing covered: what origin holds for
 * *this* branch. Short enough to be a question, like Push and Catch up.
 */
function askPull(plan: PlanPreview, branch: string): void {
  const rewrites = plan.steps.some((s) => s.destructive)
  const body = [
    rewrites
      ? 'You and origin have both moved, so there is no fast-forward to be had: your commits are replayed on top of what origin has.'
      : 'What origin holds for ' + branch + ' comes in. Nothing of yours is rewritten.',
    ...plan.warnings,
  ]
  state.pendingConfirm = {
    title: 'Pull ' + branch + ' from origin?',
    body,
    verb: 'Pull',
    done: 'pulled from origin',
    danger: false,
    plan,
  }
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
export async function rebaseTopic(topicId: string, base?: string): Promise<void> {
  const res = await guard(() => client.call('topic.rebase', { topicId, base }))
  if (!res) return
  if (!res.ok || !res.plan) {
    toast('error', res.detail)
    return
  }
  // The first repository that has a base: they are forked from the same one,
  // and its branch list is the one to offer if the base is changed.
  const anchor = state.workspaces.find((w) => w.topicId === topicId && !!w.git?.base)
  const onto = base ?? anchor?.git?.base ?? ''
  state.pendingPlanFrom = {
    scope: { kind: 'topic', id: topicId },
    workspaceId: anchor?.id ?? '',
    base: onto,
  }
  askCatchUp(res.plan, onto, res.plan.repos ?? null)
}

/**
 * §4 — the same act, onto a different branch, without leaving the dialog.
 *
 * "Always catch up from `main`" is the project's setting and stays the answer
 * nearly always; this is the exception you take once, on the plan you are
 * already looking at, and it does not change the setting.
 */
export async function replanBase(base: string): Promise<void> {
  const from = state.pendingPlanFrom
  if (!from || base === from.base) return
  state.pendingPlan = null
  state.pendingPlanFrom = null
  if (from.scope.kind === 'topic') await rebaseTopic(from.scope.id, base)
  else await requestPlan(from.scope.id, 'rebase', { base })
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
/**
 * §8 — what to say after starting, now that starting reports what happened.
 *
 * "started" was the only outcome this could ever announce, because `up`
 * answered before the server had done anything. It can now come back three
 * ways, and each one is a different sentence: it is serving, it is still
 * coming up, or it died and here is what it said.
 */
function reportStart(res: { servers: { name: string; ok: boolean; status: string; log: string }[] }): void {
  const failed = res.servers.filter((r) => !r.ok)
  const starting = res.servers.filter((r) => r.ok && r.status === 'starting')
  const up = res.servers.filter((r) => r.status === 'up')

  if (failed.length) {
    // The name and the last line it wrote: enough to know which repository
    // broke and why, without opening anything.
    const first = failed[0]!
    const why = first.log.split('\n').filter(Boolean).slice(-1)[0] ?? 'it exited before it answered'
    toast('error', first.name + ' did not start — ' + why.slice(0, 160))
    // The rest of the reason is one click away rather than in a toast.
    state.reviewTool = 'servers'
    if (state.view === 'agent') state.view = 'split'
    return
  }
  if (starting.length) {
    toast('info', starting.map((r) => r.name).join(', ') + ' — still starting, no answer yet')
    return
  }
  toast('ok', up.length > 1 ? up.length + ' servers up' : 'up')
}

export async function startTopic(topicId: string): Promise<void> {
  const res = await guard(() => client.call('topic.start', { topicId, force: false }))
  if (!res) return
  if (!res.ok && res.conflicts.length) {
    const ok = window.confirm(res.conflicts.join('\n') + '\n\nStop it and continue?')
    if (!ok) return
    const forced = await guard(() => client.call('topic.start', { topicId, force: true }))
    if (!forced) return
    await refreshTopics()
    await refreshBoard()
    if (forced.stoppedTopics.length) toast('info', 'stopped ' + forced.stoppedTopics.join(', '))
    reportStart(forced)
    return
  }
  await refreshTopics()
  await refreshBoard()
  // A refusal with no servers behind it (a closed topic, nothing to start) has
  // only its own sentence to offer.
  if (!res.servers.length) {
    toast(res.ok ? 'info' : 'error', res.detail)
    return
  }
  reportStart(res)
}

/** §11 — the board is machine-wide, so anything that starts or stops refreshes it. */
export async function refreshBoard(): Promise<void> {
  const rows = await client.call('runtime.board', undefined).catch(() => null)
  if (rows) state.board = rows
}

export async function loadRuntimeLogs(workspaceId: string): Promise<ProcessLog[]> {
  return (await client.call('runtime.logs', { workspaceId }).catch(() => [])) as ProcessLog[]
}

export async function stopTopic(topicId: string): Promise<void> {
  const res = await guard(() => client.call('topic.stop', { topicId }))
  if (!res) return
  await refreshTopics()
  await refreshBoard()
  toast('ok', 'stopped — the branches stay exactly where they are')
}

/**
 * §8 — start or stop one checkout's servers, from wherever the row is.
 *
 * The same three outcomes as a topic, reported the same way: this is the one
 * function behind the Start button on the bar and the play control on the row,
 * so they cannot drift into saying different things about the same act.
 */
export async function toggleWorkspaceRuntime(w: Workspace): Promise<void> {
  if (!w.runtime) return
  const running = w.runtime.status === 'up' || w.runtime.status === 'starting'
  if (running) {
    const res = await guard(() => client.call('runtime.down', { workspaceId: w.id }))
    await refreshBoard()
    if (res) toast('ok', 'stopped')
    return
  }
  const res = await guard(() => client.call('runtime.up', { workspaceId: w.id }))
  await refreshBoard()
  if (!res) return
  reportStart({ servers: [{ name: w.name, ok: res.ok, status: res.status, log: res.log }] })
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
  if (c && isLive(c)) {
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

/* ── §16, the undo ──────────────────────────────────────────────────────── */

/**
 * Asking is not doing. This opens the confirmation and then reads what would
 * change; nothing has moved when it returns.
 */
export async function askRevert(
  sessionId: string,
  turn: { id: string; seq: number; prompt: string },
  redo: boolean,
): Promise<void> {
  const turnId = redo ? 'redo_' + turn.id : turn.id
  state.pendingRevert = {
    sessionId,
    turnId,
    redo,
    turnSeq: turn.seq,
    turnPrompt: turn.prompt,
    plan: null,
    busy: false,
  }
  const r = await guard(() => client.call('agent.revertPreview', { sessionId, turnId }))
  // Only if it is still the same question: the dialog can be dismissed, or
  // another turn asked about, while this was in flight.
  if (state.pendingRevert?.turnId === turnId) state.pendingRevert.plan = r ?? []
}

export async function applyPendingRevert(): Promise<void> {
  const p = state.pendingRevert
  if (!p || p.busy) return
  p.busy = true
  const r = await guard(() => client.call('agent.revert', { sessionId: p.sessionId, turnId: p.turnId }))
  p.busy = false
  if (!r) return
  // Closed only on an answer: a dialog that vanishes on failure takes the
  // reason with it.
  if (r.ok) state.pendingRevert = null
  toast(r.ok ? 'ok' : 'error', r.detail)
}

/**
 * An engine's name as it is written, not as it is keyed.
 *
 * The ids are lowercase because they are ids — they key a binary on PATH and
 * a row in the database. Claude and Codex are products with names, and a chip
 * that says `claude` reads as a command someone forgot to capitalise. The id
 * is untouched; only what the window prints changes.
 */
export function engineName(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1)
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
