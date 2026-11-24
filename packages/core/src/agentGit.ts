import { basename } from 'node:path'
import { AGENT_GIT_EVENT, WRAP_TOOL, commitMessageProblems, gitProposalIn, newId, normalizeCommitRules } from '@cockpit/shared'
import type { AgentGitDone, AgentGitProposal, CockpitEvent, Conversation, PlanPreview, Workspace } from '@cockpit/shared'
import * as commit from './commit.js'
import { loadConfig } from './config.js'
import { git } from './git.js'
import { append } from './journal.js'
import * as plans from './plans.js'
import * as registry from './registry.js'

/**
 * §16 — staging, committing and pushing, when the person asked the agent for them.
 *
 * The agent still never runs them: `git add`, `git commit` and `git push` are
 * refused in its shell (`DEFAULT_DENY`). What it can do is write down what it
 * was asked for, in its recap (`wrap_up`'s `git`), and the card under the
 * answer turns that into a button. Pressing it is the person's commit, made by
 * Cockpit through the same plan the Diff's commit box builds, so a protected
 * branch, a conflict or a missing origin stops it exactly as it would there.
 *
 * Read back from the journal by the call's id, never taken from the window:
 * what runs is what the agent wrote and the card showed, nothing else.
 */

/** The repository a proposal names, among the ones the conversation is on. */
export function repoOf(c: Pick<Conversation, 'workspaceIds'>, name: string): Workspace | string {
  const ws = c.workspaceIds
    .map((id) => registry.getWorkspace(id))
    .filter((w): w is Workspace => !!w && !!w.repo && w.kind !== 'group')
  if (!ws.length) return 'this conversation is on no repository'
  if (!name) {
    if (ws.length === 1) return ws[0]!
    return 'this conversation is on ' + ws.length + ' repositories; name one in `repo` (' + ws.map((w) => w.repoName).join(', ') + ')'
  }
  const hit = ws.find((w) => w.repoName === name || w.name === name || basename(w.path) === name || w.path === name)
  return hit ?? 'no repository called ' + name + ' here; it is one of ' + ws.map((w) => w.repoName).join(', ')
}

/** Why a proposal cannot stand, or null. Said to the agent when it makes the call. */
export function proposalRefusal(c: Pick<Conversation, 'workspaceIds'>, p: AgentGitProposal): string | null {
  const w = repoOf(c, p.repo)
  if (typeof w === 'string') return w
  if (p.message.includes('"')) return 'the commit message cannot contain a double quote; write it without one'
  if (p.files.some((f) => f.includes('"'))) return 'a path with a double quote in it cannot be staged from here'
  if (p.files.some((f) => f.startsWith('/') || f.split('/').includes('..'))) {
    return '`files` are paths relative to the repository, inside it'
  }
  return null
}

interface Found {
  proposal: AgentGitProposal
  /** The latest recap on the thread is this one: an older card is not where things stand. */
  latest: boolean
  done: boolean
}

function find(toolUseId: string, events: CockpitEvent[]): Found | null {
  let found: AgentGitProposal | null = null
  let latest = false
  let done = false
  for (const e of events) {
    if (e.type === AGENT_GIT_EVENT) {
      const p = e.payload as Partial<AgentGitDone> | null
      if (p?.toolUseId === toolUseId && p.ok) done = true
      continue
    }
    if (e.type !== 'agent.tool_use') continue
    const p = e.payload as { toolUseId?: string; tool?: string; input?: Record<string, unknown> } | null
    if (p?.tool !== WRAP_TOOL) continue
    if (p.toolUseId === toolUseId) {
      found = gitProposalIn(p.input?.git)
      latest = true
    } else if (found) {
      latest = false
    }
  }
  return found ? { proposal: found, latest, done } : null
}

