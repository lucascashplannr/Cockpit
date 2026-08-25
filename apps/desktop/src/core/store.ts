import { computed, reactive, ref, shallowRef } from 'vue'
import type {
  AgentSession, CockpitEvent, Feature, PlanPreview, Project, Workspace,
} from '@cockpit/shared'
import { CoreClient } from './client.js'
import type { ConnectionState } from './client.js'

/**
 * A thin reactive mirror of what the core pushes. It deliberately holds no
 * derived truth of its own: §3.4 applies to the UI too — if it is not in the
 * last push, it is not displayed.
 */

const host = (window as unknown as { cockpitHost?: { corePort: number } }).cockpitHost
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

  activeProjectId: null as string | null,
  activeWorkspaceId: null as string | null,
  activeTab: 'diff' as TabId,

  paletteOpen: false,
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
    if (s === 'connected') void bootstrap()
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
  const [projects, workspaces, features, agents, events] = await Promise.all([
    client.call('project.list', undefined),
    client.call('workspace.list', {}),
    client.call('feature.list', {}),
    client.call('agent.list', undefined),
    client.call('journal.tail', { limit: 300 }),
  ])
  state.projects = projects
  state.workspaces = workspaces
  state.features = features
  state.agents = agents
  state.events = events
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

export function selectWorkspace(id: string): void {
  state.activeWorkspaceId = id
  const w = state.workspaces.find((x) => x.id === id)
  if (w && w.projectId !== state.activeProjectId) state.activeProjectId = w.projectId
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
  if (res) toast(res.ok ? 'ok' : 'error', res.ok ? plan.operation + ' applied' : 'stopped: see journal')
}

export const busy = ref(false)
