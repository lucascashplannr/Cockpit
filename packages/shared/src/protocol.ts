/**
 * §13 rule 1 — "L'interface n'a pas de système de fichiers."
 * Every read, list, write, spawn and terminal goes through this contract.
 * Only the address changes when the core moves to another machine (§10 C).
 */
import type { PROTOCOL_VERSION } from './protocol-version.js'
import type { CockpitEvent } from './events.js'
import type {
  AddRepoSource, AgentSession, AgentSessionFile, CockpitSettings, CommitPreview, CoreStatus,
  DatabasePlan,
  DiffFile, Feature,
  FileDiff, GitOperation, MemoryDoc, NewProjectSource, Project, SearchHit, SeedProposal,
  Workspace,
} from './model.js'

/** The outcome of acting on a conflict — always carrying the state after. */
export interface GitResolveResult {
  ok: boolean
  detail: string
  /** Null once the operation is over; otherwise where it now stands. */
  operation: GitOperation | null
  /** Paths still carrying markers, when that is why it refused. */
  unresolved: string[]
  output: string
}

/** What a folder turns out to be, for a window that cannot look for itself. */
export interface FolderInfo {
  /** Absolute, resolved by the core. */
  path: string
  exists: boolean
  isDirectory: boolean
  /** Holds nothing but the odd `.DS_Store`. */
  empty: boolean
  /** `.git` is here — the one shape the project layout rules out (§7). */
  isRepo: boolean
  /** A worktree of a repository elsewhere: it cannot be moved on its own. */
  isWorktree: boolean
  /** Repositories one level down: the layout, already in place. */
  childRepos: string[]
  /** Its first remote, when it has one. */
  remote: string | null
  /** Already registered as a project — its id, or null. */
  projectId: string | null
}

export interface ConfigView {
  settings: CockpitSettings
  /**
   * Where projects already live, when they agree: the parent folder most of
   * the registered ones share. It is a suggestion for the Dev folder and never
   * a value — nothing is created at a path nobody confirmed.
   */
  suggestedDevRoot: string | null
}

export interface FileEntry {
  name: string
  path: string
  kind: 'file' | 'dir' | 'symlink'
  size: number
  /** Used for the mtime check before writing (§16, concurrence). */
  mtimeMs: number
  gitStatus: string | null
}

export interface PlanStep {
  title: string
  command: string
  cwd: string
  /** Destructive steps are rendered in red and require confirmation (§3.7). */
  destructive: boolean
  /**
   * The binary this step runs, when it is not git.
   *
   * A plan could only ever run git until a database had to be cloned per
   * worktree (§10, "une base par workspace"), and `mysqldump` is not git. It
   * is opt-in rather than inferred from the command string so that the narrow
   * property stays the default: a step with no `run` cannot execute anything
   * but git, whatever its text says.
   *
   * Secrets never appear here. A password reaches the process through the
   * environment, which §16 keeps out of the journal — so what is previewed is
   * exactly what the user should see, and nothing more.
   */
  run?: string
  /**
   * How to take this step back. A plan spanning several repos must not be left
   * half-applied: if step 3 fails, the undos of steps 1-2 run in reverse (§3.7).
   * A list, because undoing `git worktree add -b` is two commands, not one.
   * Each carries its own `run` for the same reason the step does: the undo of
   * `createdb` is `dropdb`, a different binary entirely.
   */
  undo?: { title: string; command: string; cwd: string; run?: string }[]
}

export interface PlanPreview {
  planId: string
  operation: string
  steps: PlanStep[]
  warnings: string[]
  /** Whether applying will first capture a restore point (§16). */
  capturesRestorePoint: boolean
  /** Every repository the plan touches, so the UI can say how wide it reaches. */
  repos?: string[]
  /**
   * §3.7 — what a failed step means for the steps that already ran.
   *
   * `rollback` is all-or-nothing and the default: three worktrees of which one
   * failed is worse than none. `halt` stops and keeps what succeeded, which is
   * the only honest answer for a rebase — the conflict is a state to work in,
   * and undoing the two repositories that rebased cleanly to "recover" from it
   * would throw away the work the user is about to finish.
   */
  onFailure?: 'rollback' | 'halt'
}

/**
 * What `git.apply` reports. A halted plan is not a failure: it is the plan
 * having reached something only a person can decide.
 */
export interface ApplyResult {
  ok: boolean
  output: string
  restorePoint: string | null
  /**
   * Set when a step stopped on a conflict rather than an error. The workspace
   * named is the one to open; `git.state` there has the detail.
   */
  conflict?: { workspaceId: string; repo: string; kind: string }
  /** Steps that never ran because an earlier one halted. */
  remaining?: number
}

