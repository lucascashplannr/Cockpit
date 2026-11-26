import type { ConversationMark, ConversationMarkKind, Workspace } from '@cockpit/shared'
import { getDb } from './db.js'
import { cleanMark, readMark } from './mark.js'

/**
 * Where a person says a repository stands, and why: the status and note a
 * topic carries, set from the repository's own row and kept until changed.
 *
 * Kept by project and repository name rather than by checkout id, because the
 * id comes from the path and moving a repository into a group changes it.
 * Read once into memory: the workspace list is built far more often than a
 * status is set.
 */

let cache: Map<string, ConversationMark> | null = null

const keyOf = (projectId: string, repo: string) => projectId + '\u0000' + repo

function load(): Map<string, ConversationMark> {
  if (cache) return cache
  cache = new Map()
  const rows = getDb().prepare('SELECT project_id, repo, mark FROM repo_marks').all() as {
    project_id: string
    repo: string
    mark: string
  }[]
  for (const r of rows) {
    const m = readMark(r.mark)
    if (m) cache.set(keyOf(r.project_id, r.repo), m)
  }
  return cache
}

/** A repository's own checkout, the one row a status is set on. */
export function holdsMark(w: Workspace): boolean {
  return w.kind === 'main' && !!w.repoName
}

/** The status on this checkout's repository, or null for none and for a checkout that is not one. */
export function markOf(w: Workspace): ConversationMark | null {
  return holdsMark(w) ? (load().get(keyOf(w.projectId, w.repoName)) ?? null) : null
}

export function setRepoMark(
  w: Workspace,
  input: { kind: ConversationMarkKind | null; note: string } | null,
): { ok: true; mark: ConversationMark | null } | { ok: false; reason: string } {
  if (!holdsMark(w)) return { ok: false, reason: 'A status goes on a repository, or on the topic a branch belongs to.' }
  const mark = cleanMark(input)
  const d = getDb()
  if (mark) {
    d.prepare('INSERT INTO repo_marks (project_id, repo, mark) VALUES (?, ?, ?) ON CONFLICT(project_id, repo) DO UPDATE SET mark = excluded.mark').run(
      w.projectId,
      w.repoName,
      JSON.stringify(mark),
    )
    load().set(keyOf(w.projectId, w.repoName), mark)
  } else {
    d.prepare('DELETE FROM repo_marks WHERE project_id = ? AND repo = ?').run(w.projectId, w.repoName)
    load().delete(keyOf(w.projectId, w.repoName))
  }
  return { ok: true, mark }
}
