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
  | 'project.renamed'
  | 'project.moved'
  | 'project.trashed'
  // features — the durable unit of work (§4)
  | 'feature.opened'
  | 'feature.activated'
  | 'feature.parked'
  | 'feature.renamed'
  | 'feature.closed'
  | 'feature.deleted'
  // git
  | 'git.plan'
  | 'git.applied'
  | 'git.failed'
  | 'git.restore_point'
  | 'git.undone'
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
  | 'agent.session_ended'
  | 'agent.cost'
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
