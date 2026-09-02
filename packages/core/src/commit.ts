import { basename } from 'node:path'
import { newId } from '@cockpit/shared'
import type { CommitPreview, PlanPreview, PlanStep } from '@cockpit/shared'
import { run, which } from './exec.js'
import { git } from './git.js'
import { append } from './journal.js'
import * as plans from './plans.js'
import * as registry from './registry.js'

/**
 * §16 — "revue humaine du diff avant tout commit."
 *
 * The review was built and the commit was not, which left the loop open at
 * exactly the point it mattered: `topic.close` refuses over uncommitted
 * changes, so Cockpit blocked you on a state it gave you no way to leave. You
 * had to go to a terminal, which is the one thing this window exists to avoid.
 *
 * A topic spans repositories, so committing is one act across all of them
 * with one message — the same shape as opening it and rebasing it. Repos with
 * nothing staged are skipped rather than made to carry an empty commit.
 */

/**
 * What a commit would cover, without saying anything about the message. The
 * preview and the draft both ask this question and neither has a message to
 * give — a scope is not a commit until someone has written one.
 */
export interface CommitScope {
  /** Commit in every repository of this topic. */
  topicId?: string
  /** Or in exactly these workspaces. One of the two is required. */
  workspaceIds?: string[]
  /**
   * Stage everything first, untracked included. Off means "commit what is
   * already staged", which is the answer when the Diff tab was used to pick.
   */
  all: boolean
}

export interface CommitInput extends CommitScope {
  message: string
}

/**
 * What each repository would contribute, before anything is written.
 *
 * Re-probed rather than read off the registry (§3.4). The cached state is
 * refreshed by the watcher and by a 60-second reconcile, and either is too
 * late here: a stale count means offering to commit files that are no longer
 * there, or refusing with "nothing to commit" over work that plainly exists.
 */
export async function preview(input: CommitScope): Promise<CommitPreview[]> {
  const out: CommitPreview[] = []
  for (const target of resolveTargets(input)) {
    const w = (await registry.refreshGit(target.id)) ?? target
    const g = w.git
    if (!g) continue
    const staged = g.staged
    const unstaged = g.unstaged + g.untracked
    out.push({
      workspaceId: w.id,
      repo: w.name,
      branch: g.branch,
      staged,
      unstaged,
      // §16 — a commit on the protected branch is the one this must never make.
      // The branch name check is the window's approximation; `plan` re-checks.
      willCommit: input.all ? staged + unstaged > 0 : staged > 0,
      conflicted: g.conflicted,
    })
  }
  return out
}

function resolveTargets(input: CommitScope) {
  if (input.workspaceIds?.length) {
    return input.workspaceIds.map((id) => registry.requireWorkspace(id)).filter((w) => w.repo)
  }
  if (!input.topicId) throw new Error('commit needs a topic or a set of workspaces')
  const f = registry.getTopic(input.topicId)
  if (!f) throw new Error('unknown topic: ' + input.topicId)
  return registry
    .allWorkspaces(f.projectId)
    .filter((w) => w.topicId === input.topicId && w.repo && w.kind !== 'group')
}

/**
 * §3.7 — a commit is an operation, so it gets a plan like everything else.
 * The message is quoted as one argument; `tokenize` honours quotes, and a
 * message with a space in it was the first thing that needed that to be true.
 */
