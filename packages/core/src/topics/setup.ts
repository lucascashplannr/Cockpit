import { basename } from 'node:path'
import { scopedName, stableId } from '@cockpit/shared'
import type { ManifestV1, PlanStep, PreparationStep, SeedContext, Workspace } from '@cockpit/shared'
import * as database from '../database.js'
import { findManifest, guessKey, readManifest } from '../detect.js'
import { append } from '../journal.js'
import * as registry from '../registry.js'
import * as seed from '../seed.js'
import * as sup from '../supervisor.js'
import { splitArgs } from '../runtime/template.js'
import * as preparing from './preparing.js'
import * as store from './store.js'

/**
 * §7 — the other half of what `git worktree add` cannot give you.
 *
 * The seed carries the files; this runs what a checkout still needs once they
 * are there — `composer install`, `herd link {{scoped}}`, `herd isolate 8.2` —
 * written in `worktrees.setup`, by repository, because only the project knows
 * that its Laravel 9 wants PHP 8.2 when Herd's default is 8.4.
 *
 * It runs after the plan rather than inside it. A plan step that fails takes
 * the worktrees back (§3.7), and a failed `composer install` is no reason to:
 * the topic is there, its branch is right, and the fix is to run the line
 * again — so the topic stays, says what failed, and offers exactly that.
 */

export interface SetupLine {
  /** The `worktrees.setup` key it came from. */
  repo: string
  cwd: string
  command: string
}

/** A checkout the topic will have, and how a `worktrees.setup` key names it. */
export interface SetupTarget {
  /** `Workspace.repoName`; empty for the topic's own folder, which `.` names. */
  repoName: string
  cwd: string
  /** The main checkout, whose `.env` names the database `{{db}}` derives from. */
  mainPath: string | null
}

function manifestOf(projectId: string): ManifestV1 | null {
  const project = registry.getProject(projectId)
  const path = project?.manifestPath ?? (project ? findManifest(project.root) : null)
  return path ? readManifest(path).manifest : null
}

/** Whether a project declares anything to run, so callers skip the work when not. */
export function declared(projectId: string): boolean {
  const st = manifestOf(projectId)?.worktrees?.setup
  return !!st && Object.values(st).some((l) => l.length > 0)
}

/**
 * Every line, resolved for the worktrees this topic will have.
 *
 * A placeholder Cockpit does not know is left standing and named: running
 * `herd link {{scope}}` verbatim would link a site called `{{scope}}`.
 */
export async function resolve(
  projectId: string,
  slug: string,
  targets: SetupTarget[],
): Promise<{ lines: SetupLine[]; warnings: string[] }> {
  const manifest = manifestOf(projectId)
  const declaredSetup = manifest?.worktrees?.setup ?? {}
  const tld = String((manifest?.herd as { tld?: unknown } | undefined)?.tld ?? 'test')
  const lines: SetupLine[] = []
  const warnings: string[] = []

  for (const t of targets) {
    const key = guessKey(t.repoName)
    const list = declaredSetup[key] ?? (t.repoName ? declaredSetup[basename(t.cwd)] : undefined)
    if (!list?.length) continue

    const ctx = await contextOf(projectId, slug, t, tld, list)
    for (const template of list) {
      const command = seed.resolveTemplate(template, ctx)
      const left = [...command.matchAll(/\{\{([\w:.-]+)\}\}/g)].map((m) => '{{' + m[1] + '}}')
      if (left.length) warnings.push(key + ': nothing named ' + left.join(', ') + ' in "' + template + '"')
      lines.push({ repo: key, cwd: t.cwd, command })
    }
  }
  return { lines, warnings }
}

/**
 * The seed's context, built only as far as the lines ask: `{{port}}` allocates
 * a port and `{{db}}` reads a `.env`, and `herd link {{scoped}}` needs neither.
 */