/** Every method: params in, result out. */
export interface Rpc {
  'core.status': { params: void; result: CoreStatus }
  'core.reconcile': { params: { projectId?: string }; result: { changed: number } }
  'core.shutdown': { params: void; result: { ok: true } }

  'project.list': { params: void; result: Project[] }
  'project.add': { params: { root: string }; result: Project }
  'project.forget': { params: { projectId: string }; result: { ok: true } }
  'project.rescan': { params: { projectId: string }; result: Project }
  /** `name: null` clears the override and falls back to the manifest or folder. */
  'project.rename': { params: { projectId: string; name: string | null }; result: Project }
  /**
   * Re-points the project at another folder. With `moveFiles`, the folder is
   * moved there first. The project's id is derived from its path, so the result
   * carries a new id — the caller must re-select it (§3.4).
   */
  'project.move': {
    params: { projectId: string; root: string; moveFiles: boolean }
    result: Project
  }
  /** To the system Trash, never `rm -rf`, and never over live or unpushed work. */
  'project.trash': { params: { projectId: string }; result: { ok: true; trashed: string } }
  /**
   * §7 — creates the folder layout, then registers what it created. `project.add`
   * takes what is already there; this one is the other half, and the only path
   * by which a repository ever lands one level below the project root rather
   * than at it. All or nothing: a clone that fails leaves no folder behind.
   */
  'project.create': {
    params: { name: string; parent: string; source: NewProjectSource }
    result: Project
  }

  /**
   * §7 — the second repository, and every one after it. It lands in
   * `<project>/<repo>`, beside the ones already there.
   *
   * The one project this cannot be done to as it stands is the one whose root
   * is itself a repository: there is nowhere to put a sibling. `wrapRootAs`
   * names the folder that repository moves into first, which frees the root —
   * it is required in that case and ignored in every other, so the caller has
   * to have said it out loud before anything moves.
   */
  'project.addRepo': {
    params: { projectId: string; source: AddRepoSource; wrapRootAs?: string | null }
    result: {
      project: Project
      /** Absolute path of the repository that just joined. */
      repoPath: string
      /** The folder the root repository was moved into, when it had to move. */
      wrapped: string | null
      /** Whether `repos:` in the manifest was updated to match (§5). */
      manifestUpdated: boolean
      /** `git init` worked, the first commit did not — usually no user.email. */
      note: string | null
    }
  }

  /**
   * §13 rule 1 — the window has no filesystem, so it cannot know whether the
   * folder someone just picked is a repository, is already the right shape, or
   * is a name already taken. It asks.
   */
  'project.inspect': { params: { path: string }; result: FolderInfo }

  'config.get': { params: void; result: ConfigView }
  /** Only the keys present are written; the rest keep their value. */
  'config.set': { params: Partial<CockpitSettings>; result: ConfigView }

  'workspace.list': { params: { projectId?: string }; result: Workspace[] }
  'workspace.get': { params: { workspaceId: string }; result: Workspace | null }
  'workspace.probe': { params: { workspaceId: string }; result: Workspace }
  'workspace.openIn': {
    params: { workspaceId: string; target: 'ide' | 'finder' | 'browser'; path?: string }
    result: { ok: boolean; detail?: string }
  }

