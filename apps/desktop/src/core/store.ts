import { computed, reactive, ref, shallowRef } from 'vue'
import type {
  AddRepoSource, AgentSession, CockpitEvent, CockpitSettings, CoreStatus, Feature,
  NewProjectSource, PlanPreview, Project, Workspace,
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
  activeTab: 'diff' as TabId,

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
  toast(
    res.ok ? 'ok' : 'error',
    res.ok ? plan.operation + ' applied' : 'stopped — nothing was left behind; see the journal',
  )
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

/** §3.7 — opening a feature is a plan like any other: previewed, then applied. */
export async function openFeature(input: {
  name: string
  ceremony: 'C1' | 'C2' | 'C3'
  repoWorkspaceIds?: string[]
  base?: string
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