async function contextOf(
  projectId: string,
  slug: string,
  t: SetupTarget,
  tld: string,
  list: string[],
): Promise<SeedContext> {
  const repo = t.repoName || basename(t.cwd)
  const scoped = scopedName(repo, slug)
  const cheap: SeedContext = { slug, repo, scoped, host: scoped + '.' + tld, ports: {}, db: '', path: t.cwd }
  const wants = list.join('\n')
  if (!t.mainPath || !/\{\{(port|db)\b/.test(wants)) return cheap
  const services = [...wants.matchAll(/\{\{port(?::(\w+))?\}\}/g)].map((m) => m[1] ?? 'web')
  const ctx = await seed.contextFor({
    projectId,
    repoPath: t.mainPath,
    slug,
    tld,
    baseDb: database.connectionOf(t.mainPath)?.database ?? null,
    services,
  })
  return { ...ctx, path: t.cwd }
}

/** What the plan shows under its commands. */
export function asSteps(lines: SetupLine[]): PlanStep[] {
  return lines.map((l) => ({
    title: l.repo === '.' ? 'Topic folder' : l.repo,
    command: l.command,
    cwd: l.cwd,
    destructive: false,
  }))
}

const runs = new Map<string, Promise<void>>()

/** Resolves once this topic's setup is over, however it ended. Start waits on it. */
export function settled(topicId: string): Promise<void> {
  return runs.get(topicId) ?? Promise.resolve()
}

export function running(topicId: string): boolean {
  return runs.has(topicId)
}

function workspaceAt(path: string): string {
  return registry.allWorkspaces().find((w) => w.path === path)?.id ?? stableId('ws', path)
}

/**
 * Run the lines, repositories side by side, each list in order and stopping
 * at its first failure. Not awaited by whoever opened the topic: the topic is
 * usable — a conversation can start in it — while `composer install` runs.
 */
export function begin(topicId: string, projectId: string, rootPath: string | null, lines: SetupLine[]): Promise<void> {
  if (!lines.length) return Promise.resolve()
  const prior = runs.get(topicId)
  if (prior) return prior

  const byRepo = new Map<string, SetupLine[]>()
  for (const l of lines) byRepo.set(l.repo, [...(byRepo.get(l.repo) ?? []), l])

  const steps: PreparationStep[] = [...byRepo.entries()].map(([repo, ls]) => ({
    repo,
    workspaceId: workspaceAt(ls[0]!.cwd),
    state: 'running',
    command: ls[0]!.command,
  }))
  const publish = () => {
    const failed = steps.some((s) => s.state === 'failed')
    const busy = steps.some((s) => s.state === 'running')
    preparing.set(
      topicId,
      rootPath,
      busy || failed ? { state: busy ? 'running' : 'failed', steps: steps.map((s) => ({ ...s })) } : null,
    )
  }
  publish()

  const run = Promise.all(
    [...byRepo.values()].map(async (ls, i) => {
      const step = steps[i]!
      for (const l of ls) {
        step.command = l.command
        // The workspace exists by now; at `begin` it may only have been a path.
        step.workspaceId = workspaceAt(l.cwd)
        publish()
        const argv = splitArgs(l.command)
        const proc = sup.start({
          workspaceId: step.workspaceId,
          label: 'setup',
          cwd: l.cwd,
          command: argv[0] ?? '',
          args: argv.slice(1),
        })
        const code = await sup.waitFor(proc.id)
        if (code !== 0) {
          step.state = 'failed'
          // FORCE_COLOR is on for every supervised process; a tooltip is not a terminal.
          const said = sup.tail(proc.id, 8).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim()
          step.detail = said || (code === null ? 'did not start' : 'exited with code ' + code)
          // Said now, not when the slowest repository is done: a typo in the
          // first line should not wait behind someone else's `npm install`.
          publish()
          return
        }
      }
      step.state = 'done'
      publish()
    }),
  ).then(() => {
    const failed = steps.filter((s) => s.state === 'failed')
    append({
      type: 'worktree.setup',
      level: failed.length ? 'warn' : 'info',
      projectId,
      payload: {
        topicId,
        lines: lines.length,
        failed: failed.map((s) => ({ repo: s.repo, command: s.command, detail: s.detail })),
      },
    })
    runs.delete(topicId)
    publish()
  })
  runs.set(topicId, run)
  return run
}

/**
 * Again, where it failed — read afresh from the manifest, since editing the
 * line that failed is the usual fix. A repository that finished is left alone.
 */
export async function rerun(topicId: string): Promise<{ ok: boolean; detail: string }> {
  const rec = store.get(topicId)
  if (!rec) throw new Error('unknown topic: ' + topicId)
  if (runs.has(topicId)) return { ok: false, detail: 'setup is already running' }

  const failed = new Set(
    (preparing.get(topicId, rec.rootPath)?.steps ?? []).filter((s) => s.state === 'failed').map((s) => s.repo),
  )
  const all = targetsOf(topicId, rec.projectId)
  const { lines } = await resolve(rec.projectId, rec.slug, all)
  const again = failed.size ? lines.filter((l) => failed.has(l.repo)) : lines
  if (!again.length) {
    preparing.set(topicId, rec.rootPath, null)
    return { ok: true, detail: 'nothing to set up' }
  }
  void begin(topicId, rec.projectId, rec.rootPath, again)
  return { ok: true, detail: 'setting up' }
}

/** The checkouts an open topic has, as `resolve` wants them. */
function targetsOf(topicId: string, projectId: string): SetupTarget[] {
  const mains = registry.allWorkspaces(projectId).filter((w) => w.kind === 'main' && w.repo)
  return registry
    .allWorkspaces(projectId)
    .filter((w: Workspace) => w.topicId === topicId && (w.repo || w.kind === 'group'))
    .map((w) => ({
      repoName: w.repoName,
      cwd: w.path,
      mainPath: mains.find((m) => m.repoName === w.repoName)?.path ?? null,
    }))
}
