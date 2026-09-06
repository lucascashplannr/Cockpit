import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { Attachment, AttachmentInput } from '@cockpit/shared'
import { newId, splitPrompt } from '@cockpit/shared'
import { COCKPIT_HOME, ensureHome } from './config.js'

/**
 * What the person put into the box beside the prompt.
 *
 * Two problems, and they have different answers:
 *
 *   - **An image has to be seen.** A path to a screenshot costs the engine a
 *     tool call and one round of latency before it knows what it is looking
 *     at, and costs nothing at all when the tool set has been narrowed. The
 *     four formats the API takes inline go into the message as image blocks.
 *   - **Everything else has to be *findable*.** A log, a CSV, a PDF: the
 *     engine reads those perfectly well from disk, and disk is also the only
 *     form that survives the turn. Three turns later, after a resume or a
 *     compaction, "the file you attached" is a path or it is nothing.
 *
 * So every attachment is written down, and images are *additionally* inlined.
 * The bytes live under the cockpit's own home rather than in the repository:
 * dropping a screenshot into a conversation must not put an untracked file in
 * front of the person the next time they look at their diff.
 */

/** One directory, handed to every engine as a readable one at launch. */
export function attachmentsRoot(): string {
  ensureHome()
  const dir = join(COCKPIT_HOME, 'attachments')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * What the engine can be shown rather than told about. Exactly the four the
 * API accepts — anything else is a file, however much it looks like a picture
 * in Finder.
 */
const INLINE_IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/**
 * Ceilings, so a mis-drop cannot wedge a conversation.
 *
 * Refused rather than truncated: half a file read as a whole one is worse than
 * no file, and the window can say which one was too big while the prompt is
 * still on screen.
 */
const MAX_BYTES = 24 * 1024 * 1024
const MAX_TOTAL = 48 * 1024 * 1024
const MAX_COUNT = 12

/** A name that is safe on disk and still recognisable as what was dropped. */
function fileSafe(name: string): string {
  const clean = name
    .normalize('NFC')
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, '-')
    .replace(/^[.\-]+/, '')
    .slice(0, 80)
    .trim()
  return clean || 'attachment'
}

export class AttachmentError extends Error {}

/**
 * The bytes onto disk, once, under the conversation they belong to.
 *
 * Per conversation and not per turn: a thread that comes back to the same
 * screenshot on turn six should find it where turn one left it, and a
 * directory per turn would be a hundred directories holding one file each.
 */
export function saveAttachments(sessionId: string, inputs: AttachmentInput[]): Attachment[] {
  if (!inputs.length) return []
  if (inputs.length > MAX_COUNT) {
    throw new AttachmentError('too many files at once — ' + MAX_COUNT + ' is the limit')
  }
  const dir = join(attachmentsRoot(), sessionId)
  mkdirSync(dir, { recursive: true })

  const out: Attachment[] = []
  let total = 0
  for (const a of inputs) {
    const bytes = Buffer.from(a.data, 'base64')
    total += bytes.length
    if (bytes.length > MAX_BYTES) {
      throw new AttachmentError(a.name + ' is too big — ' + mb(MAX_BYTES) + ' is the limit')
    }
    if (total > MAX_TOTAL) {
      throw new AttachmentError('those files come to more than ' + mb(MAX_TOTAL) + ' together')
    }
    const id = newId('att_')
    const path = join(dir, id + '-' + fileSafe(a.name))
    writeFileSync(path, bytes)
    out.push({
      id,
      name: a.name,
      mediaType: a.mediaType || 'application/octet-stream',
      path,
      handle: a.handle,
      bytes: bytes.length,
      image: INLINE_IMAGE.has(a.mediaType),
    })
  }
  return out
}

function mb(n: number): string {
  return Math.round(n / (1024 * 1024)) + ' MB'
}

/* ── the turn, in the order it was written ─────────────────────────────── */

/**
 * One piece of the message the engine receives.
 *
 * A turn is a sequence of these rather than a string plus a bag of files,
 * because that is the only shape in which "this screenshot, at this point"
 * survives the trip. The API's content is an ordered array; so is this.
 */
