/**
 * §4 — Concepts. Workspace is the primitive; Feature is a decoration.
 */

export type WorkspaceKind = 'main' | 'worktree' | 'group' | 'external'

/** §5 — the capability set. Absent = invisible, never greyed out (§3.9). */
export type CapabilityId =
  | 'vcs'
  | 'tickets'
  | 'review'
  | 'ci'
  | 'runtime'
  | 'agents'
  | 'docs'
  | 'memory'

export interface Capability {
  id: CapabilityId
  /** Which implementation is behind it, e.g. `git`, `github`, `herd`, `compose`. */
  impl: string
  /** Detected from disk vs. declared in the manifest. */
  source: 'detected' | 'manifest'
  detail?: Record<string, unknown>
}

/** §4 — ceremony levels. */
export type Ceremony = 'C0' | 'C1' | 'C2' | 'C3'

export interface GitState {
  branch: string | null
  /** Detached HEAD, mid-rebase, mid-merge… */
  headState: 'attached' | 'detached' | 'rebasing' | 'merging' | 'bisecting'
  upstream: string | null
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
  lastCommit: { hash: string; subject: string; author: string; ts: number } | null
  /** §16 — refuse to tear down a workspace holding unpushed commits. */
  hasUnpushedWork: boolean
}

export interface RuntimeState {
  impl: string
  status: 'unknown' | 'down' | 'starting' | 'up' | 'unhealthy'
  /** §8 — `preview` may return a URL, a QR payload, or nothing at all. */
  preview: { kind: 'url' | 'qr' | 'none'; value?: string } | null
  ports: PortAllocation[]
  portable: boolean
  exclusive: boolean
  processes: SupervisedProcess[]
}

export interface PortAllocation {
  /** Logical name inside the project, e.g. `web`, `api`, `bundler`. */
  name: string
  port: number
  /** §11 — allocation is global across all projects, not per project. */
  scope: 'global'
}

export interface SupervisedProcess {
  id: string
  label: string
  pid: number | null
  status: 'running' | 'exited' | 'failed'
  startedAt: number
  exitCode: number | null
  cwd: string
}

export interface Workspace {
  id: string
  projectId: string
  kind: WorkspaceKind
  /** Display name; for a worktree, usually the branch. */
  name: string
  path: string
  /** Absent for `external` workspaces with no repo (§7). */
  repo: string | null
  git: GitState | null
  runtime: RuntimeState | null
  /** Null is the normal case, not the exception (§4). */
  featureId: string | null
  capabilities: Capability[]
  /** Active agent sessions whose scope covers this path. */
  agentSessions: string[]
  lease: LeaseInfo | null
  hasMemory: boolean
  lastProbedAt: number
  /** Disk footprint, surfaced because it accumulates silently (§16). */
  diskBytes: number | null
}

/** §4 — a name + a set of workspaces, plus optional decorations. */
export interface Feature {
  id: string
  projectId: string
  name: string
  workspaceIds: string[]
  ticket: TicketRef | null
  review: ReviewRef | null
  ceremony: Ceremony
  createdAt: number
  archived: boolean
}

export interface TicketRef {
  provider: string
  key: string
  title: string
  status: string
  url: string
}

export interface ReviewRef {
  provider: string
  number: number
  title: string
  state: 'draft' | 'open' | 'merged' | 'closed'
  url: string
  ci: 'unknown' | 'pending' | 'passing' | 'failing'
}

export interface Project {
  id: string
  name: string
  /** Root folder that contains the manifest, or that was simply pointed at. */
  root: string
  /** Null when running manifest-less on detection alone (§5). */
  manifestPath: string | null
  capabilities: Capability[]
  defaultCeremony: Ceremony
  workspaceIds: string[]
  featureIds: string[]
}

/** §7 — a lease is taken on a set of subtrees, never on a feature. */
export interface LeaseInfo {
  id: string
  holder: string
  paths: string[]
  acquiredAt: number
  expiresAt: number | null
  reason: string
}

export interface AgentSession {
  id: string
  engine: string
  workspaceIds: string[]
  paths: string[]
  status: 'starting' | 'idle' | 'thinking' | 'ended' | 'failed'
  startedAt: number
  endedAt: number | null
  costUsd: number
  turns: number
  leaseId: string | null
  lastMessage: string | null
}

export interface DiffFile {
  path: string
  oldPath: string | null
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'U'
  additions: number
  deletions: number
  /** §12 — the human/agent split, resolved from the journal. */
  attribution: 'human' | 'agent' | 'mixed' | 'unknown'
  binary: boolean
}

export interface DiffHunkLine {
  kind: 'context' | 'add' | 'del' | 'meta'
  oldLine: number | null
  newLine: number | null
  text: string
}

export interface FileDiff {
  path: string
  binary: boolean
  lines: DiffHunkLine[]
}

export interface SearchHit {
  workspaceId: string
  path: string
  line: number
  column: number
  text: string
}

export interface MemoryDoc {
  path: string
  content: string
  sections: { title: string; body: string }[]
  updatedAt: number | null
}

export interface AgentSessionFile {
  id: string
  path: string
  startedAt: number
  engine: string
  bytes: number
}

export interface CoreStatus {
  version: string
  protocol: { major: number; minor: number }
  pid: number
  startedAt: number
  journalEvents: number
  projects: number
  workspaces: number
  activeLeases: number
  activeProcesses: number
}
