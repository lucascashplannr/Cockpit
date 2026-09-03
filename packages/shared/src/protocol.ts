/**
 * §13 rule 1 — "L'interface n'a pas de système de fichiers."
 * Every read, list, write, spawn and terminal goes through this contract.
 * Only the address changes when the core moves to another machine (§10 C).
 */
import type { PROTOCOL_VERSION } from './protocol-version.js'
import type { CockpitEvent } from './events.js'
import type {
  AddRepoSource, AgentScope, BranchRef, Conversation, TranscriptFile, CockpitSettings,
  CommitPreview, CoreStatus,
  DatabasePlan,
  DiffFile, Topic,
  FileDiff, GitOperation, MemoryDoc, NewProjectSource, ProcessLog, Project, RuntimeUpResult,
  ProjectSettings, SearchHit, SeedProposal, StashEntry,
  Workspace,
} from './model.js'

/**
 * §11 — one row of "what is running on this machine, and whose is it".
 *
 * The port allocator has always been able to list its assignments, and the
 * window has never asked: `ports.map` answers in project and workspace ids,
 * which is not something a person can read. This is the same information with
 * the names resolved and the health attached, which is the whole of the
 * question "which of my worktrees is on which port".
 */
export interface ServerBoardRow {
  workspaceId: string
  workspace: string
  projectId: string
  project: string
  /** The topic this checkout belongs to, when it belongs to one (§4). */
  topic: string | null
  branch: string | null
  impl: string
  status: string
  url: string | null
  ports: { name: string; port: number }[]
  /** Processes this core is supervising for it. */
  processes: number
}

/**
 * §7 — starting is allowed to refuse, and a refusal that does not say what to
 * do instead is a dead end. `remedy` is the offer the window can act on.
 */
/**
 * How the engine is asked to run: chosen in the composer, remembered by the
 * window, and passed again on resume so a thread stays on the model it was
 * started with. Not persisted core-side — that would be a schema change for
 * something the window is the source of truth for anyway.
 */
export interface EngineOptions {
  /** An alias the engine understands: `opus`, `sonnet`, `haiku`. */
  model?: string
  /** `low` | `medium` | `high` | `xhigh` | `max`. */
  effort?: string
  /** §3.7 — reads and proposes, writes nothing. */
  plan?: boolean
}

export type AgentStartResult =
  | { sessionId: string; restorePoints: { workspaceId: string; head: string }[] }
  | { denied: true; reason: string; remedy?: { kind: 'branch'; workspaceIds: string[] } }

/** One path a scope resolves to, and what running there would mean. */
export interface AgentScopePath {
  workspaceId: string
  name: string
  path: string
  /** Null for a folder with no repository at all (§7, last row of the table). */
  branch: string | null
  kind: string
  /** On its repository's default branch: allowed, but a restore point first. */
  onProtectedBranch: boolean
  /** Held by another session; this scope cannot start until it is released. */
  leasedBy: string | null
}

/** What `agent.start` would do with this scope, before it is asked to do it. */
/**
 * §7 — why a scope cannot be started on, said in terms a person can act on.
 *
 * This was a list of sentences already joined together — "Init — held by
 * agent:claude" — which named the internal holder string and nothing else: not
 * which conversation, not when, not whether anything was still running behind
 * it. A lock nobody can trace to a cause reads as the app being broken.
 *
 * One entry per *lease*, not per workspace: a topic-wide session holds one
 * lease over both its repositories, and saying the same sentence twice was the
 * loudest part of the banner.
 */
export interface ScopeBlock {
  leaseId: string
  /** Every workspace of this scope that this one lease covers, by name. */
  names: string[]
  /** The conversation holding it, when it is one this core still knows. */
  sessionId: string | null
  /** What that conversation was asked — the lease carries it already. */
  reason: string
  acquiredAt: number
  /**
   * Whether anything is actually running behind it.
   *
   * A lease can outlive its process — a core killed mid-turn leaves one for up
   * to its six-hour TTL — and that is a leftover to clear, not a colleague to
   * wait for. The two look identical until this says which.
   */
  live: boolean
}

export interface AgentScopePreview {
  scope: AgentScope
  label: string
  paths: AgentScopePath[]
  /** Non-empty when a lease already covers part of the scope: start will refuse. */
  blocked: ScopeBlock[]
  /** Whether a topic memory / cross-repo CONTEXT.md will be prepended (§6). */
  preamble: { memory: boolean; context: boolean }
}