  'feature.list': { params: { projectId?: string; includeArchived?: boolean }; result: Feature[] }
  'feature.get': { params: { featureId: string }; result: Feature | null }
  /**
   * §4 — opening a feature is one plan across N repositories, previewed before
   * anything is created and rolled back as a unit if any repo fails. The
   * feature is only recorded once that plan applies.
   */
  'feature.open': {
    params: {
      projectId: string
      name: string
      ceremony: 'C1' | 'C2' | 'C3'
      /** Workspace ids of the main checkouts to span. Empty means all of them. */
      repoWorkspaceIds?: string[]
      /** Branch to fork from; defaults to each repo's own default branch. */
      base?: string
      ticketUrl?: string
      /**
       * §7 — the local config to carry into each worktree, as approved by the
       * caller. Omit and only what `cockpit.yaml` declares is applied: a
       * detected proposal nobody has seen never writes to anyone's `.env`.
       */
      seed?: SeedProposal[]
      /** §5 — write that answer into cockpit.yaml, so the next one is free. */
      rememberSeed?: boolean
      /**
       * §10 — give each worktree its own copy of the data, so a migration run
       * in one cannot break the others. Off unless asked: it copies a whole
       * database, which is slow and costs the disk again.
       */
      cloneDatabase?: boolean
    }
    result: { plan: PlanPreview; featureId: string }
  }
  /**
   * §7 — what a new worktree would be missing, per repository, and the values
   * that must differ from the main checkout's. Detected from disk unless
   * `cockpit.yaml` already declares it, which the `source` field says.
   */
  'worktree.seedPreview': {
    params: { projectId: string; repoWorkspaceIds?: string[]; slug: string }
    result: SeedProposal[]
  }
  /**
   * §10 — what giving each worktree its own database would involve, read out
   * of each repository's own `.env`. Null entries are repositories that use
   * no database at all, which is most of them.
   */
  'database.preview': {
    params: { projectId: string; repoWorkspaceIds?: string[]; slug: string }
    result: DatabasePlan[]
  }
  /** Bring its runtimes up. Refuses when an exclusive runtime is held elsewhere. */
  'feature.activate': {
    params: { featureId: string; force?: boolean }
    result: { ok: boolean; detail: string; parked: string[]; conflicts: string[] }
  }
  /** Take its runtimes down and free the exclusive resources. Worktrees stay. */
  'feature.park': { params: { featureId: string }; result: { ok: boolean; detail: string } }
  'feature.rename': { params: { featureId: string; name: string }; result: Feature }
  /**
   * §16 — closing refuses over unpushed commits and live work; removing the
   * worktrees is a plan of its own, never a silent `rm -rf`.
   */
  'feature.close': {
    params: { featureId: string; removeWorktrees: boolean }
    result: { ok: boolean; detail: string; plan: PlanPreview | null }
  }
  /**
   * §4 — one plan that replays every repository the feature spans onto its
   * base. It stops at the first conflict and keeps what already replayed;
   * running it again after resolving picks up the rest.
   */
  'feature.rebase': {
    params: { featureId: string; base?: string }
    result: { ok: boolean; detail: string; plan: PlanPreview | null }
  }
  /**
   * §4 — the step the lifecycle was missing: the feature branch goes onto the
   * base, in each repository's MAIN checkout, as one identifiable `--no-ff`
   * merge. Halts on the first conflict and keeps what already merged.
   */
  'feature.land': {
    params: { featureId: string; push?: boolean; base?: string }
    result: { ok: boolean; detail: string; plan: PlanPreview | null }
  }
  /** Archiving is not a one-way door; this is how a closed feature comes back. */
  'feature.reopen': { params: { featureId: string }; result: { ok: boolean; detail: string } }
  /**
   * §16 — the record goes for good. Refuses over anything that would lose work;
   * deleting a branch with unmerged commits is the one thing `force` unlocks,
   * because it is the one thing nothing can undo.
   */
  'feature.delete': {
    params: {
      featureId: string
      removeWorktrees: boolean
      deleteBranches: boolean
      /** §10 — drop the per-worktree databases. There is no Trash for those. */
      dropDatabases?: boolean
      force?: boolean
    }
    result: { ok: boolean; detail: string; warnings: string[]; plan: PlanPreview | null }
  }

  'fs.list': { params: { workspaceId: string; rel: string }; result: FileEntry[] }
  'fs.read': {
    params: { workspaceId: string; rel: string }
    result: { content: string; mtimeMs: number; truncated: boolean; binary: boolean }
  }
  'fs.write': {
    params: { workspaceId: string; rel: string; content: string; expectMtimeMs: number | null }
    result: { ok: boolean; conflict?: boolean; mtimeMs: number }
  }
  'fs.tracked': { params: { workspaceId: string }; result: string[] }

  'search.text': {
    params: { workspaceIds: string[]; query: string; regex?: boolean; caseSensitive?: boolean; max?: number }
    result: { hits: SearchHit[]; truncated: boolean; engine: string }
  }

  'diff.files': { params: { workspaceId: string; base?: string }; result: DiffFile[] }
  'diff.file': { params: { workspaceId: string; path: string; base?: string }; result: FileDiff }

  /**
   * §16 — "revue humaine du diff avant tout commit". The review existed and
   * the commit did not, which left `feature.close` refusing over a state
   * nothing in the app could clear. One message, one commit per repository.
   */
  'git.commitPreview': {
    params: { featureId?: string; workspaceIds?: string[]; all: boolean }
    result: CommitPreview[]
  }
  'git.commit': {
    params: { featureId?: string; workspaceIds?: string[]; message: string; all: boolean }
    result: { ok: boolean; detail: string; plan: PlanPreview | null; preview: CommitPreview[] }
  }

