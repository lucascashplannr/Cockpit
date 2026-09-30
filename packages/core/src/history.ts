import type { CommitDetail, CommitGraph, DiffFile, FileDiff, GraphCommit, GraphRef } from '@cockpit/shared'
import { parseUnified } from './diff.js'
import { defaultBranch, git } from './git.js'
import { requireWorkspace } from './registry.js'

/**
 * §2 — "on ne cache pas git": what was committed, and what of it was pushed.
 *
 * Probed on every call like everything else (§3.4). Git keeps two of the three
 * facts the Commits tool draws — the commits and where each ref points — and
 * the third, *when something was pushed*, only in the reflog of the
 * remote-tracking ref, as an entry whose message is `update by push`. That is
 * the one place a push leaves a trace on this machine, so it is read from there
 * rather than inferred from the journal, which only knows the pushes Cockpit
 * made itself.
 */

const US = '\u001f'
/** Between trailer values, which may themselves contain anything but this. */
const GS = '\u001d'

/** An object name and nothing else — never something git would read as an option. */
const HASH = /^[0-9a-f]{7,64}$/i

/**
 * Co-author trailers that name a coding agent. A heuristic, and labelled as
 * one in the window: it says who signed the commit, not who wrote each line —
 * that is the Diff's attribution, which comes from the journal.
 */
const AGENT = /\b(claude|anthropic|codex|openai|copilot|cursor|devin|aider)\b/i

export async function graph(
  workspaceId: string,
  scope: 'branch' | 'all',
  limit = 300,
): Promise<CommitGraph> {
  const ws = requireWorkspace(workspaceId)
  const empty: CommitGraph = { commits: [], more: false, hasRemote: false }
  if (!ws.repo) return empty
  const cwd = ws.path
  const n = Math.max(1, Math.min(5000, Math.floor(limit)))

  const remotes = await git(cwd, ['for-each-ref', '--count=1', '--format=%(refname)', 'refs/remotes'])
  const hasRemote = remotes.ok && remotes.stdout.trim().length > 0

  const { revs, watched } = scope === 'all' ? { revs: ['--branches', '--remotes', '--tags', 'HEAD'], watched: [] } : await branchRevs(cwd)
  if (!revs.length) return { ...empty, hasRemote }

  const F = ['%H', '%P', '%an', '%ae', '%at', '%D', '%(trailers:key=Co-authored-by,valueonly,separator=%x1d)', '%s'].join('%x1f')
  const [log, unpushed] = await Promise.all([
    git(cwd, ['log', '--date-order', '--decorate=full', '-n', String(n + 1), '--format=' + F, ...revs, '--']),
    hasRemote
      ? git(cwd, ['rev-list', '-n', '5000', ...revs, '--not', '--remotes', '--'])
      : Promise.resolve(null),
  ])
  // A repository with no commit yet answers with an error, and that is an
  // empty history rather than a failure.
  if (!log.ok) return { ...empty, hasRemote }

  const local = new Set((unpushed?.stdout ?? '').split('\n').filter(Boolean))
  const lines = log.stdout.split('\n').filter(Boolean)
  const commits: GraphCommit[] = lines.slice(0, n).map((line) => {
    const [hash = '', parents = '', author = '', email = '', at = '0', deco = '', trailers = '', ...rest] =
      line.split(US)
    return {
      hash,
      parents: parents.split(' ').filter(Boolean),
      subject: rest.join(US),
      author,
      email,
      ts: Number(at) * 1000,
      refs: parseDecorations(deco),
      pushed: hasRemote && !local.has(hash),
      agent: trailers.split(GS).some((t) => AGENT.test(t)),
      pushes: [],
    }
  })

  // The refs whose reflog is worth reading: the ones on screen. In `all` that
  // is every remote branch the page decorates, capped — a repository with four
  // hundred remote branches does not need four hundred reflogs to draw one page.
  const remoteRefs =
    scope === 'all'
      ? [...new Set(commits.flatMap((c) => c.refs.filter((r) => r.kind === 'remote').map((r) => r.name)))].slice(0, 30)
      : watched
  if (hasRemote && remoteRefs.length) {
    const byHash = new Map(commits.map((c) => [c.hash, c]))
    for (const push of await pushesOf(cwd, remoteRefs)) {
      byHash.get(push.hash)?.pushes.push({ ref: push.ref, ts: push.ts })
    }
    for (const c of commits) c.pushes.sort((a, b) => b.ts - a.ts)
  }

  return { commits, more: lines.length > n, hasRemote }
}

