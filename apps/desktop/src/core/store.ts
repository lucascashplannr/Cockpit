import { computed, reactive, ref, shallowRef } from 'vue'
import type {
  AddRepoSource, AgentScope, AgentScopePreview, AgentSession, CockpitEvent, CockpitSettings,
  CommitPreview, CoreStatus,
  DatabasePlan, Feature,
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
  features: [] as Feature[],
  agents: [] as AgentSession[],
  events: [] as CockpitEvent[],

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
  /** §4 — the sheet that opens a feature across N repositories. */
  featureDialogOpen: false,
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
  onFeatures(f) {
    state.features = f
  },
  onWorkspaces(w) {
    state.workspaces = w
    ensureSelection()
  },
  onAgents(s) {
    state.agents = s
  },
  onEvent(e) {
    state.events.push(e)
    if (state.events.length > 800) state.events.splice(0, state.events.length - 800)
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
  const [projects, workspaces, features, agents, events, status, config] = await Promise.all([
    client.call('project.list', undefined),
    client.call('workspace.list', {}),
    client.call('feature.list', { includeArchived: true }),
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
  state.features = features
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



/** §12's "where am I" for the Agent: the sessions still costing money. */
export const liveSessions = computed(() =>
  state.agents.filter((s) => s.status !== 'ended' && s.status !== 'failed'),
)

/* ── agents (§7) ────────────────────────────────────────────────────────
 * The scope is the whole idea: a session says what it is *for* — a feature,
 * a project, one checkout, one folder — and the core turns that into the paths
 * the lease is taken on. What the window has to do is offer those four and
 * never the checkbox soup that came before, where "an agent on this feature"
 * and "an agent on this repo" were the same control with different boxes
 * ticked, and nothing afterwards could tell you which you had run.
 */

export function scopeKey(scope: AgentScope): string {
  switch (scope.kind) {
    case 'feature':
      return 'feature:' + scope.featureId
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
 * §7 — a chat is opened *on* something: a feature row, a workspace row, the
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
    case 'feature':
      return state.workspaces.find((w) => w.featureId === scope.featureId && real(w)) ?? null
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

/** What to call the current scope in the chat's one line of chrome. */
export function scopeLabel(scope: AgentScope | null): { kind: string; name: string } {
  if (!scope) return { kind: '', name: '' }
  switch (scope.kind) {
    case 'feature':
      return {
        kind: 'Feature',
        name: state.features.find((f) => f.id === scope.featureId)?.name ?? 'feature',
      }
    case 'project':
      return {
        kind: 'Project',
        name: state.projects.find((p) => p.id === scope.projectId)?.name ?? 'project',
      }
    case 'folder': {
      const w = state.workspaces.find((x) => x.id === scope.workspaceId)
      return { kind: 'Folder', name: (w?.name ?? '') + '/' + scope.subpath }
    }
    default: {
      const w = state.workspaces.find((x) => x.id === scope.workspaceId)
      return { kind: w?.repo ? 'Repo' : 'Folder', name: w?.name ?? 'workspace' }
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
    // A scope whose anchor is gone (feature closed, repo forgotten) would leave
    // the chat pointing at nothing; fall back to where we are standing.
    const stillThere =
      chosen.kind === 'feature'
        ? state.features.some((f) => f.id === chosen.featureId)
        : chosen.kind === 'project'
          ? state.projects.some((p) => p.id === chosen.projectId)
          : state.workspaces.some((x) => x.id === chosen.workspaceId)
    if (stillThere) return chosen
  }
  return w ? { kind: 'workspace', workspaceId: w.id } : null
})

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
export function sessionsForScope(scope: AgentScope | null): AgentSession[] {
  if (!scope) return []
  const key = scopeKey(scope)
  return state.agents.filter((s) => scopeKey(s.scope) === key)
}

export async function startAgentIn(
  engine: string,
  scope: AgentScope,
  prompt: string,
): Promise<boolean> {
  const res = await guard(() => client.call('agent.start', { engine, scope, prompt }))
  if (!res) return false
  if ('denied' in res) {
    // §7 — a refusal explains itself; a silent no is worse than a blocked run.
    toast('error', res.reason)
    return false
  }
  state.agentDraft = ''
  // §4 — say that the anchor exists, or capturing it was pointless.
  toast(
    'ok',
    res.restorePoints.length
      ? 'session started · restore point ' + res.restorePoints[0]!.head.slice(0, 8)
      : 'session started',
  )
  return true
}


/**
 * §12 — "La liste centrale liste des workspaces, groupés par feature quand une
 * feature existe." A bare workspace and a group of three sit side by side; the
 * grouping is never forced.
 */
export interface ListGroup {
  featureId: string | null
  title: string | null
  feature: Feature | null
  workspaces: Workspace[]
}

export const workspaceGroups = computed<ListGroup[]>(() => {
  const groups: ListGroup[] = []
  const loose: Workspace[] = []
  const byFeature = new Map<string, Workspace[]>()

  for (const w of projectWorkspaces.value) {
    if (w.kind === 'group') continue
    if (w.featureId) {
      const arr = byFeature.get(w.featureId) ?? []
      arr.push(w)
      byFeature.set(w.featureId, arr)
    } else {
      loose.push(w)
    }
  }

  for (const [fid, ws] of byFeature) {
    const feature = state.features.find((f) => f.id === fid) ?? null
    groups.push({ featureId: fid, title: feature?.name ?? ws[0]?.name ?? '', feature, workspaces: ws })
  }
  groups.sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''))

  if (loose.length) groups.push({ featureId: null, title: null, feature: null, workspaces: loose })
  return groups
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
  // The feature row is written by the plan's own apply hook, so the list is
  // only true again once that has run.
  await refreshFeatures()

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
 * every repository the feature spans, like opening and rebasing it.
 */

export async function commitPreview(
  featureId: string | null,
  workspaceId: string,
  all: boolean,
): Promise<CommitPreview[]> {
  try {
    return await client.call('git.commitPreview', {
      ...(featureId ? { featureId } : { workspaceIds: [workspaceId] }),
      all,
    })
  } catch {
    // A core older than this window has no such method; the Diff tab still
    // shows the diff, which is the part that matters.
    return []
  }
}

export async function commit(
  featureId: string | null,
  workspaceId: string,
  message: string,
  all: boolean,
): Promise<boolean> {
  const res = await guard(() =>
    client.call('git.commit', {
      ...(featureId ? { featureId } : { workspaceIds: [workspaceId] }),
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
 * §4 — the step the lifecycle was missing. The feature branch goes onto the
 * base in each repository's main checkout, as one `--no-ff` merge.
 */
export async function landFeature(featureId: string, push: boolean): Promise<void> {
  const res = await guard(() => client.call('feature.land', { featureId, push }))
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

/** Every workspace mid-operation, so a feature-wide rebase can be picked up
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
 * §4 — catching a feature up is one act across every repository it spans.
 * It stops at the first conflict and keeps what already replayed; running it
 * again after resolving picks up the rest, because a branch already rebased
 * costs only a fetch.
 */
export async function rebaseFeature(featureId: string): Promise<void> {
  const res = await guard(() => client.call('feature.rebase', { featureId }))
  if (!res) return
  if (!res.ok || !res.plan) {
    toast('error', res.detail)
    return
  }
  state.pendingPlan = res.plan
}

/* ── features ────────────────────────────────────────────────────────────
 * §4 — the durable unit of work. Everything here is a thin call: the core
 * decides what is possible, the window only asks.
 */

export async function refreshFeatures(): Promise<void> {
  const [features, workspaces] = await Promise.all([
    // Closed ones included: you cannot reopen or delete what is not listed.
    client.call('feature.list', { includeArchived: true }),
    client.call('workspace.list', {}),
  ])
  state.features = features
  state.workspaces = workspaces
  ensureSelection()
}

export const projectFeatures = computed(() =>
  state.features.filter((f) => f.projectId === state.activeProjectId && f.state !== 'archived'),
)

export const liveFeature = computed(() => projectFeatures.value.find((f) => f.state === 'live') ?? null)

/** Closed, but still on record — reopenable, and deletable. */
export const archivedFeatures = computed(() =>
  state.features.filter((f) => f.projectId === state.activeProjectId && f.state === 'archived'),
)

export async function reopenFeature(featureId: string): Promise<void> {
  const res = await guard(() => client.call('feature.reopen', { featureId }))
  if (!res) return
  if (!res.ok) {
    toast('error', res.detail)
    return
  }
  await refreshFeatures()
  toast('ok', res.detail)
}

/**
 * §16 — every refusal below is a refusal to lose work, so the confirmations
 * are not ceremony. Unmerged commits are the only thing `force` unlocks,
 * because they are the only thing nothing can bring back.
 */
export async function deleteFeature(
  featureId: string,
  opts: { removeWorktrees: boolean; deleteBranches: boolean },
): Promise<void> {
  const f = state.features.find((x) => x.id === featureId)
  const run = (force: boolean) =>
    guard(() => client.call('feature.delete', { featureId, ...opts, force }))

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
      'Delete "' + (f?.name ?? 'this feature') + '" for good?',
      '',
      ...res.warnings.map((w) => '• ' + w),
    ]
    if (!window.confirm(lines.join('\n'))) return
    state.pendingPlan = res.plan
    return
  }
  await refreshFeatures()
  toast('ok', res.detail)
}

/**
 * §7 — what a new worktree will be missing, before it is created.
 *
 * Tolerated on its own: a core older than this window answers `unknown_method`,
 * and losing the whole feature sheet over the seed section would be worse than
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

/** §3.7 — opening a feature is a plan like any other: previewed, then applied. */
export async function openFeature(input: {
  name: string
  ceremony: 'C1' | 'C2' | 'C3'
  repoWorkspaceIds?: string[]
  base?: string
  seed?: SeedProposal[]
  rememberSeed?: boolean
  cloneDatabase?: boolean
}): Promise<void> {
  if (!state.activeProjectId) return
  const res = await guard(() =>
    client.call('feature.open', { projectId: state.activeProjectId!, ...input }),
  )
  if (!res) return
  state.featureDialogOpen = false
  state.pendingPlan = res.plan
}

/**
 * §8 — an exclusive runtime held elsewhere is a refusal, not a failure. The
 * second call is the user answering "yes, park the other one".
 */
export async function activateFeature(featureId: string): Promise<void> {
  const res = await guard(() => client.call('feature.activate', { featureId, force: false }))
  if (!res) return
  if (!res.ok) {
    if (!res.conflicts.length) {
      toast('error', res.detail)
      return
    }
    const ok = window.confirm(res.conflicts.join('\n') + '\n\nPark it and continue?')
    if (!ok) return
    const forced = await guard(() => client.call('feature.activate', { featureId, force: true }))
    if (!forced?.ok) return
    await refreshFeatures()
    toast('ok', forced.parked.length ? 'live — parked ' + forced.parked.join(', ') : 'live')
    return
  }
  await refreshFeatures()
  toast('ok', 'live')
}

export async function parkFeature(featureId: string): Promise<void> {
  const res = await guard(() => client.call('feature.park', { featureId }))
  if (!res) return
  await refreshFeatures()
  toast('ok', 'parked — the worktrees stay exactly where they are')
}

/** §16 — refuses over unpushed work; removing the checkouts is its own plan. */
export async function closeFeature(featureId: string, removeWorktrees: boolean): Promise<void> {
  const res = await guard(() => client.call('feature.close', { featureId, removeWorktrees }))
  if (!res) return
  if (!res.ok) {
    toast('error', res.detail)
    return
  }
  if (res.plan) {
    state.pendingPlan = res.plan
    return
  }
  await refreshFeatures()
  toast('ok', res.detail)
}

/**
 * §13 — stop the core over its own socket, then have the host spawn a fresh
 * one. Needed because this app starts the core detached: without it, picking
 * up new core code means finding a pid by hand.
 */
export async function restartCore(): Promise<void> {
  if (!host?.restartCore) {
    toast('info', 'run `cockpit restart` in a terminal — this window cannot spawn a core')
    return
  }
  toast('info', 'stopping the core…')
  try {
    await client.call('core.shutdown', undefined)
  } catch {
    // Already down, or it dropped the socket before answering. Either is fine.
  }
  const ok = await host.restartCore()
  if (!ok) {
    toast('error', 'the core did not come back — run `cockpit daemon` to see why')
    return
  }
  client.reconnectNow()
  toast('ok', 'core restarted')
}

/** §6 — the conversation is still there; the memory has moved on since. */
export async function resumeSession(sessionId: string, prompt: string): Promise<boolean> {
  const res = await guard(() => client.call('agent.resume', { sessionId, prompt }))
  if (!res) return false
  if ('denied' in res) {
    toast('error', res.reason)
    return false
  }
  toast('ok', 'resumed')
  return true
}

export const busy = ref(false)
