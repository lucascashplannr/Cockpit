import { newId } from '@cockpit/shared'
import { getDb } from './db.js'
import { append } from './journal.js'
import { git } from './git.js'

/**
 * §16 — a restore point before every risky operation, so undo is backed by
 * something real rather than by hope.
 *
 * §4 says the same thing about the one case that has the most to lose: "en C0
 * on est sur le checkout principal : c'est là qu'on a le plus à perdre. Un
 * point de restauration est capturé avant toute écriture d'agent." Which is
 * why this lives here rather than inside `plans.ts` — the git plans were not
 * the only writer that needs an anchor.
 */
export interface RestorePoint {
  id: string
  head: string
}

export async function capture(
  workspaceId: string,
  cwd: string,
  reason: string,
): Promise<RestorePoint | null> {
  const head = (await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim()
  // A folder with no repository, or a repo with no commit yet: nothing to
  // anchor to, and inventing one would be worse than saying so (§3.4).
  if (!head) return null
  const id = newId('rp_')
  getDb()
    .prepare(
      'INSERT INTO restore_points (id, workspace_id, ref, head, strategy, reason, created_at) VALUES (?,?,?,?,?,?,?)',
    )
    .run(id, workspaceId, head, head, 'reflog', reason, Date.now())
  append({ type: 'git.restore_point', workspaceId, payload: { id, head, strategy: 'reflog', reason } })
  return { id, head }
}
