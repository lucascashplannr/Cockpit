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

/**
 * §3.7 — a conflicted rebase is a state to work in, not an error to report.
 * Everything here is read off `.git` on every probe rather than remembered
 * (§3.4): a rebase the user advances in a terminal must show up in the window
 * exactly as one advanced by the button does.
 */
export interface GitOperation {
  kind: 'rebase' | 'merge' | 'cherry-pick' | 'revert'
  /** The branch being replayed. HEAD is detached mid-rebase, so status cannot say. */
  branch: string | null
  /** What it is being replayed onto, named if git kept the name, else a short sha. */
  onto: string | null
  /** Position in the sequence; null for a merge, which has no steps. */
  step: number | null
  total: number | null
  /** Paths git reports as unmerged — the ones actually blocking. */
  conflictedPaths: string[]
  /**
   * Of those, the ones that still carry conflict markers. Continue refuses
   * over these; a path here and not in `conflictedPaths` cannot happen.
   */
  unresolvedPaths: string[]
}

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
  /** Null whenever `headState` is `attached` or `detached`. */
  operation: GitOperation | null
}

/* ── worktree seeding (§7) ─────────────────────────────────────────────── */

/** The values that make one worktree's config its own rather than a copy. */
export interface SeedContext {
  slug: string
  /** The repository's folder name. */
  repo: string
  /** `repo-slug` — unique across features, which is what Herd and Compose key on. */
  scoped: string
  /** `scoped.test`, the hostname this worktree answers on. */
  host: string
  /**
   * Ports §11 allocated for this worktree, before it exists, keyed by service.
   * `web` is always present when one was free. A second listener — a Vite dev
   * server beside the app — gets its own entry and its own number, because two
   * servers on one port is the collision the global allocator exists to stop.
   */
  ports: Record<string, number>
  /** The per-worktree database name. */
  db: string
  /** Absolute path the worktree will land at. */
  path: string
}

/** One key inside one copied file that must not be shared between worktrees. */
export interface SeedKeyChange {
  key: string
  /** What the main checkout has, or null when the key is absent there. */
  from: string | null
  /** The rule, kept because it is what goes in the manifest: `https://{{host}}`. */
  template: string
  /** That rule resolved for this worktree — what will actually be written. */
  to: string
  /** Why Cockpit believes this value is per-worktree. Shown, not hidden. */
  reason: string
}

export interface SeedFileProposal {
  /** Relative to the repository root. */
  path: string
  bytes: number
  reason: string
  changes: SeedKeyChange[]
}

/**
 * §5 — what Cockpit proposes to carry into one repository's worktree.
 * `source` is the honest half: `detected` wants approval, `manifest` is settled.
 */
export interface SeedProposal {
  repo: string
  repoPath: string
  /** Where the worktree will land. */
  target: string
  source: 'manifest' | 'detected'
  /** Where an approval would be written, or null when there is no manifest. */
  manifestPath: string | null
  context: SeedContext
  files: SeedFileProposal[]
  /** Found and deliberately not carried, each with the reason. */
  skipped: { path: string; reason: string }[]
}

/**
 * §10 — "une base par workspace". What cloning the data for one worktree
 * involves, shown before it happens.
 */
export interface DatabasePlan {
  repo: string
  /**
   * `unknown` means the checkout names a database but never says which engine
   * serves it. Cockpit will not guess one — but staying silent about a
   * database it can see would be worse, so it is reported and not cloned.
   */
  engine: 'mysql' | 'pgsql' | 'sqlite' | 'unknown'
  /** The database the main checkout uses. */
  from: string
  /** The one this worktree will get. Null for sqlite, which needs no server. */
  to: string | null
  detail: string
  /** Client binaries this needs and could not find on PATH. */
  missingTools: string[]
}

/**
 * §16 — what one repository would contribute to a commit, before it is made.
 * The review the rule asks for needs numbers to review.
 */
