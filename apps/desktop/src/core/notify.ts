import { watch } from 'vue'
import type { Conversation, PermissionRequest } from '@cockpit/shared'
import {
  activeAgentScope, dismissToast, hostNotify, isBusy, openAgentOn, openThreadFor, pinThread,
  scopeLabel, showsAgent, state, toast,
} from './store.js'

/**
 * A conversation that wants a person, said where the person is.
 *
 * Two moments, and only these: a tool call is waiting on a yes or a no, and a
 * turn has come to an end. Both are read off the same pushes that light the
 * badges, as a change between one push and the next — news, and a state that
 * was already true when the window opened is not news.
 *
 * In the window it is a toast; with the window in the background, a system
 * notification. Neither one moves you. Only Open on the toast, or a click on
 * the notification, goes to the conversation: finishing a turn in one project
 * is no reason to pull you out of the one you are working in.
 */

interface Seen {
  busy: boolean
  pending: Set<string>
}

const seen = new Map<string, Seen>()
let seeded = false

export function startNotifications(): void {
  hostNotify?.onClick(open)
  watch(
    () => (state.booted ? state.agents : null),
    (agents) => {
      if (!agents) return
      for (const c of agents) observe(c)
      const ids = new Set(agents.map((c) => c.id))
      for (const id of seen.keys()) if (!ids.has(id)) seen.delete(id)
      seeded = true
    },
    { immediate: true },
  )
}

function observe(c: Conversation): void {
  const prev = seen.get(c.id)
  const busy = isBusy(c)
  seen.set(c.id, { busy, pending: new Set(c.pending.map((p) => p.id)) })
  // Everything on the first load is the state of things, not a change to it.
  if (!seeded) return
  const wasBusy = prev?.busy ?? busy
  const asked = c.pending.filter((p) => !prev?.pending.has(p.id))

  if (asked.length) tell(c, 'approval', approvalLine(asked[0]!, c.pending.length))
  // The turn is over rather than paused: nothing queued behind it, nothing
  // left to answer.
  else if (wasBusy && !busy && !c.pending.length && !c.queued.length) tell(c, 'done', doneLine(c))
  // Answered in the window: the toast asking for it has nothing left to ask.
  else if (prev?.pending.size && !c.pending.length) dropToast(c.id)
}

/** The toast on screen for each conversation, so a newer one replaces it. */
const toasts = new Map<string, number>()

function dropToast(id: string): void {
  const t = toasts.get(id)
  if (t !== undefined) dismissToast(t)
  toasts.delete(id)
}

function tell(c: Conversation, kind: 'approval' | 'done', line: Line): void {
  if (state.notifications === 'off') return
  if (kind === 'done' && state.notifications !== 'all') return
  const title = c.title || 'Conversation'
  const where = scopeLabel(c.scope).name

  if (!document.hasFocus()) {
    hostNotify?.show({
      id: c.id,
      title,
      ...(where ? { subtitle: where } : {}),
      body: line.what + (line.detail ? ' — ' + line.detail : ''),
    })
    return
  }
  // Already on screen: the thread, or the question box above it, says it.
  if (showsAgent.value && openThreadFor(activeAgentScope.value)?.id === c.id) return
  dropToast(c.id)
  toasts.set(
    c.id,
    toast(line.failed ? 'warn' : 'info', line.what + ' — ' + title + (where ? ' · ' + where : ''), {
      icon: line.failed ? undefined : kind === 'approval' ? 'approval' : 'reply',
      ...(line.detail ? { detail: line.detail } : {}),
      action: { label: 'Open', run: () => open(c.id) },
    }),
  )
}

/** What happened, and the one line under it that says what it was about. */
interface Line {
  what: string
  detail: string
  /** It stopped short of the job rather than finishing it. */
  failed?: boolean
}

function approvalLine(p: PermissionRequest, count: number): Line {
  const str = (k: string) => (typeof p.input[k] === 'string' ? (p.input[k] as string) : '')
  const what = str('command') || str('file_path') || str('notebook_path') || str('url') || p.description || ''
  const line = what.split('\n')[0]!.trim()
  const more = count > 1 ? ' (+' + (count - 1) + ')' : ''
  return { what: 'Waiting for your approval', detail: p.tool + (line ? ': ' + clip(line, 120) : '') + more }
}

function doneLine(c: Conversation): Line {
  if (c.status === 'failed') return { what: 'Failed', detail: '', failed: true }
  if (c.denials.length) return { what: 'Stopped short', detail: c.denials[0] + ' was refused.', failed: true }
  const said = (c.lastMessage ?? '').replace(/[`*_#>]/g, '').replace(/\s+/g, ' ').trim()
  return { what: 'Finished', detail: clip(said, 160) }
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s
}

/** Open, or a click on the notification: that conversation, on screen. */
function open(id: string): void {
  dropToast(id)
  const c = state.agents.find((x) => x.id === id)
  if (!c) return
  openAgentOn(c.scope)
  pinThread(c.scope, c.id)
}
