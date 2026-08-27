import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import { folderSafe, parseRemote, starterManifest } from '@cockpit/shared'
import type { AddRepoSource, FolderInfo, NewProjectSource, Project } from '@cockpit/shared'
import { childRepos, findManifest } from './detect.js'
import { run } from './exec.js'
import { isRepo, listWorktrees } from './git.js'
import { append } from './journal.js'
import { addProject, allProjects, forgetProject, liveWorkUnder, renameProject } from './registry.js'

/**
 * §7 — the other half of `project.add`. Adding takes a folder as it is;
 * creating decides what the folder looks like, and there is exactly one answer:
 *
 *     <dev>/<Project>/           ← the project. Never a repository.
 *     <dev>/<Project>/<repo>/    ← .git lives here, one folder per repository.
 *
 * A repository at the project root is the one shape ruled out, because it is
 * the shape that cannot grow: a second repository would have nowhere to go, the
 * manifest and the cross-repo memory would have to live inside one of the
 * repositories they describe, and an agent given the project would be given a
 * repository instead. Keeping the root free costs one folder today and is the
 * difference between one repo and three later.
 *
 * All or nothing (§3.7): every folder this creates is remembered, and a clone
 * that fails takes them all back out rather than leaving a half-project behind.
 */

export interface CreateProjectInput {
  name: string
  /** Folder the project folder is created in — normally the Dev folder. */
  parent: string
  source: NewProjectSource
}

/** `.DS_Store` and friends are not contents; a folder holding only those is empty. */
function isEmptyDir(path: string): boolean {
  try {
    return readdirSync(path).every((n) => n === '.DS_Store' || n === '.localized')
  } catch {
    return false
  }
}

function requireDir(path: string, what: string): string {
  const abs = resolve(path)
  if (!existsSync(abs)) throw new Error(what + ' does not exist: ' + abs)
  if (!statSync(abs).isDirectory()) throw new Error(what + ' is not a directory: ' + abs)
  return abs
}

/**
 * `git clone` says why it failed in prose meant for a terminal. The two
 * failures worth translating are the two that are not the user's typing:
 * a private repository, and a URL nobody is serving.
 */
function cloneFailure(stderr: string, url: string): string {
  const text = stderr.trim()
  if (/could not read Username|Authentication failed|terminal prompts disabled|Permission denied \(publickey\)/i.test(text)) {
    return (
      'could not authenticate to ' + url +
      ' — it is private, or this machine has no credentials for it. Clone it once by hand, or add the key, then try again.'
    )
  }
  if (/not found|does not exist|ERROR: Repository/i.test(text)) {
    return 'no repository at ' + url + ' — check the URL.'
  }
  return 'clone failed: ' + (text.split('\n').slice(-3).join(' ') || 'git gave no reason')
}

/**
 * A repository with one commit in it. An unborn HEAD is a trap: there is no
 * branch to fork, and `git worktree add` refuses outright, so C2 and C3 would
 * be unreachable from a brand new repository. One commit costs nothing and
 * makes it a real one.
 *
 * Returns a note when only the commit failed — almost always a missing
 * `user.name` / `user.email`. The repository exists and the file is there;
 * refusing the whole thing over it would be out of proportion.
 */
async function initRepository(dir: string, title: string): Promise<string | null> {
  const init = await run('git', ['init'], { cwd: dir, timeoutMs: 30_000 })
  if (!init.ok) throw new Error('git init failed: ' + init.stderr.trim().slice(-300))
  writeFileSync(join(dir, 'README.md'), '# ' + title + '\n', 'utf8')
  await run('git', ['add', 'README.md'], { cwd: dir, timeoutMs: 30_000 })
  const commit = await run('git', ['commit', '-m', 'Initial commit'], { cwd: dir, timeoutMs: 30_000 })
  if (commit.ok) return null
  return commit.stderr.trim().slice(-300) || 'git gave no reason'
}

async function cloneInto(url: string, dest: string, branch: string | null): Promise<void> {
  const args = ['clone', ...(branch ? ['--branch', branch] : []), url, dest]
  const r = await run('git', args, { timeoutMs: 20 * 60_000 })
  if (!r.ok) throw new Error(cloneFailure(r.stderr || r.stdout, url))
}

