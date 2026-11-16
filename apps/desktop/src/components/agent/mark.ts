import { CircleCheck, CirclePause, ScanEye, StickyNote } from '@lucide/vue'
import type { ConversationMarkKind } from '@cockpit/shared'

/** One icon per status a person sets on a conversation; a note alone gets the note. */
export function markIcon(k: ConversationMarkKind | null) {
  if (k === 'review') return ScanEye
  if (k === 'hold') return CirclePause
  if (k === 'done') return CircleCheck
  return StickyNote
}