export async function plan(input: CommitInput): Promise<{
  ok: boolean
  detail: string
  plan: PlanPreview | null
  preview: CommitPreview[]
}> {
  const message = input.message.trim()
  if (!message) return { ok: false, detail: 'a commit needs a message', plan: null, preview: [] }
  if (message.includes('"')) {
    // The plan is a shown command; a double quote in the message would break
    // the argv it is tokenized back into. Refusing beats committing something
    // other than what was previewed.
    return {
      ok: false,
      detail: 'the message cannot contain a double quote — the plan shows the exact command it runs',
      plan: null,
      preview: [],
    }
  }

  // preview() re-probes, so the rows below are current and the targets can be
  // read back from the registry afterwards without a second round of git.
  const rows = await preview(input)
  const targets = resolveTargets(input)
  const steps: PlanStep[] = []
  const warnings: string[] = []
  const repos: string[] = []

  for (const w of targets) {
    const row = rows.find((r) => r.workspaceId === w.id)
    if (!row) continue

    if (row.conflicted > 0) {
      return {
        ok: false,
        detail: w.name + ' has ' + row.conflicted + ' unresolved conflict(s); finish that first',
        plan: null,
        preview: rows,
      }
    }

    // §7 + §16 — never a commit on the protected branch. The same rule agents
    // live under; a human clicking a button is not an exemption.
    const base = await defaultBranchOf(w.path)
    if (row.branch && row.branch === base) {
      warnings.push(w.name + ' is on ' + base + ' and will be skipped — Cockpit does not commit to the protected branch.')
      continue
    }
    if (!row.willCommit) continue

    if (input.all) {
      steps.push({
        title: w.name + ': stage everything',
        command: 'git add -A',
        cwd: w.path,
        destructive: false,
      })
    }
    steps.push({
      title: w.name + ': commit ' + (input.all ? row.staged + row.unstaged : row.staged) + ' file(s)',
      command: 'git commit -m "' + message + '"',
      cwd: w.path,
      destructive: false,
    })
    repos.push(w.name)
  }

  if (!steps.length) {
    return {
      ok: false,
      detail: warnings.length ? warnings.join(' ') : 'nothing to commit',
      plan: null,
      preview: rows,
    }
  }

  if (repos.length > 1) {
    warnings.push(
      'One message, ' + repos.length + ' commits — one per repository. Git has no cross-repo commit; this is as close as it gets.',
    )
  }

  const p: PlanPreview = {
    planId: newId('plan_'),
    operation: 'commit',
    steps,
    warnings,
    capturesRestorePoint: false,
    repos,
    // A commit that fails in the third repo leaves the first two committed,
    // and that is correct: those commits are good work, and `git reset` to
    // "recover" from a hook rejecting one repo would throw them away.
    onFailure: 'halt',
  }
  plans.register(p, { workspaceIds: targets.map((w) => w.id) })
  return { ok: true, detail: repos.length + ' repository(ies)', plan: p, preview: rows }
}

async function defaultBranchOf(cwd: string): Promise<string> {
  const r = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], 10_000)
  if (r.ok && r.stdout.trim()) return r.stdout.trim().replace(/^origin\//, '')
  for (const cand of ['main', 'master', 'develop']) {
    const v = await git(cwd, ['rev-parse', '--verify', '--quiet', cand], 10_000)
    if (v.ok && v.stdout.trim()) return cand
  }
  return 'main'
}

export { basename }

/* ── §16 — drafting the message, never the commit ─────────────────────────
 *
 * The message box was the last place in the loop where the window offered
 * nothing and the terminal offered plenty. Writing one by hand is fine; being
 * unable to get a first sentence out of a diff you have just read, in a window
 * whose whole premise is that an engine is already sitting next to the code,
 * was not.
 *
 * What it deliberately does not do is commit. The draft lands in the same
 * field a person types in, and what is committed is whatever stands there
 * after they have read it — because §16 says an agent never commits, and §12
 * could not attribute a commit nobody looked at.
 */

/** Enough diff to write about; past this, the summary carries the rest. */
const DRAFT_DIFF_BUDGET = 48_000

export interface DraftInput extends CommitScope {
  /** What the person already knows and the diff does not say. Optional. */
  hint?: string
}

export interface DraftResult {
  ok: boolean
  detail: string
  message: string
  engine: string
  /** The diff did not fit and the draft was written from part of it. */
  truncated: boolean
}

/**
 * What the engine is shown: the same scope the commit would take, per repo,
 * as `--stat` plus as much patch as the budget allows. Untracked files are
 * named rather than pasted — a new 2000-line lockfile would eat the budget
 * and say nothing the filename does not.
 */
async function draftContext(
  input: DraftInput,
): Promise<{ text: string; repos: string[]; truncated: boolean }> {
  const rows = await preview(input)
  const parts: string[] = []
  const repos: string[] = []
  let budget = DRAFT_DIFF_BUDGET
  let truncated = false

  for (const w of resolveTargets(input)) {
    const row = rows.find((r) => r.workspaceId === w.id)
    if (!row?.willCommit) continue
    repos.push(w.name)

    // `--cached` when the Diff tab was used to pick, the whole worktree when
    // "stage everything" is on: the draft has to describe what will be
    // committed, not what happens to be lying around.
    const scope = input.all ? ['HEAD'] : ['--cached']
    const [stat, patch, untracked] = await Promise.all([
      git(w.path, ['diff', ...scope, '--stat'], 20_000),
      git(w.path, ['diff', ...scope, '--no-color', '--unified=3'], 30_000),
      input.all
        ? git(w.path, ['ls-files', '--others', '--exclude-standard'], 20_000)
        : Promise.resolve({ ok: true, stdout: '', stderr: '', code: 0 }),
    ])

    const head = ['# repository: ' + w.name + ' (branch ' + (row.branch ?? '?') + ')']
    if (stat.stdout.trim()) head.push(stat.stdout.trim())
    const news = untracked.stdout.split('\n').filter(Boolean)
    if (news.length) head.push('new files: ' + news.join(', '))

    let body = patch.stdout
    if (body.length > budget) {
      body = body.slice(0, budget)
      truncated = true
    }
    budget -= body.length
    parts.push(head.join('\n') + '\n\n' + body)
    if (budget <= 0) {
      truncated = truncated || repos.length < rows.filter((r) => r.willCommit).length
      break
    }
  }

  return { text: parts.join('\n\n'), repos, truncated }
}