/** What was asked for, as the plan for it. The window applies it, or asks first when it is destructive. */
export async function plan(
  c: Conversation,
  toolUseId: string,
  events: CockpitEvent[],
): Promise<{ ok: boolean; detail: string; plan: PlanPreview | null }> {
  const no = (detail: string) => ({ ok: false, detail, plan: null })
  const f = find(toolUseId, events)
  if (!f) return no('this recap proposed nothing to git')
  if (f.done) return no('this was already done')
  if (!f.latest) return no('a later recap replaced this one')
  const p = f.proposal
  const refused = proposalRefusal(c, p)
  if (refused) return no(refused)
  // Checked when the card was made too; again here because Settings may have
  // changed since, and a card from before the rules existed still has a button.
  const problems = p.message ? commitMessageProblems(p.message, normalizeCommitRules(loadConfig().commitRules)) : []
  if (problems.length) return no('Not committed: the message breaks your commit rules (' + problems.join('; ') + '). Ask the agent for the commit again.')
  const w = repoOf(c, p.repo) as Workspace

  let made: PlanPreview | null
  if (p.message) {
    const res = await commit.plan({
      workspaceIds: [w.id],
      message: p.message,
      all: !p.files.length,
      ...(p.files.length ? { paths: p.files } : {}),
      push: p.push,
    })
    if (!res.ok || !res.plan) return no(res.detail)
    made = res.plan
  } else if (p.files.length) {
    made = stagePlan(w, p.files)
  } else {
    try {
      made = await plans.plan(w.id, 'push')
    } catch (e) {
      return no((e as Error).message)
    }
    if (!made.steps.length) return no(made.warnings[0] ?? 'nothing to push')
  }

  const head = await git(w.path, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  plans.whenApplied(made.planId, async () => {
    record(c, { toolUseId, ok: true, text: await outcome(w, p, head.ok ? head.stdout.trim() : '') })
  })
  return { ok: true, detail: w.repoName, plan: made }
}

/** `git add` of what was named, as a plan of one step: staging has no plan of its own elsewhere. */
function stagePlan(w: Workspace, files: string[]): PlanPreview {
  const p: PlanPreview = {
    planId: newId('plan_'),
    operation: 'stage',
    steps: [{
      title: w.name + ': stage ' + files.length + ' file(s)',
      command: 'git add -A -- ' + files.map((f) => '"' + f + '"').join(' '),
      cwd: w.path,
      destructive: false,
    }],
    warnings: ['In ' + w.name + (w.git?.branch ? ', on ' + w.git.branch : '') + '.'],
    capturesRestorePoint: false,
    repos: [w.name],
    onFailure: 'halt',
  }
  return plans.register(p, { workspaceIds: [w.id] })
}

/** What it came to, in the words the card and the agent are both told. */
async function outcome(w: Workspace, p: AgentGitProposal, before: string): Promise<string> {
  const branch = (await git(w.path, ['branch', '--show-current'])).stdout.trim()
  const where = w.repoName + (branch ? ' on ' + branch : '')
  const parts: string[] = []
  if (p.message) {
    const head = (await git(w.path, ['rev-parse', '--short', 'HEAD'])).stdout.trim()
    const moved = head && !before.startsWith(head)
    parts.push(moved ? 'Committed ' + head + ' in ' + where : 'Committed in ' + where)
  } else if (p.files.length) {
    parts.push('Staged ' + p.files.length + ' file' + (p.files.length === 1 ? '' : 's') + ' in ' + where)
  }
  if (p.push) parts.push(parts.length ? 'pushed to origin' : 'Pushed ' + where + ' to origin')
  return parts.join(', and ')
}

/** On the thread, for the card; and kept for the agent's next turn. */
function record(c: Conversation, done: AgentGitDone): void {
  append({
    type: AGENT_GIT_EVENT,
    actor: { kind: 'agent', engine: c.engine, sessionId: c.id },
    workspaceId: c.workspaceIds[0] ?? null,
    // The button was the person's: the actor only puts it on the thread.
    payload: { ...done, by: 'human' },
  })
  const list = news.get(c.id) ?? []
  list.push(done.text)
  news.set(c.id, list)
}

const news = new Map<string, string[]>()

/**
 * What the person ran from the agent's proposals since its last turn, said
 * once at the top of the next one, so the agent does not offer it again or
 * believe it is still undone. Lost with the core, which costs only that line.
 */
export function takeNews(sessionId: string): string {
  const list = news.get(sessionId)
  if (!list?.length) return ''
  news.delete(sessionId)
  return '<cockpit-git>\nSince your last turn, the person pressed the button on your proposal: ' + list.join('; ') + '.\n</cockpit-git>\n\n'
}

