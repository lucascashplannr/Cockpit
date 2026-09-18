import { CircleAlert, Hand, MessageSquareDot } from '@lucide/vue'
import type { Attention } from '../../core/store.js'

/**
 * One icon per reason a conversation wants a person, the same everywhere the
 * shell draws one. The hand is kept for the one that cannot move without you —
 * a tool call waiting on a yes or a no. It used to mark an unread answer, and a
 * hand that means "done" leaves nothing to raise when the agent is stuck.
 */
export function attentionIcon(a: Attention) {
  if (a === 'approval') return Hand
  if (a === 'reply') return MessageSquareDot
  return CircleAlert
}
