import { computed } from 'vue'
import type { AgentLoadout, AgentScope, Conversation } from '@cockpit/shared'
import {
  activeProject, lastActivityAt, memoryChoiceFor, memoryLabel, projectNarrowing, projectOfConversation, shortName, state,
} from '../../core/store.js'

/**
 * What the agent gets, worked out once for the bar's pill and the sheet it
 * opens: where it runs, which memory, and what the engine loaded.
 */
export interface ContextInput {
  session?: Conversation | null
  scope?: AgentScope | null
  sources?: { workspaceId: string; name: string; path: string }[]
  /** The conversation has started: its memory and repositories are facts now. */
  started: boolean
}

export function useAgentContext(props: ContextInput) {
  const projectId = computed<string | null>(() => {
    if (props.session) return projectOfConversation(props.session)
    const sc = props.scope
    if (!sc) return null
    if (sc.kind === 'project') return sc.projectId
    if (sc.kind === 'topic') return state.topics.find((t) => t.id === sc.topicId)?.projectId ?? null
    return state.workspaces.find((w) => w.id === sc.workspaceId)?.projectId ?? null
  })

  /* ── where it runs ── */
  const narrowing = computed(() => (props.scope?.kind === 'project' ? projectNarrowing.value : null))
  /** On a project, before the conversation starts: its repositories are ticked here. */
  const reposEditable = computed(() => !!narrowing.value && !narrowing.value.frozen && narrowing.value.every.length > 1)
  const narrowed = computed(() => !!narrowing.value?.narrowed)
  const repoName = (name: string) => shortName(name, activeProject.value?.name)
  /** The short answer: "All 5", "4 of 5", or the one repository's name. */
  const reposValue = computed(() => {
    const n = narrowing.value
    if (n && n.every.length > 1) return n.narrowed ? n.picked.length + ' of ' + n.every.length : 'All ' + n.every.length
    const srcs = props.sources ?? []
    if (!srcs.length) return 'None'
    return srcs.length === 1 ? repoName(srcs[0]!.name) : srcs.length + ' repositories'
  })

  /* ── which memory ── */
  const memoryEditable = computed(() => !props.started && !!props.scope)
  const memoryId = computed(() =>
    props.started && props.session ? props.session.memory : props.scope ? memoryChoiceFor(props.scope) : 'off',
  )
  const memoryName = computed(() => memoryLabel(projectId.value, memoryId.value))
  const memoryNotes = computed(() => {
    const m = state.memories[projectId.value ?? '']?.find((x) => x.id === memoryId.value)
    return m ? m.entries : null
  })

  /* ── what the engine loaded ──
   *
   * Only true once a process has said so (`Conversation.loadout`). Before the
   * first turn it is borrowed from the project's latest conversation that has
   * one, and the sheet says so. */
  const borrowed = computed<Conversation | null>(() => {
    if (props.session?.loadout) return null
    const pid = projectId.value
    let best: Conversation | null = null
    for (const c of state.agents) {
      if (!c.loadout || c.engine !== (props.session?.engine ?? 'claude')) continue
      if (pid && projectOfConversation(c) !== pid) continue
      if (!best || lastActivityAt(c) > lastActivityAt(best)) best = c
    }
    return best
  })
  const loadout = computed<AgentLoadout | null>(() => props.session?.loadout ?? borrowed.value?.loadout ?? null)

  return {
    projectId, narrowing, reposEditable, narrowed, repoName, reposValue,
    memoryEditable, memoryId, memoryName, memoryNotes, borrowed, loadout,
  }
}
