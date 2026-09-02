/**
 * §3.3 — "Tout est un événement."
 *
 * One append-only journal from which the display, the logs, the automations
 * and the history all derive. The envelope is deliberately small and stable;
 * everything variable lives in `payload`.
 */

/** Who caused this event. The human/agent split is the core guard-rail (§12). */
export type Actor =
  | { kind: 'human' }
  | { kind: 'agent'; engine: string; sessionId: string }
  | { kind: 'system' }

export type EventLevel = 'debug' | 'info' | 'warn' | 'error'

export interface CockpitEvent<T = unknown> {
  /** Monotonic per-journal sequence. Assigned by the core on append. */
  seq: number
  /** ULID-ish, sortable, unique across cores. */
  id: string
  /** Epoch millis. */
  ts: number
  /** Dotted namespace, e.g. `git.rebase.applied`, `agent.output`. */
  type: EventType
  level: EventLevel
  actor: Actor
  /** Where it happened. Null for core-wide events. */
  projectId: string | null
  workspaceId: string | null
  /** Free-form, typed per event kind at the edges. */
  payload: T
}

export type EventType =
  // core lifecycle
  | 'core.started'
  | 'core.stopping'
  | 'core.reconciled'
  | 'core.orphan_reaped'
  // workspaces
  | 'workspace.discovered'
  | 'workspace.forgotten'
  | 'workspace.probed'
  | 'project.created'
  | 'project.repo_added'
  | 'project.renamed'
  | 'project.moved'
  | 'project.trashed'
  // topics — the durable unit of work (§4)
  | 'topic.opened'
  | 'topic.started'
  | 'topic.stopped'
  | 'topic.renamed'
  | 'topic.closed'
  | 'topic.deleted'
  // git
  | 'git.plan'
  | 'git.applied'
  | 'git.failed'
  | 'git.restore_point'
  | 'git.undone'
  /** A plan stopped on a conflict rather than an error — a state, not a failure. */
  | 'git.conflict'
  /**
   * §12 — a commit message an engine wrote is not a commit an engine made, but
   * it is not nothing either: the journal records that the sentence in the box
   * was drafted rather than typed, so the attribution of a message nobody
   * rewrote is recoverable later.
   */
  | 'git.message_drafted'
  | 'git.conflict.resolved'
  | 'git.conflict.aborted'
  // §7 — the gitignored local config carried into a new worktree
  | 'worktree.seeded'
  // runtime
  | 'runtime.provision'
  | 'runtime.up'
  | 'runtime.down'
  | 'runtime.health'
  | 'runtime.log'
  // process supervision
  | 'process.spawned'
  | 'process.exited'
  // agents
  | 'agent.session_started'
  | 'agent.session_resumed'
  | 'agent.output'
  | 'agent.tool_use'
  /**
   * What a tool call actually did. Split from `agent.tool_use` because the two
   * are separated by however long the command takes, and a transcript that
   * shows only the call reads as though every one of them succeeded.
   */
  | 'agent.tool_result'
  /** §16 — the allow-list refused a tool, so the turn stopped short of its job. */
  | 'agent.denied'
  /**
   * §16 — the working tree as it stood before a turn was allowed to write, and
   * the moment one was put back. Both are journal entries because both are
   * things that happened to the code, not merely to the conversation.
   */
  | 'agent.checkpoint'
  | 'agent.reverted'
  | 'agent.session_ended'
  // leases
  | 'lease.acquired'
  | 'lease.released'
  | 'lease.denied'
  // memory
  | 'memory.written'
  | 'memory.promoted'
  // terminal
  | 'terminal.opened'
  | 'terminal.closed'
  // catch-all for capability-defined events
  | 'capability.event'

/**
 * §12 — attribution is what makes the diff splittable later, and "which tool"
 * was never enough to judge a turn by. The whole call is carried: the command
 * for a Bash, the path and the edit for a write.
 */
export interface AgentToolUsePayload {
  /** The engine's id for this call — what pairs it with its result. */
  toolUseId: string
  tool: string
  /** The tool's own arguments, as the engine reported them. */
  input: Record<string, unknown>
  /** Files this call names, already relative to the workspace. */
  paths: string[]
}

export interface AgentToolResultPayload {
  toolUseId: string
  tool: string
  stdout: string
  stderr: string
  isError: boolean
  /** Stopped by a person rather than by finishing. */
  interrupted: boolean
}

export interface RestorePointPayload {
  /** git reflog / stash reference we can roll back to. */
  ref: string
  head: string
  strategy: 'reflog' | 'stash' | 'branch-backup'
  reason: string
}

export interface GitPlanStep {
  title: string
  command: string
  cwd: string
  /** Destructive steps are rendered in red and require confirmation (§3.7). */
  destructive: boolean
}

export interface GitPlanPayload {
  planId: string
  operation: string
  steps: GitPlanStep[]
  warnings: string[]
}
