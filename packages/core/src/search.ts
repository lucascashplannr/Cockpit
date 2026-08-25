import type { SearchHit } from '@cockpit/shared'
import { run, which } from './exec.js'
import { getWorkspace } from './registry.js'

/**
 * §12 — "Recherche plein texte … recherche simultanée dans tous les repos
 * d'une feature." That cross-repo query is the thing no IDE gives easily, and
 * it is why search counts as navigation here rather than as a feature.
 */

let engine: 'rg' | 'git-grep' | null = null

async function pickEngine(): Promise<'rg' | 'git-grep'> {
  if (engine) return engine
  engine = (await which('rg')) ? 'rg' : 'git-grep'
  return engine
}

export interface SearchOptions {
  workspaceIds: string[]
  query: string
  regex?: boolean
  caseSensitive?: boolean
  max?: number
}

export async function text(opts: SearchOptions): Promise<{
  hits: SearchHit[]
  truncated: boolean
  engine: string
}> {
  const max = Math.min(opts.max ?? 400, 2000)
  const eng = await pickEngine()
  const hits: SearchHit[] = []
  let truncated = false

  for (const wsId of opts.workspaceIds) {
    if (hits.length >= max) {
      truncated = true
      break
    }
    const ws = getWorkspace(wsId)
    if (!ws) continue

    const remaining = max - hits.length
    const found = eng === 'rg'
      ? await ripgrep(ws.path, opts, remaining)
      : await gitGrep(ws.path, opts, remaining)

    for (const h of found) hits.push({ ...h, workspaceId: wsId })
  }

  return { hits, truncated: truncated || hits.length >= max, engine: eng }
}

async function ripgrep(
  cwd: string,
  opts: SearchOptions,
  limit: number,
): Promise<Omit<SearchHit, 'workspaceId'>[]> {
  const args = [
    '--json',
    '--max-count', '50',
    '--max-filesize', '2M',
    '--glob', '!node_modules',
    '--glob', '!.git',
    '--glob', '!vendor',
    '--glob', '!dist',
  ]
  if (!opts.regex) args.push('--fixed-strings')
  if (!opts.caseSensitive) args.push('--ignore-case')
  args.push('--', opts.query, '.')

  const r = await run('rg', args, { cwd, timeoutMs: 20_000 })
  const out: Omit<SearchHit, 'workspaceId'>[] = []
  for (const line of r.stdout.split('\n')) {
    if (out.length >= limit) break
    if (!line.startsWith('{')) continue
    try {
      const o = JSON.parse(line) as {
        type: string
        data?: {
          path?: { text?: string }
          line_number?: number
          lines?: { text?: string }
          submatches?: { start: number }[]
        }
      }
      if (o.type !== 'match' || !o.data) continue
      out.push({
        path: (o.data.path?.text ?? '').replace(/^\.\//, ''),
        line: o.data.line_number ?? 0,
        column: (o.data.submatches?.[0]?.start ?? 0) + 1,
        text: (o.data.lines?.text ?? '').replace(/\n$/, '').slice(0, 400),
      })
    } catch {
      /* skip malformed line */
    }
  }
  return out
}

/** Fallback when ripgrep is not installed. Slower, but always available. */
async function gitGrep(
  cwd: string,
  opts: SearchOptions,
  limit: number,
): Promise<Omit<SearchHit, 'workspaceId'>[]> {
  const args = ['grep', '-n', '--column', '--untracked']
  if (!opts.regex) args.push('--fixed-strings')
  if (!opts.caseSensitive) args.push('--ignore-case')
  args.push('-e', opts.query)

  const r = await run('git', args, { cwd, timeoutMs: 20_000 })
  const out: Omit<SearchHit, 'workspaceId'>[] = []
  for (const line of r.stdout.split('\n')) {
    if (out.length >= limit) break
    const m = /^(.+?):(\d+):(\d+):(.*)$/.exec(line)
    if (!m) continue
    out.push({
      path: m[1]!,
      line: Number(m[2]),
      column: Number(m[3]),
      text: (m[4] ?? '').slice(0, 400),
    })
  }
  return out
}
