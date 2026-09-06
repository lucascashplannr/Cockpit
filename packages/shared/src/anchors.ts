/**
 * Where in a message an attachment belongs.
 *
 * The problem this exists for: a turn that says "1) … 2) … 3) …" with three
 * screenshots pasted into it used to reach the engine as the text, then a flat
 * list of three files at the bottom. Which picture went with which point was
 * information the person had in their head while typing and that nothing
 * carried across — so the engine guessed, and the person could not tell what
 * it had guessed until it answered about the wrong one.
 *
 * The fix is that the position is written down where positions already live:
 * in the text. `#shot` in the prompt is an anchor, resolved against the
 * attachments of that turn, and the message the engine receives is *ordered* —
 * the picture is a content block sitting at exactly that point, between the
 * words that came before it and the words that came after.
 *
 * Deliberately the same shape as the `@path` mentions in the same box: this
 * app already says "the thing I mean is here" by writing a token inline, and a
 * second mechanism for the same idea would be a second thing to learn.
 *
 * An attachment with no anchor is not an error and not a lesser thing — it is
 * about the message as a whole, which is what an attachment usually is. It
 * goes at the end, as it always did.
 */

/** The shape a handle takes: lowercase, dash-separated, starting on a letter
 *  or digit. Narrow on purpose — `#` is a character people write in prose. */
const HANDLE = /#([a-z0-9][a-z0-9-]*)/g

/** What the token for one attachment looks like, written out. */
export function anchorOf(handle: string): string {
  return '#' + handle
}

/**
 * A short, stable name for one attachment, unique among the ones beside it.
 *
 * Short because it is typed and read inside a sentence: `#sidebar-reference`
 * belongs in a prompt in a way that
 * `#Screenshot 2026-09-05 at 14.20.11.png` never could. Pasted images have no
 * name worth keeping, so callers hand this `shot` and let the numbering fall
 * out of the deduplication.
 */
export function handleFor(name: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const base = slug(stem(name)) || 'file'
  if (!used.has(base)) return base
  for (let n = 2; ; n++) {
    const next = base + '-' + n
    if (!used.has(next)) return next
  }
}

/**
 * The name without its extension — and only when there is a name in front of
 * the dot. `.prettierrc` is not an extension with nothing before it, it is a
 * file called `.prettierrc`, and stripping it leaves nothing to call it by.
 */
function stem(name: string): string {
  return name.replace(/^(.+)\.[^.]+$/, '$1')
}

/**
 * Its own normaliser rather than `slugify`, deliberately.
 *
 * `slugify` is the branch- and folder-safe form of a *topic* name and falls
 * back to the literal string `topic` when nothing usable is left — which is a
 * sensible default for a branch and a baffling one for an attachment. This
 * returns the empty string instead, so the caller can say `file`.
 */
function slug(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 40)
    .replace(/-+$/, '')
}

/** One piece of a prompt: words, or the attachment named at that point. */
export type PromptPart =
  | { kind: 'text'; text: string }
  | { kind: 'anchor'; handle: string }

/**
 * The prompt, cut at every anchor that names something actually attached.
 *
 * A `#` followed by anything that is *not* one of this turn's handles stays
 * text, which is what makes writing `#3` or `#hashtag` in a sentence safe. The
 * match backs off one dash-segment at a time — with `shot` attached and
 * `#shot-again` typed, the whole word was meant, not `#shot` plus `-again`.
 */
export function splitPrompt(prompt: string, handles: Iterable<string>): PromptPart[] {
  const known = new Set(handles)
  if (!known.size || !prompt.includes('#')) {
    return prompt ? [{ kind: 'text', text: prompt }] : []
  }

  const out: PromptPart[] = []
  let at = 0
  const push = (text: string): void => {
    if (!text) return
    const last = out[out.length - 1]
    if (last?.kind === 'text') last.text += text
    else out.push({ kind: 'text', text })
  }

  HANDLE.lastIndex = 0
  for (let m = HANDLE.exec(prompt); m; m = HANDLE.exec(prompt)) {
    // The longest handle that is really attached, shortest-suffix-first: the
    // greedy match is the common case and the loop below is the fallback.
    let word = m[1]!
    while (word && !known.has(word)) {
      const cut = word.lastIndexOf('-')
      word = cut > 0 ? word.slice(0, cut) : ''
    }
    if (!word) continue
    push(prompt.slice(at, m.index))
    out.push({ kind: 'anchor', handle: word })
    at = m.index + 1 + word.length
    HANDLE.lastIndex = at
  }
  push(prompt.slice(at))
  return out
}

/** The handles a prompt actually places, in the order it places them. */
export function anchorsIn(prompt: string, handles: Iterable<string>): string[] {
  return splitPrompt(prompt, handles)
    .filter((p): p is { kind: 'anchor'; handle: string } => p.kind === 'anchor')
    .map((p) => p.handle)
}
