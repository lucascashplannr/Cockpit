import { onScopeDispose, ref, watch, type Ref } from 'vue'

/**
 * The stream, paced — and cut into words rather than characters.
 *
 * §3.3 painted the draft message the instant a delta arrived, which is not the
 * same thing as watching it be written: the engine hands over whole clauses at
 * a time, and a paragraph that lands in four bursts reads as four hard jumps.
 * Nothing was wrong with the data — the screen was repainting at the network's
 * rhythm instead of at a legible one.
 *
 * So the text on screen is a prefix of the text received, and it walks toward
 * the end of it a few characters per frame, faster the further behind it is.
 * It never lags by more than about a tenth of a second, which is short enough
 * that the durable `agent.output` replacing the draft lands without anything
 * visibly catching up.
 *
 * The prefix always ends on a word boundary. Revealing by the character means
 * the last word on screen is a fragment of itself, and anything the transcript
 * does to soften that edge is then done to half of a word — which is the one
 * thing that reads as broken rather than as unfinished.
 */

/** Beyond this, the gap is not a stream — it is a different text. Snap. */
const SNAP = 900
/** Fraction of the backlog cleared each frame: the whole rhythm, one number. */
const DIV = 7
/** Slowest it will ever go, so the last few characters do not dawdle. */
const MIN = 2
/**
 * Nothing new for this long and the tail is not a word being typed, it is the
 * end of the message: show it rather than waiting for a space that will never
 * come. Under a running stream this never fires — deltas arrive far closer
 * together than this.
 */
const IDLE = 240
/** Longer than this and it is not a word anyone is waiting to read whole. */
const HOLD = 24

const SPACE = /\s/

function reduced(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/** Where the last complete word ends, or 0 if there is only the one word. */
function wordEnd(s: string): number {
  for (let i = s.length - 1; i >= 0; i--) if (SPACE.test(s[i]!)) return i + 1
  return 0
}

export function usePaced(source: () => string): Ref<string> {
  const shown = ref(source())
  let target = shown.value
  let changed = 0
  let raf = 0

  function stop(): void {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
  }

  function tick(): void {
    raf = 0
    const n = shown.value.length
    if (n >= target.length) {
      // Same length, different characters — a rewrite rather than a stream.
      if (shown.value !== target) shown.value = target
      return
    }

    const backlog = target.length - n
    // Not a stream at all: a text arriving whole. Straight through, ahead of
    // the word logic below — a snapped text has no trailing word being typed,
    // and holding one back stalled the whole paint for as long as the pause.
    if (backlog > SNAP) {
      shown.value = target
      return
    }

    // Forward to the end of the word the step landed inside.
    let next = n + Math.max(MIN, Math.ceil(backlog / DIV))
    while (next < target.length && !SPACE.test(target[next]!)) next++

    if (next >= target.length) {
      // The tail of a live stream is half a word by definition — the rest is
      // still on the wire — so it waits for the space that ends it. Two ways
      // out: the stream goes quiet, meaning this is the end of the message and
      // no space is coming; or the "word" is long enough that holding it would
      // itself be a slab, which is a URL or a hash rather than something being
      // read word by word.
      const cut = wordEnd(target)
      const rest = target.length - cut
      if (rest > 0 && rest <= HOLD && performance.now() - changed < IDLE) {
        next = Math.max(n, cut)
      }
    }

    if (next > n) shown.value = target.slice(0, next)
    if (shown.value.length < target.length) raf = requestAnimationFrame(tick)
  }

  watch(
    source,
    (next) => {
      target = next
      changed = performance.now()
      // Cleared, or reduced motion asked for: no in-between state at all.
      if (!next || reduced()) {
        stop()
        shown.value = next
        return
      }
      // Not an extension of what is on screen: another message, or another
      // conversation. Start it from nothing — if it is long, the snap above
      // means that lasts a single frame.
      if (!next.startsWith(shown.value)) shown.value = ''
      if (!raf) raf = requestAnimationFrame(tick)
    },
    { immediate: true },
  )

  onScopeDispose(stop)
  return shown
}