/**
 * The repository's own last ten subjects. A draft that ignores the convention
 * the log has followed for two years is one more thing to rewrite by hand, and
 * no prompt of ours knows whether this project writes `feat:` or `Fix the…`.
 */
async function styleExamples(cwd: string): Promise<string[]> {
  const r = await git(cwd, ['log', '-10', '--format=%s'], 10_000)
  if (!r.ok) return []
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
}

export async function draftMessage(input: DraftInput): Promise<DraftResult> {
  const engine = 'claude'
  const bin = await which(engine)
  if (!bin) {
    // Named rather than papered over: the box still takes a typed message, and
    // "nothing happened" would send someone hunting for a bug in the button.
    return {
      ok: false,
      detail: 'the claude CLI is not on PATH — type the message, or install it',
      message: '',
      engine,
      truncated: false,
    }
  }

  const ctx = await draftContext(input)
  if (!ctx.text.trim()) {
    return { ok: false, detail: 'nothing to describe', message: '', engine, truncated: false }
  }

  const first = resolveTargets(input)[0]
  const examples = first ? await styleExamples(first.path) : []
  const hint = (input.hint ?? '').trim()

  const prompt = [
    'Write the commit message for the change below. Reply with the message and nothing else:',
    'no preamble, no explanation, no code fences, no quotation marks around it.',
    '',
    'Rules:',
    '- First line: imperative, concrete, at most 72 characters.',
    '- Say what changed and why it changed. Never describe the diff mechanically',
    '  ("update file X"), and never invent a reason the diff does not support.',
    '- Add a body only if the change has a reason that is not obvious from the',
    '  first line. Blank line before it, wrapped at 72 columns, no bullet padding.',
    '- The body says why the change was made. It is not a code review: do not',
    '  point out bugs, risks or missing pieces in the diff, however tempting.',
    ...(ctx.repos.length > 1
      ? ['- This message will be used for ' + ctx.repos.length + ' repositories (' +
         ctx.repos.join(', ') + ') committed together. Describe the change, not each repo.']
      : []),
    ...(examples.length
      ? ['', 'Recent subjects from this repository — follow their convention:',
         ...examples.map((s) => '  ' + s)]
      : []),
    ...(hint ? ['', 'What the author says this change is about: ' + hint] : []),
    ...(ctx.truncated ? ['', 'NOTE: the diff below is truncated; describe what it shows.'] : []),
    '',
    '--- diff ---',
    ctx.text,
  ].join('\n')

  // §16 — the drafting call is not an agent session: no tools it could write
  // with, no lease, no checkpoint, nothing to resume. `--restricted` drops the
  // command-running tools and the project's own settings files, so a repo's
  // CLAUDE.md cannot dress this up into something other than one sentence.
  const r = await run(bin, [
    '-p',
    '--restricted',
    '--strict-mcp-config',
    '--output-format', 'text',
  ], { input: prompt, timeoutMs: 90_000, maxBuffer: 256 * 1024 })

  if (!r.ok) {
    return {
      ok: false,
      detail: (r.stderr.trim().split('\n').pop() ?? 'the engine failed').slice(0, 300),
      message: '',
      engine,
      truncated: ctx.truncated,
    }
  }

  const message = cleanDraft(r.stdout)
  if (!message) {
    return { ok: false, detail: 'the engine returned nothing', message: '', engine, truncated: ctx.truncated }
  }

  append({
    type: 'git.message_drafted',
    actor: { kind: 'system' },
    workspaceId: first?.id ?? null,
    payload: {
      engine,
      repos: ctx.repos,
      truncated: ctx.truncated,
      subject: message.split('\n')[0],
    },
  })

  return { ok: true, detail: ctx.repos.join(', '), message, engine, truncated: ctx.truncated }
}

/**
 * Models wrap things. A fence, a "Here is the commit message:", a pair of
 * quotes around the whole line — each of those, committed verbatim, is a
 * message someone has to amend.
 *
 * The double quotes go last and unconditionally: `plan()` refuses a message
 * containing one, because the plan is shown as the exact command it runs. A
 * draft that came back with an apostrophe-as-quote would otherwise be rejected
 * by the button that offered it.
 */
function cleanDraft(raw: string): string {
  let t = raw.trim()
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/.exec(t)
  if (fence) t = fence[1]!.trim()
  t = t.replace(/^(here('s| is)[^\n:]*:|commit message:)\s*/i, '').trim()
  if (t.length > 1 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1).trim()
  return t.replace(/"/g, "'").trim()
}
