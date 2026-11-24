import type { PullRequest, ReviewHost, ReviewStatus } from '@cockpit/shared'
import { fetchRemote, git } from './git.js'
import { run } from './exec.js'
import { append } from './journal.js'
import { pushRefusal } from './protect.js'
import { getProject, requireWorkspace } from './registry.js'

/**
 * §5 — the `review` capability: pull requests, on the host `origin` lives on.
 *
 * Two hosts, GitHub and Bitbucket Cloud, spoken to over their REST APIs with
 * the credential git already uses to push there — read from git's own
 * credential helper (the macOS keychain, usually), never stored by Cockpit,
 * never written to the journal. A repository whose remote is neither, or
 * whose credential git does not have, has no PR verbs and says why.
 *
 * Whether a pull request conflicts with its target is not asked of the host:
 * Bitbucket does not say, and GitHub says it late. It is computed here, from
 * the fetched refs, with `git merge-tree` — the same answer for both, and the
 * one the Conflicts tool will actually meet when the base is merged in.
 */

interface Remote {
  host: ReviewHost
  owner: string
  repo: string
  /** The host name git keeps the credential under, and the user in the URL, if any. */
  domain: string
  user: string | null
}

export function parseRemote(url: string): Remote | null {
  const m =
    /^https?:\/\/(?:([^@/]+)@)?([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url) ??
    /^(?:ssh:\/\/)?(?:([^@/]+)@)?([^:/]+)[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url)
  if (!m) return null
  const domain = m[2]!.toLowerCase()
  const host: ReviewHost | null = domain === 'github.com' ? 'github' : domain === 'bitbucket.org' ? 'bitbucket' : null
  if (!host) return null
  // `git@` is ssh's account, not anybody's username on the host.
  const user = m[1] && m[1] !== 'git' ? decodeURIComponent(m[1].split(':')[0]!) : null
  return { host, owner: m[3]!, repo: m[4]!, domain, user }
}

async function remoteOf(cwd: string): Promise<Remote | null> {
  const r = await git(cwd, ['remote', 'get-url', 'origin'], 5_000)
  return r.ok ? parseRemote(r.stdout.trim()) : null
}

/**
 * The credential git would push with. `git credential fill` asks every
 * configured helper and prompts nobody: no terminal, no GUI fallback.
 */
async function credential(cwd: string, rem: Remote): Promise<Cred | null> {
  const input = 'protocol=https\nhost=' + rem.domain + '\n' + (rem.user ? 'username=' + rem.user + '\n' : '') + '\n'
  const r = await run('git', ['-c', 'credential.interactive=never', 'credential', 'fill'], {
    cwd,
    input,
    timeoutMs: 15_000,
    env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '/usr/bin/false', SSH_ASKPASS: '/usr/bin/false' },
  })
  if (!r.ok) return null
  const kv = Object.fromEntries(
    r.stdout.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  )
  if (!kv.password) return null
  const out: Cred = { user: kv.username ?? rem.user ?? '', secret: kv.password }
  // Bitbucket's API tokens push with any username but answer the REST API
  // only to the Atlassian account's email. The repository's own git email is
  // that address far more often than not, and it is offered as the second try.
  if (rem.host === 'bitbucket') {
    const email = (await git(cwd, ['config', 'user.email'], 5_000)).stdout.trim()
    if (email && email !== out.user) out.alt = email
  }
  return out
}

interface Cred {
  user: string
  secret: string
  /** A second username to try when the host refuses the first one for being one. */
  alt?: string
}

class HostError extends Error {}

