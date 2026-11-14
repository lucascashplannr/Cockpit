import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import { stableId } from '@cockpit/shared'
import type { Project } from '@cockpit/shared'
import { COCKPIT_HOME, projectSettings, setProjectSettings } from './config.js'
import { getDb } from './db.js'
import { groupNameProblem } from './detect.js'
import { git, isRepo } from './git.js'
import { append } from './journal.js'
import { leasesCovering } from './leases.js'
import { isLive } from './agents.js'
import * as registry from './registry.js'

/**
 * §4 — a group is a folder of repositories inside the project:
 * `<project>/<group>/<repo>`. Nothing records it but the disk, so making one,
 * renaming one and leaving one are all the same act — folders move — and the
 * whole of the work here is that nothing Cockpit knows about a repository is
 * lost on the way.
 *
 * What a repository's path is the key of, and what follows it:
 *  - its workspace id (`stableId('ws', path)`): the journal, its conversations
 *    and their scope, restore points, checkpoints, attribution, terminal
 *    history — rekeyed in one transaction;
 *  - the checkpoint store `<id>.git` under the service's home — renamed;
 *  - the engine's transcripts, filed by working directory — moved, so a
 *    conversation that ran there still resumes;
 *  - the links its branches keep back to it — `git worktree repair`;
 *  - the manifest's `repos:` and the docs folder, when they named it.
 *
 * §16 — refused, never warned, while something runs there: a server writing
 * into a folder that moves, or a conversation whose working directory does.
 */

interface Move {
  from: string
  to: string
}

/** Repositories into the group `name` (made if needed), or back to the project root when null. */
export async function place(projectId: string, workspaceIds: string[], name: string | null): Promise<Project> {
  const p = requireProject(projectId)
  const group = name === null ? null : name.trim()
  if (group !== null) {
    const problem = groupNameProblem(group)
    if (problem) throw new Error(problem)
    const at = join(p.root, group)
    if (existsSync(at) && isRepo(at)) throw new Error(group + ' is a repository — a group cannot be one')
    if (existsSync(at) && !statSync(at).isDirectory()) throw new Error(group + ' is a file in the project')
  }
  const into = group === null ? p.root : join(p.root, group)

  const moves: Move[] = []
  const left = new Set<string>()
  for (const id of workspaceIds) {
    const w = registry.getWorkspace(id)
    if (!w || w.projectId !== p.id || w.kind !== 'main') throw new Error('not a repository of ' + p.name)
    if (resolve(w.path) === resolve(p.root)) throw new Error(w.name + ' is the project itself')
    const to = join(into, basename(w.path))
    if (resolve(to) === resolve(w.path)) continue
    if (existsSync(to)) throw new Error('there is already a ' + basename(w.path) + ' in ' + (group ?? p.name))
    if (w.groupId) left.add(dirname(w.path))
    moves.push({ from: w.path, to })
  }
  if (!moves.length) return p

  refuseLive(moves)
  if (group !== null) mkdirSync(into, { recursive: true })
  for (const m of moves) await relocate(p, m)
  // A group left with nothing in it is a folder again; an empty one goes, one
  // with anything else in it — notes, its memory — stays as it is.
  for (const dir of left) removeIfEmpty(dir)

  append({
    type: 'project.grouped',
    projectId,
    payload: { group, moves },
  })
  return p
}

/** The group's folder renamed: every repository in it moves with it. */
export async function rename(projectId: string, groupId: string, name: string): Promise<Project> {
  const p = requireProject(projectId)
  const g = registry.getWorkspace(groupId)
  if (!g || g.projectId !== p.id || g.kind !== 'group' || g.topicId || resolve(g.path) === resolve(p.root)) {
    throw new Error('not a group of ' + p.name)
  }
  const next = name.trim()
  const problem = groupNameProblem(next)
  if (problem) throw new Error(problem)
  const to = join(p.root, next)
  if (resolve(to) === resolve(g.path)) return p
  // A case-only rename is the same folder on a case-insensitive disk.
  if (existsSync(to) && next.toLowerCase() !== basename(g.path).toLowerCase()) {
    throw new Error('there is already a ' + next + ' in ' + p.name)
  }
  const move = { from: g.path, to }
  refuseLive([move])
  await relocate(p, move)
  append({ type: 'project.group_renamed', projectId, payload: { from: g.path, to } })
  return p
}

