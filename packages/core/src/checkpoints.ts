import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { newId } from '@cockpit/shared'
import { COCKPIT_HOME } from './config.js'
import { getDb } from './db.js'
import { git } from './git.js'
import { append } from './journal.js'

/**
 * §16 — "Bouton d'annulation", backed by something that can actually undo the
 * thing it is offered for.
 *
 * The restore points in `restore.ts` anchor to a commit sha, which answers a
 * different question: they take a repository back to a *committed* state, and
 * `plans.undo` refuses outright when the tree is dirty, because a `reset
 * --hard` there would throw away work nobody asked it to. That is the correct
 * behaviour for a git plan — and it makes them useless for the one case that
 * matters most, since an agent's output is, by definition, uncommitted. The
 * button existed exactly for the moment it declined to fire.
 *
 * What an agent turn needs undone is the *working tree*: files edited, files
 * created, files deleted, none of it committed, some of it not even tracked.
 * So this snapshots the tree itself, into a git object store of its own:
 *
 *   ~/.cockpit/checkpoints/<workspaceId>.git
 *
 * with `--work-tree` pointed at the real repository. Everything git is good at
 * — content addressing, so two snapshots of an unchanged tree cost nothing;
 * `.gitignore`, so `node_modules` is never in one; the stat cache, so a
 * snapshot of a large repository re-hashes only what moved — and none of what
 * would make it intrusive: the repository's own index, HEAD, reflog, stash and
 * config are never touched, and nothing appears in `git log`.
 *
 * It also works where a restore point cannot: a folder with no repository at
 * all is §7's fifth scope row, and it snapshots exactly like the others.
 */

/** Where every workspace's shadow store lives. */
function storeRoot(): string {
  return join(COCKPIT_HOME, 'checkpoints')
}

function storeFor(workspaceId: string): string {
  return join(storeRoot(), workspaceId + '.git')
}

/**
 * A bare repository with `core.bare` turned back off — the one shape that can
 * hold an index and a work tree that are not next to it.
 *
 * The identity is set here and nowhere else: `commit-tree` refuses to run
 * without one, and reading it from the user's git config would put their name
 * on snapshots they did not ask for.
 */
async function ensureStore(workspaceId: string, cwd: string): Promise<string> {
  const dir = storeFor(workspaceId)
  if (existsSync(join(dir, 'HEAD'))) return dir
  mkdirSync(storeRoot(), { recursive: true })
  await git(cwd, ['init', '--bare', '--quiet', dir], 60_000)
  for (const [k, v] of [
    ['core.bare', 'false'],
    ['user.name', 'Cockpit'],
    ['user.email', 'cockpit@localhost'],
    // Snapshots are not authored by a person and are never shown as commits;
    // signing them would prompt for a passphrase in a background process.
    ['commit.gpgsign', 'false'],
  ])
    await git(cwd, ['--git-dir', dir, 'config', k!, v!])
  return dir
}

/** Every shadow-store call: our git dir, their work tree, never the reverse. */
function shadow(dir: string, cwd: string, args: string[], timeoutMs = 120_000) {
  return git(cwd, ['--git-dir', dir, '--work-tree', cwd, ...args], timeoutMs)
}

export interface Checkpoint {
  id: string
  sessionId: string
  /** Which turn it was taken before. Null for a snapshot taken by an undo. */
  turnId: string | null
  workspaceId: string
  path: string
  commit: string
  reason: string
  createdAt: number
}

interface Row {
  id: string
  session_id: string
  turn_id: string | null
  workspace_id: string
  path: string
  commit_sha: string
  reason: string
  created_at: number
}

function hydrate(r: Row): Checkpoint {
  return {
    id: r.id,
    sessionId: r.session_id,
    turnId: r.turn_id,
    workspaceId: r.workspace_id,
    path: r.path,
    commit: r.commit_sha,
    reason: r.reason,
    createdAt: r.created_at,
  }
}

/** The last snapshot of this workspace, whatever took it — the parent of the
 *  next one, so the store is a chain rather than a heap of loose commits. */