async function api(
  rem: Remote,
  cred: Cred,
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const base = rem.host === 'github' ? 'https://api.github.com' : 'https://api.bitbucket.org/2.0'
  const auth =
    rem.host === 'github'
      ? 'Bearer ' + cred.secret
      : 'Basic ' + Buffer.from(cred.user + ':' + cred.secret).toString('base64')
  const res = await fetch(base + path, {
    method,
    headers: {
      Authorization: auth,
      Accept: rem.host === 'github' ? 'application/vnd.github+json' : 'application/json',
      'User-Agent': 'cockpit',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  })
  // Asked once more as the email, and kept that way for the rest of the call.
  if (res.status === 401 && rem.host === 'bitbucket' && cred.alt) {
    const first = await res.clone().text()
    if (/email/i.test(first)) {
      cred.user = cred.alt
      delete cred.alt
      return api(rem, cred, method, path, body)
    }
  }
  const text = await res.text()
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!res.ok) {
    const why = data?.message ?? data?.error?.message ?? text.slice(0, 200)
    if (res.status === 401 || res.status === 403) {
      throw new HostError(
        (rem.host === 'github' ? 'GitHub' : 'Bitbucket') + ' refused the credential git pushes with (' + res.status + '). ' +
          (rem.host === 'bitbucket'
            ? /email/i.test(text) ? 'An Atlassian API token is answered only for your Atlassian email; set it as this repository\'s git user.email.' : 'An app password or API token needs the "Pull requests: read and write" scope.'
            : 'The token needs the "repo" scope, or "Pull requests: write" for a fine-grained one.'),
      )
    }
    throw new HostError((rem.host === 'github' ? 'GitHub' : 'Bitbucket') + ': ' + why)
  }
  return data
}

/* ── one shape for both hosts ─────────────────────────────────────────── */

function fromGithub(p: any): Omit<PullRequest, 'conflicts' | 'checks' | 'review'> {
  return {
    host: 'github',
    number: p.number,
    url: p.html_url,
    title: p.title,
    state: p.merged_at ? 'merged' : p.state === 'closed' ? 'closed' : p.draft ? 'draft' : 'open',
    source: p.head?.ref ?? '',
    target: p.base?.ref ?? '',
    author: p.user?.login ?? null,
  }
}

function fromBitbucket(p: any): Omit<PullRequest, 'conflicts' | 'checks' | 'review'> {
  return {
    host: 'bitbucket',
    number: p.id,
    url: p.links?.html?.href ?? '',
    title: p.title,
    state: p.state === 'MERGED' ? 'merged' : p.state === 'OPEN' ? (p.draft ? 'draft' : 'open') : 'closed',
    source: p.source?.branch?.name ?? '',
    target: p.destination?.branch?.name ?? '',
    author: p.author?.display_name ?? null,
  }
}

async function findPr(rem: Remote, cred: Cred, branch: string): Promise<any | null> {
  const enc = encodeURIComponent
  if (rem.host === 'github') {
    const open = await api(rem, cred, 'GET', `/repos/${rem.owner}/${rem.repo}/pulls?state=open&head=${enc(rem.owner + ':' + branch)}`)
    if (open?.length) return open[0]
    const all = await api(rem, cred, 'GET', `/repos/${rem.owner}/${rem.repo}/pulls?state=closed&per_page=5&head=${enc(rem.owner + ':' + branch)}`)
    return all?.[0] ?? null
  }
  const q = enc(`source.branch.name="${branch}"`)
  const list = await api(
    rem, cred, 'GET',
    `/repositories/${rem.owner}/${rem.repo}/pullrequests?q=${q}&state=OPEN&state=MERGED&state=DECLINED&sort=-updated_on&pagelen=5`,
  )
  const vals: any[] = list?.values ?? []
  return vals.find((p) => p.state === 'OPEN') ?? vals[0] ?? null
}

async function checksOf(rem: Remote, cred: Cred, raw: any): Promise<PullRequest['checks']> {
  try {
    let states: string[]
    if (rem.host === 'github') {
      const runs = await api(rem, cred, 'GET', `/repos/${rem.owner}/${rem.repo}/commits/${raw.head.sha}/check-runs?per_page=50`)
      states = (runs?.check_runs ?? []).map((c: any) =>
        c.status !== 'completed' ? 'pending' : ['success', 'neutral', 'skipped'].includes(c.conclusion) ? 'ok' : 'fail',
      )
    } else {
      const st = await api(rem, cred, 'GET', `/repositories/${rem.owner}/${rem.repo}/pullrequests/${raw.id}/statuses?pagelen=50`)
      states = (st?.values ?? []).map((c: any) =>
        c.state === 'INPROGRESS' ? 'pending' : c.state === 'SUCCESSFUL' ? 'ok' : 'fail',
      )
    }
    if (!states.length) return null
    return states.includes('fail') ? 'failing' : states.includes('pending') ? 'pending' : 'passing'
  } catch {
    return null
  }
}