/** `renameSync` across volumes is the one failure worth explaining. */
function moveFolder(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EXDEV') {
      throw new Error(
        dirname(to) + ' is on another volume than ' + from + ' — move the folder yourself, then add it.',
      )
    }
    throw e
  }
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  const name = input.name.trim()
  if (!name) throw new Error('a project needs a name')
  const src = input.source

  // Registering a folder as it stands creates no layout at all, so it shares
  // nothing below this point — it is `project.add` plus a display name.
  if (src.kind === 'folder' && !src.wrap) {
    const folder = requireDir(src.folder, 'that folder')
    const project = addProject(folder)
    append({
      type: 'project.created',
      projectId: project.id,
      payload: { root: folder, source: 'folder', wrapped: false },
    })
    return project.name === name ? project : renameProject(project.id, name)
  }

  const parent = resolve(input.parent)
  // One level of folder may be created — a Dev folder that does not exist yet
  // is normal. Two would mean a typo turned into a directory tree.
  if (!existsSync(parent)) requireDir(dirname(parent), 'the folder above ' + basename(parent))
  else if (!statSync(parent).isDirectory()) throw new Error('not a directory: ' + parent)

  const folderName = folderSafe(name)
  if (!folderName) throw new Error('"' + name + '" leaves nothing usable as a folder name')

  const root = join(parent, folderName)
  if (existsSync(root) && !isEmptyDir(root)) {
    throw new Error(root + ' already exists and is not empty — pick another name.')
  }

  /** Only what this call made, so undoing it can never reach anything else. */
  const created: string[] = []
  const mk = (p: string): void => {
    if (existsSync(p)) return
    mkdirSync(p, { recursive: true })
    created.push(p)
  }
  let moved: { from: string; to: string } | null = null
  const undo = (): void => {
    if (moved) {
      try {
        renameSync(moved.to, moved.from)
      } catch {
        // Reported by the error already being thrown; nothing to add here.
      }
    }
    for (const p of [...created].reverse()) {
      try {
        rmSync(p, { recursive: true, force: true })
      } catch {
        // Best effort: the caller is already handling a failure.
      }
    }
  }

  let repoPath: string | null = null

  try {
    if (src.kind === 'scratch') {
      mk(root)
      if (src.repoName) {
        const dir = folderSafe(src.repoName)
        if (!dir) throw new Error('"' + src.repoName + '" leaves nothing usable as a folder name')
        repoPath = join(root, dir)
        mk(repoPath)
        const note = await initRepository(repoPath, name)
        if (note) {
          append({
            type: 'project.created',
            level: 'warn',
            payload: { root, note: 'initial commit failed', detail: note },
          })
        }
      }
    } else if (src.kind === 'clone') {
      const remote = parseRemote(src.url)
      if (!remote) throw new Error('not a repository URL: ' + src.url)
      const dir = folderSafe(src.repoName ?? remote.repo) || remote.repo
      repoPath = join(root, dir)
      mk(root)
      // Listed before it exists so a clone that dies half-written is still
      // cleaned up: `git clone` creates the folder itself.
      created.push(repoPath)
      await cloneInto(remote.url, repoPath, src.branch)
    } else {
      // wrap: the folder picked is itself a repository, which is the one shape
      // the layout rules out. It moves down one level rather than being
      // registered as a root that can never grow a second repository.
      const folder = requireDir(src.folder, 'that folder')
      if (!isRepo(folder)) {
        throw new Error(folder + ' is not a repository — register it as it is instead of wrapping it.')
      }
      if (statSync(join(folder, '.git')).isFile()) {
        throw new Error(
          basename(folder) + ' is a git worktree; it belongs to the repository that created it and cannot be moved out on its own.',
        )
      }
      if (root === folder || root.startsWith(folder + '/')) {
        throw new Error('cannot move ' + folder + ' inside itself')
      }
      const live = liveWorkUnder(folder)
      if (live.length) throw new Error('stop these first — ' + live.join('; '))

      const dir = folderSafe(src.repoName ?? basename(folder)) || basename(folder)
      repoPath = join(root, dir)
      if (existsSync(repoPath)) throw new Error('already exists: ' + repoPath)

      // It may already be registered at the path it is about to leave; a config
      // entry pointing at a folder that no longer exists is invisible state.
      for (const p of allProjects()) {
        if (resolve(p.root) === folder) forgetProject(p.id)
      }

      mk(root)
      moveFolder(folder, repoPath)
      moved = { from: folder, to: repoPath }
    }

    // Written last, and only into a root this call created: it names the
    // project and marks the folder as one, without freezing the repo list.
    if (!findManifest(root)) {
      writeFileSync(
        join(root, 'cockpit.yaml'),
        starterManifest(name, repoPath ? basename(repoPath) : null),
        'utf8',
      )
    }
  } catch (e) {
    undo()
    throw e
  }

  const project = addProject(root)
  append({
    type: 'project.created',
    projectId: project.id,
    payload: { root, source: src.kind, repo: repoPath },
  })
  return project.name === name ? project : renameProject(project.id, name)
}

