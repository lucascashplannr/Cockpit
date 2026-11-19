import type { ConversationMark, ConversationMarkKind } from '@cockpit/shared'

/**
 * Where a person says something stands, and why: a conversation from its tab,
 * a topic from its header. One shape, one reading, one cleaning for both.
 */
export const MARK_KINDS: readonly ConversationMarkKind[] = ['brainstorm', 'review', 'hold', 'done']

/** A stored mark, or null for none, for a broken one, and for one that says nothing. */
export function readMark(raw: unknown): ConversationMark | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const m = JSON.parse(raw) as Partial<ConversationMark>
    const kind = MARK_KINDS.includes(m.kind as ConversationMarkKind) ? (m.kind as ConversationMarkKind) : null
    const note = typeof m.note === 'string' ? m.note : ''
    if (!kind && !note) return null
    return { kind, note, at: Number(m.at) || 0 }
  } catch {
    return null
  }
}

/** What the window sent, made into a mark: neither a kind nor a note is no mark at all. */
export function cleanMark(input: { kind: ConversationMarkKind | null; note: string } | null): ConversationMark | null {
  const kind = input && MARK_KINDS.includes(input.kind as ConversationMarkKind) ? input.kind : null
  const note = (input?.note ?? '').replace(/[ \t]+\n/g, '\n').trim().slice(0, 500)
  return kind || note ? { kind, note, at: Date.now() } : null
}