/** Every repository out of the group, back to the project root. */
export async function ungroup(projectId: string, groupId: string): Promise<Project> {
  const members = registry
    .allWorkspaces(projectId)
    .filter((w) => w.kind === 'main' && w.groupId === groupId)
    .map((w) => w.id)
  if (!members.length) throw new Error('that group holds no repository')
  return place(projectId, members, null)
}

function requireProject(id: string): Project {
  const p = registry.getProject(id)
  if (!p) throw new Error('unknown project: ' + id)
  return p
}

function under(path: string, root: string): boolean {
  const p = resolve(path)
  const r = resolve(root)
  return p === r || p.startsWith(r + sep)
}

/** What moving these folders would pull out from under someone (§16). */
function refuseLive(moves: Move[]): void {
  const out: string[] = []
  for (const m of moves) {
    out.push(...registry.liveWorkUnder(m.from))
    for (const l of leasesCovering(m.from)) out.push(basename(m.from) + ': locked by ' + l.holder)
    // A conversation still open there — idle, but its engine was started in
    // that folder and would go on writing to where it was.
    for (const r of sessionsUnder(m.from)) {
      if (isLive(r.id)) out.push(basename(m.from) + ': a conversation is open there — ' + (r.title || r.id))
    }
  }
  const unique = [...new Set(out)]
  if (unique.length) throw new Error('stop these first — ' + unique.join('; '))
}

interface SessionRow {
  id: string
  title: string
  paths: string
  workspace_ids: string
  scope_id: string
  engine_session_id: string | null
}

function sessionsUnder(root: string): SessionRow[] {
  const rows = getDb()
    .prepare('SELECT id, title, paths, workspace_ids, scope_id, engine_session_id FROM agent_sessions')
    .all() as SessionRow[]
  return rows.filter((r) => parseList(r.paths).some((x) => under(x, root)))
}

function parseList(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

/** A path under `from`, as it reads once `from` is `to`. */
function mapPath(path: string, m: Move): string {
  if (!under(path, m.from)) return path
  const rest = relative(resolve(m.from), resolve(path))
  return rest ? join(m.to, rest) : m.to
}

async function relocate(p: Project, m: Move): Promise<void> {
  // Every workspace this folder is the home of, before anything moves: the
  // repository itself, or a group and each repository in it.
  const affected = registry.allWorkspaces(p.id).filter((w) => w.kind !== 'worktree' && under(w.path, m.from))
  const ids = new Map<string, string>()
  for (const w of affected) ids.set(w.id, stableId('ws', mapPath(w.path, m)))
  const sessions = sessionsUnder(m.from)

  mkdirSync(dirname(m.to), { recursive: true })
  try {
    renameSync(m.from, m.to)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EXDEV') throw new Error(m.to + ' is on another volume')
    throw e
  }

  // The branches each moved repository has elsewhere still point at where its
  // `.git` was; from the main checkout, `repair` finds and rewrites them all.
  for (const w of affected) {
    if (w.kind !== 'main') continue
    const at = mapPath(w.path, m)
    const r = await git(at, ['worktree', 'repair'])
    if (!r.ok) append({ type: 'project.group_repair_failed', projectId: p.id, payload: { path: at, stderr: r.stderr } })
  }

  rekey(ids, m)
  moveCheckpointStores(ids)
  moveTranscripts(sessions, m)
  followSettings(p, m)
}

/** One transaction: either every row follows the folder or none does. */
function rekey(ids: Map<string, string>, m: Move): void {
  const d = getDb()
  const tables = ['events', 'restore_points', 'checkpoints', 'touches', 'terminal_history', 'processes']
  d.transaction(() => {
    for (const [from, to] of ids) {
      for (const t of tables) {
        try {
          d.prepare(`UPDATE ${t} SET workspace_id = ? WHERE workspace_id = ?`).run(to, from)
        } catch {
          // A table an older database does not have yet has nothing to move.
        }
      }
      d.prepare('UPDATE agent_sessions SET scope_id = ? WHERE scope_id = ?').run(to, from)
      d.prepare('UPDATE agent_sessions SET memory = ? WHERE memory = ?').run('group:' + to, 'group:' + from)
      d.prepare('DELETE FROM workspace_cache WHERE id = ?').run(from)
    }
    const rows = d.prepare('SELECT id, paths, workspace_ids FROM agent_sessions').all() as SessionRow[]
    const set = d.prepare('UPDATE agent_sessions SET paths = ?, workspace_ids = ? WHERE id = ?')
    for (const r of rows) {
      const paths = parseList(r.paths)
      const wids = parseList(r.workspace_ids)
      const nextPaths = paths.map((x) => mapPath(x, m))
      const nextIds = wids.map((x) => ids.get(x) ?? x)
      if (nextPaths.some((x, i) => x !== paths[i]) || nextIds.some((x, i) => x !== wids[i])) {
        set.run(JSON.stringify(nextPaths), JSON.stringify(nextIds), r.id)
      }
    }
    const cps = d.prepare('SELECT id, path FROM checkpoints').all() as { id: string; path: string }[]
    const setCp = d.prepare('UPDATE checkpoints SET path = ? WHERE id = ?')
    for (const c of cps) {
      const next = mapPath(c.path, m)
      if (next !== c.path) setCp.run(next, c.id)
    }
  })()
}

function moveCheckpointStores(ids: Map<string, string>): void {
  const root = join(COCKPIT_HOME, 'checkpoints')
  for (const [from, to] of ids) {
    const a = join(root, from + '.git')
    const b = join(root, to + '.git')
    if (existsSync(a) && !existsSync(b)) renameSync(a, b)
  }
}

/**
 * The engine files a transcript under its working directory, spelled with
 * every character that is not a letter or a digit as `-`. `--resume` looks
 * only there, so a conversation whose folder moved has to have its transcript
 * moved with it, or it would start over with no memory of itself.
 */
function engineProjectsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
}