  'git.plan': {
    params: { workspaceId: string; operation: 'rebase' | 'merge' | 'branch' | 'worktree' | 'push' | 'sync'; args?: Record<string, string> }
    result: PlanPreview
  }
  'git.apply': { params: { planId: string }; result: ApplyResult }
  'git.undo': { params: { workspaceId: string }; result: { ok: boolean; detail: string } }
  /**
   * §3.7 — the state a stopped operation left behind, re-probed on every call.
   * Null means nothing is in progress, which is the answer most of the time.
   */
  'git.state': { params: { workspaceId: string }; result: GitOperation | null }
  /**
   * The three verbs that end a conflict. `continue` refuses over files still
   * carrying markers and stages the rest itself, so resolving in an editor is
   * enough — nobody has to remember `git add`.
   */
  'git.resolve': {
    params: { workspaceId: string; action: 'continue' | 'abort' | 'skip' }
    result: GitResolveResult
  }
  /** Marks paths resolved by hand — the escape hatch for a file meant to
   *  contain conflict markers, which `continue` refuses over on purpose. */
  'git.stage': { params: { workspaceId: string; paths: string[] }; result: GitResolveResult }
  'git.log': {
    params: { workspaceId: string; limit?: number }
    result: { hash: string; subject: string; author: string; ts: number; refs: string }[]
  }

  'runtime.up': { params: { workspaceId: string }; result: { ok: boolean; detail: string } }
  'runtime.down': { params: { workspaceId: string }; result: { ok: boolean; detail: string } }
  'runtime.health': { params: { workspaceId: string }; result: { status: string; detail: string } }
  'runtime.preview': { params: { workspaceId: string }; result: { kind: 'url' | 'qr' | 'none'; value?: string } }

  'ports.map': { params: void; result: { port: number; owner: string; name: string }[] }

  'agent.engines': { params: void; result: { id: string; available: boolean; bin: string }[] }
  'agent.start': {
    params: {
      engine: string
      workspaceIds: string[]
      prompt: string
      ceremony?: string
      /** Scopes the session to a feature: its memory and CONTEXT.md are prepended. */
      featureId?: string
    }
    result: { sessionId: string } | { denied: true; reason: string }
  }
  /**
   * §6 — the session is disposable, the memory is not. Resuming hands the
   * engine back its own conversation; starting fresh against the same memory
   * is the other half of the same idea.
   */
  'agent.resume': {
    params: { sessionId: string; prompt: string }
    result: { sessionId: string } | { denied: true; reason: string }
  }
  'agent.list': { params: void; result: AgentSession[] }
  'agent.stop': { params: { sessionId: string }; result: { ok: true } }
  /**
   * Both engines run one-shot with the prompt as an argument and their stdin
   * closed, so there is no live conversation to write into. This always
   * refuses, and says which way round it is: finish, then `agent.resume`.
   */
  'agent.send': { params: { sessionId: string }; result: { ok: false; reason: string } }

  'memory.read': { params: { workspaceId: string }; result: MemoryDoc | null }
  'memory.write': { params: { workspaceId: string; content: string }; result: { ok: true } }
  'memory.promote': { params: { workspaceId: string; section: string; text: string }; result: { ok: true } }
  'memory.sessions': { params: { workspaceId: string }; result: AgentSessionFile[] }

  'journal.tail': {
    params: { workspaceId?: string; projectId?: string; limit?: number; types?: string[] }
    result: CockpitEvent[]
  }

  'lease.list': { params: void; result: import('./model.js').LeaseInfo[] }
  'lease.release': { params: { leaseId: string }; result: { ok: true } }

  'terminal.open': { params: { workspaceId: string; cols: number; rows: number; shell?: string }; result: { termId: string } }
  'terminal.write': { params: { termId: string; data: string }; result: { ok: true } }
  'terminal.resize': { params: { termId: string; cols: number; rows: number }; result: { ok: true } }
  'terminal.close': { params: { termId: string }; result: { ok: true } }
}

export type RpcMethod = keyof Rpc
export type RpcParams<M extends RpcMethod> = Rpc[M]['params']
export type RpcResult<M extends RpcMethod> = Rpc[M]['result']

export interface RpcRequest<M extends RpcMethod = RpcMethod> {
  t: 'req'
  id: number
  method: M
  params: RpcParams<M>
}

export interface RpcResponse {
  t: 'res'
  id: number
  ok: boolean
  result?: unknown
  error?: { code: string; message: string; detail?: unknown }
}

/** Server-pushed messages. */
export type ServerPush =
  | { t: 'hello'; protocol: typeof PROTOCOL_VERSION; core: CoreStatus }
  | { t: 'event'; event: CockpitEvent }
  /** Pushed on every project mutation, so every window's rail stays true. */
  | { t: 'projects'; projects: Project[] }
  | { t: 'workspaces'; workspaces: Workspace[] }
  | { t: 'features'; features: Feature[] }
  | { t: 'agents'; sessions: AgentSession[] }
  | { t: 'term'; termId: string; data: string }
  | { t: 'term-exit'; termId: string; code: number }

export type ClientMessage = RpcRequest
export type ServerMessage = RpcResponse | ServerPush
