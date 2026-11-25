import { computed, type Ref } from 'vue'
import type { Conversation } from '@cockpit/shared'
import { state } from '../../core/store.js'

/**
 * §6 — where a conversation's context stands, read the same way by the meter
 * under the box and the banner over it.
 *
 * The percentage is against the model's whole window, because that is what
 * the model can hold. The context limit (Settings) is where the engine
 * compacts, drawn as a mark on top of it: the meter used to fill toward the
 * limit instead, and on a 200k limit one message with a few files read showed
 * as half full.
 */

/** Past this share of the window, answers get worse. */
export const CROWDED = 70
/** Past this share of the context limit, a compaction is coming. */
export const NEAR_COMPACT = 75

export function useContextLevel(session: Ref<Conversation | null | undefined>) {
  return computed(() => {
    const s = session.value
    const u = s?.usage
    if (!u || !u.contextWindow) return null
    const tokens = u.contextTokens
    const window = u.contextWindow
    // Only the claude engine is given a compaction window. Unknown until the
    // settings arrive, so no mark rather than a wrong one.
    const limit = s.engine === 'claude' && state.settings ? state.settings.contextLimit : null
    const compactAt = limit && limit < window ? limit : null
    const pct = Math.min(100, Math.round((tokens / window) * 100))
    const ofLimit = compactAt ? Math.min(100, Math.round((tokens / compactAt) * 100)) : null
    const nearCompact = ofLimit !== null && ofLimit >= NEAR_COMPACT
    const crowded = pct >= CROWDED
    return {
      tokens,
      window,
      pct,
      compactAt,
      /** Share of the way to the compaction point, or null when there is none. */
      ofLimit,
      /** Tokens left before the engine compacts. */
      toCompact: compactAt ? Math.max(0, compactAt - tokens) : null,
      nearCompact,
      crowded,
      warn: nearCompact || crowded,
    }
  })
}