function engineDirFor(cwd: string): string {
  return join(engineProjectsDir(), resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'))
}

function moveTranscripts(sessions: SessionRow[], m: Move): void {
  const cwds = new Set<string>([m.from])
  for (const r of sessions) {
    const first = parseList(r.paths)[0]
    if (first && under(first, m.from)) cwds.add(first)
  }
  for (const cwd of cwds) {
    const from = engineDirFor(cwd)
    const to = engineDirFor(mapPath(cwd, m))
    if (from === to || !existsSync(from)) continue
    mkdirSync(to, { recursive: true })
    let entries: string[] = []
    try {
      entries = readdirSync(from)
    } catch {
      continue
    }
    for (const e of entries) {
      const dest = join(to, e)
      if (!existsSync(dest)) renameSync(join(from, e), dest)
    }
    removeIfEmpty(from)
  }
}

/** The manifest's `repos:`, the docs folder and the untracked list, where they named the old place. */
function followSettings(p: Project, m: Move): void {
  const s = projectSettings(p.root)
  const patch: Parameters<typeof setProjectSettings>[1] = {}
  if (s.docsPath && under(s.docsPath, m.from)) patch.docsPath = mapPath(s.docsPath, m)
  const untracked = s.untrackedRepos.map((r) => relative(p.root, mapPath(resolve(p.root, r), m)).split(sep).join('/'))
  if (untracked.some((r, i) => r !== s.untrackedRepos[i])) patch.untrackedRepos = untracked
  if (Object.keys(patch).length) setProjectSettings(p.root, patch)

  if (!p.manifestPath) return
  // Through the document API, as `declareRepo` does: the file is written by
  // hand and its comments are half of what is in it.
  let doc
  try {
    doc = parseDocument(readFileSync(p.manifestPath, 'utf8'))
  } catch {
    return
  }
  const repos = doc.get('repos')
  if (!isSeq(repos)) return
  const follow = (at: unknown): string | null => {
    if (typeof at !== 'string') return null
    const abs = resolve(p.root, at)
    if (!under(abs, m.from)) return null
    return './' + relative(p.root, mapPath(abs, m)).split(sep).join('/')
  }
  let changed = false
  for (const item of repos.items) {
    if (isScalar(item)) {
      const next = follow(item.value)
      if (!next) continue
      item.value = next
      changed = true
    } else if (isMap(item)) {
      const next = follow(item.get('path'))
      if (!next) continue
      item.set('path', next)
      changed = true
    }
  }
  if (changed) writeFileSync(p.manifestPath, doc.toString(), 'utf8')
}

/** Gone only when nothing is in it but Finder's own `.DS_Store`. */
function removeIfEmpty(dir: string): void {
  try {
    const entries = readdirSync(dir)
    if (entries.some((e) => e !== '.DS_Store')) return
    if (entries.length) unlinkSync(join(dir, '.DS_Store'))
    rmdirSync(dir)
  } catch {
    // Not empty after all, or already gone: either way there is nothing to do.
  }
}