function previous(workspaceId: string): string | null {
  const row = getDb()
    .prepare('SELECT commit_sha FROM checkpoints WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(workspaceId) as { commit_sha: string } | undefined
  return row?.commit_sha ?? null
}

export interface CaptureTarget {
  workspaceId: string
  path: string
}

/**
 * One snapshot per workspace in scope, before a turn is allowed to write.
 *
 * Awaited by its caller rather than fired off beside it: a snapshot that lands
 * after the engine's first edit is a checkpoint of the wrong tree, which is
 * worse than none at all — it would restore to a state that never existed.
 */
export async function capture(
  sessionId: string,
  turnId: string | null,
  targets: CaptureTarget[],
  reason: string,
): Promise<Checkpoint[]> {
  const out: Checkpoint[] = []
  for (const t of targets) {
    const cp = await captureOne(sessionId, turnId, t, reason)
    if (cp) out.push(cp)
  }
  if (out.length)
    append({
      type: 'agent.checkpoint',
      actor: { kind: 'agent', sessionId, engine: '' },
      workspaceId: out[0]!.workspaceId,
      payload: { turnId, reason, workspaces: out.map((c) => c.workspaceId) },
    })
  return out
}

async function captureOne(
  sessionId: string,
  turnId: string | null,
  t: CaptureTarget,
  reason: string,
): Promise<Checkpoint | null> {
  if (!existsSync(t.path)) return null
  let dir: string
  try {
    dir = await ensureStore(t.workspaceId, t.path)
  } catch {
    return null
  }

  // `add -A` and not `add .`: a file the turn is about to delete has to be in
  // the snapshot, and only the first form records the whole tree.
  const added = await shadow(dir, t.path, ['add', '-A'])
  if (!added.ok) return null
  const tree = await shadow(dir, t.path, ['write-tree'])
  if (!tree.ok || !tree.stdout.trim()) return null

  const parent = previous(t.workspaceId)
  const commit = await shadow(dir, t.path, [
    'commit-tree',
    tree.stdout.trim(),
    ...(parent ? ['-p', parent] : []),
    '-m',
    reason,
  ])
  if (!commit.ok || !commit.stdout.trim()) return null
  const sha = commit.stdout.trim()

  const id = newId('cp_')
  // A ref, so the commit is reachable: an unreferenced one is exactly what
  // `git gc` exists to delete, and a checkpoint that can be collected is not a
  // checkpoint. Deleting the ref is how a checkpoint is ever forgotten.
  await shadow(dir, t.path, ['update-ref', 'refs/cockpit/' + id, sha])

  const now = Date.now()
  getDb()
    .prepare(
      'INSERT INTO checkpoints (id, session_id, turn_id, workspace_id, path, commit_sha, reason, created_at) VALUES (?,?,?,?,?,?,?,?)',
    )
    .run(id, sessionId, turnId, t.workspaceId, t.path, sha, reason, now)

  return {
    id,
    sessionId,
    turnId,
    workspaceId: t.workspaceId,
    path: t.path,
    commit: sha,
    reason,
    createdAt: now,
  }
}

/** Which turns of a conversation can be gone back to, by turn id. */
export function turnsWithCheckpoints(sessionId: string): string[] {
  const rows = getDb()
    .prepare('SELECT DISTINCT turn_id FROM checkpoints WHERE session_id = ? AND turn_id IS NOT NULL')
    .all(sessionId) as { turn_id: string }[]
  return rows.map((r) => r.turn_id)
}

/**
 * The checkpoint a turn id names, one per workspace, newest wins.
 *
 * A real turn only ever has one per workspace. An *undo's* snapshot does not:
 * undoing the same turn twice files a second one under the same id, and the
 * state worth coming back to is the one captured last. Restoring both in
 * sequence would land on the same tree by luck rather than by rule.
 */
function forTurn(sessionId: string, turnId: string): Checkpoint[] {
  const rows = getDb()
    .prepare('SELECT * FROM checkpoints WHERE session_id = ? AND turn_id = ? ORDER BY created_at ASC')
    .all(sessionId, turnId) as Row[]
  const latest = new Map<string, Checkpoint>()
  for (const r of rows) latest.set(r.workspace_id, hydrate(r))
  return [...latest.values()]
}

/** An undo's own snapshot is filed under the turn it undid, prefixed. */
function isRedo(turnId: string): boolean {
  return turnId.startsWith('redo_')
}

export interface RevertPreviewEntry {
  workspaceId: string
  name: string
  files: number
  insertions: number
  deletions: number
}

/**
 * §3.7 — "toute opération affiche son plan avant de s'exécuter", for the one
 * operation whose whole point is that it throws work away.
 *
 * Measured against the *index* of the shadow store, refreshed first: a diff
 * against the work tree alone cannot see a file that did not exist at the
 * checkpoint, and "3 files" that silently omits the four the turn created is
 * the kind of number that gets trusted once.
 */
export async function preview(
  sessionId: string,
  turnId: string,
  nameOf: (workspaceId: string) => string,
): Promise<RevertPreviewEntry[]> {
  const out: RevertPreviewEntry[] = []
  for (const cp of forTurn(sessionId, turnId)) {
    if (!existsSync(cp.path)) continue
    const dir = storeFor(cp.workspaceId)
    if (!existsSync(join(dir, 'HEAD'))) continue
    await shadow(dir, cp.path, ['add', '-A'])
    const d = await shadow(dir, cp.path, ['diff', '--numstat', '--cached', cp.commit])
    if (!d.ok) continue
    let files = 0
    let insertions = 0
    let deletions = 0
    for (const line of d.stdout.split('\n')) {
      const parts = line.trim().split('\t')
      if (parts.length < 3) continue
      files++
      // A binary file reports `-` on both counts; counting it as zero lines is
      // right, dropping the file from the count is not.
      insertions += Number(parts[0]) || 0
      deletions += Number(parts[1]) || 0
    }
    if (files) out.push({ workspaceId: cp.workspaceId, name: nameOf(cp.workspaceId), files, insertions, deletions })
  }
  return out
}

export interface RevertResult {
  ok: boolean
  detail: string
  /** The snapshot taken on the way in, so the undo is itself undoable. */
  redoTurnId: string | null
}

/**
 * Back to the tree as it stood before that turn was asked.
 *
 * Three things happen per workspace, in this order and no other:
 *
 *   1. the current tree is snapshotted, so pressing this was not a one-way
 *      door — the state being discarded is recoverable from the moment it is
 *      discarded, not merely regrettable;
 *   2. `read-tree -u --reset` puts the checkpoint's tree back *through* the
 *      index built in step 1, which is what lets it delete the files the turn
 *      created rather than leaving them behind beside the restored ones;
 *   3. the real repository's index is unstaged for exactly the paths that
 *      moved, so a `git add` the agent ran does not leave a staged blob
 *      pointing at content that is no longer anywhere in the tree.
 */
export async function revert(
  sessionId: string,
  turnId: string,
  reason: string,
): Promise<RevertResult> {
  const cps = forTurn(sessionId, turnId)
  if (!cps.length) return { ok: false, detail: 'no checkpoint was taken for that turn', redoTurnId: null }

  // One id for the whole redo, so undoing the undo is one operation across
  // every repository the turn spanned.
  const redoTurnId = 'redo_' + turnId
  const failures: string[] = []
  let restored = 0
  // What the transcript will say it put back. Counted from the paths that
  // actually moved, not from the preview: the two are taken a click apart and
  // the number shown afterwards has to be the one that happened.
  let files = 0

  for (const cp of cps) {
    if (!existsSync(cp.path)) {
      failures.push(cp.workspaceId + ': its folder is gone')
      continue
    }
    const dir = storeFor(cp.workspaceId)
    if (!existsSync(join(dir, 'HEAD'))) {
      failures.push(cp.workspaceId + ': its snapshot store is gone')
      continue
    }

    // 1 — what is being discarded, kept.
    await captureOne(sessionId, redoTurnId, { workspaceId: cp.workspaceId, path: cp.path }, reason)

    // Which paths are about to move, read before they do: this is also what
    // step 3 unstages, and after the restore the answer is empty by design.
    const moved = await shadow(dir, cp.path, ['diff', '--name-only', '--cached', cp.commit])
    const paths = moved.ok ? moved.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : []
    files += paths.length

    // 2 — the tree, back.
    const r = await shadow(dir, cp.path, ['read-tree', '-u', '--reset', cp.commit])
    if (!r.ok) {
      failures.push(cp.workspaceId + ': ' + r.stderr.trim().slice(-200))
      continue
    }
    restored++

    // 3 — the real index, only for what moved, and only where there is a HEAD
    // to unstage against. Never a bare `reset`: that would also unstage work
    // the person had staged themselves and never asked about.
    if (paths.length) {
      const head = await git(cp.path, ['rev-parse', '--verify', '--quiet', 'HEAD'])
      if (head.ok && head.stdout.trim()) {
        for (let i = 0; i < paths.length; i += 100)
          await git(cp.path, ['reset', '--quiet', '--', ...paths.slice(i, i + 100)])
      }
    }
  }

  if (!restored) {
    return { ok: false, detail: failures.join('; ') || 'nothing could be restored', redoTurnId: null }
  }

  append({
    type: 'agent.reverted',
    level: failures.length ? 'warn' : 'info',
    actor: { kind: 'agent', sessionId, engine: '' },
    workspaceId: cps[0]!.workspaceId,
    // Which direction it went. The two are the same operation and read as
    // opposite ones, and a transcript that calls a redo "put back to before
    // this turn" is describing the wrong half of it.
    payload: { turnId, redo: isRedo(turnId), workspaces: restored, files, failures },
  })

  const detail =
    'reverted ' +
    restored +
    (restored === 1 ? ' repository' : ' repositories') +
    (failures.length ? ' — ' + failures.join('; ') : '')
  return { ok: true, detail, redoTurnId }
}

/**
 * §13 — a permanent service fills a disk in weeks, and this one stores trees.
 *
 * Dropping the ref is what makes the objects collectable; the row goes with
 * it, because a checkpoint the store can no longer produce is worse than no
 * checkpoint at all. `gc` itself is left to git's own automatic threshold.
 */
export async function prune(retentionDays: number): Promise<number> {
  const cutoff = Date.now() - retentionDays * 86_400_000
  const rows = getDb()
    .prepare('SELECT * FROM checkpoints WHERE created_at < ?')
    .all(cutoff) as Row[]
  for (const r of rows) {
    const dir = storeFor(r.workspace_id)
    if (existsSync(join(dir, 'HEAD')) && existsSync(r.path))
      await shadow(dir, r.path, ['update-ref', '-d', 'refs/cockpit/' + r.id])
  }
  if (rows.length) getDb().prepare('DELETE FROM checkpoints WHERE created_at < ?').run(cutoff)
  return rows.length
}
