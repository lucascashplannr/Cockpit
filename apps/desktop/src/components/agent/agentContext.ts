import { computed } from 'vue'
import type { AgentLoadout, AgentScope, Conversation } from '@cockpit/shared'
import {
  activeProject, lastActivityAt, memoryChoiceFor, memoryLabel, projectNarrowing, projectOfConversation, shortName, skillsKey,
  state,
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
  /**
   * A checkout by its repository's name: in a topic every checkout is named
   * after the topic's branch, so two of them read the same and say nothing.
   */
  const labelOf = (src: { workspaceId: string; name: string }) =>
    state.workspaces.find((w) => w.id === src.workspaceId)?.repoName || src.name
  /** The short answer: "All 5", "4 of 5", "2", or the one repository's name. */
  const reposValue = computed(() => {
    const n = narrowing.value
    if (n && n.every.length > 1) return n.narrowed ? n.picked.length + ' of ' + n.every.length : 'All ' + n.every.length
    const srcs = props.sources ?? []
    if (!srcs.length) return 'None'
    return srcs.length === 1 ? labelOf(srcs[0]!) : String(srcs.length)
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
  /** What the engine itself says it would load here (`skills.catalog`). */
  const probed = computed(() => state.engineCatalog[skillsKey((props.sources ?? []).map((s) => s.workspaceId))] ?? null)
  /**
   * This conversation's own report; else the engine's answer for these
   * folders, with MCP servers from the latest real report (the probe stops
   * before they have connected).
   */
  const loadout = computed<AgentLoadout | null>(() => {
    if (props.session?.loadout) return props.session.loadout
    const p = probed.value
    const b = borrowed.value?.loadout ?? null
    if (!p) return b
    return b ? { ...p, mcp: b.mcp, tools: b.tools } : p
  })

  return {
    projectId, narrowing, reposEditable, narrowed, repoName, labelOf, reposValue,
    memoryEditable, memoryId, memoryName, memoryNotes, borrowed, loadout,
  }
}