/* ── adding a repository to a project that already exists ────────────────
 * §7 — `project.create` lays down the layout once; this is the half that keeps
 * it true afterwards. A backend joining a project a month later is the same
 * three sources as the first repository, landing one level below the root:
 *
 *     <dev>/<Project>/web/     ← already there
 *     <dev>/<Project>/api/     ← this
 */

export interface AddRepoInput {
  projectId: string
  source: AddRepoSource
  /**
   * The folder the project's own repository moves into first, when the project
   * root is itself a repository. Required in that case — nothing that moves
   * somebody's checkout happens because a default said so — and ignored in
   * every other.
   */
  wrapRootAs?: string | null
}

export interface AddRepoResult {
  repoPath: string
  wrapped: string | null
  manifestUpdated: boolean
  /** `git init` worked, the first commit did not. The repository is still real. */
  note: string | null
}

/**
 * A project whose root is itself a repository is the one shape the layout
 * rules out (§7), and the one that cannot grow: a second repository has
 * nowhere to go. It moves down a level, which frees the root and leaves the
 * project's path — and therefore its id — untouched.
 *
 * Through a sibling folder rather than entry by entry: a folder cannot be
 * renamed into its own child, and a loop over its contents leaves a half-moved
 * tree behind the moment one entry fails.
 */
async function wrapRoot(root: string, folder: string): Promise<() => void> {
  if (statSync(join(root, '.git')).isFile()) {
    throw new Error(
      basename(root) +
        ' is a git worktree; it belongs to the repository that created it and cannot be moved on its own.',
    )
  }
  const live = liveWorkUnder(root)
  if (live.length) throw new Error('stop these first — ' + live.join('; '))

  const staging = join(dirname(root), '.' + basename(root) + '.cockpit-wrap')
  if (existsSync(staging)) {
    throw new Error(staging + ' is in the way — remove it and try again.')
  }
  const dest = join(root, folder)

  moveFolder(root, staging)
  try {
    mkdirSync(root)
    renameSync(staging, dest)
  } catch (e) {
    // Back to exactly where it was: an interrupted wrap must not cost anyone
    // their checkout.
    try {
      if (existsSync(root) && isEmptyDir(root)) rmSync(root, { recursive: true, force: true })
    } catch {
      // The rename below is what matters; if it also fails, that error wins.
    }
    renameSync(staging, root)
    throw e
  }

  // Linked worktrees hold an absolute path back to the repository they came
  // from, and it just changed. Best effort: a worktree that cannot be repaired
  // is still visible on disk, and `git worktree repair` says so itself.
  const linked = (await listWorktrees(dest)).map((w) => w.path).filter((p) => resolve(p) !== dest)
  if (linked.length) await run('git', ['worktree', 'repair', ...linked], { cwd: dest, timeoutMs: 60_000 })

  return () => {
    renameSync(dest, staging)
    rmSync(root, { recursive: true, force: true })
    renameSync(staging, root)
  }
}

/**
 * §5 — the manifest is touched only when it already declares `repos:`. A
 * declared list is pinned on purpose, and `buildProject` reads nothing else, so
 * a repository missing from it would be invisible. When the key is absent,
 * detection finds the folder on its own and writing it would freeze a list
 * nobody asked to freeze.
 *
 * Through the document API rather than parse-and-restringify: the file is
 * hand-written (§11) and its comments are half of what is in it.
 */
