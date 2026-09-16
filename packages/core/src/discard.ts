import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as diff from './diff.js'
import { run, serialize } from './exec.js'
import { git } from './git.js'
import { append } from './journal.js'
import * as registry from './registry.js'

/**
 * §16 — throwing a change away, without it being gone.
 *
 * "Corbeille à durée de vie plutôt que suppression immédiate." A discard that
 * is a bare `git restore` is the one button in the review that cannot be taken
 * back, so this never runs one. What is discarded goes into the stash first,
 * as an entry titled "Discarded …", and the Diff tab already lists every stash
 * in the repository it came from. The toast's Undo is the short way back; the
 * list is the long one, and it survives a restart.
 *
 * Two shapes:
 *
 *   - files: `git stash push -- <paths>`. Git does the saving and the
 *     reverting in one step, untracked files included.
 *   - one hunk: git has no non-interactive way to stash part of a file, so the
 *     entry is built by hand — HEAD's tree with only that hunk applied, wrapped
 *     in the two commits `git stash` would have made — and stored with
 *     `git stash store`. Only then is the hunk reversed out of the tree.
 */

export interface HunkLine {
  kind: 'context' | 'add' | 'del'
  text: string
}

export interface DiscardInput {
  workspaceId: string
  /** Whole files. Renames take their old path with them. */
  paths?: string[]
  /** One hunk of one file, by its position in `diff.file` and the lines it showed. */
  hunk?: { path: string; index: number; lines: HunkLine[] }
}

export interface DiscardResult {
  ok: boolean
  detail: string
  /** The stash commit holding what was discarded — what Undo names. */
  entry: string | null
}

/** Marks an entry built by `hunk` — Undo puts those back by patch, not by pop. */
const HUNK_PREFIX = 'Discarded lines '

export async function discard(input: DiscardInput): Promise<DiscardResult> {
  const ws = registry.requireWorkspace(input.workspaceId)
  if (!ws.repo) return fail('not a repository')

  const fresh = (await registry.refreshGit(ws.id)) ?? ws
  const g = fresh.git
  if (g?.conflicted) return fail(fresh.name + ' has unresolved conflicts; finish that first')
  if (g?.operation) return fail(fresh.name + ' is mid-' + g.operation.kind + '; finish or abort that first')

  if (input.hunk) return hunk(ws.id, ws.path, input.hunk)
  if (input.paths?.length) return files(ws.id, ws.path, input.paths)
  return fail('nothing to discard')
}

async function files(workspaceId: string, cwd: string, requested: string[]): Promise<DiscardResult> {
  // Only what the review is showing. A path from anywhere else has no business
  // becoming a pathspec, and a rename is two paths to git however it is listed.
  const shown = new Map((await diff.files(workspaceId)).map((f) => [f.path, f]))
  const paths = new Set<string>()
  for (const p of requested) {
    const f = shown.get(p)
    if (!f) continue
    paths.add(f.path)
    if (f.oldPath) paths.add(f.oldPath)
  }
  const listed = requested.filter((p) => shown.has(p))
  if (!listed.length) return fail('those files have no change left to discard')

  const label = 'Discarded ' + (listed.length === 1 ? listed[0] : listed.length + ' files')
  const r = await git(
    cwd,
    [
      'stash', 'push', '--include-untracked', '-m', label, '--',
      ...[...paths].map((p) => ':(literal)' + p),
    ],
    120_000,
  )
  if (!r.ok) return fail(lastLine(r.stderr) || 'git stash refused')
  if (/No local changes to save/.test(r.stdout + r.stderr)) return fail('nothing to discard')

  const sha = await revParse(cwd, 'stash@{0}')
  append({
    type: 'git.discarded',
    workspaceId,
    payload: { paths: listed, hunk: null, entry: sha },
  })
  return { ok: true, detail: label, entry: sha }
}

