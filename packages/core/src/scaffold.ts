import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { folderSafe, parseRemote, starterManifest } from '@cockpit/shared'
import type { FolderInfo, NewProjectSource, Project } from '@cockpit/shared'
import { childRepos, findManifest } from './detect.js'
import { run } from './exec.js'
import { isRepo } from './git.js'
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
        const init = await run('git', ['init'], { cwd: repoPath, timeoutMs: 30_000 })
        if (!init.ok) throw new Error('git init failed: ' + init.stderr.trim().slice(-300))
        // An unborn HEAD is a trap: no branch to fork, and `git worktree add`
        // refuses outright, so C2 and C3 would be unreachable from a brand new
        // repository. One commit costs nothing and makes it a real repository.
        writeFileSync(join(repoPath, 'README.md'), '# ' + name + '\n', 'utf8')
        await run('git', ['add', 'README.md'], { cwd: repoPath, timeoutMs: 30_000 })
        const commit = await run('git', ['commit', '-m', 'Initial commit'], {
          cwd: repoPath,
          timeoutMs: 30_000,
        })
        if (!commit.ok) {
          // Almost always a missing user.name/user.email. The repository exists
          // and the file is there; refusing the whole project over it would be
          // out of proportion.
          append({
            type: 'project.created',
            level: 'warn',
            payload: { root, note: 'initial commit failed', detail: commit.stderr.trim().slice(-300) },
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
      const args = ['clone', ...(src.branch ? ['--branch', src.branch] : []), remote.url, repoPath]
      const r = await run('git', args, { timeoutMs: 20 * 60_000 })
      if (!r.ok) throw new Error(cloneFailure(r.stderr || r.stdout, remote.url))
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
      try {
        renameSync(folder, repoPath)
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'EXDEV') {
          throw new Error(
            root + ' is on another volume than ' + folder + ' — move the folder yourself, then add it.',
          )
        }
        throw e
      }
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