function declareRepo(manifestPath: string, folder: string, wrapped: string | null): boolean {
  let doc
  try {
    doc = parseDocument(readFileSync(manifestPath, 'utf8'))
  } catch {
    return false
  }
  const repos = doc.get('repos')
  if (!isSeq(repos)) return false

  // The repository that was at the root has moved; the entry that pointed at
  // the root has to follow it, or the project loses the repo it started with.
  if (wrapped) {
    for (const item of repos.items) {
      if (isScalar(item) && (item.value === '.' || item.value === './')) {
        item.value = './' + wrapped
      } else if (isMap(item)) {
        const at = item.get('path')
        if (at === '.' || at === './') item.set('path', './' + wrapped)
      }
    }
  }

  // Written in the shape the file already uses: a list of strings stays a list
  // of strings, a list of mappings stays a list of mappings.
  const bare = repos.items.length > 0 && repos.items.every((i) => isScalar(i))
  repos.add(doc.createNode(bare ? './' + folder : { path: './' + folder }))
  writeFileSync(manifestPath, doc.toString(), 'utf8')
  return true
}

export async function addRepo(input: AddRepoInput): Promise<AddRepoResult> {
  const project = allProjects().find((p) => p.id === input.projectId)
  if (!project) throw new Error('no such project: ' + input.projectId)
  const root = requireDir(project.root, 'the project folder')
  const src = input.source

  const asked =
    src.kind === 'clone'
      ? (src.repoName ?? parseRemote(src.url)?.repo ?? '')
      : src.kind === 'folder'
        ? (src.repoName ?? basename(resolve(src.folder)))
        : src.repoName
  const dir = folderSafe(asked ?? '')
  if (!dir) throw new Error('"' + String(asked ?? '') + '" leaves nothing usable as a folder name')
  const repoPath = join(root, dir)

  const rootIsRepo = isRepo(root)
  const wrapAs = rootIsRepo ? folderSafe(input.wrapRootAs ?? '') : ''
  if (rootIsRepo) {
    if (!input.wrapRootAs?.trim()) {
      throw new Error(
        basename(root) +
          ' is itself a repository, so there is nowhere beside it for a second one. It has to move into a folder of its own first — say which one.',
      )
    }
    if (!wrapAs) throw new Error('"' + input.wrapRootAs + '" leaves nothing usable as a folder name')
    if (wrapAs === dir) {
      throw new Error('both repositories would be called ' + dir + ' — pick another name for one of them.')
    }
  } else if (existsSync(repoPath) && !isEmptyDir(repoPath)) {
    throw new Error(repoPath + ' already exists and is not empty — pick another folder name.')
  }

  /** Only what this call made or moved, so undoing it can never reach further. */
  const undos: (() => void)[] = []
  const mk = (path: string): void => {
    if (existsSync(path)) return
    mkdirSync(path, { recursive: true })
    undos.push(() => rmSync(path, { recursive: true, force: true }))
  }
  const undo = (): void => {
    for (const step of [...undos].reverse()) {
      try {
        step()
      } catch {
        // Best effort: the caller is already handling a failure.
      }
    }
  }

  let wrapped: string | null = null
  let manifestUpdated = false
  let note: string | null = null

  try {
    if (rootIsRepo) {
      undos.push(await wrapRoot(root, wrapAs))
      wrapped = wrapAs
      // The manifest describes the project and has just been carried inside one
      // of its repositories, where nothing reads it. A copy comes back up; the
      // original stays where git tracks it, so no repository gains a deletion
      // nobody asked for.
      const carried = project.manifestPath ? join(root, wrapAs, basename(project.manifestPath)) : null
      if (carried && existsSync(carried) && !findManifest(root)) {
        copyFileSync(carried, join(root, basename(carried)))
      }
      // Checked again: the root held the old repository's contents a moment ago,
      // so a name that looked taken may be free now, and the reverse.
      if (existsSync(repoPath) && !isEmptyDir(repoPath)) {
        throw new Error(repoPath + ' already exists and is not empty — pick another folder name.')
      }
    }

    if (src.kind === 'scratch') {
      mk(repoPath)
      note = await initRepository(repoPath, dir)
    } else if (src.kind === 'clone') {
      const remote = parseRemote(src.url)
      if (!remote) throw new Error('not a repository URL: ' + src.url)
      // Listed before it exists so a clone that dies half-written is still
      // cleaned up: `git clone` creates the folder itself.
      undos.push(() => rmSync(repoPath, { recursive: true, force: true }))
      await cloneInto(remote.url, repoPath, src.branch)
    } else {
      const folder = requireDir(src.folder, 'that folder')
      if (folder === root || root.startsWith(folder + '/')) {
        throw new Error('cannot move ' + folder + ' inside itself')
      }
      if (isRepo(folder) && statSync(join(folder, '.git')).isFile()) {
        throw new Error(
          basename(folder) +
            ' is a git worktree; it belongs to the repository that created it and cannot be moved out on its own.',
        )
      }
      const live = liveWorkUnder(folder)
      if (live.length) throw new Error('stop these first — ' + live.join('; '))

      // It may already be registered as a project of its own; a config entry
      // pointing at a folder that no longer exists is invisible state.
      for (const p of allProjects()) {
        if (resolve(p.root) === folder) forgetProject(p.id)
      }

      moveFolder(folder, repoPath)
      undos.push(() => renameSync(repoPath, folder))
      // A backend written before anyone ran `git init` is still a repository
      // waiting to happen, and every level above C0 needs it to be one.
      if (!isRepo(repoPath)) note = await initRepository(repoPath, dir)
    }

    const manifestPath = findManifest(root)
    if (manifestPath) manifestUpdated = declareRepo(manifestPath, dir, wrapped)
  } catch (e) {
    undo()
    throw e
  }

  append({
    type: 'project.repo_added',
    projectId: project.id,
    payload: { root, repo: repoPath, source: src.kind, wrapped, manifestUpdated },
  })
  return { repoPath, wrapped, manifestUpdated, note }
}

