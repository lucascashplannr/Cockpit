/**
 * §7 — the shape the cockpit creates on disk, and the only place that shape is
 * written down.
 *
 * One folder per project, and never a repository at the project root:
 * `<dev>/<Project>/<repo>/.git`, never `<dev>/<Project>/.git`. The root is
 * kept free so a second repository is a folder added beside the first rather
 * than a migration, so the manifest and the cross-repo memory have somewhere
 * to live (§7), and so an agent scoped to the project root reaches every
 * repository at once instead of one of them.
 *
 * Pure string work on purpose: the core executes it, the window previews it,
 * and both have to agree on the path down to the character.
 */

/** Separators and the characters no filesystem here will take. */
const ILLEGAL = /[/\\:*?"<>|\x00-\x1f]/g

/**
 * A folder name from something a human typed. Case is preserved — a folder is
 * read by people, and `Cashplannr` is not `cashplannr`. Returns '' when
 * nothing usable is left, which the caller must treat as a refusal.
 */
export function folderSafe(name: string): string {
  return name
    .normalize('NFC')
    .replace(ILLEGAL, '-')
    .replace(/\s+/g, '-')
    // A leading dot hides the folder; a leading dash is an argument to half
    // the tools that will later be pointed at it.
    .replace(/^[.\-]+/, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64)
    .replace(/[.\-]+$/, '')
    .trim()
}

export interface RemoteRef {
  /** Exactly what `git clone` is handed. */
  url: string
  host: string | null
  owner: string | null
  /** The repository's own name — the folder the clone lands in. */
  repo: string
}

const SHORTHAND = /^[\w.-]+\/[\w.-]+$/
/** `git@github.com:owner/repo.git` — a URL only by convention. */
const SCP = /^(?:([\w.-]+)@)?([\w.-]+\.[\w.-]+):(?!\/)(.+)$/
/** Web path segments that are not part of the clone URL. */
const WEB_SUFFIX = new Set([
  'tree', 'blob', 'pull', 'pulls', 'issues', 'commit', 'compare', 'releases', 'actions', 'wiki',
])

function stripGit(s: string): string {
  return s.replace(/\.git$/i, '')
}

function fromPath(host: string, path: string, url: string): RemoteRef | null {
  const clean = stripGit(path.replace(/^\/+/, '').replace(/\/+$/, ''))
  const segments = clean.split('/').filter(Boolean)
  // `github.com/owner/repo/tree/main` is a page about a repository rather than
  // a remote, and pasting one is the normal way to arrive here.
  const cut = segments.findIndex((s, i) => i >= 2 && WEB_SUFFIX.has(s))
  const parts = cut > 0 ? segments.slice(0, cut) : segments
  const repo = parts[parts.length - 1]
  if (!repo) return null
  const tail = '/' + segments.slice(cut).join('/')
  return {
    url: cut > 0 && url.includes(tail) ? url.slice(0, url.indexOf(tail)) : url,
    host,
    owner: parts.length > 1 ? parts[parts.length - 2]! : null,
    repo,
  }
}

/**
 * Accepts what people actually paste: an https URL, an SSH remote, a GitHub
 * page, or the `owner/repo` shorthand. Returns null when it is none of those,
 * so the caller can say so before anything is created.
 */
export function parseRemote(input: string): RemoteRef | null {
  const raw = input.trim().replace(/\/+$/, '')
  if (!raw) return null

  if (SHORTHAND.test(raw)) {
    const [owner, repo] = raw.split('/') as [string, string]
    const name = stripGit(repo)
    if (!name) return null
    return {
      url: 'https://github.com/' + owner + '/' + name + '.git',
      host: 'github.com',
      owner,
      repo: name,
    }
  }

  const scp = SCP.exec(raw)
  if (scp) return fromPath(scp[2]!, scp[3]!, raw)

  // Parsed by hand rather than with `URL`: this module is imported by the core
  // and by the renderer, and it stays free of anything either one has to
  // provide. A git remote is a simpler grammar than a URL in any case.
  const url = /^(https?|ssh|git):\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?(\/.*)?$/i.exec(raw)
  if (!url) return null
  return fromPath(url[2]!, url[3] ?? '', raw)
}

/**
 * The manifest written into a project the cockpit created. Deliberately with no
 * `repos:` key: declaring the repositories would freeze the list, and a second
 * one dropped into the folder later has to be found on its own (§5, "défaut
 * sain"). It is here to name the project and to be a file worth opening the
 * day something needs pinning down.
 */
export function starterManifest(name: string, repoFolder?: string | null): string {
  const safe = /^[\w .-]+$/.test(name) ? name : JSON.stringify(name)
  return [
    '# cockpit.yaml — desired state of this project (§13)',
    'version: 1',
    'name: ' + safe,
    '',
    '# One folder per repository, beside this file. They are discovered on their',
    '# own, so adding a second one is a `git clone` and nothing else. Declare',
    '# repos: here only to pin the list or to fix its order.',
    '#',
    '# repos:',
    '#   - path: ./' + (repoFolder || folderSafe(name) || 'repo'),
    '',
    '# ceremony: C1',
    '# runtime: compose',
    '# tickets: { provider: github, repo: owner/name }',
    '',
  ].join('\n')
}

/**
 * §4 — the branch- and folder-safe form of a feature name.
 *
 * It lives here, beside the other pure path work, because it is no longer just
 * a branch name: it is the branch in every repository, the folder under
 * `worktrees/`, half of the Herd hostname and half of the per-worktree
 * database name. Three implementations of it that disagree by one character
 * is four things pointing at three places.
 */
export function slugify(name: string): string {
  const s = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 60)
    .replace(/-+$/, '')
  return s || 'feature'
}

/**
 * §8 + §11 — a name unique across features, for every tool that keys on the
 * folder name rather than the path.
 *
 * This is the collision that silently breaks running two features at once:
 * `worktrees/2fa/api` and `worktrees/search/api` are both `api`, so Herd serves
 * one feature's code at the other's hostname and Compose adopts the other
 * feature's containers. The feature slug is the disambiguator.
 *
 * Shared by the runtime that links the site and the seed that writes the
 * hostname into `.env` — those two disagreeing is the same bug in two hats.
 */
export function scopedName(repoFolder: string, featureSlug: string | null): string {
  if (!featureSlug) return repoFolder
  const clean = slugify(featureSlug)
  if (repoFolder === clean) return repoFolder
  return repoFolder + '-' + clean
}