async function hunk(
  workspaceId: string,
  cwd: string,
  h: { path: string; index: number; lines: HunkLine[] },
): Promise<DiscardResult> {
  // First, before any shortcut: is this still the hunk the reader saw? Read
  // through the review's own parser, so both sides compare the same thing.
  const view = await diff.file(workspaceId, h.path)
  const seen: HunkLine[][] = []
  for (const l of view.lines) {
    if (l.kind === 'meta') seen.push([])
    else seen[seen.length - 1]?.push({ kind: l.kind, text: l.text })
  }
  if (!seen[h.index] || !same(seen[h.index]!, h.lines)) return stale()

  // A file git does not track yet is one hunk by definition; so is one whose
  // whole change is a single hunk. Either way the file path is the same act
  // with less to go wrong.
  const tracked = await git(cwd, ['ls-files', '--error-unmatch', '--', ':(literal)' + h.path])
  if (!tracked.ok) return files(workspaceId, cwd, [h.path])

  // The same diff the review parsed, with the prefixes pinned: a user's
  // `diff.noprefix` would otherwise hand `git apply` a patch it cannot place.
  const d = await git(cwd, [
    'diff', 'HEAD', '--no-color', '--no-ext-diff', '--unified=3',
    '--src-prefix=a/', '--dst-prefix=b/', '--', ':(literal)' + h.path,
  ])
  if (!d.ok) return fail(lastLine(d.stderr) || 'could not read the diff')

  const { header, hunks } = split(d.stdout)
  if (!hunks.length) return fail('that file has no change left to discard')
  if (hunks.length === 1 || /^(new|deleted) file mode|^Binary files|^rename from/m.test(header)) {
    return files(workspaceId, cwd, [h.path])
  }

  const chosen = hunks[h.index]
  if (!chosen || !sameLines(chosen, h.lines)) return stale()

  const patch = header + chosen.join('\n') + '\n'
  const range = rangeOf(chosen[0]!)
  const label = HUNK_PREFIX + range + ' of ' + h.path

  const dir = mkdtempSync(join(tmpdir(), 'cockpit-discard-'))
  const patchFile = join(dir, 'hunk.patch')
  writeFileSync(patchFile, patch)
  try {
    // 1 — what is being discarded, kept, before anything moves.
    const entry = await store(cwd, dir, patchFile, label)
    if (!entry.ok) return fail(entry.detail)

    // 2 — out of the tree.
    const back = await git(cwd, ['apply', '-R', '--', patchFile])
    if (!back.ok) {
      await dropEntry(cwd, entry.sha)
      return fail(lastLine(back.stderr) || 'the hunk no longer applies')
    }

    // 3 — out of the index too, where it had been staged. Checked first: a
    // hunk nobody staged is not in the index, and that is not an error.
    const staged = await git(cwd, ['apply', '-R', '--cached', '--check', '--', patchFile])
    if (staged.ok) await git(cwd, ['apply', '-R', '--cached', '--', patchFile])

    append({
      type: 'git.discarded',
      workspaceId,
      payload: { paths: [h.path], hunk: range, entry: entry.sha },
    })
    return { ok: true, detail: label, entry: entry.sha }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * The entry `git stash push` would have made for this hunk alone: a commit of
 * the index (here, HEAD's own tree — nothing of it was staged as far as the
 * entry is concerned) and a merge-shaped commit of the "working tree", which
 * is HEAD with the hunk applied. Built in a scratch index so the real one is
 * never touched.
 */
async function store(
  cwd: string,
  dir: string,
  patchFile: string,
  label: string,
): Promise<{ ok: true; sha: string } | { ok: false; detail: string }> {
  const env = { GIT_INDEX_FILE: join(dir, 'index') }
  const withIndex = (args: string[]) =>
    serialize('git:' + cwd, () => run('git', args, { cwd, env, timeoutMs: 60_000 }))

  const head = await revParse(cwd, 'HEAD')
  if (!head) return { ok: false, detail: 'there is no commit to discard back to' }

  const read = await withIndex(['read-tree', 'HEAD'])
  if (!read.ok) return { ok: false, detail: lastLine(read.stderr) }
  const applied = await withIndex(['apply', '--cached', '--', patchFile])
  if (!applied.ok) return { ok: false, detail: lastLine(applied.stderr) || 'the hunk does not apply to HEAD' }
  const tree = await withIndex(['write-tree'])
  if (!tree.ok) return { ok: false, detail: lastLine(tree.stderr) }

  const branchR = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const branch = branchR.ok ? branchR.stdout.trim() : '(no branch)'
  const subject = (await git(cwd, ['log', '-1', '--format=%h %s', 'HEAD'])).stdout.trim()

  const index = await git(cwd, [
    'commit-tree', 'HEAD^{tree}', '-p', head, '-m', 'index on ' + branch + ': ' + subject,
  ])
  if (!index.ok) return { ok: false, detail: lastLine(index.stderr) }
  const work = await git(cwd, [
    'commit-tree', tree.stdout.trim(), '-p', head, '-p', index.stdout.trim(),
    '-m', 'On ' + branch + ': ' + label,
  ])
  if (!work.ok) return { ok: false, detail: lastLine(work.stderr) }

  const sha = work.stdout.trim()
  const s = await git(cwd, ['stash', 'store', '-m', 'On ' + branch + ': ' + label, sha])
  if (!s.ok) return { ok: false, detail: lastLine(s.stderr) }
  return { ok: true, sha }
}

/**
 * Undo, while the entry is still where it was left.
 *
 * A file entry is popped: the paths it holds were reset by the discard, so the
 * replay lands on a clean file. A hunk entry cannot be popped once the rest of
 * that file has changes of its own — git refuses to merge into a dirty file —
 * so it goes back as the patch it is, and the entry is dropped after.
 */
export async function undo(input: { workspaceId: string; entry: string }): Promise<{ ok: boolean; detail: string }> {
  const ws = registry.requireWorkspace(input.workspaceId)
  const cwd = ws.path
  const ref = await refOf(cwd, input.entry)
  if (!ref) return { ok: false, detail: 'that entry is no longer in the list' }

  const msg = (await git(cwd, ['log', '-1', '--format=%s', input.entry])).stdout
  let r
  if (msg.includes(': ' + HUNK_PREFIX)) {
    const patch = await git(cwd, ['diff', '--binary', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', input.entry + '^1', input.entry])
    if (!patch.ok) return { ok: false, detail: lastLine(patch.stderr) }
    r = await serialize('git:' + cwd, () => run('git', ['apply', '-'], { cwd, input: patch.stdout, timeoutMs: 60_000 }))
    if (r.ok) await git(cwd, ['stash', 'drop', ref])
  } else {
    r = await git(cwd, ['stash', 'pop', ref], 120_000)
  }

  if (!r.ok) {
    return {
      ok: false,
      detail: (lastLine(r.stderr) || 'it did not apply') + ' — the entry is still under Set aside',
    }
  }
  append({ type: 'git.discard_undone', workspaceId: ws.id, payload: { entry: input.entry } })
  return { ok: true, detail: 'put back' }
}

/* ── helpers ──────────────────────────────────────────────────────────── */

function fail(detail: string): DiscardResult {
  return { ok: false, detail, entry: null }
}

function stale(): DiscardResult {
  return fail('the file changed since it was shown — look at it again before discarding')
}

function same(a: HunkLine[], b: HunkLine[]): boolean {
  return a.length === b.length && a.every((l, i) => l.kind === b[i]!.kind && l.text === b[i]!.text)
}

function lastLine(s: string): string {
  return s.trim().split('\n').filter(Boolean).pop() ?? ''
}

async function revParse(cwd: string, rev: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', rev])
  return r.ok ? r.stdout.trim() : null
}

/** `stash@{n}` for a commit, read now — refs shift with every push and drop. */
async function refOf(cwd: string, sha: string): Promise<string | null> {
  const r = await git(cwd, ['stash', 'list', '--format=%gd%x1f%H'])
  if (!r.ok) return null
  for (const line of r.stdout.split('\n')) {
    const [ref, h] = line.split('')
    if (h === sha && ref && /^stash@\{\d+\}$/.test(ref)) return ref
  }
  return null
}

async function dropEntry(cwd: string, sha: string): Promise<void> {
  const ref = await refOf(cwd, sha)
  if (ref) await git(cwd, ['stash', 'drop', ref])
}

/** The file header, and each hunk as its lines, `@@` line first. */
function split(text: string): { header: string; hunks: string[][] } {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const first = lines.findIndex((l) => l.startsWith('@@'))
  if (first < 0) return { header: text, hunks: [] }
  const hunks: string[][] = []
  for (const l of lines.slice(first)) {
    if (l.startsWith('@@')) hunks.push([l])
    else hunks[hunks.length - 1]!.push(l)
  }
  return { header: lines.slice(0, first).join('\n') + '\n', hunks }
}

/** Whether a hunk is still the one the reader was looking at. */
function sameLines(hunk: string[], shown: HunkLine[]): boolean {
  const body = hunk.slice(1).filter((l) => !l.startsWith('\\'))
  if (body.length !== shown.length) return false
  return body.every((l, i) => {
    const s = shown[i]!
    const sign = s.kind === 'add' ? '+' : s.kind === 'del' ? '-' : ' '
    return l === sign + s.text
  })
}

/** "44–50", from the side that still has lines. */
function rangeOf(at: string): string {
  const m = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(at)
  if (!m) return '?'
  const newCount = m[4] === undefined ? 1 : Number(m[4])
  const [start, count] = newCount > 0 ? [Number(m[3]), newCount] : [Number(m[1]), m[2] === undefined ? 1 : Number(m[2])]
  return count <= 1 ? String(start) : start + '–' + (start + count - 1)
}
