/**
 * §4 — Concepts. Workspace is the primitive; Topic is a decoration.
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

/** §4 — setup levels. */
export type Setup = 'none' | 'branch' | 'isolated' | 'full'

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

/**
 * A branch this repository could be put on.
 *
 * Local and remote in one list because the question the picker answers is
 * "where do I want to be", and "it exists on origin but not here yet" is an
 * answer to that, not a different question — it just costs one more step
 * (`git switch --track`).
 */
export interface BranchRef {
  /** Short name: `dev` for a local branch, `origin/dev` for a remote one. */
  name: string
  /** HEAD is on it, in the checkout that was asked. */
  current: boolean
  /** Only on the remote so far: taking it creates a local tracking branch. */
  remoteOnly: boolean
  /**
   * The other worktree holding it, if any. Git refuses to check out a branch
   * that is already out somewhere else, and this app hands out worktrees, so
   * the picker has to say so rather than offer a step that will fail.
   */
  checkedOutAt: string | null
  upstream: string | null
  ahead: number
  behind: number
  /** Last commit on it, which is the only useful way to order the list. */
  ts: number
  subject: string
}

export interface GitState {
  branch: string | null
  /** Detached HEAD, mid-rebase, mid-merge… */
  headState: 'attached' | 'detached' | 'rebasing' | 'merging' | 'bisecting'
  upstream: string | null
  /**
   * The branch this one is worked against — what "Catch up" pulls from and
   * "Send to" goes back onto.
   *
   * Distinct from `upstream`, which is this branch's own tracking ref
   * (`origin/two-factor-auth`) and says nothing about where the work belongs.
   * Exposed so the buttons can name it: a verb that says *which direction the
   * code moves* is the whole reason they were renamed, and "Send to dev"
   * cannot be written without knowing it is dev.
   */
  base: string | null
  /**
   * Ahead of and behind `upstream` — this branch against its own tracking ref,
   * and nothing else.
   *
   * Which ref that *is* changes under you, and that is the trap: a topic branch
   * is created with `git branch <slug> origin/<base>`, so until it is pushed
   * git tracks `origin/main` and these two read against the base. `git push -u`
   * then repoints the upstream at `origin/<slug>` and the same two fields
   * silently start answering a different question. Anything about the base must
   * read `aheadOfBase` / `behindBase`; these two are for the branch's own
   * remote — what a push sends, and what a pull would bring.
   */
  ahead: number
  behind: number
  /**
   * Commits on this branch that `base` does not have — what Send would land.
   *
   * Distinct from `ahead`, and the distinction is not academic: push a topic
   * branch and `ahead` drops to zero while everything it holds is still
   * unmerged. The Send button counted `ahead` for a long time and so read
   * "nothing to send" the moment you pushed, which was survivable while it was
   * only a label and is not once the button is disabled by it.
   *
   * Null when it cannot be told — no base, or a base that does not resolve
   * locally. Unknown is not zero: the button stays live rather than blocking
   * on ignorance.
   */
  aheadOfBase: number | null
  /**
   * Commits `base` has that this branch does not — what Catch up would replay
   * this branch on top of.
   *
   * The counterpart of `aheadOfBase`, and needed for the same reason. Catch up
   * counted `behind` for a long time, which is right only for as long as the
   * upstream happens to be `origin/<base>` — that is to say, until the first
   * push. After it the count reads zero while the base has moved on, and the
   * one button whose whole job is to notice that says "already up to date".
   *
   * Null when it cannot be told — no base, or a base that does not resolve
   * locally. Unknown is not zero.
   */
  behindBase: number | null
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
  /**
   * Which files are unmerged, not merely how many.
   *
   * `operation.conflictedPaths` covers a rebase or a merge, and for a long time
   * that was every way to get one. `git stash pop` is not: it can leave markers
   * in the index with nothing in progress at all — no MERGE_HEAD, no rebase
   * directory, so no operation to continue or abort. The window still has to be
   * able to name those files and mark them resolved, and this is the only place
   * that knows them.
   */
  conflictedPaths: string[]
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
  /** `repo-slug` — unique across topics, which is what Herd and Compose key on. */
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

/**
 * §16 — a stash git took and the app never mentioned was the failure mode that
 * kept `--autostash` in the rebase plan instead of a push/pop pair. If Cockpit
 * is going to make stashes of its own, every one of them has to be listed
 * where the work it holds was taken from.
 */
export interface StashEntry {
  workspaceId: string
  repo: string
  /** `stash@{0}` — the ref as git names it, and as the plan will pass it. */
  ref: string
  /** The subject line git recorded, message and all. */
  subject: string
  /**
   * Whether a person named this entry.
   *
   * Git writes "On <branch>: <message>" when it was given one and "WIP on
   * <branch>: <sha> <subject of HEAD>" when it was not — and that second
   * form is a trap in a list: it is the subject of the commit the work was
   * sitting on, so an unnamed stash reads as though it contains that commit.
   * The window shows what it holds instead. See `files` and `paths`.
   */
  titled: boolean
  /** The first few paths in the entry, for naming one that has no name. */
  paths: string[]
  /** The branch the work was taken from. */
  branch: string | null
  ts: number
  /** Files the entry holds, so a stash is never an opaque parcel. */
  files: number
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

/**
 * §8 — what one supervised process has written, and how it ended.
 *
 * The supervisor has always captured stdout and stderr into a ring buffer and
 * nothing has ever been able to read it: `logsFor` existed, no method exposed
 * it, and the window could not tell a server that failed to boot from one that
 * booted perfectly. This is the type that closes that hole.
 */
export interface ProcessLog {
  procId: string
  label: string
  cwd: string
  startedAt: number
  status: 'running' | 'exited' | 'failed'
  exitCode: number | null
  /** Everything still in the ring, oldest first, ANSI included. */
  text: string
}

/**
 * §8 — the answer to "start this", after it has actually been tried.
 *
 * `up` used to call `spawn()` and return `{ ok: true }` on the very next line,
 * so the window said *started* whether the server was booting or had already
 * died on a missing dependency — and the status only moved on the next probe,
 * long after the toast was gone. This carries what was actually observed:
 * whether the port answered, the URL if it did, and the tail of the server's
 * own output, which is the only thing that ever explains a failure.
 */
export interface RuntimeUpResult {
  ok: boolean
  /**
   * `up` — the port answered. `starting` — the process is alive but has not
   * answered yet, which is a normal state for a slow bundler and not a
   * failure. `down` — it is gone.
   */
  status: RuntimeState['status']
  detail: string
  url: string | null
  /** How long was spent waiting for the port, in ms. */
  waitedMs: number
  /** The tail of the process's own output. Empty when there is nothing to say. */
  log: string
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
  topicId: string | null
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
 * Durable on purpose: a topic outlives the daemon, the window and the day,
 * because that is the granularity at which work is actually picked up and put
 * down. Sessions inside it stay disposable (§6) — that separation is the point.
 */
export type TopicState =
  /** Worktrees on disk, agents may run, no server is bound. */
  | 'stopped'
  /** Runtime up, ports bound, preview reachable. */
  | 'running'
  | 'closed'

export interface Topic {
  id: string
  projectId: string
  /** Human name, e.g. "Two-factor auth". */
  name: string
  /** Branch- and folder-safe form; the branch created in every repo it spans. */
  slug: string
  /**
   * §7 — the folder holding `.cockpit/memory.md` and the cross-repo
   * `CONTEXT.md`. Null for a topic merely inferred from branch names, which
   * has nowhere to keep either.
   */
  rootPath: string | null
  workspaceIds: string[]
  state: TopicState
  ticket: TicketRef | null
  review: ReviewRef | null
  setup: Setup
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

/**
 * §15 — what this machine has been told about one project.
 *
 * Machine-local for the same reason the display name is: setting one lives in
 * `~/.cockpit`, never in a file inside somebody's checkout. A team convention
 * belongs in `cockpit.yaml`, which is versioned and reviewed; "do not let me
 * commit to main on this laptop" is not a team convention, it is a handrail
 * one person put up.
 */
export interface ProjectSettings {
  /**
   * The branch this project forks from and lands on, when the probe gets it
   * wrong. Null means "ask git": `origin/HEAD`, then main, master, develop.
   * A repository whose default is `develop` and whose `main` is a stale
   * release branch is the case this exists for.
   */
  defaultBranch: string | null
  /**
   * §16 — branches Cockpit refuses to commit to, and nothing else.
   *
   * This used to be one hardcoded rule: never commit on the default branch,
   * applied to agents and people alike. For an agent that is §16 and it stays
   * absolute. For a person it was a guess about how they work, and it was
   * wrong often enough to be worth removing — plenty of repositories are
   * committed to directly, on purpose, by the one person who owns them.
   *
   * So it is opt-in and it is per project. Empty by default: nothing is locked
   * until you lock it. `*` is allowed, so `release/*` covers a family.
   */
  lockedBranches: string[]
}

export interface Project {
  id: string
  name: string
  /** §15 — this machine's settings for it. Never written into the repo. */
  settings: ProjectSettings
  /** Root folder that contains the manifest, or that was simply pointed at. */
  root: string
  /** Null when running manifest-less on detection alone (§5). */
  manifestPath: string | null
  capabilities: Capability[]
  defaultSetup: Setup
  workspaceIds: string[]
  topicIds: string[]
}

/** §7 — a lease is taken on a set of subtrees, never on a topic. */
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
 * a session was a bag of `workspaceIds` with a `topicId` bolted on the side,
 * so "an agent on this topic" and "an agent on this repo" were the same call
 * with different checkboxes ticked, and nothing downstream could tell them
 * apart. The scope is what the window, the journal and the preamble read.
 *
 * The **lease is still taken on paths and never on this** (§7: "le verrou porte
 * sur des chemins, jamais sur des topics"), which is what makes a topic
 * agent and a repo agent inside it collide exactly as they should.
 */
export type AgentScope =
  /** Every worktree the topic spans, with its memory and CONTEXT.md (§6). */
  | { kind: 'topic'; topicId: string }
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
/**
 * §16 — "Coût affiché", and §6's reason for existing: a conversation whose
 * context is filling up is one whose quality is about to fall off, and you
 * cannot act on that if nothing says it.
 *
 * Every number here is the engine's own. `window` in particular is *reported*,
 * not assumed: `claude` names the context window of the model it actually used
 * on its result event, which is the difference between a percentage that is
 * true and one that is a guess baked into a table that rots.
 */
export interface TurnUsage {
  /** Fresh prompt tokens — small, once a conversation is warm. */
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  /**
   * How full the window was for this turn: everything the model was sent,
   * cached or not. This is the number a meter is about, and it is not the sum
   * of the turn's tokens — it is the size of the conversation so far.
   */
  context: number
  /** The engine's own figure for the model it used. 0 when it did not say. */
  window: number
  /**
   * What *this* turn cost. The engine reports a running total per process, so
   * this is the delta — which is also what makes a resumed conversation add up
   * rather than start again from zero.
   */
  costUsd: number
  /** Which model actually answered, as the engine names it. */
  model: string
}

export interface AgentTurn {
  id: string
  seq: number
  prompt: string
  startedAt: number
  endedAt: number | null
  status: 'running' | 'done' | 'failed'
  /**
   * §16 — whether the tree as it stood before this turn was captured, and can
   * therefore be put back.
   *
   * Not every turn has one: a folder that has since been deleted, a snapshot
   * store that failed to initialise, and every turn taken before checkpoints
   * existed all answer no. The window offers the button only where there is
   * something behind it — an undo that might work is not an undo.
   */
  restorable: boolean
  /**
   * §16 — whether the state this turn's undo discarded is still there.
   *
   * An undo snapshots what it is about to throw away before throwing it, so
   * pressing it is not a one-way door. This is what makes that reachable
   * rather than merely true.
   */
  redoable: boolean
  /** §16 — what it cost and how full the window was. Null before it lands. */
  usage: TurnUsage | null
}

export interface Conversation {
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
  /** Which topic it was run under, when it was run under one (§4). */
  topicId: string | null
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
  /**
   * §6 — what has been said while it was still answering, in the order it goes
   * in. Live only: the queue is the running process's, so a conversation whose
   * process is gone has an empty one and nothing was lost.
   *
   * Carried on the conversation rather than fetched separately because the
   * window has to *show* it — a turn typed and then invisible until the engine
   * gets to it is indistinguishable from a turn that was dropped.
   */
  queued: string[]
  /**
   * §6 — where the conversation stands against its own limit, and what it has
   * cost so far.
   *
   * The context is the *last* turn's, not a sum: it is a level, not a total.
   * The cost is a sum, because that is what a cost is.
   */
  usage: {
    contextTokens: number
    contextWindow: number
    costUsd: number
    model: string
  } | null
  /**
   * §16 — the tools the allow-list refused during the last turn, by name.
   *
   * The engine reports them on the event that ends the turn and then stops. A
   * conversation that ends with this non-empty did not finish what it was
   * asked: it ran out of permission, and that is a question for a person
   * rather than a session to leave sitting in a list looking done.
   */
  denials: string[]
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

export interface TranscriptFile {
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