/** §3.7 — the size of what an undo would discard, per repository. */
export interface RevertPreviewEntry {
  workspaceId: string
  name: string
  files: number
  insertions: number
  deletions: number
}

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
   * §15 — the machine's settings for one project. Merged, not replaced: the
   * window sends the field it changed and nothing else.
   */
  'project.settings': {
    params: { projectId: string; patch: Partial<ProjectSettings> }
    result: Project
  }
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

  'topic.list': { params: { projectId?: string; includeArchived?: boolean }; result: Topic[] }
  'topic.get': { params: { topicId: string }; result: Topic | null }
  /**
   * §4 — opening a topic is one plan across N repositories, previewed before
   * anything is created and rolled back as a unit if any repo fails. The
   * topic is only recorded once that plan applies.
   */
  'topic.open': {
    params: {
      projectId: string
      name: string
      setup: 'branch' | 'isolated' | 'full'
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
    result: { plan: PlanPreview; topicId: string }
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
  'topic.start': {
    params: { topicId: string; force?: boolean }
    result: {
      ok: boolean
      detail: string
      stoppedTopics: string[]
      conflicts: string[]
      /**
       * §8 — one entry per repository asked to start, and what came of it. A
       * topic spanning three repositories where one server died is neither
       * started nor failed; it is this list, and the window can only name the
       * one that broke if it is told which one broke.
       */
      servers: {
        workspaceId: string
        name: string
        impl: string
        ok: boolean
        status: string
        detail: string
        url: string | null
        log: string
      }[]
    }
  }
  /** Take its runtimes down and free the exclusive resources. Worktrees stay. */
  'topic.stop': { params: { topicId: string }; result: { ok: boolean; detail: string } }
  'topic.rename': { params: { topicId: string; name: string }; result: Topic }
  /**
   * §16 — closing refuses over unpushed commits and live work; removing the
   * worktrees is a plan of its own, never a silent `rm -rf`.
   */
  'topic.close': {
    params: { topicId: string; removeWorktrees: boolean }
    result: { ok: boolean; detail: string; plan: PlanPreview | null }
  }
  /**
   * §4 — one plan that replays every repository the topic spans onto its
   * base. It stops at the first conflict and keeps what already replayed;
   * running it again after resolving picks up the rest.
   */
  'topic.rebase': {
    params: { topicId: string; base?: string }
    result: { ok: boolean; detail: string; plan: PlanPreview | null }
  }
  /**
   * §4 — the step the lifecycle was missing: the topic branch goes onto the
   * base, in each repository's MAIN checkout, as one identifiable `--no-ff`
   * merge. Halts on the first conflict and keeps what already merged.
   */
  'topic.merge': {
    params: { topicId: string; push?: boolean; base?: string }
    result: { ok: boolean; detail: string; plan: PlanPreview | null }
  }
  /**
   * §4 — every branch of the topic to origin, in one act.
   *
   * The counterpart of what the commit box deliberately does not do. One
   * message across two different diffs is a lie in one of them, so committing
   * is per repository; a push carries no words, so there is nothing to be
   * wrong about doing them together.
   */
  'topic.push': {
    params: { topicId: string }
    result: { ok: boolean; detail: string; plan: PlanPreview | null }
  }
  /** Archiving is not a one-way door; this is how a closed topic comes back. */
  'topic.reopen': { params: { topicId: string }; result: { ok: boolean; detail: string } }
  /**
   * §16 — the record goes for good. Refuses over anything that would lose work;
   * deleting a branch with unmerged commits is the one thing `force` unlocks,
   * because it is the one thing nothing can undo.
   */
  'topic.delete': {
    params: {
      topicId: string
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
   * the commit did not, which left `topic.close` refusing over a state
   * nothing in the app could clear. One message, one commit per repository.
   */
  'git.commitPreview': {
    params: { topicId?: string; workspaceIds?: string[]; all: boolean }
    result: CommitPreview[]
  }
  'git.commit': {
    params: { topicId?: string; workspaceIds?: string[]; message: string; all: boolean }
    result: { ok: boolean; detail: string; plan: PlanPreview | null; preview: CommitPreview[] }
  }

  /**
   * §16 — the message is drafted, never committed. The engine reads the diff
   * and proposes a sentence into the same field a person types in; what gets
   * committed is whatever stands there after they have read it. A draft that
   * arrives already committed would be an agent committing, which §16 forbids
   * and §12 could not attribute.
   */
  'git.draftMessage': {
    params: { topicId?: string; workspaceIds?: string[]; all: boolean; hint?: string }
    result: { ok: boolean; detail: string; message: string; engine: string; truncated: boolean }
  }

  /**
   * §16 — every stash this app makes, listed where the work was taken from.
   * A stash nothing mentions is how uncommitted work disappears, which is the
   * reason the rebase plan uses `--autostash` and not a push/pop pair.
   */
  'git.stashList': { params: { topicId?: string; workspaceIds?: string[] }; result: StashEntry[] }
  'git.stash': {
    params: {
      topicId?: string
      workspaceIds?: string[]
      action: 'push' | 'pop' | 'apply' | 'drop'
      /** push only. */
      message?: string
      /** push only — untracked files come along, which is what "set aside" means. */
      includeUntracked?: boolean
      /** pop/apply/drop — the entry, in the workspace it belongs to. */
      workspaceId?: string
      ref?: string
    }
    result: { ok: boolean; detail: string; plan: PlanPreview | null }
  }

  /**
   * §2 — "on ne cache pas git". Every branch this checkout could be put on,
   * local and remote, with the tracking counts and — because this app hands
   * out worktrees — where each one is already checked out.
   */
  'git.branches': { params: { workspaceId: string }; result: BranchRef[] }
  'git.plan': {
    params: {
      workspaceId: string
      operation: 'rebase' | 'merge' | 'branch' | 'switch' | 'worktree' | 'push' | 'pull' | 'sync'
      args?: Record<string, string>
    }
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

  /**
   * §8 — starts the servers and waits for them to answer, so the result is
   * what was observed rather than what was attempted. It can therefore take
   * as long as the server takes to boot; `status` distinguishes a server that
   * is up from one that is merely still coming up.
   */
  'runtime.up': { params: { workspaceId: string }; result: RuntimeUpResult }
  'runtime.down': { params: { workspaceId: string }; result: { ok: boolean; detail: string } }
  'runtime.health': { params: { workspaceId: string }; result: { status: string; detail: string } }
  'runtime.preview': { params: { workspaceId: string }; result: { kind: 'url' | 'qr' | 'none'; value?: string } }
  /**
   * §8 — what this workspace's servers have written, the ones that already
   * died included. The supervisor has captured this since it was written and
   * nothing has ever been able to read it, which is why a server that failed
   * to boot and one that booted looked identical from the window.
   */
  'runtime.logs': { params: { workspaceId: string }; result: ProcessLog[] }

  'ports.map': { params: void; result: { port: number; owner: string; name: string }[] }
  /**
   * §11 — every port this machine has handed out, with the workspace and topic
   * behind it resolved. `ports.map` answers in ids; this answers in names,
   * which is what a window showing "what is running where" needs.
   */
  'runtime.board': { params: void; result: ServerBoardRow[] }

  'agent.engines': { params: void; result: { id: string; available: boolean; bin: string }[] }
  /**
   * §7 — the scope says what the session is for; the core resolves it to the
   * paths the lease is taken on. `workspaceIds` is still accepted for a caller
   * that only knows where it is standing, and is read as a workspace scope.
   */
  'agent.start': {
    params: {
      engine: string
      scope?: AgentScope
      /** Legacy form: one or more workspaces, read as `{ kind: 'workspace' }`. */
      workspaceIds?: string[]
      prompt: string
      setup?: string
      /** Scopes the session to a topic: its memory and CONTEXT.md are prepended. */
      topicId?: string
      options?: EngineOptions
    }
    result: AgentStartResult
  }
  /**
   * §7 — what a scope would actually do, before it is asked to do it: which
   * paths, which of them are on a protected branch, and what the lease would
   * collide with. The window shows this under the composer so a refusal never
   * arrives after the prompt has been written.
   */
  'agent.preview': {
    params: { scope: AgentScope }
    result: AgentScopePreview
  }
  /**
   * §6 — the session is disposable, the memory is not. Resuming hands the
   * engine back its own conversation; starting fresh against the same memory
   * is the other half of the same idea.
   */
  'agent.resume': {
    params: { sessionId: string; prompt: string; options?: EngineOptions }
    result: AgentStartResult
  }
  'agent.list': { params: void; result: Conversation[] }
  'agent.stop': { params: { sessionId: string }; result: { ok: true } }
  /**
   * §6 — the conversation removed, and only the conversation.
   *
   * The turns and the row in the list go; the journal, the checkpoints and the
   * per-path attribution stay, because those record what happened to the code
   * rather than what was said about it. Refuses while the engine is still
   * running: stopping is its own decision.
   */
  'agent.delete': {
    params: { sessionId: string }
    result: { ok: true } | { ok: false; reason: string }
  }
  /**
   * §6 — a turn written into a conversation that is already open.
   *
   * A streaming engine holds one process for the whole conversation with its
   * stdin open, so this is how the second question reaches the first session
   * rather than starting a new one. Sent while the engine is still working it
   * is *queued*, not refused: typing the next thing before the current turn
   * lands is the normal way to work, and making it an error was the reason the
   * composer had to be disabled.
   *
   * A one-shot engine has no stdin to write into and refuses with a reason.
   */
  'agent.send': {
    params: { sessionId: string; prompt: string }
    result: { ok: true; queued: boolean } | { ok: false; reason: string }
  }
  /**
   * A queued turn taken back before the engine ever reads it. Named by its
   * text rather than its position: the queue drains on its own, so an index is
   * out of date by the time it crosses the socket.
   */
  'agent.unqueue': {
    params: { sessionId: string; prompt: string }
    result: { ok: boolean; reason?: string }
  }
  /**
   * §3.3 — one conversation's transcript, filtered out of the journal.
   *
   * The window cannot derive this from the events it happens to be holding:
   * that buffer is every workspace's, capped, and rolling. A thread opened
   * tomorrow has to read as what was said, and this is where that comes from.
   */
  'agent.transcript': { params: { sessionId: string }; result: CockpitEvent[] }
  /**
   * §3.7 — what going back to a turn would change, per repository, before it
   * changes anything. An undo that says "this will revert 12 files, +340 −18"
   * is a decision; one that just says "undo?" is a gamble.
   */
  'agent.revertPreview': {
    params: { sessionId: string; turnId: string }
    result: RevertPreviewEntry[]
  }
  /**
   * §16 — the working tree as it stood before that turn, put back: files
   * edited, files created, files deleted, tracked or not, committed or not.
   *
   * The state being discarded is snapshotted on the way in, so this is not a
   * one-way door — `redoTurnId` names the checkpoint that holds it.
   */
  'agent.revert': {
    params: { sessionId: string; turnId: string }
    result: { ok: boolean; detail: string; redoTurnId: string | null }
  }

  'memory.read': { params: { workspaceId: string }; result: MemoryDoc | null }
  'memory.write': { params: { workspaceId: string; content: string }; result: { ok: true } }
  'memory.promote': { params: { workspaceId: string; section: string; text: string }; result: { ok: true } }
  'memory.sessions': { params: { workspaceId: string }; result: TranscriptFile[] }

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
  | { t: 'topics'; topics: Topic[] }
  | { t: 'agents'; sessions: Conversation[] }
  /**
   * §3.3 — the journal is what the transcript derives from, and a token is not
   * a journal entry. Deltas are pushed beside the journal, never into it: the
   * window paints them as the sentence forms and drops them the moment the
   * durable `agent.output` event arrives with the finished message.
   *
   * `messageId` is the engine's own id for the message being written, so a
   * delta cannot be appended to the wrong one when two arrive interleaved.
   */
  | { t: 'agent-delta'; sessionId: string; messageId: string; text: string }
  | { t: 'term'; termId: string; data: string }
  | { t: 'term-exit'; termId: string; code: number }
  /**
   * §8 — a dev server's output, as it is written.
   *
   * Beside the journal for the same reason agent deltas are (§3.3): a log line
   * is not an event, and putting several thousand of them a minute into the
   * journal would drown the history it exists to keep. The window holds a
   * bounded tail and drops it when the workspace goes away.
   */
  | { t: 'runtime-log'; workspaceId: string | null; procId: string; label: string; chunk: string }

export type ClientMessage = RpcRequest
export type ServerMessage = RpcResponse | ServerPush