/**
 * §13 rule 1 — the window has no filesystem. Everything the new-project sheet
 * needs to know about a path it is about to use comes from here, so it can say
 * "that folder is itself a repository" before anything is created rather than
 * after.
 */
export function inspectFolder(path: string): FolderInfo {
  const abs = resolve(path)
  const info: FolderInfo = {
    path: abs,
    exists: existsSync(abs),
    isDirectory: false,
    empty: false,
    isRepo: false,
    isWorktree: false,
    childRepos: [],
    remote: null,
    projectId: null,
  }
  if (!info.exists) return info
  try {
    info.isDirectory = statSync(abs).isDirectory()
  } catch {
    return info
  }
  if (!info.isDirectory) return info

  info.empty = isEmptyDir(abs)
  info.isRepo = isRepo(abs)
  if (info.isRepo) {
    try {
      info.isWorktree = statSync(join(abs, '.git')).isFile()
    } catch {
      info.isWorktree = false
    }
    info.remote = firstRemote(abs)
  }
  info.childRepos = childRepos(abs).map((p) => basename(p))
  info.projectId = allProjects().find((p) => resolve(p.root) === abs)?.id ?? null
  return info
}

/** Read from `.git/config` rather than shelled out: this runs on every keystroke. */
function firstRemote(dir: string): string | null {
  try {
    const text = readFileSync(join(dir, '.git', 'config'), 'utf8')
    return /url\s*=\s*(\S+)/.exec(text)?.[1] ?? null
  } catch {
    return null
  }
}

/**
 * Where projects already live, when they agree. Offered as the Dev folder when
 * none is set — a suggestion the user confirms, never a path anything is
 * created at on its own.
 */
export function suggestedDevRoot(): string | null {
  const counts = new Map<string, number>()
  for (const p of allProjects()) {
    const parent = dirname(p.root)
    counts.set(parent, (counts.get(parent) ?? 0) + 1)
  }
  let best: string | null = null
  let bestN = 0
  for (const [parent, n] of counts) {
    if (n > bestN) {
      best = parent
      bestN = n
    }
  }
  return best
}
