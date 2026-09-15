/**
 * Letting go of the launch splash (drawn in index.html by scripts/logo.mjs).
 *
 * It stays up until the first bootstrap has answered, so the window arrives
 * with its projects already in it rather than as an empty shell that fills in
 * row by row. Held for at least one full pass round the letter: a core that answers
 * in 80ms would otherwise flash the mark for two frames, which reads as a
 * glitch rather than as a splash.
 *
 * Never a gate. If the core never answers the splash goes anyway, and the
 * connection banner underneath is what explains why.
 */

/* One whole pass round the letter (it ends at 1.44s) and a beat of the breath
   after it, so the fill never cuts a trace off halfway. */
const MIN_MS = 1600
const MAX_MS = 8000
/* The fill runs 200ms of stagger plus 260ms; the fade is 320ms. */
const FILL_MS = 440
const FADE_MS = 340

let released = false

export function releaseSplash(): void {
  const el = document.getElementById('splash')
  if (released || !el) return
  released = true
  const wait = Math.max(0, MIN_MS - performance.now())
  setTimeout(() => {
    el.classList.add('done')
    setTimeout(() => {
      el.classList.add('gone')
      setTimeout(() => el.remove(), FADE_MS)
    }, FILL_MS)
  }, wait)
}

setTimeout(releaseSplash, MAX_MS)