/**
 * This branch, and the two things it is measured by: its upstream (what Push
 * sends to) and the base (what Catch up and Send to are about). Drawn together
 * they answer the two questions the scope bar's counts only number — which of
 * my commits are not pushed, and where did the base go since I left it.
 */
async function branchRevs(cwd: string): Promise<{ revs: string[]; watched: string[] }> {
  const [upstream, base] = await Promise.all([
    git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
    defaultBranch(cwd),
  ])
  const candidates = ['HEAD']
  const watched: string[] = []
  const up = upstream.ok ? upstream.stdout.trim() : ''
  if (up) {
    candidates.push(up)
    watched.push(up)
  }
  // `origin/<base>` first, for the reason `countAhead` gives: the shared base
  // is the one that matters, and a local `main` left behind flatters it.
  for (const ref of ['origin/' + base, base]) {
    if (await resolves(cwd, ref)) {
      candidates.push(ref)
      if (ref.startsWith('origin/')) watched.push(ref)
      break
    }
  }
  const revs: string[] = []
  for (const ref of candidates) {
    if (!revs.includes(ref) && (ref === 'HEAD' ? await resolves(cwd, 'HEAD') : true)) revs.push(ref)
  }
  return { revs, watched: [...new Set(watched)] }
}

async function resolves(cwd: string, ref: string): Promise<boolean> {
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', ref + '^{commit}'])
  return r.ok && r.stdout.trim().length > 0
}

/**
 * `%D` under `--decorate=full`: `HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1`.
 * The full form is the only way to tell a local branch called `origin/x` from
 * the remote one; the short names are what the window shows.
 */