export interface CommitPreview {
  workspaceId: string
  repo: string
  branch: string | null
  staged: number
  /** Unstaged plus untracked — what `all` would sweep in. */
  unstaged: number
  /** False for a repo with nothing to contribute; it is skipped, not emptied. */
  willCommit: boolean
  /** Unresolved conflicts block a commit outright. */
  conflicted: number
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

/**
 * §4 — a name + a set of workspaces, plus optional decorations.
 *
 * Durable on purpose: a feature outlives the daemon, the window and the day,
 * because that is the granularity at which work is actually picked up and put
 * down. Sessions inside it stay disposable (§6) — that separation is the point.
 */
export type FeatureState =
  /** Worktrees on disk, agents may run, no server is bound. */
  | 'parked'
  /** Runtime up, ports bound, preview reachable. */
  | 'live'
  | 'archived'

export interface Feature {
  id: string
  projectId: string
  /** Human name, e.g. "Two-factor auth". */
  name: string
  /** Branch- and folder-safe form; the branch created in every repo it spans. */
  slug: string
  /**
   * §7 — the folder holding `.cockpit/memory.md` and the cross-repo
   * `CONTEXT.md`. Null for a feature merely inferred from branch names, which
   * has nowhere to keep either.
   */
  rootPath: string | null
  workspaceIds: string[]
  state: FeatureState
  ticket: TicketRef | null
  review: ReviewRef | null
  ceremony: Ceremony
  /** Inferred from matching branch names rather than opened deliberately. */
  derived: boolean
  createdAt: number
  updatedAt: number
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

/**
 * §7 — what a session is *for*.
 *
 * The doc's scope table is four rows, and until now the code had none of them:
 * a session was a bag of `workspaceIds` with a `featureId` bolted on the side,
 * so "an agent on this feature" and "an agent on this repo" were the same call
 * with different checkboxes ticked, and nothing downstream could tell them
 * apart. The scope is what the window, the journal and the preamble read.
 *
 * The **lease is still taken on paths and never on this** (§7: "le verrou porte
 * sur des chemins, jamais sur des features"), which is what makes a feature
 * agent and a repo agent inside it collide exactly as they should.
 */
export type AgentScope =
  /** Every worktree the feature spans, with its memory and CONTEXT.md (§6). */
  | { kind: 'feature'; featureId: string }
  /** Every repository in the project, at its main checkout (§7, C0). */
  | { kind: 'project'; projectId: string }
  /** One checkout — a worktree, or a main, or a folder with no repo at all. */
  | { kind: 'workspace'; workspaceId: string }
  /** One subtree of one checkout, for when the blast radius should be smaller. */
  | { kind: 'folder'; workspaceId: string; subpath: string }

/**
 * §6 — one exchange in a conversation.
 *
 * A session used to carry a single `prompt` column that `agent.resume`
 * overwrote, so the opening question was destroyed the first time the work was
 * picked back up: exactly the state in which nobody can tell what a session was
 * ever for. Turns are append-only; the session's `title` is turn 1 and never
 * moves.
 */
export interface AgentTurn {
  id: string
  seq: number
  prompt: string
  startedAt: number
  endedAt: number | null
  status: 'running' | 'done' | 'failed'
}

export interface AgentSession {
  id: string
  engine: string
  workspaceIds: string[]
  paths: string[]
  status: 'starting' | 'idle' | 'thinking' | 'ended' | 'failed'
  startedAt: number
  endedAt: number | null
  turns: number
  leaseId: string | null
  lastMessage: string | null
  /** Which feature it was run under, when it was run under one (§4). */
  featureId: string | null
  /**
   * The engine's own resume handle (`claude --resume`, `codex exec resume`).
   * Without it a session dies with the daemon, and multi-day work is a fiction.
   */
  engineSessionId: string | null
  /** Ended, but the engine can pick the conversation back up. */
  resumable: boolean
  /** The opening prompt, kept so a resumed session is recognisable in a list. */
  prompt: string
  /** §7 — what this session is for. Resolved to `paths` at launch. */
  scope: AgentScope
  /** Turn 1's prompt, frozen: what the conversation is called, forever. */
  title: string
  /** §6 — every turn, oldest first. Append-only; a resume adds, never replaces. */
  history: AgentTurn[]
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

/**
 * §15 — what the machine remembers about how this person works, as opposed to
 * what it remembers about any one project.
 */
export interface CockpitSettings {
  /**
   * The folder holding one folder per project (§7 layout). New projects are
   * created inside it. Null until it is named: nothing is ever created at a
   * guessed path, so the new-project sheet asks for a parent instead.
   */
  devRoot: string | null
  /** Command run to open a workspace in an editor. */
  ide: string
}

/** §7 — how a project comes into existence. Three sources, one layout. */
export type NewProjectSource =
  /** An empty project folder, optionally with a first repository inside it. */
  | { kind: 'scratch'; repoName: string | null }
  /**
   * A folder that already exists. `wrap` moves it into a project folder of its
   * own — the answer when the folder picked is itself a repository, which is
   * the one shape the layout rules out.
   */
  | { kind: 'folder'; folder: string; wrap: boolean; repoName: string | null }
  /** Cloned into `<project>/<repo>`, never into the project root. */
  | { kind: 'clone'; url: string; repoName: string | null; branch: string | null }

/**
 * §7 — how a repository joins a project that already exists.
 *
 * The same three sources as a new project, minus the one that makes no sense
 * here: there is no "register it where it is", because the whole point is that
 * it ends up beside its siblings under the project root.
 */
export type AddRepoSource =
  /** `git init` in `<project>/<repo>`, with one commit so it has a branch. */
  | { kind: 'scratch'; repoName: string }
  /**
   * A folder already on this machine, moved in. It is initialised on arrival
   * if it is not a repository yet — a backend written before anyone ran
   * `git init` is still a repository waiting to happen.
   */
  | { kind: 'folder'; folder: string; repoName: string | null }
  /** Cloned into `<project>/<repo>`. */
  | { kind: 'clone'; url: string; repoName: string | null; branch: string | null }

