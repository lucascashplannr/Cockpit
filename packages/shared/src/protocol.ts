/**
 * §13 rule 1 — "L'interface n'a pas de système de fichiers."
 * Every read, list, write, spawn and terminal goes through this contract.
 * Only the address changes when the core moves to another machine (§10 C).
 */
import type { PROTOCOL_VERSION } from './protocol-version.js'
import type { CockpitEvent } from './events.js'
import type {
  AgentSession, AgentSessionFile, CoreStatus, DiffFile, Feature, FileDiff,
  MemoryDoc, Project, SearchHit, Workspace,
} from './model.js'

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
   * How to take this step back. A plan spanning several repos must not be left
   * half-applied: if step 3 fails, the undos of steps 1-2 run in reverse (§3.7).
   * A list, because undoing `git worktree add -b` is two commands, not one.
   */
  undo?: { title: string; command: string; cwd: string }[]
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
    }
    result: { plan: PlanPreview; featureId: string }
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

  'git.plan': {
    params: { workspaceId: string; operation: 'rebase' | 'merge' | 'branch' | 'worktree' | 'push' | 'sync'; args?: Record<string, string> }
    result: PlanPreview
  }
  'git.apply': { params: { planId: string }; result: { ok: boolean; output: string; restorePoint: string | null } }
  'git.undo': { params: { workspaceId: string }; result: { ok: boolean; detail: string } }
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
  'agent.send': { params: { sessionId: string; text: string }; result: { ok: true } }

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