export type TurnSegment =
  | { kind: 'text'; text: string }
  | { kind: 'file'; file: Attachment }

/**
 * The whole turn, anchors resolved, ready for an engine to encode.
 *
 * `preamble` goes in front and is never scanned: it is the topic memory, it
 * was not typed into the box, and a `#` inside it names nothing.
 */
export function turnSegments(
  preamble: string,
  prompt: string,
  files: Attachment[],
): TurnSegment[] {
  const byHandle = new Map(files.filter((f) => f.handle).map((f) => [f.handle, f]))
  const out: TurnSegment[] = []
  const text = (t: string): void => {
    if (!t) return
    const last = out[out.length - 1]
    if (last?.kind === 'text') last.text += t
    else out.push({ kind: 'text', text: t })
  }

  text(preamble)
  const placed = new Set<string>()
  for (const part of splitPrompt(prompt, byHandle.keys())) {
    if (part.kind === 'text') {
      text(part.text)
      continue
    }
    const file = byHandle.get(part.handle)!
    placed.add(file.id)
    // Named in the text as well as placed, and always with its path: the
    // engine needs a word for it in its own answer — "the second screenshot"
    // is a guess, `shot-2.png` is not — and it needs somewhere to look on a
    // later turn, when the picture is no longer in the context. The note is
    // what stops it spending a `Read` on something already in front of it.
    text(
      ' [' + file.name + ' — `' + file.path + '`' +
        (file.image ? ', shown here' : '') + '] ',
    )
    out.push({ kind: 'file', file })
  }

  // Everything nobody pointed at: about the message as a whole, which is what
  // an attachment usually is. Said in those words, so a file at the bottom is
  // not read as belonging to the last sentence above it — and then inlined
  // like any other, because unplaced is not unimportant.
  const rest = files.filter((f) => !placed.has(f.id))
  text(suffixFor(rest, placed.size > 0))
  for (const file of rest) out.push({ kind: 'file', file })
  return out
}

function suffixFor(items: Attachment[], someWerePlaced: boolean): string {
  if (!items.length) return ''
  const lines = items.map((a) => {
    const where = '`' + a.path + '`'
    return a.image
      ? '- ' + a.name + ' — ' + where + ' (shown to you in this message; no need to read it again)'
      : '- ' + a.name + ' — ' + a.mediaType + ' — ' + where
  })
  const heading = someWerePlaced
    ? 'Also attached, about the message as a whole rather than any one point:'
    : 'Files attached to this message by the user:'
  return (
    '\n\n---\n' +
    heading +
    '\n' +
    lines.join('\n') +
    '\nThey are outside the repository, under the cockpit’s own directory, and are readable.\n'
  )
}

/**
 * The same turn as one string, for an engine with nowhere to put a picture.
 *
 * `codex` takes its prompt as an argument and cannot be handed an image, so it
 * gets the paths — in the right places. The ordering survives even where the
 * inlining cannot.
 */
export function flatten(segs: TurnSegment[]): string {
  // Files contribute nothing of their own: every one of them is already named,
  // with its path, in the text run beside it. An engine that cannot be handed
  // a picture still gets told exactly where each one goes.
  return segs.map((s) => (s.kind === 'text' ? s.text : '')).join('')
}

/** What a conversation's bubble says when nothing was typed beside the files. */
export function summarise(items: Attachment[]): string {
  if (!items.length) return ''
  return items.length === 1 ? items[0]!.name : items.length + ' files'
}

/** The conversation is gone; so are the screenshots that only it referred to. */
export function forgetSession(sessionId: string): void {
  rmSync(join(attachmentsRoot(), sessionId), { recursive: true, force: true })
}

/**
 * One attachment's bytes, for the window's thumbnail.
 *
 * The path is checked against the root rather than trusted: this call reads a
 * file named by whoever is on the socket, and the only files it has any
 * business reading are the ones it wrote itself.
 */
export function readAttachment(path: string): string | null {
  const root = attachmentsRoot()
  const full = resolve(path)
  if (full !== root && !full.startsWith(root + sep)) return null
  try {
    return readFileSync(full).toString('base64')
  } catch {
    return null
  }
}