function parseDecorations(deco: string): GraphRef[] {
  const out: GraphRef[] = []
  for (const raw of deco.split(', ').map((s) => s.trim()).filter(Boolean)) {
    if (raw === 'HEAD') {
      out.push({ name: 'HEAD', kind: 'head', current: true })
    } else if (raw.startsWith('HEAD -> ')) {
      out.push({ name: raw.slice(8).replace(/^refs\/heads\//, ''), kind: 'local', current: true })
    } else if (raw.startsWith('tag: ')) {
      out.push({ name: raw.slice(5).replace(/^refs\/tags\//, ''), kind: 'tag', current: false })
    } else if (raw.startsWith('refs/heads/')) {
      out.push({ name: raw.slice(11), kind: 'local', current: false })
    } else if (raw.startsWith('refs/remotes/')) {
      // `origin/HEAD` points at the default branch; drawn, it is the same
      // branch said twice on the same commit.
      if (raw.endsWith('/HEAD')) continue
      out.push({ name: raw.slice(13), kind: 'remote', current: false })
    }
    // refs/stash and anything else: not a branch, not drawn.
  }
  // The branch you are on first, then local, remote, tags.
  const rank = (r: GraphRef) => (r.current ? 0 : r.kind === 'head' ? 0 : r.kind === 'local' ? 1 : r.kind === 'remote' ? 2 : 3)
  return out.sort((a, b) => rank(a) - rank(b))
}

async function pushesOf(cwd: string, refs: string[]): Promise<{ hash: string; ref: string; ts: number }[]> {
  const out: { hash: string; ref: string; ts: number }[] = []
  for (const ref of refs) {
    const r = await git(cwd, [
      'log', '-g', '-n', '100', '--date=unix', '--format=%H%x1f%gs%x1f%gd', 'refs/remotes/' + ref, '--',
    ])
    if (!r.ok) continue
    for (const line of r.stdout.split('\n').filter(Boolean)) {
      const [hash = '', subject = '', selector = ''] = line.split(US)
      if (!subject.startsWith('update by push')) continue
      const ts = Number(/@\{(\d+)\}$/.exec(selector)?.[1] ?? 0) * 1000
      if (hash && ts) out.push({ hash, ref, ts })
    }
  }
  return out
}

export async function show(workspaceId: string, hash: string): Promise<CommitDetail> {
  const ws = requireWorkspace(workspaceId)
  if (!HASH.test(hash)) throw new Error('not a commit: ' + hash)
  const cwd = ws.path

  const meta = await git(cwd, ['show', '-s', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%B', hash, '--'])
  if (!meta.ok) throw new Error(meta.stderr.trim() || 'no such commit: ' + hash)
  const [full = hash, parents = '', author = '', email = '', at = '0', committer = '', ct = '0', ...rest] =
    meta.stdout.split(US)
  const message = rest.join(US).replace(/\s+$/, '')
  const nl = message.indexOf('\n')

  // Against the first parent, so a merge lists what it brought in rather than
  // the combined diff, which is empty for a clean merge and says nothing.
  const args = ['show', '--format=', '-M', '--diff-merges=first-parent', '-z']
  const [numstat, status] = await Promise.all([
    git(cwd, [...args, '--numstat', full, '--']),
    git(cwd, [...args, '--name-status', full, '--']),
  ])

  const counts = new Map<string, { add: number; del: number; binary: boolean }>()
  const t = numstat.stdout.replace(/^\n+/, '').split('\0')
  for (let i = 0; i < t.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(t[i]!.replace(/^\n+/, ''))
    if (!m) continue
    // A rename has no path in its own field: the old and new ones follow it.
    let path = m[3]!
    if (!path) {
      path = t[i + 2] ?? ''
      i += 2
    }
    const binary = m[1] === '-'
    counts.set(path, { add: binary ? 0 : Number(m[1]), del: binary ? 0 : Number(m[2]), binary })
  }

  const files: CommitDetail['files'] = []
  const s = status.stdout.replace(/^\n+/, '').split('\0')
  for (let i = 0; i < s.length; i++) {
    const code = s[i]!.trim()
    if (!code) continue
    const letter = code[0] as DiffFile['status']
    let path: string
    let oldPath: string | null = null
    if (letter === 'R' || letter === 'C') {
      oldPath = s[i + 1] ?? null
      path = s[i + 2] ?? ''
      i += 2
    } else {
      path = s[i + 1] ?? ''
      i += 1
    }
    if (!path) continue
    const c = counts.get(path) ?? { add: 0, del: 0, binary: false }
    files.push({ path, oldPath, status: letter, additions: c.add, deletions: c.del, binary: c.binary })
  }

  return {
    hash: full,
    parents: parents.split(' ').filter(Boolean),
    author,
    email,
    ts: Number(at) * 1000,
    committer,
    committedTs: Number(ct) * 1000,
    subject: nl === -1 ? message : message.slice(0, nl),
    body: nl === -1 ? '' : message.slice(nl + 1).trim(),
    files,
  }
}

export async function showFile(
  workspaceId: string,
  hash: string,
  path: string,
  oldPath?: string | null,
): Promise<FileDiff> {
  const ws = requireWorkspace(workspaceId)
  if (!HASH.test(hash)) throw new Error('not a commit: ' + hash)
  if (!path) throw new Error('no path')
  const paths = oldPath && oldPath !== path ? [oldPath, path] : [path]
  const r = await git(ws.path, [
    'show', '--format=', '-M', '--diff-merges=first-parent', '--unified=3', hash, '--', ...paths,
  ])
  const text = r.stdout
  if (!r.ok || !text.trim()) return { path, binary: false, lines: [] }
  if (/^Binary files /m.test(text)) return { path, binary: true, lines: [] }
  return { path, binary: false, lines: parseUnified(text) }
}