async function reviewOf(rem: Remote, cred: Cred, raw: any): Promise<PullRequest['review']> {
  try {
    if (rem.host === 'bitbucket') {
      const ps: any[] = raw.participants ?? []
      if (ps.some((p) => p.state === 'changes_requested')) return 'changes'
      if (ps.some((p) => p.approved)) return 'approved'
      return 'waiting'
    }
    const rs: any[] = await api(rem, cred, 'GET', `/repos/${rem.owner}/${rem.repo}/pulls/${raw.number}/reviews?per_page=100`)
    // The last word of each reviewer is the one that stands.
    const last = new Map<string, string>()
    for (const r of rs ?? []) if (r.state !== 'COMMENTED') last.set(r.user?.login, r.state)
    const v = [...last.values()]
    if (v.includes('CHANGES_REQUESTED')) return 'changes'
    if (v.includes('APPROVED')) return 'approved'
    return 'waiting'
  } catch {
    return null
  }
}

/** Would merging the target into this branch stop on a conflict? Null when git cannot say. */
async function conflictsWith(cwd: string, target: string): Promise<boolean | null> {
  const r = await git(cwd, ['merge-tree', '--write-tree', '--quiet', 'origin/' + target, 'HEAD'], 30_000)
  if (r.code === 0) return false
  if (r.code === 1) return true
  return null
}

/* ── the verbs ────────────────────────────────────────────────────────── */

const cache = new Map<string, { at: number; status: ReviewStatus }>()
const FRESH = 45_000

function landingOf(workspaceId: string) {
  const ws = requireWorkspace(workspaceId)
  const s = getProject(ws.projectId)?.settings
  return { ws, landing: s?.landing ?? 'send', mergeHere: !!s?.mergeHere }
}

export async function status(workspaceId: string, opts: { force?: boolean } = {}): Promise<ReviewStatus> {
  const hit = cache.get(workspaceId)
  if (!opts.force && hit && Date.now() - hit.at < FRESH) return hit.status
  const out = await probe(workspaceId, opts.force)
  cache.set(workspaceId, { at: Date.now(), status: out })
  return out
}

async function probe(workspaceId: string, force?: boolean): Promise<ReviewStatus> {
  const { ws, mergeHere } = landingOf(workspaceId)
  const base: ReviewStatus = { workspaceId, host: null, pr: null, error: null, mergeHere }
  if (!ws.repo) return base
  const rem = await remoteOf(ws.path)
  if (!rem) return { ...base, error: 'origin is not on GitHub or Bitbucket' }
  base.host = rem.host
  const branch = ws.git?.branch
  if (!branch) return base
  const cred = await credential(ws.path, rem)
  if (!cred) {
    return { ...base, error: 'git has no stored credential for ' + rem.domain + ' to read pull requests with. Push once over https so it keeps one.' }
  }
  try {
    await fetchRemote(ws.path, { force })
    const raw = await findPr(rem, cred, branch)
    if (!raw) return base
    const shape = rem.host === 'github' ? fromGithub(raw) : fromBitbucket(raw)
    const live = shape.state === 'open' || shape.state === 'draft'
    const [checks, review, conflicts] = live
      ? await Promise.all([checksOf(rem, cred, raw), reviewOf(rem, cred, raw), conflictsWith(ws.path, shape.target)])
      : [null, null, null]
    return { ...base, pr: { ...shape, checks, review, conflicts } }
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Opens a pull request from this checkout's branch into `target`, pushing the
 * branch first if origin does not have all of it. The push is the click that
 * asked for the request: it is said in the dialog that asks.
 */
export async function open(
  workspaceId: string,
  input: { title: string; body: string; target: string },
): Promise<{ ok: boolean; detail: string; status: ReviewStatus | null }> {
  const ws = requireWorkspace(workspaceId)
  const branch = ws.git?.branch
  if (!branch) return { ok: false, detail: ws.name + ': detached HEAD, there is no branch to open a pull request from', status: null }
  if (branch === input.target) return { ok: false, detail: ws.name + ' is on ' + branch + ' itself', status: null }
  const rem = await remoteOf(ws.path)
  if (!rem) return { ok: false, detail: ws.name + ': origin is not on GitHub or Bitbucket', status: null }
  const cred = await credential(ws.path, rem)
  if (!cred) return { ok: false, detail: ws.name + ': git has no stored credential for ' + rem.domain, status: null }

  const refusal = await pushRefusal(ws, branch)
  if (refusal) return { ok: false, detail: refusal, status: null }
  const push = await git(ws.path, ['push', '-u', 'origin', branch], 120_000)
  if (!push.ok) return { ok: false, detail: ws.name + ': push refused. ' + push.stderr.trim().split('\n').slice(-2).join(' '), status: null }

  try {
    const existing = await findPr(rem, cred, branch)
    const live = existing && (rem.host === 'github' ? existing.state === 'open' : existing.state === 'OPEN')
    if (!live) {
      if (rem.host === 'github') {
        await api(rem, cred, 'POST', `/repos/${rem.owner}/${rem.repo}/pulls`, {
          title: input.title, body: input.body, head: branch, base: input.target,
        })
      } else {
        await api(rem, cred, 'POST', `/repositories/${rem.owner}/${rem.repo}/pullrequests`, {
          title: input.title,
          description: input.body,
          source: { branch: { name: branch } },
          destination: { branch: { name: input.target } },
          close_source_branch: false,
        })
      }
    }
    append({ type: 'review.opened', workspaceId, payload: { branch, target: input.target, host: rem.host, existed: !!live } })
    const s = await status(workspaceId, { force: true })
    return { ok: true, detail: live ? 'a pull request was already open; branch pushed to it' : 'pull request opened', status: s }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e), status: null }
  }
}

/** Merges the pull request on the host. Only where the project says Cockpit may. */
export async function merge(workspaceId: string): Promise<{ ok: boolean; detail: string; status: ReviewStatus | null }> {
  const { ws, landing, mergeHere } = landingOf(workspaceId)
  if (landing !== 'pr' || !mergeHere) {
    return { ok: false, detail: 'this project merges its pull requests outside Cockpit', status: null }
  }
  const s = await status(workspaceId, { force: true })
  const pr = s.pr
  if (!pr || pr.state !== 'open') return { ok: false, detail: 'no open pull request for this branch', status: s }
  if (pr.conflicts) return { ok: false, detail: 'it conflicts with ' + pr.target + '. Resolve the conflicts first.', status: s }
  const rem = (await remoteOf(ws.path))!
  const cred = await credential(ws.path, rem)
  if (!cred) return { ok: false, detail: 'git has no stored credential for ' + rem.domain, status: s }
  try {
    if (rem.host === 'github') {
      await api(rem, cred, 'PUT', `/repos/${rem.owner}/${rem.repo}/pulls/${pr.number}/merge`, { merge_method: 'merge' })
    } else {
      await api(rem, cred, 'POST', `/repositories/${rem.owner}/${rem.repo}/pullrequests/${pr.number}/merge`, {
        merge_strategy: 'merge_commit',
        close_source_branch: false,
      })
    }
    append({ type: 'review.merged', workspaceId, payload: { number: pr.number, target: pr.target, host: rem.host } })
    return { ok: true, detail: '#' + pr.number + ' merged into ' + pr.target, status: await status(workspaceId, { force: true }) }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e), status: s }
  }
}
